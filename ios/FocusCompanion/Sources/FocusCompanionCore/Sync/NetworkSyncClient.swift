import Foundation

#if canImport(Network)
import Network

#if canImport(UIKit)
import UIKit
#endif

/// The concrete `SyncClient` transport: Bonjour discovery + a WebSocket
/// connection over Network.framework.
///
/// This type covers discovery and connection (task 7.2). It deliberately leaves
/// clean seams for the persisted offline queue and reconnect logic that task 7.3
/// layers on top:
///
/// - `isConnected` — a single flag the queue can consult before flushing.
/// - `sendRaw(_:)` — the low-level "put these bytes on the wire" primitive that
///   `flush()` will call for each queued message; `send(_:)` is built on it.
/// - `onDisconnect` — a hook invoked whenever the live connection drops, which
///   task 7.3 wires to its exponential-backoff reconnect scheduler.
///
/// The design's default path is LAN-only (Requirement 7.1/7.4): the client talks
/// to exactly one host — either the Bonjour-discovered desktop or the manual
/// `host:port` from the pairing payload — and nothing else.
///
/// Network.framework is Apple-only, so the whole implementation is wrapped in
/// `#if canImport(Network)`. A portable stub (below) keeps `FocusCompanionCore`
/// compiling on non-Apple CI where `Network` is unavailable.
///
/// - Requirements: 4.1, 4.2, 4.8, 8.3
public final class NetworkSyncClient: SyncClient {
    /// The Bonjour service type advertised by the desktop `Sync_Server`.
    public static let serviceType = "_focusflow._tcp"

    /// How the client should locate the desktop when connecting.
    public enum Endpoint: Equatable {
        /// Browse Bonjour for `_focusflow._tcp` and connect to the first result.
        /// Used for reconnection after a prior pairing (Requirement 4.2).
        case bonjour
        /// Connect directly to a known `host:port`. Backs both the initial
        /// pairing (from the scanned `PairingPayload`) and the manual fallback
        /// when discovery is blocked (Requirement 4.8).
        case manual(host: String, port: Int)
    }

    // MARK: SyncClient

    public var onMessage: ((InboundMessage) -> Void)?

    // MARK: Seams for the offline queue (task 7.3)

    /// Whether a live WebSocket connection is currently established. Task 7.3's
    /// `enqueue`/`flush` consults this before attempting to send.
    public private(set) var isConnected: Bool = false

    /// Invoked whenever the live connection drops (peer close, cancel, or a
    /// failed state). The owned ``OutboundQueue`` also observes drops through the
    /// `QueueTransport` conformance; this hook stays available for additional
    /// observers (e.g. the UI).
    public var onDisconnect: (() -> Void)?

    // MARK: Offline queue (task 7.3)

    /// The persisted, ack-gated offline queue. The client owns it and acts as its
    /// ``QueueTransport``, so `enqueue`/`flush`/reconnect all route through this
    /// one connection. Exposed so the app can wire `onEventsSynced` to the
    /// `LocalStore` (task 12.3).
    public let outboundQueue: OutboundQueue

    // MARK: Configuration

    /// Where to connect. Defaults to Bonjour discovery; pairing and the manual
    /// fallback override it with a concrete `host:port`.
    private var endpoint: Endpoint

    /// The durable session key from a prior successful pairing, sent as a header
    /// on `connect()`. `nil` until pairing completes.
    private var sessionKey: String?

    // MARK: Network state

    private let queue = DispatchQueue(label: "focuscompanion.sync.network")
    private var connection: NWConnection?
    private var browser: NWBrowser?

    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    /// Most recent Bonjour browse results, newest discovery wins on reconnect.
    private var discoveredEndpoints: [NWEndpoint] = []

