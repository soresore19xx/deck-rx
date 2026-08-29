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
    /// The same views the Mac window draws. Not UIKit copies of them: a second
    /// spectrum would quietly stop agreeing with the first about what a signal
    /// looks like, the way a second demodulator would about what one sounds
    /// like. They are one file each, with the platform seams in Platform.swift.
    /// `var`, not `let`: a scale change rebuilds the layout, and a height or
    /// a width put on a view with `constraint(equalToConstant:)` belongs to
    /// that view — it survives being taken out of the hierarchy, so the only
    /// way not to stack a second set of constants on the first is a new view.
    private var spectrum = SpectrumView(frame: .zero)
    private var freqView = FreqView(frame: .zero)
    private var sMeter = SignalMeter(frame: .zero)
    private var nMeter = SignalMeter(frame: .zero)
    private var presetTable = UITableView(frame: .zero, style: .plain)
    private let addPresetButton = UIButton(type: .system)
    private let editPresetsButton = UIButton(type: .system)
    private var presets: [Receiver.Preset] = []
    private var displaySliders: [Int: UISlider] = [:]
    private var displaySaveTimer: Timer?
    private let zoomReadout = UILabel(), timeReadout = UILabel()
    private var ceilRail = VerticalSliderHost(caption: "MAX")
    private var floorRail = VerticalSliderHost(caption: "MIN")
    private let optionsButton = UIButton(type: .system)
    private let stationLabel = UILabel()
    private let modeControl = UISegmentedControl(items: MODE_NAMES)
    private let stepLabel = UILabel()
    private let muteButton = UIButton(type: .system)
    private var refreshTimer: Timer?
    /// The packet gap as it stood when the drop count last moved. A live gap
    /// says what the network is doing now; this says what it was doing at the
    /// moment the audio actually broke, which is the one that answers "was it
    /// the network or this end".
    private var lastDrops = 0
    private var gapAtDrop: Double = 0

    /// The modes worth a segment on a receiver this size. RAW and DSB exist in
    /// the mode list but are not what anyone reaches for on an iPad, and eight
    /// segments across a phone-width layout are unreadable.
    private static let shownModes = [0, 1, 2, 4, 6, 5]  // NFM WFM AM USB LSB CW

    override func viewDidLoad() {
        super.viewDidLoad()
        // Before anything is built: every constant and font size below is baked
        // in at construction, the way the Mac window bakes them (main.swift:1192).
        UI.scale = UI.from(radio.config.uiScale)
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
        // The receiver's own frames, straight into the display — the same wiring
        // the standalone Mac app uses.
        radio.onFrame = { [weak self] frame in
            DispatchQueue.main.async { self?.spectrum.accept(frame) }
        }
        rebuildMarkers()
        radio.audioEnabled = true
        // No slider here: the iPad's own volume buttons are the volume
        // control, so the app hands the mixer full scale and gets out of the
        // way. Two attenuators in series only cost headroom and confuse which
        // one is turned down.
        radio.volume = 1
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
        hostField.font = xMono(S(17))
        hostField.autocapitalizationType = .none
        hostField.autocorrectionType = .no
        hostField.keyboardType = .URL
        // Return connects and puts the keyboard away, which is the whole
        // reason the field is being typed into.
        optionsButton.setTitle("Options", for: .normal)
        optionsButton.titleLabel?.font = xMono(S(15), .medium)
        optionsButton.setContentHuggingPriority(.required, for: .horizontal)
        optionsButton.addTarget(self, action: #selector(showOptions), for: .touchUpInside)

        hostField.returnKeyType = .go
        hostField.addTarget(self, action: #selector(hostEntered), for: .editingDidEndOnExit)
        hostField.clearButtonMode = .whileEditing

        connectButton.setTitle("Connect", for: .normal)
        connectButton.titleLabel?.font = .systemFont(ofSize: S(17), weight: .semibold)
        connectButton.addTarget(self, action: #selector(toggleConnection), for: .touchUpInside)

        statusLabel.font = xMono(S(13))
        statusLabel.textColor = Pal.faint
        statusLabel.numberOfLines = 2

        // Monospaced digits, or every tune shifts the whole readout sideways.
        stationLabel.font = .systemFont(ofSize: S(20))
        stationLabel.textColor = Pal.dim
        stationLabel.lineBreakMode = .byTruncatingTail

        modeControl.removeAllSegments()
        for (i, m) in Self.shownModes.enumerated() {
            modeControl.insertSegment(withTitle: MODE_NAMES[m], at: i, animated: false)
        }
        modeControl.selectedSegmentTintColor = Pal.rule
        modeControl.addTarget(self, action: #selector(modeChanged), for: .valueChanged)

        stepLabel.font = xMono(S(13))
        stepLabel.textColor = Pal.faint
        stepLabel.textAlignment = .center

        muteButton.setTitle("Mute", for: .normal)
        muteButton.addTarget(self, action: #selector(toggleMute), for: .touchUpInside)

        freqView.onTune = { [weak self] hz in
            guard let self else { return }
            self.radio.setFrequency(UInt32(max(0, hz)))
            self.refresh()
        }
        freqView.translatesAutoresizingMaskIntoConstraints = false
        // The digit size comes from the height, and the width follows from it.
        // At 84 the readout ran most of the way across a landscape column and
        // left the meters beside it looking like an afterthought; the iPad is
        // held landscape, so the header has to share the width rather than let
        // one thing take it.
        freqView.heightAnchor.constraint(equalToConstant: S(62)).isActive = true
        freqView.setContentHuggingPriority(.required, for: .horizontal)
        freqView.setContentCompressionResistancePriority(.required, for: .horizontal)

        spectrum.translatesAutoresizingMaskIntoConstraints = false
        // The same scale the Mac reads it on, so a signal that looks strong on
        // one looks strong on the other.
        spectrum.dbFloor = Float(radio.config.spectrumDbFloor)
        spectrum.dbCeil = Float(radio.config.spectrumDbCeil)
        spectrum.zoom = radio.config.spectrumZoom
        spectrum.wfTargetSeconds = radio.config.waterfallSeconds
        spectrum.spectrumFraction = CGFloat(radio.config.spectrumSplit)
        spectrum.idleCenterHz = radio.config.frequencyHz
        spectrum.idleSpanHz = radio.config.spectrumSpanHz
        spectrum.onSplitChanged = { [weak self] f in
            guard let self else { return }
            self.radio.config.spectrumSplit = Double(f)
            self.radio.config.save()
        }
        // Drag the rail between trace and waterfall, as on the Mac. A pan
        // recogniser rather than the view's own mouse handling: a touch has no
        // hover and no cursor, so the view leaves the gesture to whoever owns
        // the screen it is on.
        let split = UIPanGestureRecognizer(target: self, action: #selector(splitDragged(_:)))
        spectrum.addGestureRecognizer(split)
        spectrum.addGestureRecognizer(UITapGestureRecognizer(target: self,
                                                             action: #selector(spectrumTapped(_:))))
        // Touch-down, so a tap can be aimed before it is taken. It watches the
        // same touch the other two do, which needs the delegate below.
        let press = UILongPressGestureRecognizer(target: self, action: #selector(spectrumTouched(_:)))
        press.minimumPressDuration = 0
        press.delegate = self
        spectrum.addGestureRecognizer(press)

        for (m, tint) in [(sMeter, Pal.accent), (nMeter, Pal.blue)] {
            m.tint = tint
            m.translatesAutoresizingMaskIntoConstraints = false
            m.heightAnchor.constraint(equalToConstant: S(30)).isActive = true
            // A definite width, as the Mac window gives them. Left to take
            // whatever the station name does not, the meters were re-measured
            // on every refresh and their scale moved under the reading.
            let wide = m.widthAnchor.constraint(equalToConstant: S(360))
            wide.priority = .defaultHigh
            wide.isActive = true
            m.widthAnchor.constraint(greaterThanOrEqualToConstant: S(160)).isActive = true
        }
        // The name is what gives way when the header is tight, not the meters
        // and not the readout.
        stationLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        stationLabel.setContentHuggingPriority(.defaultLow, for: .horizontal)
        sMeter.ticks = [(0, "-100"), (2.0 / 9, "-80"), (4.0 / 9, "-60"),
                        (6.0 / 9, "-40"), (8.0 / 9, "-20")]
        nMeter.ticks = [(0, "0"), (0.25, "15"), (0.5, "30"), (0.75, "45"), (1, "60")]

        presetTable.translatesAutoresizingMaskIntoConstraints = false
        presetTable.dataSource = self
        presetTable.delegate = self
        presetTable.addGestureRecognizer(
            UILongPressGestureRecognizer(target: self, action: #selector(presetLongPressed(_:))))
        presetTable.backgroundColor = Pal.panel
        presetTable.separatorStyle = .none
        // A fallback only; heightForRowAt gives the two kinds of row their own.
        presetTable.rowHeight = S(28)
        presetTable.register(UITableViewCell.self, forCellReuseIdentifier: "p")
        presets = Receiver.presets()

        addPresetButton.setTitle("+ Add", for: .normal)
        addPresetButton.titleLabel?.font = xMono(S(15), .medium)
        addPresetButton.addTarget(self, action: #selector(addCurrentAsPreset), for: .touchUpInside)
        editPresetsButton.setTitle("Edit", for: .normal)
        editPresetsButton.titleLabel?.font = xMono(S(15))
        editPresetsButton.addTarget(self, action: #selector(togglePresetEditing), for: .touchUpInside)

        // Left column: what to listen to. Right column: what is being heard.
        // The iPad is landscape most of the time it is a receiver, and a single
        // scrolling column would put the spectrum below the fold.
        // Header as a row, the way the Mac window has it: what is tuned on the
        // left, how well it is coming in on the right. Stacked, the readout and
        // the two meters ate a third of a landscape screen between them.
        let tuned = UIStackView(arrangedSubviews: [stationLabel, freqView])
        tuned.axis = .vertical
        tuned.alignment = .leading
        tuned.spacing = S(2)
        let meters = UIStackView(arrangedSubviews: [
            row([sLabel("S"), sMeter]),
            row([sLabel("N"), nMeter]),
        ])
        meters.axis = .vertical
        meters.spacing = S(6)
        let header = UIStackView(arrangedSubviews: [tuned, meters])
        header.axis = .horizontal
        header.alignment = .center
        header.spacing = S(20)
        tuned.setContentHuggingPriority(.required, for: .horizontal)

        // MAX above MIN beside the trace, because that is how the dB scale down
        // its left runs. Horizontal, the pair moved against the numbers they
        // set — the same reason the Mac window puts them on a vertical rail.
        for (h, tag) in [(ceilRail, 2), (floorRail, 3)] {
            h.translatesAutoresizingMaskIntoConstraints = false
            h.widthAnchor.constraint(equalToConstant: S(52)).isActive = true
            h.slider.tag = tag
            h.slider.isContinuous = true
            h.slider.addTarget(self, action: #selector(displayChanged(_:)), for: .valueChanged)
            displaySliders[tag] = h.slider
        }
        ceilRail.slider.minimumValue = -60;  ceilRail.slider.maximumValue = 0
        ceilRail.slider.value = Float(radio.config.spectrumDbCeil)
        floorRail.slider.minimumValue = -160; floorRail.slider.maximumValue = -60
        floorRail.slider.value = Float(radio.config.spectrumDbFloor)
        let rail = UIStackView(arrangedSubviews: [ceilRail, floorRail])
        rail.axis = .vertical
        rail.distribution = .fillEqually
        rail.spacing = S(4)
        let plot = UIStackView(arrangedSubviews: [spectrum, rail])
        plot.axis = .horizontal
        plot.spacing = S(6)

        let right = UIStackView(arrangedSubviews: [
            header,
            plot,
            displayRow(),
            bandRow(),
            tuneRow(),
            modeControl,
            muteButton,
            row([hostField, connectButton, optionsButton]),
            statusLabel,
            stepLabel,
        ])
        right.axis = .vertical
        right.spacing = S(10)
        right.translatesAutoresizingMaskIntoConstraints = false
        // The spectrum takes what the rest of the column leaves.
        spectrum.setContentHuggingPriority(.init(1), for: .vertical)
        spectrum.setContentCompressionResistancePriority(.init(200), for: .vertical)
        spectrum.heightAnchor.constraint(greaterThanOrEqualToConstant: S(220)).isActive = true

        let presetTitle = UILabel()
        presetTitle.text = "PRESET"
        presetTitle.font = xMono(S(15), .bold)
        presetTitle.textColor = Pal.faint
        presetTitle.setContentHuggingPriority(.required, for: .horizontal)
        // In the bar rather than on a line of its own: a heading that cost a
        // row's height would undo the tightening below it.
        let presetBar = row([presetTitle, UIView(), addPresetButton, editPresetsButton])
        presetBar.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(presetBar)
        view.addSubview(presetTable)
        view.addSubview(right)
        let g = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            presetBar.topAnchor.constraint(equalTo: g.topAnchor, constant: S(4)),
            presetBar.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: S(8)),
            presetBar.widthAnchor.constraint(equalToConstant: S(284)),
            presetTable.topAnchor.constraint(equalTo: presetBar.bottomAnchor, constant: S(4)),
            presetTable.leadingAnchor.constraint(equalTo: g.leadingAnchor),
            presetTable.bottomAnchor.constraint(equalTo: g.bottomAnchor),
            presetTable.widthAnchor.constraint(equalToConstant: S(300)),

            right.topAnchor.constraint(equalTo: g.topAnchor, constant: S(8)),
            right.leadingAnchor.constraint(equalTo: presetTable.trailingAnchor, constant: S(14)),
            right.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -S(14)),
        ])
        // Two bottoms: normally the safe area, but never under the keyboard.
        // The host field is the last row of the column, so typing an address
        // put the keyboard straight over the characters being typed. The
        // spectrum has the loosest hugging in the column, so it is what gives
        // up the height while the keyboard is there, and takes it back after.
        let restBottom = right.bottomAnchor.constraint(equalTo: g.bottomAnchor, constant: -8)
        restBottom.priority = .defaultHigh
        restBottom.isActive = true
        right.bottomAnchor.constraint(lessThanOrEqualTo: view.keyboardLayoutGuide.topAnchor,
                                      constant: -8).isActive = true
    }

    /// A one-letter caption in the meter's own rhythm.
    private func sLabel(_ t: String) -> UILabel {
        let l = UILabel()
        l.text = t
        l.font = xMono(S(15), .regular)
        l.textColor = Pal.faint
        l.setContentHuggingPriority(.required, for: .horizontal)
        return l
    }

    /// One gesture, two jobs, decided by where the finger lands. The rail
    /// between the trace and the waterfall is a handle; everywhere else is the
    /// band, and dragging it carries the band sideways.
    @objc private func splitDragged(_ g: UIPanGestureRecognizer) {
        let p = g.location(in: spectrum)
        let usable = spectrum.bounds.height - 24
        guard usable > 0 else { return }
        if g.state == .began {
            let specH = ((spectrum.bounds.height - 24) * spectrum.spectrumFraction).rounded()
            draggingSplit = abs(p.y - (specH + 12)) < 26
            panning = !draggingSplit
            panFromHz = Double(radio.deviceCenterHz)
            lastPanRetune = .distantPast
            // The aim mark belongs to a tap, and this has stopped being one.
            clearAim()
        }
        if panning {
            pan(g)
            return
        }
        guard draggingSplit else { return }
        spectrum.spectrumFraction = (p.y - 12) / usable
        if g.state == .ended || g.state == .cancelled {
            draggingSplit = false
            radio.config.spectrumSplit = Double(spectrum.spectrumFraction)
            radio.config.save()
        }
    }
    private var draggingSplit = false
    private var panning = false

    /// The frequency under a point, as one the receiver could actually be on.
    ///
    /// Snapped to the band's own raster — the same `config.step(for:)` the tune
    /// buttons ride, so the spectrum lands where +1 would. Unzoomed, an Airspy
    /// HF+ window is 456 kHz across perhaps 900 points: a pixel is half a
    /// kilohertz, no finger is worth better than three of them, and a broadcast
    /// band has nothing between its channels anyway. Without the snap, tuning
    /// by touch could not reach 954 kHz at all.
    private func aimFreq(atX x: CGFloat) -> Double? {
        guard let hz = spectrum.frequency(atX: x) else { return nil }
        return snapToStep(hz, step: radio.tuneStepHz)
    }

    /// Drag the band sideways.
    ///
    /// Nothing is sent while the finger is down: the view slides and the
    /// receiver stays where it is, and one retune goes out on release. A pan is
    /// a device retune by definition — it moves the window itself, which is the
    /// one thing tuning inside the window cannot do — so it costs a round trip
    /// and a restarted trace, and doing that per touch event would spend the
    /// gesture catching up.
    private func pan(_ g: UIPanGestureRecognizer) {
        let w = spectrum.plotWidth, span = spectrum.visibleSpanHz
        guard w > 0, span > 0, panFromHz > 0 else { return }
        // The finger carries the band with it: dragging right brings lower
        // frequencies into view, so the window moves down by what the drag
        // covered. Absolute rather than incremental, so the view stays glued to
        // the finger no matter how the receiver is doing at keeping up.
        let target = max(0, panFromHz - Double(g.translation(in: spectrum).x / w) * span)
        spectrum.viewCenterHz = target
        switch g.state {
        case .ended:
            panning = false
            radio.setDeviceCenter(target)
            // Held at where the receiver was actually left — a centre it
            // clamped is still the one the view has to settle on. The view
            // clears it once a frame arrives from there.
            spectrum.viewCenterHz = Double(radio.deviceCenterHz)
            refresh()
        case .cancelled, .failed:
            panning = false
            spectrum.viewCenterHz = 0
        default:
            // The hardware follows too, or the band being dragged into stays
            // blank until the finger lifts and the drag is a picture of
            // nothing. Not per touch event, though: every one of these is a
            // round trip, a demodulator reset and a restarted transform.
            guard Date().timeIntervalSince(lastPanRetune) > 0.15 else { return }
            lastPanRetune = Date()
            radio.setDeviceCenter(target, persist: false)
        }
    }
    /// Where the window was when the finger went down, and when the receiver
    /// was last asked to follow it.
    private var panFromHz: Double = 0
    private var lastPanRetune = Date.distantPast

    /// Where a tap would land, marked from the moment the finger touches down.
    ///
    /// A tap is over before anything could be drawn for it, so the mark comes
    /// from the touch rather than from the tap recogniser — a press with no
    /// minimum duration, recognised alongside the other two. Moving turns the
    /// gesture into a pan and the mark goes away with it.
    @objc private func spectrumTouched(_ g: UILongPressGestureRecognizer) {
        switch g.state {
        case .began, .changed:
            guard !panning, !draggingSplit,
                  let hz = aimFreq(atX: g.location(in: spectrum).x) else { clearAim(); return }
            // Only when the channel under the finger actually changes. The snap
            // means most touch events land on the one before, and a station
            // lookup at touch rate is work nobody asked for.
            guard spectrum.aimHz != hz else { return }
            spectrum.aimHz = hz
            showFreq(hz)
        default:
            clearAim()
        }
    }

    private func clearAim() {
        guard spectrum.aimHz != nil else { return }
        spectrum.aimHz = nil
        refresh()
    }

    /// The readout alone. The meters and the status line describe the signal
    /// coming in, which is still the old one until the finger lifts.
    private func showFreq(_ hz: Double) {
        freqView.set(freqHz: hz)
        let region = StationLabel.Region(rawValue: radio.config.jpRegion) ?? .kanto
        setText(stationLabel, StationLabel.lookup(freqHz: hz, region: region) ?? " ")
    }

    private func tuneTo(_ hz: Double) {
        radio.setFrequency(UInt32(max(0, hz.rounded())))
        refresh()
    }

    /// Tapping without moving is still a tune: a pan recogniser reports began
    /// and ended with no change in between, and the frequency under the finger
    /// is the one that was asked for.
    @objc private func spectrumTapped(_ g: UITapGestureRecognizer) {
        guard let hz = aimFreq(atX: g.location(in: spectrum).x) else { return }
        clearAim()
        tuneTo(hz)
    }

    /// The bands worth a button, from the same table the Mac uses. Landing on
    /// a station inside the band beats landing on its edge, so a preset in
    /// range wins — the same rule as Receiver.jump, done locally because there
    /// is no control endpoint here to ask.
    private func bandRow() -> UIStackView {
        let s = row([])
        s.distribution = .fillEqually
        for (i, b) in Receiver.bands.enumerated() {
            let btn = UIButton(type: .system)
            btn.setTitle(b.name, for: .normal)
            btn.titleLabel?.font = xMono(S(15), .medium)
            btn.backgroundColor = Pal.panel
            btn.layer.cornerRadius = 8
            btn.heightAnchor.constraint(equalToConstant: S(40)).isActive = true
            btn.tag = i
            btn.addTarget(self, action: #selector(bandTapped(_:)), for: .touchUpInside)
            s.addArrangedSubview(btn)
        }
        return s
    }

    @objc private func bandTapped(_ sender: UIButton) {
        let b = Receiver.bands[sender.tag]
        let target = presets.first { $0.freq >= b.lo && $0.freq <= b.hi }
        radio.mode = target?.mode ?? b.mode
        radio.config.mode = radio.mode
        radio.setFrequency(UInt32(target?.freq ?? b.lo))
        radio.config.frequencyHz = Double(radio.frequency)
        radio.config.save()
        refresh()
    }

    /// Zoom, the dB window and the waterfall depth — the rail down the right of
    /// the Mac window. Horizontal here: the iPad has width to spare and no
    /// height to give a vertical rail.
    private func displayRow() -> UIStackView {
        func slide(_ caption: String, _ lo: Float, _ hi: Float, _ v: Float,
                   _ tag: Int, _ readout: UILabel) -> UIStackView {
            let s = UISlider()
            s.minimumValue = lo; s.maximumValue = hi; s.value = v
            s.tag = tag
            s.isContinuous = true
            // A slider has no width of its own. Left to a stack that sizes by
            // intrinsic content it collapses to nothing and the caption and
            // readout close up around it — which is what put four captions and
            // four thumbs in a heap across the band buttons.
            s.setContentHuggingPriority(.init(1), for: .horizontal)
            s.setContentCompressionResistancePriority(.init(200), for: .horizontal)
            s.addTarget(self, action: #selector(displayChanged(_:)), for: .valueChanged)
            displaySliders[tag] = s
            let c = UILabel()
            c.text = caption; c.font = xMono(S(11)); c.textColor = Pal.faint
            c.setContentHuggingPriority(.required, for: .horizontal)
            readout.font = xMono(S(11)); readout.textColor = Pal.dim
            readout.setContentHuggingPriority(.required, for: .horizontal)
            let r = row([c, s, readout])
            r.spacing = S(6)
            return r
        }
        let c = radio.config
        let top = row([
            slide("ZOOM", 0, 5, Float(max(0, min(5, log2(c.spectrumZoom)))), 0, zoomReadout),
            slide("TIME", Float(log(5.0)), Float(log(600.0)),
                  Float(log(max(5, min(600, c.waterfallSeconds)))), 1, timeReadout),
        ])
        // Half the width each, rather than whatever their contents ask for.
        top.distribution = .fillEqually
        syncDisplayReadouts()
        return top
    }

    @objc private func displayChanged(_ sender: UISlider) {
        switch sender.tag {
        case 0: spectrum.zoom = pow(2, Double(sender.value))
        case 1: spectrum.wfTargetSeconds = exp(Double(sender.value))
        case 2: spectrum.dbCeil = Float(max(Double(sender.value), Double(spectrum.dbFloor) + 10))
        default: spectrum.dbFloor = Float(min(Double(sender.value), Double(spectrum.dbCeil) - 10))
        }
        syncDisplayReadouts()
        // A beat after the last move, not on every one: the sliders are
        // continuous so the trace follows the drag.
        displaySaveTimer?.invalidate()
        displaySaveTimer = Timer.scheduledTimer(withTimeInterval: 0.6, repeats: false) { [weak self] _ in
            guard let self else { return }
            self.radio.config.spectrumZoom = self.spectrum.zoom
            self.radio.config.waterfallSeconds = self.spectrum.wfTargetSeconds
            self.radio.config.spectrumDbCeil = Double(self.spectrum.dbCeil)
            self.radio.config.spectrumDbFloor = Double(self.spectrum.dbFloor)
            self.radio.config.save()
        }
    }

    private func syncDisplayReadouts() {
        zoomReadout.text = String(format: "%.0f×", spectrum.zoom)
        let secs = spectrum.wfTargetSeconds
        timeReadout.text = secs < 60 ? String(format: "%.0fs", secs)
                                     : String(format: "%.0fm", secs / 60)
        ceilRail.setReadout(String(format: "%.0f", spectrum.dbCeil))
        floorRail.setReadout(String(format: "%.0f", spectrum.dbFloor))
    }

    private func row(_ views: [UIView]) -> UIStackView {
        let s = UIStackView(arrangedSubviews: views)
        s.axis = .horizontal
        s.spacing = S(12)
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
            b.titleLabel?.font = .monospacedDigitSystemFont(ofSize: S(20), weight: .medium)
            b.backgroundColor = Pal.panel
            b.layer.cornerRadius = 10
            b.heightAnchor.constraint(equalToConstant: S(56)).isActive = true
            b.tag = ticks
            b.addTarget(self, action: #selector(tuneTapped(_:)), for: .touchUpInside)
            s.addArrangedSubview(b)
        }
        return s
    }

    // MARK: actions

    @objc private func hostEntered() { connectNow() }

    /// The demod's settings, in a sheet rather than a permanent column. The
    /// Mac has the width to keep them on screen; an iPad held in landscape has
    /// the width spent on the spectrum, and these are set once and left.
    /// The names written along the spectrum. Rebuilt rather than set once: the
    /// FM database is regional, so changing JP region in the options has to
    /// re-label the trace as well as the readout.
    private func rebuildMarkers() {
        let region = StationLabel.Region(rawValue: radio.config.jpRegion) ?? .kanto
        spectrum.markers = Receiver.presets().map {
            ($0.freq, StationLabel.lookup(freqHz: $0.freq, region: region) ?? $0.name)
        }
    }

    /// Swaps in a freshly built layout at the scale the options sheet just
    /// picked, and does nothing at all when it did not move. The Mac window
    /// answers a scale change the same way and for the same reason
    /// (main.swift's `rebuildForScale`): a relaunch is a poor answer to a
    /// three-way picker.
    ///
    /// The waterfall's history does not survive — it is a bitmap sized to the
    /// old panel, and there is no honest way to rescale one. Everything else is
    /// read back from the receiver on the next tick.
    private func rebuildForScale() {
        let wanted = UI.from(radio.config.uiScale)
        guard wanted != UI.scale else { return }
        UI.scale = wanted
        view.subviews.forEach { $0.removeFromSuperview() }
        displaySliders.removeAll()
        spectrum = SpectrumView(frame: .zero)
        freqView = FreqView(frame: .zero)
        sMeter = SignalMeter(frame: .zero)
        nMeter = SignalMeter(frame: .zero)
        presetTable = UITableView(frame: .zero, style: .plain)
        ceilRail = VerticalSliderHost(caption: "MAX")
        floorRail = VerticalSliderHost(caption: "MIN")
        buildUI()
        rebuildMarkers()
    }

    @objc private func showOptions() {
        let vc = OptionsViewController(radio: radio) { [weak self] in
            self?.rebuildForScale()
            self?.rebuildMarkers()
            self?.refresh()
        }
        let nav = UINavigationController(rootViewController: vc)
        nav.modalPresentationStyle = .formSheet
        present(nav, animated: true)
    }

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

    @objc private func toggleMute() {
        radio.muted.toggle()
        refresh()
    }

    // MARK: presets

    /// Grouped by band the way the Mac list is, with the heading as its own
    /// row: a UITableView section header floats over the rows while scrolling,
    /// which on a list this short reads as a label that will not sit still.
    private enum PresetItem { case head(String), station(Receiver.Preset) }
    private var items: [PresetItem] {
        var out: [PresetItem] = []
        var band = ""
        for p in presets {
            let b = Receiver.bandName(ofHz: p.freq)
            if b != band { band = b; out.append(.head(b)) }
            out.append(.station(p))
        }
        return out
    }

    // MARK: state

    private func refresh() {
        // The pending frequency while a finger is on the spectrum; the
        // receiver's own the rest of the time.
        // The mark under a resting finger, so the digits and the station name
        // say where a tap would go; the receiver's own frequency otherwise.
        let shownHz = spectrum.aimHz ?? Double(radio.frequency)
        freqView.set(freqHz: shownHz)
        // Same call the Mac window makes, region and all: the station database
        // is regional for FM, so a lookup without one names a Tokyo station on
        // an Osaka frequency.
        let region = StationLabel.Region(rawValue: radio.config.jpRegion) ?? .kanto
        // Written only when it changes. Assigning a label's text invalidates
        // its intrinsic size even when the string is identical, and at the
        // 4 Hz this runs at that re-laid out the header continuously: the
        // meters and the readout were measured again between every pair of
        // frames, so their contents appeared to shift on each bar update.
        setText(stationLabel, StationLabel.lookup(freqHz: shownHz, region: region) ?? " ")
        setText(stepLabel, "step \(formatStep(radio.tuneStepHz))")
        // The same mapping the Mac window uses, so a reading means the same
        // thing on both: -100..-10 dBFS, and 0..60 dB of signal to noise.
        let live = radio.isConnected
        sMeter.value = live ? max(0, min(1, (radio.rssiDbfs + 100) / 90)) : 0
        nMeter.value = live ? max(0, min(1, radio.snrDb / 60)) : 0
        spectrum.bandwidthHz = radio.config.bandwidth(for: radio.mode)
        // The window is drawn around the device; the marker sits where the
        // demodulator is, which is not the same place once it moves inside it.
        spectrum.idleCenterHz = Double(radio.deviceCenterHz)
        spectrum.vfoHz = Double(radio.frequency)
        if radio.iqRate > 0 { spectrum.idleSpanHz = Double(radio.iqRate) }

        setTitle(connectButton, radio.isConnected ? "Disconnect" : "Connect")
        setTitle(muteButton, radio.muted ? "Unmute" : "Mute")
        muteButton.tintColor = radio.muted ? Pal.warn : Pal.blue

        if let err = radio.lastError, !radio.isConnected {
            statusLabel.textColor = Pal.warn
            setText(statusLabel, err)
        } else if radio.isConnected && !radio.canControl {
            // The server hands control to one client. Without saying so, the
            // tune buttons look broken rather than refused — setFrequency
            // deliberately drops the call instead of showing a frequency
            // nothing is receiving.
            statusLabel.textColor = Pal.warn
            setText(statusLabel, "connected, but another client holds control of the receiver")
        } else if radio.isConnected {
            statusLabel.textColor = Pal.accent
            // The drop count is the difference between "the producer cannot
            // keep up" and "the output stopped asking": one climbs while the
            // audio breaks up, the other stays flat. Without it, choppy audio
            // is a description rather than a measurement.
            // Drops alone cannot say why. The packet gap beside them can: a
            // large gap means the IQ was late (network or server), a small one
            // with drops climbing means it arrived and this end fell behind.
            let drops = radio.audioUnderruns
            if drops > lastDrops {
                gapAtDrop = radio.maxPacketGapMs
                lastDrops = drops
            }
            let tail = drops > 0
                ? String(format: "  drops %d (gap was %.0fms)  gap %.0fms",
                         drops, gapAtDrop, radio.maxPacketGapMs)
                : String(format: "  gap %.0fms", radio.maxPacketGapMs)
            setText(statusLabel, String(format: "connected  %@  RSSI %.0f dBFS  SNR %.0f dB  %.0f kHz audio%@",
                                      modeName(radio.mode), radio.rssiDbfs, radio.snrDb,
                                      radio.audioRate / 1000, tail))
        } else {
            statusLabel.textColor = Pal.faint
            setText(statusLabel, "not connected")
        }

        if let i = Self.shownModes.firstIndex(of: radio.mode) {
            modeControl.selectedSegmentIndex = i
        } else {
            modeControl.selectedSegmentIndex = UISegmentedControl.noSegment
        }
        presetTable.visibleCells.forEach { markCell($0) }
    }

    /// Add what is tuned. The name comes from the station database when it
    /// knows the frequency, so the common case needs no typing at all.
    @objc private func addCurrentAsPreset() {
        let region = StationLabel.Region(rawValue: radio.config.jpRegion) ?? .kanto
        let name = StationLabel.lookup(freqHz: Double(radio.frequency), region: region)
            ?? String(format: "%.0f kHz", Double(radio.frequency) / 1000)
        try? PresetStore.add(name: name, frequency: Double(radio.frequency),
                             mode: radio.mode, bandwidth: radio.config.bandwidth(for: radio.mode))
        reloadPresets()
    }

    @objc private func togglePresetEditing() {
        presetTable.setEditing(!presetTable.isEditing, animated: true)
        setTitle(editPresetsButton, presetTable.isEditing ? "Done" : "Edit")
    }

    private func reloadPresets() {
        presets = Receiver.presets()
        presetTable.reloadData()
        rebuildMarkers()
    }

    /// Name, frequency and mode, in a sheet. Reached by a long press on a row,
    /// which leaves a plain tap meaning what it always meant: tune to this.
    @objc private func presetLongPressed(_ g: UILongPressGestureRecognizer) {
        guard g.state == .began,
              let ip = presetTable.indexPathForRow(at: g.location(in: presetTable)),
              case .station(let p) = items[ip.row] else { return }
        let a = UIAlertController(title: "Edit preset", message: nil, preferredStyle: .alert)
        a.addTextField { $0.text = p.name }
        a.addTextField {
            $0.text = String(format: "%.0f", p.freq / 1000)
            $0.keyboardType = .decimalPad
            $0.placeholder = "kHz"
        }
        a.addTextField {
            $0.text = p.mode < MODE_NAMES.count ? MODE_NAMES[p.mode] : "WFM"
            $0.placeholder = MODE_NAMES.joined(separator: " / ")
        }
        a.addAction(UIAlertAction(title: "Save", style: .default) { [weak self] _ in
            guard let self else { return }
            let name = a.textFields?[0].text?.trimmingCharacters(in: .whitespaces) ?? p.name
            let khz = Double(a.textFields?[1].text ?? "") ?? (p.freq / 1000)
            let modeText = (a.textFields?[2].text ?? "").uppercased()
            let mode = MODE_NAMES.firstIndex(of: modeText) ?? p.mode
            try? PresetStore.update(oldName: p.name, name: name.isEmpty ? p.name : name,
                                    frequency: khz * 1000, mode: mode,
                                    bandwidth: self.radio.config.bandwidth(for: mode))
            self.reloadPresets()
        })
        a.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        present(a, animated: true)
    }

    /// Assign only on a change. See the note in `refresh()`.
    private func setText(_ l: UILabel, _ t: String) {
        if l.text != t { l.text = t }
    }
    private func setTitle(_ b: UIButton, _ t: String) {
        if b.title(for: .normal) != t { b.setTitle(t, for: .normal) }
    }

    /// The row the receiver is actually on, by frequency: it may have been
    /// moved by the readout or a tune button rather than by picking a preset.
    private func markCell(_ cell: UITableViewCell) {
        guard let ip = presetTable.indexPath(for: cell),
              case .station(let p) = items[ip.row] else { return }
        let on = abs(p.freq - Double(radio.frequency)) < 1
        cell.contentView.backgroundColor = on
            ? Pal.accent.withAlphaComponent(0.18)
            : (ip.row % 2 == 1 ? Pal.band.withAlphaComponent(0.35) : .clear)
    }
}

extension RadioViewController: UIGestureRecognizerDelegate {
    /// The aim mark watches the same touch the pan and the tap do rather than
    /// competing with them for it.
    func gestureRecognizer(_ g: UIGestureRecognizer,
                           shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        true
    }
}

extension RadioViewController: UITableViewDataSource, UITableViewDelegate {
    func tableView(_ t: UITableView, numberOfRowsInSection s: Int) -> Int { items.count }

    func tableView(_ t: UITableView, cellForRowAt ip: IndexPath) -> UITableViewCell {
        let cell = t.dequeueReusableCell(withIdentifier: "p", for: ip)
        cell.backgroundColor = .clear
        cell.contentView.subviews.forEach { $0.removeFromSuperview() }
        switch items[ip.row] {
        case .head(let band):
            let l = UILabel()
            l.text = band
            l.font = xMono(S(19), .bold)
            l.textColor = Self.bandColor(band)
            l.translatesAutoresizingMaskIntoConstraints = false
            let rule = UIView()
            rule.backgroundColor = Self.bandColor(band).withAlphaComponent(0.55)
            rule.translatesAutoresizingMaskIntoConstraints = false
            cell.contentView.addSubview(rule); cell.contentView.addSubview(l)
            NSLayoutConstraint.activate([
                rule.leadingAnchor.constraint(equalTo: cell.contentView.leadingAnchor),
                rule.trailingAnchor.constraint(equalTo: cell.contentView.trailingAnchor),
                rule.topAnchor.constraint(equalTo: cell.contentView.topAnchor, constant: 4),
                rule.heightAnchor.constraint(equalToConstant: 2),
                l.leadingAnchor.constraint(equalTo: cell.contentView.leadingAnchor, constant: S(8)),
                l.topAnchor.constraint(equalTo: rule.bottomAnchor, constant: 2),
            ])
            cell.contentView.backgroundColor = .clear
            cell.selectionStyle = .none
        case .station(let p):
            let (num, unit) = formatFreq(p.freq)
            let f = UILabel(); f.text = num; f.font = xMono(S(17), .light); f.textColor = Pal.text
            // The unit reads as part of the number, so it is set as part of it:
            // same face, same size, same colour, and close enough to belong to
            // it. Small and grey, it read as an annotation on the row instead.
            let u = UILabel(); u.text = unit; u.font = xMono(S(17), .light); u.textColor = Pal.text
            // Proportional, alone in the row: a name is words, and fixed pitch
            // buys nothing for words while costing them a third of their width.
            // The frequency beside it stays monospaced, which is what keeps the
            // digits from shuffling as the list scrolls past.
            let n = UILabel(); n.text = p.name; n.font = .systemFont(ofSize: S(13))
            n.textColor = Pal.dim
            let m = UILabel(); m.text = modeName(p.mode); m.font = xMono(S(11)); m.textColor = Pal.faint
            n.lineBreakMode = .byTruncatingTail
            // Neither half of the reading gives up any of its width.
            for v in [f, u] {
                v.setContentHuggingPriority(.required, for: .horizontal)
                v.setContentCompressionResistancePriority(.required, for: .horizontal)
            }
            for v in [f, u, n, m] {
                v.translatesAutoresizingMaskIntoConstraints = false
                cell.contentView.addSubview(v)
            }
            // The unit is a column, not a follower. Tight against the number
            // it would be ragged down the list — the digit count changes from
            // row to row and the eye reads that as a wobble, which is worse
            // than the air a short reading leaves behind. Everything after it
            // lines up for free, the unit being three characters either way.
            //
            // Given up only for a reading too wide to leave room: "100.10"
            // takes the column's whole width, and pushing is better than
            // overlapping.
            let unitColumn = u.leadingAnchor.constraint(
                equalTo: cell.contentView.leadingAnchor, constant: S(72))
            unitColumn.priority = UILayoutPriority(999)
            NSLayoutConstraint.activate([
                f.leadingAnchor.constraint(equalTo: cell.contentView.leadingAnchor, constant: S(8)),
                f.centerYAnchor.constraint(equalTo: cell.contentView.centerYAnchor),
                unitColumn,
                u.leadingAnchor.constraint(greaterThanOrEqualTo: f.trailingAnchor, constant: S(2)),
                u.firstBaselineAnchor.constraint(equalTo: f.firstBaselineAnchor),
                n.leadingAnchor.constraint(equalTo: u.trailingAnchor, constant: S(6)),
                n.trailingAnchor.constraint(lessThanOrEqualTo: m.leadingAnchor, constant: -S(4)),
                n.centerYAnchor.constraint(equalTo: cell.contentView.centerYAnchor),
                m.trailingAnchor.constraint(equalTo: cell.contentView.trailingAnchor, constant: -S(8)),
                m.centerYAnchor.constraint(equalTo: cell.contentView.centerYAnchor),
            ])
            cell.selectionStyle = .default
        }
        markCell(cell)
        return cell
    }

    /// A station is one line of text and needs the height of one. The band
    /// headings carry a rule above a 19-point name and do not fit in that, so
    /// they are measured separately rather than everything being sized for the
    /// tallest thing in the list.
    func tableView(_ t: UITableView, heightForRowAt ip: IndexPath) -> CGFloat {
        if case .head = items[ip.row] { return S(32) }
        return S(26)
    }

    /// Only stations can be deleted; the band headings are not rows anyone put
    /// there.
    func tableView(_ t: UITableView, canEditRowAt ip: IndexPath) -> Bool {
        if case .station = items[ip.row] { return true }
        return false
    }

    func tableView(_ t: UITableView, commit style: UITableViewCell.EditingStyle,
                   forRowAt ip: IndexPath) {
        guard style == .delete, case .station(let p) = items[ip.row] else { return }
        try? PresetStore.remove(name: p.name)
        reloadPresets()
    }

    func tableView(_ t: UITableView, didSelectRowAt ip: IndexPath) {
        t.deselectRow(at: ip, animated: true)
        guard case .station(let p) = items[ip.row] else { return }
        // Mode first: landing on an FM frequency still demodulating AM is
        // silence, not a station.
        radio.mode = p.mode
        radio.config.mode = p.mode
        radio.setFrequency(UInt32(p.freq))
        radio.config.frequencyHz = p.freq
        radio.config.save()
        refresh()
    }

    /// One colour per band, as the Mac list uses.
    static func bandColor(_ band: String) -> UIColor {
        switch band {
        case "MW": return UIColor(red: 0.878, green: 0.639, blue: 0.290, alpha: 1)
        case "SW": return UIColor(red: 0.435, green: 0.659, blue: 0.863, alpha: 1)
        case "FM": return UIColor(red: 0.498, green: 0.796, blue: 0.561, alpha: 1)
        default:   return Pal.faint
        }
    }
}


/// A UISlider stood on end.
///
/// UIKit has no vertical slider, and a rotation transform and Auto Layout do
/// not mix — the constraint system sizes the untransformed frame and then the
/// rotation throws it somewhere else. So the host takes the space through
/// constraints and places the slider inside it by hand.
final class VerticalSliderHost: UIView {
    let slider = UISlider()
    private let caption = UILabel()
    private let readout = UILabel()

    init(caption text: String) {
        super.init(frame: .zero)
        caption.text = text
        caption.font = xMono(S(11))
        caption.textColor = Pal.faint
        caption.textAlignment = .center
        readout.font = xMono(S(11))
        readout.textColor = Pal.dim
        readout.textAlignment = .center
        for v in [slider, caption, readout] { addSubview(v) }
    }
    required init?(coder: NSCoder) { fatalError("not used") }

    func setReadout(_ t: String) { readout.text = t }

    override func layoutSubviews() {
        super.layoutSubviews()
        let capH: CGFloat = S(14)
        caption.frame = CGRect(x: 0, y: 0, width: bounds.width, height: capH)
        readout.frame = CGRect(x: 0, y: bounds.height - capH, width: bounds.width, height: capH)
        let track = bounds.height - capH * 2 - 8
        // Reset before measuring: a transform already applied would otherwise
        // be composed with the new one on every layout pass.
        slider.transform = .identity
        slider.frame = CGRect(x: 0, y: 0, width: max(S(40), track), height: S(30))
        // Negative, so the low end is at the bottom — the way a dB scale reads,
        // and the way the rail on the Mac window is arranged.
        slider.transform = CGAffineTransform(rotationAngle: -.pi / 2)
        slider.center = CGPoint(x: bounds.midX, y: bounds.midY)
    }
}

/// The receiver's settings, as the Mac's options panel has them: a row per
/// setting, tapped to step its value on.
///
/// It drives `radio.config` directly. The Mac's panel talks to a control
/// endpoint because it may be a front-end onto the plugin's receiver; here the
/// app *is* the receiver, and config's didSet already reconfigures the
/// demodulators.
final class OptionsViewController: UITableViewController {
    private let radio: LocalRadio
    private let onChange: () -> Void

    private enum Kind {
        case bool(get: () -> Bool, set: (Bool) -> Void)
        case list(values: [Double], unit: String, get: () -> Double, set: (Double) -> Void)
        case text(options: [String], get: () -> String, set: (String) -> Void)
    }
    private struct Row { let title: String; let kind: Kind }
    private struct Section { let name: String; let rows: [Row] }
    private var sections: [Section] = []

    init(radio: LocalRadio, onChange: @escaping () -> Void) {
        self.radio = radio
        self.onChange = onChange
        super.init(style: .insetGrouped)
    }
    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Options"
        navigationItem.rightBarButtonItem = UIBarButtonItem(
            barButtonSystemItem: .done, target: self, action: #selector(done))
        tableView.backgroundColor = Pal.bg
        build()
    }
    @objc private func done() { dismiss(animated: true) }

    /// Rows for the live mode only — an AM receiver has no de-emphasis and an
    /// FM one has no carrier AGC, and showing both with half of them inert is
    /// worse than showing what applies.
    private func build() {
        let r = radio
        var demod: Section
        switch r.mode {
        case 0, 1:
            demod = Section(name: "FM OPTIONS", rows: [
                Row(title: "Bandwidth", kind: .list(values: [90_000, 100_000, 110_000, 150_000, 200_000],
                    unit: "kHz", get: { r.config.fmBandwidthHz }, set: { r.config.fmBandwidthHz = $0 })),
                Row(title: "De-emphasis", kind: .text(options: ["off", "50us", "75us"],
                    get: { r.config.fmDeemphasis }, set: { r.config.fmDeemphasis = $0 })),
                Row(title: "Stereo", kind: .bool(get: { r.config.fmStereo }, set: { r.config.fmStereo = $0 })),
                Row(title: "IFNR", kind: .bool(get: { r.config.fmIfnr }, set: { r.config.fmIfnr = $0 })),
                Row(title: "Audio HPF", kind: .bool(get: { r.config.fmHighPass }, set: { r.config.fmHighPass = $0 })),
                Row(title: "Audio LPF", kind: .bool(get: { r.config.fmLowPass }, set: { r.config.fmLowPass = $0 })),
            ])
        case 2:
            demod = Section(name: "AM OPTIONS", rows: [
                Row(title: "Bandwidth", kind: .list(values: [4_000, 6_000, 9_000, 12_000],
                    unit: "kHz", get: { r.config.amBandwidthHz }, set: { r.config.amBandwidthHz = $0 })),
                Row(title: "Sync detect", kind: .bool(get: { r.config.amSync }, set: { r.config.amSync = $0 })),
                Row(title: "Carrier AGC", kind: .bool(get: { r.config.amCarrierAgc }, set: { r.config.amCarrierAgc = $0 })),
                Row(title: "AGC attack", kind: .list(values: [5, 10, 20, 50, 100, 200], unit: "",
                    get: { r.config.amAgcAttack }, set: { r.config.amAgcAttack = $0 })),
                Row(title: "AGC decay", kind: .list(values: [1, 2, 5, 8, 12, 20], unit: "",
                    get: { r.config.amAgcDecay }, set: { r.config.amAgcDecay = $0 })),
            ])
        default:
            demod = Section(name: "SSB / CW OPTIONS", rows: [
                Row(title: "Bandwidth", kind: .list(values: [500, 1_000, 1_800, 2_400, 3_000], unit: "Hz",
                    get: { r.config.ssbBandwidthHz }, set: { r.config.ssbBandwidthHz = $0 })),
                Row(title: "BFO pitch", kind: .list(values: [400, 500, 600, 700, 800, 1_000], unit: "Hz",
                    get: { r.config.cwBfoHz }, set: { r.config.cwBfoHz = $0 })),
            ])
        }
        sections = [
            demod,
            Section(name: "RF", rows: [
                // One row, on whichever of the two gain indices the live
                // mode uses: AM keeps its own so it can be pulled down against
                // a strong medium-wave neighbour, and everything else shares
                // the other (spyService.ts:1214). Shown resolved, so a value
                // never set here reads as the device maximum it is running at
                // rather than as a blank.
                Row(title: "Gain", kind: .list(values: [0, 1, 2, 3, 4, 5, 6, 7, 8], unit: "",
                    get: { Double(r.gain) },
                    set: { v in
                        let g = UInt32(max(0, v))
                        if r.mode == 2 { r.config.amGain = g } else { r.config.fmGain = g }
                    })),
                Row(title: "IQ NR", kind: .bool(get: { r.iqNrEnabled }, set: { r.iqNrEnabled = $0 })),
                Row(title: "Levelling", kind: .bool(get: { r.levelingEnabled }, set: { r.levelingEnabled = $0 })),
            ]),
            // The transform's own settings, which the Mac keeps in its toolbar.
            // Framerate and smoothing are what get ridden — a slow trace is
            // easier to read a weak carrier off, a fast one is easier to tune
            // by — and both survive a relaunch now that they are in the config.
            Section(name: "DISPLAY", rows: [
                Row(title: "Framerate", kind: .list(values: [5, 10, 16, 24, 30, 60], unit: "fps",
                    get: { Double(r.fps) }, set: { r.fps = Int($0) })),
                Row(title: "Smoothing", kind: .list(values: [2, 5, 10, 20, 24, 30, 50, 60], unit: "",
                    get: { Double(r.smoothingFactor) }, set: { r.smoothingFactor = Float($0) })),
            ]),
            Section(name: "RECEIVER", rows: [
                Row(title: "Tune mode", kind: .text(options: ["preset", "vfo"],
                    get: { r.config.tuneMode }, set: { r.config.tuneMode = $0 })),
                Row(title: "JP region", kind: .text(options: StationLabel.Region.allCases.map(\.rawValue),
                    get: { r.config.jpRegion }, set: { r.config.jpRegion = $0 })),
                Row(title: "Connect at start", kind: .bool(get: { r.config.autoDirect },
                    set: { r.config.autoDirect = $0 })),
                // Same three names and the same file the Mac window reads, so
                // one machine's setting is not another's mystery.
                Row(title: "UI scale", kind: .text(options: UI.names,
                    get: { r.config.uiScale }, set: { r.config.uiScale = $0 })),
            ]),
        ]
        tableView.reloadData()
    }

    override func numberOfSections(in t: UITableView) -> Int { sections.count }
    override func tableView(_ t: UITableView, titleForHeaderInSection s: Int) -> String? { sections[s].name }
    override func tableView(_ t: UITableView, numberOfRowsInSection s: Int) -> Int { sections[s].rows.count }

    override func tableView(_ t: UITableView, cellForRowAt ip: IndexPath) -> UITableViewCell {
        let row = sections[ip.section].rows[ip.row]
        let cell = UITableViewCell(style: .value1, reuseIdentifier: nil)
        cell.textLabel?.text = row.title
        cell.textLabel?.font = xMono(15)
        cell.detailTextLabel?.font = xMono(15, .medium)
        cell.backgroundColor = Pal.panel
        cell.textLabel?.textColor = Pal.dim
        switch row.kind {
        case .bool(let get, _):
            cell.detailTextLabel?.text = get() ? "ON" : "OFF"
            cell.detailTextLabel?.textColor = get() ? Pal.accent : Pal.faint
            cell.selectionStyle = .default
        case .list(let values, let unit, let get, let set):
            let titles = values.map { Self.listTitle($0, unit: unit) }
            let cur = get()
            cell.accessoryView = pullDown(titles,
                                          selected: values.firstIndex { abs($0 - cur) < 0.001 },
                                          fallback: Self.listTitle(cur, unit: unit)) { [weak self] i in
                self?.apply { set(values[i]) }
            }
            // The control is the pull-down, so the row does not offer itself.
            cell.selectionStyle = .none
        case .text(let options, let get, let set):
            cell.accessoryView = pullDown(options,
                                          selected: options.firstIndex(of: get()),
                                          fallback: get()) { [weak self] i in
                self?.apply { set(options[i]) }
            }
            cell.selectionStyle = .none
        }
        return cell
    }

    private static func listTitle(_ v: Double, unit: String) -> String {
        unit == "kHz" ? String(format: "%g kHz", v / 1000)
      : unit.isEmpty ? String(format: "%g", v)
      : String(format: "%g %@", v, unit)
    }

    /// The value, and every value it could be, one tap away.
    ///
    /// The rows used to step and wrap, the way the Mac panel's do. That is fine
    /// for three options and tedious for eight, and it never says what the
    /// eight are — a JP region or a framerate is something to pick, not
    /// something to walk past. `fallback` covers a value the list does not hold,
    /// so a config written by hand still reads as itself.
    private func pullDown(_ titles: [String], selected: Int?, fallback: String,
                          pick: @escaping (Int) -> Void) -> UIButton {
        let b = UIButton(type: .system)
        var cfg = UIButton.Configuration.plain()
        // Vertical padding, so the tap target is a row's height rather than a
        // line of text's.
        cfg.contentInsets = NSDirectionalEdgeInsets(top: 8, leading: 10, bottom: 8, trailing: 0)
        cfg.image = UIImage(systemName: "chevron.up.chevron.down")
        cfg.imagePlacement = .trailing
        cfg.imagePadding = 6
        cfg.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(pointSize: 11)
        var title = AttributedString(selected.map { titles[$0] } ?? fallback)
        title.font = xMono(15, .medium)
        title.foregroundColor = Pal.text
        cfg.attributedTitle = title
        b.configuration = cfg
        b.tintColor = Pal.faint
        b.menu = UIMenu(children: titles.enumerated().map { i, t in
            UIAction(title: t, state: i == selected ? .on : .off) { _ in pick(i) }
        })
        b.showsMenuAsPrimaryAction = true
        b.sizeToFit()
        return b
    }

    /// Tap toggles a boolean; the pull-downs carry everything else.
    override func tableView(_ t: UITableView, didSelectRowAt ip: IndexPath) {
        t.deselectRow(at: ip, animated: true)
        guard case .bool(let get, let set) = sections[ip.section].rows[ip.row].kind else { return }
        apply { set(!get()) }
    }

    private func apply(_ change: () -> Void) {
        change()
        // Saving is not applying — but applying is now `config`'s own job, so
        // writing the value above is enough. See LocalRadio.applyConfig.
        radio.config.save()
        // The mode's own section may have changed shape; rebuild rather than
        // reload one row.
        build()
        onChange()
    }
}

#endif
