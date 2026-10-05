import Foundation
import SwiftCheck
@testable import FocusCompanionCore

/// SwiftCheck `Arbitrary` generators for the core models.
///
/// These are the shared building blocks for the named, numbered property-based
/// tests added in later tasks (e.g. Property 7 "unique pickup ids", Property 10
/// "persistence round trip"). Defining them here in task 1 confirms the
/// property-testing target is correctly wired.

extension SessionMode: Arbitrary {
    public static var arbitrary: Gen<SessionMode> {
        Gen<SessionMode>.fromElements(of: SessionMode.allCases)
    }
}

extension DistractionTag: Arbitrary {
    public static var arbitrary: Gen<DistractionTag> {
        Gen<DistractionTag>.fromElements(of: DistractionTag.allCases)
    }
}

/// Generates a `Date` within a bounded, realistic window to keep shrinking sane.
private let arbitraryDate: Gen<Date> = Int.arbitrary
    .map { Date(timeIntervalSince1970: TimeInterval(1_700_000_000 + abs($0 % 100_000_000))) }

extension PickupEvent: Arbitrary {
    public static var arbitrary: Gen<PickupEvent> {
        Gen<PickupEvent>.compose { c in
            PickupEvent(
                id: UUID(),
                elapsed: abs(c.generate(using: Int.arbitrary) % 3600),
                occurredAt: c.generate(using: arbitraryDate),
                tag: c.generate(),
                synced: c.generate()
            )
        }
    }
}

extension FocusSession: Arbitrary {
    public static var arbitrary: Gen<FocusSession> {
        Gen<FocusSession>.compose { c in
            FocusSession(
                id: UUID(),
                dateKey: c.generate(using: dateKeyGen),
                mode: c.generate(),
                startedAt: c.generate(using: arbitraryDate),
                plannedDuration: 60 * (1 + abs(c.generate(using: Int.arbitrary) % 60)),
                endedAt: c.generate(using: arbitraryDate.optional),
                pickups: c.generate(using: PickupEvent.arbitrary.proliferate)
            )
        }
    }
}

/// Generates a plausible "YYYY-MM-DD" date key.
private let dateKeyGen: Gen<String> = Gen<(Int, Int, Int)>.zip(
    Gen<Int>.choose((2020, 2030)),
    Gen<Int>.choose((1, 12)),
    Gen<Int>.choose((1, 28))
).map { year, month, day in
    String(format: "%04d-%02d-%02d", year, month, day)
}

/// A trivial property confirming the generators run and the target is wired.
final class ArbitraryModelsSmokeTests {
    static func run() {
        property("generated pickup elapsed is non-negative") <- forAll { (event: PickupEvent) in
            event.elapsed >= 0
        }
    }
}
