# Requirements Document

## Introduction

This feature is an iOS application that tracks and visualizes device usage using Apple's Screen Time framework family. The app helps users understand their phone habits by displaying aggregated usage statistics (total screen time, device activity/pickup metrics, and per-app / per-category time) and rendering a "time map" visualization (a timeline/heatmap of usage across the day). A Lock Screen widget summarizes daily usage at a glance.

The design is constrained by the iOS platform. Third-party apps cannot detect raw lock/unlock events, measure precise per-unlock session durations, or draw custom UI on the lock screen. Instead, this app relies on the Screen Time APIs — FamilyControls (authorization), DeviceActivity (usage monitoring and reporting), and ManagedSettings (where relevant) — which expose privacy-sandboxed, aggregated data. All requirements reflect what these frameworks actually make available. Access requires the Family Controls entitlement granted by Apple, with corresponding App Store review implications.

**Target platform:** iOS 16+ for widgets; Screen Time APIs available iOS 15+. Language: Swift / SwiftUI.

## Glossary

- **App**: The iOS application described by this document.
- **Screen_Time_Framework**: Apple's family of frameworks comprising FamilyControls, DeviceActivity, and ManagedSettings.
- **FamilyControls**: Apple framework used to request and hold authorization to access Screen Time data.
- **DeviceActivity**: Apple framework that provides usage monitoring and aggregated activity reporting via the DeviceActivityReport SwiftUI view and DeviceActivityMonitor extension.
- **DeviceActivityReport**: The SwiftUI view and report extension mechanism through which aggregated usage data is rendered inside a privacy-preserving sandbox.
- **ManagedSettings**: Apple framework for applying device management settings; used only where relevant to this App.
- **Family_Controls_Entitlement**: The Apple-granted entitlement (com.apple.developer.family-controls) required to use the Screen_Time_Framework in a distributed app.
- **Authorization_Status**: The FamilyControls authorization state, one of: notDetermined, denied, or approved.
- **Usage_Data**: Aggregated, privacy-sandboxed activity information exposed by DeviceActivity, including total screen time, device activity segments, and per-app / per-category durations.
- **Device_Activity_Metric**: The aggregated activity indicator exposed by DeviceActivity (for example, number of activity segments or pickups as surfaced by the framework), as distinct from raw individual unlock events.
- **App_Category**: A grouping of applications as classified by Apple (for example, Social, Productivity, Games).
- **Time_Map**: A visualization of Usage_Data across a single day, rendered as a timeline or heatmap of usage intensity per time interval.
- **Lock_Screen_Widget**: A WidgetKit widget (iOS 16+) that appears on the Lock Screen and summarizes daily Usage_Data.
- **Widget_Refresh**: The system-controlled process by which WidgetKit reloads widget content, subject to iOS budget throttling.
- **Reporting_Interval**: A user- or system-defined time span over which Usage_Data is aggregated (for example, today, this week).
- **User**: The person operating the App on their own device.

## Requirements

### Requirement 1: Screen Time Authorization

**User Story:** As a User, I want to grant the app permission to access my Screen Time data, so that the app can display my usage statistics.

#### Acceptance Criteria

1. WHEN the App launches for the first time, THE App SHALL request FamilyControls authorization from the User.
2. WHILE the Authorization_Status is notDetermined, THE App SHALL display an explanation of why Screen Time access is needed before presenting the system authorization prompt.
3. WHEN the User approves authorization, THE App SHALL set the Authorization_Status to approved and enable access to Usage_Data.
4. IF the User denies authorization, THEN THE App SHALL display guidance on how to enable Screen Time access in Settings.
5. WHILE the Authorization_Status is denied, THE App SHALL disable all Usage_Data displays and present the authorization guidance instead.
6. WHEN the App requires the Family_Controls_Entitlement to function, THE App SHALL operate only when the Family_Controls_Entitlement is present in the build.

### Requirement 2: Total Screen Time Display

**User Story:** As a User, I want to see my total screen time for a period, so that I can understand how much I use my phone.

#### Acceptance Criteria

1. WHILE the Authorization_Status is approved, THE App SHALL display the total screen time for the selected Reporting_Interval.
2. WHEN the User selects a Reporting_Interval, THE App SHALL update the displayed total screen time to reflect the selected Reporting_Interval.
3. THE App SHALL render total screen time using the DeviceActivityReport mechanism so that Usage_Data remains within Apple's privacy sandbox.
4. IF Usage_Data is unavailable for the selected Reporting_Interval, THEN THE App SHALL display a message indicating that no usage data is available.

### Requirement 3: Device Activity Metrics Display

**User Story:** As a User, I want to see how often my device is active, so that I can gauge my engagement patterns.

