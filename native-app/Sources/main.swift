import AppKit

// Deck RX — a native front-end over the receiver core, laid out to the "D"
// design: preset table on the left, spectrum + waterfall in the middle,
// receiver state on the right, transport along the bottom.
//
// It owns no receiver state. Reads come from the plugin's status feed and the
// spectrum socket; writes go to the control endpoint. Anything the feed does
// not publish yet is drawn as "—" rather than invented.

// MARK: - palette (the design's, matching the deck's own LCDs)

enum P {
    static let bg      = NSColor(red: 0.071, green: 0.075, blue: 0.086, alpha: 1) // #121316
    static let panel   = NSColor(red: 0.090, green: 0.094, blue: 0.110, alpha: 1) // #17181C
    static let sunken  = NSColor(red: 0.047, green: 0.051, blue: 0.059, alpha: 1) // #0C0D0F
    static let line    = NSColor(red: 0.149, green: 0.157, blue: 0.176, alpha: 1) // #26282D
    // Contrast against the near-black panels, not just a tidy grey ramp. The
    // previous dim/faint pair measured about 5:1 and 3.4:1 against #17181C —
    // the second is below the readable floor for text at any size, and it was
    // carrying units, section headers and axis labels. These are ~10:1 and
    // ~6.3:1, so a secondary label still reads as secondary but is legible.
    static let text    = NSColor(red: 0.941, green: 0.949, blue: 0.961, alpha: 1) // #F0F2F5
    static let dim     = NSColor(red: 0.765, green: 0.788, blue: 0.816, alpha: 1) // #C3C9D0
    static let faint   = NSColor(red: 0.596, green: 0.627, blue: 0.659, alpha: 1) // #98A0A8
    static let accent  = NSColor(red: 0.349, green: 0.851, blue: 0.451, alpha: 1) // #59D973
    static let blue    = NSColor(red: 0.400, green: 0.702, blue: 0.949, alpha: 1) // #66B3F2
    static let warn    = NSColor(red: 0.949, green: 0.749, blue: 0.349, alpha: 1) // #F2BF59
}

func mono(_ size: CGFloat, _ w: NSFont.Weight = .regular) -> NSFont {
    // Floor at 9 pt: below that the monospaced faces stop being readable and a
    // smaller number on screen is worth nothing.
    NSFont.monospacedSystemFont(ofSize: max(9, (size * UI.scale).rounded()), weight: w)
}
func label(_ text: String, _ font: NSFont, _ color: NSColor) -> NSTextField {
    let f = NSTextField(labelWithString: text)
    f.font = font; f.textColor = color; f.backgroundColor = .clear; f.isBezeled = false
    return f
}
func panelView(_ color: NSColor = P.panel) -> NSView {
    let v = NSView(); v.wantsLayer = true; v.layer?.backgroundColor = color.cgColor
    return v
}

// MARK: - preset table

/// A container whose origin is top-left, so a scroll view built on it opens at
/// the first row instead of the last.
private final class FlippedStack: NSStackView {
    override var isFlipped: Bool { true }
}

final class PresetList: NSView {
    private let stack = FlippedStack()
    private let scroll = NSScrollView()
    private var rows: [(row: NSView, bar: NSView, freq: NSTextField, name: NSTextField, preset: Receiver.Preset)] = []
    private var presets: [Receiver.Preset] = []
    var onPick: ((Receiver.Preset) -> Void)?

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = P.panel.cgColor
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 0
        stack.translatesAutoresizingMaskIntoConstraints = false
        // A real preset store runs to dozens of entries — more than fits. The
        // rows live in a clipping scroll view so the list can never draw over
        // the transport bar below it.
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        scroll.documentView = stack
        addSubview(scroll)
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: topAnchor, constant: 6),
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: bottomAnchor),
            stack.widthAnchor.constraint(equalTo: scroll.widthAnchor),
        ])
        reload()
    }
    required init?(coder: NSCoder) { fatalError() }

    func reload() {
        presets = Receiver.presets()
        for r in rows { stack.removeArrangedSubview(r.row); r.row.removeFromSuperview() }
        rows.removeAll()
        for p in presets {
            let row = NSView()
            row.translatesAutoresizingMaskIntoConstraints = false
            let (num, unit) = formatFreq(p.freq)
            let f = label(num, mono(21, .light), P.text)
            let u = label(unit, mono(13), P.faint)
            let n = label(p.name, .systemFont(ofSize: max(9, S(18))), P.dim)
            let m = label(modeName(p.mode), mono(13), P.faint)
            n.lineBreakMode = .byTruncatingTail
            // Selection marker: a solid accent bar down the leading edge. A
            // background tint alone was nearly invisible against the panel.
            let bar = NSView()
            bar.wantsLayer = true
            bar.translatesAutoresizingMaskIntoConstraints = false
            row.addSubview(bar)
            for v in [f, u, n, m] { v.translatesAutoresizingMaskIntoConstraints = false; row.addSubview(v) }
            NSLayoutConstraint.activate([
                // Every one of these was a fixed constant, so the list kept its
                // full row height and column widths at any scale while the
                // panel around it shrank.
                row.heightAnchor.constraint(equalToConstant: S(29)),
                bar.leadingAnchor.constraint(equalTo: row.leadingAnchor),
                bar.topAnchor.constraint(equalTo: row.topAnchor),
                bar.bottomAnchor.constraint(equalTo: row.bottomAnchor),
                bar.widthAnchor.constraint(equalToConstant: S(4)),
                f.leadingAnchor.constraint(equalTo: row.leadingAnchor, constant: S(10)),
                f.widthAnchor.constraint(equalToConstant: S(78)),
                f.centerYAnchor.constraint(equalTo: row.centerYAnchor),
                u.leadingAnchor.constraint(equalTo: f.trailingAnchor, constant: 1),
                u.widthAnchor.constraint(equalToConstant: S(26)),
                u.firstBaselineAnchor.constraint(equalTo: f.firstBaselineAnchor),
                n.leadingAnchor.constraint(equalTo: u.trailingAnchor, constant: S(8)),
                n.trailingAnchor.constraint(lessThanOrEqualTo: m.leadingAnchor, constant: S(-6)),
                n.centerYAnchor.constraint(equalTo: row.centerYAnchor),
                // -24, not -10: the vertical scroller overlays the row's
                // trailing edge and would clip the mode column to "A" / "WF".
                m.trailingAnchor.constraint(equalTo: row.trailingAnchor, constant: S(-20)),
                m.centerYAnchor.constraint(equalTo: row.centerYAnchor),
            ])
            row.wantsLayer = true
            stack.addArrangedSubview(row)
            NSLayoutConstraint.activate([
                row.leadingAnchor.constraint(equalTo: stack.leadingAnchor),
                row.trailingAnchor.constraint(equalTo: stack.trailingAnchor),
            ])
            rows.append((row, bar, f, n, p))
        }
    }

    /// Highlight whichever row the receiver is actually on. Frequency is the
    /// identity here: the plugin may have been retuned by a dial or a knob.
    private var lastMarked: Double = -1

    /// Alternating row tint. A dense list of numbers is hard to track across
    /// horizontally — the eye loses the line between a frequency and its
    /// station name — and a stripe is cheaper than a rule for that.
    private static let stripe = NSColor(white: 1, alpha: 0.085)

    func markCurrent(freqHz: Double) {
        // Bring the tuned row into view when it changes. The marker is useless
        // if the row is scrolled off — which it usually is, since the store
        // runs from medium wave to FM and the window shows a dozen entries.
        if freqHz != lastMarked {
            lastMarked = freqHz
            if let r = rows.first(where: { abs($0.preset.freq - freqHz) < 1 }) {
                DispatchQueue.main.async { [weak self] in
                    guard let self else { return }
                    self.scroll.contentView.scrollToVisible(r.row.frame.insetBy(dx: 0, dy: -60))
                }
            }
        }
        for (i, r) in rows.enumerated() {
            let on = abs(r.preset.freq - freqHz) < 1
            r.row.layer?.backgroundColor = on
                ? NSColor(red: 0.129, green: 0.239, blue: 0.161, alpha: 1).cgColor
                : (i % 2 == 1 ? Self.stripe.cgColor : NSColor.clear.cgColor)
            r.bar.layer?.backgroundColor = on ? P.accent.cgColor : NSColor.clear.cgColor
            // Lift the text too: on a dark panel a background change alone is
            // easy to miss, and this row answers "what am I listening to?".
            r.freq.textColor = on ? .white : P.text
            r.name.textColor = on ? .white : P.dim
        }
    }

    override func mouseDown(with event: NSEvent) {
        let inStack = stack.convert(event.locationInWindow, from: nil)
        for r in rows where r.row.frame.contains(inStack) {
            onPick?(r.preset); return
        }
    }
}

