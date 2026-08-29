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
    /// The rows are stacked top-down with no bound on the total, so on a short
    /// screen the last of them ran off the bottom of the panel and could not be
    /// reached at all. Scrolling costs nothing when everything already fits.
    private let scroll = NSScrollView()
    private let doc = NSView()
    /// Width an overlay scroller occupies when it appears. A system dimension,
    /// so it is asked for rather than guessed, with a floor for the case where
    /// the style reports zero.
    private var scrollerClearance: CGFloat {
        max(16, NSScroller.scrollerWidth(for: .small, scrollerStyle: .overlay))
    }
    private var live: [String: Any] = [:]
    private var mode = -1
    /// The display scale. Never read from the control endpoint, in either
    /// bundle: it is this window's size, and the endpoint on :8771 may well
    /// belong to the plugin — which has no opinion about it and answered the
    /// row with "—" and its click with a 400. That happened to the front-end
    /// always, and to the standalone app whenever the plugin held the port.
    ///
    /// Held here rather than re-read on every refresh: the panel refreshes
    /// several times a second and this changes only when the row is clicked.
    /// A rebuild constructs a fresh panel, so a change made elsewhere — the
    /// standalone app's endpoint, say — is picked up on the way back in.
    private var localUiScale = RadioConfig.load().uiScale
    /// The user picked a scale. Persisting it belongs to the delegate, which
    /// knows whether there is a live receiver holding a copy of the config.
    var onUiScaleChanged: ((String) -> Void)?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.backgroundColor = P.panel.cgColor
        stack.orientation = .vertical
        stack.alignment = .leading
        // No gap: the banding separates the rows, and a space between them put
        // the panel's ground back between two shades that were doing the work.
        stack.spacing = 0
        stack.translatesAutoresizingMaskIntoConstraints = false
        doc.translatesAutoresizingMaskIntoConstraints = false
        doc.addSubview(stack)
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = false
        scroll.drawsBackground = false
        // Overlay, so the scroller does not take a column away from rows that
        // are already tight in a 228 pt panel.
        scroll.scrollerStyle = .overlay
        scroll.autohidesScrollers = true
        // A clip view with its origin at the top. Without this a document
        // shorter than the scroll view sinks to the bottom — AppKit's
        // coordinates start at the bottom left — which is why the panel sat at
        // the foot of its column with a hand's width of empty above it, and
        // why it looked like it was falling out of the window as rows were
        // added and it grew back up.
        scroll.contentView = TopClipView()
        scroll.documentView = doc
        addSubview(scroll)
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: topAnchor),
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: bottomAnchor),
            doc.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
            stack.topAnchor.constraint(equalTo: doc.topAnchor, constant: S(10)),
            // The stack runs edge to edge so a banded row's ground reaches the
            // panel sides; the text inset moved inside the row instead.
            stack.leadingAnchor.constraint(equalTo: doc.leadingAnchor),
            // Clear of the scroller, plus a margin. The scroller's width is a
            // system size and does not follow our scale, so this inset must not
            // either: scaling it left 14 pt at min, under the ~15 pt bar, and
            // the values sat against it. Fixed clearance, scaled margin.
            stack.trailingAnchor.constraint(equalTo: doc.trailingAnchor),
            // The document's height is the stack's: what makes it scrollable.
            stack.bottomAnchor.constraint(equalTo: doc.bottomAnchor, constant: S(-10)),
        ])
    }
    required init?(coder: NSCoder) { fatalError() }

    private var rx: [String: Any] = [:]
    /// What the last answer said the panel should be made of. Only the parts
    /// that decide the rows and their choices — the values themselves change
    /// constantly and must not cost a rebuild.
    private var rxShape = ""
    private static func shape(of j: [String: Any]) -> String {
        [
            j["audioEnabled"] == nil ? "-" : "a",
            (j["audioSink"] as? String) ?? "",
            j["icecastUrl"] == nil ? "-" : "i",
            ((j["databases"] as? [String]) ?? []).joined(separator: ","),
            ((j["regions"] as? [String]) ?? []).joined(separator: ","),
            ((j["audioDevices"] as? [String]) ?? []).joined(separator: ","),
        ].joined(separator: "|")
    }

    func refresh() {
        Receiver.options { [weak self] j in self?.adopt(j) }
        Receiver.receiver { [weak self] j in
            guard let self else { return }
            self.rx = j
            // Some rows exist only if the endpoint offers them, and some rows'
            // choices come from it too. Both are decided when the panel is
            // built, and the panel is built before the first answer arrives —
            // so without this the conditional rows never appeared at all, and
            // the region and audio-device rows cycled through the fallback
            // list of one entry for the whole session.
            let shape = Self.shape(of: j)
            if shape != self.rxShape {
                self.rxShape = shape
                self.rebuild()
            } else {
                self.updateValues()
            }
        }
    }

    private func adopt(_ j: [String: Any]) {
        live = j
        let m = j["mode"] as? Int ?? -1
        if m != mode { mode = m; rebuild() } else { updateValues() }
    }

    // MARK: rows

    private var rows: [(name: String, value: NSTextField, kind: Kind)] = []
    /// Editable rows keep their field so a refresh can update it — but never
    /// while the user is typing in it.
    private var fields: [(name: String, field: NSTextField)] = []
    /// `action` carries the endpoint action it runs: there is more than one
    /// now, and a row that hard-codes the only one there used to be is a row
    /// that quietly runs the wrong thing when a second arrives.
    private enum Kind { case bool, list([Double], String), text([String]), action(String) }

    private func jpRegions() -> [String] {
        (rx["regions"] as? [String]) ?? ["kanto"]
    }
    /// "" is the system default, the same blank the deck's device list offers.
    private func audioDevices() -> [String] {
        [""] + ((rx["audioDevices"] as? [String]) ?? [])
    }

    /// Section heading. It used to be a plain label in the same rhythm as the
    /// rows, sitting right under the previous row's separator — indistinguishable
    /// from a row whose value had gone missing. Space above it and letter
    /// spacing below are what make it read as a heading by position rather than
    /// by being noticed.
    private func header(_ t: String) -> NSView {
        // Brighter than the faint grey it was: a heading that reads as dimmer
        // than the values under it inverts the hierarchy, and at 11 pt with
        // letter spacing it was closer to a watermark than a label.
        let l = label(t, mono(11), P.dim)
        l.attributedStringValue = NSAttributedString(
            string: t,
            attributes: [.font: mono(11, .medium),
                         .foregroundColor: P.dim,
                         .kern: 1.4])
        let host = NSView()
        host.translatesAutoresizingMaskIntoConstraints = false
        l.translatesAutoresizingMaskIntoConstraints = false
        host.addSubview(l)
        NSLayoutConstraint.activate([
            l.leadingAnchor.constraint(equalTo: host.leadingAnchor, constant: S(12)),
            l.trailingAnchor.constraint(lessThanOrEqualTo: host.trailingAnchor, constant: S(-12)),
            l.topAnchor.constraint(equalTo: host.topAnchor, constant: S(13)),
            l.bottomAnchor.constraint(equalTo: host.bottomAnchor, constant: S(-4)),
        ])
        // A rule above the heading, not under every row: the grouping that
        // matters here is AM OPTIONS / RF / RECEIVER, and a line per row turned
        // the panel into a table with more structure than its content has.
        let rule = NSView()
        rule.wantsLayer = true
        rule.layer?.backgroundColor = P.rule.cgColor
        rule.translatesAutoresizingMaskIntoConstraints = false
        host.addSubview(rule)
        NSLayoutConstraint.activate([
            rule.leadingAnchor.constraint(equalTo: host.leadingAnchor),
            rule.trailingAnchor.constraint(equalTo: host.trailingAnchor),
            rule.topAnchor.constraint(equalTo: host.topAnchor, constant: S(6)),
            rule.heightAnchor.constraint(equalToConstant: 1),
        ])
        return host
    }

    private func row(_ title: String, _ name: String, _ kind: Kind) -> NSView {
        // Monospaced, like the value. A proportional name beside a monospaced
        // value put two rhythms in one line and read as two different tables.
        let t = label(title, mono(13), P.dim)
        t.lineBreakMode = .byTruncatingTail
        // The value is the part you read; let the name lose characters first.
        t.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let v = label("—", mono(13), P.text)
        // Half the panel, at most. A long value — "system default" — otherwise
        // pushed the name out entirely and left "Audi...", which says nothing
        // about what the value belongs to. Both truncate; the name goes second.
        v.setContentCompressionResistancePriority(.defaultHigh, for: .horizontal)
        v.lineBreakMode = .byTruncatingTail
        v.cell?.usesSingleLineMode = true
        v.setContentHuggingPriority(.required, for: .horizontal)
        t.setContentCompressionResistancePriority(.init(251), for: .horizontal)
        let r = NSStackView(views: [t, NSView(), v])
        r.orientation = .horizontal
        r.spacing = S(8)
        r.translatesAutoresizingMaskIntoConstraints = false
        r.heightAnchor.constraint(equalToConstant: S(23)).isActive = true
        // 0.55 was too tight for this one row: "Audio out" and "system
        // default" both truncated, which is the worst of both. 0.66 lets a long
        // value keep its shape while the name stays readable.
        v.widthAnchor.constraint(lessThanOrEqualTo: r.widthAnchor, multiplier: 0.66).isActive = true
        rows.append((name, v, kind))
        let pad = ClickRow { [weak self] in self?.cycle(name, kind) }
        pad.translatesAutoresizingMaskIntoConstraints = false
        pad.addSubview(r)
        NSLayoutConstraint.activate([
            r.leadingAnchor.constraint(equalTo: pad.leadingAnchor, constant: S(12)),
            // Clear of the scroller: its width is a system dimension and does
            // not follow our scale, so the clearance must not either.
            r.trailingAnchor.constraint(equalTo: pad.trailingAnchor,
                                        constant: -(scrollerClearance + S(6))),
            r.topAnchor.constraint(equalTo: pad.topAnchor),
            r.bottomAnchor.constraint(equalTo: pad.bottomAnchor),
        ])
        // Alternate rows get a lighter ground. That is what makes a name and
        // its value read as one row: a line between rows says where rows end,
        // a band says which pieces belong together.
        //
        // This had been dropped while reverting the per-row rule, so exactly
        // one row in the panel — the last, which goes through editRow — was
        // banded, and the feature looked broken rather than absent.
        pad.base = bandIndex % 2 == 1 ? P.band : .clear
        bandIndex += 1
        return pad
    }

    /// A row whose value is typed rather than cycled. Host and port are the two
    /// settings with no sensible list to walk.
    private func editRow(_ title: String, _ name: String, width: CGFloat) -> NSView {
        let t = label(title, mono(13), P.dim)
        let f = NSTextField(string: "")
        f.font = mono(13)
        f.alignment = .right
        // A flat well rather than a system bezel. The bezelled pair sat on the
        // panel as two floating widgets from a different toolkit, with their
        // own light ground and rounded shoulders, while every row above them
        // was flat. Still obviously typeable — it is the only sunken thing in
        // the column, and the focus ring still lands on it.
        f.isBezeled = false
        f.isBordered = false
        f.drawsBackground = true
        f.backgroundColor = P.sunken
        f.wantsLayer = true
        f.layer?.cornerRadius = 3
        f.layer?.borderWidth = 1
        f.layer?.borderColor = P.line.cgColor
        f.translatesAutoresizingMaskIntoConstraints = false
        f.widthAnchor.constraint(equalToConstant: width).isActive = true
        f.target = ButtonBox.shared
        f.action = #selector(ButtonBox.fire(_:))
        ButtonBox.shared.actions[ObjectIdentifier(f)] = { [weak self] in
            guard let self else { return }
            let key = String(name.dropFirst(3))
            Receiver.receiver(set: key, value: f.stringValue) { [weak self] j in
                guard let self else { return }
                self.rx = j
                self.updateValues()
            }
        }
        fields.append((name, f))
        let inner = NSStackView(views: [t, NSView(), f])
        let r = NSView()
        r.translatesAutoresizingMaskIntoConstraints = false
        inner.translatesAutoresizingMaskIntoConstraints = false
        r.addSubview(inner)
        NSLayoutConstraint.activate([
            inner.leadingAnchor.constraint(equalTo: r.leadingAnchor, constant: S(12)),
            inner.trailingAnchor.constraint(equalTo: r.trailingAnchor,
                                            constant: -(scrollerClearance + S(6))),
            inner.topAnchor.constraint(equalTo: r.topAnchor),
            inner.bottomAnchor.constraint(equalTo: r.bottomAnchor),
        ])
        inner.orientation = .horizontal
        inner.spacing = S(8)
        r.heightAnchor.constraint(equalToConstant: S(26)).isActive = true
        if bandIndex % 2 == 1 {
            r.wantsLayer = true
            r.layer?.backgroundColor = P.band.cgColor
        }
        bandIndex += 1
        return r
    }

    /// Wraps a row with the separator beneath it.
    private func ruled(_ inner: NSView) -> NSView {
        let host = NSView()
        host.translatesAutoresizingMaskIntoConstraints = false
        inner.translatesAutoresizingMaskIntoConstraints = false
        host.addSubview(inner)
        let rule = NSView()
        rule.wantsLayer = true
        rule.layer?.backgroundColor = P.rule.cgColor
        rule.translatesAutoresizingMaskIntoConstraints = false
        host.addSubview(rule)
        NSLayoutConstraint.activate([
            inner.leadingAnchor.constraint(equalTo: host.leadingAnchor),
            inner.trailingAnchor.constraint(equalTo: host.trailingAnchor),
            inner.topAnchor.constraint(equalTo: host.topAnchor),
            inner.bottomAnchor.constraint(equalTo: host.bottomAnchor),
            rule.leadingAnchor.constraint(equalTo: host.leadingAnchor),
            rule.trailingAnchor.constraint(equalTo: host.trailingAnchor),
            rule.bottomAnchor.constraint(equalTo: host.bottomAnchor),
            rule.heightAnchor.constraint(equalToConstant: 1),
        ])
        return host
    }

    /// Counts rows so alternate ones can be tinted. Runs across the whole
    /// panel: resetting it at each heading made every section start unbanded,
    /// and with odd-length sections that left almost no bands at all — the
    /// first attempt tinted exactly one row out of fifteen.
    private var bandIndex = 0

    private func rebuild() {
        bandIndex = 0
        for v in stack.arrangedSubviews { stack.removeArrangedSubview(v); v.removeFromSuperview() }
        rows.removeAll()
        fields.removeAll()
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
        // The list is compiled in rather than read from the endpoint's
        // "uiScales": both bundles hold the same UI.names, and the endpoint
        // this panel is talking to may not report the scale at all. It applies
        // by rebuilding the view, so the label no longer carries the asterisk
        // it wore back when the change needed a relaunch.
        views.append(row("UI scale", "rx.uiScale", .text(UI.names)))
        // "Audio" rather than "Audio out": the device names are long and the
        // column is 228 pt. A name that survives beats one that explains.
        views.append(row("Audio", "rx.audioDevice", .text(audioDevices())))
        views.append(row("Output", "rx.outputMode", .text(["local", "icecast"])))
        views.append(row("SDR++ sync", "rx.autoSyncSdrpp", .bool))
        views.append(row("SDR++ import", "rx.import", .action("importSdrpp")))
        // Only what the endpoint says it can do. The standalone app answers its
        // own /receiver and has neither an icecast publisher nor the plugin's
        // station databases behind it, so those rows would be buttons that do
        // nothing.
        if rx["audioEnabled"] != nil {
            views.append(row("Audio on", "rx.audioEnabled", .bool))
        }
        if (rx["audioSink"] as? String) == "icecast", rx["icecastUrl"] != nil {
            // The password is not here on purpose: it stays in the config and
            // the deck's Property Inspector, not on a loopback endpoint.
            views.append(editRow("Icecast", "rx.icecastUrl", width: S(128)))
            views.append(row("Bitrate", "rx.icecastBitrate",
                             .text(["64k", "96k", "128k", "192k", "256k"])))
        }
        // The link's address. Changing either dials the new server, so these
        // are typed and applied on Enter rather than cycled by accident.
        // Short names: "Server host" truncates to "Serve" in this column, and a
        // label that loses its last word says less than one that never had it.
        views.append(editRow("Host", "rx.host", width: S(128)))
        views.append(editRow("Port", "rx.port", width: S(64)))
        // Last, and after the address: these fetch from the network, and a row
        // that goes and does something belongs below the ones that only say
        // what the receiver is set to.
        if let dbs = rx["databases"] as? [String], !dbs.isEmpty {
            views.append(header("DATABASES"))
            if dbs.contains("jp") {
                views.append(row("JP stations", "rx.updateJp", .action("updateJp")))
            }
            if dbs.contains("eibi") {
                views.append(row("EiBi schedule", "rx.updateEibi", .action("updateEibi")))
            }
        }
        for v in views {
            stack.addArrangedSubview(v)
            v.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
        updateValues()
    }

    private func value(for name: String) -> Any? {
        if name.hasPrefix("rx.") {
            let key = String(name.dropFirst(3))
            if key == "import" || key.hasPrefix("update") { return "run" }
            if key == "outputMode" { return rx["audioSink"] }
            if key == "uiScale" { return localUiScale }
            return rx[key]
        }
        let parts = name.split(separator: ".")
        if parts.count == 1 {
            if name == "gain" {
                guard let g = live["gain"] as? [String: Any] else { return nil }
                // The split the demodulators make: AM has its own gain, and
                // everything else — FM, SSB, CW — rides the other one
                // (spyService.ts:1214). Reading it as "0 or 1 is FM" showed
                // the AM number while listening to SSB.
                return mode == 2 ? g["am"] : g["fm"]
            }
            return live[name]
        }
        guard let group = live[String(parts[0])] as? [String: Any] else { return nil }
        let key = parts[1] == "bandwidth" && parts[0] == "ssb" ? "bandwidthHz"
                : parts[1] == "bfo" ? "bfoPitchHz" : String(parts[1])
        return group[key]
    }

    private func updateValues() {
        for f in fields {
            // Don't overwrite what someone is typing.
            if window?.firstResponder === f.field.currentEditor() { continue }
            let key = String(f.name.dropFirst(3))
            if let v = rx[key] {
                f.field.stringValue = v is Int ? String(v as! Int) : ((v as? String) ?? "")
            }
        }
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
            if isRx, key == "uiScale" {
                localUiScale = v
                updateValues()
                onUiScaleChanged?(v)
                return
            }
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
        case .action(let what):
            // Show what it did, briefly, in the row's own value. These take a
            // network fetch and a file write; a button that goes back to
            // saying RUN gives no sign it ever ran.
            if let r = rows.first(where: { $0.name == name }) {
                r.value.stringValue = "…"
                r.value.textColor = P.dim
            }
            Receiver.receiver(action: what) { [weak self] j in
                guard let self else { return }
                if let r = self.rows.first(where: { $0.name == name }) {
                    let n = (j["count"] as? Int) ?? (j["added"] as? Int)
                    r.value.stringValue = n.map { "\($0)" } ?? ((j["ok"] as? Bool) == false ? "FAILED" : "OK")
                    r.value.textColor = (j["ok"] as? Bool) == false ? P.warn : P.accent
                }
                // Back to RUN after the result has been read, and the rest of
                // the panel re-read: a region's names change with the database.
                DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in self?.refresh() }
            }
        }
    }
}