#### Acceptance Criteria

1. WHILE the Authorization_Status is approved, THE App SHALL display the Device_Activity_Metric for the selected Reporting_Interval as exposed by DeviceActivity.
2. THE App SHALL label the Device_Activity_Metric using terminology consistent with the aggregated data that DeviceActivity provides, rather than presenting the value as a count of individual raw unlock events.
3. WHERE DeviceActivity does not expose exact per-unlock session durations, THE App SHALL omit per-unlock session duration displays.
4. IF the Device_Activity_Metric is unavailable for the selected Reporting_Interval, THEN THE App SHALL display a message indicating that the metric is unavailable.

### Requirement 4: Per-App and Per-Category Usage Display

**User Story:** As a User, I want to see time spent per app and per category, so that I can identify which apps consume my attention.

#### Acceptance Criteria

1. WHILE the Authorization_Status is approved, THE App SHALL display per-app usage durations for the selected Reporting_Interval.
2. WHILE the Authorization_Status is approved, THE App SHALL display per-App_Category usage durations for the selected Reporting_Interval.
3. WHEN the User selects a Reporting_Interval, THE App SHALL update the per-app and per-App_Category displays to reflect the selected Reporting_Interval.
4. THE App SHALL render per-app and per-App_Category usage within the DeviceActivityReport sandbox so that identifiable app data is not extracted outside Apple's privacy boundary.
5. THE App SHALL order per-app usage entries by descending usage duration.

### Requirement 5: Time Map Visualization

**User Story:** As a User, I want to see a time map of my usage across the day, so that I can visualize when I use my phone most.

#### Acceptance Criteria

1. WHILE the Authorization_Status is approved, THE App SHALL render a Time_Map that visualizes Usage_Data across the selected Reporting_Interval as a timeline or heatmap.
2. THE Time_Map SHALL divide the selected day into discrete time intervals and represent usage intensity for each interval using Usage_Data available from DeviceActivity.
3. WHEN the User selects a different Reporting_Interval, THE App SHALL redraw the Time_Map to reflect the selected Reporting_Interval.
4. THE App SHALL render the Time_Map within the DeviceActivityReport sandbox where it depends on aggregated Usage_Data.
5. IF no Usage_Data is available for an interval of the Time_Map, THEN THE App SHALL render that interval as having zero usage.

### Requirement 6: Lock Screen Widget

**User Story:** As a User, I want a Lock Screen widget summarizing my daily usage, so that I can see my habits without opening the app.

#### Acceptance Criteria

1. WHERE the device runs iOS 16 or later, THE App SHALL provide a Lock_Screen_Widget that summarizes daily Usage_Data.
2. WHILE the Authorization_Status is approved, THE Lock_Screen_Widget SHALL display a daily usage summary derived from Usage_Data.
3. WHEN WidgetKit performs a Widget_Refresh, THE Lock_Screen_Widget SHALL update the displayed daily usage summary to the most recently available Usage_Data.
4. THE App SHALL request Widget_Refresh according to WidgetKit scheduling and SHALL accept that iOS controls the actual refresh timing under its update budget.
5. IF the Authorization_Status is not approved, THEN THE Lock_Screen_Widget SHALL display a prompt to open the App and grant Screen Time access instead of usage data.
6. IF current Usage_Data is unavailable at the time of a Widget_Refresh, THEN THE Lock_Screen_Widget SHALL display the most recently cached daily usage summary.

### Requirement 7: Reporting Interval Selection

**User Story:** As a User, I want to choose the time range for my statistics, so that I can review usage over different periods.

#### Acceptance Criteria

1. THE App SHALL provide a control for the User to select the Reporting_Interval.
2. THE App SHALL support at minimum a daily Reporting_Interval and a weekly Reporting_Interval.
3. WHEN the User changes the Reporting_Interval, THE App SHALL update all Usage_Data displays to reflect the selected Reporting_Interval.
4. WHEN the App launches, THE App SHALL default the Reporting_Interval to the current day.

### Requirement 8: Privacy and Data Handling

**User Story:** As a User, I want my usage data to stay private, so that I can trust the app with my personal information.

#### Acceptance Criteria

1. THE App SHALL access Usage_Data only through the Screen_Time_Framework within Apple's privacy sandbox.
2. THE App SHALL render identifiable per-app Usage_Data only within the DeviceActivityReport sandbox.
3. WHERE the App caches summary values for the Lock_Screen_Widget, THE App SHALL store only aggregated summary values and SHALL exclude identifiable raw activity records.
4. THE App SHALL retain Usage_Data displays on the device and SHALL transmit Usage_Data to external services only when the User explicitly enables such transmission.