    /// Creates a client for the given endpoint and optional stored session key.
    ///
    /// - Parameters:
    ///   - endpoint: how to locate the desktop. Defaults to `.bonjour`.
    ///   - sessionKey: the durable key from a prior pairing, if any.
    ///   - queueBackend: durable storage for the offline queue. Defaults to
    ///     `UserDefaults`; tests inject an in-memory backend.
    ///   - backoff: the reconnection backoff policy for the offline queue.
    public init(
        endpoint: Endpoint = .bonjour,
        sessionKey: String? = nil,
        queueBackend: PersistenceBackend = UserDefaultsPersistenceBackend(),
        backoff: BackoffPolicy = BackoffPolicy()
    ) {
        self.endpoint = endpoint
        self.sessionKey = sessionKey

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        self.encoder = encoder

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        self.decoder = decoder

        // Build the queue over the durable backend (restoring any prior backlog),
        // then attach `self` as its transport once fully initialized.
        self.outboundQueue = OutboundQueue(backend: queueBackend, backoff: backoff)
        self.outboundQueue.attach(transport: self)

        // Ack frames arriving on the inbound path resolve the queue's in-flight
        // send; every other inbound message still reaches the app's `onMessage`.
        installAckForwarding()
    }

    /// Wraps `onMessage` so `ack` frames drive the offline queue while all other
    /// inbound messages continue to reach the app's own handler.
    private func installAckForwarding() {
        let userHandler = { [weak self] (message: InboundMessage) in
            self?.onMessage?(message)
        }
        internalMessageHandler = { [weak self] message in
            if case let .ack(eventIds) = message {
                self?.outboundQueue.handleAck(eventIds: eventIds)
            }
            userHandler(message)
        }
    }

    /// Internal inbound dispatcher installed in `init`: routes `ack` to the queue
    /// and forwards every message to the public `onMessage`. `receiveNextFrame`
    /// calls this rather than `onMessage` directly.
    private var internalMessageHandler: ((InboundMessage) -> Void)?

    // MARK: - Discovery

    /// Browse for the desktop sync service over Bonjour (`_focusflow._tcp`).
    ///
    /// Results are cached so a subsequent `connect()` on the `.bonjour` endpoint
    /// can dial the most recently seen desktop — the reconnection path when the
    /// host may have changed address (Requirement 4.2).
    public func discover() {
        browser?.cancel()

        let parameters = NWParameters()
        parameters.includePeerToPeer = false
        let descriptor = NWBrowser.Descriptor.bonjour(type: Self.serviceType, domain: nil)
        let browser = NWBrowser(for: descriptor, using: parameters)

        browser.browseResultsChangedHandler = { [weak self] results, _ in
            guard let self else { return }
            self.queue.async {
                self.discoveredEndpoints = results.map { $0.endpoint }
            }
        }
        browser.stateUpdateHandler = { [weak self] state in
            if case .failed = state {
                self?.browser?.cancel()
            }
        }

        self.browser = browser
        browser.start(queue: queue)
    }

    // MARK: - Pairing

    /// Perform the one-time pairing handshake from a scanned QR payload.
    ///
    /// Opens a WebSocket to the payload's `host:port` (Requirement 3.2 /
    /// 4.8's manual address), sends a `pairRequest` with the one-time token, and
    /// awaits the desktop's reply. The higher-level `PairFromQR` flow (task 6.2)
    /// interprets `pairAck`/`pairError` and Keychain-stores the session key; this
    /// method's job is the transport: connect, send, deliver replies via
    /// `onMessage`.
    ///
    /// - Parameter qr: the validated `PairingPayload` decoded from the QR code.
    /// - Throws: if the connection to `host:port` cannot be established.
    public func pair(with qr: PairingPayload) async throws {
        endpoint = .manual(host: qr.host, port: qr.port)
        try await openConnection(sessionKey: nil)
        let device = DeviceInfo(name: Self.deviceName(), platform: "ios")
        try await send(.pairRequest(pairingToken: qr.pairingToken, device: device))
    }

    // MARK: - Connecting

