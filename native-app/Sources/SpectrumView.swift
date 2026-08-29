#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

/// Spectrum + waterfall, drawn from the plugin's live FFT frames.
///
/// Palette follows the design the receiver's LCDs already use: near-black
/// surfaces, a blue trace, a green centre marker for the tuned frequency.
final class SpectrumView: XView {
    /// dBFS window. Matches the FFT dial's default floor/ceiling so the same
    /// signal looks the same on the deck and on screen.
    var dbFloor: Float = -160
    var dbCeil: Float = -1
    /// The waterfall maps colour over its own dB window, tracked from the data
    /// rather than shared with the trace. Sharing looked reasonable and was the
    /// reason the ramp read as two flat tones: with the trace window set wide
    /// enough to see the noise floor and the peaks at once, everything on air
    /// lands in the bottom third of the ramp, so blue and cyan are the only
    /// colours that ever appear and the greens through reds are dead weight.
    /// Anchoring the window on the measured noise floor keeps the whole ramp in
    /// use on any band, at any gain.
    var wfRangeDb: Float = 55 { didSet { redraw() } }
    private var wfFloorEst: Float = -100

    /// Waterfall history depth, asked for in seconds. Frames per row is the
    /// mechanism, but it is the wrong thing to set: it makes the time on screen
    /// depend on the frame rate, so changing RATE silently changes how far back
    /// the waterfall reaches. Holding seconds and deriving the divider keeps the
    /// history put when the rate moves.
    ///
    /// At 60 fps a full-height waterfall is about 6 seconds with one row per
    /// frame — the whole picture gone before a slow fade has finished. Hence a
    /// default well above the floor.
    var wfTargetSeconds: Double = 45 { didSet { wfSkipCount = 0 } }
    /// Frames merged into the next row, derived from the target and the
    /// measured rate. At least 1.
    private var wfFrameSkip: Int {
        guard frameInterval > 0, fallHeight > 0 else { return 1 }
        let rows = wfTargetSeconds / (frameInterval * Double(fallHeight))
        return max(1, min(400, Int(rows.rounded())))
    }
    private var wfSkipCount = 0
    /// Frames are merged, not dropped, while waiting for the next row: the peak
    /// of each bin over the interval. Dropping is simpler and loses exactly what
    /// a waterfall is watched for — a burst shorter than the interval would
    /// leave no mark at all.
    private var wfAccum: [Float] = []
    /// Measured seconds between frames, so the depth can be reported in time
    /// rather than in frames the user never sees.
    private var frameInterval: Double = 0

    /// Seconds of history currently on screen. 0 until frames have been timed.
    var wfSpanSeconds: Double {
        guard frameInterval > 0, fallHeight > 0 else { return 0 }
        return frameInterval * Double(wfFrameSkip) * Double(fallHeight)
    }

    /// Fraction of the height given to the spectrum; the rest is waterfall.
    ///
    /// Dragged, not fixed: how much trace against how much history is the one
    /// split that changes with what is being listened to — a crowded broadcast
    /// band wants the trace, a slow chase across a quiet band wants the history.
    /// The scale rail between the two is the grab handle.
    var spectrumFraction: CGFloat = 0.45 {
        didSet {
            // Clamped here rather than at each caller: a restored config and a
            // drag both arrive through this one door. Assigning inside didSet
            // does not re-enter it.
            spectrumFraction = min(0.85, max(0.15, spectrumFraction))
            // ensureFall re-allocates on a size change, so the history is
            // dropped rather than stretched over times it did not happen.
            redraw()
            invalidateCursors()
        }
    }
    /// Called when a drag settles, so the split can be persisted. Not on every
    /// dragged pixel: that would be a file write per mouse event.
    var onSplitChanged: ((CGFloat) -> Void)?

    /// Peak hold, the way SDR++'s "FFT Hold" works: keep the highest value each
    /// bin has reached and decay it slowly, so a brief signal stays visible
    /// long enough to read.
    var holdEnabled = false { didSet { hold = []; redraw() } }
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
    var zoom: Double = 1 { didSet { hold = []; redraw() } }

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

    /// The window the last draw put on screen, so a touch can be turned back
    /// into a frequency. Recorded rather than recomputed: the mapping depends
    /// on whether a frame has arrived, and a second derivation of it would be
    /// a second thing to keep in step with the drawing.
    private(set) var visibleLoHz: Double = 0
    private(set) var visibleSpanHz: Double = 0