// MARK: - window

final class MainView: NSView {
    let spectrum = SpectrumView(frame: .zero)
    let presetList = PresetList(frame: .zero)
    let options = OptionsPanel(frame: .zero)

    private let clockJST = label("—", mono(22), P.text)
    private let clockUTC = label("—", mono(22), P.dim)
    private let linkDot = panelView(P.faint)
    private let linkLabel = label("—", mono(19), P.dim)
    private let deviceLabel = label("—", mono(17), P.faint)
    private let iqLabel = label("—", mono(17), P.faint)
    private let dropsLabel = label("—", mono(17), P.faint)
    private let outLabel = label("—", mono(17), P.faint)

    private let stationLabel = label("—", .systemFont(ofSize: max(11, UI.H(26))), P.text)
    private let freqView = FreqView(frame: .zero)
    private let modeChip = label("—", mono(22, .medium), P.text)
    /// FM stereo pilot lock, drawn as the deck's LCD draws it: a red outlined
    /// badge, shown only while the pilot is actually locked AND the output is
    /// really stereo. Pilot detection keeps running in other modes, so a badge
    /// lit over a mono output would be a lie.
    private let stereoBadge = BadgeView(text: "STEREO", font: mono(17, .black),
                                       color: NSColor(red: 1.0, green: 0.25, blue: 0.25, alpha: 1))
    private let bwLabel = label("—", mono(19), P.dim)
    private let stepLabel = label("—", mono(19), P.dim)

    private let sBar = MeterBar(); private let sNum = label("—", mono(21), P.text)
    private let nBar = MeterBar(); private let nNum = label("—", mono(21), P.text)

    private let bandBar = panelView()
    private let volBar = VolumeBar()
    private let volLabel = label("—", mono(18), P.dim)

    // Spectrum display controls. FFT size / framerate / averaging live on the
    // receiver (the deck's FFT dial shares that pipeline), so those three are
    // pushed to /spectrum; peak hold and the dB window are this app's own view
    // of the same data and stay local.
    private let fftPop = NSPopUpButton()
    private let fpsPop = NSPopUpButton()
    private let avgLabel = label("(0.3s)", mono(15), P.faint)
    private let smoothField = NSTextField(string: "30")
    private let smoothStepper = NSStepper()
    private let dbLabel = label("−100 / −20 dB", mono(17), P.dim)
    private var modePads: [TogglePad] = []
    private var mutePad: TogglePad!
    private var powerPad: TogglePad!
    private var holdPad: TogglePad!
    private let stepPop = NSPopUpButton()
    /// Spectrum source: the plugin's socket, or the app's own SpyServer
    /// connection. Both exist while the standalone port is in progress —
    /// switching between them on one screen is how parity gets checked.
#if STANDALONE
    var onSourceToggle: (() -> Void)?
    var onAudioToggle: (() -> Void)?
    /// Returns true when the direct path took the change, so it is not also
    /// sent to the plugin.
    var onFftSize: ((Int) -> Bool)?
    lazy var srcAudioPad: TogglePad = TogglePad("AUDIO", font: mono(13), momentary: false) {
        [weak self] in self?.onAudioToggle?()
    }
    var onImportPresets: (() -> Void)?
    lazy var importPad: TogglePad = TogglePad("IMPORT", font: mono(13), momentary: true) {
        [weak self] in self?.onImportPresets?()
    }
    var onNrToggle: (() -> Void)?
    var onLevelToggle: (() -> Void)?
    lazy var nrPad: TogglePad = TogglePad("NR", font: mono(13), momentary: false) {
        [weak self] in self?.onNrToggle?()
    }
    lazy var levelPad: TogglePad = TogglePad("LVL", font: mono(13), momentary: false) {
        [weak self] in self?.onLevelToggle?()
    }
    lazy var srcPad: TogglePad = TogglePad("DIRECT", font: mono(13), momentary: false) {
        [weak self] in self?.onSourceToggle?()
    }
    let srcLabel = label("via plugin", mono(13), P.faint)
#endif
    private let zoomSlider = NSSlider()
    private let wfSlider = NSSlider()
    private let wfLabel = label("--", mono(14), P.dim)
    private let maxSlider = NSSlider()
    private let minSlider = NSSlider()
    private let zoomLabel = label("1×", mono(14), P.dim)
    private var stepValues: [Int] = []
    private let muteLabel = label("", mono(18, .medium), P.warn)

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = P.bg.cgColor
        nBar.tint = P.blue
        sBar.tint = P.accent
        build()
    }
    required init?(coder: NSCoder) { fatalError() }

    private func build() {
        // top bar
        let top = panelView()
        // The bar the layout asked for: what the receiver is, how wide its IQ is,
        // how hard it is decimating, whether the sink is losing buffers, and
        // where the audio goes — the questions you ask when something sounds
        // wrong, answered without opening a log.
        func sep() -> NSView { label("|", mono(15), P.line) }
        let topRow = NSStackView(views: [
            label("deck", .systemFont(ofSize: max(9, S(23)), weight: .bold), P.text),
            linkDot, linkLabel, deviceLabel,
            sep(), iqLabel, dropsLabel,
            sep(), outLabel,
            NSView(),
            label("JST", mono(17), P.faint), clockJST,
            label("UTC", mono(17), P.faint), clockUTC,
        ])
        topRow.orientation = .horizontal
        topRow.spacing = 8
        topRow.alignment = .centerY
        // Let the status text give way when the window is narrowed. Every label
        // here defends its full width by default, and their sum became the
        // window's minimum — the window could not be resized at all, measured
        // pinned at 1930 px wide. These are status readouts: truncating one is
        // a far smaller loss than a window that will not move.
        for v in [linkLabel, deviceLabel, iqLabel, dropsLabel, outLabel, stationLabel] {
            v.setContentCompressionResistancePriority(.init(1), for: .horizontal)
            v.lineBreakMode = .byTruncatingTail
            v.cell?.usesSingleLineMode = true
        }
        linkDot.layer?.cornerRadius = 3
        linkDot.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            linkDot.widthAnchor.constraint(equalToConstant: 6),
            linkDot.heightAnchor.constraint(equalToConstant: 6),
        ])
        embed(topRow, in: top, inset: S(12))

        // frequency header
        let header = panelView(NSColor(red: 0.082, green: 0.086, blue: 0.102, alpha: 1))
        freqView.onTune = { hz in Receiver.tune(hz: Int(hz)) }
        freqView.translatesAutoresizingMaskIntoConstraints = false
        // FreqView derives its digit height from its own bounds, so this one
        // constant sizes the whole readout.
        freqView.heightAnchor.constraint(equalToConstant: UI.H(96)).isActive = true
        stereoBadge.isHidden = true
        stereoBadge.translatesAutoresizingMaskIntoConstraints = false
        let freqRow = NSStackView(views: [freqView, modeChip, stereoBadge])
        freqRow.orientation = .horizontal; freqRow.alignment = .centerY; freqRow.spacing = 10
        let meters = NSStackView(views: [meterRow("S", sBar, sNum), meterRow("N", nBar, nNum)])
        meters.orientation = .vertical; meters.spacing = 6; meters.alignment = .leading
        let detail = NSStackView(views: [
            label("BW", mono(14), P.faint), bwLabel,
            label("STEP", mono(14), P.faint), stepLabel,
        ])
        detail.orientation = .horizontal; detail.spacing = 6; detail.alignment = .firstBaseline
        let left = NSStackView(views: [stationLabel, freqRow, detail])
        left.orientation = .vertical; left.alignment = .leading; left.spacing = 4
        let headerRow = NSStackView(views: [left, NSView(), meters])
        headerRow.orientation = .horizontal; headerRow.alignment = .centerY; headerRow.spacing = 20
        embed(headerRow, in: header, inset: 14)

        // bottom transport
        let bottom = panelView()
        let f = mono(16)
        let volDown = TogglePad("VOL −", font: f, momentary: true) { Receiver.volume(delta: -3) }
        let volUp   = TogglePad("VOL +", font: f, momentary: true) { Receiver.volume(delta: 3) }
        let prev    = TogglePad("◀ PRESET", font: f, momentary: true) { Receiver.preset(step: -1) }
        let next    = TogglePad("PRESET ▶", font: f, momentary: true) { Receiver.preset(step: 1) }
        let down    = TogglePad("− TUNE", font: f, momentary: true) { [weak self] in self?.tuneStep(-1) }
        let up      = TogglePad("TUNE +", font: f, momentary: true) { [weak self] in self?.tuneStep(1) }
        mutePad  = TogglePad("MUTE", font: f, onColor: P.warn) { Receiver.toggleMute() }
        powerPad = TogglePad("POWER", font: f) { Receiver.togglePower() }
        modePads = ["WFM", "NFM", "AM", "USB", "LSB", "CW"].map { name in
            let m = MODE_NAMES.firstIndex(of: name) ?? 1
            return TogglePad(name, font: f) { Receiver.mode(m) }
        }
        let modeRow = NSStackView(views: modePads)
        modeRow.orientation = .horizontal; modeRow.spacing = 2
        volBar.onSet = { level in Receiver.volume(level: level) }
        volBar.translatesAutoresizingMaskIntoConstraints = false
        let bottomRow = NSStackView(views: [prev, next, down, up, modeRow, NSView(),
                                            volDown, volBar, volUp, volLabel, mutePad, powerPad])
        bottomRow.orientation = .horizontal; bottomRow.spacing = 4; bottomRow.alignment = .centerY
        // The volume bar gives way before the buttons do: a shorter bar is
        // still a usable volume control, a clipped button is not.
        volBar.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        volBar.widthAnchor.constraint(greaterThanOrEqualToConstant: S(90)).isActive = true
        // Measured at 1162 px once the toolbar was dealt with, which then set
        // the minimum on its own. The percentage readout gives before the
        // buttons do; a clipped button is not a button.
        volLabel.setContentCompressionResistancePriority(.init(2), for: .horizontal)
        volLabel.lineBreakMode = .byTruncatingTail
        embed(bottomRow, in: bottom, inset: S(12))

        // display toolbar, between the header and the spectrum
        let bar = panelView(P.sunken)
        // Sizes above 4096 are only reachable on the app's own connection. The
        // plugin's ladder stops where a 200x100 LCD stopped needing more and
        // where a JS transform stopped being affordable; vDSP has neither
        // limit, and 65536 is what SDR++ runs here — worth 12 dB of noise
        // floor against 4096.
