import Foundation

/// A recorded distraction produced when the phone is picked up during a
/// `FocusSession`.
///
/// Each event carries a stable `id` (UUID) so the desktop can deduplicate on
/// merge — important because the phone may resend a batch after a dropped
/// connection.
///
/// - `elapsed`: whole seconds since the session start; maps onto the desktop
///   distraction timeline. Constrained to `0...plannedDuration` by the
///   `SessionTracker`.
/// - `occurredAt`: wall-clock time, used for local history display and dedup.
/// - `tag`: defaults to `.phone` because this event *is* a phone pickup.
/// - `synced`: `false` until acknowledged by the desktop.
///
/// - Requirements: 2.4, 2.6
public struct PickupEvent: Codable, Identifiable {
    public let id: UUID
    public let elapsed: Int
    public let occurredAt: Date
    public var tag: DistractionTag
    public var synced: Bool

    public init(
        id: UUID = UUID(),
        elapsed: Int,
        occurredAt: Date,
        tag: DistractionTag = .phone,
        synced: Bool = false
    ) {
        self.id = id
        self.elapsed = elapsed
        self.occurredAt = occurredAt
        self.tag = tag
        self.synced = synced
    }
}