    /// The window the user is looking at, when that is not the receiver's own.
    /// 0 means "wherever the receiver is", which is the resting state.
    ///
    /// A dragged spectrum moves at the speed of the finger; the receiver
    /// follows a few times a second, because each step of it is a retune. Both
    /// are true at once during a drag, so the view is held in absolute
    /// frequency rather than as an offset in points: the data is translated by
    /// whatever is left between the two, and that difference closes on its own
    /// as the receiver arrives. Cleared in `accept` once it has.
    var viewCenterHz: Double = 0 { didSet { if viewCenterHz != oldValue { redraw() } } }

    /// The width a frequency span is drawn across. The gutter down the left
    /// carries the dB scale and belongs to no frequency, so a caller turning a
    /// drag into hertz needs this rather than the view's own width.
    var plotWidth: CGFloat { max(0, bounds.width - gutter) }

    /// The frequency under a point, or nil outside the trace. The gutter on the
    /// left carries the dB scale and belongs to no frequency.
    func frequency(atX x: CGFloat) -> Double? {
        let plotW = bounds.width - gutter
        guard plotW > 0, visibleSpanHz > 0, x >= gutter else { return nil }
        let f = Double(min(max(0, (x - gutter) / plotW), 1))
        return visibleLoHz + visibleSpanHz * f
    }

    /// Where a touch says the receiver would go, drawn while the finger is
    /// still down. A tap is over before anything could be drawn for it, so
    /// without a mark taken from the touch itself the only feedback is the jump
    /// at the end, and the tap cannot be aimed.
    var aimHz: Double? { didSet { if aimHz != oldValue { redraw() } } }
    private let axisStrip: CGFloat = 24

    /// Where the receiver is and how wide its IQ window is, from the status
    /// feed rather than from a frame. Before the first frame arrives these are
    /// all the display has, and they are enough to place the presets: the
    /// panel would otherwise sit blank next to a header that already says
    /// 810 kHz and IQ 456k.
    var idleCenterHz: Double = 0 { didSet { if bins.isEmpty { redraw() } } }

    /// Where the receiver is listening, when that is not the middle of the
    /// window. A frame carries the *device's* centre; the demodulator can sit
    /// at an offset from it, and the marker and the passband belong on the
    /// demodulator. 0 means "the centre", which is what a front-end onto the
    /// plugin reports and what a receiver tuned by moving the device does.
    var vfoHz: Double = 0 { didSet { if vfoHz != oldValue { redraw() } } }
    var idleSpanHz: Double = 0 { didSet { if bins.isEmpty { redraw() } } }

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

    // The drawing works top-down. UIKit's coordinates already do; AppKit's
    // start at the bottom, so only the Mac needs telling.
    #if !canImport(UIKit)
    override var isFlipped: Bool { true }
    #endif

    override init(frame frameRect: CGRect) {
        super.init(frame: frameRect)
        configureCustomDrawing()
        setBacking(XColor(red: 0.047, green: 0.051, blue: 0.059, alpha: 1))
    }
    required init?(coder: NSCoder) { fatalError("not used") }

    func accept(_ frame: SpectrumFeed.Frame) {
        bins = frame.bins
        if holdEnabled {
            if hold.count != bins.count { hold = bins }
            for i in 0..<bins.count { hold[i] = max(bins[i], hold[i] - holdDecayDbPerFrame) }
        }
        // The receiver moving does not move what was already measured: every
        // row drawn before it belongs to the frequencies it was measured at, so
        // the bitmap slides to keep them there. Without this a pan leaves the
        // whole history lying about where its signals were.
        if centerFreq != 0, frame.centerFreq != centerFreq, iqRate > 0, fallWidth > 0 {
            let hzPerColumn = Double(iqRate) / max(1, zoom) / Double(fallWidth)
            if hzPerColumn > 0 {
                shiftWaterfall(byColumns: Int(((Double(frame.centerFreq) - Double(centerFreq))
                                               / hzPerColumn).rounded()))
            }
        }
        iqRate = frame.iqRate
        centerFreq = frame.centerFreq
        // The view stops overriding the window once the receiver has reached
        // it. Compared against the frame rather than against what was asked
        // for, so a centre the device clamped still resolves.
        if viewCenterHz > 0, UInt32(max(0, viewCenterHz.rounded())) == frame.centerFreq {
            viewCenterHz = 0
        }
        let now = Date()
        if let prev = lastFrameAt {
            let dt = now.timeIntervalSince(prev)
            // Ignore a gap that means "the feed stalled", not "this is the rate".
            if dt > 0, dt < 2 { frameInterval = frameInterval == 0 ? dt : frameInterval * 0.9 + dt * 0.1 }
        }
        lastFrameAt = now
        if wfAccum.count != bins.count {
            wfAccum = bins
        } else {
            for i in 0..<bins.count where bins[i] > wfAccum[i] { wfAccum[i] = bins[i] }
        }
        wfSkipCount += 1
        if wfSkipCount >= wfFrameSkip {
            wfSkipCount = 0
            pushWaterfallRow()
            wfAccum = []
        }
        redraw()
    }

