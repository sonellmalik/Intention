import Foundation

/// The transport seam the ``OutboundQueue`` drives to deliver messages.
///
/// The queue owns *ordering, persistence, and ack-gated removal*; it delegates
/// the two things that actually touch the network to this protocol: whether a
/// live connection exists and how to put an encoded message on the wire. Hiding
/// the transport behind a protocol keeps the queue logic pure and portable
/// (no Network.framework), so the no-loss property test (task 7.4) and the
/// flush-semantics unit tests (task 7.6) run off-device against a fake.
///
/// `NetworkSyncClient` conforms to this by forwarding to its `isConnected`
/// flag and `sendRaw(_:)` primitive; ack delivery flows the other way, from the
/// client's `onMessage(.ack)` path into ``OutboundQueue/handleAck(eventIds:)``.
///
/// - Requirements: 4.3, 4.5
public protocol QueueTransport: AnyObject {
    /// Whether a live connection to the desktop currently exists. The queue
    /// consults this before attempting to flush (Algorithm 4's `connected`).
    var isConnected: Bool { get }

    /// Put a single already-encoded outbound frame on the wire, in order.
    ///
    /// - Parameter message: the head-of-queue `OutboundMessage` to deliver.
    /// - Throws: a transport error if the send fails; the queue treats any throw
    ///   as a disconnect and stops flushing (Algorithm 4's `CATCH networkError`).
    func sendMessage(_ message: OutboundMessage) async throws

    /// Ask the transport to (re)establish a connection using increasing backoff.
    ///
    /// Invoked by ``OutboundQueue/onDisconnect()`` and after a send failure. The
    /// concrete client runs Bonjour `discover()` (if the host may have moved) and
    /// `connect()`; on success it flips `isConnected` and calls
    /// ``OutboundQueue/connectionRestored()`` so the queue resumes flushing.
    ///
    /// - Parameter delay: how long to wait before the reconnection attempt,
    ///   computed by the queue's exponential-backoff policy.
    func scheduleReconnect(after delay: TimeInterval)
}

/// Computes the exponential-backoff delay for successive reconnection attempts.
///
/// Injected into ``OutboundQueue`` so reconnection timing is deterministic in
/// tests. The delay grows geometrically from `base` by `multiplier` on each
/// consecutive failure and is capped at `maximum`; a successful reconnect resets
/// the attempt counter (see ``OutboundQueue/connectionRestored()``).
///
/// - Requirements: 4.6
public struct BackoffPolicy: Equatable {
    /// The delay before the first retry, in seconds.
    public let base: TimeInterval
    /// The factor each successive delay is multiplied by.
    public let multiplier: Double
    /// The ceiling applied to every computed delay, in seconds.
    public let maximum: TimeInterval

    /// - Parameters:
    ///   - base: first-retry delay. Defaults to `1` second.
    ///   - multiplier: growth factor per attempt. Defaults to `2` (doubling).
    ///   - maximum: delay ceiling. Defaults to `60` seconds.
    public init(base: TimeInterval = 1, multiplier: Double = 2, maximum: TimeInterval = 60) {
        self.base = base
        self.multiplier = multiplier
        self.maximum = maximum
    }

    /// The backoff delay for a zero-based `attempt` (0 = first retry).
    ///
    /// `attempt` 0 yields `base`, 1 yields `base * multiplier`, and so on, each
    /// clamped to `maximum`.
    public func delay(forAttempt attempt: Int) -> TimeInterval {
        guard attempt > 0 else { return min(base, maximum) }
        let scaled = base * pow(multiplier, Double(attempt))
        return min(scaled, maximum)
    }
}

