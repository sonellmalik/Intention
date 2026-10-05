import Foundation

/// The v1 default `PickupDetector`: foreground-session lifecycle counting
/// (design Option B).
///
/// While a focus session is running the companion app is expected to be the
/// foreground app (the user sets the phone down with the app open). Each time
/// the app leaves the foreground (`inactive`/`background`) and later returns to
/// `active`, that round trip is counted as one pickup — the user turned the
/// phone on / switched away and came back. This needs no special entitlement
/// and yields precise per-pickup timestamps that map onto the desktop's
/// `elapsed`-based distraction timeline.
///
/// The detector implements Algorithm 1 (`LifecyclePickupDetector`) from the
/// design:
///
/// - `active` — whether a focus session is running. When `false`, no pickup is
///   ever emitted (Requirement 1.3).
/// - `wasActive` — whether the most recent phase was `.active`. A pickup fires
///   only on an `inactive`/`background` → `active` transition (Requirement 1.1).
/// - `minGapSeconds` — debounce window (default `2`) that suppresses accidental
///   flickers; two pickups are never emitted closer together than this
///   (Requirement 1.2).
/// - `lastPickupAt` — the time of the last emitted pickup, used for the debounce.
///
/// ## Testability
///
/// Scene phase is expressed as the UI-independent ``ScenePhaseLike`` enum and
/// the current-time source is injected via `now`, so the debounce and
/// session-scoping property tests (tasks 2.3, 2.4) run deterministically off
/// device. The SwiftUI live-session view binds `scenePhase` to
/// `handleScenePhase(_:)`:
///
/// ```swift
/// .onChange(of: scenePhase) { newPhase in
///     detector.handleScenePhase(ScenePhaseLike(newPhase))
/// }
/// ```
///
/// - Requirements: 1.1, 1.2, 1.3
public final class LifecyclePickupDetector: PickupDetector {
    /// Invoked once for each detected pickup with the wall-clock time it occurred.
    public var onPickup: ((_ occurredAt: Date) -> Void)?

    /// Whether a focus session is currently running. No pickup is emitted while
    /// this is `false`.
    private var active: Bool = false

    /// Whether the last observed scene phase was `.active`. A pickup fires only
    /// on the transition from a non-active phase back to `.active`.
    private var wasActive: Bool = true

    /// Minimum spacing between two emitted pickups; debounces accidental
    /// foreground flickers.
    private let minGapSeconds: TimeInterval

    /// The time of the most recently emitted pickup, or `nil` if none yet.
    private var lastPickupAt: Date?

    /// Injectable current-time provider so the debounce is deterministic in
    /// tests. Defaults to `Date()` on device.
    private let now: () -> Date

    /// Creates a lifecycle pickup detector.
    ///
    /// - Parameters:
    ///   - minGapSeconds: Debounce window in seconds between emitted pickups.
    ///     Defaults to `2` per Algorithm 1.
    ///   - now: Current-time provider, injectable for deterministic tests.
    ///     Defaults to `Date()`.
    public init(
        minGapSeconds: TimeInterval = 2,
        now: @escaping () -> Date = { Date() }
    ) {
        self.minGapSeconds = minGapSeconds
        self.now = now
    }

    // MARK: - PickupDetector

    /// Begins detecting pickups for the given session.
    ///
    /// Marks the detector active and seeds `wasActive = true` on the assumption
    /// that the app is the foreground app when the session begins (design
    /// precondition). The SwiftUI view is responsible for forwarding subsequent
    /// scene-phase changes via `handleScenePhase(_:)`.
    ///
    /// - Parameter session: the focus session pickups are recorded against.
    /// - Requirements: 1.1
    public func start(session: FocusSession) {
        active = true
        wasActive = true
    }

    /// Stops detecting pickups.
    ///
    /// Further scene-phase changes are ignored until `start(session:)` is called
    /// again, so no pickup is emitted once a session has ended (Requirement 1.3).
    public func stop() {
        active = false
    }

    // MARK: - Scene phase handling

    /// The SwiftUI-binding entry point wrapping Algorithm 1's
    /// `onScenePhaseChanged`. Call this whenever the observed scene phase changes.
    ///
    /// Emits `onPickup(now)` on an `inactive`/`background` → `active` round trip,
    /// but only while a session is active and only when the debounce gap has
    /// elapsed since the last emitted pickup. Leaving the foreground records
    /// `wasActive = false`. When no session is active this is a no-op.
    ///
    /// - Parameter phase: the new scene phase.
    /// - Requirements: 1.1, 1.2, 1.3
    public func handleScenePhase(_ phase: ScenePhaseLike) {
        guard active else { return }

        switch phase {
        case .active:
            if !wasActive {
                // App returned to the foreground => the user picked the phone
                // back up. Emit a pickup unless it falls inside the debounce gap.
                let occurredAt = now()
                if let last = lastPickupAt, occurredAt.timeIntervalSince(last) < minGapSeconds {
                    // Debounced: too close to the previous pickup (Requirement 1.2).
                } else {
                    lastPickupAt = occurredAt
                    onPickup?(occurredAt)
                }
            }
            wasActive = true
        case .inactive, .background:
            // User left the app / the phone is about to lock.
            wasActive = false
        }
    }
}
