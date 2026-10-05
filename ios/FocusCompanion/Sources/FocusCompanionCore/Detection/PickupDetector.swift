import Foundation

/// Detects when the user picks up / uses the phone during an active focus
/// session and emits one `PickupEvent`-worth of information per detected pickup.
///
/// The protocol is the substitution seam for the detection strategy: the v1
/// default is a foreground lifecycle counter (`LifecyclePickupDetector`,
/// Option B), but an alternative strategy — for example an Option A detector
/// built on `DeviceActivity`/`FamilyControls` — can be dropped in without
/// changing the `PickupEvent` output shape, because every strategy reports the
/// same thing: the wall-clock time a pickup occurred. The `SessionTracker`
/// converts each reported time into a `PickupEvent`, so the rest of the app is
/// unaffected by which detector is wired in.
///
/// - Requirements: 1.4
public protocol PickupDetector: AnyObject {
    /// Invoked once for each detected phone pickup / app-switch.
    ///
    /// The associated value is the wall-clock time the pickup occurred
    /// (`occurredAt`), which the `SessionTracker` maps onto the session's
    /// elapsed timeline.
    var onPickup: ((_ occurredAt: Date) -> Void)? { get set }

    /// Begin detecting pickups for the given active focus session.
    ///
    /// - Parameter session: the focus session that pickups are recorded against.
    func start(session: FocusSession)

    /// Stop detecting pickups and release any observation resources.
    func stop()
}
