# Implementation Plan: iOS Focus Companion

## Overview

This plan implements the iOS Focus Companion in two coordinated tracks:

- **iOS (Swift/SwiftUI):** the greenfield companion app â€” core models, the `PickupDetector` protocol and lifecycle-based detector (Option B), the `SessionTracker`, the on-device `LocalStore`, the `SyncClient` (Bonjour discovery + WebSocket transport, offline queue, reconnect), QR-code pairing with Keychain-backed `sessionKey`, and the SwiftUI views (pair, live session, local history, settings).
- **Electron desktop (JavaScript):** additive changes to the existing Intention app â€” a Bonjour + WebSocket sync server in `main.js`, bridge methods in `preload.js`, and phone-distraction merge logic in `js/timer.js` / `js/history.js`.

Tasks are ordered so each step builds on the previous one and ends by wiring components together. The design defines pseudocode/Swift signatures and 12 correctness properties; property-based test sub-tasks reference those properties directly and are marked optional (`*`). Swift property tests use SwiftCheck; Electron unit tests use a Node test runner (e.g. Jest or `node:test`), which must be set up as part of task 8.

## Tasks

- [x] 1. Scaffold the iOS companion project and core data models
  - Create the SwiftUI app target (`FocusCompanion`) with an Xcode project structure: `Models/`, `Detection/`, `Session/`, `Store/`, `Sync/`, `Pairing/`, `Views/`.
  - Define `SessionMode` (`work`, `shortBreak`, `longBreak`) and `DistractionTag` (`phone`, `people`, `thought`, `other`) enums as `Codable`.
  - Define `FocusSession` (`id`, `dateKey`, `mode`, `startedAt`, `plannedDuration`, `endedAt`, `pickups`) and `PickupEvent` (`id`, `elapsed`, `occurredAt`, `tag`, `synced`) as `Codable, Identifiable`.
  - Add a SwiftCheck (or equivalent) test target for property-based tests.
  - _Requirements: 2.1, 2.4, 2.6_

- [x] 2. Implement pickup detection behind a substitutable protocol
  - [x] 2.1 Define the `PickupDetector` protocol
    - Declare `var onPickup: ((Date) -> Void)? { get set }`, `func start(session: FocusSession)`, and `func stop()` so alternative strategies (e.g. Option A / DeviceActivity) can be dropped in without changing the `PickupEvent` output shape.
    - _Requirements: 1.4_

  - [x] 2.2 Implement `LifecyclePickupDetector` (Option B)
    - Track `active`, `wasActive`, `minGapSeconds` (default 2), and `lastPickupAt` per Algorithm 1.
    - On `start(session:)` set `active = true`, `wasActive = true`, and subscribe to scene-phase changes; on `stop()` set `active = false` and unsubscribe.
    - In `handleScenePhase`: emit `onPickup(now)` on an inactive/background â†’ active round trip only when a session is active and the debounce gap has elapsed; record background/inactive by setting `wasActive = false`.
    - _Requirements: 1.1, 1.2, 1.3_

  - [x]* 2.3 Write property test for session scoping
    - **Property 4: Session scoping**
    - **Validates: Requirements 1.1, 1.3**

  - [x]* 2.4 Write property test for debounce spacing
    - **Property 11: Debounce spacing**
    - **Validates: Requirements 1.2**

- [x] 3. Implement the on-device Local Store
  - [x] 3.1 Implement `LocalStore` persistence (SwiftData or UserDefaults + Codable)
    - Provide `save(_ session:)`, `loadSessions()`, and helpers to append/update a session's `pickups`; persist `FocusSession`s with their nested `PickupEvent`s.
    - Restore previously persisted sessions and pickups on init (app restart).
    - _Requirements: 6.1, 6.2, 6.3_

  - [x]* 3.2 Write property test for persistence round trip across restart
    - **Property 10: Persistence round trip across restart**
    - **Validates: Requirements 6.1, 6.2, 6.3**

- [x] 4. Implement the Session Tracker
  - [x] 4.1 Implement `SessionTracker` with pickup â†’ distraction conversion
    - On `onSessionStarted(msg)` build a `FocusSession` from the message, persist it via `LocalStore`, and call `detector.start`.
    - On `onPickup(occurredAt)` compute `elapsed = clamp(round(occurredAt - startedAt), 0, plannedDuration)`, build a `PickupEvent` with a new UUID and `tag = .phone` and `synced = false`, append it, persist, and enqueue a `distractionBatch` on the sync client.
    - On `onSessionStopped(msg)` set `endedAt`, persist, stop the detector, and enqueue any unsynced events (offline finalize).
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 6.4, 6.5_

  - [x]* 4.2 Write property test for elapsed bounds
    - **Property 1: Elapsed bounds**
    - **Validates: Requirements 2.2, 2.3**

  - [x]* 4.3 Write property test for tag consistency (phone side)
    - **Property 5: Tag consistency** (the `PickupEvent` half of the end-to-end chain)
    - **Validates: Requirements 2.4**

  - [x]* 4.4 Write property test for unique pickup ids
    - **Property 7: Unique pickup ids**
    - **Validates: Requirements 2.6**

  - [x]* 4.5 Write unit tests for SessionTracker edge cases
    - Cover `onPickup`/`onSessionStopped` when no session is active, pickups before start (clamps to 0) and after planned end (clamps to `plannedDuration`).
    - _Requirements: 2.2, 2.3, 2.5_

