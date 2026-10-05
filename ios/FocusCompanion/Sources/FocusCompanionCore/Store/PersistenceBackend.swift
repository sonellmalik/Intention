import Foundation

/// A minimal key-value persistence backend used by `LocalStore`.
///
/// Abstracting the raw storage behind this protocol keeps `LocalStore` testable
/// off-device: production code injects the `UserDefaults`-backed implementation,
/// while tests (e.g. the Property 10 round-trip test in task 3.2) inject the
/// in-memory implementation and can simulate an app restart by constructing a
/// fresh `LocalStore` over the same backend instance — no SwiftData, simulator,
/// or real `UserDefaults` domain required.
///
/// - Requirements: 6.1, 6.2, 6.3
public protocol PersistenceBackend: AnyObject {
    /// Returns the raw data previously stored for `key`, or `nil` if absent.
    func data(forKey key: String) -> Data?

    /// Persists `data` for `key`, replacing any existing value.
    func setData(_ data: Data?, forKey key: String)
}

/// A `UserDefaults`-backed `PersistenceBackend`.
///
/// This is the default backend on device. `UserDefaults` is durable across app
/// restarts, which satisfies the "survive an app restart" requirement for the
/// small volume of session/pickup data this app records.
public final class UserDefaultsPersistenceBackend: PersistenceBackend {
    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public func data(forKey key: String) -> Data? {
        defaults.data(forKey: key)
    }

    public func setData(_ data: Data?, forKey key: String) {
        if let data {
            defaults.set(data, forKey: key)
        } else {
            defaults.removeObject(forKey: key)
        }
    }
}

/// An in-memory `PersistenceBackend` for tests.
///
/// Retaining a single instance across two `LocalStore`s models an app restart:
/// data written by the first store is visible to the second, exactly as it
/// would be after relaunching the app over real `UserDefaults`.
public final class InMemoryPersistenceBackend: PersistenceBackend {
    private var storage: [String: Data] = [:]

    public init() {}

    public func data(forKey key: String) -> Data? {
        storage[key]
    }

    public func setData(_ data: Data?, forKey key: String) {
        if let data {
            storage[key] = data
        } else {
            storage.removeValue(forKey: key)
        }
    }
}
