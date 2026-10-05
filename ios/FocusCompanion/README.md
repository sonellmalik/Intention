# FocusCompanion (iOS)

Native Swift/SwiftUI companion app for the FocusFlow desktop (Electron) app. While a
Pomodoro focus session runs on the desktop, this app counts phone pickups during the
session and syncs them back to the desktop as distraction events.

See the spec in `.kiro/specs/ios-focus-companion/` for requirements and design.

## Project layout

This uses a Swift Package Manager (SwiftPM) layout so the UI-independent logic can be
built and tested on macOS CI without a device or simulator. The SwiftUI app target is
built with Xcode against the iOS SDK.

```
ios/FocusCompanion/
  Package.swift                         SwiftPM manifest (FocusCompanionCore library + tests)
  App/
    FocusCompanionApp.swift             SwiftUI @main entry point (app target, Xcode-only)
    Views/                              SwiftUI views: pair, live session, history, settings (task 12/13)
  Sources/FocusCompanionCore/
    Models/                             SessionMode, DistractionTag, FocusSession, PickupEvent  (task 1)
    Detection/                          PickupDetector protocol + LifecyclePickupDetector       (task 2)
    Session/                            SessionTracker                                          (task 4)
    Store/                              LocalStore persistence                                  (task 3)
    Sync/                               SyncClient (Bonjour + WebSocket, offline queue)         (task 7)
    Pairing/                            PairingPayload + QR handshake                           (task 6)
  Tests/FocusCompanionCoreTests/
    ModelCodableTests.swift             Codable round-trip smoke tests
    Arbitrary+Models.swift              SwiftCheck Arbitrary generators for the models
```

The `App/` target depends on the `FocusCompanionCore` library and hosts SwiftUI. The
core library holds all UI-independent logic so the correctness properties from the
design can be tested with SwiftCheck off-device.

## Building and testing

The core library and its property-based tests build with SwiftPM on **macOS**:

```sh
cd ios/FocusCompanion
swift build
swift test
```

The SwiftUI app target (`App/`) requires **Xcode** and an iOS SDK. On macOS, add the
`App/` sources to an Xcode app target that links `FocusCompanionCore`, or open the
package in Xcode and add an app target.

## Environment limitation (important)

This package was scaffolded on **Windows**, where no Swift toolchain and no Xcode are
available. As a result the following could **not** be verified locally:

- `swift build` / `swift test` were not run (no `swift` toolchain on Windows).
- SwiftCheck was not resolved or compiled.
- The SwiftUI app target was not compiled (Xcode + iOS SDK required).

The source files and `Package.swift` were written to match the design's Swift
signatures exactly and follow standard SwiftPM structure, so they are expected to build
on a Mac with Swift 5.9+ and Xcode. Run `swift build` / `swift test` on macOS to
confirm before relying on the package.