/// The persisted, ack-gated offline queue for outbound messages (design
/// Algorithm 4, `SyncClient.deliver`).
///
/// Every message a session produces is appended here and immediately persisted,
/// so the backlog survives a disconnect *and* an app restart (Requirement 6.4).
/// When connected, the queue flushes in order and removes a message **only after
/// an ack confirms it** — the ack must contain the event ids of the head batch.
/// Because nothing leaves the queue before it is acked and the queue is
/// persisted while disconnected, no event is ever lost and send order is
/// preserved (Requirements 4.4, 4.5).
///
/// ## Delivery model
///
/// Ack delivery is asynchronous: `flush()` sends the head message and then
/// *waits*. The desktop's `ack` arrives later through the client's inbound
/// message path, which calls ``handleAck(eventIds:)``. If that ack confirms the
/// in-flight message it is removed and the next one is sent; a non-confirming
/// ack stops the flush (the message is retried later). A send failure marks the
/// queue disconnected and asks the transport to reconnect with exponential
/// backoff (Requirement 4.6).
///
/// ## Persistence & portability
///
/// The queue is serialized as a `Codable [OutboundMessage]` through the injected
/// ``PersistenceBackend`` (the same abstraction `LocalStore` uses), so tests can
/// supply `InMemoryPersistenceBackend` and simulate a restart by constructing a
/// second queue over the same backend. All logic here is pure Swift with no
/// Network.framework dependency, so it compiles and is tested on every platform.
///
/// > Concurrency: mutations are serialized on an internal lock so the async
/// > `flush()` and the inbound `handleAck(_:)` callback cannot corrupt the queue
/// > when they interleave.
///
/// - Requirements: 4.3, 4.4, 4.5, 4.6, 6.4
public final class OutboundQueue {
    /// The backend key under which the encoded queue is persisted.
    public static let storageKey = "focuscompanion.outboundQueue"

    /// The transport used to send and to trigger reconnection. `weak` because
    /// the concrete `NetworkSyncClient` owns the queue, not the other way round.
    private weak var transport: QueueTransport?

    private let backend: PersistenceBackend
    private let backoff: BackoffPolicy
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    /// Serializes access to `queue`, `inFlight`, and `reconnectAttempt`.
    private let lock = NSLock()

    /// The pending messages in send order. `queue.first` is the head that
    /// `flush()` sends and that an ack must confirm before removal.
    private var queue: [OutboundMessage]

    /// The message currently awaiting an ack, if any. While non-nil `flush()`
    /// will not send again — it is waiting for `handleAck(_:)` to resolve the
    /// in-flight send.
    private var inFlight: OutboundMessage?

    /// Zero-based count of consecutive reconnection attempts, feeding the
    /// backoff delay. Reset to 0 by ``connectionRestored()``.
    private var reconnectAttempt: Int = 0

    /// Invoked with the event ids confirmed by an ack so the caller can flip the
    /// corresponding `PickupEvent.synced` flags in the `LocalStore`. Wired up by
    /// the app (task 12.3); the queue itself has no dependency on the store.
    ///
    /// - Requirements: 4.5
    public var onEventsSynced: (([UUID]) -> Void)?

    /// Creates a queue over the given transport and backend, restoring any
    /// backlog persisted by a previous run (Requirement 6.4).
    ///
    /// - Parameters:
    ///   - transport: the send/reconnect seam (typically the `NetworkSyncClient`).
    ///   - backend: durable storage for the queue. Defaults to `UserDefaults`.
    ///   - backoff: the reconnection backoff policy. Defaults to 1s→60s doubling.
    public init(
        transport: QueueTransport? = nil,
        backend: PersistenceBackend = UserDefaultsPersistenceBackend(),
        backoff: BackoffPolicy = BackoffPolicy()
    ) {
        self.transport = transport
        self.backend = backend
        self.backoff = backoff

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        self.encoder = encoder

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        self.decoder = decoder

        self.queue = []
        restore()
    }

    /// Attaches the transport after construction.
    ///
    /// The concrete `NetworkSyncClient` builds its queue in `init` (before `self`
    /// is fully available) and then hands itself in here, breaking the
    /// initialization cycle without forcing an optional transport at every call
    /// site.
    public func attach(transport: QueueTransport) {
        lock.lock()
        self.transport = transport
        lock.unlock()
    }

    // MARK: - Introspection (used by tests and the reconnect scheduler)

    /// A snapshot of the pending messages in send order (excludes the in-flight
    /// message, which has been sent but not yet acked).
    public var pendingMessages: [OutboundMessage] {
        lock.lock(); defer { lock.unlock() }
        return queue
    }

