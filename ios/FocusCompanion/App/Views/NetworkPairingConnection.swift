import Foundation
import FocusCompanionCore

#if os(iOS)

/// A ``PairingConnection`` backed by ``NetworkSyncClient``.
///
/// `PairFromQR` (the pure handshake orchestration in `FocusCompanionCore`) talks
/// to the desktop through the `PairingConnection`/`PairingConnectionFactory`
/// seams so it never depends on real networking. The core library ships the
/// protocols and an in-memory double for tests, but the *live* transport lives
/// in the app target — this adapter wires the handshake onto the real
/// `NetworkSyncClient` (Bonjour + WebSocket over Network.framework).
///
/// `NetworkSyncClient` exposes sends as `async` calls and delivers replies
/// through its `onMessage` callback. `PairingConnection.receive()` is an async
/// call that returns the next inbound message, so this adapter bridges the two:
/// it installs an `onMessage` handler that either resolves a waiting
/// `receive()` continuation or buffers the message until the next `receive()`.
///
/// - Requirements: 3.2, 4.8
final class NetworkPairingConnection: PairingConnection {
    private let client: NetworkSyncClient

    /// Continuation for an in-flight `receive()` awaiting the next message.
    private var pendingReceive: CheckedContinuation<InboundMessage, Error>?
    /// Messages that arrived before a `receive()` was awaiting them, delivered
    /// in order to the next `receive()` call.
    private var buffered: [InboundMessage] = []
    /// Guards `pendingReceive`/`buffered` against the client's callback queue.
    private let lock = NSLock()
    private var isClosed = false

    /// - Parameter client: an already-connected `NetworkSyncClient` whose
    ///   endpoint targets the scanned payload's `host:port`.
    init(client: NetworkSyncClient) {
        self.client = client
        client.onMessage = { [weak self] message in
            self?.deliver(message)
        }
        client.onDisconnect = { [weak self] in
            self?.fail(with: SyncTransportError.notConnected)
        }
    }

    func send(_ message: OutboundMessage) async throws {
        try await client.send(message)
    }

    func receive() async throws -> InboundMessage {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            if isClosed {
                lock.unlock()
                continuation.resume(throwing: SyncTransportError.notConnected)
                return
            }
            if !buffered.isEmpty {
                let next = buffered.removeFirst()
                lock.unlock()
                continuation.resume(returning: next)
                return
            }
            pendingReceive = continuation
            lock.unlock()
        }
    }

    func close() {
        lock.lock()
        isClosed = true
        let waiting = pendingReceive
        pendingReceive = nil
        buffered.removeAll()
        lock.unlock()
        // Resolving a still-waiting receive keeps a caller from hanging on a
        // connection that was closed out from under it.
        waiting?.resume(throwing: SyncTransportError.notConnected)
    }

    // MARK: - Callback bridging

    /// Routes an inbound message to a waiting `receive()`, or buffers it.
    private func deliver(_ message: InboundMessage) {
        lock.lock()
        if let waiting = pendingReceive {
            pendingReceive = nil
            lock.unlock()
            waiting.resume(returning: message)
        } else {
            buffered.append(message)
            lock.unlock()
        }
    }

    /// Fails a waiting `receive()` when the underlying connection drops.
    private func fail(with error: Error) {
        lock.lock()
        let waiting = pendingReceive
        pendingReceive = nil
        lock.unlock()
        waiting?.resume(throwing: error)
    }
}

/// Opens a ``NetworkPairingConnection`` to a scanned payload's `host:port`.
///
/// Injected into `PairFromQR` so the handshake runs over the real WebSocket
/// transport in the app while staying testable (tests inject an in-memory
/// factory instead).
///
/// - Requirements: 3.2, 4.8
final class NetworkPairingConnectionFactory: PairingConnectionFactory {
    func open(host: String, port: Int) async throws -> PairingConnection {
        let client = NetworkSyncClient(endpoint: .manual(host: host, port: port))
        try await client.connect()
        return NetworkPairingConnection(client: client)
    }
}

#endif
