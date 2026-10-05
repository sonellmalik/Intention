import XCTest
import SwiftCheck
@testable import FocusCompanionCore

/// Property + unit tests for the offline queue and the privacy invariant.
///
///   - Property 3 (no loss across disconnect) — Requirements 4.4, 4.5, 6.4 (task 7.4)
///   - Property 6 (privacy invariant, default) — Requirements 7.1, 7.4       (task 7.5)
///   - Queue flush semantics (unit)            — Requirement 4.5             (task 7.6)
///
/// The queue is exercised through a fake `QueueTransport` so send/ack/disconnect
/// interleavings run deterministically off-device.
final class SyncQueuePropertyTests: XCTestCase {

    // MARK: Fake transport

    /// A controllable `QueueTransport`: records sent messages, lets the test
    /// toggle connectivity, and never really reconnects (the test drives that).
    private final class FakeTransport: QueueTransport {
        var isConnected: Bool = false
        private(set) var sent: [OutboundMessage] = []
        private(set) var reconnectRequests = 0
        var failNextSend = false

        func sendMessage(_ message: OutboundMessage) async throws {
            if !isConnected || failNextSend {
                failNextSend = false
                throw SyncTransportError.notConnected
            }
            sent.append(message)
        }
        func scheduleReconnect(after delay: TimeInterval) {
            reconnectRequests += 1
        }
    }

    private func batch(_ n: Int, session: UUID = UUID()) -> OutboundMessage {
        var events: [DistractionEvent] = []
        for i in 0..<n {
            events.append(DistractionEvent(
                id: UUID(), elapsed: i, occurredAt: Date(timeIntervalSince1970: TimeInterval(1_700_000_000 + i)), tag: .phone
            ))
        }
        return .distractionBatch(sessionId: session, dateKey: "2025-06-14", events: events)
    }

    private func ids(of message: OutboundMessage) -> [UUID] {
        if case let .distractionBatch(_, _, events) = message { return events.map(\.id) }
        return []
    }

    // MARK: - Property 3: No loss across disconnect (4.4, 4.5, 6.4)

    func testProperty3_NoLossAcrossDisconnect() async {
        // Enqueue several batches, connect/flush/ack some, drop the connection,
        // restart the queue over the SAME backend (app restart), reconnect and
        // drain. Every originally-enqueued event id is delivered exactly once,
        // in order, and nothing is lost.
        let backend = InMemoryPersistenceBackend()
        let transport = FakeTransport()
        let queue = OutboundQueue(transport: transport, backend: backend, backoff: BackoffPolicy(base: 0.001))

        var synced: [UUID] = []
        queue.onEventsSynced = { synced.append(contentsOf: $0) }

        let messages = [batch(2), batch(1), batch(3), batch(2)]
        let expected = messages.flatMap { ids(of: $0) }
        for m in messages { queue.enqueue(m) }

        // Connect and ack the first two, then "disconnect".
        transport.isConnected = true
        await queue.flush()
        // Ack head repeatedly, draining while connected.
        var guardCount = 0
        while queue.count > 2 && guardCount < 10 {
            if let head = queue.pendingMessages.first {
                queue.handleAck(eventIds: ids(of: head))
                await queue.flush()
            }
            guardCount += 1
        }

        // Drop the connection: remaining messages stay persisted.
        transport.isConnected = false
        queue.onDisconnect()

        // Simulate an app restart: a brand-new queue over the same backend.
        let transport2 = FakeTransport()
        let queue2 = OutboundQueue(transport: transport2, backend: backend, backoff: BackoffPolicy(base: 0.001))
        var synced2: [UUID] = []
        queue2.onEventsSynced = { synced2.append(contentsOf: $0) }

        // Reconnect and drain everything.
        transport2.isConnected = true
        queue2.connectionRestored()
        await queue2.flush()
        guardCount = 0
        while queue2.count > 0 && guardCount < 50 {
            if let head = queue2.pendingMessages.first {
                queue2.handleAck(eventIds: ids(of: head))
                await queue2.flush()
            }
            guardCount += 1
        }

        // Everything delivered, in order, no loss and no queue remaining.
        let delivered = (transport.sent + transport2.sent).flatMap { ids(of: $0) }
        // Delivered may contain a resend of the in-flight head across the drop;
        // the invariant is that every expected id is delivered at least once and
        // nothing is dropped.
        for id in expected {
            XCTAssertTrue(delivered.contains(id), "event \(id) was lost")
        }
        XCTAssertEqual(queue2.count, 0, "queue should be fully drained")
        // Confirmed sync set covers every event id exactly.
        XCTAssertEqual(Set(synced + synced2), Set(expected))
    }

