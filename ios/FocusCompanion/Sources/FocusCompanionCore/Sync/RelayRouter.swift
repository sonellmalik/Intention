import Foundation

#if canImport(CryptoKit)
import CryptoKit
#endif

/// End-to-end encryption seam for the optional cloud relay (task 13.2).
///
/// The relay is an untrusted forwarder: when the user opts in, a distraction
/// batch is routed through a hosted relay to reach the paired desktop across
/// networks. To keep FocusFlow's privacy promise, the relay must never see
/// plaintext distraction data — it only ever handles ciphertext that solely the
/// paired peer's key can open (design Property 12, Requirement 8.2).
///
/// This protocol is the encryption boundary. `encrypt(_:)` turns a plaintext
/// payload into a `RelayEnvelope` (ciphertext + nonce) the relay may carry;
/// `decrypt(_:)` recovers the plaintext with the shared peer key. Hiding it
/// behind a protocol keeps `RelayRouter` and its tests free of any concrete
/// crypto dependency, and lets non-CryptoKit CI substitute a test double.
///
/// - Requirements: 8.2
public protocol RelayEncrypting {
    /// Encrypt plaintext for transport through the untrusted relay.
    ///
    /// - Parameter plaintext: the serialized distraction batch bytes.
    /// - Returns: an envelope carrying only ciphertext (and a nonce); no
    ///   plaintext-derived bytes are exposed.
    /// - Throws: if encryption fails.
    func encrypt(_ plaintext: Data) throws -> RelayEnvelope

    /// Decrypt an envelope received from the relay with the shared peer key.
    ///
    /// - Parameter envelope: the ciphertext envelope forwarded by the relay.
    /// - Returns: the recovered plaintext bytes.
    /// - Throws: if authentication/decryption fails (tampering, wrong key).
    func decrypt(_ envelope: RelayEnvelope) throws -> Data
}

/// The only thing the relay ever sees: authenticated ciphertext plus the nonce
/// needed to open it. Contains no plaintext and no key material.
///
/// It is `Codable` so it can be JSON-framed for the relay, and the ciphertext /
/// nonce are base64 strings so the wire form is plain text. Because the sealed
/// box is authenticated (AES-GCM), any bit the relay flips causes `decrypt` to
/// throw rather than yield forged plaintext.
///
/// - Requirements: 8.2
public struct RelayEnvelope: Codable, Equatable {
    /// Base64-encoded AES-GCM combined sealed box (nonce is carried separately
    /// for clarity/inspection; `ciphertext` is the ciphertext+tag).
    public let ciphertext: String
    /// Base64-encoded AES-GCM nonce.
    public let nonce: String

    public init(ciphertext: String, nonce: String) {
        self.ciphertext = ciphertext
        self.nonce = nonce
    }
}

/// Errors thrown along the relay path.
public enum RelayError: Error, Equatable, CustomStringConvertible {
    /// The relay was asked to transmit while the user has it disabled — the
    /// privacy invariant refused the send (Requirement 7.4 / 8.1).
    case relayDisabled
    /// Encryption/decryption failed (bad key, tampered ciphertext, bad base64).
    case cryptoFailure(String)
    /// CryptoKit is unavailable on this platform (stub build).
    case cryptoUnavailable

    public var description: String {
        switch self {
        case .relayDisabled:
            return "Cloud relay is disabled; refusing to transmit to a relay."
        case .cryptoFailure(let detail):
            return "Relay encryption failed: \(detail)."
        case .cryptoUnavailable:
            return "CryptoKit is unavailable on this platform."
        }
    }
}

/// A relay transport: hands an already-encrypted envelope to the hosted relay.
///
/// Kept minimal and behind a protocol so `RelayRouter` never encrypts *and*
/// sends in one place a test can't observe — tests inject a fake that records
/// the envelope it was given and asserts it is ciphertext, never plaintext.
///
/// - Requirements: 8.2
public protocol RelayTransport: AnyObject {
    /// Forward an encrypted envelope through the relay to the paired peer.
    ///
    /// - Parameter envelope: ciphertext-only payload; the transport (and the
    ///   relay behind it) never receives plaintext.
    func forward(_ envelope: RelayEnvelope) async throws
}

