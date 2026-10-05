// swift-tools-version: 5.9
// The swift-tools-version declares the minimum version of Swift required to build this package.

import PackageDescription

let package = Package(
    name: "FocusCompanion",
    platforms: [
        // iOS is the shipping target for the SwiftUI app; macOS is included so the
        // pure-logic library and its tests build and run on a Mac CI/dev machine
        // without needing a device or simulator.
        .iOS(.v16),
        .macOS(.v13)
    ],
    products: [
        // The core, UI-independent logic (models, detection, session, store, sync,
        // pairing) lives in a library so it can be unit- and property-tested off-device.
        .library(
            name: "FocusCompanionCore",
            targets: ["FocusCompanionCore"]
        )
    ],
    dependencies: [
        // Property-based testing framework used by the design's correctness properties.
        .package(url: "https://github.com/typelift/SwiftCheck.git", from: "0.12.0")
    ],
    targets: [
        .target(
            name: "FocusCompanionCore",
            dependencies: [],
            path: "Sources/FocusCompanionCore"
        ),
        .testTarget(
            name: "FocusCompanionCoreTests",
            dependencies: [
                "FocusCompanionCore",
                .product(name: "SwiftCheck", package: "SwiftCheck")
            ],
            path: "Tests/FocusCompanionCoreTests"
        )
    ]
)
