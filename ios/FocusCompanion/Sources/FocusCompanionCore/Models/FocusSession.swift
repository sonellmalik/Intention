import Foundation

/// A single Pomodoro period mirrored from the desktop to the phone.
///
/// The shape is deliberately chosen to round-trip cleanly into the desktop's
/// existing storage: `dateKey` matches the desktop `getDateKey()` (`"YYYY-MM-DD"`),
/// `startedAt`/`plannedDuration` come from the desktop `sessionStarted` message,
/// and `pickups` holds the distraction events recorded during the session.
///
/// - `endedAt`: set when the session completes/stops.
///
/// - Requirements: 2.1
public struct FocusSession: Codable, Identifiable {
    public let id: UUID
    public let dateKey: String
    public let mode: SessionMode
    public let startedAt: Date
    public let plannedDuration: Int
    public var endedAt: Date?
    public var pickups: [PickupEvent]

    public init(
        id: UUID,
        dateKey: String,
        mode: SessionMode,
        startedAt: Date,
        plannedDuration: Int,
        endedAt: Date? = nil,
        pickups: [PickupEvent] = []
    ) {
        self.id = id
        self.dateKey = dateKey
        self.mode = mode
        self.startedAt = startedAt
        self.plannedDuration = plannedDuration
        self.endedAt = endedAt
        self.pickups = pickups
    }
}
