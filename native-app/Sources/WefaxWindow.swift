#if STANDALONE
import AppKit

/// The weather fax window: pick a frequency, capture, look at the chart.
///
/// A window of its own rather than a section of the main one. A chart is
/// 1809 px wide and takes minutes to arrive, so it wants to be sized, scrolled
/// and left open while the receiver is used for something else — none of which
/// a row in the main panel can do.
final class WefaxWindowController: NSWindowController {

    /// The JMH transmissions, which are the ones this was built against.
    /// Frequencies from the JMA schedule; 7795 kHz was the one that produced a
    /// readable chart on 2026-09-01.
    private static let presets: [(String, UInt32)] = [
        ("3622.5 kHz  JMH", 3_622_500),
        ("7795 kHz  JMH",   7_795_000),
        ("13988.5 kHz  JMH", 13_988_500),
    ]
    private static let lengths: [(String, Double)] = [
        ("2 分  (試し)", 120), ("5 分", 300), ("12 分  (1 枚分)", 720),
    ]

    private let radio: LocalRadio
    private let freqPop = NSPopUpButton()
    private let lenPop  = NSPopUpButton()
    private let startButton = NSButton()
    private let status  = label("待機", mono(13), P.dim)
    private let imageView = NSImageView()
    private let saveButton = NSButton()
    private var ticker: Timer?
    private var capturing = false
    private var lastImage: WefaxImage?

    init(radio: LocalRadio) {
        self.radio = radio
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 980, height: 720),
                         styleMask: [.titled, .closable, .miniaturizable, .resizable],
                         backing: .buffered, defer: false)
        w.title = "気象ファクス"
        w.backgroundColor = P.bg
        super.init(window: w)
        build()
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
        freqPop.selectItem(at: 1)                       // 7795 kHz
        for (t, _) in Self.lengths { lenPop.addItem(withTitle: t) }
        lenPop.selectItem(at: 2)                        // a full chart
        for p in [freqPop, lenPop] { p.font = mono(13) }

        startButton.title = "受信開始"
        startButton.bezelStyle = .rounded
        startButton.font = mono(13)
        startButton.target = self
        startButton.action = #selector(toggle)

        saveButton.title = "PNG 保存"
        saveButton.bezelStyle = .rounded
        saveButton.font = mono(13)
        saveButton.target = self
        saveButton.action = #selector(save)
        saveButton.isEnabled = false

        let row = NSStackView(views: [freqPop, lenPop, startButton, status, NSView(), saveButton])
        row.orientation = .horizontal
        row.spacing = 12
        row.alignment = .centerY
        row.translatesAutoresizingMaskIntoConstraints = false
        bar.addSubview(row)

        imageView.imageScaling = .scaleProportionallyUpOrDown
        imageView.imageAlignment = .alignTop
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = true
        scroll.drawsBackground = true
        scroll.backgroundColor = P.sunken
        scroll.documentView = imageView
        scroll.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(scroll)

        NSLayoutConstraint.activate([
            bar.topAnchor.constraint(equalTo: content.topAnchor),
            bar.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            bar.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            bar.heightAnchor.constraint(equalToConstant: 48),
            row.leadingAnchor.constraint(equalTo: bar.leadingAnchor, constant: 12),
            row.trailingAnchor.constraint(equalTo: bar.trailingAnchor, constant: -12),
            row.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
            scroll.topAnchor.constraint(equalTo: bar.bottomAnchor),
            scroll.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: content.bottomAnchor),
        ])
    }

    // MARK: - capture

    @objc private func toggle() {
        if capturing { cancel(); return }
        let hz = Self.presets[max(0, freqPop.indexOfSelectedItem)].1
        let secs = Self.lengths[max(0, lenPop.indexOfSelectedItem)].1

        radio.setFrequency(hz)
        capturing = true
        startButton.title = "中止"
        saveButton.isEnabled = false
        status.stringValue = "受信中  0%"
        status.textColor = P.warn

        radio.startFaxCapture(seconds: secs) { [weak self] img in
            guard let self else { return }
            self.capturing = false
            self.ticker?.invalidate(); self.ticker = nil
            self.startButton.title = "受信開始"
            guard let img else {
                self.status.stringValue = "中止しました"
                self.status.textColor = P.faint
                return
            }
            self.lastImage = img
            self.imageView.image = Self.nsImage(from: img)
            self.imageView.frame = NSRect(x: 0, y: 0, width: img.width, height: img.height)
            self.saveButton.isEnabled = true
            self.status.stringValue = "完了  \(img.width) x \(img.height)"
            self.status.textColor = P.accent
        }

        ticker = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            guard let self, let p = self.radio.faxProgress else { return }
            self.status.stringValue = "受信中  \(Int(p * 100))%"
        }
    }

    private func cancel() {
        radio.cancelFaxCapture()
        ticker?.invalidate(); ticker = nil
    }

    @objc private func save() {
        guard let img = lastImage, let rep = Self.bitmap(from: img),
              let png = rep.representation(using: .png, properties: [:]) else { return }
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.png]
        let stamp = ISO8601DateFormatter().string(from: Date())
            .replacingOccurrences(of: ":", with: "")
        panel.nameFieldStringValue = "wefax_\(stamp).png"
        panel.begin { r in
            guard r == .OK, let url = panel.url else { return }
            try? png.write(to: url)
        }
    }

    // MARK: - image

    private static func bitmap(from img: WefaxImage) -> NSBitmapImageRep? {
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: img.width, pixelsHigh: img.height,
            bitsPerSample: 8, samplesPerPixel: 1, hasAlpha: false, isPlanar: false,
            colorSpaceName: .calibratedWhite, bytesPerRow: img.width, bitsPerPixel: 8)
        else { return nil }
        if let dst = rep.bitmapData {
            img.pixels.withUnsafeBufferPointer { src in
                dst.update(from: src.baseAddress!, count: img.width * img.height)
            }
        }
        return rep
    }

    private static func nsImage(from img: WefaxImage) -> NSImage? {
        guard let rep = bitmap(from: img) else { return nil }
        let image = NSImage(size: NSSize(width: img.width, height: img.height))
        image.addRepresentation(rep)
        return image
    }
}
#endif
