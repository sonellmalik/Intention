import Foundation

/// A UI-framework-independent representation of a scene's lifecycle phase.
///
/// SwiftUI's `ScenePhase` is only available with SwiftUI imported and cannot be
/// constructed in a pure-logic test target, which would make the debounce and
/// session-scoping property tests (tasks 2.3, 2.4) impossible to run off-device.
/// `ScenePhaseLike` mirrors the three SwiftUI cases the detector cares about so
/// the detection logic lives in the core library and is exercised in tests with
/// no UI dependency. The SwiftUI live-session view maps `ScenePhase` onto this
/// enum before calling `handleScenePhase(_:)`.
///
/// - Requirements: 1.1, 1.2, 1.3
public enum ScenePhaseLike: String, Codable, CaseIterable {
    /// The app is running in the foreground and is the focus of user interaction.
    case active
    /// The app is in the foreground but not receiving events (e.g. transitioning,
    /// system prompt on screen). Treated as "the user is leaving the app".
    case inactive
    /// The app is no longer visible (backgrounded / phone about to lock).
    case background
}

#if canImport(SwiftUI)
import SwiftUI

public extension ScenePhaseLike {
    /// Maps SwiftUI's `ScenePhase` onto the UI-independent `ScenePhaseLike` used
    /// by the detector, so the live-session view can forward `scenePhase`
    /// changes to `LifecyclePickupDetector.handleScenePhase(_:)` without leaking
    /// SwiftUI into the core detection logic.
    ///
    /// Unknown future cases are treated as `.background` (the conservative
    /// "the app is not in the foreground" interpretation).
    init(_ scenePhase: ScenePhase) {
        switch scenePhase {
        case .active:
            self = .active
        case .inactive:
            self = .inactive
        case .background:
            self = .background
        @unknown default:
            self = .background
        }
    }
}
#endif