    /// Connect to the paired desktop using the stored `sessionKey`.
    ///
    /// Resolves the target from the configured `endpoint`: a `.manual` host:port
    /// (from the pairing payload or manual fallback) is used directly, while
    /// `.bonjour` dials the most recent discovery result (Requirement 4.2). The
    /// `sessionKey` is attached so the desktop can authenticate the reconnection.
    ///
    /// - Throws: `SyncTransportError.noEndpoint` if no target is known, or a
    ///   connection error if the socket fails to become ready.
    public func connect() async throws {
        try await openConnection(sessionKey: sessionKey)
    }

    // MARK: - Sending

    /// Encode and send an `OutboundMessage` to the desktop.
    ///
    /// Built on the lower-level `sendRaw(_:)` primitive so task 7.3's `flush()`
    /// can reuse the same send path for queued messages.
    ///
    /// - Parameter message: the `OutboundMessage` to deliver.
    /// - Throws: `SyncTransportError.notConnected` if there is no live
    ///   connection, or an encoding/socket error on failure.
    public func send(_ message: OutboundMessage) async throws {
        let data = try encoder.encode(message)
        try await sendRaw(data)
    }

    /// The low-level send primitive: put an already-encoded frame on the wire.
    ///
    /// Exposed to the package so task 7.3's offline queue drives delivery through
    /// the same code path `send(_:)` uses, keeping ordering and framing identical
    /// for queued and immediate sends.
    ///
    /// - Parameter data: the encoded message bytes.
    /// - Throws: `SyncTransportError.notConnected` or the underlying socket error.
    func sendRaw(_ data: Data) async throws {
        guard let connection, isConnected else {
            throw SyncTransportError.notConnected
        }

        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "textFrame", metadata: [metadata])

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.send(
                content: data,
                contentContext: context,
                isComplete: true,
                completion: .contentProcessed { error in
                    if let error {
                        continuation.resume(throwing: error)
                    } else {
                        continuation.resume()
                    }
                }
            )
        }
    }

    // MARK: - Connection lifecycle

    /// Opens (or replaces) the WebSocket connection for the current `endpoint`
    /// and resolves once the socket reaches `.ready`.
    private func openConnection(sessionKey: String?) async throws {
        let nwEndpoint = try resolveEndpoint()

        let options = NWProtocolWebSocket.Options()
        options.autoReplyPing = true
        // Attach the durable session key so the desktop can authenticate a
        // reconnection without re-pairing (nil during the first pairing handshake).
        if let sessionKey {
            options.setAdditionalHeaders([("X-FocusFlow-Session-Key", sessionKey)])
        }

        let parameters = NWParameters.tcp
        parameters.defaultProtocolStack.applicationProtocols.insert(options, at: 0)

        let connection = NWConnection(to: nwEndpoint, using: parameters)
        self.connection = connection

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            // Guard against resuming the continuation more than once as the
            // connection transitions through multiple states.
            var didResume = false
            connection.stateUpdateHandler = { [weak self] state in
                guard let self else { return }
                switch state {
                case .ready:
                    self.isConnected = true
                    self.receiveNextFrame()
                    if !didResume { didResume = true; continuation.resume() }
                    // Resume flushing any backlog that accumulated while offline.
                    self.outboundQueue.connectionRestored()
                case .failed(let error):
                    self.isConnected = false
                    self.tearDownConnection()
                    if !didResume { didResume = true; continuation.resume(throwing: error) }
                    self.notifyDisconnected()
                case .cancelled:
                    self.isConnected = false
                    self.notifyDisconnected()
                default:
                    break
                }
            }
            connection.start(queue: queue)
        }
    }

    /// Resolves the configured `endpoint` into a concrete `NWEndpoint`.
    private func resolveEndpoint() throws -> NWEndpoint {
        switch endpoint {
        case let .manual(host, port):
            guard let port16 = UInt16(exactly: port),
                  port16 > 0,
                  let nwPort = NWEndpoint.Port(rawValue: port16)
            else {
                throw SyncTransportError.invalidPort(port)
            }
            return .hostPort(host: NWEndpoint.Host(host), port: nwPort)
        case .bonjour:
            guard let discovered = discoveredEndpoints.first else {
                throw SyncTransportError.noEndpoint
            }
            return discovered
        }
    }

    /// Receives the next inbound WebSocket frame, decodes it into an
    /// `InboundMessage`, invokes `onMessage`, and recurses to keep listening.
    private func receiveNextFrame() {
        connection?.receiveMessage { [weak self] data, _, isComplete, error in
            guard let self else { return }

            if let data, !data.isEmpty {
                if let message = try? self.decoder.decode(InboundMessage.self, from: data) {
                    // Route through the internal handler so `ack` frames resolve
                    // the offline queue's in-flight send before reaching the app.
                    self.internalMessageHandler?(message)
                }
                // Unknown/undecodable frames are ignored rather than fatal so a
                // future desktop message type can't crash an older phone build.
            }

            if let error {
                self.isConnected = false
                self.tearDownConnection()
                self.notifyDisconnected()
                return
            }

            if isComplete && data == nil {
                // Peer closed the stream.
                self.isConnected = false
                self.tearDownConnection()
                self.notifyDisconnected()
                return
            }

            // Keep listening for the next frame.
            if self.isConnected {
                self.receiveNextFrame()
            }
        }
    }

    /// Cancels and clears the current connection without invoking `onDisconnect`
    /// (callers decide whether a drop warrants the hook).
    private func tearDownConnection() {
        connection?.cancel()
        connection = nil
    }

    /// A best-effort device name for the pairing handshake's `device` field.
    private static func deviceName() -> String {
        #if canImport(UIKit)
        return UIDevice.current.name
        #else
        return Host.current().localizedName ?? "iPhone"
        #endif
    }

    /// Fans a connection drop out to both the offline queue (so it stops
    /// flushing, retains its backlog, and schedules a reconnect) and any external
    /// `onDisconnect` observer. Guarded so the queue is only told once per drop
    /// isn't required — `OutboundQueue.onDisconnect()` is idempotent enough that a
    /// repeated call just re-arms the backoff — but the state flag already gates
    /// most double-fires.
    private func notifyDisconnected() {
        outboundQueue.onDisconnect()
        onDisconnect?()
    }

    // MARK: - Offline queue seams (enqueue / markSynced)

    /// Enqueue a message for reliable, ack-gated delivery through the offline
    /// queue. See `SyncClient.enqueue(_:)`.
    ///
    /// - Requirements: 4.3, 4.4, 6.4
    public func enqueue(_ message: OutboundMessage) {
        outboundQueue.enqueue(message)
    }

    /// Resolve the queue's in-flight send against a desktop ack. Normally driven
    /// automatically by the inbound `ack` frame; also exposed so the app's
    /// `onMessage(.ack)` wiring can call it explicitly (design example usage).
    ///
    /// - Requirements: 4.5
    public func markSynced(_ eventIds: [UUID]) {
        outboundQueue.markSynced(eventIds)
    }
}

