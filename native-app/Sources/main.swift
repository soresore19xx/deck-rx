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
    static let text    = NSColor(red: 0.863, green: 0.871, blue: 0.886, alpha: 1) // #DCDEE2
    static let dim     = NSColor(red: 0.604, green: 0.627, blue: 0.655, alpha: 1) // #9AA0A7
    static let faint   = NSColor(red: 0.435, green: 0.459, blue: 0.486, alpha: 1) // #6F757C
    static let accent  = NSColor(red: 0.349, green: 0.851, blue: 0.451, alpha: 1) // #59D973
    static let blue    = NSColor(red: 0.400, green: 0.702, blue: 0.949, alpha: 1) // #66B3F2
    static let warn    = NSColor(red: 0.949, green: 0.749, blue: 0.349, alpha: 1) // #F2BF59
}

func mono(_ size: CGFloat, _ w: NSFont.Weight = .regular) -> NSFont {
    NSFont.monospacedSystemFont(ofSize: size, weight: w)
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

final class PresetList: NSView {
    private let stack = NSStackView()
    private let scroll = NSScrollView()
    private var rows: [(NSView, Receiver.Preset)] = []
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
        for (v, _) in rows { stack.removeArrangedSubview(v); v.removeFromSuperview() }
        rows.removeAll()
        for p in presets {
            let row = NSView()
            row.translatesAutoresizingMaskIntoConstraints = false
            let (num, unit) = formatFreq(p.freq)
            let f = label(num, mono(15), P.text)
            let u = label(unit, mono(11), P.faint)
            let n = label(p.name, .systemFont(ofSize: 14), P.dim)
            let m = label(modeName(p.mode), mono(11), P.faint)
            n.lineBreakMode = .byTruncatingTail
            for v in [f, u, n, m] { v.translatesAutoresizingMaskIntoConstraints = false; row.addSubview(v) }
            NSLayoutConstraint.activate([
                row.heightAnchor.constraint(equalToConstant: 28),
                f.leadingAnchor.constraint(equalTo: row.leadingAnchor, constant: 10),
                f.widthAnchor.constraint(equalToConstant: 74),
                f.centerYAnchor.constraint(equalTo: row.centerYAnchor),
                u.leadingAnchor.constraint(equalTo: f.trailingAnchor, constant: 4),
                u.widthAnchor.constraint(equalToConstant: 30),
                u.firstBaselineAnchor.constraint(equalTo: f.firstBaselineAnchor),
                n.leadingAnchor.constraint(equalTo: u.trailingAnchor, constant: 6),
                n.trailingAnchor.constraint(lessThanOrEqualTo: m.leadingAnchor, constant: -6),
                n.centerYAnchor.constraint(equalTo: row.centerYAnchor),
                // -24, not -10: the vertical scroller overlays the row's
                // trailing edge and would clip the mode column to "A" / "WF".
                m.trailingAnchor.constraint(equalTo: row.trailingAnchor, constant: -24),
                m.centerYAnchor.constraint(equalTo: row.centerYAnchor),
            ])
            row.wantsLayer = true
            stack.addArrangedSubview(row)
            NSLayoutConstraint.activate([
                row.leadingAnchor.constraint(equalTo: stack.leadingAnchor),
                row.trailingAnchor.constraint(equalTo: stack.trailingAnchor),
            ])
            rows.append((row, p))
        }
    }

    /// Highlight whichever row the receiver is actually on. Frequency is the
    /// identity here: the plugin may have been retuned by a dial or a knob.
    func markCurrent(freqHz: Double) {
        for (row, p) in rows {
            let on = abs(p.freq - freqHz) < 1
            row.layer?.backgroundColor = on
                ? NSColor(red: 0.110, green: 0.165, blue: 0.125, alpha: 1).cgColor
                : NSColor.clear.cgColor
        }
    }

    override func mouseDown(with event: NSEvent) {
        let inStack = stack.convert(event.locationInWindow, from: nil)
        for (row, preset) in rows where row.frame.contains(inStack) {
            onPick?(preset); return
        }
    }
}

// MARK: - window

final class MainView: NSView {
    let spectrum = SpectrumView(frame: .zero)
    let presetList = PresetList(frame: .zero)

    private let clockJST = label("—", mono(13), P.text)
    private let clockUTC = label("—", mono(13), P.dim)
    private let linkDot = panelView(P.faint)
    private let linkLabel = label("—", mono(13), P.dim)