/// A row that reports clicks. NSStackView swallows them otherwise.
/// A row of the options panel: click it and the value steps on.
///
/// It used to be a plain view with a mouseDown. Every row in the panel is a
/// control, and nothing on screen said so — the panel read as a table of
/// readings, and the only way to find out it was live was to click it. The
/// pointer changing and the row lifting under it is the whole affordance.
/// Anchors a short document to the top of its scroll view instead of the
/// bottom.
final class TopClipView: NSClipView {
    override var isFlipped: Bool { true }
}

final class ClickRow: NSView {
    private let action: () -> Void
    /// The row's own ground — banded or not — so hover can lift it and put it
    /// back without the panel having to remember which rows were which.
    var base: NSColor = .clear {
        didSet { if !hot { layer?.backgroundColor = base.cgColor } }
    }
    private var hot = false {
        didSet {
            guard hot != oldValue else { return }
            layer?.backgroundColor = (hot ? ClickRow.hover : base).cgColor
        }
    }
    /// The accent at low alpha, so the lift reads as "this does something"
    /// rather than as another shade of grey. The panel's ground shows through.
    private static let hover = NSColor(red: 0.349, green: 0.851, blue: 0.451, alpha: 0.16)

    init(action: @escaping () -> Void) {
        self.action = action
        super.init(frame: .zero)
        wantsLayer = true
    }
    required init?(coder: NSCoder) { fatalError() }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for a in trackingAreas { removeTrackingArea(a) }
        addTrackingArea(NSTrackingArea(rect: .zero,
                                       options: [.mouseEnteredAndExited, .activeInKeyWindow,
                                                 .inVisibleRect],
                                       owner: self, userInfo: nil))
    }
    override func mouseEntered(with event: NSEvent) { hot = true }
    override func mouseExited(with event: NSEvent) { hot = false }
    override func resetCursorRects() {
        super.resetCursorRects()
        addCursorRect(bounds, cursor: .pointingHand)
    }
    override func mouseDown(with event: NSEvent) { action() }
}
