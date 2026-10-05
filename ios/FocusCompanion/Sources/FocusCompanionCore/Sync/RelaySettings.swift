import Foundation

/// The transmission destination the `Sync_Client` is allowed to contact for a
/// given privacy configuration.
///
/// This is the code representation of the privacy invariant (design Property 6):
/// with the cloud relay disabled, distraction data may travel only to the paired
/// desktop on the local network; nothing reaches a hosted relay. When the user
/// explicitly opts in, and only then, the relay becomes a permitted destination.
///
/// Task 13.2 (opt-in encrypted relay) reads this to decide whether the relay
/// path is available at all before it routes an encrypted batch through it, and
/// the privacy property test (task 7.5 / Property 6) asserts that the default
/// case never permits the relay.
///
/// - Requirements: 7.1, 7.4, 8.1, 8.2
public enum RelayDestinationPolicy: Equatable {
    /// LAN-only: transmit distraction data solely to the paired desktop on the
    /// local network. This is the default and the only destination while the
    /// cloud relay is disabled.
    ///
    /// - Requirements: 7.1, 7.4
    case pairedDesktopOnly

    /// The user has explicitly enabled the cloud relay, so batches may be routed
    /// through the hosted relay (end-to-end encrypted, task 13.2) in addition to
    /// the paired desktop.
    ///
    /// - Requirements: 8.2
    case pairedDesktopOrEncryptedRelay
}

/// Observable privacy/relay configuration shared by the settings UI and the
/// sync path.
///
/// FocusFlow's promise is local-first: no account, no analytics, and no cloud by
/// default. `RelaySettings` is the single source of truth for that promise in
/// code. It lives in `FocusCompanionCore` (rather than the app target) so the
/// sync client can read the same value the settings screen writes — the settings
/// view binds to `cloudRelayEnabled`, and task 13.2's relay routing consults
/// `destinationPolicy` to decide whether the relay path is permitted.
///
/// Defaults encode the privacy posture directly:
/// - `cloudRelayEnabled` defaults to `false` (Requirement 8.1).
/// - `accountRequired` is always `false` — the app has no accounts (Requirement 7.2).
/// - `analyticsTransmitted` is always `false` — the app sends no analytics (Requirement 7.3).
///
/// The `cloudRelayEnabled` flag is persisted by the app via `@AppStorage`
/// (SwiftUI writes it to `UserDefaults`); this type also mirrors it into a
/// `UserDefaults`-backed store so the sync client can read the current value
/// without depending on SwiftUI. Both read the same key, so the settings toggle
/// and the sync path never disagree.
///
/// - Requirements: 7.1, 7.2, 7.3, 7.4, 8.1
public final class RelaySettings: ObservableObject {
    /// The `UserDefaults` key backing `cloudRelayEnabled`. The settings view's
    /// `@AppStorage` uses this exact key so the SwiftUI toggle and this model
    /// stay in sync through the shared defaults store.
    public static let cloudRelayEnabledKey = "focuscompanion.cloudRelayEnabled"

    /// Whether the optional cloud relay is enabled. Defaults to `false` so no
    /// distraction data ever leaves the two paired devices unless the user
    /// explicitly opts in.
    ///
    /// Writing this value persists it to the backing `UserDefaults` under
    /// ``cloudRelayEnabledKey`` and republishes ``destinationPolicy``.
    ///
    /// - Requirements: 8.1
    @Published public var cloudRelayEnabled: Bool {
        didSet {
            defaults.set(cloudRelayEnabled, forKey: Self.cloudRelayEnabledKey)
        }
    }

    /// Whether using the app requires an account. Always `false`: the companion
    /// app operates with no accounts. Exposed as a stored constant so the
    /// settings screen can state the guarantee to the user rather than hard-code
    /// it in the view.
    ///
    /// - Requirements: 7.2
    public let accountRequired: Bool = false

    /// Whether the app transmits analytics. Always `false`: the companion app
    /// sends no analytics data.
    ///
    /// - Requirements: 7.3
    public let analyticsTransmitted: Bool = false

    /// The `UserDefaults` store the flag is persisted to. Shared with the
    /// settings view's `@AppStorage` (both key off ``cloudRelayEnabledKey``).
    private let defaults: UserDefaults

    /// Creates the settings model, restoring `cloudRelayEnabled` from the backing
    /// store (defaulting to `false` when absent).
    ///
    /// - Parameter defaults: the `UserDefaults` store to read/write the relay
    ///   flag. Defaults to `.standard`; tests inject a suite-scoped store.
    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        // Absent key -> `object(forKey:)` is nil -> default to disabled.
        if defaults.object(forKey: Self.cloudRelayEnabledKey) == nil {
            self.cloudRelayEnabled = false
        } else {
            self.cloudRelayEnabled = defaults.bool(forKey: Self.cloudRelayEnabledKey)
        }
    }

    /// The destination the sync client is currently permitted to contact.
    ///
    /// This is the privacy invariant expressed as a value the sync path can
    /// branch on: while the relay is disabled the only permitted destination is
    /// the paired desktop (`.pairedDesktopOnly`); enabling the relay widens it to
    /// include the encrypted relay (`.pairedDesktopOrEncryptedRelay`). Task 13.2
    /// reads this before routing any batch through the relay.
    ///
    /// - Requirements: 7.1, 7.4, 8.2
    public var destinationPolicy: RelayDestinationPolicy {
        cloudRelayEnabled ? .pairedDesktopOrEncryptedRelay : .pairedDesktopOnly
    }

    /// Whether transmitting distraction data to the hosted cloud relay is
    /// currently permitted. `false` unless the user has explicitly enabled the
    /// relay, so the default LAN path never contacts a relay (design Property 6).
    ///
    /// - Requirements: 7.4, 8.1
    public var isRelayTransmissionPermitted: Bool {
        destinationPolicy == .pairedDesktopOrEncryptedRelay
    }
}