/// Routes distraction batches to the correct destination based on the user's
/// privacy configuration, encrypting anything bound for the relay.
///
/// This is the task 13.2 policy gate. It reads ``RelaySettings/destinationPolicy``
/// — the single source of truth for the privacy posture — and:
///
/// - **`.pairedDesktopOnly`** (relay off, the default): the router refuses to
///   contact the relay at all. `sendViaRelay(_:)` throws `.relayDisabled`, so
///   the default LAN path can never leak to a hosted relay (Property 6 / 8.1).
/// - **`.pairedDesktopOrEncryptedRelay`** (user opted in): the batch is
///   serialized, encrypted into a `RelayEnvelope`, and only the ciphertext is
///   handed to the `RelayTransport`. The relay sees ciphertext, decryptable
///   only with the paired peer's key (Property 12 / 8.2).
///
/// Manual `host:port` remains the non-relay fallback for a blocked LAN
/// (Requirement 8.3): it is a direct `NetworkSyncClient` connection and does not
/// go through this router, so turning the relay off never disables that path.
///
/// The router is pure policy + crypto orchestration over injected protocols, so
/// it and Property 12 are testable without CryptoKit or a real relay.
///
/// - Requirements: 8.2, 8.3
public final class RelayRouter {
    private let settings: RelaySettings
    private let encryptor: RelayEncrypting
    private let transport: RelayTransport
    private let encoder: JSONEncoder

    /// - Parameters:
    ///   - settings: the shared privacy/relay configuration (relay off by default).
    ///   - encryptor: the end-to-end encryption boundary for relay-bound data.
    ///   - transport: the relay transport that carries ciphertext envelopes.
    public init(
        settings: RelaySettings,
        encryptor: RelayEncrypting,
        transport: RelayTransport
    ) {
        self.settings = settings
        self.encryptor = encryptor
        self.transport = transport

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        self.encoder = encoder
    }

    /// Whether the relay path is currently permitted by the user's settings.
    /// Mirrors ``RelaySettings/isRelayTransmissionPermitted`` for call-site clarity.
    public var isRelayPermitted: Bool {
        settings.isRelayTransmissionPermitted
    }

    /// Encrypt and route a message through the relay — only if the user enabled it.
    ///
    /// Enforces the privacy invariant *before* touching the network: if the relay
    /// is disabled the message is never serialized or sent (throws
    /// `.relayDisabled`). When enabled, the message is encoded, encrypted, and
    /// only the resulting ciphertext envelope is forwarded — the relay never sees
    /// plaintext (Property 12).
    ///
    /// - Parameter message: the `OutboundMessage` (typically a `distractionBatch`).
    /// - Returns: the ciphertext `RelayEnvelope` that was forwarded (returned so
    ///   callers/tests can confirm it carries no plaintext).
    /// - Throws: `RelayError.relayDisabled` when the relay is off, or a crypto /
    ///   transport error on failure.
    ///
    /// - Requirements: 8.1, 8.2
    @discardableResult
    public func sendViaRelay(_ message: OutboundMessage) async throws -> RelayEnvelope {
        guard settings.isRelayTransmissionPermitted else {
            throw RelayError.relayDisabled
        }
        let plaintext = try encoder.encode(message)
        let envelope = try encryptor.encrypt(plaintext)
        try await transport.forward(envelope)
        return envelope
    }
}

#if canImport(CryptoKit)

/// AES-GCM end-to-end encryption using a symmetric key derived from the paired
/// peer's `sessionKey`.
///
/// Both devices already share a durable `sessionKey` from pairing (stored in the
/// Keychain). This encryptor derives a 256-bit symmetric key from it and seals
/// each payload with AES-GCM, which is authenticated: the relay cannot read the
/// plaintext (confidentiality) and cannot tamper with it undetected (integrity).
/// The relay only ever holds the resulting ciphertext + nonce.
///
/// - Requirements: 8.2
public struct AESGCMRelayEncryptor: RelayEncrypting {
    private let key: SymmetricKey

    /// Derive the symmetric key from the shared pairing `sessionKey`.
    ///
    /// - Parameter sessionKey: the durable per-pair secret established during
    ///   pairing (the same value both peers hold), used as key material.
    public init(sessionKey: String) {
        // SHA-256 over the shared secret yields a stable 256-bit key both peers
        // compute identically — no key material is transmitted.
        let digest = SHA256.hash(data: Data(sessionKey.utf8))
        self.key = SymmetricKey(data: Data(digest))
    }

    public func encrypt(_ plaintext: Data) throws -> RelayEnvelope {
        do {
            let sealed = try AES.GCM.seal(plaintext, using: key)
            guard let combined = sealed.combined else {
                throw RelayError.cryptoFailure("no combined box")
            }
            return RelayEnvelope(
                ciphertext: combined.base64EncodedString(),
                nonce: Data(sealed.nonce).base64EncodedString()
            )
        } catch let error as RelayError {
            throw error
        } catch {
            throw RelayError.cryptoFailure(String(describing: error))
        }
    }

    public func decrypt(_ envelope: RelayEnvelope) throws -> Data {
        guard let combined = Data(base64Encoded: envelope.ciphertext) else {
            throw RelayError.cryptoFailure("ciphertext is not valid base64")
        }
        do {
            let box = try AES.GCM.SealedBox(combined: combined)
            return try AES.GCM.open(box, using: key)
        } catch {
            throw RelayError.cryptoFailure(String(describing: error))
        }
    }
}

#endif
