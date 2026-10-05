import Foundation

/// The type of a `FocusSession`, mirrored from the desktop's Pomodoro mode.
///
/// The raw values are chosen to round-trip cleanly with the desktop wire format
/// (`"work"`, `"shortBreak"`, `"longBreak"`).
///
/// - Requirements: 2.1
public enum SessionMode: String, Codable, CaseIterable {
    case work
    case shortBreak
    case longBreak
}
