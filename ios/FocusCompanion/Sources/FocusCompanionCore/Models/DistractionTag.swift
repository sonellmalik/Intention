import Foundation

/// A classification of a distraction event.
///
/// Phone pickups produced by this companion app always use `.phone`; the other
/// cases exist so the model matches the desktop's shared distraction taxonomy
/// (`phone` | `people` | `thought` | `other`).
///
/// - Requirements: 2.4
public enum DistractionTag: String, Codable, CaseIterable {
    case phone
    case people
    case thought
    case other
}
