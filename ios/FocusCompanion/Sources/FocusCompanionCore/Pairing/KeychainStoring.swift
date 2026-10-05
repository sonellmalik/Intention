import Foundation

/// Secure key-value storage for the durable secrets produced by pairing.
///
/// After a successful handshake `PairFromQR` persists the `sessionKey` (and the
/// desktop host/port used to reconnect) through this protocol. Abstracting the
/// store keeps the handshake orchestration testable off-device: production code
/// injects the `Security`-backed ``KeychainStore`` while tests inject an
/// in-memory double and assert what was — or, on the failure paths, was *not* —
/// persisted (task 6.4).
///
/// The design keeps the `sessionKey` in the iOS Keychain, never in plaintext
/// `UserDefaults`; this protocol is the seam that guarantees the handshake logic
/// talks only to a secure store.
///
/// - Requirements: 3.4, 3.6
public protocol KeychainStoring: AnyObject {
    /// Persist `value` for `key`, replacing any existing value.
    ///
    /// - Throws: if the underlying secure store rejects the write.
    func setString(_ value: String, forKey key: String) throws

    /// Return the value previously stored for `key`, or `nil` if absent.
    ///
    /// - Throws: if the underlying secure store fails to read.
    func string(forKey key: String) throws -> String?

    /// Remove any value stored for `key`.
    ///
    /// - Throws: if the underlying secure store fails to delete.
    func removeValue(forKey key: String) throws
}

/// The well-known keychain keys written on a successful pairing.
public enum KeychainKey {
    /// The durable session key reused by `SyncClient.connect()`.
    public static let sessionKey = "focuscompanion.sessionKey"
    /// The paired desktop host, backing reconnection / manual fallback.
    public static let desktopHost = "focuscompanion.desktopHost"
    /// The paired desktop port, backing reconnection / manual fallback.
    public static let desktopPort = "focuscompanion.desktopPort"
}

/// An in-memory `KeychainStoring` for tests and previews.
///
/// Holds values in a dictionary so failure-path tests can construct a handshake
/// with a store they can inspect, without touching the real Keychain (which is
/// unavailable on macOS CI and in the SwiftPM test bundle).
public final class InMemoryKeychainStore: KeychainStoring {
    private var storage: [String: String] = [:]

    public init() {}

    public func setString(_ value: String, forKey key: String) throws {
        storage[key] = value
    }

    public func string(forKey key: String) throws -> String? {
        storage[key]
    }

    public func removeValue(forKey key: String) throws {
        storage.removeValue(forKey: key)
    }

    /// Whether any value is currently stored — convenient for asserting that a
    /// failed handshake persisted nothing.
    public var isEmpty: Bool { storage.isEmpty }
}

#if canImport(Security)
import Security

/// A `Security`-framework-backed `KeychainStoring` using generic password items.
///
/// This is the on-device implementation. It is compiled only where the
/// `Security` framework is available (iOS, and macOS), so the core library still
/// builds on CI; the pure handshake orchestration in `PairFromQR` depends only
/// on the `KeychainStoring` protocol, never on this type directly.
///
/// Each secret is stored as a `kSecClassGenericPassword` item keyed by
/// `service` (a fixed app identifier) plus the `account` (the `key` argument).
///
/// - Requirements: 3.4
public final class KeychainStore: KeychainStoring {
    /// An error surfaced from an unexpected `Security` status code.
    public enum KeychainError: Error, Equatable, CustomStringConvertible {
        case unexpectedStatus(OSStatus)
        case unreadableData

        public var description: String {
            switch self {
            case .unexpectedStatus(let status):
                return "Keychain operation failed with status \(status)."
            case .unreadableData:
                return "Keychain returned data that could not be read as UTF-8."
            }
        }
    }

    private let service: String

    /// - Parameter service: the keychain service identifier that scopes all
    ///   items written by this store. Defaults to the app's bundle-style id.
    public init(service: String = "com.focusflow.companion") {
        self.service = service
    }

    public func setString(_ value: String, forKey key: String) throws {
        guard let data = value.data(using: .utf8) else {
            throw KeychainError.unreadableData
        }
        let query = baseQuery(forKey: key)

        // Update in place if the item already exists, otherwise add it.
        let updateStatus = SecItemUpdate(
            query as CFDictionary,
            [kSecValueData as String: data] as CFDictionary
        )
        if updateStatus == errSecSuccess {
            return
        }
        if updateStatus == errSecItemNotFound {
            var addQuery = query
            addQuery[kSecValueData as String] = data
            let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
            guard addStatus == errSecSuccess else {
                throw KeychainError.unexpectedStatus(addStatus)
            }
            return
        }
        throw KeychainError.unexpectedStatus(updateStatus)
    }

    public func string(forKey key: String) throws -> String? {
        var query = baseQuery(forKey: key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound {
            return nil
        }
        guard status == errSecSuccess else {
            throw KeychainError.unexpectedStatus(status)
        }
        guard let data = item as? Data else {
            return nil
        }
        guard let value = String(data: data, encoding: .utf8) else {
            throw KeychainError.unreadableData
        }
        return value
    }

    public func removeValue(forKey key: String) throws {
        let status = SecItemDelete(baseQuery(forKey: key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.unexpectedStatus(status)
        }
    }

    private func baseQuery(forKey key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key
        ]
    }
}
#endif