#if STANDALONE
        fftPop.addItems(withTitles: ["256", "512", "1024", "2048", "4096",
                                     "8192", "16384", "32768", "65536"])
#else
        fftPop.addItems(withTitles: ["256", "512", "1024", "2048", "4096"])
#endif
        fftPop.font = mono(16)
        fftPop.target = ButtonBox.shared
        fftPop.action = #selector(ButtonBox.fire(_:))
        ButtonBox.shared.actions[ObjectIdentifier(fftPop)] = { [weak self] in
            guard let self, let t = self.fftPop.titleOfSelectedItem, let v = Int(t) else { return }
#if STANDALONE
            if let set = self.onFftSize, set(v) { return }   // handled by the direct path
#endif
            Receiver.spectrum(fft: v) { size, rate, avg in self.adoptSpectrum(size, rate, avg) }
        }
        fpsPop.addItems(withTitles: ["5", "10", "15", "20", "30", "60"])
        fpsPop.font = mono(16)
        fpsPop.target = ButtonBox.shared
        fpsPop.action = #selector(ButtonBox.fire(_:))
        ButtonBox.shared.actions[ObjectIdentifier(fpsPop)] = { [weak self] in
            guard let self, let t = self.fpsPop.titleOfSelectedItem, let v = Int(t) else { return }
            Receiver.spectrum(fps: v) { size, rate, avg in self.adoptSpectrum(size, rate, avg) }
        }
        holdPad = TogglePad("HOLD", font: mono(16), onColor: P.warn) { [weak self] in
            guard let self else { return }
            self.spectrum.holdEnabled.toggle()
            self.holdPad.isOn = self.spectrum.holdEnabled
        }
        // The VFO step lives on the receiver (the deck's dial reads the same
        // value), so the menu is built from what /step reports rather than from
        // a list hard-coded here that would drift.
        stepPop.font = mono(16)
        stepPop.target = ButtonBox.shared
        stepPop.action = #selector(ButtonBox.fire(_:))
        ButtonBox.shared.actions[ObjectIdentifier(stepPop)] = { [weak self] in
            guard let self, self.stepPop.indexOfSelectedItem >= 0,
                  self.stepPop.indexOfSelectedItem < self.stepValues.count else { return }
            let hz = self.stepValues[self.stepPop.indexOfSelectedItem]
            Receiver.step(hz: hz) { step, values in self.adoptStep(step, values) }
        }

        // Smoothing as a number you can type, with ±1 steps — the ladder of
        // preset values was too coarse to find the point where the noise
        // settles without smearing a signal. Same shape SDR++ uses.
        smoothField.font = mono(16)
        smoothField.alignment = .right
        smoothField.isBezeled = true
        smoothField.drawsBackground = true
        smoothField.translatesAutoresizingMaskIntoConstraints = false
        smoothField.widthAnchor.constraint(equalToConstant: S(62)).isActive = true
        smoothField.target = ButtonBox.shared
        smoothField.action = #selector(ButtonBox.fire(_:))
        ButtonBox.shared.actions[ObjectIdentifier(smoothField)] = { [weak self] in
            guard let self, let v = Int(self.smoothField.stringValue) else { return }
            Receiver.spectrum(smooth: v) { s, r, a in self.adoptSpectrum(s, r, a) }
        }
        smoothStepper.minValue = 1
        smoothStepper.maxValue = 1000
        smoothStepper.increment = 1
        smoothStepper.integerValue = smoothSpeed
        smoothStepper.valueWraps = false
        smoothStepper.target = ButtonBox.shared
        smoothStepper.action = #selector(ButtonBox.fire(_:))
        ButtonBox.shared.actions[ObjectIdentifier(smoothStepper)] = { [weak self] in
            guard let self else { return }
            Receiver.spectrum(smooth: self.smoothStepper.integerValue) { s, r, a in
                self.adoptSpectrum(s, r, a)
            }
        }

        let barRow = NSStackView(views: [
            label("STEP", mono(14), P.faint), stepPop,
            label("FFT", mono(14), P.faint), fftPop,
            label("RATE", mono(14), P.faint), fpsPop, label("fps", mono(14), P.faint),
            
            label("SMOOTH", mono(14), P.faint), smoothField, smoothStepper, avgLabel,
            holdPad,
            NSView(),
            dbLabel,
        ])