- [x] 5. Checkpoint - detection, store, and tracking
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Implement pairing over QR code
  - [x] 6.1 Define `PairingPayload` and QR decoding
    - Define `PairingPayload` (`host`, `port`, `deviceId`, `pairingToken`, `fingerprint`) as `Codable`; implement JSON decoding of a scanned QR string and validation that required fields are present.
    - _Requirements: 3.1, 4.8_

  - [x] 6.2 Implement `PairFromQR` handshake with Keychain storage
    - Open a WebSocket to `payload.host:payload.port`, send a `pairRequest` with the `pairingToken` and device info, await `pairAck` (10s timeout).
    - On `pairAck` with a matching fingerprint, store `sessionKey`, `desktopHost`, and `desktopPort` in the iOS Keychain; on token rejection or fingerprint mismatch, close the connection and persist nothing.
    - _Requirements: 3.2, 3.3, 3.4, 3.5, 3.6_

  - [x]* 6.3 Write property test for pairing QR round trip
    - **Property 9: Pairing QR round trip**
    - **Validates: Requirements 3.1**

  - [x]* 6.4 Write unit tests for pairing failure paths
    - Assert invalid/expired token prompts re-scan (no key stored) and fingerprint mismatch closes the connection with nothing persisted.
    - _Requirements: 3.5, 3.6_

- [x] 7. Implement the Sync Client (transport, offline queue, reconnect)
  - [x] 7.1 Define `SyncClient` protocol and wire messages
    - Declare `discover()`, `pair(with:)`, `connect()`, `send(_:)`, and `onMessage`; define `OutboundMessage` (`distractionBatch`, `pairRequest`) and `InboundMessage` (`sessionStarted`, `sessionStopped`, `ack`, `pairAck`, `pairError`) with JSON coding matching the design wire formats.
    - _Requirements: 4.3, 4.7_

  - [x] 7.2 Implement Bonjour discovery and WebSocket connection
    - Use `NWBrowser` to browse `_focusflow._tcp` for reconnection and `NWConnection` for the WebSocket, connecting with the stored `sessionKey`; support manual host:port connection from the pairing payload when discovery is blocked.
    - _Requirements: 4.1, 4.2, 4.8, 8.3_

  - [x] 7.3 Implement persisted offline queue with ack-gated removal
    - Implement `enqueue`, `flush`, and `onDisconnect` per Algorithm 4: persist the queue, send in order, remove a message only after an ack that confirms it, mark events `synced`, and schedule reconnection with exponential backoff on failure.
    - _Requirements: 4.3, 4.4, 4.5, 4.6, 6.4_

  - [x]* 7.4 Write property test for no loss across disconnect
    - **Property 3: No loss across disconnect**
    - **Validates: Requirements 4.4, 4.5, 6.4**

  - [x]* 7.5 Write property test for privacy invariant (default LAN path)
    - **Property 6: Privacy invariant (default path)**
    - **Validates: Requirements 7.1, 7.4**

  - [x]* 7.6 Write unit tests for queue flush semantics
    - Assert flush removes only acked messages, preserves send order, and stops on a non-confirming ack.
    - _Requirements: 4.5_

- [x] 8. Set up the Electron test harness and Bonjour + WebSocket server in main.js
  - [x] 8.1 Add dependencies and a Node test runner
    - Add `ws`, `bonjour-service`, and `qrcode` to `package.json` dependencies and configure a test runner (Jest or `node:test`) with a `test` script.
    - _Requirements: 4.1_

  - [x] 8.2 Implement `DesktopSyncServer` in main.js
    - Start a `WebSocketServer` on a chosen port and publish a `_focusflow._tcp` Bonjour service with `deviceId`/`fingerprint` TXT records; accept a single paired socket.
    - Handle `pairRequest` (validate token â†’ issue `sessionKey` â†’ reply `pairAck` with fingerprint, else `pairError`) and `distractionBatch` (forward to renderer via `mainWindow.webContents.send('phone-distractions', msg)` and reply `ack` with exactly the batch event ids).
    - _Requirements: 3.1, 3.3, 4.1, 4.7_

  - [x] 8.3 Emit session lifecycle to the paired phone
    - In the existing `ipcMain.on('timer-started'|'timer-stopped')` handlers, when a socket is paired, send `sessionStarted` (with `sessionId`, `dateKey`, `mode`, `startedAt`, `plannedDuration`) and `sessionStopped`.
    - _Requirements: 2.1, 2.5_

  - [x]* 8.4 Write property test for ack mirrors batch ids
    - **Property 8: Ack mirrors batch ids**
    - **Validates: Requirements 4.7**

