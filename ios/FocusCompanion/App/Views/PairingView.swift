import SwiftUI
import FocusCompanionCore

#if os(iOS)

/// The pairing screen: scan the desktop's QR code to connect, with a manual
/// host:port fallback for networks where camera scanning or Bonjour discovery
/// is unavailable.
///
/// The view is deliberately thin: it renders the scanner (`QRScannerView`) and
/// the manual-entry form, and reflects the `PairingViewModel`'s published
/// `outcome`. All decoding/handshake/error-mapping logic lives in the view
/// model so it stays testable off-device.
///
/// Success is reported to the host (e.g. the root view) through `onPaired` so it
/// can advance to the live-session screen.
///
/// - Requirements: 3.2, 4.8, 8.3
struct PairingView: View {
    @StateObject private var viewModel: PairingViewModel
    /// Invoked once pairing succeeds so the app can move on.
    var onPaired: () -> Void

    /// Creates the view with the live iOS transport/Keychain.
    init(onPaired: @escaping () -> Void = {}) {
        _viewModel = StateObject(wrappedValue: PairingViewModel())
        self.onPaired = onPaired
    }

    /// Creates the view with an injected view model (previews / tests).
    init(viewModel: PairingViewModel, onPaired: @escaping () -> Void = {}) {
        _viewModel = StateObject(wrappedValue: viewModel)
        self.onPaired = onPaired
    }

    var body: some View {
        NavigationView {
            VStack(spacing: 0) {
                if viewModel.showManualEntry {
                    manualEntryForm
                } else {
                    scannerSection
                }
            }
            .navigationTitle("Pair with Desktop")
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button(viewModel.showManualEntry ? "Scan" : "Enter manually") {
                        viewModel.reset()
                        viewModel.showManualEntry.toggle()
                    }
                }
            }
        }
        .onChange(of: viewModel.outcome) { newValue in
            if newValue == .success {
                onPaired()
            }
        }
    }

    // MARK: - Scanner

    private var scannerSection: some View {
        VStack(spacing: 16) {
            ZStack {
                QRScannerView(
                    onScan: { raw in
                        Task { await viewModel.handleScannedCode(raw) }
                    },
                    onError: { _ in
                        // Camera unavailable/denied: steer the user to manual entry.
                        viewModel.showManualEntry = true
                    }
                )
                .cornerRadius(12)

                if viewModel.outcome == .pairing {
                    ProgressView("Pairing…")
                        .padding()
                        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 8))
                }
            }
            .frame(maxWidth: .infinity, minHeight: 320)
            .padding(.horizontal)

            Text("Open FocusFlow on your desktop, choose “Pair phone”, and point your camera at the QR code.")
                .font(.footnote)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal)

            outcomeBanner

            Spacer()
        }
        .padding(.top)
    }

    // MARK: - Manual entry (Requirement 4.8 / 8.3)

    private var manualEntryForm: some View {
        Form {
            Section {
                TextField("Host (e.g. 192.168.1.20)", text: $viewModel.manualHost)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled(true)
                    .keyboardType(.URL)
                TextField("Port (e.g. 41234)", text: $viewModel.manualPort)
                    .keyboardType(.numberPad)
            } header: {
                Text("Desktop address")
            } footer: {
                Text("Use this when your network blocks automatic discovery. Read the values from the pairing screen on your desktop.")
            }

            Section("Pairing details") {
                TextField("Device ID", text: $viewModel.manualDeviceId)
                    .autocorrectionDisabled(true)
                TextField("Pairing token", text: $viewModel.manualPairingToken)
                    .autocorrectionDisabled(true)
                TextField("Fingerprint", text: $viewModel.manualFingerprint)
                    .autocorrectionDisabled(true)
            }

            Section {
                Button {
                    Task { await viewModel.pairManually() }
                } label: {
                    if viewModel.outcome == .pairing {
                        ProgressView()
                    } else {
                        Text("Connect")
                    }
                }
                .disabled(viewModel.outcome == .pairing)
            }

            if viewModel.outcome.message != nil {
                Section {
                    outcomeBanner
                }
            }
        }
    }

    // MARK: - Outcome

    @ViewBuilder
    private var outcomeBanner: some View {
        if let message = viewModel.outcome.message {
            VStack(spacing: 8) {
                Text(message)
                    .font(.callout)
                    .multilineTextAlignment(.center)
                    .foregroundColor(viewModel.outcome == .success ? .green : .primary)

                if viewModel.outcome.suggestsReScan {
                    Button("Try again") {
                        viewModel.reset()
                    }
                    .font(.callout.weight(.semibold))
                }
            }
            .padding()
            .frame(maxWidth: .infinity)
            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 10))
            .padding(.horizontal)
        }
    }
}

#endif
