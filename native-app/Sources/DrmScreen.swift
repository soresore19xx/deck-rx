#if os(iOS) && DRM_ENABLED
import UIKit

/// The DRM panel on the iPad: pick a frequency, start decoding, watch the
/// receiver lock.
///
/// The four lamps are the whole diagnosis, in order. TIME means the OFDM
/// symbol timing was found — that much happens on noise too. FAC means a frame
/// was actually decoded, which is the first thing that cannot happen by
/// accident. SDC carries the service description, so the station name appears
/// with it. AUDIO is the AAC decoder accepting frames. A lamp that lights and
/// drops back says where the chain is failing far more precisely than "no
/// sound" does.
///
/// A sheet rather than a pane in the main screen: a decode runs for as long as
/// it is left running, and the receiver stays usable underneath.
final class DrmViewController: UIViewController {

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
    private var chosen = 1                       // the TWR slot
    private let freqButton = UIButton(type: .system)
    private let startButton = UIButton(type: .system)
    private let hint = UILabel()

    private let lampTime  = Lamp("TIME")
    private let lampFac   = Lamp("FAC")
    private let lampSdc   = Lamp("SDC")
    private let lampAudio = Lamp("AUDIO")

    private let serviceValue = UILabel()
    private let modeValue    = UILabel()
    private let codingValue  = UILabel()
    private let audioValue   = UILabel()
    private let merValue     = UILabel()
    private let messageValue = UILabel()

    private var running = false
    private var spectrum = "-"
    private var modeLetter = "-"
    private var fac = "-", sdc = "-", msc = "-"

