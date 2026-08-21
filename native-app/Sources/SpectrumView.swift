import AppKit

/// Spectrum + waterfall, drawn from the plugin's live FFT frames.
///
/// Palette follows the design the receiver's LCDs already use: near-black
/// surfaces, a blue trace, a green centre marker for the tuned frequency.
final class SpectrumView: NSView {
    /// dBFS window. Matches the FFT dial's default floor/ceiling so the same
    /// signal looks the same on the deck and on screen.
    var dbFloor: Float = -100
    var dbCeil: Float = -20
    /// Fraction of the height given to the spectrum; the rest is waterfall.
    private let spectrumFraction: CGFloat = 0.45

    /// Peak hold, the way SDR++'s "FFT Hold" works: keep the highest value each
    /// bin has reached and decay it slowly, so a brief signal stays visible
    /// long enough to read.
    var holdEnabled = false { didSet { hold = []; needsDisplay = true } }
    private var hold: [Float] = []
    private let holdDecayDbPerFrame: Float = 0.35

    /// Demodulated bandwidth in Hz, drawn as the passband over the trace. 0
    /// hides it — better than inventing a width the receiver never reported.
    var bandwidthHz: Double = 0
    /// Presets that fall inside the visible span, labelled on the trace the way
    /// SDR++ labels bookmarks.
    var markers: [(freq: Double, name: String)] = []

    /// Display zoom. 1 shows the receiver's whole IQ span; higher values show a
    /// centred slice of it. Zooming is done here rather than on the receiver
    /// because every frame already carries all the bins — asking for a narrower
    /// FFT would cost resolution, which is the opposite of what zooming is for.
    var zoom: Double = 1 { didSet { hold = []; needsDisplay = true } }

    /// The bin window currently on screen, and the frequencies it spans.
    private func visible(_ count: Int) -> (start: Int, end: Int, lo: Double, span: Double) {
        let z = max(1, min(64, zoom))
        let width = max(16, Int(Double(count) / z))
        let start = max(0, (count - width) / 2)
        let end = min(count, start + width)
        let span = Double(iqRate) * Double(end - start) / Double(max(1, count))
        return (start, end, Double(centerFreq) - span / 2, span)
    }

    /// Left gutter for the dB scale, and the strip under the trace that carries
    /// the frequency scale. Both the trace and the waterfall start after the
    /// gutter so the two line up column for column.
    private let gutter: CGFloat = 62
    private let axisStrip: CGFloat = 24

    private var bins: [Float] = []
    private var iqRate: UInt32 = 0
    private var centerFreq: UInt32 = 0
    private var lastFrameAt: Date?

    // Waterfall as a rolling RGBA buffer: one pixel row per frame, newest on
    // top. Redrawing from a bitmap keeps the cost flat no matter how much
    // history is on screen.
    private var fallWidth = 0
    private var fallHeight = 0
    private var fallPixels: [UInt8] = []