    /// The number of messages still awaiting delivery, including any in-flight
    /// message that has been sent but not yet acked.
    public var count: Int {
        lock.lock(); defer { lock.unlock() }
        return queue.count + (inFlight == nil ? 0 : 1)
    }

    // MARK: - Enqueue (Algorithm 4: PROCEDURE enqueue)

    /// Appends a message to the queue, persists the backlog, and flushes if the
    /// transport is connected.
    ///
    /// This is the seam `SessionTracker` uses (`syncClient.enqueue(...)`) to push
    /// a `distractionBatch` for each pickup and at session end. Persisting before
    /// any send guarantees the message survives even if the app dies between the
    /// append and the flush (Requirement 6.4).
    ///
    /// - Parameter message: the `OutboundMessage` to deliver.
    /// - Requirements: 4.3, 4.4, 6.4
    public func enqueue(_ message: OutboundMessage) {
        lock.lock()
        queue.append(message)
        persistLocked()
        let connected = transport?.isConnected ?? false
        lock.unlock()

        if connected {
            Task { await flush() }
        }
    }

    // MARK: - Flush (Algorithm 4: PROCEDURE flush)

    /// Sends queued messages in order, one at a time, pausing after each send to
    /// await its ack.
    ///
    /// The loop sends only the current head (`queue.first`) and then stops,
    /// setting it as the in-flight message. Removal happens later in
    /// ``handleAck(eventIds:)`` once a confirming ack arrives, which then calls
    /// `flush()` again to advance to the next message. This ack-gated,
    /// one-at-a-time cadence is what preserves "remove only after ack" and send
    /// order (Requirements 4.5). A send failure marks the queue disconnected and
    /// schedules a backoff reconnect (Requirement 4.6).
    ///
    /// Calling `flush()` while a message is already in flight, while
    /// disconnected, or with an empty queue is a no-op.
    ///
    /// - Requirements: 4.5, 4.6
    public func flush() async {
        lock.lock()
        // Only one send may be outstanding at a time; wait for the ack first.
        guard inFlight == nil else { lock.unlock(); return }
        guard transport?.isConnected == true else { lock.unlock(); return }
        guard let head = queue.first else { lock.unlock(); return }
        // Mark the head in-flight before releasing the lock so a concurrent
        // flush cannot pick the same message.
        inFlight = head
        lock.unlock()

        do {
            try await transport?.sendMessage(head)
            // Sent successfully; ack handling (handleAck) will remove it and
            // pump the next message. Nothing more to do here.
        } catch {
            // Network error: the message was NOT acked, so it stays in the queue
            // (still at the head) and we simply clear the in-flight marker so a
            // future flush retries it. Then disconnect + schedule reconnect.
            lock.lock()
            inFlight = nil
            lock.unlock()
            handleSendFailure()
        }
    }

    // MARK: - Ack handling (Algorithm 4: ack.confirms(msg) -> removeFirst)

    /// Resolves the in-flight send against an ack from the desktop.
    ///
    /// Wired to the client's `onMessage(.ack)` path. If `eventIds` confirms the
    /// in-flight (head) message — i.e. contains every event id in that batch —
    /// the message is removed, the confirmed `PickupEvent`s are reported via
    /// ``onEventsSynced`` (so their `synced` flag can flip), the backlog is
    /// re-persisted, and the next message is flushed. A non-confirming ack leaves
    /// the message in place to be retried later (Algorithm 4's `ELSE BREAK`).
    ///
    /// - Parameter eventIds: the event ids the desktop acknowledged.
    /// - Requirements: 4.5
    public func handleAck(eventIds: [UUID]) {
        lock.lock()
        guard let head = inFlight ?? queue.first else { lock.unlock(); return }

        guard ackConfirms(head, ackedIds: eventIds) else {
            // Non-confirming ack: keep the message; it will be retried. Clear the
            // in-flight marker so a later flush can resend it.
            inFlight = nil
            lock.unlock()
            return
        }

        // Confirmed: drop the head and persist the shrunken backlog.
        if !queue.isEmpty {
            queue.removeFirst()
        }
        inFlight = nil
        persistLocked()
        let confirmed = Self.eventIds(of: head)
        lock.unlock()

        // Flip synced flags outside the lock, then advance to the next message.
        onEventsSynced?(confirmed)
        Task { await flush() }
    }

