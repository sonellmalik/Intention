import Foundation

/// The transport abstraction that discovers, pairs with, connects to, and
/// exchanges messages with the desktop `Sync_Server`.
///
/// The protocol lets the rest of the app (notably `SessionTracker`) drive sync
/// without depending on the concrete `NWBrowser`/`NWConnection` implementation,
/// and lets tests substitute an in-memory client. It intentionally mirrors the
/// design's Core Interfaces:
///
/// - `discover()` browses for the desktop over Bonjour (`_focusflow._tcp`),
///   used when reconnecting after the host may have moved.
/// - `pair(with:)` performs the one-time QR handshake, sending a `pairRequest`
///   built from the scanned `PairingPayload` and awaiting `pairAck`.
/// - `connect()` opens the WebSocket using the stored `sessionKey` from a prior
///   successful pairing.
/// - `send(_:)` delivers an `OutboundMessage` to the desktop.
/// - `onMessage` is invoked for each `InboundMessage` received from the desktop
///   (`sessionStarted`, `sessionStopped`, `ack`, `pairAck`, `pairError`).
///
/// > Note: `pair(with:)` depends on `PairingPayload`, which is defined in the
/// > `Pairing/` group (task 6.1). Concrete implementations of this protocol are
/// > added in task 7.2 / 7.3 (Bonjour discovery, WebSocket transport, and the
/// > persisted offline queue).
///
/// - Requirements: 4.3, 4.7
public protocol SyncClient: AnyObject {
    /// Browse for the desktop sync service over Bonjour.
    func discover()

    /// Perform the one-time pairing handshake from a scanned QR payload.
    ///
    /// - Parameter qr: the validated `PairingPayload` decoded from the QR code.
    /// - Throws: if the token is rejected or the fingerprint does not match.
    func pair(with qr: PairingPayload) async throws

    /// Connect to the paired desktop using the stored `sessionKey`.
    ///
    /// - Throws: if no session key is stored or the connection fails.
    func connect() async throws

    /// Send an outbound message to the desktop.
    ///
    /// - Parameter message: the `OutboundMessage` to deliver.
    /// - Throws: if the message cannot be sent.
    func send(_ message: OutboundMessage) async throws

    /// Enqueue an outbound message for reliable, ack-gated delivery.
    ///
    /// This is the seam `SessionTracker` drives (design example usage:
    /// `syncClient.enqueue(distractionBatch(...))`). Unlike `send(_:)`, which is
    /// a one-shot best-effort put on the wire, `enqueue(_:)` hands the message to
    /// the persisted offline queue: it is stored immediately, flushed when
    /// connected, and removed only after the desktop acks it — so it survives a
    /// disconnect or app restart and is never lost (task 7.3).
    ///
    /// - Parameter message: the `OutboundMessage` to deliver reliably.
    /// - Requirements: 4.3, 4.4, 6.4
    func enqueue(_ message: OutboundMessage)

    /// Resolve the outstanding delivery against a desktop `ack`.
    ///
    /// The `onMessage(.ack)` path forwards its `eventIds` here so the queue can
    /// remove the confirmed head message and mark the corresponding
    /// `PickupEvent`s synced (design example usage: `syncClient.markSynced(ids)`).
    ///
    /// - Parameter eventIds: the event ids acknowledged by the desktop.
    /// - Requirements: 4.5
    func markSynced(_ eventIds: [UUID])

    /// Invoked for each inbound message received from the desktop.
    var onMessage: ((InboundMessage) -> Void)? { get set }
}