#if STANDALONE
        // The receiver controls exist only in the standalone build. Deck RX is
        // a front-end onto the plugin's receiver and has nothing to point them
        // at; showing dead buttons would be worse than not having them.
        for v in [srcPad, srcAudioPad, nrPad, levelPad, importPad] { barRow.addArrangedSubview(v) }
        barRow.addArrangedSubview(srcLabel)
#endif
        barRow.orientation = .horizontal
        barRow.spacing = 4
        barRow.alignment = .centerY
        // Same for the display toolbar: the source label carries an error
        // message that can be arbitrarily long.
#if STANDALONE
        srcLabel.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        srcLabel.lineBreakMode = .byTruncatingTail
        srcLabel.cell?.usesSingleLineMode = true
#endif
        dbLabel.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        // Measured: this row wanted 1106 px and, with the 606 px of fixed
        // panels beside it, set the window's whole minimum. The captions are
        // the give: a popup has to stay legible, the word in front of it does
        // not. avgLabel is a derived readout and goes first.
        avgLabel.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        for v in barRow.arrangedSubviews {
            guard let t = v as? NSTextField, !t.isEditable else { continue }
            t.setContentCompressionResistancePriority(.init(2), for: .horizontal)
            t.lineBreakMode = .byTruncatingTail
            t.cell?.usesSingleLineMode = true
        }
        embed(barRow, in: bar, inset: S(12))

        // Zoom and the dB window as continuous vertical sliders down the right
        // edge, the way SDR++ presents them: these are the three you ride while
        // watching the waterfall, so they want a handle rather than a menu.
        let rail = panelView(P.panel)
        zoomSlider.minValue = 0; zoomSlider.maxValue = 5; zoomSlider.doubleValue = 0
        // Waterfall depth in seconds. The scale is log so the short end, where
        // a few seconds either way is the whole picture, gets as much travel as
        // the long end where it is a rounding error.
        wfSlider.minValue = log(5.0); wfSlider.maxValue = log(600.0)
        wfSlider.doubleValue = log(spectrum.wfTargetSeconds)
        maxSlider.minValue = -60; maxSlider.maxValue = 0; maxSlider.doubleValue = Double(spectrum.dbCeil)
        minSlider.minValue = -160; minSlider.maxValue = -60; minSlider.doubleValue = Double(spectrum.dbFloor)
        for sl in [zoomSlider, wfSlider, maxSlider, minSlider] {
            sl.isVertical = true
            sl.target = ButtonBox.shared
            sl.action = #selector(ButtonBox.fire(_:))
            sl.translatesAutoresizingMaskIntoConstraints = false
            // A vertical NSSlider's intrinsic height is tiny; without this the
            // three of them collapse into a stack of dots at one end of the rail.
            sl.heightAnchor.constraint(greaterThanOrEqualToConstant: S(120)).isActive = true
            sl.setContentHuggingPriority(.defaultLow, for: .vertical)
        }
        ButtonBox.shared.actions[ObjectIdentifier(zoomSlider)] = { [weak self] in
            guard let self else { return }
            self.spectrum.zoom = pow(2, self.zoomSlider.doubleValue)
            self.zoomLabel.stringValue = String(format: "%.0f×", pow(2, self.zoomSlider.doubleValue))
        }
        ButtonBox.shared.actions[ObjectIdentifier(wfSlider)] = { [weak self] in
            guard let self else { return }
            self.spectrum.wfTargetSeconds = exp(self.wfSlider.doubleValue)
            self.syncWaterfallSpan()
        }
        ButtonBox.shared.actions[ObjectIdentifier(maxSlider)] = { [weak self] in
            guard let self else { return }
            // Keep at least 10 dB of window: a collapsed range paints a flat
            // block and looks like a dead receiver.
            self.spectrum.dbCeil = Float(max(self.maxSlider.doubleValue, Double(self.spectrum.dbFloor) + 10))
            self.syncRange()
        }
        ButtonBox.shared.actions[ObjectIdentifier(minSlider)] = { [weak self] in
            guard let self else { return }
            self.spectrum.dbFloor = Float(min(self.minSlider.doubleValue, Double(self.spectrum.dbCeil) - 10))
            self.syncRange()
        }
        let railStack = NSStackView(views: [
            label("ZOOM", mono(13), P.faint), zoomSlider, zoomLabel,
            label("MIN", mono(13), P.faint), minSlider,
            label("MAX", mono(13), P.faint), maxSlider,
            label("TIME", mono(13), P.faint), wfSlider, wfLabel,
        ])
        railStack.orientation = .vertical
        railStack.alignment = .centerX
        railStack.spacing = 4
        railStack.distribution = .fill
        railStack.translatesAutoresizingMaskIntoConstraints = false
        rail.addSubview(railStack)
        NSLayoutConstraint.activate([
            railStack.topAnchor.constraint(equalTo: rail.topAnchor, constant: 8),
            railStack.bottomAnchor.constraint(equalTo: rail.bottomAnchor, constant: -8),
            railStack.centerXAnchor.constraint(equalTo: rail.centerXAnchor),
        ])

        // Band shortcuts. Scrolling a store that runs from medium wave to FM to
        // reach the next band is the motion this removes.
        let bandGrid = NSGridView()
        bandGrid.rowSpacing = 3
        bandGrid.columnSpacing = 3
        bandGrid.translatesAutoresizingMaskIntoConstraints = false
        let pads = Receiver.bands.map { b in
            TogglePad(b.name, font: mono(14), momentary: true) { Receiver.jump(to: b) }
        }
        bandGrid.addRow(with: Array(pads[0..<4]))
        bandGrid.addRow(with: Array(pads[4...]) + [NSView()])
        let bandTitle = label("BAND JUMP", mono(13), P.faint)
        bandTitle.translatesAutoresizingMaskIntoConstraints = false
        bandBar.addSubview(bandTitle)
        bandBar.addSubview(bandGrid)
        NSLayoutConstraint.activate([
            bandTitle.topAnchor.constraint(equalTo: bandBar.topAnchor, constant: 6),
            bandTitle.leadingAnchor.constraint(equalTo: bandBar.leadingAnchor, constant: 10),
            bandGrid.topAnchor.constraint(equalTo: bandTitle.bottomAnchor, constant: 4),
            bandGrid.leadingAnchor.constraint(equalTo: bandBar.leadingAnchor, constant: 10),
        ])

        for (n, v) in [("top", top), ("header", header), ("bottom", bottom),
                       ("presetList", presetList), ("spectrum", spectrum), ("bar", bar),
                       ("rail", rail), ("options", options), ("bandBar", bandBar)] {
            v.translatesAutoresizingMaskIntoConstraints = false
            addSubview(v)
            debugPanelRefs.append((n, v))
        }
        NSLayoutConstraint.activate([
            top.topAnchor.constraint(equalTo: topAnchor),
            top.leadingAnchor.constraint(equalTo: leadingAnchor),
            top.trailingAnchor.constraint(equalTo: trailingAnchor),

            top.heightAnchor.constraint(equalToConstant: S(58)),

            presetList.topAnchor.constraint(equalTo: top.bottomAnchor),
            presetList.leadingAnchor.constraint(equalTo: leadingAnchor),
            presetList.widthAnchor.constraint(equalToConstant: S(306)),
            presetList.bottomAnchor.constraint(equalTo: bandBar.topAnchor),

            bandBar.leadingAnchor.constraint(equalTo: leadingAnchor),
            bandBar.widthAnchor.constraint(equalTo: presetList.widthAnchor),
            bandBar.bottomAnchor.constraint(equalTo: bottom.topAnchor),
            bandBar.heightAnchor.constraint(equalToConstant: S(76)),

            header.topAnchor.constraint(equalTo: top.bottomAnchor),
            header.leadingAnchor.constraint(equalTo: presetList.trailingAnchor),
            header.trailingAnchor.constraint(equalTo: rail.leadingAnchor),
            // Tall enough for the 68 pt readout plus the station line above it
            // and the BW / STEP line below; at 118 the last line was clipped.
            header.heightAnchor.constraint(equalToConstant: UI.H(168)),

            bar.topAnchor.constraint(equalTo: header.bottomAnchor),
            bar.leadingAnchor.constraint(equalTo: presetList.trailingAnchor),
            bar.trailingAnchor.constraint(equalTo: options.leadingAnchor),
            bar.heightAnchor.constraint(equalToConstant: S(50)),

            spectrum.topAnchor.constraint(equalTo: bar.bottomAnchor),
            spectrum.leadingAnchor.constraint(equalTo: presetList.trailingAnchor),
            spectrum.trailingAnchor.constraint(equalTo: options.leadingAnchor),

            options.topAnchor.constraint(equalTo: bar.bottomAnchor),
            options.trailingAnchor.constraint(equalTo: rail.leadingAnchor),
            options.bottomAnchor.constraint(equalTo: bottom.topAnchor),
            options.widthAnchor.constraint(equalToConstant: S(228)),

            rail.topAnchor.constraint(equalTo: top.bottomAnchor),
            rail.trailingAnchor.constraint(equalTo: trailingAnchor),
            rail.bottomAnchor.constraint(equalTo: bottom.topAnchor),
            rail.widthAnchor.constraint(equalToConstant: S(72)),
            spectrum.bottomAnchor.constraint(equalTo: bottom.topAnchor),

            bottom.leadingAnchor.constraint(equalTo: leadingAnchor),
            bottom.trailingAnchor.constraint(equalTo: trailingAnchor),
            bottom.bottomAnchor.constraint(equalTo: bottomAnchor),
            bottom.heightAnchor.constraint(equalToConstant: S(64)),
        ])

        // Mode first, then frequency — the order the dial's preset cycle uses.
        // Sending the frequency alone put the receiver on an FM channel while
        // still demodulating AM, which is silence.
        presetList.onPick = { p in
            Receiver.mode(p.mode)
            Receiver.tune(hz: Int(p.freq))
        }
        // Label stations on the trace. The names come from the receiver's own
        // JP DB lookup rather than from the preset text, so a label on the
        // spectrum reads the same as the station line above the frequency.
        Receiver.stations { [weak self] list in self?.spectrum.markers = list; self?.spectrum.needsDisplay = true }
    }

    private var smoothSpeed = 30
    private var currentStepHz = 0
    private var currentFreqHz: Double = 0

    /// Step the VFO, snapping onto the step's grid first when the receiver is
    /// off it. Japanese medium wave sits on multiples of 9 kHz, so a receiver
    /// parked on 960 kHz (left there by a coarser step) walks 969, 978, … and
    /// never lands on a station. A real radio snaps to the channel grid on the
    /// first press; this does the same, in the direction of travel.
    private func tuneStep(_ dir: Int) {
        let step = Double(currentStepHz)
        guard step > 0, currentFreqHz > 0 else { Receiver.tune(ticks: dir); return }
        let offGrid = currentFreqHz.truncatingRemainder(dividingBy: step) != 0
        if offGrid {
            let snapped = dir > 0 ? (currentFreqHz / step).rounded(.up) * step
                                  : (currentFreqHz / step).rounded(.down) * step
            Receiver.tune(hz: Int(snapped))
        } else {
            Receiver.tune(ticks: dir)
        }
    }

    /// Render the step menu from the receiver's ladder and select what is in
    /// force — including a value set from the deck while this app was open.
    func adoptStep(_ stepHz: Int, _ values: [Int]) {
        if !values.isEmpty, values != stepValues {
            stepValues = values
            stepPop.removeAllItems()
            stepPop.addItems(withTitles: values.map { formatStep(Double($0)) })
        }
        if let i = stepValues.firstIndex(of: stepHz) { stepPop.selectItem(at: i) }
    }

    /// Render the controls from what the receiver reports, not from what we
    /// asked for: the endpoint clamps, and the deck's FFT dial can change these
    /// too.
    func adoptSpectrum(_ size: Int, _ rate: Int, _ speed: Int) {
        fftPop.selectItem(withTitle: String(size))
        fpsPop.selectItem(withTitle: String(rate))
        smoothSpeed = speed
        // SDR++'s units: the averaging window is 10 / speed seconds, so a
        // SMALLER number is smoother. The seconds sit next to the field so that
        // is not a riddle. Don't fight the user mid-edit.
        if window?.firstResponder !== smoothField.currentEditor() {
            smoothField.stringValue = String(speed)
        }
        smoothStepper.integerValue = speed
        avgLabel.stringValue = String(format: "(%.2fs)", 10.0 / Double(max(1, speed)))
    }

    /// Panels in layout order, for the debug dump. Captured at layout time —
    /// they are locals in the setup, not properties.
    private(set) var debugPanelRefs: [(String, NSView)] = []
    func debugPanels() -> [(String, NSView)] { debugPanelRefs }

    private func syncRange() {
        dbLabel.stringValue = String(format: "%.0f / %.0f dB", spectrum.dbFloor, spectrum.dbCeil)
        spectrum.needsDisplay = true
    }

    /// Depth readout. Shown in seconds because that is what the user is asking
    /// for when they reach for this; a dash until enough frames have arrived to
    /// time the feed, rather than a made-up number from a nominal rate.
    func syncWaterfallSpan() {
        let secs = spectrum.wfSpanSeconds
        wfLabel.stringValue = secs > 0
            ? (secs < 60 ? String(format: "%.0fs", secs)
                         : String(format: "%.0fm%02ds", secs / 60, Int(secs) % 60))
            : "--"
    }

    private func meterRow(_ name: String, _ bar: MeterBar, _ num: NSTextField) -> NSStackView {
        bar.translatesAutoresizingMaskIntoConstraints = false
        bar.heightAnchor.constraint(equalToConstant: S(11)).isActive = true
        // Preferred, not fixed. A meter reads fine at half this width, and the
        // pair of them plus the readout beside each was part of what stopped
        // the window narrowing at all.
        let wide = bar.widthAnchor.constraint(equalToConstant: S(250))
        wide.priority = .defaultLow
        wide.isActive = true
        bar.widthAnchor.constraint(greaterThanOrEqualToConstant: S(120)).isActive = true
        let row = NSStackView(views: [label(name, mono(18), P.faint), bar, num])
        row.orientation = .horizontal; row.spacing = 8; row.alignment = .centerY
        return row
    }

    private func button(_ title: String, _ action: @escaping () -> Void) -> NSButton {
        let b = NSButton(title: title, target: ButtonBox.shared, action: #selector(ButtonBox.fire(_:)))
        b.bezelStyle = .rounded
        b.font = mono(16)
        ButtonBox.shared.actions[ObjectIdentifier(b)] = action
        return b
    }

    private func embed(_ inner: NSView, in outer: NSView, inset: CGFloat) {
        inner.translatesAutoresizingMaskIntoConstraints = false
        outer.addSubview(inner)
        NSLayoutConstraint.activate([
            inner.leadingAnchor.constraint(equalTo: outer.leadingAnchor, constant: inset),
            inner.trailingAnchor.constraint(equalTo: outer.trailingAnchor, constant: -inset),
            inner.centerYAnchor.constraint(equalTo: outer.centerYAnchor),
        ])
    }

    // MARK: refresh

    private static let jst: DateFormatter = {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd HH:mm:ss"
        f.timeZone = TimeZone(identifier: "Asia/Tokyo"); return f
    }()
    private static let utc: DateFormatter = {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd HH:mm:ss"
        f.timeZone = TimeZone(identifier: "UTC"); return f
    }()

    func refresh() {
        let now = Date()
        clockJST.stringValue = Self.jst.string(from: now)
        clockUTC.stringValue = Self.utc.string(from: now)

        let s = Receiver.status()
        let live = s.fresh && s.connected && s.enabled
        linkDot.layer?.backgroundColor = (live ? P.accent : P.faint).cgColor
        linkLabel.stringValue = s.fresh
            ? (s.connected ? "\(s.host):\(s.port)" : "link down")
            : "receiver not running"
        linkLabel.textColor = s.fresh && s.connected ? P.dim : P.warn
        deviceLabel.stringValue = s.device
        iqLabel.stringValue = s.iqRateHz > 0
            ? String(format: "IQ %.0fk  DEC %d", s.iqRateHz / 1000, s.decStage) : ""
        dropsLabel.stringValue = s.iqRateHz > 0 ? "drops \(s.audioDrops)" : ""
        // A non-zero drop count is the audible-glitch signature, so it stops
        // being a grey footnote the moment it moves off zero.
        dropsLabel.textColor = s.audioDrops > 0 ? P.warn : P.faint
        if s.audioSink == "icecast" {
            outLabel.stringValue = "OUT ICECAST"
            outLabel.textColor = P.accent
        } else {
            outLabel.stringValue = s.audioDevice.isEmpty ? "" : "OUT \(s.audioDevice)"
            outLabel.textColor = P.faint
        }

        freqView.set(freqHz: s.freqHz)
        modeChip.stringValue = modeName(s.mode)
        stereoBadge.isHidden = !s.stereo
        for (i, pad) in modePads.enumerated() {
            let name = ["WFM", "NFM", "AM", "USB", "LSB", "CW"][i]
            pad.isOn = (MODE_NAMES.firstIndex(of: name) ?? -1) == s.mode
        }
        mutePad.isOn = s.muted
        powerPad.isOn = s.enabled
        stationLabel.stringValue = s.station.isEmpty ? "—" : s.station

        sBar.value = live ? max(0, min(1, (s.rssiDbfs + 100) / 90)) : 0
        nBar.value = live ? max(0, min(1, s.snrDb / 60)) : 0
        sNum.stringValue = live ? String(format: "%.0f dBFS", s.rssiDbfs) : "—"
        nNum.stringValue = live ? String(format: "%.0f dB", s.snrDb) : "—"

        currentFreqHz = s.freqHz
        spectrum.bandwidthHz = s.bandwidthHz
        bwLabel.stringValue = s.bandwidthHz > 0
            ? (s.bandwidthHz >= 1000 ? String(format: "%.0f kHz", s.bandwidthHz / 1000)
                                     : String(format: "%.0f Hz", s.bandwidthHz))
            : "—"
        if s.tuneStepHz > 0, Int(s.tuneStepHz) != currentStepHz {
            currentStepHz = Int(s.tuneStepHz)
            adoptStep(currentStepHz, stepValues)
        }
        stepLabel.stringValue = s.tuneStepHz > 0
            ? (s.tuneStepHz >= 1000 ? String(format: "%.0f kHz", s.tuneStepHz / 1000)
                                    : String(format: "%.0f Hz", s.tuneStepHz))
            : "—"

        volBar.level = s.volume
        volBar.muted = s.muted
        volLabel.stringValue = String(format: "%.0f%%", s.volume * 100)
        volLabel.textColor = s.muted ? P.warn : P.dim
        muteLabel.stringValue = ""
        presetList.markCurrent(freqHz: s.freqHz)
    }
}

