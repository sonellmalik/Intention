import Foundation
import Combine
import FocusCompanionCore

/// A thin `ObservableObject` that exposes persisted local history to SwiftUI.
///
/// `LocalStore` is a plain class (not `ObservableObject`) so it stays
/// UI-independent and testable off device. This view model is the light adapter
/// that reads `LocalStore.loadSessions()` and publishes the result for the
/// history list. The store is injected so task 12.3 can hand in the *shared*
/// instance the tracker persists into; a default initializer builds a standalone
/// store for previews / isolated runs.
///
/// The store has no change notifications, so the view model reloads on `init`
/// and whenever `refresh()` is called (e.g. `.onAppear` / a pull-to-refresh),
/// keeping the published list in step with what has been persisted.
///
/// - Requirements: 6.3
@MainActor
final class HistoryViewModel: ObservableObject {
    /// Persisted sessions, most recent first, for the history list.
    @Published private(set) var sessions: [FocusSession] = []

    private let store: LocalStore

    /// Creates a history view model over a shared `LocalStore`.
    ///
    /// - Parameter store: the shared store the tracker persists sessions into.
    init(store: LocalStore) {
        self.store = store
        refresh()
    }

    /// Convenience initializer that builds a standalone store, used for previews
    /// and isolated runs. Task 12.3 injects the shared store via `init(store:)`.
    convenience init() {
        self.init(store: LocalStore())
    }

    /// Reload persisted sessions from the store.
    ///
    /// Sessions are ordered most-recent-first (by `startedAt`) so the newest
    /// focus session appears at the top of the history list.
    ///
    /// - Requirements: 6.3
    func refresh() {
        sessions = store.loadSessions().sorted { $0.startedAt > $1.startedAt }
    }

    /// The pickup count for a session, surfaced for the row summary.
    func pickupCount(for session: FocusSession) -> Int {
        session.pickups.count
    }
}