// MARK: - QueueTransport conformance

extension NetworkSyncClient: QueueTransport {
    /// Put one queued message on the wire via the shared `send(_:)`/`sendRaw(_:)`
    /// path so queued and immediate sends share framing and ordering.
    public func sendMessage(_ message: OutboundMessage) async throws {
        try await send(message)
    }

    /// Reconnect after the queue's backoff delay: browse Bonjour (in case the
    /// host moved) and reconnect using the stored session key. On success the
    /// `.ready` state handler calls `outboundQueue.connectionRestored()`, which
    /// resumes the flush; on failure the queue arms the next backoff step.
    ///
    /// - Requirements: 4.2, 4.6
    public func scheduleReconnect(after delay: TimeInterval) {
        queue.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self else { return }
            Task {
                // Re-run discovery so a moved desktop is found on the Bonjour path.
                if case .bonjour = self.endpoint {
                    self.discover()
                }
                do {
                    try await self.connect()
                } catch {
                    // connect() failing routes through the connection's failure
                    // state -> notifyDisconnected() -> queue arms the next backoff.
                }
            }
        }
    }
}

#else

// MARK: - Portable stub (non-Apple platforms)

/// A no-op `SyncClient` used only where `Network` is unavailable (e.g. Linux CI)
/// so `FocusCompanionCore` still compiles. The real transport above is compiled
/// on every Apple platform, which is where the app and its device tests run.
///
/// Every transport call throws `SyncTransportError.networkUnavailable`; the
/// task 7.3 seams (`isConnected`, `onDisconnect`) exist here too so higher-level
/// code type-checks identically on both platforms.
///
/// - Requirements: 4.1, 4.2, 4.8, 8.3
public final class NetworkSyncClient: SyncClient {
    public var onMessage: ((InboundMessage) -> Void)?