/// NSButton needs a target/action pair; this keeps the closures alive without
/// one subclass per button.
final class ButtonBox: NSObject {
    static let shared = ButtonBox()
    var actions: [ObjectIdentifier: () -> Void] = [:]
    @objc func fire(_ sender: NSButton) { actions[ObjectIdentifier(sender)]?() }
}

/// A button that shows its state in its colour.
///
/// AppKit's stock button gives a system-tinted "on" that is nearly invisible on
/// a dark panel, so which demod mode is live, whether the output is muted and
/// whether the receiver is powered were all invisible until you read the state
/// somewhere else on screen. This draws itself: filled and dark-on-accent when
/// on, outlined and dim when off.
final class TogglePad: NSView {
    private let title: String
    private let font: NSFont
    private let onColor: NSColor
    private let action: () -> Void
    /// Momentary controls (tune, volume, preset stepping) have no lasting
    /// state — they flash on press and never latch.
    private let momentary: Bool
    private var pressed = false

    var isOn = false { didSet { if isOn != oldValue { needsDisplay = true } } }

    init(_ title: String, font: NSFont, onColor: NSColor = P.accent,
         momentary: Bool = false, action: @escaping () -> Void) {
        self.title = title; self.font = font; self.onColor = onColor
        self.momentary = momentary; self.action = action
        super.init(frame: .zero)
    }
    required init?(coder: NSCoder) { fatalError() }

