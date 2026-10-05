import Foundation

/// On-device persistence for `FocusSession`s and their nested `PickupEvent`s.
///
/// `LocalStore` keeps every session (with its pickups) durable across app
/// restarts and offline periods, and drives the local history view. It is
/// deliberately built on an injectable ``PersistenceBackend`` (defaulting to
/// `UserDefaults` + `Codable`) rather than SwiftData so the pure logic — and
/// the Property 10 round-trip test in task 3.2 — builds and runs off-device on
/// macOS CI without a simulator.
///
/// Sessions are held in memory keyed by `id` for O(1) lookup/update and
/// re-serialized to the backend on every mutation. On `init` any previously
/// persisted sessions are restored, so a freshly constructed store (as happens
/// on app launch) reflects the last saved state.
///
/// - Requirements: 6.1, 6.2, 6.3
public final class LocalStore {
    /// The `UserDefaults`/backend key under which the encoded session list lives.
    public static let storageKey = "focuscompanion.sessions"

    private let backend: PersistenceBackend
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    /// Sessions indexed by `id`, kept in sync with the persisted store.
    private var sessionsByID: [UUID: FocusSession]

    /// Preserves the order in which sessions were first saved so `loadSessions()`
    /// returns a stable, insertion-ordered list rather than a dictionary's
    /// arbitrary order.
    private var order: [UUID]

    /// Creates a store over the given backend and restores previously persisted
    /// sessions and pickups (app restart).
    ///
    /// - Parameters:
    ///   - backend: The persistence backend. Defaults to `UserDefaults.standard`.
    ///   - Requirements: 6.3
    public init(backend: PersistenceBackend = UserDefaultsPersistenceBackend()) {
        self.backend = backend

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        self.encoder = encoder

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        self.decoder = decoder

        self.sessionsByID = [:]
        self.order = []

        restore()
    }

    // MARK: - Reading

    /// Returns all persisted sessions in the order they were first saved.
    ///
    /// - Requirements: 6.3
    public func loadSessions() -> [FocusSession] {
        order.compactMap { sessionsByID[$0] }
    }

    /// Returns the persisted session with the given `id`, if present.
    public func session(id: UUID) -> FocusSession? {
        sessionsByID[id]
    }

    // MARK: - Writing

    /// Persists a session, inserting it or replacing an existing session with the
    /// same `id`. The session's nested `pickups` are persisted along with it.
    ///
    /// - Requirements: 6.1, 6.2
    public func save(_ session: FocusSession) {
        if sessionsByID[session.id] == nil {
            order.append(session.id)
        }
        sessionsByID[session.id] = session
        persist()
    }

    /// Appends a `PickupEvent` to the session with `sessionID` and persists the
    /// change.
    ///
    /// If no session with `sessionID` exists, the call is a no-op — the tracker
    /// always saves a session before recording pickups against it.
    ///
    /// - Requirements: 6.2
    @discardableResult
    public func appendPickup(_ pickup: PickupEvent, toSession sessionID: UUID) -> Bool {
        guard var session = sessionsByID[sessionID] else { return false }
        session.pickups.append(pickup)
        sessionsByID[sessionID] = session
        persist()
        return true
    }

    /// Replaces an existing `PickupEvent` (matched by `id`) within its session
    /// and persists the change — used, for example, to flip `synced` to `true`
    /// once the desktop acknowledges the event.
    ///
    /// - Requirements: 6.2
    @discardableResult
    public func updatePickup(_ pickup: PickupEvent, inSession sessionID: UUID) -> Bool {
        guard var session = sessionsByID[sessionID],
              let index = session.pickups.firstIndex(where: { $0.id == pickup.id })
        else { return false }
        session.pickups[index] = pickup
        sessionsByID[sessionID] = session
        persist()
        return true
    }

    // MARK: - Persistence

    /// Serializes the current session list to the backend.
    private func persist() {
        let sessions = loadSessions()
        do {
            let data = try encoder.encode(sessions)
            backend.setData(data, forKey: Self.storageKey)
        } catch {
            // A serialization failure must not crash the app; the in-memory
            // state remains authoritative for the current run and the next
            // successful save re-syncs the backend.
            assertionFailure("LocalStore failed to encode sessions: \(error)")
        }
    }

    /// Loads persisted sessions from the backend into memory on `init`.
    private func restore() {
        guard let data = backend.data(forKey: Self.storageKey) else { return }
        do {
            let sessions = try decoder.decode([FocusSession].self, from: data)
            for session in sessions {
                if sessionsByID[session.id] == nil {
                    order.append(session.id)
                }
                sessionsByID[session.id] = session
            }
        } catch {
            // Corrupt or incompatible data is ignored rather than fatal so the
            // app can still launch; it will be overwritten on the next save.
            assertionFailure("LocalStore failed to decode sessions: \(error)")
        }
    }
}
