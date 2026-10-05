import SwiftUI
import FocusCompanionCore

/// The live session screen: shows the running pickup count for the active focus
/// session and drives pickup detection by forwarding scene-phase changes.
///
/// The view observes a ``LiveSessionViewModel`` (a thin `ObservableObject` over
/// the shared `SessionTracker`/`LifecyclePickupDetector`) for the published
/// pickup count, and binds SwiftUI's `scenePhase` to the detector. Each time the
/// app leaves and re-enters the foreground during an active session, the
/// detector records a pickup and the count updates — this is the on-screen
/// feedback for Requirement 1.1.
///
/// The `scenePhase` binding maps SwiftUI's `ScenePhase` onto the UI-independent
/// `ScenePhaseLike` via the existing `ScenePhaseLike(_:)` adapter, keeping
/// SwiftUI out of the core detection logic.
///
/// - Requirements: 1.1
struct LiveSessionView: View {
    @Environment(\.scenePhase) private var scenePhase
    @ObservedObject var viewModel: LiveSessionViewModel

    var body: some View {
        VStack(spacing: 24) {
            if viewModel.isSessionActive {
                activeContent
            } else {
                idleContent
            }
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .navigationTitle("Live Session")
        // Forward every scene-phase change to the detector. Mapping ScenePhase ->
        // ScenePhaseLike uses the adapter that already exists in the core library.
        .onChange(of: scenePhase) { newPhase in
            viewModel.handleScenePhase(ScenePhaseLike(newPhase))
        }
        .onAppear { viewModel.refresh() }
    }

    // MARK: - Subviews

    private var activeContent: some View {
        VStack(spacing: 16) {
            if let mode = viewModel.activeMode {
                Text(modeLabel(mode))
                    .font(.headline)
                    .foregroundStyle(.secondary)
            }

            Text("\(viewModel.pickupCount)")
                .font(.system(size: 72, weight: .bold, design: .rounded))
                .monospacedDigit()
                .accessibilityLabel("\(viewModel.pickupCount) pickups")

            Text(viewModel.pickupCount == 1 ? "pickup" : "pickups")
                .font(.title3)
                .foregroundStyle(.secondary)

            Text("Keep FocusCompanion open during your session. Each time you pick the phone back up, it's counted here.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.top, 8)
        }
    }

    private var idleContent: some View {
        VStack(spacing: 12) {
            Image(systemName: "moon.zzz")
                .font(.system(size: 44))
                .foregroundStyle(.secondary)
            Text("No active session")
                .font(.headline)
            Text("Start a focus session on your desktop to begin counting phone pickups here.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
    }

    private func modeLabel(_ mode: SessionMode) -> String {
        switch mode {
        case .work: return "Work session"
        case .shortBreak: return "Short break"
        case .longBreak: return "Long break"
        }
    }
}

#if DEBUG
struct LiveSessionView_Previews: PreviewProvider {
    static var previews: some View {
        NavigationView {
            LiveSessionView(viewModel: LiveSessionViewModel())
        }
    }
}
#endif
