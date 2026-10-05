import SwiftUI

#if os(iOS) && canImport(AVFoundation)
import AVFoundation

/// A SwiftUI wrapper around an `AVCaptureSession` configured to read QR codes.
///
/// The pairing flow scans the desktop's QR code to learn where to connect and
/// how to authenticate (design Algorithm 3). This view owns a capture session
/// with an `AVCaptureMetadataOutput` restricted to the `.qr` object type and
/// reports the first decoded string back through `onScan`; the pairing view
/// model then decodes it into a `PairingPayload` and runs `PairFromQR`.
///
/// Camera usage requires the `NSCameraUsageDescription` key in the app's
/// Info.plist. If the camera is unavailable or permission is denied, `onError`
/// is called so the view can steer the user to the manual host:port fallback
/// (Requirement 4.8 / 8.3).
///
/// - Requirements: 3.2, 4.8
struct QRScannerView: UIViewControllerRepresentable {
    /// Called once with the decoded string when a QR code is first read.
    let onScan: (String) -> Void
    /// Called if the camera cannot be configured (no device, denied permission).
    let onError: (QRScannerError) -> Void

    func makeUIViewController(context: Context) -> QRScannerViewController {
        let controller = QRScannerViewController()
        controller.onScan = onScan
        controller.onError = onError
        return controller
    }

    func updateUIViewController(_ uiViewController: QRScannerViewController, context: Context) {}
}

/// Errors surfaced by the QR scanner so the view can fall back to manual entry.
enum QRScannerError: Error, CustomStringConvertible {
    case cameraUnavailable
    case permissionDenied
    case configurationFailed

    var description: String {
        switch self {
        case .cameraUnavailable:
            return "No camera is available on this device."
        case .permissionDenied:
            return "Camera access was denied. Enable it in Settings or enter the address manually."
        case .configurationFailed:
            return "The camera could not be started for scanning."
        }
    }
}

/// A `UIViewController` that runs an `AVCaptureSession` and reports the first
/// scanned QR string. Kept small; all pairing logic lives in the view model.
final class QRScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onScan: ((String) -> Void)?
    var onError: ((QRScannerError) -> Void)?

    private let session = AVCaptureSession()
    private var previewLayer: AVCaptureVideoPreviewLayer?
    /// Ensures `onScan` fires at most once per presented scanner.
    private var didScan = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        requestAccessAndConfigure()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        stopRunning()
    }

    private func requestAccessAndConfigure() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            configureSession()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                DispatchQueue.main.async {
                    if granted {
                        self?.configureSession()
                    } else {
                        self?.onError?(.permissionDenied)
                    }
                }
            }
        default:
            onError?(.permissionDenied)
        }
    }

    private func configureSession() {
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device) else {
            onError?(.cameraUnavailable)
            return
        }

        session.beginConfiguration()

        guard session.canAddInput(input) else {
            session.commitConfiguration()
            onError?(.configurationFailed)
            return
        }
        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else {
            session.commitConfiguration()
            onError?(.configurationFailed)
            return
        }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        session.commitConfiguration()

        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        preview.frame = view.bounds
        view.layer.addSublayer(preview)
        previewLayer = preview

        startRunning()
    }

    private func startRunning() {
        guard !session.isRunning else { return }
        // Starting the session blocks briefly, so keep it off the main thread.
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            self?.session.startRunning()
        }
    }

    private func stopRunning() {
        guard session.isRunning else { return }
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            self?.session.stopRunning()
        }
    }

    // MARK: AVCaptureMetadataOutputObjectsDelegate

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard !didScan,
              let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              object.type == .qr,
              let value = object.stringValue else {
            return
        }
        didScan = true
        stopRunning()
        onScan?(value)
    }
}

#endif