    /// True while frames are arriving; the view says so rather than showing a
    /// frozen spectrum that looks live.
    private var isLive: Bool {
        guard let t = lastFrameAt else { return false }
        return Date().timeIntervalSince(t) < 1.5
    }


    /// Map a bin window onto `count` output columns, the way the deck's FFT
    /// dial already does it (`src/actions/spyDialFft.ts`).
    ///
    /// The obvious loop — one bin sampled per column — silently discards every
    /// other bin under that column. At zoom 1 that is most of them, and a
    /// carrier narrower than a column vanishes or not depending purely on where
    /// it happens to land. Two regimes instead:
    ///   * a column covers >= 1 bin: take the peak, so nothing narrow is lost
    ///   * a column covers < 1 bin: interpolate, so high zoom draws a curve
    ///     rather than a staircase of repeated bin values
    private func columns(from src: [Float], _ start: Int, _ end: Int, _ count: Int) -> [Float] {
        let n = src.count
        guard n > 0, count > 0 else { return [] }
        let lo = max(0, min(n - 1, start))
        let hi = max(lo + 1, min(n, end))
        let visN = hi - lo
        var out = [Float](repeating: -200, count: count)
        if visN >= count {
            var lastEnd = lo
            for x in 0..<count {
                let s = lastEnd
                let e = min(hi, lo + (x + 1) * visN / count)
                var m = -Float.greatestFiniteMagnitude
                var k = s
                while k < e { if src[k] > m { m = src[k] }; k += 1 }
                out[x] = e > s ? m : src[min(n - 1, s)]
                lastEnd = e
            }
        } else {
            let perCol = Double(visN) / Double(count)
            for x in 0..<count {
                let f = Double(lo) + (Double(x) + 0.5) * perCol
                let i0 = max(lo, min(hi - 1, Int(f)))
                let i1 = min(hi - 1, i0 + 1)
                let t = Float(f - Double(i0))
                out[x] = src[i0] + (src[i1] - src[i0]) * t
            }
        }
        return out
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

    /// Slide the history sideways by whole columns. Positive means the window
    /// moved up in frequency, so the picture moves left by that much and the
    /// vacated edge is left empty — nothing has been measured there yet.
    private func shiftWaterfall(byColumns cols: Int) {
        guard cols != 0, fallWidth > 0, fallHeight > 0,
              fallPixels.count >= fallWidth * fallHeight * 4 else { return }
        if abs(cols) >= fallWidth {
            for i in 0..<fallPixels.count { fallPixels[i] = 0 }
            return
        }
        let rowBytes = fallWidth * 4
        let move = abs(cols) * 4
        fallPixels.withUnsafeMutableBytes { raw in
            guard let base = raw.baseAddress else { return }
            for r in 0..<fallHeight {
                let row = base.advanced(by: r * rowBytes)
                if cols > 0 {
                    memmove(row, row.advanced(by: move), rowBytes - move)
                    memset(row.advanced(by: rowBytes - move), 0, move)
                } else {
                    memmove(row.advanced(by: move), row, rowBytes - move)
                    memset(row, 0, move)
                }
            }
        }
    }

    private func pushWaterfallRow() {
        guard fallWidth > 0, fallHeight > 0, !bins.isEmpty else { return }
        let src = wfAccum.count == bins.count ? wfAccum : bins
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

        // Noise floor for this frame, as a low percentile of the visible bins.
        // A percentile rather than the minimum: one dead bin would otherwise
        // anchor the whole ramp. Sampled every 8th bin — the floor is a bulk
        // property, and sorting the full FFT every frame is not worth it.
        var sample: [Float] = []
        sample.reserveCapacity(winCount / 8 + 1)
        var i = win.start
        while i < win.end { sample.append(src[i]); i += 8 }
        if sample.count > 4 {
            sample.sort()
            let p15 = sample[max(0, min(sample.count - 1, sample.count * 15 / 100))]
            // Ease toward the estimate so a burst of noise does not make the
            // whole waterfall change colour for one row and back again.
            wfFloorEst = frameInterval > 0 && wfFloorEst > -300 ? wfFloorEst * 0.92 + p15 * 0.08 : p15
        }
        let lo = wfFloorEst - 4
        let hi = lo + max(10, wfRangeDb)
        let cols = columns(from: src, win.start, win.end, fallWidth)
        for x in 0..<fallWidth {
            let b = cols[x]
            let t = CGFloat(max(0, min(1, (b - lo) / (hi - lo))))
            let (r, g, bl) = color(for: t)
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

    /// The aim mark. Dashed and white against the tuned marker's solid red, so
    /// a glance says which line is the receiver and which is the proposal. The reading goes in the top of the waterfall well: the trace's
    /// own top corner is where the station labels stack.
    private func drawAim(_ ctx: CGContext, xOf: (Double) -> CGFloat,
                           h: CGFloat, fallTop: CGFloat) {
        guard let hz = aimHz else { return }
        let x = xOf(hz).rounded() + 0.5
        ctx.saveGState()
        ctx.setStrokeColor(XColor(white: 0.95, alpha: 0.92).cgColor)
        ctx.setLineWidth(1)
        ctx.setLineDash(phase: 0, lengths: [5, 4])
        ctx.move(to: CGPoint(x: x, y: 0))
        ctx.addLine(to: CGPoint(x: x, y: h))
        ctx.strokePath()
        ctx.restoreGState()
        let text = axisFreq(hz)
        // Flipped to the left of the line near the right edge, so the reading
        // never runs off the panel it belongs to.
        let wide = CGFloat(text.count) * 8 + 8
        let tx = x + wide > bounds.width ? x - wide : x + 5
        axisLabel(text, at: CGPoint(x: tx, y: fallTop + 4),
                  color: XColor(white: 0.95, alpha: 0.95))
    }

    private func axisLabel(_ text: String, at p: CGPoint, size: CGFloat = 13,
                           color: XColor = XColor(white: 0.68, alpha: 1)) {
        NSAttributedString(string: text, attributes: [
            .font: xMono(size, .regular),
            .foregroundColor: color,
        ]).draw(at: p)
    }

    /// Axis labels in the style receivers use: 440K, 9.910M.
    private func axisFreq(_ hz: Double) -> String {
        if hz >= 1_000_000 { return String(format: "%.3fM", hz / 1_000_000) }
        return String(format: "%.0fK", hz / 1000)
    }

    // MARK: the split, dragged

    /// The scale rail, which doubles as the split's grab handle. One geometry,
    /// used by the drawing, the cursor rect and the hit test, so the handle
    /// cannot drift away from the line it appears to move.
    private func railRect(_ b: CGRect) -> CGRect {
        let specH = ((b.height - axisStrip) * spectrumFraction).rounded()
        return CGRect(x: 0, y: specH, width: b.width, height: axisStrip)
    }

    private var draggingSplit = false

    // Pointer-driven, so macOS only. The same split is dragged on iPad, but by
    // a gesture recogniser the view controller installs — a touch has no hover
    // and no cursor to change, and pretending otherwise is how a port grows a
    // second set of rules for the same interaction.
#if !canImport(UIKit)
    override func resetCursorRects() {
        super.resetCursorRects()
        addCursorRect(railRect(bounds), cursor: .resizeUpDown)
    }

    override func mouseDown(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        // A few points of slop on each edge: the rail is 24 pt tall, but the
        // line the eye aims at is its border, and a handle that starts exactly
        // where the target ends is one the pointer keeps missing.
        draggingSplit = railRect(bounds).insetBy(dx: 0, dy: -4).contains(p)
        if !draggingSplit { super.mouseDown(with: event) }
    }

    override func mouseDragged(with event: NSEvent) {
        guard draggingSplit else { super.mouseDragged(with: event); return }
        let usable = bounds.height - axisStrip
        guard usable > 0 else { return }
        let p = convert(event.locationInWindow, from: nil)
        // The pointer holds the middle of the rail, not its top edge, so the
        // handle does not jump under the cursor on the first movement.
        spectrumFraction = (p.y - axisStrip / 2) / usable
    }

    override func mouseUp(with event: NSEvent) {
        guard draggingSplit else { super.mouseUp(with: event); return }
        draggingSplit = false
        onSplitChanged?(spectrumFraction)
    }
#endif

    /// Frequency scale: ruled through the trace, labelled in the strip between
    /// trace and waterfall so both share one x mapping.
    ///
    /// Split out of draw() so the waiting display can use it. The receiver's
    /// centre and IQ width are known from the status feed before any frame
    /// arrives, and a scale drawn from those is the same scale — what is
    /// missing while waiting is the trace, not the axis.
    private func drawFrequencyScale(_ ctx: CGContext, plotX: CGFloat, plotW: CGFloat,
                                    specH: CGFloat, lo: Double, span: Double,
                                    xOf: (Double) -> CGFloat) {
        func x(forHz hz: Double) -> CGFloat { xOf(hz) }
        // Grid step chosen as the ladder rung *nearest* the ideal spacing,
        // judged in log space so rungs are compared by ratio the way spacing
        // is actually perceived.
        //
        // The ladder is deliberately finer than the usual 1-2-5. Every gap
        // in 1-2-5 is a factor of 2, so the line count had to swing by that
        // much between rungs: measured over a 1x-64x sweep it ran 3.2-8.0
        // lines (2.49x). Filling in 1.25/1.5/2.5/3/4/6/8 caps every gap at
        // 1.33x and holds the count at 7.0-9.2 (1.31x) — the graticule now
        // subdivides smoothly under zoom instead of lurching at each rung.
        // 1-2-2.5-5 was tried first and only reached 1.97x, not enough.
        // Major spacing follows the window, not a fixed count: one labelled
        // line per ~LABEL_PITCH px keeps the labels from crowding as the
        // window is resized, and a wide window earns more of them.
        let LABEL_PITCH: CGFloat = 110
        let targetTicks = max(4.0, Double(plotW / LABEL_PITCH))
        let raw = span / targetTicks
        let mag = pow(10, (log10(raw)).rounded(.down))
        let step = [1.0, 1.25, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0, 8.0, 10.0].map { mag * $0 }
            .min(by: { abs(log($0 / raw)) < abs(log($1 / raw)) }) ?? mag

        // Minor lines subdivide each major interval. Label width — not
        // legibility of the ruling — is what caps the major spacing, so
        // without these the graticule is only ever as fine as the text
        // allows, which is what read as coarse under zoom. Subdivision
        // matches the rung so the minors land on round values too: 5 parts
        // for a 1/2.5/5 rung, 4 for 4/8, 3 for 1.5/3/6, 2 otherwise.
        let rung = step / mag
        let sub: Int
        switch rung {
        case 1.0, 2.5, 5.0, 10.0: sub = 5
        case 4.0, 8.0:            sub = 4
        case 1.5, 3.0, 6.0:       sub = 3
        default:                  sub = 2
        }
        let minorStep = step / Double(sub)
        if plotW / CGFloat(span / minorStep) >= 9 {
            ctx.setStrokeColor(XColor(white: 0.030, alpha: 1).cgColor)
            ctx.setLineWidth(0.5)
            var mf = (lo / minorStep).rounded(.up) * minorStep
            while mf < lo + span {
                let px = x(forHz: mf)
                ctx.move(to: CGPoint(x: px, y: 0)); ctx.addLine(to: CGPoint(x: px, y: specH))
                mf += minorStep
            }
            ctx.strokePath()
        }

        var f = (lo / step).rounded(.up) * step
        ctx.setStrokeColor(XColor(white: 0.052, alpha: 1).cgColor)
        ctx.setLineWidth(0.5)
        while f < lo + span {
            let px = x(forHz: f)
            ctx.move(to: CGPoint(x: px, y: 0)); ctx.addLine(to: CGPoint(x: px, y: specH))
            let text = axisFreq(f)
            axisLabel(text, at: CGPoint(x: px - CGFloat(text.count) * 3.9, y: specH + 4))
            f += step
        }
        ctx.strokePath()
        ctx.setLineWidth(1)
    }

    /// Preset names on the trace, stacked so they never overlap.
    ///
    /// Split out of draw() so the waiting display can use it: the presets are
    /// what the panel has to show before a frame arrives, and they need an x
    /// mapping rather than a trace.
    private func drawStationLabels(_ ctx: CGContext, specH: CGFloat,
                                   lo: Double, span: Double,
                                   xOf: (Double) -> CGFloat) {
        guard span > 0 else { return }
        func x(forHz hz: Double) -> CGFloat { xOf(hz) }
    // Station labels, stacked so they never overlap.
    //
    // Medium wave puts stations 9 kHz apart; at a wide span their labels
    // are far wider than that gap, and drawn at one height they overprint
    // each other into an unreadable smear ("RKB毎日放 HBCラジオ"). Each
    // label takes the topmost row whose previous label has already ended,
    // so neighbours step down instead of colliding.
        let attrs: [NSAttributedString.Key: Any] = [
            .font: xMono(16, .semibold),
            .foregroundColor: XColor.black,
        ]
        let rowH: CGFloat = 24
        let maxRows = max(1, Int((specH * 0.45) / rowH))
        var rowEnds = [CGFloat](repeating: -1_000_000, count: maxRows)

        let visible = markers.filter { $0.freq > lo && $0.freq < lo + span }
                             .sorted { $0.freq < $1.freq }
        for m in visible {
            let px = x(forHz: m.freq)
            let text = m.name as NSString
            let size = text.size(withAttributes: attrs)
            let boxX = px - size.width / 2 - 5
            let boxW = size.width + 10
            let boxH = size.height + 4
            // First row this label fits on. When every row is still
            // occupied at this x the label is dropped rather than drawn
            // over another one — a smeared name is worse than no name.
            guard let row = (0..<maxRows).first(where: { rowEnds[$0] < boxX - 4 }) else { continue }
            rowEnds[row] = boxX + boxW
            let y = CGFloat(row) * rowH + 1

            ctx.setStrokeColor(XColor(red: 0.949, green: 0.749, blue: 0.349, alpha: 0.55).cgColor)
            ctx.setLineWidth(1)
            ctx.move(to: CGPoint(x: px, y: y + boxH))
            ctx.addLine(to: CGPoint(x: px, y: specH))
            ctx.strokePath()

            ctx.setFillColor(XColor(red: 0.949, green: 0.808, blue: 0.349, alpha: 0.92).cgColor)
            ctx.fill(CGRect(x: boxX, y: y, width: boxW, height: boxH))
            text.draw(at: CGPoint(x: boxX + 5, y: y + 2), withAttributes: attrs)
        }
    }

    // MARK: drawing

    override func draw(_ dirtyRect: CGRect) {
        guard let ctx = currentContext else { return }
        let w = bounds.width, h = bounds.height
        let plotX = gutter
        let plotW = max(1, w - gutter)
        let specH = ((h - axisStrip) * spectrumFraction).rounded()
        let fallTop = specH + axisStrip
        let fallH = max(1, h - fallTop)

        ctx.setFillColor(XColor(red: 0.047, green: 0.051, blue: 0.059, alpha: 1).cgColor)
        ctx.fill(bounds)

        // A hairline round each of the two panels. Half a point — one physical
        // pixel on a retina screen — because at a full point an outline sits
        // heavier than the graticule it contains, and the point of it is to say
        // where each panel ends, not to draw attention to itself.
        //
        // On the way out rather than here: the waterfall's bitmap fills its
        // rect exactly and the trace runs to its edges, so anything drawn now
        // would be painted over. Inset by a quarter point so the stroke lands
        // inside the view instead of straddling its edge and losing half of
        // itself to the clip.
        defer {
            ctx.setStrokeColor(XColor(white: 0.30, alpha: 1).cgColor)
            ctx.setLineWidth(0.5)
            for panel in [CGRect(x: plotX, y: 0, width: plotW, height: specH),
                          CGRect(x: plotX, y: fallTop, width: plotW, height: fallH)] {
                ctx.stroke(panel.insetBy(dx: 0.25, dy: 0.25))
            }
        }

        // Three surfaces rather than one flat field: the trace, the scale rail
        // under it, and the waterfall well. The display used to be a single
        // ground with the plot floating in it — running, where the spectrum
        // ended and the waterfall began was left to the eye to work out, and
        // before the first frame there was nothing on screen at all but a
        // column of dB numbers.
        ctx.setFillColor(XColor(white: 0.085, alpha: 1).cgColor)
        ctx.fill(CGRect(x: 0, y: specH, width: w, height: axisStrip))
        ctx.setFillColor(XColor(white: 0.018, alpha: 1).cgColor)
        ctx.fill(CGRect(x: plotX, y: fallTop, width: plotW, height: fallH))

        // The frame: the two horizontal rules that divide those surfaces, and
        // the gutter's own edge. Brighter than the graticule inside the plot on
        // purpose — a frame that reads no stronger than the ruling it contains
        // is not doing a frame's job.
        // Half-pixel offsets so a 1 pt rule lands on one physical row instead
        // of straddling two and going soft.
        ctx.setStrokeColor(XColor(white: 0.20, alpha: 1).cgColor)
        ctx.setLineWidth(1)
        for y in [specH, fallTop] {
            ctx.move(to: CGPoint(x: 0, y: y + 0.5))
            ctx.addLine(to: CGPoint(x: w, y: y + 0.5))
        }
        ctx.move(to: CGPoint(x: plotX + 0.5, y: 0))
        ctx.addLine(to: CGPoint(x: plotX + 0.5, y: h))
        ctx.strokePath()

        // Grip marks, so the rail reads as something to take hold of. Drawn in
        // the gutter's width of it, which carries no frequency label and is the
        // only part of the rail that is always free.
        ctx.setStrokeColor(XColor(white: 0.34, alpha: 1).cgColor)
        ctx.setLineWidth(1)
        let gripW: CGFloat = 18
        let gripX = ((gutter - gripW) / 2).rounded()
        for k in -1...1 {
            let y = (specH + axisStrip / 2).rounded() + CGFloat(k) * 4 + 0.5
            ctx.move(to: CGPoint(x: gripX, y: y))
            ctx.addLine(to: CGPoint(x: gripX + gripW, y: y))
        }
        ctx.strokePath()

        // dB scale: label every 10 dB, rule every one of them. Reading a level
        // off the trace is the point of a spectrum; without a scale it is just
        // a shape.
        // Rules are a reference, not content: dark enough that the trace and the
        // station labels sit clearly in front of them.
        ctx.setStrokeColor(XColor(white: 0.052, alpha: 1).cgColor)
        // 0.5 pt, not 1: on a Retina display a 1 pt rule is two physical
        // pixels, which reads as a drawn line rather than a graticule.
        ctx.setLineWidth(0.5)
        var db = (Double(dbCeil) / 10).rounded(.down) * 10
        while db >= Double(dbFloor) {
            let y = specH - norm(Float(db)) * specH
            ctx.move(to: CGPoint(x: plotX, y: y)); ctx.addLine(to: CGPoint(x: w, y: y))
            axisLabel(String(format: "%.0f", db), at: CGPoint(x: 8, y: y - 9))
            db -= 10
        }
        ctx.strokePath()

        // The window on screen, from a frame when there is one and from the
        // status feed when there is not. Deriving it in both states is what
        // lets the presets be drawn while waiting: they need an x mapping, not
        // a trace.
        let liveWin = bins.isEmpty ? nil : visible(bins.count)
        let span: Double
        let rawLo: Double
        /// The frequency to mark as tuned. Frames carry it; before they do,
        /// the status feed does.
        let tunedHz: Double
        if let w = liveWin {
            span = w.span
            rawLo = w.lo
            tunedHz = vfoHz > 0 ? vfoHz : Double(centerFreq)
        } else {
            span = idleSpanHz > 0 ? idleSpanHz / max(1, zoom) : 0
            rawLo = idleCenterHz - span / 2
            tunedHz = idleCenterHz
        }
        // The window on screen, and how far the data has to move to stay under
        // the frequencies it belongs to. Applied to the window, so the scale,
        // the station labels and the marker all follow it for free.
        let lo = viewCenterHz > 0 ? viewCenterHz - span / 2 : rawLo
        let panPixels: CGFloat = span > 0 ? CGFloat((rawLo - lo) / span) * plotW : 0
        visibleLoHz = lo
        visibleSpanHz = span
        func x(forHz hz: Double) -> CGFloat {
            guard span > 0 else { return plotX }
            return plotX + CGFloat((hz - lo) / span) * plotW
        }

        if bins.isEmpty || !isLive {
            // The notice goes in the waterfall's well while waiting, and over
            // the trace only when a live feed has stalled. At the top of the
            // plot it collided with the station labels, which start in that
            // same corner — and the labels are the thing worth reading.
            let noticeAt = bins.isEmpty
                ? CGPoint(x: plotX + 10, y: fallTop + 14)
                : CGPoint(x: plotX + 8, y: 8)
            axisLabel(bins.isEmpty ? "waiting for the receiver" : "feed stalled",
                      at: noticeAt, size: 15,
                      color: XColor(white: 0.66, alpha: 1))
            if bins.isEmpty, span > 0 {
                // The receiver's frequency and IQ width are known before any
                // frame is, so the scale and the presets can be drawn now.
                // What is missing is the trace, and only the trace.
                drawFrequencyScale(ctx, plotX: plotX, plotW: plotW, specH: specH,
                                   lo: lo, span: span, xOf: x(forHz:))
                ctx.setStrokeColor(XColor(red: 0.96, green: 0.24, blue: 0.24, alpha: 1).cgColor)
                ctx.setLineWidth(1.6)
                let cx = x(forHz: tunedHz).rounded()
                ctx.move(to: CGPoint(x: cx, y: 0)); ctx.addLine(to: CGPoint(x: cx, y: h))
                ctx.strokePath()
                drawStationLabels(ctx, specH: specH, lo: lo, span: span, xOf: x(forHz:))
                drawAim(ctx, xOf: x(forHz:), h: h, fallTop: fallTop)
                return
            }
            if bins.isEmpty {
                // An even graticule while there is nothing to draw, so an idle
                // receiver reads as an instrument waiting for a signal rather
                // than as an empty panel. Deliberately unlabelled: with no
                // frame there is no span, and a frequency scale drawn over
                // nothing would be a number the receiver never reported.
                //
                // Carried through the waterfall well too, which is the larger
                // half of the display and otherwise sits there as a void. Once
                // frames arrive the bitmap covers it and the graticule belongs
                // to the trace alone, as it does on any receiver.
                // A step brighter than the live ruling: with nothing drawn over
                // it there is no trace for it to stay behind, and at the live
                // value it was invisible.
                ctx.setStrokeColor(XColor(white: 0.085, alpha: 1).cgColor)
                ctx.setLineWidth(0.5)
                let cols = 12
                for i in 1..<cols {
                    let px = (plotX + plotW * CGFloat(i) / CGFloat(cols)).rounded() + 0.5
                    ctx.move(to: CGPoint(x: px, y: 0))
                    ctx.addLine(to: CGPoint(x: px, y: specH))
                    ctx.move(to: CGPoint(x: px, y: fallTop))
                    ctx.addLine(to: CGPoint(x: px, y: h))
                }
                ctx.strokePath()
                return
            }
        }

        let n = bins.count
        let win = liveWin!

        if span > 0 {
            drawFrequencyScale(ctx, plotX: plotX, plotW: plotW, specH: specH,
                               lo: lo, span: span, xOf: x(forHz:))
        }

        // waterfall
        // The waterfall is a bitmap, so unlike every vector element around it
        // it has a resolution of its own. Sizing it in points meant a 2x display
        // stretched each pixel over four, and the waterfall alone looked soft
        // against crisp text and rules. Size it in device pixels instead; the
        // buffer is a few MB either way.
        let scale = max(1, Int(pixelScale.rounded()))
        ensureFall(width: max(1, Int(plotW) * scale), height: max(1, Int(fallH) * scale))
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
                    // Pixel-for-pixel at this point, so any smoothing is loss
                    // with no upside.
                    ctx.interpolationQuality = .none
                    // Each row was captured at the frequencies it was captured
                    // at, so a pan carries the history with it. Clipped, or it
                    // would slide over the dB gutter.
                    ctx.clip(to: CGRect(x: plotX, y: 0, width: plotW, height: fallH))
                    ctx.draw(img, in: CGRect(x: plotX + panPixels, y: 0,
                                             width: plotW, height: fallH))
                    ctx.restoreGState()
                }
            }
        }

        // passband, before the trace so the trace stays readable on top of it
        if bandwidthHz > 0, span > 0 {
            let half = bandwidthHz / 2
            let r = CGRect(x: x(forHz: tunedHz - half), y: 0,
                           width: max(2, x(forHz: tunedHz + half) - x(forHz: tunedHz - half)),
                           height: h)
            ctx.setFillColor(XColor(red: 0.85, green: 0.35, blue: 0.30, alpha: 0.16).cgColor)
            ctx.fill(r)
        }

        // trace + fill. Drawn from bin columns rather than from frequencies,
        // so the pan is applied here as a translation instead.
        ctx.saveGState()
        ctx.clip(to: CGRect(x: plotX, y: 0, width: plotW, height: h))
        ctx.translateBy(x: panPixels, y: 0)
        let path = CGMutablePath()
        let traceCols = columns(from: bins, win.start, win.end, max(1, Int(plotW)))
        for px in 0..<Int(plotW) {
            let b = traceCols[px]
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
                                 colors: [XColor(red: 0.40, green: 0.70, blue: 0.95, alpha: 0.30).cgColor,
                                          XColor(red: 0.40, green: 0.70, blue: 0.95, alpha: 0.02).cgColor] as CFArray,
                                 locations: [0, 1]) {
            ctx.drawLinearGradient(grad, start: CGPoint(x: 0, y: 0), end: CGPoint(x: 0, y: specH), options: [])
        }
        ctx.restoreGState()
        ctx.addPath(path)
        ctx.setStrokeColor(XColor(red: 0.78, green: 0.90, blue: 1.0, alpha: 1).cgColor)
        ctx.setLineWidth(1.2)
        ctx.strokePath()

        if holdEnabled, hold.count == n {
            let hp = CGMutablePath()
            let holdCols = columns(from: hold, win.start, win.end, max(1, Int(plotW)))
            for px in 0..<Int(plotW) {
                let v = holdCols[px]
                let p = CGPoint(x: plotX + CGFloat(px), y: specH - norm(v) * specH)
                if px == 0 { hp.move(to: p) } else { hp.addLine(to: p) }
            }
            ctx.addPath(hp)
            ctx.setStrokeColor(XColor(red: 0.949, green: 0.749, blue: 0.349, alpha: 0.8).cgColor)
            ctx.setLineWidth(1)
            ctx.strokePath()
        }
        ctx.restoreGState()

        // Tuned marker, full height so it ties trace and waterfall together.
        // Red, and the only red on the display: the preset labels and their
        // lines are amber, so "where am I listening" never competes with
        // "what else is here".
        ctx.setStrokeColor(XColor(red: 0.96, green: 0.24, blue: 0.24, alpha: 1).cgColor)
        ctx.setLineWidth(1.6)
        let cx = x(forHz: tunedHz).rounded()
        ctx.move(to: CGPoint(x: cx, y: 0)); ctx.addLine(to: CGPoint(x: cx, y: h))
        ctx.strokePath()

        drawStationLabels(ctx, specH: specH, lo: lo, span: span, xOf: x(forHz:))
        drawAim(ctx, xOf: x(forHz:), h: h, fallTop: fallTop)
    }

}
