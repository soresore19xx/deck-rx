#if STANDALONE && DRM_ENABLED
import AppKit

/// The DRM window: pick a frequency, start decoding, watch the receiver lock.
///
/// The four lamps are the whole diagnosis, in order. TIME means the OFDM symbol
/// timing was found — that much happens on noise too. FAC means a frame was
/// actually decoded, which is the first thing that cannot happen by accident.
/// SDC carries the service description, so the station name appears with it.
/// AUDIO is the AAC decoder accepting frames. A lamp that lights and drops back
/// says where the chain is failing far more precisely than "no sound".
final class DrmWindowController: NSWindowController {

    /// Frequencies the schedule search turned up, none of which has yet been
    /// heard here — DRM on shortwave is thin and the propagation has to
    /// cooperate. The Saturday TWR slot is the nearest transmitter.
    private static let presets: [(String, UInt32?)] = [
        ("現在の周波数のまま", nil),
        ("12105 kHz  TWR 日本語 (土 21:00-)", 12_105_000),
        ("9655 kHz  CNR", 9_655_000),
        ("13790 kHz  CNR", 13_790_000),
        ("13825 kHz  CNR", 13_825_000),
        ("11695 kHz  CNR", 11_695_000),
        ("17770 kHz  CNR", 17_770_000),
        ("21590 kHz  CNR", 21_590_000),
        ("15760 kHz", 15_760_000),
    ]

    private let radio: LocalRadio
    private let freqPop = NSPopUpButton()
    private let startButton = NSButton()

    private let lampTime  = Lamp("TIME")
    private let lampFac   = Lamp("FAC")
    private let lampSdc   = Lamp("SDC")
    private let lampAudio = Lamp("AUDIO")

    private let serviceValue    = label("-", mono(16, .medium), P.text)
    private let modeValue       = label("-", mono(13), P.dim)
    private let codingValue     = label("-", mono(13), P.dim)
    private let audioValue      = label("-", mono(13), P.dim)
    private let merValue        = label("-", mono(13), P.faint)
    private let messageValue    = label("", mono(13), P.blue)
    private let hint = label("待機", mono(12), P.faint)

    private var running = false

