import XCTest
import SwiftCheck
@testable import FocusCompanionCore

/// Property-based tests for the pickup detector and session tracker.
///
/// Covers the design's correctness properties for detection/tracking:
///   - Property 1  (elapsed bounds)      — Requirements 2.2, 2.3  (task 4.2)
///   - Property 4  (session scoping)     — Requirements 1.1, 1.3  (task 2.3)
///   - Property 7  (unique pickup ids)   — Requirement 2.6        (task 4.4)
///   - Property 11 (debounce spacing)    — Requirement 1.2        (task 2.4)
/// plus Property 5's phone half (tag consistency) — Requirement 2.4 (task 4.3)
/// and SessionTracker edge-case unit tests (task 4.5).
///
/// All collaborators are the real core types driven through in-memory fakes so
/// these run off-device under SwiftPM.
final class DetectionTrackingPropertyTests: XCTestCase {

    // MARK: Fakes

    /// A `SyncClient` double that records every enqueued message and never
    /// touches the network. Enough for the tracker to drive `enqueue`.
    private final class RecordingSyncClient: SyncClient {
        var onMessage: ((InboundMessage) -> Void)?
        private(set) var enqueued: [OutboundMessage] = []
        func discover() {}
        func pair(with qr: PairingPayload) async throws {}
        func connect() async throws {}
        func send(_ message: OutboundMessage) async throws {}
        func enqueue(_ message: OutboundMessage) { enqueued.append(message) }
        func markSynced(_ eventIds: [UUID]) {}

        /// All distraction events across every enqueued batch, in order.
        var allEvents: [DistractionEvent] {
            enqueued.flatMap { msg -> [DistractionEvent] in
                if case let .distractionBatch(_, _, events) = msg { return events }
                return []
            }
        }
    }

    private func makeTracker(now: @escaping () -> Date = { Date() })
        -> (SessionTracker, LocalStore, LifecyclePickupDetector, RecordingSyncClient) {
        let store = LocalStore(backend: InMemoryPersistenceBackend())
        let detector = LifecyclePickupDetector(now: now)
        let sync = RecordingSyncClient()
        let tracker = SessionTracker(store: store, detector: detector, syncClient: sync, now: now)
        return (tracker, store, detector, sync)
    }

    private func startSession(
        _ tracker: SessionTracker,
        startedAt: Date = Date(timeIntervalSince1970: 1_700_000_000),
        plannedDuration: Int = 1500,
        mode: SessionMode = .work
    ) -> UUID {
        let id = UUID()
        tracker.onSessionStarted(
            sessionId: id,
            dateKey: "2025-06-14",
            mode: mode,
            startedAt: startedAt,
            plannedDuration: plannedDuration
        )
        return id
    }

    // MARK: - Property 1: Elapsed bounds (Requirements 2.2, 2.3)

    func testProperty1_ElapsedBounds() {
        // For any planned duration and any pickup offset (including negative /
        // beyond the planned end), 0 <= elapsed <= plannedDuration.
        property("elapsed is clamped into [0, plannedDuration]") <- forAll {
            (planned: Int, offset: Int) in
            let plannedDuration = 1 + abs(planned % 7200)      // 1s .. 2h
            let start = Date(timeIntervalSince1970: 1_700_000_000)
            // offset can be far before start or far after the planned end.
            let pickupOffset = Double((offset % 20000) - 5000)
            let pickupTime = start.addingTimeInterval(pickupOffset)

            let (tracker, _, _, sync) = self.makeTracker(now: { pickupTime })
            _ = self.startSession(tracker, startedAt: start, plannedDuration: plannedDuration)
            tracker.onPickup(occurredAt: pickupTime)

            guard let event = sync.allEvents.last else { return false }
            return event.elapsed >= 0 && event.elapsed <= plannedDuration
        }
    }

    // MARK: - Property 4: Session scoping (Requirements 1.1, 1.3)

    func testProperty4_NoPickupsWithoutActiveSession() {
        // With no session active, arbitrary scene-phase sequences emit nothing.
        property("no pickups emitted while inactive") <- forAll { (steps: [Bool]) in
            let detector = LifecyclePickupDetector(now: { Date() })
            var count = 0
            detector.onPickup = { _ in count += 1 }
            // Never call start(): the detector is inactive throughout.
            for foreground in steps {
                detector.handleScenePhase(foreground ? .active : .background)
            }
            return count == 0
        }
    }

    func testProperty4_ActiveRoundTripEmitsPickups() {
        // While active, each background->active round trip (spaced beyond the
        // debounce) emits exactly one pickup.
        var clock = Date(timeIntervalSince1970: 1_700_000_000)
        let detector = LifecyclePickupDetector(minGapSeconds: 2, now: { clock })
        var count = 0
        detector.onPickup = { _ in count += 1 }
        detector.start(session: FocusSession(
            id: UUID(), dateKey: "2025-06-14", mode: .work,
            startedAt: clock, plannedDuration: 1500, endedAt: nil, pickups: []
        ))

        let roundTrips = 5
        for _ in 0..<roundTrips {
            clock.addTimeInterval(10)             // well beyond the 2s debounce
            detector.handleScenePhase(.background)
            clock.addTimeInterval(10)
            detector.handleScenePhase(.active)
        }
        XCTAssertEqual(count, roundTrips)
    }