    /// A synonym for ``handleAck(eventIds:)`` matching the design's
    /// `syncClient.markSynced(ids)` wire-up in the example usage.
    ///
    /// - Requirements: 4.5
    public func markSynced(_ eventIds: [UUID]) {
        handleAck(eventIds: eventIds)
    }

    // MARK: - Disconnect / reconnect (Algorithm 4: PROCEDURE onDisconnect)

    /// Marks the queue disconnected and schedules a backoff reconnection.
    ///
    /// Wired to the client's `onDisconnect` hook. The in-flight message (if any)
    /// was never acked, so it is returned to the head of the queue to be resent
    /// once the connection is restored — nothing is lost across the drop
    /// (Requirement 4.4). The transport is asked to reconnect after the current
    /// backoff delay (Requirement 4.6).
    ///
    /// - Requirements: 4.4, 4.6
    public func onDisconnect() {
        handleSendFailure()
    }

    /// Called by the transport once a reconnection attempt has succeeded.
    ///
    /// Resets the backoff attempt counter and resumes flushing whatever remained
    /// queued while offline, delivering the backlog in its original order.
    ///
    /// - Requirements: 4.5, 4.6
    public func connectionRestored() {
        lock.lock()
        reconnectAttempt = 0
        // Any message that was in flight when the link dropped was never acked;
        // it is still at the head of `queue` (flush never removes on failure),
        // so just clear the marker and re-flush.
        inFlight = nil
        lock.unlock()

        Task { await flush() }
    }

    // MARK: - Private

    /// Common handling for a dropped connection or a failed send: clear the
    /// in-flight marker (the message remains queued) and ask the transport to
    /// reconnect after the next backoff delay.
    private func handleSendFailure() {
        lock.lock()
        inFlight = nil
        let attempt = reconnectAttempt
        reconnectAttempt += 1
        lock.unlock()

        let delay = backoff.delay(forAttempt: attempt)
        transport?.scheduleReconnect(after: delay)
    }

    /// Whether `ackedIds` confirms `message`: for a `distractionBatch` every
    /// event id in the batch must be present in the ack (Algorithm 4's
    /// `ack.confirms(msg)`). A `pairRequest` carries no event ids and is not
    /// ack-gated here, so it is treated as confirmed by any ack it heads.
    private func ackConfirms(_ message: OutboundMessage, ackedIds: [UUID]) -> Bool {
        switch message {
        case let .distractionBatch(_, _, events):
            let acked = Set(ackedIds)
            return events.allSatisfy { acked.contains($0.id) }
        case .pairRequest:
            return true
        }
    }

    /// The event ids carried by a message (empty for non-batch messages).
    private static func eventIds(of message: OutboundMessage) -> [UUID] {
        switch message {
        case let .distractionBatch(_, _, events):
            return events.map(\.id)
        case .pairRequest:
            return []
        }
    }

    /// Serializes the current queue to the backend. Caller must hold `lock`.
    private func persistLocked() {
        do {
            let data = try encoder.encode(queue)
            backend.setData(data, forKey: Self.storageKey)
        } catch {
            // A serialization failure must not crash the app; the in-memory
            // queue stays authoritative and the next successful persist re-syncs.
            assertionFailure("OutboundQueue failed to encode queue: \(error)")
        }
    }

    /// Loads any persisted backlog into memory on `init` (Requirement 6.4).
    private func restore() {
        guard let data = backend.data(forKey: Self.storageKey) else { return }
        do {
            queue = try decoder.decode([OutboundMessage].self, from: data)
        } catch {
            // Corrupt/incompatible data is ignored rather than fatal so the app
            // can still launch; it will be overwritten on the next persist.
            assertionFailure("OutboundQueue failed to decode queue: \(error)")
        }
    }
}
