import Foundation
import Combine
import FocusCompanionCore

#if os(iOS)
import UIKit
#endif

/// The user-facing outcome of a pairing attempt.
///
/// `PairingView` renders one of these; the view model derives them from a
/// scanned QR string or manual host:port entry by running `PairFromQR` and
/// mapping its `PairingError` cases (Requirement 3.5/3.6 plus the timeout path).
///
/// - Requirements: 3.2, 3.5, 3.6
enum PairingOutcome: Equatable {
    /// Idle / ready to scan or enter an address.
    case idle
    /// A pairing attempt is in flight.
    case pairing
    /// Pairing succeeded; the durable session key is stored in the Keychain.
    case success
    /// The desktop rejected the one-time token — prompt the user to re-scan.
    case tokenRejected
    /// The desktop fingerprint did not match — a possible LAN spoof.
    case fingerprintMismatch
    /// The desktop did not answer in time.
    case timedOut
    /// The scanned QR string was not a valid pairing payload.
    case invalidQRCode(String)
    /// Any other failure (e.g. the connection could not be opened).
    case failed(String)

    /// A human-readable message for the outcome, or `nil` when there is nothing
    /// to show (idle / in-progress).
    var message: String? {
        switch self {
        case .idle, .pairing:
            return nil
        case .success:
            return "Paired! Your phone is connected to the desktop."
        case .tokenRejected:
            return "That pairing code was rejected or has expired. Generate a fresh code on the desktop and scan again."
        case .fingerprintMismatch:
            return "The desktop identity did not match the scanned code. Nothing was saved. Make sure you are scanning the code from your own desktop."
        case .timedOut:
            return "The desktop did not respond. Check that FocusFlow is open and both devices are on the same network, then try again."
        case .invalidQRCode(let detail):
            return "That QR code is not a FocusFlow pairing code. \(detail)"
        case .failed(let detail):
            return "Pairing could not be completed. \(detail)"
        }
    }

    /// Whether the outcome should invite the user to re-scan a fresh code.
    var suggestsReScan: Bool {
        switch self {
        case .tokenRejected, .timedOut, .invalidQRCode:
            return true
        default:
            return false
        }
    }
}

/// Drives the pairing screen: turns a scanned QR string (or manual host:port
/// entry) into a `PairFromQR` handshake and publishes the outcome.
///
/// View logic stays thin — this `ObservableObject` holds the testable glue so
/// the mapping from a scanned string / manual fields to a `PairingOutcome` can
/// be exercised without SwiftUI. It depends only on the injected
/// `PairingConnectionFactory` and `KeychainStoring`, matching `PairFromQR`, so a
/// test can drive a full success/failure path with in-memory doubles.
///
/// - Requirements: 3.2, 4.8, 8.3
@MainActor
final class PairingViewModel: ObservableObject {
    /// The current pairing outcome, observed by the view.
    @Published private(set) var outcome: PairingOutcome = .idle
    /// Whether the manual host:port fallback is currently shown.
    @Published var showManualEntry: Bool = false

    // Manual-entry fields (Requirement 4.8 / 8.3).
    @Published var manualHost: String = ""
    @Published var manualPort: String = ""
    // Manual-entry secrets, shown as additional fields alongside host:port when
    // the desktop cannot be discovered. Kept simple as plain published strings.
    @Published var manualDeviceId: String = ""
    @Published var manualPairingToken: String = ""
    @Published var manualFingerprint: String = ""

    private let pairer: PairFromQR

    /// - Parameters:
    ///   - connectionFactory: opens the transport to the desktop. Defaults to the
    ///     live `NetworkSyncClient`-backed factory on iOS; tests inject a double.
    ///   - keychain: secure store for the resulting session key. Defaults to the
    ///     `Security`-backed store on iOS.
    ///   - deviceInfo: identifies this phone to the desktop.
    init(
        connectionFactory: PairingConnectionFactory,
        keychain: KeychainStoring,
        deviceInfo: DeviceInfo
    ) {
        self.pairer = PairFromQR(
            connectionFactory: connectionFactory,
            keychain: keychain,
            deviceInfo: deviceInfo
        )
    }

    #if os(iOS)
    /// Convenience initializer using the live iOS transport and Keychain.
    convenience init() {
        self.init(
            connectionFactory: NetworkPairingConnectionFactory(),
            keychain: KeychainStore(),
            deviceInfo: DeviceInfo(name: UIDevice.current.name, platform: "ios")
        )
    }
    #endif

    /// Handle a raw string scanned from a QR code.
    ///
    /// Decodes it into a `PairingPayload`; on a decode failure the outcome is
    /// `.invalidQRCode` (prompting a re-scan) and no handshake runs.
    ///
    /// - Requirements: 3.2, 3.5
    func handleScannedCode(_ raw: String) async {
        let payload: PairingPayload
        do {
            payload = try PairingPayload.decode(fromQRString: raw)
        } catch {
            outcome = .invalidQRCode(String(describing: error))
            return
        }
        await pair(with: payload)
    }

    /// Attempt to pair using the manually entered host and port.
    ///
    /// Because the manual fallback carries no one-time token or fingerprint from
    /// a scanned code, this builds a `PairingPayload` from the entered address
    /// and the handshake proceeds over that direct connection (Requirement 4.8 /
    /// 8.3). Invalid input surfaces as `.invalidQRCode` describing the bad field.
    ///
    /// - Requirements: 4.8, 8.3
    func pairManually() async {
        let trimmedHost = manualHost.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedHost.isEmpty else {
            outcome = .invalidQRCode("Enter the desktop host address.")
            return
        }
        guard let port = Int(manualPort.trimmingCharacters(in: .whitespacesAndNewlines)),
              (1...65535).contains(port) else {
            outcome = .invalidQRCode("Enter a valid port between 1 and 65535.")
            return
        }

        // The manual path has no scanned token/fingerprint; the desktop's
        // pairing payload display provides them for the user to enter alongside
        // the address when discovery is blocked. We forward them verbatim so the
        // same `PairFromQR` handshake validates them server-side.
        let payload = PairingPayload(
            host: trimmedHost,
            port: port,
            deviceId: manualDeviceId,
            pairingToken: manualPairingToken,
            fingerprint: manualFingerprint
        )
        await pair(with: payload)
    }

    /// Reset back to the idle scanning state (e.g. after a re-scan prompt).
    func reset() {
        outcome = .idle
    }

    // MARK: - Handshake

    /// Runs the `PairFromQR` handshake and maps the result to a `PairingOutcome`.
    private func pair(with payload: PairingPayload) async {
        outcome = .pairing
        do {
            _ = try await pairer.pair(with: payload)
            outcome = .success
        } catch let error as PairingError {
            outcome = Self.map(error)
        } catch let error as PairingPayloadError {
            outcome = .invalidQRCode(error.description)
        } catch {
            outcome = .failed(String(describing: error))
        }
    }

    /// Maps a `PairingError` onto a user-facing outcome.
    ///
    /// - Requirements: 3.5, 3.6
    static func map(_ error: PairingError) -> PairingOutcome {
        switch error {
        case .tokenRejected:
            return .tokenRejected
        case .fingerprintMismatch:
            return .fingerprintMismatch
        case .timedOut:
            return .timedOut
        case .unexpectedReply(let type):
            return .failed("Unexpected reply from the desktop: \(type).")
        }
    }
}
