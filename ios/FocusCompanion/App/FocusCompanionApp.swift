import SwiftUI
import FocusCompanionCore

/// Entry point for the FocusCompanion iOS app.
///
/// This app target depends on `FocusCompanionCore` (the UI-independent logic
/// library) and hosts the SwiftUI views. It owns the single ``AppContainer``
/// composition root, which constructs the shared detector/tracker/store/sync
/// graph exactly once and injects those shared instances into every view model.
///
/// Note: this file is part of the *app* target, which must be built with Xcode
/// against an iOS SDK. The `FocusCompanionCore` library and its tests build with
/// SwiftPM on macOS (see Package.swift and README).
@main
struct FocusCompanionApp: App {
    /// The single composition root for the process. `@StateObject` guarantees it
    /// is created once and survives view redraws, so every screen observes the
    /// *same* shared graph rather than its own disconnected copy.
    @StateObject private var container = AppContainer()

    var body: some Scene {
        WindowGroup {
            RootView(container: container)
        }
    }
}

/// The composition root: builds the shared object graph once and wires the
/// collaborators together per design "Example Usage (iOS)" and task 12.3.
///
/// A single `AppContainer` owns one each of ``LocalStore``,
/// ``LifecyclePickupDetector``, ``NetworkSyncClient`` (with its
/// ``RelaySettings``), and ``SessionTracker``. Because it is held as a
/// `@StateObject` on the app and passed down to the views, all four view models
/// share these instances — the sync client that receives desktop messages, the
/// detector that observes scene-phase changes, and the store the history view
/// reads are the *same* objects the tracker drives. Nothing here constructs a
/// second graph.
///
/// ## Wiring (order matters)
///
/// 1. `syncClient.onMessage` routes desktop → phone messages:
///    - `.sessionStarted` / `.sessionStopped` map their associated values onto
///      `tracker.onSessionStarted` / `tracker.onSessionStopped`.
///    - `.ack` forwards its event ids to `syncClient.markSynced(_:)` per the
///      design example. (The client also resolves acks internally via its
///      inbound path; forwarding here matches the documented example and is
///      idempotent — the queue treats a duplicate ack for an already-removed
///      head as a no-op.)
/// 2. `syncClient.outboundQueue.onEventsSynced` → `tracker.markSynced(ids:)`.
///    The queue owns ack-gated *removal*; the tracker flips the store-side
///    `PickupEvent.synced` flags for the confirmed ids so an offline finalize or
///    a restart never re-enqueues an already-delivered event.
/// 3. `detector.onPickup = tracker.onPickup(occurredAt:)` is set **here, before**
///    any ``LiveSessionViewModel`` is constructed. `LiveSessionViewModel`
///    *chains* onto the existing `detector.onPickup` (it wraps the current hook
///    and appends a UI refresh), so by installing the tracker hook first we
///    guarantee the tracker still records every pickup and the view model's
///    refresh runs after it. The composition root owns the tracker hook; the
///    view model only decorates it.
///
/// - Requirements: 2.1, 2.5, 4.3, 4.5
@MainActor
final class AppContainer: ObservableObject {
    // MARK: Shared graph (constructed once)

    /// On-device persistence shared by the tracker (writes) and the history view
    /// model (reads).
    let store: LocalStore

    /// The lifecycle pickup detector whose `onPickup` is wired to the tracker
    /// here and later decorated by the live-session view model.
    let detector: LifecyclePickupDetector

    /// The LAN sync client: receives desktop lifecycle/ack messages and owns the
    /// persisted outbound queue.
    let syncClient: NetworkSyncClient

    /// Mirrors the desktop session, converts pickups into `PickupEvent`s, and
    /// flips store-side `synced` flags on ack.
    let tracker: SessionTracker

    /// Privacy/relay configuration shared with the settings screen and the sync
    /// path (relay off by default).
    let settings: RelaySettings

    // MARK: View models (over the shared instances)

    /// Live-session view model over the shared tracker + detector. Constructed
    /// **after** the tracker's `onPickup` hook is installed so its refresh hook
    /// chains onto (rather than replaces) the tracker's.
    let liveSessionViewModel: LiveSessionViewModel

    /// History view model over the shared store.
    let historyViewModel: HistoryViewModel

    init() {
        // 1) Construct the shared collaborators exactly once.
        let store = LocalStore()
        let detector = LifecyclePickupDetector()
        let settings = RelaySettings()
        let syncClient = NetworkSyncClient()
        let tracker = SessionTracker(store: store, detector: detector, syncClient: syncClient)

        self.store = store
        self.detector = detector
        self.settings = settings
        self.syncClient = syncClient
        self.tracker = tracker

        // 2) Route inbound desktop messages to the tracker / sync client.
        //    Mapping the associated values keeps `onMessage` a thin dispatcher.
        syncClient.onMessage = { [weak tracker, weak syncClient] message in
            switch message {
            case let .sessionStarted(sessionId, dateKey, mode, startedAt, plannedDuration):
                tracker?.onSessionStarted(
                    sessionId: sessionId,
                    dateKey: dateKey,
                    mode: mode,
                    startedAt: startedAt,
                    plannedDuration: plannedDuration
                )
            case let .sessionStopped(sessionId, reason):
                tracker?.onSessionStopped(sessionId: sessionId, reason: reason)
            case let .ack(eventIds):
                // Per the design example. The client already resolves acks on
                // its inbound path; this explicit forward is idempotent.
                syncClient?.markSynced(eventIds)
            case .pairAck, .pairError:
                // Handled by the pairing flow (PairFromQR / PairingViewModel),
                // not the running-session graph.
                break
            }
        }

        // 3) When the queue confirms delivery (ack-gated removal), flip the
        //    store-side `synced` flags for those event ids so a later offline
        //    finalize / restart does not re-enqueue already-delivered events.
        syncClient.outboundQueue.onEventsSynced = { [weak tracker] ids in
            tracker?.markSynced(ids: ids)
        }

        // 4) Install the tracker's pickup hook BEFORE building the live-session
        //    view model. The view model chains onto this existing hook (it wraps
        //    the current `onPickup` and appends a UI refresh), so ordering here
        //    ensures the tracker records the pickup first and the refresh runs
        //    after — the composition root owns the tracker hook; the VM decorates.
        detector.onPickup = { [weak tracker] occurredAt in
            tracker?.onPickup(occurredAt: occurredAt)
        }

        // 5) Build the view models over the shared instances. `LiveSessionViewModel`
        //    wraps `detector.onPickup` installed above; `HistoryViewModel` reads
        //    the shared store the tracker persists into.
        self.liveSessionViewModel = LiveSessionViewModel(tracker: tracker, detector: detector)
        self.historyViewModel = HistoryViewModel(store: store)
    }
}

/// The app's root: a `TabView` over the four screens (Pair / Live / History /
/// Settings), each fed the shared graph from the ``AppContainer`` composition
/// root so every screen observes the same tracker/detector/store/sync instances.
struct RootView: View {
    @ObservedObject var container: AppContainer

    var body: some View {
        TabView {
            PairingView()
                .tabItem {
                    Label("Pair", systemImage: "qrcode.viewfinder")
                }

            NavigationView {
                LiveSessionView(viewModel: container.liveSessionViewModel)
            }
            .tabItem {
                Label("Live", systemImage: "waveform.path.ecg")
            }

            NavigationView {
                HistoryView(viewModel: container.historyViewModel)
            }
            .tabItem {
                Label("History", systemImage: "clock.arrow.circlepath")
            }

            SettingsView(settings: container.settings)
                .tabItem {
                    Label("Settings", systemImage: "gearshape")
                }
        }
    }
}