- [x] 9. Add the preload.js sync bridge and pairing QR generation
  - [x] 9.1 Expose bridge methods in preload.js
    - Add `onPhoneDistractions(cb)` (subscribes to the `phone-distractions` IPC channel) and `getPairingQR()` (invokes `get-pairing-qr`) to the `electronAPI` object.
    - _Requirements: 3.1, 5.1_

  - [x] 9.2 Implement pairing QR generation in main.js
    - Add a `get-pairing-qr` IPC handler that builds the `{host, port, deviceId, pairingToken, fingerprint}` payload with a fresh one-time token and returns a QR data URL plus the payload (for manual host:port fallback display).
    - _Requirements: 3.1, 4.8, 8.3_

- [x] 10. Implement renderer merge of phone distractions
  - [x] 10.1 Implement `mergePhoneDistractions` in timer.js / history.js
    - Subscribe to `onPhoneDistractions`; for the current running work session, dedup by `id` and push `{id, elapsed, tag}` into `timerState.distractionTimestamps`.
    - Merge each event into `distractionDailyLog[msg.dateKey]` (dedup by `id`) as `{id, time, cause: null, tag: "phone", duration: null, source: "ios"}`, save, and call `renderCalendar()`.
    - Ensure existing entries lacking `id`/`source` still render without error.
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [x]* 10.2 Write property test for idempotent, complete merge
    - **Property 2: Idempotent, complete merge**
    - **Validates: Requirements 5.1, 5.2, 5.3**

  - [x]* 10.3 Write unit tests for merge tag consistency and backward compatibility
    - Assert merged entries carry `tag: "phone"` and `source: "ios"` (Property 5 desktop half) and that entries without `id`/`source` render without error.
    - _Requirements: 5.4, 5.5_

- [x] 11. Checkpoint - end-to-end LAN sync path
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. Build the SwiftUI views and wire the app together
  - [x] 12.1 Implement the pairing view
    - QR-scanning screen (AVFoundation/VisionKit) that decodes a `PairingPayload` and runs `PairFromQR`, plus a manual host:port entry fallback when discovery is blocked.
    - _Requirements: 3.2, 4.8, 8.3_

  - [x] 12.2 Implement the live session and local history views
    - Live view showing the running pickup count for the active session; history view reading persisted sessions/pickups from `LocalStore`.
    - Bind `scenePhase` changes to `detector.handleScenePhase` in the live session view.
    - _Requirements: 1.1, 6.3_

  - [x] 12.3 Wire detector, tracker, store, and sync client together
    - Instantiate `LifecyclePickupDetector`, `SessionTracker`, `LocalStore`, and `SyncClient`; route `syncClient.onMessage` to `tracker.onSessionStarted/onSessionStopped` and `syncClient.markSynced`; set `detector.onPickup = tracker.onPickup`.
    - _Requirements: 2.1, 2.5, 4.3, 4.5_

- [x] 13. Implement privacy defaults and optional cloud relay
  - [x] 13.1 Implement the settings view and privacy defaults
    - Add a settings screen that defaults the cloud relay to disabled and confirms no account and no analytics transmission; while LAN + relay-off, restrict transmission to the paired desktop only.
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 8.1_

  - [x] 13.2 Implement opt-in cloud relay with end-to-end encryption
    - When the user explicitly enables the relay, route batches through the relay encrypted with the paired peer's key so the relay cannot read plaintext; keep manual host:port available as the non-relay fallback.
    - _Requirements: 8.2, 8.3_

  - [x]* 13.3 Write property test for relay end-to-end encryption
    - **Property 12: Relay end-to-end encryption**
    - **Validates: Requirements 8.2**

- [x] 14. Final checkpoint - ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP; they are test tasks (unit, property-based, integration-style unit).
- Each task references specific requirements clauses for traceability.
- Property test sub-tasks each reference a single correctness property from the design's Correctness Properties section and are placed close to the implementation they validate.
- Property 5 (tag consistency) spans two components; task 4.3 covers the phone half and task 10.3 covers the desktop half.
- The Electron changes are additive to the existing `main.js`, `preload.js`, `js/timer.js`, and `js/history.js`; no test framework exists yet, so task 8.1 sets one up before the first Electron test.
- Checkpoints ensure incremental validation at natural integration boundaries.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "8.1"] },
    { "id": 1, "tasks": ["2.1", "3.1", "6.1", "7.1", "8.2", "9.1"] },
    { "id": 2, "tasks": ["2.2", "3.2", "6.2", "7.2", "8.3", "9.2", "10.1"] },
    { "id": 3, "tasks": ["2.3", "2.4", "4.1", "6.3", "6.4", "7.3", "8.4", "10.2", "10.3"] },
    { "id": 4, "tasks": ["4.2", "4.3", "4.4", "4.5", "7.4", "7.5", "7.6", "12.1", "12.2", "13.1"] },
    { "id": 5, "tasks": ["12.3", "13.2"] },
    { "id": 6, "tasks": ["13.3"] }
  ]
}
```