    init(radio: LocalRadio) {
        self.radio = radio
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "DRM"
        view.backgroundColor = Pal.bg
        navigationItem.rightBarButtonItem = UIBarButtonItem(
            barButtonSystemItem: .done, target: self, action: #selector(done))
        build()
        radio.drm.onState = { [weak self] key, value in self?.apply(key, value) }
        // A decode left running from a previous visit keeps its state; the
        // sheet reflects what is happening rather than resetting it.
        running = radio.drm.isRunning
        syncButton()
        for (k, v) in radio.drm.state { apply(k, v) }
    }

    @objc private func done() { dismiss(animated: true) }

    private func build() {
        freqButton.setTitle(Self.presets[chosen].0, for: .normal)
        freqButton.titleLabel?.font = xMono(S(15))
        freqButton.contentHorizontalAlignment = .leading
        freqButton.showsMenuAsPrimaryAction = true
        freqButton.menu = UIMenu(children: Self.presets.enumerated().map { i, p in
            UIAction(title: p.0) { [weak self] _ in
                self?.chosen = i
                self?.freqButton.setTitle(p.0, for: .normal)
            }
        })

        startButton.setTitle("受信開始", for: .normal)
        startButton.titleLabel?.font = xMono(S(16), .medium)
        startButton.backgroundColor = Pal.panel
        startButton.layer.borderWidth = 1
        startButton.layer.borderColor = Pal.rule.cgColor
        startButton.layer.cornerRadius = S(6)
        startButton.widthAnchor.constraint(equalToConstant: S(120)).isActive = true
        startButton.heightAnchor.constraint(equalToConstant: S(40)).isActive = true
        startButton.addTarget(self, action: #selector(toggle), for: .touchUpInside)

        hint.font = xMono(S(13))
        hint.textColor = Pal.faint
        hint.text = "待機"

        for (l, f, c) in [(serviceValue, xMono(S(20), .medium), Pal.text),
                          (modeValue,    xMono(S(14)), Pal.dim),
                          (codingValue,  xMono(S(14)), Pal.dim),
                          (audioValue,   xMono(S(14)), Pal.dim),
                          (merValue,     xMono(S(13)), Pal.faint)] {
            l.font = f; l.textColor = c; l.text = "-"
        }
        messageValue.font = xMono(S(14))
        messageValue.textColor = Pal.blue
        messageValue.numberOfLines = 4
        messageValue.text = ""

        let top = UIStackView(arrangedSubviews: [freqButton, startButton, hint])
        top.axis = .horizontal
        top.spacing = S(14)
        top.alignment = .center

        let lamps = UIStackView(arrangedSubviews: [lampTime, lampFac, lampSdc, lampAudio, UIView()])
        lamps.axis = .horizontal
        lamps.spacing = S(16)
        lamps.alignment = .center

        let grid = UIStackView(arrangedSubviews: [
            serviceValue,
            pair("モード", modeValue),
            pair("符号化", codingValue),
            pair("音声", audioValue),
            pair("MER", merValue),
            messageValue,
        ])
        grid.axis = .vertical
        grid.spacing = S(10)
        grid.alignment = .fill

        let all = UIStackView(arrangedSubviews: [top, lamps, grid, UIView()])
        all.axis = .vertical
        all.spacing = S(20)
        all.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(all)
        NSLayoutConstraint.activate([
            all.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: S(18)),
            all.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: S(18)),
            all.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -S(18)),
            all.bottomAnchor.constraint(lessThanOrEqualTo: view.safeAreaLayoutGuide.bottomAnchor,
                                        constant: -S(18)),
        ])
    }

    private func pair(_ name: String, _ value: UILabel) -> UIView {
        let n = UILabel()
        n.text = name
        n.font = xMono(S(12))
        n.textColor = Pal.faint
        n.widthAnchor.constraint(equalToConstant: S(72)).isActive = true
        let s = UIStackView(arrangedSubviews: [n, value])
        s.axis = .horizontal
        s.spacing = S(12)
        s.alignment = .firstBaseline
        return s
    }

    // MARK: - control

    @objc private func toggle() {
        if running {
            radio.stopDrm()
            running = false
            hint.text = "停止しました"
            reset()
            syncButton()
            return
        }
        if let hz = Self.presets[chosen].1 { radio.setFrequency(hz) }
        reset()
        radio.startDrm()
        running = true
        hint.text = "同期待ち"
        syncButton()
    }

    private func syncButton() {
        startButton.setTitle(running ? "停止" : "受信開始", for: .normal)
        startButton.setTitleColor(running ? Pal.warn : Pal.text, for: .normal)
    }

    private func reset() {
        for l in [lampTime, lampFac, lampSdc, lampAudio] { l.lit = false }
        serviceValue.text = "-"
        for f in [modeValue, codingValue, audioValue, merValue] { f.text = "-" }
        messageValue.text = ""
        spectrum = "-"; modeLetter = "-"
        fac = "-"; sdc = "-"; msc = "-"
    }

    /// One field of the decoder's state. `DrmSession` has already brought it
    /// to the main queue.
    private func apply(_ key: String, _ value: String) {
        switch key {
        case "timeSync": lampTime.lit  = value == "yes"
        case "facSync":  lampFac.lit   = value == "yes"
                         if value == "yes" { hint.text = "受信中" }
        case "sdcSync":  lampSdc.lit   = value == "yes"
        case "faadSync": lampAudio.lit = value == "yes"
        case "service":  serviceValue.text = value.isEmpty ? "-" : value
        case "mode":     modeLetter = value; showMode()
        case "spectrum": spectrum = value; showMode()
        case "datacoding": codingValue.text = value
        case "aacData":  audioValue.text = value
        case "audioMode":
            let t = value.trimmingCharacters(in: .whitespaces)
            if !t.isEmpty { audioValue.text = "\(t)  \(audioValue.text ?? "")" }
        case "facMer":   fac = value; showMer()
        case "sdcMer":   sdc = value; showMer()
        case "mscMer":   msc = value; showMer()
        case "message":  messageValue.text = value
        default: break
        }
    }

    private func showMode() { modeValue.text = "\(modeLetter)  /  スペクトラム \(spectrum)" }
    private func showMer()  { merValue.text = "FAC \(fac)   SDC \(sdc)   MSC \(msc)  dB" }

    /// A named indicator. Red until the thing it names is true, then green —
    /// the same reading the decoder's own window had, which is what every
    /// description of DRM reception assumes you are looking at.
    final class Lamp: UIView {
        private let dot = UIView()
        var lit = false { didSet { dot.backgroundColor = lit ? Pal.accent : Pal.rule } }

        init(_ name: String) {
            super.init(frame: .zero)
            translatesAutoresizingMaskIntoConstraints = false
            dot.backgroundColor = Pal.rule
            dot.layer.cornerRadius = S(6)
            dot.translatesAutoresizingMaskIntoConstraints = false
            let t = UILabel()
            t.text = name
            t.font = xMono(S(11))
            t.textColor = Pal.faint
            let s = UIStackView(arrangedSubviews: [dot, t])
            s.axis = .horizontal
            s.spacing = S(7)
            s.alignment = .center
            s.translatesAutoresizingMaskIntoConstraints = false
            addSubview(s)
            NSLayoutConstraint.activate([
                dot.widthAnchor.constraint(equalToConstant: S(12)),
                dot.heightAnchor.constraint(equalToConstant: S(12)),
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