    init(radio: LocalRadio) {
        self.radio = radio
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 640, height: 330),
                         styleMask: [.titled, .closable, .miniaturizable],
                         backing: .buffered, defer: false)
        w.title = "DRM (短波デジタル)"
        w.backgroundColor = P.bg
        super.init(window: w)
        build()
        radio.drm.onState = { [weak self] key, value in self?.apply(key, value) }
    }
    required init?(coder: NSCoder) { fatalError("not used") }

    private func build() {
        guard let content = window?.contentView else { return }
        content.wantsLayer = true
        content.layer?.backgroundColor = P.bg.cgColor

        let bar = panelView()
        bar.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(bar)

        for (t, _) in Self.presets { freqPop.addItem(withTitle: t) }
        freqPop.selectItem(at: 1)
        freqPop.font = mono(13)

        startButton.title = "受信開始"
        startButton.bezelStyle = .rounded
        startButton.font = mono(13)
        startButton.target = self
        startButton.action = #selector(toggle)

        let row = NSStackView(views: [freqPop, startButton, hint, NSView()])
        row.orientation = .horizontal
        row.spacing = 12
        row.alignment = .centerY
        row.translatesAutoresizingMaskIntoConstraints = false
        bar.addSubview(row)

        let lamps = NSStackView(views: [lampTime, lampFac, lampSdc, lampAudio, NSView()])
        lamps.orientation = .horizontal
        lamps.spacing = 10
        lamps.alignment = .centerY
        lamps.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(lamps)

        messageValue.maximumNumberOfLines = 3
        messageValue.lineBreakMode = .byWordWrapping
        messageValue.cell?.wraps = true

        let grid = NSStackView(views: [
            serviceValue,
            pair("モード", modeValue),
            pair("符号化", codingValue),
            pair("音声", audioValue),
            pair("MER", merValue),
            messageValue,
        ])
        grid.orientation = .vertical
        grid.spacing = 8
        grid.alignment = .leading
        grid.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(grid)

        NSLayoutConstraint.activate([
            bar.topAnchor.constraint(equalTo: content.topAnchor),
            bar.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            bar.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            bar.heightAnchor.constraint(equalToConstant: 48),
            row.leadingAnchor.constraint(equalTo: bar.leadingAnchor, constant: 12),
            row.trailingAnchor.constraint(equalTo: bar.trailingAnchor, constant: -12),
            row.centerYAnchor.constraint(equalTo: bar.centerYAnchor),

            lamps.topAnchor.constraint(equalTo: bar.bottomAnchor, constant: 14),
            lamps.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 14),
            lamps.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -14),

            grid.topAnchor.constraint(equalTo: lamps.bottomAnchor, constant: 16),
            grid.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 14),
            grid.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -14),
        ])
    }

    private func pair(_ name: String, _ value: NSTextField) -> NSView {
        let n = label(name, mono(12), P.faint)
        n.setContentHuggingPriority(.required, for: .horizontal)
        let w = n.widthAnchor.constraint(equalToConstant: 64)
        w.isActive = true
        let s = NSStackView(views: [n, value])
        s.orientation = .horizontal
        s.spacing = 10
        s.alignment = .firstBaseline
        return s
    }

    // MARK: - control

    @objc private func toggle() {
        if running {
            radio.stopDrm()
            running = false
            startButton.title = "受信開始"
            hint.stringValue = "停止しました"
            reset()
            return
        }
        if let hz = Self.presets[max(0, freqPop.indexOfSelectedItem)].1 {
            radio.setFrequency(hz)
        }
        reset()
        radio.startDrm()
        running = true
        startButton.title = "停止"
        hint.stringValue = "同期待ち"
    }

    private func reset() {
        for l in [lampTime, lampFac, lampSdc, lampAudio] { l.lit = false }
        serviceValue.stringValue = "-"
        for f in [modeValue, codingValue, audioValue, merValue] { f.stringValue = "-" }
        messageValue.stringValue = ""
    }

    /// One field of the decoder's state, already on the main queue.
    private func apply(_ key: String, _ value: String) {
        switch key {
        case "timeSync": lampTime.lit  = value == "yes"
        case "facSync":  lampFac.lit   = value == "yes"
                         if value == "yes" { hint.stringValue = "受信中" }
        case "sdcSync":  lampSdc.lit   = value == "yes"
        case "faadSync": lampAudio.lit = value == "yes"
        case "service":  serviceValue.stringValue = value.isEmpty ? "-" : value
        case "mode":     modeValue.stringValue = "\(value)  /  スペクトラム \(spectrum)"
        case "spectrum": spectrum = value
                         modeValue.stringValue = "\(modeValue.stringValue.prefix(1))  /  スペクトラム \(value)"
        case "datacoding": codingValue.stringValue = value
        case "aacData":  audioValue.stringValue = value
        case "audioMode":
            let t = value.trimmingCharacters(in: .whitespaces)
            if !t.isEmpty { audioValue.stringValue = "\(t)  \(audioValue.stringValue)" }
        case "facMer":   fac = value; showMer()
        case "sdcMer":   sdc = value; showMer()
        case "mscMer":   msc = value; showMer()
        case "message":  messageValue.stringValue = value
        default: break
        }
    }

    private var spectrum = "-"
    private var fac = "-", sdc = "-", msc = "-"
    private func showMer() {
        merValue.stringValue = "FAC \(fac)   SDC \(sdc)   MSC \(msc)  dB"
    }

    /// A named indicator. Red until the thing it names is true, then green —
    /// the same reading as the decoder's own window had, which is what every
    /// description of DRM reception out there assumes you are looking at.
    final class Lamp: NSView {
        private let dot = NSView()
        var lit = false { didSet { dot.layer?.backgroundColor = (lit ? P.accent : P.rule).cgColor } }

        init(_ name: String) {
            super.init(frame: .zero)
            translatesAutoresizingMaskIntoConstraints = false
            dot.wantsLayer = true
            dot.layer?.cornerRadius = 5
            dot.layer?.backgroundColor = P.rule.cgColor
            dot.translatesAutoresizingMaskIntoConstraints = false
            let t = label(name, mono(11), P.faint)
            let s = NSStackView(views: [dot, t])
            s.orientation = .horizontal
            s.spacing = 6
            s.alignment = .centerY
            s.translatesAutoresizingMaskIntoConstraints = false
            addSubview(s)
            NSLayoutConstraint.activate([
                dot.widthAnchor.constraint(equalToConstant: 10),
                dot.heightAnchor.constraint(equalToConstant: 10),
                s.topAnchor.constraint(equalTo: topAnchor),
                s.bottomAnchor.constraint(equalTo: bottomAnchor),
                s.leadingAnchor.constraint(equalTo: leadingAnchor),
                s.trailingAnchor.constraint(equalTo: trailingAnchor),
            ])
        }
        required init?(coder: NSCoder) { fatalError("not used") }
    }
}
#endif
