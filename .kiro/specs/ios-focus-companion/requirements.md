# Requirements Document

## Introduction

The **iOS Focus Companion** is a native Swift/SwiftUI application that extends the existing Intention Electron desktop app. While a Pomodoro focus session runs on the desktop, the companion app measures how often the user picks up the phone and records each pickup as a distraction event. Those events are synced back to the desktop and merged into Intention's existing distraction timeline and history heatmap.

The feature preserves Intention's core promise: local-first operation with no accounts, no cloud, and no analytics by default. The default sync path is a direct device-to-device connection over the local network (LAN) using Bonjour discovery, a WebSocket transport, and QR-code pairing. A cloud relay is available only as an explicit, off-by-default opt-in. Manual host:port entry is available as a fallback when mDNS discovery is blocked.

This requirements document is derived from the approved design document and captures the functional and non-functional requirements the design must satisfy.

## Glossary

- **Companion_App**: The native iOS Swift/SwiftUI application that detects phone pickups and syncs them to the desktop.
- **Desktop_App**: The existing Intention Electron application that runs Pomodoro focus sessions and owns the distraction data model.
- **Pickup_Detector**: The Companion_App component that detects each phone pickup or app-switch during an active focus session and emits a pickup event.
- **Session_Tracker**: The Companion_App component that mirrors the desktop session state and converts pickups into distraction events.
- **Sync_Client**: The Companion_App component that discovers, pairs with, connects to, and exchanges messages with the Desktop_App.
- **Sync_Server**: The Desktop_App component that advertises the service over Bonjour, accepts a paired phone connection, and receives distraction batches.
- **Local_Store**: The on-device persistence layer of the Companion_App (SwiftData or UserDefaults + Codable).
- **Focus_Session**: A single Pomodoro period with a mode, start time, and planned duration, mirrored from the Desktop_App to the Companion_App.
- **Pickup_Event**: A recorded distraction produced when the phone is picked up during a Focus_Session; carries a stable id, elapsed seconds within the session, wall-clock time, and a tag.
- **Distraction_Batch**: A wire message from the phone to the desktop containing one or more Pickup_Events for a session.
- **Session_Mode**: The type of a Focus_Session; one of work, shortBreak, or longBreak.
- **Distraction_Tag**: A classification of a distraction; one of phone, people, thought, or other.
- **Elapsed**: The number of seconds between a Focus_Session start and a pickup, used to place the event on the desktop timeline.
- **Pairing_Token**: A one-time, short-lived secret used to authenticate the first WebSocket handshake between phone and desktop.
- **Session_Key**: A durable secret stored in the iOS Keychain after successful pairing, reused for subsequent connections.
- **Fingerprint**: An identifier that lets the phone verify it is connected to the intended Desktop_App.
- **Distraction_Timeline**: The Desktop_App in-memory list of distraction events for the running session (`distractionTimestamps`).
- **Distraction_Daily_Log**: The Desktop_App persisted history of distraction events keyed by date (`focusflow_distractionDailyLog`).
- **Cloud_Relay**: An optional hosted relay transport that forwards data across networks; off by default.

## Requirements

### Requirement 1: Phone Pickup Detection During a Focus Session

**User Story:** As a person running a Pomodoro session, I want the companion app to detect each time I pick up my phone during the session, so that my phone distractions are captured accurately.

#### Acceptance Criteria

1. WHILE a Focus_Session is active, WHEN the Companion_App returns to the foreground after a background or inactive transition, THE Pickup_Detector SHALL emit one Pickup_Event.
2. IF the Companion_App returns to the foreground within the debounce interval of the previous pickup, THEN THE Pickup_Detector SHALL suppress the additional Pickup_Event.
3. WHILE no Focus_Session is active, THE Pickup_Detector SHALL emit zero Pickup_Events.
4. THE Pickup_Detector SHALL expose a detection interface that supports substituting an alternative detection strategy without changing the Pickup_Event output shape.

### Requirement 2: Session Tracking Mirrored from the Desktop

**User Story:** As a user, I want the companion app to mirror my desktop focus session, so that pickups are recorded against the correct session and time.

#### Acceptance Criteria

1. WHEN the Companion_App receives a session-started message from the Desktop_App, THE Session_Tracker SHALL create a Focus_Session with the received identifier, date key, mode, start time, and planned duration.
2. WHEN a Pickup_Event is detected during an active Focus_Session, THE Session_Tracker SHALL set the Pickup_Event Elapsed to the whole number of seconds between the Focus_Session start time and the pickup time.
3. WHEN a Pickup_Event is recorded, THE Session_Tracker SHALL constrain its Elapsed value to be greater than or equal to 0 and less than or equal to the Focus_Session planned duration.
4. WHEN a Pickup_Event is recorded, THE Session_Tracker SHALL assign the Distraction_Tag value phone to the Pickup_Event.
5. WHEN the Companion_App receives a session-stopped message from the Desktop_App, THE Session_Tracker SHALL record the Focus_Session end time and stop the Pickup_Detector.
6. THE Session_Tracker SHALL assign a unique identifier to each Pickup_Event within a Focus_Session.

### Requirement 3: Device Pairing via QR Code

**User Story:** As a user, I want to pair my phone with my desktop by scanning a QR code, so that setup is quick and I connect to the correct device without accounts.

#### Acceptance Criteria

