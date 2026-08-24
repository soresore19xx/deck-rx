#if os(iOS)
import UIKit

/// Phase 0 of the iPad front end: enough window to prove the receiver runs.
///
/// The whole point of this file is that there is nothing of the receiver in it.
/// Protocol, FFT, demodulators and the audio queue are the same sources the Mac
/// app compiles — this only drives them and shows what they report. Spectrum,
/// preset list and the options panel come next; they are ports of the AppKit
/// views, not new designs, and they do not belong in a first-light build.
///
/// No tuning gesture is invented here either. The Mac reads a Stream Deck dial
/// and the iPad has no dial, so the step buttons below are a placeholder for a
/// gesture that has to be designed rather than guessed at.
@main
final class IOSAppDelegate: UIResponder, UIApplicationDelegate {

    func application(_ app: UIApplication,
                     didFinishLaunchingWithOptions opts: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Copies the station databases out of the bundle on first run. Same
        // call the standalone Mac app makes; on iOS the bundle is the only
        // source, since there is no plugin next door to seed from.
        Receiver.seedData()
        return true
    }

    func application(_ app: UIApplication,
                     configurationForConnecting session: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let cfg = UISceneConfiguration(name: "Default", sessionRole: session.role)
        cfg.delegateClass = SceneDelegate.self
        return cfg
    }
}

/// The window is built from the scene, not from `UIScreen.main`.
///
/// The scene lifecycle is not optional the way it once was — an app linked
/// against a current SDK that still hands UIKit a screen-sized window is
/// working against the system rather than with it. It is also the only correct
/// answer on iPad, where the app can be one of several windows and Split View
/// gives it a size that has nothing to do with the screen's.
///
/// `@objc` fixes the runtime name, so the Info.plist can name the class without
/// depending on what the module ends up being called.
@objc(SceneDelegate)
final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession,
               options: UIScene.ConnectionOptions) {
        guard let ws = scene as? UIWindowScene else { return }
        let w = UIWindow(windowScene: ws)
        w.rootViewController = RadioViewController()
        w.overrideUserInterfaceStyle = .dark
        w.makeKeyAndVisible()
        window = w
    }
}

final class RadioViewController: UIViewController {

    private let radio = LocalRadio()

    private let hostField = UITextField()
    private let connectButton = UIButton(type: .system)
    private let statusLabel = UILabel()
    private let freqLabel = UILabel()
    private let unitLabel = UILabel()
    private let stationLabel = UILabel()
    private let modeControl = UISegmentedControl(items: MODE_NAMES)
    private let stepLabel = UILabel()
    private let volumeSlider = UISlider()
    private let muteButton = UIButton(type: .system)
    private var refreshTimer: Timer?

    /// The modes worth a segment on a receiver this size. RAW and DSB exist in
    /// the mode list but are not what anyone reaches for on an iPad, and eight
    /// segments across a phone-width layout are unreadable.
    private static let shownModes = [0, 1, 2, 4, 6, 5]  // NFM WFM AM USB LSB CW

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Pal.bg
        buildUI()