    override var isFlipped: Bool { true }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.backgroundColor = NSColor(red: 0.047, green: 0.051, blue: 0.059, alpha: 1).cgColor
    }
    required init?(coder: NSCoder) { fatalError("not used") }

    func accept(_ frame: SpectrumFeed.Frame) {
        bins = frame.bins
        if holdEnabled {
            if hold.count != bins.count { hold = bins }
            for i in 0..<bins.count { hold[i] = max(bins[i], hold[i] - holdDecayDbPerFrame) }
        }
        iqRate = frame.iqRate
        centerFreq = frame.centerFreq
        lastFrameAt = Date()
        pushWaterfallRow()
        needsDisplay = true
    }

    /// True while frames are arriving; the view says so rather than showing a
    /// frozen spectrum that looks live.
    private var isLive: Bool {
        guard let t = lastFrameAt else { return false }
        return Date().timeIntervalSince(t) < 1.5
    }

    private func norm(_ db: Float) -> CGFloat {
        CGFloat(max(0, min(1, (db - dbFloor) / (dbCeil - dbFloor))))
    }

    // MARK: waterfall

    private func ensureFall(width: Int, height: Int) {
        guard width > 0, height > 0, width != fallWidth || height != fallHeight else { return }
        fallWidth = width; fallHeight = height
        fallPixels = [UInt8](repeating: 0, count: width * height * 4)
    }

    private func pushWaterfallRow() {
        guard fallWidth > 0, fallHeight > 0, !bins.isEmpty else { return }
        // Scroll down by one row, then paint the new row at the top.
        let rowBytes = fallWidth * 4
        if fallHeight > 1 {
            fallPixels.withUnsafeMutableBytes { raw in
                guard let base = raw.baseAddress else { return }
                memmove(base.advanced(by: rowBytes), base, rowBytes * (fallHeight - 1))
            }
        }
        let win = visible(bins.count)
        let winCount = max(1, win.end - win.start)
        for x in 0..<fallWidth {
            let b = bins[min(bins.count - 1, win.start + x * winCount / fallWidth)]
            let (r, g, bl) = color(for: norm(b))
            let o = x * 4
            fallPixels[o] = r; fallPixels[o + 1] = g; fallPixels[o + 2] = bl; fallPixels[o + 3] = 255
        }
    }

    /// The classic SDR waterfall ramp — near-black, blue, cyan, green, yellow,
    /// red. A monochrome ramp reads as prettier next to the rest of the UI but
    /// costs the thing a waterfall is for: with one hue you cannot tell a
    /// moderate signal from a strong one at a glance, and every band of
    /// interference looks alike.
    private static let ramp: [(CGFloat, (Double, Double, Double))] = [
        (0.00, (0, 0, 12)),
        (0.18, (0, 20, 130)),
        (0.38, (0, 160, 220)),
        (0.55, (0, 200, 90)),
        (0.72, (230, 220, 0)),
        (0.88, (240, 110, 0)),
        (1.00, (255, 40, 40)),
    ]

    private func color(for v: CGFloat) -> (UInt8, UInt8, UInt8) {
        let t = max(0, min(1, v))
        var lo = Self.ramp[0], hi = Self.ramp[Self.ramp.count - 1]
        for i in 0..<(Self.ramp.count - 1) where t >= Self.ramp[i].0 && t <= Self.ramp[i + 1].0 {
            lo = Self.ramp[i]; hi = Self.ramp[i + 1]; break
        }
        let span = max(0.0001, hi.0 - lo.0)
        let k = Double((t - lo.0) / span)
        return (UInt8(lo.1.0 + (hi.1.0 - lo.1.0) * k),
                UInt8(lo.1.1 + (hi.1.1 - lo.1.1) * k),
                UInt8(lo.1.2 + (hi.1.2 - lo.1.2) * k))
    }

    private func axisLabel(_ text: String, at p: CGPoint, size: CGFloat = 13,
                           color: NSColor = NSColor(white: 0.68, alpha: 1)) {
        NSAttributedString(string: text, attributes: [
            .font: NSFont.monospacedSystemFont(ofSize: size, weight: .regular),
            .foregroundColor: color,
        ]).draw(at: p)
    }

    /// Axis labels in the style receivers use: 440K, 9.910M.
    private func axisFreq(_ hz: Double) -> String {
        if hz >= 1_000_000 { return String(format: "%.3fM", hz / 1_000_000) }
        return String(format: "%.0fK", hz / 1000)
    }

    // MARK: drawing

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let w = bounds.width, h = bounds.height
        let plotX = gutter
        let plotW = max(1, w - gutter)
        let specH = ((h - axisStrip) * spectrumFraction).rounded()
        let fallTop = specH + axisStrip
        let fallH = max(1, h - fallTop)

        ctx.setFillColor(NSColor(red: 0.047, green: 0.051, blue: 0.059, alpha: 1).cgColor)
        ctx.fill(bounds)

        // dB scale: label every 10 dB, rule every one of them. Reading a level
        // off the trace is the point of a spectrum; without a scale it is just
        // a shape.
        // Rules are a reference, not content: dark enough that the trace and the
        // station labels sit clearly in front of them.
        ctx.setStrokeColor(NSColor(white: 0.105, alpha: 1).cgColor)
        ctx.setLineWidth(1)
        var db = (Double(dbCeil) / 10).rounded(.down) * 10
        while db >= Double(dbFloor) {
            let y = specH - norm(Float(db)) * specH
            ctx.move(to: CGPoint(x: plotX, y: y)); ctx.addLine(to: CGPoint(x: w, y: y))
            axisLabel(String(format: "%.0f", db), at: CGPoint(x: 8, y: y - 9))
            db -= 10
        }
        ctx.strokePath()

        if bins.isEmpty || !isLive {
            axisLabel(bins.isEmpty ? "waiting for the receiver" : "feed stalled",
                      at: CGPoint(x: plotX + 8, y: 8), size: 15,
                      color: NSColor(white: 0.66, alpha: 1))
            if bins.isEmpty { return }
        }

        let n = bins.count
        let win = visible(n)
        let winCount = max(1, win.end - win.start)
        let span = win.span
        let lo = win.lo
        func x(forHz hz: Double) -> CGFloat {
            guard span > 0 else { return plotX }
            return plotX + CGFloat((hz - lo) / span) * plotW
        }

        // Frequency scale, ruled through the trace and labelled in the strip
        // between trace and waterfall so both share one x mapping.
        if span > 0 {
            let targetTicks = 8.0
            let raw = span / targetTicks
            let mag = pow(10, (log10(raw)).rounded(.down))
            let step = [1.0, 2.0, 5.0, 10.0].first { mag * $0 >= raw }.map { mag * $0 } ?? mag * 10
            var f = (lo / step).rounded(.up) * step
            ctx.setStrokeColor(NSColor(white: 0.105, alpha: 1).cgColor)
            while f < lo + span {
                let px = x(forHz: f)
                ctx.move(to: CGPoint(x: px, y: 0)); ctx.addLine(to: CGPoint(x: px, y: specH))
                let text = axisFreq(f)
                axisLabel(text, at: CGPoint(x: px - CGFloat(text.count) * 3.9, y: specH + 4))
                f += step
            }
            ctx.strokePath()
        }

        // waterfall
        ensureFall(width: max(1, Int(plotW)), height: max(1, Int(fallH)))
        if fallWidth > 0, fallHeight > 0 {
            fallPixels.withUnsafeMutableBytes { raw in
                guard let base = raw.baseAddress,
                      let provider = CGDataProvider(dataInfo: nil, data: base,
                                                    size: fallWidth * fallHeight * 4,
                                                    releaseData: { _, _, _ in }) else { return }
                if let img = CGImage(width: fallWidth, height: fallHeight, bitsPerComponent: 8,
                                     bitsPerPixel: 32, bytesPerRow: fallWidth * 4,
                                     space: CGColorSpaceCreateDeviceRGB(),
                                     bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
                                     provider: provider, decode: nil, shouldInterpolate: false,
                                     intent: .defaultIntent) {
                    // This view is flipped (origin top-left) and CGImage drawing
                    // is not: without un-mirroring, the waterfall grows upward
                    // from the bottom edge instead of scrolling down from under
                    // the trace.
                    ctx.saveGState()
                    ctx.translateBy(x: 0, y: fallTop + fallH)
                    ctx.scaleBy(x: 1, y: -1)
                    ctx.draw(img, in: CGRect(x: plotX, y: 0, width: plotW, height: fallH))
                    ctx.restoreGState()
                }
            }
        }

        // passband, before the trace so the trace stays readable on top of it
        if bandwidthHz > 0, span > 0 {
            let half = bandwidthHz / 2
            let r = CGRect(x: x(forHz: Double(centerFreq) - half), y: 0,
                           width: max(2, x(forHz: Double(centerFreq) + half) - x(forHz: Double(centerFreq) - half)),
                           height: h)
            ctx.setFillColor(NSColor(red: 0.85, green: 0.35, blue: 0.30, alpha: 0.16).cgColor)
            ctx.fill(r)
        }

        // trace + fill
        let path = CGMutablePath()
        for px in 0..<Int(plotW) {
            let b = bins[min(n - 1, win.start + px * winCount / max(1, Int(plotW)))]
            let p = CGPoint(x: plotX + CGFloat(px), y: specH - norm(b) * specH)
            if px == 0 { path.move(to: p) } else { path.addLine(to: p) }
        }
        let fill = path.mutableCopy()!
        fill.addLine(to: CGPoint(x: w, y: specH))
        fill.addLine(to: CGPoint(x: plotX, y: specH))
        fill.closeSubpath()
        ctx.saveGState()
        ctx.addPath(fill); ctx.clip()
        if let grad = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
                                 colors: [NSColor(red: 0.40, green: 0.70, blue: 0.95, alpha: 0.30).cgColor,
                                          NSColor(red: 0.40, green: 0.70, blue: 0.95, alpha: 0.02).cgColor] as CFArray,
                                 locations: [0, 1]) {
            ctx.drawLinearGradient(grad, start: CGPoint(x: 0, y: 0), end: CGPoint(x: 0, y: specH), options: [])
        }
        ctx.restoreGState()
        ctx.addPath(path)
        ctx.setStrokeColor(NSColor(red: 0.78, green: 0.90, blue: 1.0, alpha: 1).cgColor)
        ctx.setLineWidth(1.2)
        ctx.strokePath()

        if holdEnabled, hold.count == n {
            let hp = CGMutablePath()
            for px in 0..<Int(plotW) {
                let v = hold[min(n - 1, win.start + px * winCount / max(1, Int(plotW)))]
                let p = CGPoint(x: plotX + CGFloat(px), y: specH - norm(v) * specH)
                if px == 0 { hp.move(to: p) } else { hp.addLine(to: p) }
            }
            ctx.addPath(hp)
            ctx.setStrokeColor(NSColor(red: 0.949, green: 0.749, blue: 0.349, alpha: 0.8).cgColor)
            ctx.setLineWidth(1)
            ctx.strokePath()
        }

        // Tuned marker, full height so it ties trace and waterfall together.
        // Red, and the only red on the display: the preset labels and their
        // lines are amber, so "where am I listening" never competes with
        // "what else is here".
        ctx.setStrokeColor(NSColor(red: 0.96, green: 0.24, blue: 0.24, alpha: 1).cgColor)
        ctx.setLineWidth(1.6)
        let cx = x(forHz: Double(centerFreq)).rounded()
        ctx.move(to: CGPoint(x: cx, y: 0)); ctx.addLine(to: CGPoint(x: cx, y: h))
        ctx.strokePath()

        // preset labels for anything inside the span
        if span > 0 {
            for m in markers where m.freq > lo && m.freq < lo + span {
                let px = x(forHz: m.freq)
                ctx.setStrokeColor(NSColor(red: 0.949, green: 0.749, blue: 0.349, alpha: 0.55).cgColor)
                ctx.move(to: CGPoint(x: px, y: 26)); ctx.addLine(to: CGPoint(x: px, y: specH))
                ctx.strokePath()
                let text = m.name as NSString
                let attrs: [NSAttributedString.Key: Any] = [
                    .font: NSFont.monospacedSystemFont(ofSize: 16, weight: .semibold),
                    .foregroundColor: NSColor.black,
                ]
                let size = text.size(withAttributes: attrs)
                let box = CGRect(x: px - size.width / 2 - 5, y: 1, width: size.width + 10, height: size.height + 4)
                ctx.setFillColor(NSColor(red: 0.949, green: 0.808, blue: 0.349, alpha: 0.92).cgColor)
                ctx.fill(box)
                text.draw(at: CGPoint(x: box.minX + 5, y: box.minY + 2), withAttributes: attrs)
            }
        }
    }

}
