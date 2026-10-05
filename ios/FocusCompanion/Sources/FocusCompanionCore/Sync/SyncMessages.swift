import Foundation

/// The wire representation of a single distraction inside a `distractionBatch`.
///
/// This is intentionally narrower than the on-device `PickupEvent`: only the
/// fields the desktop needs to merge and dedup travel on the wire (`id`,
/// `elapsed`, `occurredAt`, `tag`). The local-only `synced` flag stays on the
/// phone. Keeping a dedicated wire struct means the transport shape is decoupled
/// from the storage shape and matches the design wire format exactly.
///
/// - Requirements: 4.3
public struct DistractionEvent: Codable, Equatable, Identifiable {
    public let id: UUID
    public let elapsed: Int
    public let occurredAt: Date
    public let tag: DistractionTag

    public init(id: UUID, elapsed: Int, occurredAt: Date, tag: DistractionTag) {
        self.id = id
        self.elapsed = elapsed
        self.occurredAt = occurredAt
        self.tag = tag
    }

    /// Builds the wire event from a recorded `PickupEvent`, dropping the
    /// local-only `synced` flag.
    public init(_ pickup: PickupEvent) {
        self.id = pickup.id
        self.elapsed = pickup.elapsed
        self.occurredAt = pickup.occurredAt
        self.tag = pickup.tag
    }
}

/// Identifies the phone to the desktop during the pairing handshake.
///
/// Matches the nested `device` object in the `pairRequest` wire format:
/// `{ "name": ..., "platform": "ios" }`.
///
/// - Requirements: 4.3
public struct DeviceInfo: Codable, Equatable {
    public let name: String
    public let platform: String

    public init(name: String, platform: String = "ios") {
        self.name = name
        self.platform = platform
    }
}

// MARK: - Outbound (phone -> desktop)

/// A message sent from the phone to the desktop.
///
/// Both cases carry an explicit `type` discriminator on the wire so the desktop
/// can route them:
///
/// - `distractionBatch`:
///   `{ "type": "distractionBatch", "sessionId", "dateKey", "events": [ … ] }`
/// - `pairRequest`:
///   `{ "type": "pairRequest", "pairingToken", "device": { "name", "platform" } }`
///
/// The `Codable` conformance is hand-written so the encoded JSON matches the
/// design wire format exactly (a flat object with a `type` tag), rather than the
/// nested container Swift would synthesise for an enum with associated values.
///
/// - Requirements: 4.3
public enum OutboundMessage: Equatable {
    /// One or more pickups for a session, pushed to the desktop for merge.
    case distractionBatch(sessionId: UUID, dateKey: String, events: [DistractionEvent])
    /// The first-handshake pairing request carrying the one-time token.
    case pairRequest(pairingToken: String, device: DeviceInfo)

    /// The `type` discriminator values used on the wire.
    public enum Kind: String {
        case distractionBatch
        case pairRequest
    }

    /// The wire `type` value for this message.
    public var kind: Kind {
        switch self {
        case .distractionBatch: return .distractionBatch
        case .pairRequest: return .pairRequest
        }
    }
}

extension OutboundMessage: Codable {
    private enum CodingKeys: String, CodingKey {
        case type
        // distractionBatch
        case sessionId
        case dateKey
        case events
        // pairRequest
        case pairingToken
        case device
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(kind.rawValue, forKey: .type)
        switch self {
        case let .distractionBatch(sessionId, dateKey, events):
            try container.encode(sessionId, forKey: .sessionId)
            try container.encode(dateKey, forKey: .dateKey)
            try container.encode(events, forKey: .events)
        case let .pairRequest(pairingToken, device):
            try container.encode(pairingToken, forKey: .pairingToken)
            try container.encode(device, forKey: .device)
        }
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let rawType = try container.decode(String.self, forKey: .type)
        guard let kind = Kind(rawValue: rawType) else {
            throw SyncMessageError.unknownType(rawType)
        }
        switch kind {
        case .distractionBatch:
            let sessionId = try container.decode(UUID.self, forKey: .sessionId)
            let dateKey = try container.decode(String.self, forKey: .dateKey)
            let events = try container.decode([DistractionEvent].self, forKey: .events)
            self = .distractionBatch(sessionId: sessionId, dateKey: dateKey, events: events)
        case .pairRequest:
            let pairingToken = try container.decode(String.self, forKey: .pairingToken)
            let device = try container.decode(DeviceInfo.self, forKey: .device)
            self = .pairRequest(pairingToken: pairingToken, device: device)
        }
    }
}

// MARK: - Inbound (desktop -> phone)