    // MARK: - Property 11: Debounce spacing (Requirement 1.2)

    func testProperty11_DebounceSpacing() {
        // No two emitted pickups occur closer together than minGapSeconds.
        property("emitted pickups are spaced >= minGapSeconds") <- forAll {
            (rawGaps: [Int]) in
            let minGap: TimeInterval = 2
            var clock = Date(timeIntervalSince1970: 1_700_000_000)
            let detector = LifecyclePickupDetector(minGapSeconds: minGap, now: { clock })
            var emitted: [Date] = []
            detector.onPickup = { emitted.append($0) }
            detector.start(session: FocusSession(
                id: UUID(), dateKey: "2025-06-14", mode: .work,
                startedAt: clock, plannedDuration: 100000, endedAt: nil, pickups: []
            ))

            // Drive a sequence of round trips separated by arbitrary (>=0) gaps.
            for raw in rawGaps.prefix(30) {
                let gap = TimeInterval(abs(raw) % 6)   // 0..5 seconds
                detector.handleScenePhase(.background)
                clock.addTimeInterval(gap)
                detector.handleScenePhase(.active)
                clock.addTimeInterval(0.001)
            }

            // Verify spacing invariant across everything that was emitted.
            for i in 1..<max(emitted.count, 1) where emitted.count > 1 {
                if emitted[i].timeIntervalSince(emitted[i - 1]) < minGap {
                    return false
                }
            }
            return true
        }
    }

    // MARK: - Property 7: Unique pickup ids (Requirement 2.6)

    func testProperty7_UniquePickupIDs() {
        property("all pickup ids within a session are unique") <- forAll { (n: Int) in
            let count = abs(n % 50)
            var clock = Date(timeIntervalSince1970: 1_700_000_000)
            let (tracker, store, _, _) = self.makeTracker(now: { clock })
            let id = self.startSession(tracker, startedAt: clock, plannedDuration: 100000)

            for _ in 0..<count {
                clock.addTimeInterval(3)
                tracker.onPickup(occurredAt: clock)
            }

            guard let session = store.session(id: id) else { return count == 0 }
            let ids = session.pickups.map(\.id)
            return Set(ids).count == ids.count
        }
    }

    // MARK: - Property 5 (phone half): Tag consistency (Requirement 2.4)

    func testProperty5_PhoneTagOnEveryRecordedPickup() {
        property("every recorded pickup is tagged .phone") <- forAll { (n: Int) in
            let count = 1 + abs(n % 20)
            var clock = Date(timeIntervalSince1970: 1_700_000_000)
            let (tracker, store, _, sync) = self.makeTracker(now: { clock })
            let id = self.startSession(tracker, startedAt: clock, plannedDuration: 100000)
            for _ in 0..<count {
                clock.addTimeInterval(3)
                tracker.onPickup(occurredAt: clock)
            }
            let stored = store.session(id: id)?.pickups ?? []
            let enqueuedPhone = sync.allEvents.allSatisfy { $0.tag == .phone }
            let storedPhone = stored.allSatisfy { $0.tag == .phone }
            return enqueuedPhone && storedPhone && stored.count == count
        }
    }

    // MARK: - Task 4.5: SessionTracker edge cases (unit)

    func testOnPickupWithNoActiveSessionIsNoOp() {
        let (tracker, _, _, sync) = makeTracker()
        tracker.onPickup(occurredAt: Date())
        XCTAssertTrue(sync.allEvents.isEmpty)
        XCTAssertNil(tracker.current)
    }

    func testOnSessionStoppedWithNoActiveSessionIsNoOp() {
        let (tracker, _, _, sync) = makeTracker()
        tracker.onSessionStopped(sessionId: UUID(), reason: "stopped")
        XCTAssertTrue(sync.enqueued.isEmpty)
    }

    func testPickupBeforeStartClampsToZero() {
        let start = Date(timeIntervalSince1970: 1_700_000_000)
        let before = start.addingTimeInterval(-120)
        let (tracker, store, _, _) = makeTracker(now: { before })
        let id = startSession(tracker, startedAt: start, plannedDuration: 1500)
        tracker.onPickup(occurredAt: before)
        XCTAssertEqual(store.session(id: id)?.pickups.first?.elapsed, 0)
    }

    func testPickupAfterPlannedEndClampsToPlannedDuration() {
        let start = Date(timeIntervalSince1970: 1_700_000_000)
        let planned = 1500
        let after = start.addingTimeInterval(TimeInterval(planned + 500))
        let (tracker, store, _, _) = makeTracker(now: { after })
        let id = startSession(tracker, startedAt: start, plannedDuration: planned)
        tracker.onPickup(occurredAt: after)
        XCTAssertEqual(store.session(id: id)?.pickups.first?.elapsed, planned)
    }
}