    override var intrinsicContentSize: NSSize {
        let w = (title as NSString).size(withAttributes: [.font: font]).width
        return NSSize(width: ceil(w) + 22, height: 34)
    }

    override func mouseDown(with event: NSEvent) { pressed = true; needsDisplay = true }
    override func mouseUp(with event: NSEvent) {
        pressed = false; needsDisplay = true
        if bounds.contains(convert(event.locationInWindow, from: nil)) { action() }
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let box = bounds.insetBy(dx: 0.75, dy: 0.75)
        let path = CGPath(roundedRect: box, cornerWidth: 5, cornerHeight: 5, transform: nil)
        let lit = isOn && !momentary
        ctx.addPath(path)
        ctx.setFillColor(pressed ? onColor.withAlphaComponent(0.45).cgColor
                                 : (lit ? onColor.cgColor : P.panel.cgColor))
        ctx.fillPath()
        ctx.addPath(path)
        ctx.setStrokeColor(lit ? onColor.cgColor : P.line.cgColor)
        ctx.setLineWidth(1.5)
        ctx.strokePath()

        let color: NSColor = lit ? NSColor(white: 0.05, alpha: 1) : P.text
        let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color]
        let size = (title as NSString).size(withAttributes: attrs)
        (title as NSString).draw(at: CGPoint(x: (bounds.width - size.width) / 2,
                                             y: (bounds.height - size.height) / 2),
                                 withAttributes: attrs)
    }
}

/// Text in a rounded outline, centred on both axes.
///
/// An NSTextField in a fixed-height box sits on its baseline, which leaves the
/// glyphs riding high inside the border — visible immediately on a two-colour
/// badge like this one. Drawing the string ourselves puts it where the box says.
final class BadgeView: NSView {
    var text: String { didSet { needsDisplay = true } }
    var color: NSColor { didSet { needsDisplay = true } }
    private let font: NSFont

    init(text: String, font: NSFont, color: NSColor) {
        self.text = text; self.font = font; self.color = color
        super.init(frame: .zero)
    }
    required init?(coder: NSCoder) { fatalError() }

    override var intrinsicContentSize: NSSize {
        let s = (text as NSString).size(withAttributes: [.font: font])
        return NSSize(width: ceil(s.width) + 18, height: ceil(s.height) + 10)
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let box = bounds.insetBy(dx: 0.75, dy: 0.75)
        let path = CGPath(roundedRect: box, cornerWidth: 4, cornerHeight: 4, transform: nil)
        ctx.addPath(path)
        ctx.setStrokeColor(color.cgColor)
        ctx.setLineWidth(1.5)
        ctx.strokePath()

        // Negative strokeWidth means "fill AND stroke", which thickens the
        // glyphs beyond what the font's heaviest weight gives — monospaced
        // system faces top out well short of a badge's worth of weight.
        let attrs: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: color,
            .strokeColor: color,
            .strokeWidth: -4.0,
        ]
        let size = (text as NSString).size(withAttributes: [.font: font])
        (text as NSString).draw(at: CGPoint(x: (bounds.width - size.width) / 2,
                                            y: (bounds.height - size.height) / 2),
                                withAttributes: attrs)
    }
}