1. WHEN the user opens the pairing screen on the Desktop_App, THE Desktop_App SHALL generate a pairing payload containing host, port, device identifier, Pairing_Token, and Fingerprint, and render it as a QR code.
2. WHEN the Companion_App scans a valid pairing QR code, THE Sync_Client SHALL open a connection to the encoded host and port and send a pairing request containing the Pairing_Token.
3. WHEN the Desktop_App receives a pairing request with a valid Pairing_Token, THE Sync_Server SHALL issue a Session_Key and return a pairing acknowledgement containing the Session_Key and Fingerprint.
4. WHEN the Companion_App receives a pairing acknowledgement whose Fingerprint matches the scanned payload, THE Sync_Client SHALL store the Session_Key in the iOS Keychain.
5. IF the Pairing_Token is invalid or expired, THEN THE Sync_Server SHALL reject the pairing request and THE Sync_Client SHALL prompt the user to re-scan the QR code.
6. IF the pairing acknowledgement Fingerprint does not match the scanned payload, THEN THE Sync_Client SHALL close the connection and store no Session_Key.

### Requirement 4: LAN Sync Transport with Offline Queueing and Reliable Delivery

**User Story:** As a user, I want pickups to sync reliably even when my connection drops, so that no distraction is lost or double-counted.

#### Acceptance Criteria

1. THE Desktop_App SHALL advertise the sync service over Bonjour and run a WebSocket server that accepts one paired Companion_App connection.
2. WHEN pairing information is required for reconnection, THE Sync_Client SHALL discover the Desktop_App over Bonjour.
3. WHEN a Pickup_Event is enqueued and the Sync_Client is connected, THE Sync_Client SHALL send the corresponding Distraction_Batch to the Desktop_App.
4. WHILE the Sync_Client is disconnected, THE Sync_Client SHALL retain enqueued messages in a persisted queue.
5. WHEN a message is sent, THE Sync_Client SHALL remove the message from the queue only after receiving an acknowledgement that confirms the message.
6. WHEN the connection is lost, THE Sync_Client SHALL schedule a reconnection using increasing backoff.
7. WHEN the Desktop_App receives a Distraction_Batch, THE Sync_Server SHALL return an acknowledgement containing the identifiers of the received Pickup_Events.
8. WHERE the network blocks Bonjour discovery, THE Sync_Client SHALL allow connection using a host and port entered manually from the same pairing payload.

### Requirement 5: Desktop Merge of Phone Distraction Events

**User Story:** As a user, I want phone pickups to appear in my existing Intention timeline and history, so that all my distractions live in one place.

#### Acceptance Criteria

1. WHEN the Desktop_App receives a Distraction_Batch for the currently running work session, THE Desktop_App SHALL add each contained Pickup_Event to the Distraction_Timeline.
2. WHEN the Desktop_App receives a Distraction_Batch, THE Desktop_App SHALL add each contained Pickup_Event to the Distraction_Daily_Log under the batch date key.
3. IF a Pickup_Event identifier already exists in the Distraction_Timeline or Distraction_Daily_Log, THEN THE Desktop_App SHALL skip adding that Pickup_Event.
4. WHEN merging a Pickup_Event into the Distraction_Daily_Log, THE Desktop_App SHALL record the Distraction_Tag value phone and mark the entry source as ios.
5. THE Desktop_App SHALL render Distraction_Daily_Log entries that lack an identifier or source field without error.

### Requirement 6: On-Device History and Persistence

**User Story:** As a user, I want my sessions and pickups saved on the phone, so that my data survives app restarts and offline periods and I can review my local history.

#### Acceptance Criteria

1. WHEN a Focus_Session is created, THE Local_Store SHALL persist the Focus_Session on the device.
2. WHEN a Pickup_Event is recorded, THE Local_Store SHALL persist the Pickup_Event associated with its Focus_Session.
3. WHEN the Companion_App restarts, THE Local_Store SHALL restore previously persisted Focus_Sessions and Pickup_Events.
4. WHILE the Companion_App has no connection to the Desktop_App, THE Session_Tracker SHALL continue recording Pickup_Events to the Local_Store.
5. WHEN a Focus_Session ends without a reachable Desktop_App, THE Session_Tracker SHALL mark the Focus_Session complete locally and enqueue its unsynced Pickup_Events for later delivery.

### Requirement 7: Privacy — Local-First Data Handling

**User Story:** As a privacy-conscious user, I want my distraction data to stay on my own devices by default, so that no third party ever sees it.

#### Acceptance Criteria

1. WHILE the Companion_App uses the LAN configuration, THE Sync_Client SHALL transmit distraction data only to the paired Desktop_App on the local network.
2. THE Companion_App SHALL operate without requiring any user account.
3. THE Companion_App SHALL operate without transmitting analytics data.
4. WHERE the Cloud_Relay option is not enabled, THE Sync_Client SHALL transmit no distraction data to any hosted relay.

### Requirement 8: Optional Cloud Relay and Manual Fallback

**User Story:** As a user on separate networks, I want an optional cloud relay I can turn on, so that I can sync across networks while keeping it disabled by default.

#### Acceptance Criteria

1. THE Companion_App SHALL default the Cloud_Relay option to disabled.
2. WHERE the user explicitly enables the Cloud_Relay option, THE Sync_Client SHALL route distraction data through the Cloud_Relay using end-to-end encryption such that the relay cannot read the distraction data.
3. WHERE the user has not enabled the Cloud_Relay option and Bonjour discovery is blocked, THE Sync_Client SHALL offer manual host and port entry as the connection method.
