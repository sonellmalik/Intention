import XCTest
import SwiftCheck
@testable import FocusCompanionCore

/// Property + unit tests for persistence and pairing.
///
///   - Property 10 (persistence round trip across restart) — Req 6.1,6.2,6.3 (task 3.2)
///   - Property 9  (pairing QR round trip)                  — Req 3.1         (task 6.3)
///   - Pairing failure paths (unit)                         — Req 3.5, 3.6    (task 6.4)
final class PersistencePairingTests: XCTestCase {

    // MARK: - Property 10: Persistence round trip across restart (6.1, 6.2, 6.3)

    func testProperty10_PersistenceRoundTripAcrossRestart() {
        property("saved sessions+pickups reload equivalently after restart") <- forAll {
            (sessions: [FocusSession]) in
            // Bound the size so shrinking stays fast; dedup ids so save() semantics
            // (replace-by-id) don't collapse distinct generated sessions.
            var seen = Set<UUID>()
            let unique = sessions.prefix(15).filter { seen.insert($0.id).inserted }

            let backend = InMemoryPersistenceBackend()
            let store = LocalStore(backend: backend)
            for s in unique { store.save(s) }

            // "Restart": a fresh store over the SAME backend.
            let reloaded = LocalStore(backend: backend).loadSessions()

            guard reloaded.count == unique.count else { return false }
            for original in unique {
                guard let r = reloaded.first(where: { $0.id == original.id }) else { return false }
                let sameMeta = r.dateKey == original.dateKey
                    && r.mode == original.mode
                    && r.plannedDuration == original.plannedDuration
                    && r.pickups.map(\.id) == original.pickups.map(\.id)
                if !sameMeta { return false }
            }
            return true
        }
    }

    func testPersistedPickupSyncedFlagRoundTrips() {
        let backend = InMemoryPersistenceBackend()
        let store = LocalStore(backend: backend)
        let id = UUID()
        let pickup = PickupEvent(elapsed: 42, occurredAt: Date(timeIntervalSince1970: 1_700_000_042))
        store.save(FocusSession(id: id, dateKey: "2025-06-14", mode: .work,
                                startedAt: Date(timeIntervalSince1970: 1_700_000_000),
                                plannedDuration: 1500, endedAt: nil, pickups: [pickup]))
        var updated = pickup; updated.synced = true
        store.updatePickup(updated, inSession: id)

        let reloaded = LocalStore(backend: backend).session(id: id)
        XCTAssertEqual(reloaded?.pickups.first?.synced, true)
    }

    // MARK: - Property 9: Pairing QR round trip (3.1)

    func testProperty9_PairingQRRoundTrip() {
        // Encoding a payload to JSON (the QR contents) and decoding the scanned
        // result reproduces an equivalent payload with all required fields.
        property("PairingPayload JSON round trip preserves all fields") <- forAll {
            (host: String, rawPort: Int, deviceId: String, token: String, fp: String) in
            // Constrain to a valid, non-empty payload (validate() enforces these).
            let safeHost = host.isEmpty ? "host" : host.replacingOccurrences(of: "\0", with: "")
            let port = 1 + abs(rawPort % 65535)
            let payload = PairingPayload(
                host: safeHost.isEmpty ? "h" : safeHost,
                port: port,
                deviceId: deviceId.isEmpty ? "d" : deviceId,
                pairingToken: token.isEmpty ? "t" : token,
                fingerprint: fp.isEmpty ? "f" : fp
            )
            guard let data = try? JSONEncoder().encode(payload),
                  let scanned = String(data: data, encoding: .utf8),
                  let decoded = try? PairingPayload.decode(fromQRString: scanned)
            else { return false }
            return decoded == payload
        }
    }

    // MARK: - Task 6.4: Pairing failure paths (unit)

    /// An in-memory pairing connection that returns a scripted reply.
    private final class ScriptedConnection: PairingConnection {
        let reply: InboundMessage
        private(set) var closed = false
        private(set) var sent: [OutboundMessage] = []
        init(reply: InboundMessage) { self.reply = reply }
        func send(_ message: OutboundMessage) async throws { sent.append(message) }
        func receive() async throws -> InboundMessage { reply }
        func close() { closed = true }
    }

    private final class ScriptedFactory: PairingConnectionFactory {
        let connection: ScriptedConnection
        init(_ c: ScriptedConnection) { connection = c }
        func open(host: String, port: Int) async throws -> PairingConnection { connection }
    }

    private func payload(fingerprint: String = "fp-desktop") -> PairingPayload {
        PairingPayload(host: "192.168.1.5", port: 51234, deviceId: "dev",
                       pairingToken: "one-time", fingerprint: fingerprint)
    }

    func testPairErrorRejectsAndPersistsNothing() async {
        let conn = ScriptedConnection(reply: .pairError)
        let keychain = InMemoryKeychainStore()
        let pairer = PairFromQR(connectionFactory: ScriptedFactory(conn),
                                keychain: keychain,
                                deviceInfo: DeviceInfo(name: "iPhone"))
        do {
            _ = try await pairer.pair(with: payload())
            XCTFail("expected tokenRejected")
        } catch let error as PairingError {
            XCTAssertEqual(error, .tokenRejected)
        } catch {
            XCTFail("unexpected error: \(error)")
        }
        XCTAssertTrue(conn.closed, "connection should be closed on rejection")
        XCTAssertTrue(keychain.isEmpty, "nothing must be persisted on rejection")
    }

    func testFingerprintMismatchClosesAndPersistsNothing() async {
        // pairAck carries a fingerprint that does NOT match the scanned payload.
        let conn = ScriptedConnection(reply: .pairAck(sessionKey: "sk", fingerprint: "WRONG"))
        let keychain = InMemoryKeychainStore()
        let pairer = PairFromQR(connectionFactory: ScriptedFactory(conn),
                                keychain: keychain,
                                deviceInfo: DeviceInfo(name: "iPhone"))
        do {
            _ = try await pairer.pair(with: payload(fingerprint: "fp-desktop"))
            XCTFail("expected fingerprintMismatch")
        } catch let error as PairingError {
            XCTAssertEqual(error, .fingerprintMismatch)
        } catch {
            XCTFail("unexpected error: \(error)")
        }
        XCTAssertTrue(conn.closed)
        XCTAssertTrue(keychain.isEmpty, "no session key on fingerprint mismatch")
    }

    func testSuccessfulPairStoresSessionKey() async throws {
        let conn = ScriptedConnection(reply: .pairAck(sessionKey: "session-123", fingerprint: "fp-desktop"))
        let keychain = InMemoryKeychainStore()
        let pairer = PairFromQR(connectionFactory: ScriptedFactory(conn),
                                keychain: keychain,
                                deviceInfo: DeviceInfo(name: "iPhone"))
        let key = try await pairer.pair(with: payload(fingerprint: "fp-desktop"))
        XCTAssertEqual(key, "session-123")
        XCTAssertEqual(try keychain.string(forKey: KeychainKey.sessionKey), "session-123")
        XCTAssertEqual(try keychain.string(forKey: KeychainKey.desktopHost), "192.168.1.5")
        XCTAssertEqual(try keychain.string(forKey: KeychainKey.desktopPort), "51234")
        XCTAssertTrue(conn.closed)
    }
}
