import AppKit

/// The demod's settings, in the panel the original layout put on the right.
///
/// The deck spreads these across several dials because it has four LCDs; here
/// they all fit at once, which was the point of building a window in the first
/// place. Rows are rebuilt when the mode changes — an AM receiver has no
/// de-emphasis and an FM one has no carrier AGC, and showing both with half
/// greyed out is worse than showing what applies.
final class OptionsPanel: NSView {
    private let stack = NSStackView()
    private var live: [String: Any] = [:]
    private var mode = -1

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.backgroundColor = P.panel.cgColor
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 2
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 10),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
        ])
    }
    required init?(coder: NSCoder) { fatalError() }

    private var rx: [String: Any] = [:]

    func refresh() {
        Receiver.options { [weak self] j in self?.adopt(j) }
        Receiver.receiver { [weak self] j in
            guard let self else { return }
            self.rx = j
            self.updateValues()
        }
    }

    private func adopt(_ j: [String: Any]) {
        live = j
        let m = j["mode"] as? Int ?? -1
        if m != mode { mode = m; rebuild() } else { updateValues() }
    }

    // MARK: rows

    private var rows: [(name: String, value: NSTextField, kind: Kind)] = []
    private enum Kind { case bool, list([Double], String), text([String]), action }

    private func jpRegions() -> [String] {
        (rx["regions"] as? [String]) ?? ["kanto"]
    }
    /// "" is the system default, the same blank the deck's device list offers.
    private func audioDevices() -> [String] {
        [""] + ((rx["audioDevices"] as? [String]) ?? [])
    }

    private func header(_ t: String) -> NSView {
        let l = label(t, mono(13), P.faint)
        return l
    }

    private func row(_ title: String, _ name: String, _ kind: Kind) -> NSView {
        let t = label(title, .systemFont(ofSize: 15), P.dim)
        t.lineBreakMode = .byTruncatingTail
        // The value is the part you read; let the name lose characters first.
        t.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let v = label("—", mono(15), P.text)
        v.setContentCompressionResistancePriority(.required, for: .horizontal)
        let r = NSStackView(views: [t, NSView(), v])
        r.orientation = .horizontal
        r.spacing = 8
        r.translatesAutoresizingMaskIntoConstraints = false
        r.heightAnchor.constraint(equalToConstant: 28).isActive = true
        rows.append((name, v, kind))
        let pad = ClickRow { [weak self] in self?.cycle(name, kind) }
        pad.translatesAutoresizingMaskIntoConstraints = false
        pad.addSubview(r)
        NSLayoutConstraint.activate([
            r.leadingAnchor.constraint(equalTo: pad.leadingAnchor),
            r.trailingAnchor.constraint(equalTo: pad.trailingAnchor),
            r.topAnchor.constraint(equalTo: pad.topAnchor),
            r.bottomAnchor.constraint(equalTo: pad.bottomAnchor),
        ])
        return pad
    }

    private func rebuild() {
        for v in stack.arrangedSubviews { stack.removeArrangedSubview(v); v.removeFromSuperview() }
        rows.removeAll()
        var views: [NSView] = []
        switch mode {
        case 0, 1:   // NFM / WFM
            views.append(header("FM OPTIONS"))
            views.append(row("Bandwidth", "fm.bandwidth", .list([90_000, 100_000, 110_000, 150_000, 200_000], "kHz")))
            views.append(row("De-emphasis", "fm.deemphasis", .text(["off", "50us", "75us"])))
            views.append(row("Stereo", "fm.stereo", .bool))
            views.append(row("IFNR", "fm.ifnr", .bool))
            views.append(row("Audio HPF", "fm.highPass", .bool))
            views.append(row("Audio LPF", "fm.lowPass", .bool))
        case 2:      // AM
            views.append(header("AM OPTIONS"))
            views.append(row("Bandwidth", "am.bandwidth", .list([4_000, 6_000, 9_000, 12_000], "kHz")))
            views.append(row("Sync detect", "am.sync", .bool))
            views.append(row("Carrier AGC", "am.carrierAgc", .bool))
            views.append(row("AGC attack", "am.agcAttack", .list([5, 10, 20, 50, 100, 200], "")))
            views.append(row("AGC decay", "am.agcDecay", .list([1, 2, 5, 8, 12, 20], "")))
        default:     // USB / LSB / CW
            views.append(header("SSB / CW OPTIONS"))
            views.append(row("Bandwidth", "ssb.bandwidth", .list([500, 1_000, 1_800, 2_400, 3_000], "Hz")))
            views.append(row("BFO pitch", "ssb.bfo", .list([400, 500, 600, 700, 800, 1_000], "Hz")))
        }
        views.append(header("RF"))
        views.append(row("Gain", "gain", .list([0, 1, 2, 3, 4, 5, 6, 7, 8], "")))

        // Receiver-wide settings, the ones the deck keeps in its Property
        // Inspector. Without them the window can drive the radio but not
        // configure it, which is half a front-end.
        views.append(header("RECEIVER"))
        views.append(row("Tune mode", "rx.tuneMode", .text(["preset", "vfo"])))
        views.append(row("JP region", "rx.jpRegion", .text(jpRegions())))
        views.append(row("Audio out", "rx.audioDevice", .text(audioDevices())))
        views.append(row("Output", "rx.outputMode", .text(["local", "icecast"])))
        views.append(row("SDR++ auto-sync", "rx.autoSyncSdrpp", .bool))
        views.append(row("Import SDR++ now", "rx.import", .action))
        for v in views {
            stack.addArrangedSubview(v)
            v.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
        updateValues()
    }

    private func value(for name: String) -> Any? {
        if name.hasPrefix("rx.") {
            let key = String(name.dropFirst(3))
            if key == "import" { return "run" }
            if key == "outputMode" { return rx["audioSink"] }
            return rx[key]
        }
        let parts = name.split(separator: ".")
        if parts.count == 1 {
            if name == "gain" {
                guard let g = live["gain"] as? [String: Any] else { return nil }
                return (mode == 0 || mode == 1) ? g["fm"] : g["am"]
            }
            return live[name]
        }
        guard let group = live[String(parts[0])] as? [String: Any] else { return nil }
        let key = parts[1] == "bandwidth" && parts[0] == "ssb" ? "bandwidthHz"
                : parts[1] == "bfo" ? "bfoPitchHz" : String(parts[1])
        return group[key]
    }

    private func updateValues() {
        for r in rows {
            let v = value(for: r.name)
            switch r.kind {
            case .bool:
                let on = (v as? Bool) ?? false
                r.value.stringValue = on ? "ON" : "OFF"
                r.value.textColor = on ? P.accent : P.faint
            case .list(_, let unit):
                let d = (v as? Double) ?? Double((v as? Int) ?? 0)
                r.value.textColor = P.text
                if unit == "kHz" {
                    r.value.stringValue = String(format: "%g kHz", d / 1000)
                } else if unit.isEmpty {
                    r.value.stringValue = String(format: "%g", (d * 10).rounded() / 10)
                } else {
                    r.value.stringValue = String(format: "%g %@", d, unit)
                }
            case .text:
                r.value.textColor = P.text
                let t = (v as? String) ?? "—"
                r.value.stringValue = t.isEmpty ? "system default" : t
            case .action:
                r.value.textColor = P.accent
                r.value.stringValue = "RUN"
            }
        }
    }

    /// Clicking a row advances it: booleans flip, everything else steps to the
    /// next value in its list and wraps. One gesture for the whole panel.
    private func cycle(_ name: String, _ kind: Kind) {
        // Receiver-wide settings live behind a different endpoint than the
        // demod's; the row does not need to care which.
        let isRx = name.hasPrefix("rx.")
        let key = isRx ? String(name.dropFirst(3)) : name
        func send(_ v: String) {
            if isRx {
                Receiver.receiver(set: key, value: v) { [weak self] j in
                    guard let self else { return }
                    self.rx = j
                    // A region change re-labels every preset, and an audio
                    // change moves the sink: re-read the rest too.
                    self.refresh()
                }
            } else {
                Receiver.options(set: key, value: v) { [weak self] j in self?.adopt(j) }
            }
        }
        switch kind {
        case .bool:
            let on = (value(for: name) as? Bool) ?? false
            send(on ? "0" : "1")
        case .list(let values, _):
            let cur = (value(for: name) as? Double) ?? Double((value(for: name) as? Int) ?? 0)
            let idx = values.firstIndex(where: { $0 > cur + 0.001 }) ?? 0
            send(String(format: "%g", values[idx]))
        case .text(let options):
            let cur = (value(for: name) as? String) ?? options[0]
            let i = ((options.firstIndex(of: cur) ?? 0) + 1) % options.count
            send(options[i])
        case .action:
            Receiver.receiver(action: "importSdrpp") { [weak self] _ in self?.refresh() }
        }
    }
}

/// A row that reports clicks. NSStackView swallows them otherwise.
final class ClickRow: NSView {
    private let action: () -> Void
    init(action: @escaping () -> Void) { self.action = action; super.init(frame: .zero) }
    required init?(coder: NSCoder) { fatalError() }
    override func mouseDown(with event: NSEvent) { action() }
}
