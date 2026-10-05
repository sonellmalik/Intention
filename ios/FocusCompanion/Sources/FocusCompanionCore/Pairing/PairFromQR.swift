import Foundation

/// An error thrown by the `PairFromQR` handshake.
///
/// - Requirements: 3.5, 3.6
public enum PairingError: Error, Equatable, CustomStringConvertible {
    /// The desktop rejected the one-time token (invalid or expired). The UI
    /// should prompt the user to re-scan a fresh QR code.
    case tokenRejected
    /// The `pairAck` fingerprint did not match the scanned payload — the phone
    /// may be talking to a spoofed desktop on the LAN. Nothing is persisted.
    case fingerprintMismatch
    /// No `pairAck`/`pairError` arrived within the handshake timeout.
    case timedOut
    /// The desktop replied with a message that is not part of the handshake.
    case unexpectedReply(String)

    public var description: String {
        switch self {
        case .tokenRejected:
            return "The pairing token was rejected; re-scan the QR code."
        case .fingerprintMismatch:
            return "The desktop fingerprint did not match the scanned code."
        case .timedOut:
            return "The desktop did not respond to the pairing request in time."
        case .unexpectedReply(let type):
            return "Received an unexpected reply during pairing: \(type)."
        }
    }
}

/// Runs the QR pairing handshake (design Algorithm 3, `PairFromQR`).
///
/// Given a validated `PairingPayload`, the handshake opens a connection to the
/// desktop, sends a `pairRequest` carrying the one-time `pairingToken` and this
/// device's info, and awaits a `pairAck` (with a 10-second timeout). On a
/// `pairAck` whose `fingerprint` matches the scanned payload it stores the
/// `sessionKey`, desktop host, and port in the iOS Keychain; on a `pairError`
/// (token rejected) or a fingerprint mismatch it closes the connection and
/// persists nothing.
///
/// The type is pure orchestration: it depends only on the injected
/// ``PairingConnectionFactory`` and ``KeychainStoring`` protocols, never on real
/// networking or the real Keychain, so the failure paths (task 6.4) are testable
/// off-device.
///
/// - Requirements: 3.2, 3.3, 3.4, 3.5, 3.6
public struct PairFromQR {
    /// How long to wait for the desktop's `pairAck`/`pairError` reply.
    public static let replyTimeout: TimeInterval = 10

    private let connectionFactory: PairingConnectionFactory
    private let keychain: KeychainStoring
    private let deviceInfo: DeviceInfo
    private let timeout: TimeInterval

    /// - Parameters:
    ///   - connectionFactory: opens the transport to the desktop (injected so
    ///     tests can supply an in-memory connection).
    ///   - keychain: secure store for the resulting `sessionKey`/host/port.
    ///   - deviceInfo: identifies this phone to the desktop in the `pairRequest`.
    ///   - timeout: seconds to await the reply. Defaults to ``replyTimeout``.
    public init(
        connectionFactory: PairingConnectionFactory,
        keychain: KeychainStoring,
        deviceInfo: DeviceInfo,
        timeout: TimeInterval = PairFromQR.replyTimeout
    ) {
        self.connectionFactory = connectionFactory
        self.keychain = keychain
        self.deviceInfo = deviceInfo
        self.timeout = timeout
    }

    /// Performs the handshake for a scanned pairing payload.
    ///
    /// - Parameter payload: the validated `PairingPayload` decoded from the QR
    ///   code (see `PairingPayload.decode(fromQRString:)`).
    /// - Returns: the durable `sessionKey` issued by the desktop and stored in
    ///   the Keychain.
    /// - Throws: `PairingError.tokenRejected` if the desktop returns `pairError`,
    ///   `PairingError.fingerprintMismatch` if the `pairAck` fingerprint does not
    ///   match the payload, `PairingError.timedOut` if no reply arrives in time,
    ///   or any error from the connection/keychain. On every failure the
    ///   connection is closed and nothing is persisted.
    ///
    /// - Requirements: 3.2, 3.3, 3.4, 3.5, 3.6
    @discardableResult
    public func pair(with payload: PairingPayload) async throws -> String {
        // Guard against a payload that skipped validation.
        try payload.validate()

        let connection = try await connectionFactory.open(host: payload.host, port: payload.port)

        do {
            try await connection.send(
                .pairRequest(pairingToken: payload.pairingToken, device: deviceInfo)
            )

            let reply = try await receiveWithTimeout(on: connection)

            switch reply {
            case let .pairAck(sessionKey, fingerprint):
                guard fingerprint == payload.fingerprint else {
                    // Fingerprint mismatch: possible LAN spoof. Persist nothing.
                    connection.close()
                    throw PairingError.fingerprintMismatch
                }
                try store(sessionKey: sessionKey, host: payload.host, port: payload.port)
                connection.close()
                return sessionKey

            case .pairError:
                // Token rejected/expired: the UI should prompt a re-scan.
                connection.close()
                throw PairingError.tokenRejected

            case .sessionStarted, .sessionStopped, .ack:
                connection.close()
                throw PairingError.unexpectedReply(reply.kind.rawValue)
            }
        } catch {
            // Any failure (send error, timeout, decode error) closes the
            // connection and leaves the Keychain untouched.
            connection.close()
            throw error
        }
    }

    // MARK: - Timeout

    /// Awaits a single reply, racing the receive against the timeout so a
    /// desktop that never answers cannot hang the handshake forever.
    private func receiveWithTimeout(on connection: PairingConnection) async throws -> InboundMessage {
        try await withThrowingTaskGroup(of: InboundMessage.self) { group in
            group.addTask {
                try await connection.receive()
            }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                throw PairingError.timedOut
            }

            defer { group.cancelAll() }
            guard let result = try await group.next() else {
                throw PairingError.timedOut
            }
            return result
        }
    }

    // MARK: - Persistence

    /// Stores the durable pairing secrets in the Keychain on success.
    private func store(sessionKey: String, host: String, port: Int) throws {
        try keychain.setString(sessionKey, forKey: KeychainKey.sessionKey)
        try keychain.setString(host, forKey: KeychainKey.desktopHost)
        try keychain.setString(String(port), forKey: KeychainKey.desktopPort)
    }
}
