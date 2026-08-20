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
        for x in 0..<fallWidth {
            let b = bins[min(bins.count - 1, x * bins.count / fallWidth)]
            let (r, g, bl) = color(for: norm(b))
            let o = x * 4
            fallPixels[o] = r; fallPixels[o + 1] = g; fallPixels[o + 2] = bl; fallPixels[o + 3] = 255
        }
    }

    /// Black -> blue -> white ramp. Deliberately not a rainbow: the dial's
    /// palette is monochromatic-plus-accent and a rainbow would fight it.
    private func color(for v: CGFloat) -> (UInt8, UInt8, UInt8) {
        let t = max(0, min(1, v))
        if t < 0.5 {
            let k = t / 0.5
            return (UInt8(10 + 30 * k), UInt8(14 + 60 * k), UInt8(20 + 150 * k))
        }
        let k = (t - 0.5) / 0.5
        return (UInt8(40 + 215 * k), UInt8(74 + 181 * k), UInt8(170 + 85 * k))
    }

    // MARK: drawing

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let w = bounds.width, h = bounds.height
        let specH = (h * spectrumFraction).rounded()
        let fallH = h - specH

        ctx.setFillColor(NSColor(red: 0.047, green: 0.051, blue: 0.059, alpha: 1).cgColor)
        ctx.fill(bounds)

        // grid
        ctx.setStrokeColor(NSColor(red: 0.098, green: 0.106, blue: 0.122, alpha: 1).cgColor)
        ctx.setLineWidth(1)
        for i in 1..<4 {
            let y = specH * CGFloat(i) / 4
            ctx.move(to: CGPoint(x: 0, y: y)); ctx.addLine(to: CGPoint(x: w, y: y))
        }
        for i in 1..<5 {
            let x = (w * CGFloat(i) / 5).rounded()
            ctx.move(to: CGPoint(x: x, y: 0)); ctx.addLine(to: CGPoint(x: x, y: specH))
        }
        ctx.strokePath()

        if bins.isEmpty || !isLive {
            let msg = bins.isEmpty ? "waiting for the receiver" : "feed stalled"
            let attrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.monospacedSystemFont(ofSize: 11, weight: .regular),
                .foregroundColor: NSColor(white: 0.42, alpha: 1),
            ]
            let s = NSAttributedString(string: msg, attributes: attrs)
            s.draw(at: CGPoint(x: 10, y: 8))
            if bins.isEmpty { return }
        }

        // waterfall
        ensureFall(width: max(1, Int(w)), height: max(1, Int(fallH)))
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
                    // This view is flipped (origin top-left), and CGImage
                    // drawing is not: without un-mirroring here the waterfall
                    // grows upward from the bottom edge instead of scrolling
                    // down from under the spectrum.
                    ctx.saveGState()
                    ctx.translateBy(x: 0, y: specH + fallH)
                    ctx.scaleBy(x: 1, y: -1)
                    ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: fallH))
                    ctx.restoreGState()
                }
            }
        }

        // spectrum trace + fill
        let path = CGMutablePath()
        let n = bins.count
        for x in 0..<Int(w) {
            let b = bins[min(n - 1, x * n / max(1, Int(w)))]
            let y = specH - norm(b) * specH
            let p = CGPoint(x: CGFloat(x), y: y)
            if x == 0 { path.move(to: p) } else { path.addLine(to: p) }
        }
        let fill = path.mutableCopy()!
        fill.addLine(to: CGPoint(x: w, y: specH))
        fill.addLine(to: CGPoint(x: 0, y: specH))
        fill.closeSubpath()
        ctx.saveGState()
        ctx.addPath(fill); ctx.clip()
        if let grad = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
                                 colors: [NSColor(red: 0.40, green: 0.70, blue: 0.95, alpha: 0.34).cgColor,
                                          NSColor(red: 0.40, green: 0.70, blue: 0.95, alpha: 0.02).cgColor] as CFArray,
                                 locations: [0, 1]) {
            ctx.drawLinearGradient(grad, start: CGPoint(x: 0, y: 0), end: CGPoint(x: 0, y: specH), options: [])
        }
        ctx.restoreGState()
        ctx.addPath(path)
        ctx.setStrokeColor(NSColor(red: 0.66, green: 0.85, blue: 1.0, alpha: 1).cgColor)
        ctx.setLineWidth(1.3)
        ctx.strokePath()

        if holdEnabled, hold.count == n {
            let hp = CGMutablePath()
            for x in 0..<Int(w) {
                let v = hold[min(n - 1, x * n / max(1, Int(w)))]
                let p = CGPoint(x: CGFloat(x), y: specH - norm(v) * specH)
                if x == 0 { hp.move(to: p) } else { hp.addLine(to: p) }
            }
            ctx.addPath(hp)
            ctx.setStrokeColor(NSColor(red: 0.949, green: 0.749, blue: 0.349, alpha: 0.75).cgColor)
            ctx.setLineWidth(1)
            ctx.strokePath()
        }

        // tuned-frequency marker
        ctx.setStrokeColor(NSColor(red: 0.35, green: 0.85, blue: 0.45, alpha: 1).cgColor)
        ctx.setLineWidth(1)
        ctx.move(to: CGPoint(x: (w / 2).rounded(), y: 0))
        ctx.addLine(to: CGPoint(x: (w / 2).rounded(), y: h))
        ctx.strokePath()

        // span readout
        if iqRate > 0 {
            let span = Double(iqRate) / 1000
            let attrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.monospacedSystemFont(ofSize: 9, weight: .regular),
                .foregroundColor: NSColor(white: 0.42, alpha: 1),
            ]
            NSAttributedString(string: String(format: "%.0f kHz", span), attributes: attrs)
                .draw(at: CGPoint(x: w - 54, y: 5))
        }
    }
}
