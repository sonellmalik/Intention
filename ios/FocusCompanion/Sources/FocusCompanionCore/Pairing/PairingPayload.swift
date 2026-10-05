import Foundation

/// The QR-encoded handshake payload exchanged during pairing.
///
/// The desktop generates this payload, renders it as a QR code, and the phone
/// scans it to learn where to connect and how to authenticate:
///
/// - `host`/`port`: the LAN address of the desktop WebSocket server. These also
///   back the manual host:port entry fallback when Bonjour discovery is blocked.
/// - `deviceId`: identifies the desktop device.
/// - `pairingToken`: a one-time, short-lived secret used to authenticate the
///   first WebSocket handshake.
/// - `fingerprint`: lets the phone verify it connected to the intended desktop.
///
/// The struct is `Codable` so it round-trips cleanly through JSON: encoding a
/// payload and decoding the scanned result reproduces an equivalent payload
/// with all required fields present.
///
/// - Requirements: 3.1, 4.8
public struct PairingPayload: Codable, Equatable {
    public let host: String
    public let port: Int
    public let deviceId: String
    public let pairingToken: String
    public let fingerprint: String

    public init(
        host: String,
        port: Int,
        deviceId: String,
        pairingToken: String,
        fingerprint: String
    ) {
        self.host = host
        self.port = port
        self.deviceId = deviceId
        self.pairingToken = pairingToken
        self.fingerprint = fingerprint
    }
}

/// An error thrown while decoding or validating a scanned pairing QR string.
public enum PairingPayloadError: Error, Equatable, CustomStringConvertible {
    /// The scanned string could not be read as UTF-8 data.
    case notUTF8
    /// The scanned string was not valid JSON matching the `PairingPayload` shape.
    case malformedJSON(String)
    /// A required field was missing or invalid after decoding.
    ///
    /// - Parameter field: the name of the offending field (e.g. `"host"`).
    case missingField(String)

    public var description: String {
        switch self {
        case .notUTF8:
            return "Scanned QR code is not valid UTF-8 text."
        case .malformedJSON(let detail):
            return "Scanned QR code is not a valid pairing payload: \(detail)"
        case .missingField(let field):
            return "Scanned QR code is missing a required field: \(field)."
        }
    }
}

extension PairingPayload {
    /// Decodes a scanned QR string into a validated `PairingPayload`.
    ///
    /// The scanned string is expected to be the JSON encoding of a
    /// `PairingPayload`. On success the returned payload is guaranteed to have
    /// all required fields (`host`, `port`, `deviceId`, `pairingToken`,
    /// `fingerprint`) present and non-empty (with `port` in the valid TCP range).
    ///
    /// - Parameter scanned: the raw text decoded from the pairing QR code.
    /// - Returns: a validated `PairingPayload`.
    /// - Throws: `PairingPayloadError` if the string is not UTF-8, is not valid
    ///   JSON for a payload, or is missing/has an invalid required field.
    ///
    /// - Requirements: 3.1, 4.8
    public static func decode(fromQRString scanned: String) throws -> PairingPayload {
        guard let data = scanned.data(using: .utf8) else {
            throw PairingPayloadError.notUTF8
        }
        return try decode(fromQRData: data)
    }

    /// Decodes scanned QR bytes into a validated `PairingPayload`.
    ///
    /// - Parameter data: the raw bytes decoded from the pairing QR code.
    /// - Returns: a validated `PairingPayload`.
    /// - Throws: `PairingPayloadError` on malformed JSON or a missing/invalid field.
    ///
    /// - Requirements: 3.1, 4.8
    public static func decode(fromQRData data: Data) throws -> PairingPayload {
        let payload: PairingPayload
        do {
            payload = try JSONDecoder().decode(PairingPayload.self, from: data)
        } catch {
            throw PairingPayloadError.malformedJSON(String(describing: error))
        }
        try payload.validate()
        return payload
    }

    /// Validates that all required fields are present and well-formed.
    ///
    /// String fields must be non-empty and `port` must be a valid TCP port
    /// (`1...65535`). A decoded-but-invalid payload (e.g. an empty `host`)
    /// therefore fails here rather than silently connecting to a bad address.
    ///
    /// - Throws: `PairingPayloadError.missingField` naming the first invalid field.
    ///
    /// - Requirements: 3.1, 4.8
    public func validate() throws {
        if host.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw PairingPayloadError.missingField("host")
        }
        guard (1...65535).contains(port) else {
            throw PairingPayloadError.missingField("port")
        }
        if deviceId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw PairingPayloadError.missingField("deviceId")
        }
        if pairingToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw PairingPayloadError.missingField("pairingToken")
        }
        if fingerprint.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw PairingPayloadError.missingField("fingerprint")
        }
    }
}
