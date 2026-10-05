import Foundation

/// The transport seam used by the pairing handshake (`PairFromQR`).
///
/// The handshake orchestration only needs to open a connection to the desktop,
/// send a single `pairRequest`, await one reply, and close. Hiding that behind
/// this protocol keeps the orchestration free of any dependency on real
/// networking (`NWConnection`/URLSession WebSockets), so the failure paths in
/// task 6.4 — token rejection, fingerprint mismatch, timeout — can be exercised
/// off-device with an in-memory connection. The concrete WebSocket-backed
/// implementation is added alongside the transport in task 7.2.
///
/// Messages are exchanged as decoded/encoded `InboundMessage`/`OutboundMessage`
/// values so the wire coding stays in one place (`SyncMessages.swift`); a
/// conforming type is responsible only for moving those values across the link.
///
/// - Requirements: 3.2, 3.4
public protocol PairingConnection: AnyObject {
    /// Send an outbound message to the desktop over the open connection.
    ///
    /// - Parameter message: the `OutboundMessage` to deliver (a `pairRequest`
    ///   during the handshake).
    /// - Throws: if the message cannot be encoded or sent.
    func send(_ message: OutboundMessage) async throws

    /// Await the next inbound message from the desktop.
    ///
    /// Implementations should honor Swift's cooperative cancellation so the
    /// handshake's timeout can abandon a receive that never completes.
    ///
    /// - Returns: the next decoded `InboundMessage`.
    /// - Throws: if the connection fails, is cancelled, or the reply cannot be
    ///   decoded.
    func receive() async throws -> InboundMessage

    /// Close the connection and release its resources.
    ///
    /// Safe to call more than once; a second close is a no-op.
    func close()
}

/// Opens a `PairingConnection` to a host and port from the scanned payload.
///
/// The handshake receives its transport through this factory rather than
/// constructing one directly, which is what lets tests inject an in-memory
/// connection (and lets the real implementation own the WebSocket lifecycle).
///
/// - Requirements: 3.2
public protocol PairingConnectionFactory {
    /// Open a connection to the desktop WebSocket server.
    ///
    /// - Parameters:
    ///   - host: the desktop host from the pairing payload.
    ///   - port: the desktop port from the pairing payload.
    /// - Returns: an open `PairingConnection` ready to send/receive.
    /// - Throws: if the connection cannot be opened.
    func open(host: String, port: Int) async throws -> PairingConnection
}
