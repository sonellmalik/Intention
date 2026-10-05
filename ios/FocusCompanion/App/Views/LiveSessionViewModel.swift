import Foundation
import Combine
import FocusCompanionCore

/// A thin `ObservableObject` that exposes the live session state to SwiftUI.
///
/// `SessionTracker`, `LifecyclePickupDetector`, `LocalStore`, and `SyncClient`
/// are plain (non-`ObservableObject`) classes in `FocusCompanionCore` so they
/// stay UI-independent and testable off device. This view model is the light
/// adapter that bridges them into SwiftUI: it holds the shared collaborators,
/// publishes the running pickup count for the active session, and forwards
/// scene-phase changes to the detector.
///
/// ## Collaborator injection
///
/// The `tracker` and `detector` are injected so task 12.3 can wire the *shared*
/// instances (the same `SessionTracker`/`LifecyclePickupDetector`/`LocalStore`/
/// `SyncClient` graph the sync client drives) into this view model, rather than
/// each view owning its own disconnected copies. A default initializer builds a
/// standalone graph so the live view can be previewed / run in isolation.
///
/// ## Observing pickups
///
/// `SessionTracker` is not itself observable, so the view model refreshes its
/// published state from `tracker.current` in response to the two events that
/// change it: a detected pickup (via `detector.onPickup`) and a scene-phase
/// transition it forwards. The tracker remains the source of truth; this type
/// only mirrors `current?.pickups.count` into a `@Published` value SwiftUI can
/// observe.
///
/// - Requirements: 1.1
@MainActor
final class LiveSessionViewModel: ObservableObject {
    /// The running pickup count for the active session, or `0` when idle.
    @Published private(set) var pickupCount: Int = 0

    /// The mode of the active session, if one is running (for display).
    @Published private(set) var activeMode: SessionMode?

    /// Whether a focus session is currently active.
    @Published private(set) var isSessionActive: Bool = false

    private let tracker: SessionTracker
    private let detector: LifecyclePickupDetector

    /// Creates a live-session view model over shared collaborators.
    ///
    /// - Parameters:
    ///   - tracker: the shared `SessionTracker` that owns the active session.
    ///   - detector: the shared lifecycle detector whose `onPickup` drives the
    ///     tracker; scene-phase changes are forwarded to it here.
    init(tracker: SessionTracker, detector: LifecyclePickupDetector) {
        self.tracker = tracker
        self.detector = detector
        installPickupHook()
        refresh()
    }

    /// Convenience initializer that builds a standalone collaborator graph, used
    /// for previews and running the live view in isolation. Task 12.3 injects the
    /// shared graph via `init(tracker:detector:)` instead.
    convenience init() {
        let store = LocalStore()
        let detector = LifecyclePickupDetector()
        let sync = NetworkSyncClient()
        let tracker = SessionTracker(store: store, detector: detector, syncClient: sync)
        detector.onPickup = { [weak tracker] occurredAt in
            tracker?.onPickup(occurredAt: occurredAt)
        }
        self.init(tracker: tracker, detector: detector)
    }

    /// Forward a SwiftUI scene-phase change to the detector, then refresh the
    /// published count.
    ///
    /// The live-session view binds this to `.onChange(of: scenePhase)`, mapping
    /// `ScenePhase` onto the UI-independent `ScenePhaseLike` the detector expects
    /// (the `ScenePhaseLike(_:)` adapter already exists in the core library):
    ///
    /// ```swift
    /// .onChange(of: scenePhase) { handleScenePhase(ScenePhaseLike($0)) }
    /// ```
    ///
    /// - Requirements: 1.1
    func handleScenePhase(_ phase: ScenePhaseLike) {
        detector.handleScenePhase(phase)
        refresh()
    }

    /// Re-read the observable state from the tracker's current session.
    func refresh() {
        let current = tracker.current
        pickupCount = current?.pickups.count ?? 0
        activeMode = current?.mode
        isSessionActive = current != nil
    }

    /// Wrap the detector's `onPickup` so each detected pickup — after the tracker
    /// records it — refreshes the published count. The tracker's own hook (wired
    /// in task 12.3 / the convenience graph) still runs; this chains a refresh
    /// after it so the count SwiftUI shows stays in step with `tracker.current`.
    private func installPickupHook() {
        let existing = detector.onPickup
        detector.onPickup = { [weak self] occurredAt in
            existing?(occurredAt)
            Task { @MainActor in self?.refresh() }
        }
    }
}