/// A message received by the phone from the desktop.
///
/// Cases map one-to-one onto the design's desktop→phone wire formats:
///
/// - `sessionStarted`:
///   `{ "type": "sessionStarted", "sessionId", "dateKey", "mode", "startedAt", "plannedDuration" }`
/// - `sessionStopped`:
///   `{ "type": "sessionStopped", "sessionId", "reason" }`
/// - `ack`: `{ "type": "ack", "eventIds": [ … ] }`
/// - `pairAck`: `{ "type": "pairAck", "sessionKey", "fingerprint" }`
/// - `pairError`: `{ "type": "pairError" }`
///
/// As with `OutboundMessage`, the `Codable` conformance is hand-written so the
/// wire JSON is a flat, `type`-tagged object.
///
/// - Requirements: 4.7
public enum InboundMessage: Equatable {
    /// The desktop started a focus session; mirror it into a `FocusSession`.
    case sessionStarted(sessionId: UUID, dateKey: String, mode: SessionMode, startedAt: Date, plannedDuration: Int)
    /// The desktop stopped the session; finalize it locally.
    case sessionStopped(sessionId: UUID, reason: String)
    /// The desktop confirmed receipt of a batch; carries the acked event ids.
    case ack(eventIds: [UUID])
    /// The desktop accepted pairing; carries the durable session key and fingerprint.
    case pairAck(sessionKey: String, fingerprint: String)
    /// The desktop rejected the pairing request (invalid/expired token).
    case pairError

    /// The `type` discriminator values used on the wire.
    public enum Kind: String {
        case sessionStarted
        case sessionStopped
        case ack
        case pairAck
        case pairError
    }

    /// The wire `type` value for this message.
    public var kind: Kind {
        switch self {
        case .sessionStarted: return .sessionStarted
        case .sessionStopped: return .sessionStopped
        case .ack: return .ack
        case .pairAck: return .pairAck
        case .pairError: return .pairError
        }
    }
}

extension InboundMessage: Codable {
    private enum CodingKeys: String, CodingKey {
        case type
        // sessionStarted
        case sessionId
        case dateKey
        case mode
        case startedAt
        case plannedDuration
        // sessionStopped
        case reason
        // ack
        case eventIds
        // pairAck
        case sessionKey
        case fingerprint
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(kind.rawValue, forKey: .type)
        switch self {
        case let .sessionStarted(sessionId, dateKey, mode, startedAt, plannedDuration):
            try container.encode(sessionId, forKey: .sessionId)
            try container.encode(dateKey, forKey: .dateKey)
            try container.encode(mode, forKey: .mode)
            try container.encode(startedAt, forKey: .startedAt)
            try container.encode(plannedDuration, forKey: .plannedDuration)
        case let .sessionStopped(sessionId, reason):
            try container.encode(sessionId, forKey: .sessionId)
            try container.encode(reason, forKey: .reason)
        case let .ack(eventIds):
            try container.encode(eventIds, forKey: .eventIds)
        case let .pairAck(sessionKey, fingerprint):
            try container.encode(sessionKey, forKey: .sessionKey)
            try container.encode(fingerprint, forKey: .fingerprint)
        case .pairError:
            break
        }
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let rawType = try container.decode(String.self, forKey: .type)
        guard let kind = Kind(rawValue: rawType) else {
            throw SyncMessageError.unknownType(rawType)
        }
        switch kind {
        case .sessionStarted:
            let sessionId = try container.decode(UUID.self, forKey: .sessionId)
            let dateKey = try container.decode(String.self, forKey: .dateKey)
            let mode = try container.decode(SessionMode.self, forKey: .mode)
            let startedAt = try container.decode(Date.self, forKey: .startedAt)
            let plannedDuration = try container.decode(Int.self, forKey: .plannedDuration)
            self = .sessionStarted(
                sessionId: sessionId,
                dateKey: dateKey,
                mode: mode,
                startedAt: startedAt,
                plannedDuration: plannedDuration
            )
        case .sessionStopped:
            let sessionId = try container.decode(UUID.self, forKey: .sessionId)
            let reason = try container.decode(String.self, forKey: .reason)
            self = .sessionStopped(sessionId: sessionId, reason: reason)
        case .ack:
            let eventIds = try container.decode([UUID].self, forKey: .eventIds)
            self = .ack(eventIds: eventIds)
        case .pairAck:
            let sessionKey = try container.decode(String.self, forKey: .sessionKey)
            let fingerprint = try container.decode(String.self, forKey: .fingerprint)
            self = .pairAck(sessionKey: sessionKey, fingerprint: fingerprint)
        case .pairError:
            self = .pairError
        }
    }
}

/// An error thrown while decoding a sync message from the wire.
public enum SyncMessageError: Error, Equatable, CustomStringConvertible {
    /// The `type` discriminator did not match any known message case.
    case unknownType(String)

    public var description: String {
        switch self {
        case .unknownType(let type):
            return "Unknown sync message type: \(type)."
        }
    }
}