    /// Always `false` — the stub never establishes a connection.
    public private(set) var isConnected: Bool = false

    /// Hook retained for source compatibility with the Network.framework build.
    public var onDisconnect: (() -> Void)?

    /// The persisted, ack-gated offline queue — identical to the Apple build so
    /// the queue logic (task 7.3) and its tests (7.4/7.6) type-check and run on
    /// non-Apple CI. Because the stub is never connected, enqueued messages stay
    /// persisted rather than flushing, which is exactly the offline behaviour the
    /// no-loss property test exercises.
    public let outboundQueue: OutboundQueue

    public init(
        queueBackend: PersistenceBackend = UserDefaultsPersistenceBackend(),
        backoff: BackoffPolicy = BackoffPolicy()
    ) {
        self.outboundQueue = OutboundQueue(backend: queueBackend, backoff: backoff)
        self.outboundQueue.attach(transport: self)
    }

    public func discover() {}

    public func pair(with qr: PairingPayload) async throws {
        throw SyncTransportError.networkUnavailable
    }

    public func connect() async throws {
        throw SyncTransportError.networkUnavailable
    }

    public func send(_ message: OutboundMessage) async throws {
        throw SyncTransportError.networkUnavailable
    }

    /// Enqueue for reliable delivery. See `SyncClient.enqueue(_:)`.
    public func enqueue(_ message: OutboundMessage) {
        outboundQueue.enqueue(message)
    }

    /// Resolve the queue's in-flight send against an ack. See `markSynced(_:)`.
    public func markSynced(_ eventIds: [UUID]) {
        outboundQueue.markSynced(eventIds)
    }
}

extension NetworkSyncClient: QueueTransport {
    /// The stub is never connected, so a flush send always fails, keeping the
    /// message queued (the offline path).
    public func sendMessage(_ message: OutboundMessage) async throws {
        throw SyncTransportError.networkUnavailable
    }

    /// No real transport to reconnect; a no-op on the stub build.
    public func scheduleReconnect(after delay: TimeInterval) {}
}

#endif

/// Errors thrown by the concrete `SyncClient` transport.
public enum SyncTransportError: Error, Equatable, CustomStringConvertible {
    /// A send was attempted with no live connection.
    case notConnected
    /// `connect()` on the Bonjour endpoint found no discovered desktop.
    case noEndpoint
    /// The manual `host:port` carried an out-of-range port.
    case invalidPort(Int)
    /// Network.framework is unavailable on this platform (stub build).
    case networkUnavailable

    public var description: String {
        switch self {
        case .notConnected:
            return "No live connection to the desktop; send was skipped."
        case .noEndpoint:
            return "No desktop endpoint is known; run discovery or pair first."
        case .invalidPort(let port):
            return "Pairing payload carried an invalid TCP port: \(port)."
        case .networkUnavailable:
            return "Network.framework is unavailable on this platform."
        }
    }
}