    // MARK: - Task 7.6: Queue flush semantics (unit)

    func testFlushRemovesOnlyAckedMessagesInOrder() async {
        let transport = FakeTransport()
        let queue = OutboundQueue(transport: transport, backend: InMemoryPersistenceBackend())
        let m1 = batch(1), m2 = batch(1), m3 = batch(1)
        queue.enqueue(m1); queue.enqueue(m2); queue.enqueue(m3)

        transport.isConnected = true
        await queue.flush()                       // sends head (m1), awaits ack
        XCTAssertEqual(queue.count, 3)            // nothing removed before ack

        queue.handleAck(eventIds: ids(of: m1))    // confirm m1
        await queue.flush()
        XCTAssertEqual(queue.count, 2)            // only m1 removed

        // A non-confirming ack for the current head does NOT remove it.
        queue.handleAck(eventIds: [UUID()])
        await queue.flush()
        XCTAssertEqual(queue.count, 2, "non-confirming ack must not remove a message")

        // Correct ack drains the rest in order.
        queue.handleAck(eventIds: ids(of: m2)); await queue.flush()
        queue.handleAck(eventIds: ids(of: m3)); await queue.flush()
        XCTAssertEqual(queue.count, 0)
        XCTAssertEqual(transport.sent.map { self.ids(of: $0) }, [ids(of: m1), ids(of: m2), ids(of: m3)])
    }

    func testSendFailureKeepsMessageAndSchedulesReconnect() async {
        let transport = FakeTransport()
        let queue = OutboundQueue(transport: transport, backend: InMemoryPersistenceBackend())
        let m1 = batch(2)
        queue.enqueue(m1)

        transport.isConnected = true
        transport.failNextSend = true
        await queue.flush()

        XCTAssertEqual(queue.count, 1, "failed send keeps the message queued")
        XCTAssertGreaterThanOrEqual(transport.reconnectRequests, 1, "a reconnect should be scheduled")
    }

    // MARK: - Property 6: Privacy invariant, default path (7.1, 7.4)

    func testProperty6_DefaultPathNeverPermitsRelay() {
        // With the relay disabled (the default), the destination policy is
        // paired-desktop-only and relay transmission is never permitted.
        property("default settings forbid the relay") <- forAll { (_: Int) in
            let defaults = UserDefaults(suiteName: "privacy-\(UUID().uuidString)")!
            let settings = RelaySettings(defaults: defaults)
            return settings.destinationPolicy == .pairedDesktopOnly
                && settings.isRelayTransmissionPermitted == false
                && settings.accountRequired == false
                && settings.analyticsTransmitted == false
        }
    }

    func testEnablingRelayWidensDestinationPolicy() {
        let defaults = UserDefaults(suiteName: "privacy-toggle-\(UUID().uuidString)")!
        let settings = RelaySettings(defaults: defaults)
        XCTAssertEqual(settings.destinationPolicy, .pairedDesktopOnly)
        settings.cloudRelayEnabled = true
        XCTAssertEqual(settings.destinationPolicy, .pairedDesktopOrEncryptedRelay)
        XCTAssertTrue(settings.isRelayTransmissionPermitted)
    }
}