/// Volume as a bar you can click and drag, not just a number and two buttons.
final class VolumeBar: NSView {
    var level: Double = 0 { didSet { if level != oldValue { needsDisplay = true } } }
    var muted = false { didSet { if muted != oldValue { needsDisplay = true } } }
    var onSet: ((Double) -> Void)?

    override var intrinsicContentSize: NSSize { NSSize(width: 190, height: 22) }

    private func apply(_ event: NSEvent) {
        let x = convert(event.locationInWindow, from: nil).x
        onSet?(max(0, min(1, Double(x / max(1, bounds.width)))))
    }
    override func mouseDown(with event: NSEvent) { apply(event) }
    override func mouseDragged(with event: NSEvent) { apply(event) }

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let h: CGFloat = 10
        let y = (bounds.height - h) / 2
        let track = CGRect(x: 0, y: y, width: bounds.width, height: h)
        ctx.addPath(CGPath(roundedRect: track, cornerWidth: 5, cornerHeight: 5, transform: nil))
        ctx.setFillColor(NSColor(red: 0.137, green: 0.149, blue: 0.169, alpha: 1).cgColor)
        ctx.fillPath()

        let w = bounds.width * CGFloat(max(0, min(1, level)))
        if w > 1 {
            let fill = CGRect(x: 0, y: y, width: w, height: h)
            ctx.addPath(CGPath(roundedRect: fill, cornerWidth: 5, cornerHeight: 5, transform: nil))
            // Muted output still has a level — showing it in the warning colour
            // says "this is where it will come back to", which a greyed-out bar
            // does not.
            ctx.setFillColor((muted ? P.warn : P.text).cgColor)
            ctx.fillPath()
        }
    }
}

final class MeterBar: NSView {
    var tint: NSColor = P.accent { didSet { needsDisplay = true } }
    var value: Double = 0 { didSet { needsDisplay = true } }
    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        ctx.setFillColor(NSColor(red: 0.137, green: 0.149, blue: 0.169, alpha: 1).cgColor)
        ctx.fill(bounds)
        ctx.setFillColor(tint.cgColor)
        ctx.fill(CGRect(x: 0, y: 0, width: bounds.width * CGFloat(max(0, min(1, value))), height: bounds.height))
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private var view: MainView!
    private var feed: SpectrumFeed?
#if STANDALONE
    private let radio = LocalRadio()
    private lazy var server = AppServer(radio: radio)
    private var direct = false
    private var lastLabelledFreq: Double = -1
    /// JP region for the station database. Follows the plugin's setting when
    /// the feed is up, so the two do not disagree about which 関東 is meant.
    private var region: StationLabel.Region {
        StationLabel.Region(rawValue: radio.config.jpRegion) ?? .kanto
    }
#endif
    private var timer: Timer?
    private var aliveTimer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
#if STANDALONE
        Receiver.seedData()
        // Before the view is built: every constraint constant and font size is
        // captured at construction, so a later change needs a relaunch.
        UI.scale = UI.from(RadioConfig.load().uiScale)
#endif
        Receiver.touchAlive()
        view = MainView(frame: NSRect(x: 0, y: 0, width: 1440, height: 860))
        window = NSWindow(contentRect: view.frame,
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Deck RX"
        window.contentView = view
        window.appearance = NSAppearance(named: .darkAqua)
        window.isReleasedWhenClosed = false
        // A floor rather than a wall: below this the spectrum is too narrow to
        // read and the preset list crowds it out. Above it the window is free.
        window.contentMinSize = NSSize(width: S(1040), height: S(700))
        // DECK_RX_LAYOUT_DEBUG=1 prints what each panel insists on. Which row
        // sets the window's minimum is not guessable from the constraint list —
        // two attempts at narrowing it changed nothing because they targeted
        // the wrong row.
        if ProcessInfo.processInfo.environment["DECK_RX_LAYOUT_DEBUG"] == "1" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
                guard let self else { return }
                // stderr, not print: stdout is buffered and the dump was lost
                // every time the process was killed to read it.
                var out = ""
                for (name, v) in self.view.debugPanels() {
                    let f = v.fittingSize
                    out += String(format: "panel %-12@ fitting %.0f x %.0f\n", name as NSString, f.width, f.height)
                }
                out += String(format: "UI.scale %.2f\n", UI.scale)
                let w = self.window.frame.size
                out += String(format: "window %.0f x %.0f  min %.0f x %.0f\n", w.width, w.height,
                              self.window.contentMinSize.width, self.window.contentMinSize.height)
                FileHandle.standardError.write(Data(out.utf8))
            }
        }
        window.setFrameAutosaveName("deckRxReceiver")
        window.makeKeyAndOrderFront(nil)
        buildMenu()
        NSApp.activate(ignoringOtherApps: true)

        feed = SpectrumFeed { [weak self] frame in
            guard let self else { return }
#if STANDALONE
            guard !self.direct else { return }             // DIRECT wins while it is on
#endif
            self.view.spectrum.accept(frame)
        }
        feed?.start()

#if STANDALONE
        radio.onFrame = { [weak self] frame in
            guard let self, self.direct else { return }
            self.view.spectrum.accept(frame)
            // Republish for anything reading the socket — the deck, knobctl,
            // whatever else speaks it. Free when nobody is connected.
            self.server.publish(frame)
        }
        server.onStateChange = { [weak self] in self?.syncSource() }
        radio.onState = { [weak self] in self?.syncSource() }
        view.onSourceToggle = { [weak self] in self?.toggleSource() }
        view.onImportPresets = { [weak self] in
            guard let self else { return }
            do {
                let r = try PresetStore.importFromSdrpp()
                self.view.srcLabel.stringValue =
                    "import +\(r.added) skip \(r.skipped) dedup \(r.migrated)"
                self.view.srcLabel.textColor = P.dim
                self.view.presetList.reload()
            } catch {
                self.view.srcLabel.stringValue = "import failed: \(error.localizedDescription)"
                self.view.srcLabel.textColor = P.warn
            }
        }
        view.onNrToggle = { [weak self] in
            guard let self, self.direct else { self?.view.nrPad.isOn = false; return }
            self.radio.iqNrEnabled.toggle()
            self.view.nrPad.isOn = self.radio.iqNrEnabled
            self.radio.config.fmIfnr = self.radio.iqNrEnabled
            self.radio.config.save()
        }
        view.onLevelToggle = { [weak self] in
            guard let self, self.direct else { self?.view.levelPad.isOn = false; return }
            self.radio.levelingEnabled.toggle()
            self.view.levelPad.isOn = self.radio.levelingEnabled
        }
        view.onFftSize = { [weak self] size in
            guard let self, self.direct else { return false }
            self.radio.fftSize = size
            return true
        }
        view.onAudioToggle = { [weak self] in
            guard let self else { return }
            // Audio only means anything on the app's own connection; through
            // the plugin the plugin owns the sound card.
            guard self.direct else { self.view.srcAudioPad.isOn = false; return }
            self.radio.audioEnabled.toggle()
            self.view.srcAudioPad.isOn = self.radio.audioEnabled
            self.syncSource()
        }
#endif
        // Seed the display controls from the receiver's live settings.
        Receiver.spectrum { [weak self] size, rate, avg in self?.view.adoptSpectrum(size, rate, avg) }
        Receiver.step { [weak self] step, values in self?.view.adoptStep(step, values) }

        view.refresh()
        var tick = 0
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.view.refresh()
            // The options panel polls the receiver over HTTP, so it runs at
            // 1 Hz rather than with the 4 Hz status read — nothing in it moves
            // on its own, it only has to notice a change made from the deck.
            tick += 1
            if tick % 4 == 0 { self.view.options.refresh() }
            // Depth in seconds moves with the measured frame rate and with the
            // window height, so it is refreshed rather than set once.
            self.view.syncWaterfallSpan()
        }
        view.options.refresh()
