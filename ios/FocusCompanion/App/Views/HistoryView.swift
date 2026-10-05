import SwiftUI
import FocusCompanionCore

/// The local history screen: lists persisted focus sessions with their date,
/// mode, and pickup count, read from `LocalStore` via ``HistoryViewModel``.
///
/// This is the on-device review surface promised by Requirement 6.3 — sessions
/// and their pickups survive app restarts and offline periods, and this view
/// reflects whatever `LocalStore.loadSessions()` returns. Tapping a session
/// reveals its individual pickups with each one's elapsed offset into the
/// session.
///
/// - Requirements: 6.3
struct HistoryView: View {
    @ObservedObject var viewModel: HistoryViewModel

    var body: some View {
        Group {
            if viewModel.sessions.isEmpty {
                emptyState
            } else {
                sessionList
            }
        }
        .navigationTitle("History")
        .onAppear { viewModel.refresh() }
    }

    // MARK: - Subviews

    private var sessionList: some View {
        List(viewModel.sessions) { session in
            NavigationLink {
                SessionDetailView(session: session)
            } label: {
                SessionRow(session: session)
            }
        }
        .refreshable { viewModel.refresh() }
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "clock.arrow.circlepath")
                .font(.system(size: 44))
                .foregroundStyle(.secondary)
            Text("No sessions yet")
                .font(.headline)
            Text("Your completed focus sessions and the phone pickups recorded during them will appear here.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// A single row summarizing a persisted session: date, mode, and pickup count.
private struct SessionRow: View {
    let session: FocusSession

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text(session.dateKey)
                    .font(.headline)
                Text(HistoryFormatting.modeLabel(session.mode))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 4) {
                Text("\(session.pickups.count)")
                    .font(.title3.weight(.semibold))
                    .monospacedDigit()
                Text(session.pickups.count == 1 ? "pickup" : "pickups")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}

/// Detail for a single session: its pickups listed with elapsed offsets.
private struct SessionDetailView: View {
    let session: FocusSession

    var body: some View {
        List {
            Section("Session") {
                LabeledContent("Date", value: session.dateKey)
                LabeledContent("Mode", value: HistoryFormatting.modeLabel(session.mode))
                LabeledContent("Pickups", value: "\(session.pickups.count)")
            }

            if session.pickups.isEmpty {
                Section("Pickups") {
                    Text("No pickups recorded for this session.")
                        .foregroundStyle(.secondary)
                }
            } else {
                Section("Pickups") {
                    ForEach(session.pickups) { pickup in
                        HStack {
                            Text(HistoryFormatting.elapsedLabel(pickup.elapsed))
                                .monospacedDigit()
                            Spacer()
                            if !pickup.synced {
                                Image(systemName: "arrow.triangle.2.circlepath")
                                    .foregroundStyle(.secondary)
                                    .accessibilityLabel("Not yet synced")
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle(session.dateKey)
    }
}

/// Formatting helpers shared by the history rows and detail.
private enum HistoryFormatting {
    static func modeLabel(_ mode: SessionMode) -> String {
        switch mode {
        case .work: return "Work"
        case .shortBreak: return "Short break"
        case .longBreak: return "Long break"
        }
    }

    /// Renders elapsed seconds within the session as `mm:ss`.
    static func elapsedLabel(_ elapsed: Int) -> String {
        let clamped = max(0, elapsed)
        let minutes = clamped / 60
        let seconds = clamped % 60
        return String(format: "%d:%02d", minutes, seconds)
    }
}

#if DEBUG
struct HistoryView_Previews: PreviewProvider {
    static var previews: some View {
        NavigationView {
            HistoryView(viewModel: HistoryViewModel())
        }
    }
}
#endif
