import SwiftUI
import FocusCompanionCore

/// The settings screen for the companion app.
///
/// This screen surfaces FocusFlow's local-first privacy promise and the single
/// user-facing toggle that can change it — the optional cloud relay:
///
/// - The cloud relay defaults to **disabled** and is persisted via `@AppStorage`
///   under ``RelaySettings/cloudRelayEnabledKey`` with a default of `false`, so a
///   fresh install never transmits to a hosted relay (Requirement 8.1).
/// - The screen states that no account is required and no analytics are
///   transmitted (Requirements 7.2, 7.3).
/// - While the relay is off (LAN mode), it shows that distraction data is sent
///   only to the paired desktop on the local network (Requirements 7.1, 7.4).
///
/// The toggle binds to the same `UserDefaults` key that ``RelaySettings`` reads,
/// so the sync path (task 13.2) sees exactly the value shown here. Task 13.2
/// layers opt-in end-to-end-encrypted relay routing on top of this toggle;
/// nothing here contacts the network — it only records the user's choice.
///
/// - Requirements: 7.1, 7.2, 7.3, 7.4, 8.1
struct SettingsView: View {
    /// The persisted cloud-relay opt-in, keyed to the same `UserDefaults` entry
    /// ``RelaySettings`` reads so the UI and the sync path agree. Default `false`
    /// keeps the relay off until the user explicitly enables it (Requirement 8.1).
    @AppStorage(RelaySettings.cloudRelayEnabledKey) private var cloudRelayEnabled: Bool = false

    /// The shared privacy/relay model, used to render the account/analytics
    /// guarantees and the current transmission destination. Injected so the app
    /// and previews can share one instance with the sync client.
    @ObservedObject var settings: RelaySettings

    var body: some View {
        NavigationView {
            Form {
                privacySection
                relaySection
                transmissionSection
            }
            .navigationTitle("Settings")
        }
    }

    /// States the account and analytics guarantees (Requirements 7.2, 7.3).
    private var privacySection: some View {
        Section {
            Label {
                Text(settings.accountRequired ? "Account required" : "No account required")
            } icon: {
                Image(systemName: "person.crop.circle.badge.xmark")
            }

            Label {
                Text(settings.analyticsTransmitted ? "Analytics enabled" : "No analytics transmitted")
            } icon: {
                Image(systemName: "chart.bar.xaxis")
            }
        } header: {
            Text("Privacy")
        } footer: {
            Text("FocusCompanion works entirely on your devices. It never asks you to sign in and never sends usage analytics.")
        }
    }

    /// The single opt-in that can widen the transmission destination beyond the
    /// paired desktop (Requirement 8.1). Off by default.
    private var relaySection: some View {
        Section {
            Toggle("Enable cloud relay", isOn: $cloudRelayEnabled)
                // Keep the shared model in lockstep with the toggle so the sync
                // path reads the same value the user just set. Both persist to
                // the same UserDefaults key, so this is belt-and-suspenders for
                // the in-memory `@Published` observers within this process.
                .onChange(of: cloudRelayEnabled) { newValue in
                    settings.cloudRelayEnabled = newValue
                }
        } header: {
            Text("Cloud Relay")
        } footer: {
            Text("Off by default. Turn this on only if you need to sync across different networks. Data routed through the relay is end-to-end encrypted, so the relay can't read it.")
        }
    }

    /// Reflects the current transmission destination derived from the relay
    /// state, making the LAN-only invariant visible (Requirements 7.1, 7.4).
    private var transmissionSection: some View {
        Section {
            switch settings.destinationPolicy {
            case .pairedDesktopOnly:
                Label {
                    Text("Sent only to your paired desktop on the local network.")
                } icon: {
                    Image(systemName: "lock.laptopcomputer")
                }
            case .pairedDesktopOrEncryptedRelay:
                Label {
                    Text("Sent to your paired desktop, or through the encrypted cloud relay when it can't be reached directly.")
                } icon: {
                    Image(systemName: "antenna.radiowaves.left.and.right")
                }
            }
        } header: {
            Text("Where your data goes")
        }
    }
}

#if DEBUG
struct SettingsView_Previews: PreviewProvider {
    static var previews: some View {
        SettingsView(settings: RelaySettings())
    }
}
#endif
