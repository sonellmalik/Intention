import Foundation

/// Mirrors the desktop's focus-session state on the phone and converts each
/// detected pickup into a persisted, sync-bound `PickupEvent`.
///
/// `SessionTracker` implements design Algorithm 2. It sits between three
/// injected collaborators, all behind protocols so the tracker is unit-testable
/// off device:
///
/// - a `LocalStore` for on-device persistence of the session and its pickups,
/// - a `PickupDetector` it starts/stops around the session lifetime,
/// - a `SyncClient` it hands `distractionBatch` messages to for delivery.
///
/// ## The enqueue seam
///
/// Design Algorithm 2 pushes each recorded distraction with
/// `syncClient.enqueue(distractionBatch(...))`. The `SyncClient` protocol
/// (tasks 7.1/7.3) exposes exactly that seam: alongside the one-shot
/// `send(_:) async throws` transport call it declares a synchronous,
/// non-throwing `enqueue(_:)` that hands the message to the persisted offline
/// queue (`OutboundQueue`, Algorithm 4). The tracker depends only on that
/// `enqueue(_:)` — a fire-and-forget "record it, deliver it reliably" call — so
/// `onPickup` never has to await the network, and whether a message goes out now
/// or waits in the queue (surviving a disconnect or restart) is entirely the
/// sync client's responsibility. This keeps task 4.1 and task 7.3 aligned
/// without widening the tracker's surface: the tracker is agnostic to how
/// delivery happens.
///
/// ## Ack / markSynced
///
/// The `SyncClient`/`OutboundQueue` already owns ack-gated queue removal. The
/// tracker's own ``markSynced(ids:)`` is the *store-side* half: it flips the
/// persisted `PickupEvent.synced` flags so a later `onSessionStopped` offline
/// finalize (or an app restart) does not re-enqueue an already-delivered event.
/// The app wires the queue's `onEventsSynced` callback to this method
/// (task 12.3), keeping the queue free of any `LocalStore` dependency.
///
/// ## Threading
///
/// The tracker is not internally synchronized; it is meant to be driven from a
/// single serial context (the sync client's `onMessage` callback and the
/// detector's `onPickup` callback, both wired on the same queue in task 12.3).
///
/// ## Lifecycle
///
/// ```
/// onSessionStarted -> [ onPickup ]* -> onSessionStopped
/// ```
///
/// `current` holds the active session between start and stop and is `nil`
/// otherwise, which is how the tracker enforces session scoping: `onPickup` and
/// `onSessionStopped` are no-ops when no session is active.
///
/// - Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 6.4, 6.5
public final class SessionTracker {
    private let store: LocalStore
    private let detector: PickupDetector
    private let syncClient: SyncClient

    /// A time source, injectable so `onSessionStopped`'s `endedAt` is
    /// deterministic in tests. Defaults to `Date()` on device.
    private let now: () -> Date

    /// The active session, or `nil` when none is running. Exposed read-only for
    /// the live-session view (running pickup count) and for tests.
    public private(set) var current: FocusSession?

    /// Creates a tracker over its injected collaborators.
    ///
    /// - Parameters:
    ///   - store: on-device persistence for sessions and pickups.
    ///   - detector: the pickup detector started/stopped around the session.
    ///   - syncClient: the sync client whose `enqueue(_:)` reliably delivers
    ///     `distractionBatch` messages (backed by the `OutboundQueue`, task 7.3).
    ///   - now: current-time provider for `endedAt`; injectable for tests.
    public init(
        store: LocalStore,
        detector: PickupDetector,
        syncClient: SyncClient,
        now: @escaping () -> Date = { Date() }
    ) {
        self.store = store
        self.detector = detector
        self.syncClient = syncClient
        self.now = now
    }

    // MARK: - Desktop session lifecycle

    /// Handle a `sessionStarted` message from the desktop.
    ///
    /// Builds a `FocusSession` from the message fields, persists it, and starts
    /// the detector so pickups are recorded against it. The parameters mirror the
    /// `InboundMessage.sessionStarted` associated values, so the app can forward
    /// them straight from `onMessage`.
    ///
    /// - Requirements: 2.1, 6.1
    public func onSessionStarted(
        sessionId: UUID,
        dateKey: String,
        mode: SessionMode,
        startedAt: Date,
        plannedDuration: Int
    ) {
        let session = FocusSession(
            id: sessionId,
            dateKey: dateKey,
            mode: mode,
            startedAt: startedAt,
            plannedDuration: plannedDuration,
            endedAt: nil,
            pickups: []
        )
        current = session
        store.save(session)
        detector.start(session: session)
    }