#if STANDALONE
        // Honour autoDirect after the window is up, so a failure to connect is
        // visible in the label rather than happening before anything is drawn.
        if radio.config.autoDirect {
            toggleSource()
            if radio.config.autoAudio {
                radio.audioEnabled = true
                view.srcAudioPad.isOn = true
                syncSource()
            }
        }
#endif
        // The plugin only publishes the status feed while this flag is fresh.
        aliveTimer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { _ in Receiver.touchAlive() }
    }

#if STANDALONE
    /// DIRECT: the app connects to SpyServer itself instead of reading the
    /// plugin's socket. Server address and tuned frequency come from the status
    /// feed, so this follows whatever the receiver is already set to rather than
    /// introducing a second place to configure the same thing.
    private func toggleSource() {
        direct.toggle()
        if direct {
            // Prefer the live feed when the plugin happens to be up — following
            // it avoids a jump when switching — but fall back to the app's own
            // config, which is what a machine with no plugin has.
            let s = Receiver.status_fromFeed()
            radio.mode = s.fresh ? s.mode : radio.config.mode
            radio.connect(host: s.fresh && !s.host.isEmpty ? s.host : nil,
                          port: s.fresh && s.port > 0 ? UInt16(s.port) : nil,
                          frequency: s.fresh && s.freqHz > 0 ? UInt32(s.freqHz) : nil)
            installDirectControl()
            // Serve the plugin's three interfaces so a front-end can drive this
            // app instead. Silently declines when the plugin already owns them.
            server.start()
        } else {
            server.stop()
            Receiver.direct = nil
            radio.iqNrEnabled = false
            radio.levelingEnabled = false
            view.nrPad.isOn = false
            view.levelPad.isOn = false
            radio.audioEnabled = false
            view.srcAudioPad.isOn = false
            radio.disconnect()
        }
        syncSource()
    }

    /// Routes control and the status readout at the app's own receiver, so the
    /// window shows what it is actually doing rather than the last thing the
    /// plugin said before it was stopped.
    private func installDirectControl() {
        Receiver.direct = Receiver.DirectControl(
            status: { [weak self] in
                guard let self else { return Receiver.Status() }
                var s = Receiver.status_fromFeed()   // keep station name etc. when the plugin is up
                s.connected = self.radio.isConnected
                s.enabled = self.radio.isConnected
                s.fresh = true
                s.freqHz = Double(self.radio.frequency)
                s.mode = self.radio.mode
                s.iqRateHz = Double(self.radio.iqRateHz)
                s.tuneStepHz = self.radio.tuneStepHz
                s.volume = self.radio.volume
                s.muted = self.radio.muted
                s.device = self.radio.deviceInfo.map { "SpyServer type \($0.deviceType)" } ?? s.device
                s.audioSink = self.radio.audioEnabled ? "local" : "off"
                // Label the frequency ourselves — the feed's station name is
                // whatever the plugin last tuned, which is not where we are.
                if let name = StationLabel.lookup(freqHz: s.freqHz, region: self.region) {
                    s.station = name
                } else if s.station.isEmpty == false, self.lastLabelledFreq != s.freqHz {
                    s.station = ""
                }
                self.lastLabelledFreq = s.freqHz
                return s
            },
            tuneHz: { [weak self] hz in self?.radio.setFrequency(UInt32(max(0, hz))) },
            tuneTicks: { [weak self] t in self?.radio.tune(ticks: t) },
            mode: { [weak self] m in self?.radio.mode = m },
            volume: { [weak self] v in self?.radio.volume = v },
            toggleMute: { [weak self] in
                guard let self else { return }
                self.radio.muted.toggle()
            })
    }

    private func syncSource() {
        view.srcPad.isOn = direct
        if !direct {
            view.srcLabel.stringValue = "via plugin"
            view.srcLabel.textColor = P.faint
        } else if let e = radio.lastError {
            view.srcLabel.stringValue = e
            view.srcLabel.textColor = P.warn
        } else if radio.isConnected {
            let a = radio.audioEnabled ? String(format: " audio %.1f k", radio.audioRate / 1000) : ""
            // SpyServer hands control to the first client only. Without this
            // the window looks fine and tuning simply does nothing.
            let ctl = radio.canControl ? "" : " · LISTEN ONLY (another client has the device)"
            let srv = server.isServing ? " serving" : (server.portBusy ? " (plugin owns :8771)" : "")
            let r = radio.deviceInfo.map { "IQ \(Int(Double($0.maxSampleRate) / 1000)) k max" } ?? ""
            view.srcLabel.stringValue = "direct \(r)\(a)\(srv)\(ctl)"
            view.srcLabel.textColor = radio.canControl ? P.dim : P.warn
            view.srcLabel.textColor = P.dim
        } else {
            view.srcLabel.stringValue = "connecting..."
            view.srcLabel.textColor = P.faint
        }
    }

#endif

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

    /// Built by hand: there is no nib, so without this the app has no menu bar
    /// at all — no About, and no Cmd-Q either. The Quit item is the one that
    /// matters; an app you can only close by killing the process is not
    /// finished.
    private func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        main.addItem(appItem)

        let name = Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String ?? "Deck RX"
        let appMenu = NSMenu(title: name)
        appMenu.addItem(withTitle: "\(name) について",
                        action: #selector(showAbout), keyEquivalent: "")
            .target = self
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "\(name) を隠す",
                        action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let others = appMenu.addItem(withTitle: "ほかを隠す",
                                     action: #selector(NSApplication.hideOtherApplications(_:)),
                                     keyEquivalent: "h")
        others.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "すべてを表示",
                        action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "\(name) を終了",
                        action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        // Window menu, so close and minimise have their usual keys. Cmd-W
        // closes the only window, which terminates the app — see
        // applicationShouldTerminateAfterLastWindowClosed above.
        let windowItem = NSMenuItem()
        main.addItem(windowItem)
        let windowMenu = NSMenu(title: "ウインドウ")
        windowMenu.addItem(withTitle: "しまう",
                           action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "閉じる",
                           action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowItem.submenu = windowMenu
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = main
    }

    /// Says what this build is and what it is talking to. The receiver's
    /// address is the useful half: with two bundles installed and a config
    /// seeded from several places, "which one is this and where is it pointed"
    /// is a real question.
    @objc private func showAbout() {
        let info = Bundle.main.infoDictionary ?? [:]
        let name = info["CFBundleName"] as? String ?? "Deck RX"
        let version = info["CFBundleShortVersionString"] as? String ?? "?"
        let build = info["CFBundleVersion"] as? String ?? "?"
        let arch: String
#if arch(arm64)
        arch = "arm64"
#else
        arch = "x86_64"
#endif
        var lines = ["\(name) \(version) (build \(build), \(arch))"]
#if STANDALONE
        let s = Receiver.status()
        lines.append("Standalone receiver — connects to SpyServer itself")
        lines.append("Server: \(s.host.isEmpty ? "—" : "\(s.host):\(s.port)")")
        lines.append(s.connected ? "Connected" : "Not connected")
#else
        lines.append("Front-end — drives the Stream Deck plugin's receiver")
#endif
        lines.append("Settings: ~/Library/Application Support/deck-rx/")

        NSApp.orderFrontStandardAboutPanel(options: [
            .applicationName: name,
            .applicationVersion: "\(version) (\(arch))",
            .credits: NSAttributedString(
                string: lines.dropFirst().joined(separator: "\n"),
                attributes: [.font: NSFont.systemFont(ofSize: 11),
                             .foregroundColor: NSColor.labelColor]),
        ])
        NSApp.activate(ignoringOtherApps: true)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
