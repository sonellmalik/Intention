import XCTest
@testable import FocusCompanionCore

/// Smoke tests confirming the core data models encode and decode losslessly.
///
/// These exercise the `Codable` conformance added in task 1. The named,
/// numbered property-based tests (SwiftCheck) that validate the design's
/// correctness properties are added in later tasks.
final class ModelCodableTests: XCTestCase {

    private func makeCoder() -> (JSONEncoder, JSONDecoder) {
        let encoder = JSONEncoder()
        let decoder = JSONDecoder()
        encoder.dateEncodingStrategy = .iso8601
        decoder.dateDecodingStrategy = .iso8601
        return (encoder, decoder)
    }

    func testSessionModeRawValuesMatchWireFormat() {
        XCTAssertEqual(SessionMode.work.rawValue, "work")
        XCTAssertEqual(SessionMode.shortBreak.rawValue, "shortBreak")
        XCTAssertEqual(SessionMode.longBreak.rawValue, "longBreak")
    }

    func testDistractionTagRawValuesMatchWireFormat() {
        XCTAssertEqual(DistractionTag.phone.rawValue, "phone")
        XCTAssertEqual(DistractionTag.people.rawValue, "people")
        XCTAssertEqual(DistractionTag.thought.rawValue, "thought")
        XCTAssertEqual(DistractionTag.other.rawValue, "other")
    }

    func testPickupEventDefaultsToPhoneTagAndUnsynced() {
        let event = PickupEvent(elapsed: 143, occurredAt: Date())
        XCTAssertEqual(event.tag, .phone)
        XCTAssertFalse(event.synced)
    }

    func testPickupEventRoundTrip() throws {
        let (encoder, decoder) = makeCoder()
        let original = PickupEvent(
            id: UUID(),
            elapsed: 902,
            occurredAt: Date(timeIntervalSince1970: 1_718_360_862),
            tag: .phone,
            synced: true
        )
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(PickupEvent.self, from: data)
        XCTAssertEqual(decoded.id, original.id)
        XCTAssertEqual(decoded.elapsed, original.elapsed)
        XCTAssertEqual(decoded.occurredAt, original.occurredAt)
        XCTAssertEqual(decoded.tag, original.tag)
        XCTAssertEqual(decoded.synced, original.synced)
    }

    func testFocusSessionRoundTripWithNestedPickups() throws {
        let (encoder, decoder) = makeCoder()
        let start = Date(timeIntervalSince1970: 1_718_359_800)
        let original = FocusSession(
            id: UUID(),
            dateKey: "2025-06-14",
            mode: .work,
            startedAt: start,
            plannedDuration: 1500,
            endedAt: start.addingTimeInterval(1500),
            pickups: [
                PickupEvent(elapsed: 143, occurredAt: start.addingTimeInterval(143)),
                PickupEvent(elapsed: 902, occurredAt: start.addingTimeInterval(902))
            ]
        )
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(FocusSession.self, from: data)
        XCTAssertEqual(decoded.id, original.id)
        XCTAssertEqual(decoded.dateKey, original.dateKey)
        XCTAssertEqual(decoded.mode, original.mode)
        XCTAssertEqual(decoded.startedAt, original.startedAt)
        XCTAssertEqual(decoded.plannedDuration, original.plannedDuration)
        XCTAssertEqual(decoded.endedAt, original.endedAt)
        XCTAssertEqual(decoded.pickups.count, 2)
        XCTAssertEqual(decoded.pickups.map(\.id), original.pickups.map(\.id))
    }
}