    /// Record a detected pickup as a `PickupEvent` on the active session.
    ///
    /// No-op when no session is active (session scoping). Otherwise the elapsed
    /// seconds are clamped to `0...plannedDuration` (Algorithm 2 / Property 1),
    /// the event is tagged `.phone` with a fresh UUID and `synced = false`,
    /// appended to `current`, persisted, and handed to the sync client as a
    /// single-event `distractionBatch`.
    ///
    /// - Parameter occurredAt: wall-clock time the pickup occurred (from the
    ///   `PickupDetector`).
    /// - Requirements: 2.2, 2.3, 2.4, 2.6, 6.2, 6.4
    public func onPickup(occurredAt: Date) {
        guard var session = current else { return }

        let rawElapsed = occurredAt.timeIntervalSince(session.startedAt).rounded()
        let elapsed = clampElapsed(rawElapsed, plannedDuration: session.plannedDuration)

        let event = PickupEvent(
            id: UUID(),
            elapsed: elapsed,
            occurredAt: occurredAt,
            tag: .phone,
            synced: false
        )

        session.pickups.append(event)
        current = session
        store.appendPickup(event, toSession: session.id)

        syncClient.enqueue(
            .distractionBatch(
                sessionId: session.id,
                dateKey: session.dateKey,
                events: [DistractionEvent(event)]
            )
        )
    }

    /// Handle a `sessionStopped` message from the desktop.
    ///
    /// No-op when no session is active. Otherwise records `endedAt`, persists the
    /// finalized session, stops the detector, and enqueues any still-unsynced
    /// events as one `distractionBatch` so a session that ended while offline is
    /// finalized locally and its pickups are delivered on the next connect
    /// (Requirement 6.5). Clears `current`.
    ///
    /// The parameters mirror the `InboundMessage.sessionStopped` associated
    /// values for a clean `onMessage` hand-off; the tracker finalizes whichever
    /// session is currently active.
    ///
    /// - Requirements: 2.5, 6.5
    public func onSessionStopped(sessionId: UUID, reason: String) {
        guard var session = current else { return }

        session.endedAt = now()
        current = session
        store.save(session)
        detector.stop()

        let unsynced = session.pickups.filter { !$0.synced }
        if !unsynced.isEmpty {
            syncClient.enqueue(
                .distractionBatch(
                    sessionId: session.id,
                    dateKey: session.dateKey,
                    events: unsynced.map(DistractionEvent.init)
                )
            )
        }

        current = nil
    }

    // MARK: - Ack handling

    /// Mark the given pickup ids as synced in the local store.
    ///
    /// Pairs with the sync client's ack handling: when the desktop acknowledges a
    /// batch, the confirmed event ids flow here (the app wires the
    /// `OutboundQueue`'s `onEventsSynced` callback to this method). Each matching
    /// `PickupEvent` has its `synced` flag flipped to `true` and is persisted via
    /// `LocalStore.updatePickup`, so a subsequent offline finalize or a restart
    /// does not re-enqueue an already-delivered event.
    ///
    /// The update is applied to persistent storage (covering events whose session
    /// has already ended) and to the in-memory `current` session so both stay
    /// consistent.
    ///
    /// - Parameter ids: the event ids the desktop confirmed.
    /// - Requirements: 4.5, 6.2
    public func markSynced(ids: [UUID]) {
        guard !ids.isEmpty else { return }
        let idSet = Set(ids)

        // Persist across every session that owns one of the acked ids so acks
        // arriving after a session has ended are still recorded.
        for session in store.loadSessions() {
            for pickup in session.pickups where idSet.contains(pickup.id) && !pickup.synced {
                var updated = pickup
                updated.synced = true
                store.updatePickup(updated, inSession: session.id)
            }
        }

        // Keep the in-memory active session consistent with what was persisted.
        if var session = current {
            var changed = false
            for index in session.pickups.indices where idSet.contains(session.pickups[index].id) {
                if !session.pickups[index].synced {
                    session.pickups[index].synced = true
                    changed = true
                }
            }
            if changed { current = session }
        }
    }

    // MARK: - Helpers

    /// Clamps rounded elapsed seconds into `0...plannedDuration`.
    ///
    /// Pickups that (due to clock skew) fall before the session start clamp to
    /// `0`; pickups after the planned end clamp to `plannedDuration` (Property 1
    /// / Requirement 2.3). `plannedDuration` is treated as a non-negative bound.
    private func clampElapsed(_ rawElapsed: Double, plannedDuration: Int) -> Int {
        let upper = max(0, plannedDuration)
        if rawElapsed <= 0 { return 0 }
        if rawElapsed >= Double(upper) { return upper }
        return Int(rawElapsed)
    }
}