        radio.onState = { [weak self] in self?.refresh() }
        // The same 4 Hz the Mac window runs on. RSSI and SNR move with the
        // signal rather than with connection state, so onState alone leaves
        // the readout frozen at the -120 it starts life with.
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            self?.refresh()
        }
        // Audio is the reason the app is open. The Mac app has a switch for it
        // because it also serves a plugin that may want silence; here, a
        // receiver that has to be told to make sound is just a bug with a
        // control on it.
        radio.audioEnabled = true
        radio.mode = radio.config.mode
        refresh()

        // Same rule as the Mac window: honour autoDirect once there is
        // something on screen, so a refused connection lands in the status
        // line rather than happening before anything is drawn. autoAudio is
        // not consulted here — audio is already on, for the reason above.
        if radio.config.autoDirect { connectNow() }
    }

    // MARK: layout

    private func buildUI() {
        hostField.text = "\(radio.config.host):\(radio.config.port)"
        hostField.placeholder = "host:port"
        hostField.borderStyle = .roundedRect
        hostField.backgroundColor = Pal.sunken
        hostField.textColor = Pal.text
        hostField.font = .monospacedSystemFont(ofSize: 17, weight: .regular)
        hostField.autocapitalizationType = .none
        hostField.autocorrectionType = .no
        hostField.keyboardType = .URL
        hostField.clearButtonMode = .whileEditing

        connectButton.setTitle("Connect", for: .normal)
        connectButton.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
        connectButton.addTarget(self, action: #selector(toggleConnection), for: .touchUpInside)

        statusLabel.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        statusLabel.textColor = Pal.faint
        statusLabel.numberOfLines = 2

        // Monospaced digits, or every tune shifts the whole readout sideways.
        freqLabel.font = .monospacedDigitSystemFont(ofSize: 88, weight: .light)
        freqLabel.textColor = Pal.text
        freqLabel.adjustsFontSizeToFitWidth = true
        freqLabel.minimumScaleFactor = 0.4
        unitLabel.font = .monospacedSystemFont(ofSize: 22, weight: .regular)
        unitLabel.textColor = Pal.faint
        stationLabel.font = .systemFont(ofSize: 20)
        stationLabel.textColor = Pal.dim
        stationLabel.lineBreakMode = .byTruncatingTail

        modeControl.removeAllSegments()
        for (i, m) in Self.shownModes.enumerated() {
            modeControl.insertSegment(withTitle: MODE_NAMES[m], at: i, animated: false)
        }
        modeControl.selectedSegmentTintColor = Pal.rule
        modeControl.addTarget(self, action: #selector(modeChanged), for: .valueChanged)

        stepLabel.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        stepLabel.textColor = Pal.faint
        stepLabel.textAlignment = .center

        volumeSlider.minimumValue = 0
        volumeSlider.maximumValue = 1
        volumeSlider.value = Float(radio.volume)
        volumeSlider.minimumTrackTintColor = Pal.accent
        volumeSlider.addTarget(self, action: #selector(volumeChanged), for: .valueChanged)

        muteButton.setTitle("Mute", for: .normal)
        muteButton.addTarget(self, action: #selector(toggleMute), for: .touchUpInside)

        let freqRow = UIStackView(arrangedSubviews: [freqLabel, unitLabel])
        freqRow.alignment = .lastBaseline
        freqRow.spacing = 10

        let stack = UIStackView(arrangedSubviews: [
            row([hostField, connectButton]),
            statusLabel,
            stationLabel,
            freqRow,
            tuneRow(),
            stepLabel,
            modeControl,
            row([muteButton, volumeSlider]),
        ])
        stack.axis = .vertical
        stack.spacing = 18
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)

        // readableContentGuide rather than the safe area: a 12.9-inch iPad is
        // wide enough that a full-width row leaves the controls at opposite
        // ends of the glass.
        let g = view.readableContentGuide
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 24),
            stack.leadingAnchor.constraint(equalTo: g.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: g.trailingAnchor),
        ])
    }

    private func row(_ views: [UIView]) -> UIStackView {
        let s = UIStackView(arrangedSubviews: views)
        s.axis = .horizontal
        s.spacing = 12
        s.alignment = .center
        return s
    }

    /// Coarse and fine in one row. The multipliers ride on the mode's own tune
    /// step (`config.step(for:)`), so AM moves in 9 kHz and FM in 100 kHz
    /// without this row knowing anything about bands.
    private func tuneRow() -> UIStackView {
        let s = row([])
        s.distribution = .fillEqually
        for ticks in [-100, -10, -1, 1, 10, 100] {
            let b = UIButton(type: .system)
            b.setTitle(ticks > 0 ? "+\(ticks)" : "\(ticks)", for: .normal)
            b.titleLabel?.font = .monospacedDigitSystemFont(ofSize: 20, weight: .medium)
            b.backgroundColor = Pal.panel
            b.layer.cornerRadius = 10
            b.heightAnchor.constraint(equalToConstant: 56).isActive = true
            b.tag = ticks
            b.addTarget(self, action: #selector(tuneTapped(_:)), for: .touchUpInside)
            s.addArrangedSubview(b)
        }
        return s
    }

    // MARK: actions

    @objc private func toggleConnection() {
        guard !radio.isConnected else { radio.disconnect(); return }
        connectNow()
    }

    private func connectNow() {
        let parts = (hostField.text ?? "").split(separator: ":", maxSplits: 1)
        let host = parts.first.map(String.init) ?? radio.config.host
        let port = parts.count > 1 ? UInt16(parts[1]) : UInt16(clamping: radio.config.port)
        // Persisted before connecting, not after: a server that refuses the
        // connection is still the one to try again on the next launch, and
        // retyping an address after every failure is its own punishment.
        radio.config.host = host
        if let p = port { radio.config.port = Int(p) }
        radio.config.save()
        hostField.resignFirstResponder()
        radio.connect(host: host, port: port)
    }

    @objc private func tuneTapped(_ sender: UIButton) { radio.tune(ticks: sender.tag) }

    @objc private func modeChanged() {
        let i = modeControl.selectedSegmentIndex
        guard i >= 0, i < Self.shownModes.count else { return }
        radio.mode = Self.shownModes[i]
        radio.config.mode = radio.mode
        radio.config.save()
        refresh()
    }

    @objc private func volumeChanged() { radio.volume = Double(volumeSlider.value) }

    @objc private func toggleMute() {
        radio.muted.toggle()
        refresh()
    }

    // MARK: state

    private func refresh() {
        let (num, unit) = formatFreq(Double(radio.frequency))
        freqLabel.text = num
        unitLabel.text = unit
        // Same call the Mac window makes, region and all: the station database
        // is regional for FM, so a lookup without one names a Tokyo station on
        // an Osaka frequency.
        let region = StationLabel.Region(rawValue: radio.config.jpRegion) ?? .kanto
        stationLabel.text = StationLabel.lookup(freqHz: Double(radio.frequency), region: region) ?? " "
        stepLabel.text = "step \(formatStep(radio.tuneStepHz))"

        connectButton.setTitle(radio.isConnected ? "Disconnect" : "Connect", for: .normal)
        muteButton.setTitle(radio.muted ? "Unmute" : "Mute", for: .normal)
        muteButton.tintColor = radio.muted ? Pal.warn : Pal.blue

        if let err = radio.lastError, !radio.isConnected {
            statusLabel.textColor = Pal.warn
            statusLabel.text = err
        } else if radio.isConnected && !radio.canControl {
            // The server hands control to one client. Without saying so, the
            // tune buttons look broken rather than refused — setFrequency
            // deliberately drops the call instead of showing a frequency
            // nothing is receiving.
            statusLabel.textColor = Pal.warn
            statusLabel.text = "connected, but another client holds control of the receiver"
        } else if radio.isConnected {
            statusLabel.textColor = Pal.accent
            statusLabel.text = String(format: "connected  %@  RSSI %.0f dBFS  SNR %.0f dB",
                                      modeName(radio.mode), radio.rssiDbfs, radio.snrDb)
        } else {
            statusLabel.textColor = Pal.faint
            statusLabel.text = "not connected"
        }

        if let i = Self.shownModes.firstIndex(of: radio.mode) {
            modeControl.selectedSegmentIndex = i
        } else {
            modeControl.selectedSegmentIndex = UISegmentedControl.noSegment
        }
    }
}
#endif