    private let stationLabel = label("—", .systemFont(ofSize: 17), P.text)
    private let freqLabel = label("—", mono(68, .bold), .white)
    private let unitLabel = label("", mono(26, .medium), P.text)
    private let modeChip = label("—", mono(16, .medium), P.text)
    private let bwLabel = label("—", mono(13), P.dim)
    private let stepLabel = label("—", mono(13), P.dim)

    private let sBar = MeterBar(); private let sNum = label("—", mono(14), P.text)
    private let nBar = MeterBar(); private let nNum = label("—", mono(14), P.text)

    private let volLabel = label("—", mono(13), P.dim)

    // Spectrum display controls. FFT size / framerate / averaging live on the
    // receiver (the deck's FFT dial shares that pipeline), so those three are
    // pushed to /spectrum; peak hold and the dB window are this app's own view
    // of the same data and stay local.
    private let fftPop = NSPopUpButton()
    private let fpsPop = NSPopUpButton()
    private let avgLabel = label("0.40", mono(13), P.text)
    private let holdButton = NSButton()
    private let dbLabel = label("−100 / −20 dB", mono(13), P.dim)
    private let stepPop = NSPopUpButton()
    private let zoomPop = NSPopUpButton()
    private var stepValues: [Int] = []
    private let muteLabel = label("", mono(13, .medium), P.warn)

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
        let topRow = NSStackView(views: [
            label("deck", .systemFont(ofSize: 15, weight: .bold), P.text),
            linkDot, linkLabel,
            NSView(),
            label("JST", mono(11), P.faint), clockJST,
            label("UTC", mono(11), P.faint), clockUTC,
        ])
        topRow.orientation = .horizontal
        topRow.spacing = 8
        topRow.alignment = .centerY
        linkDot.layer?.cornerRadius = 3
        linkDot.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            linkDot.widthAnchor.constraint(equalToConstant: 6),
            linkDot.heightAnchor.constraint(equalToConstant: 6),
        ])
        embed(topRow, in: top, inset: 12)

        // frequency header
        let header = panelView(NSColor(red: 0.082, green: 0.086, blue: 0.102, alpha: 1))
        let freqRow = NSStackView(views: [freqLabel, unitLabel, modeChip])
        freqRow.orientation = .horizontal; freqRow.alignment = .lastBaseline; freqRow.spacing = 8
        let meters = NSStackView(views: [meterRow("S", sBar, sNum), meterRow("N", nBar, nNum)])
        meters.orientation = .vertical; meters.spacing = 6; meters.alignment = .leading
        let detail = NSStackView(views: [
            label("BW", mono(11), P.faint), bwLabel,
            label("STEP", mono(11), P.faint), stepLabel,
        ])
        detail.orientation = .horizontal; detail.spacing = 6; detail.alignment = .firstBaseline
        let left = NSStackView(views: [stationLabel, freqRow, detail])
        left.orientation = .vertical; left.alignment = .leading; left.spacing = 4
        let headerRow = NSStackView(views: [left, NSView(), meters])
        headerRow.orientation = .horizontal; headerRow.alignment = .centerY; headerRow.spacing = 20
        embed(headerRow, in: header, inset: 14)

        // bottom transport
        let bottom = panelView()
        let volDown = button("VOL −") { Receiver.volume(delta: -3) }
        let volUp   = button("VOL +") { Receiver.volume(delta: 3) }
        let mute    = button("MUTE")  { Receiver.toggleMute() }
        let prev    = button("◀ PRESET") { Receiver.preset(step: -1) }
        let next    = button("PRESET ▶") { Receiver.preset(step: 1) }
        let down    = button("− TUNE") { [weak self] in self?.tuneStep(-1) }
        let up      = button("TUNE +") { [weak self] in self?.tuneStep(1) }
        let power   = button("POWER") { Receiver.togglePower() }
        let bottomRow = NSStackView(views: [prev, next, down, up, NSView(),
                                            volLabel, muteLabel, volDown, volUp, mute, power])
        bottomRow.orientation = .horizontal; bottomRow.spacing = 6; bottomRow.alignment = .centerY
        embed(bottomRow, in: bottom, inset: 12)

        // display toolbar, between the header and the spectrum
        let bar = panelView(P.sunken)
        fftPop.addItems(withTitles: ["256", "512", "1024", "2048", "4096"])
        fftPop.font = mono(12)
        fftPop.target = ButtonBox.shared
        fftPop.action = #selector(ButtonBox.fire(_:))
        ButtonBox.shared.actions[ObjectIdentifier(fftPop)] = { [weak self] in
            guard let self, let t = self.fftPop.titleOfSelectedItem, let v = Int(t) else { return }
            Receiver.spectrum(fft: v) { size, rate, avg in self.adoptSpectrum(size, rate, avg) }
        }
        fpsPop.addItems(withTitles: ["5", "10", "15", "20", "30", "60"])
        fpsPop.font = mono(12)
        fpsPop.target = ButtonBox.shared
        fpsPop.action = #selector(ButtonBox.fire(_:))
        ButtonBox.shared.actions[ObjectIdentifier(fpsPop)] = { [weak self] in
            guard let self, let t = self.fpsPop.titleOfSelectedItem, let v = Int(t) else { return }
            Receiver.spectrum(fps: v) { size, rate, avg in self.adoptSpectrum(size, rate, avg) }
        }
        holdButton.title = "HOLD"
        holdButton.setButtonType(.pushOnPushOff)
        holdButton.bezelStyle = .rounded
        holdButton.font = mono(13)
        holdButton.target = ButtonBox.shared
        holdButton.action = #selector(ButtonBox.fire(_:))
        ButtonBox.shared.actions[ObjectIdentifier(holdButton)] = { [weak self] in
            guard let self else { return }
            self.spectrum.holdEnabled = self.holdButton.state == .on
        }
        // The VFO step lives on the receiver (the deck's dial reads the same
        // value), so the menu is built from what /step reports rather than from
        // a list hard-coded here that would drift.
        stepPop.font = mono(12)
        stepPop.target = ButtonBox.shared
        stepPop.action = #selector(ButtonBox.fire(_:))
        ButtonBox.shared.actions[ObjectIdentifier(stepPop)] = { [weak self] in
            guard let self, self.stepPop.indexOfSelectedItem >= 0,
                  self.stepPop.indexOfSelectedItem < self.stepValues.count else { return }
            let hz = self.stepValues[self.stepPop.indexOfSelectedItem]
            Receiver.step(hz: hz) { step, values in self.adoptStep(step, values) }
        }

        // Zoom is a display concern: every frame carries all the bins, so the
        // app narrows the view instead of asking for a smaller FFT.
        zoomPop.addItems(withTitles: ["1×", "2×", "4×", "8×", "16×", "32×"])
        zoomPop.font = mono(12)
        zoomPop.target = ButtonBox.shared
        zoomPop.action = #selector(ButtonBox.fire(_:))
        ButtonBox.shared.actions[ObjectIdentifier(zoomPop)] = { [weak self] in
            guard let self else { return }
            self.spectrum.zoom = pow(2, Double(self.zoomPop.indexOfSelectedItem))
        }

        let barRow = NSStackView(views: [
            label("STEP", mono(12), P.faint), stepPop,
            label("ZOOM", mono(12), P.faint), zoomPop,
            label("FFT", mono(12), P.faint), fftPop,
            label("RATE", mono(12), P.faint), fpsPop, label("fps", mono(12), P.faint),
            label("AVG", mono(12), P.faint),
            button("−") { [weak self] in self?.nudgeAvg(-0.1) }, avgLabel,
            button("+") { [weak self] in self?.nudgeAvg(0.1) },
            holdButton,
            NSView(),
            label("RANGE", mono(12), P.faint),
            button("FLOOR −") { [weak self] in self?.nudgeDb(floor: -5) },
            button("FLOOR +") { [weak self] in self?.nudgeDb(floor: 5) },
            dbLabel,
        ])
        barRow.orientation = .horizontal
        barRow.spacing = 6
        barRow.alignment = .centerY
        embed(barRow, in: bar, inset: 12)

        for v in [top, header, bottom, presetList, spectrum, bar] {
            v.translatesAutoresizingMaskIntoConstraints = false
            addSubview(v)
        }
        NSLayoutConstraint.activate([
            top.topAnchor.constraint(equalTo: topAnchor),
            top.leadingAnchor.constraint(equalTo: leadingAnchor),
            top.trailingAnchor.constraint(equalTo: trailingAnchor),
            top.heightAnchor.constraint(equalToConstant: 38),

            presetList.topAnchor.constraint(equalTo: top.bottomAnchor),
            presetList.leadingAnchor.constraint(equalTo: leadingAnchor),
            presetList.widthAnchor.constraint(equalToConstant: 286),
            presetList.bottomAnchor.constraint(equalTo: bottom.topAnchor),

            header.topAnchor.constraint(equalTo: top.bottomAnchor),
            header.leadingAnchor.constraint(equalTo: presetList.trailingAnchor),
            header.trailingAnchor.constraint(equalTo: trailingAnchor),
            header.heightAnchor.constraint(equalToConstant: 118),

            bar.topAnchor.constraint(equalTo: header.bottomAnchor),
            bar.leadingAnchor.constraint(equalTo: presetList.trailingAnchor),
            bar.trailingAnchor.constraint(equalTo: trailingAnchor),
            bar.heightAnchor.constraint(equalToConstant: 38),

            spectrum.topAnchor.constraint(equalTo: bar.bottomAnchor),
            spectrum.leadingAnchor.constraint(equalTo: presetList.trailingAnchor),
            spectrum.trailingAnchor.constraint(equalTo: trailingAnchor),
            spectrum.bottomAnchor.constraint(equalTo: bottom.topAnchor),

            bottom.leadingAnchor.constraint(equalTo: leadingAnchor),
            bottom.trailingAnchor.constraint(equalTo: trailingAnchor),
            bottom.bottomAnchor.constraint(equalTo: bottomAnchor),
            bottom.heightAnchor.constraint(equalToConstant: 50),
        ])

        presetList.onPick = { p in Receiver.tune(hz: Int(p.freq)) }
        // Label presets on the trace, the way SDR++ labels bookmarks. Only the
        // ones inside the visible span end up drawn.
        spectrum.markers = Receiver.presets().map { (freq: $0.freq, name: $0.name) }
    }

    private var avg: Double = 0.4
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
    func adoptSpectrum(_ size: Int, _ rate: Int, _ smoothing: Double) {
        fftPop.selectItem(withTitle: String(size))
        fpsPop.selectItem(withTitle: String(rate))
        avg = smoothing
        avgLabel.stringValue = String(format: "%.2f", smoothing)
    }

    private func nudgeAvg(_ d: Double) {
        let next = max(0, min(0.95, avg + d))
        Receiver.spectrum(avg: next) { [weak self] s, r, a in self?.adoptSpectrum(s, r, a) }
    }

    private func nudgeDb(floor d: Float) {
        spectrum.dbFloor = max(-140, min(spectrum.dbCeil - 10, spectrum.dbFloor + d))
        dbLabel.stringValue = String(format: "%.0f / %.0f dB", spectrum.dbFloor, spectrum.dbCeil)
        spectrum.needsDisplay = true
    }

    private func meterRow(_ name: String, _ bar: MeterBar, _ num: NSTextField) -> NSStackView {
        bar.translatesAutoresizingMaskIntoConstraints = false
        bar.heightAnchor.constraint(equalToConstant: 8).isActive = true
        bar.widthAnchor.constraint(equalToConstant: 210).isActive = true
        let row = NSStackView(views: [label(name, mono(12), P.faint), bar, num])
        row.orientation = .horizontal; row.spacing = 8; row.alignment = .centerY
        return row
    }

    private func button(_ title: String, _ action: @escaping () -> Void) -> NSButton {
        let b = NSButton(title: title, target: ButtonBox.shared, action: #selector(ButtonBox.fire(_:)))
        b.bezelStyle = .rounded
        b.font = mono(13)
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

        let (num, unit) = formatFreq(s.freqHz)
        freqLabel.stringValue = num
        unitLabel.stringValue = unit
        modeChip.stringValue = modeName(s.mode)
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

        volLabel.stringValue = String(format: "VOL %.0f%%", s.volume * 100)
        muteLabel.stringValue = s.muted ? "MUTED" : ""
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
    private var timer: Timer?
    private var aliveTimer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        Receiver.touchAlive()
        view = MainView(frame: NSRect(x: 0, y: 0, width: 1120, height: 700))
        window = NSWindow(contentRect: view.frame,
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Deck RX"
        window.contentView = view
        window.appearance = NSAppearance(named: .darkAqua)
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("deckRxReceiver")
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        feed = SpectrumFeed { [weak self] frame in self?.view.spectrum.accept(frame) }
        feed?.start()
        // Seed the display controls from the receiver's live settings.
        Receiver.spectrum { [weak self] size, rate, avg in self?.view.adoptSpectrum(size, rate, avg) }
        Receiver.step { [weak self] step, values in self?.view.adoptStep(step, values) }

        view.refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            self?.view.refresh()
        }
        // The plugin only publishes the status feed while this flag is fresh.
        aliveTimer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { _ in Receiver.touchAlive() }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
