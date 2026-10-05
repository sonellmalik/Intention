import XCTest
import SwiftCheck
@testable import FocusCompanionCore

/// Property + unit tests for the opt-in cloud relay (tasks 13.2 / 13.3).
///
///   - Property 12 (relay end-to-end encryption) — Requirement 8.2 (task 13.3)
///
/// Verifies that when the relay is enabled the relay only ever handles
/// ciphertext (never plaintext), that ciphertext round-trips back to the
/// original plaintext with the shared key, and that with the relay disabled the
/// router refuses to transmit at all (privacy invariant, Requirement 8.1).
final class RelayEncryptionTests: XCTestCase {

    /// Records the envelope handed to the "relay". Since the relay is untrusted,
    /// this stands in for what the relay can see.
    private final class RecordingRelayTransport: RelayTransport {
        private(set) var forwarded: [RelayEnvelope] = []
        func forward(_ envelope: RelayEnvelope) async throws { forwarded.append(envelope) }
    }

    private func enabledSettings() -> RelaySettings {
        let s = RelaySettings(defaults: UserDefaults(suiteName: "relay-\(UUID().uuidString)")!)
        s.cloudRelayEnabled = true
        return s
    }

    private func sampleBatch() -> OutboundMessage {
        .distractionBatch(
            sessionId: UUID(),
            dateKey: "2025-06-14",
            events: [DistractionEvent(id: UUID(), elapsed: 143, occurredAt: Date(timeIntervalSince1970: 1_700_000_143), tag: .phone)]
        )
    }

    // MARK: - Property 12: what the relay sees is ciphertext only

    func testProperty12_RelaySeesOnlyCiphertext() async throws {
        let settings = enabledSettings()
        let encryptor = AESGCMRelayEncryptor(sessionKey: "shared-pair-secret")
        let transport = RecordingRelayTransport()
        let router = RelayRouter(settings: settings, encryptor: encryptor, transport: transport)

        let message = sampleBatch()
        // The plaintext contains the sessionId/dateKey; ensure none leaks.
        let plaintext = try JSONEncoder().encode(message)
        let plaintextString = String(data: plaintext, encoding: .utf8) ?? ""

        let envelope = try await router.sendViaRelay(message)

        // The relay received exactly one envelope, and it is what we returned.
        XCTAssertEqual(transport.forwarded.count, 1)
        XCTAssertEqual(transport.forwarded.first, envelope)

        // The ciphertext must not contain the plaintext JSON, nor the dateKey.
        guard let cipherData = Data(base64Encoded: envelope.ciphertext) else {
            return XCTFail("ciphertext not base64")
        }
        XCTAssertFalse(cipherData.range(of: Data("2025-06-14".utf8)) != nil,
                       "dateKey leaked into ciphertext")
        XCTAssertNotEqual(cipherData, plaintext, "relay must not see plaintext bytes")
        XCTAssertFalse(plaintextString.isEmpty)
    }

    func testProperty12_CiphertextRoundTripsWithSharedKey() {
        property("decrypt(encrypt(m)) == m for the shared key") <- forAll { (raw: String) in
            let encryptor = AESGCMRelayEncryptor(sessionKey: "k-\(raw.count)")
            let plaintext = Data(raw.utf8)
            guard let env = try? encryptor.encrypt(plaintext),
                  let back = try? encryptor.decrypt(env)
            else { return false }
            return back == plaintext
        }
    }

    func testWrongKeyCannotDecrypt() throws {
        let good = AESGCMRelayEncryptor(sessionKey: "correct-secret")
        let bad = AESGCMRelayEncryptor(sessionKey: "attacker-secret")
        let env = try good.encrypt(Data("top secret distraction".utf8))
        XCTAssertThrowsError(try bad.decrypt(env), "a different key must not decrypt")
    }

    // MARK: - Requirement 8.1: disabled relay refuses to transmit

    func testRelayDisabledRefusesToTransmit() async {
        // Default settings => relay disabled => sendViaRelay throws and nothing
        // is forwarded to the relay transport.
        let settings = RelaySettings(defaults: UserDefaults(suiteName: "relay-off-\(UUID().uuidString)")!)
        let transport = RecordingRelayTransport()
        let router = RelayRouter(
            settings: settings,
            encryptor: AESGCMRelayEncryptor(sessionKey: "s"),
            transport: transport
        )
        XCTAssertFalse(router.isRelayPermitted)
        do {
            _ = try await router.sendViaRelay(sampleBatch())
            XCTFail("expected relayDisabled")
        } catch let error as RelayError {
            XCTAssertEqual(error, .relayDisabled)
        } catch {
            XCTFail("unexpected error: \(error)")
        }
        XCTAssertTrue(transport.forwarded.isEmpty, "nothing may reach the relay while disabled")
    }
}
