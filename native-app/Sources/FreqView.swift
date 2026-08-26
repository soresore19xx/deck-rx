#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

/// The frequency readout, tunable digit by digit.
///
/// Nearly every SDR front-end lets you click above or below a digit to step
/// that decade, and it is the fastest way to move a known distance: to go from
/// 954 kHz to 1134 kHz you nudge the 100 kHz digit twice rather than holding a
/// tune button through twenty steps. Scrolling over a digit does the same.
///
/// The decade of each digit is derived from the displayed text, so it stays
/// correct across the unit switches the readout does (kHz below 30 MHz, MHz
/// above it) without a second source of truth.
final class FreqView: XView {
    /// Called with the frequency to tune to, in Hz.
    var onTune: ((Double) -> Void)?

    private var freqHz: Double = 0
    private var text = "—"
    /// The unit the digits are read in. The digits themselves do not change
    /// with it — the rightmost is always 1 Hz — so this is a label, not a
    /// conversion: 000.954.000 is 954.000 kHz, and calling it Hz made the last
    /// group read as a fraction of the wrong unit.
    static let unit = "kHz"
    /// Hz weight of each character in `text`; 0 for a group separator.
    private var weights: [Double] = []
    private var hoverIndex: Int?
    private var hoverUp = true

    private let digitFont = xMono(72, .bold)
    private let unitFont = xMono(26, .medium)

    // Top-down, which UIKit does natively and AppKit has to be told.
    #if !canImport(UIKit)
    override var isFlipped: Bool { true }
    #endif

    override init(frame frameRect: CGRect) {
        super.init(frame: frameRect)
#if !canImport(UIKit)
                let area = NSTrackingArea(rect: .zero,
                                  options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect],
                                  owner: self, userInfo: nil)
        addTrackingArea(area)
#endif
    }
    required init?(coder: NSCoder) { fatalError() }

    /// The digit size is derived from `bounds.height`, so the intrinsic width
    /// is only right once the height constraint has been applied. Without this
    /// the row was measured at the 24 pt floor — a width for digits a fifth of
    /// the size of the ones actually drawn — and the mode chip beside it was
    /// laid out on top of the readout. `set(freqHz:)` re-measures, but it
    /// returns early when the frequency has not moved, so a receiver that came
    /// up on its stored frequency and stayed there never got a second chance.
#if canImport(UIKit)
    /// Same job as the AppKit override below: the digit size comes from the
    /// view's height, so the intrinsic width is only right once the height is.
    private var lastHeight: CGFloat = 0
    override func layoutSubviews() {
        super.layoutSubviews()
        if bounds.height != lastHeight {
            lastHeight = bounds.height
            invalidateIntrinsicContentSize()
            redraw()
        }
    }
#else
    override func setFrameSize(_ newSize: CGSize) {
        let changed = newSize.height != frame.size.height
        super.setFrameSize(newSize)
        if changed {
            invalidateIntrinsicContentSize()
            redraw()
        }
    }
#endif

    func set(freqHz: Double) {
        guard freqHz != self.freqHz else { return }
        self.freqHz = freqHz
        (text, weights) = Self.render(freqHz)
        invalidateIntrinsicContentSize()
        redraw()
    }

    /// Grouped in threes: 000.954.000, labelled kHz. Every decade from 100 MHz down
    /// to 1 Hz is on screen and therefore clickable, which a unit-switching
    /// readout cannot offer — in MHz form the smallest digit was 10 kHz, so
    /// nothing finer could be tuned by hand, and the set of digits moved under
    /// the cursor whenever the display crossed a unit boundary. The digits
    /// above the first significant one are not shown — see `significantStart`.
    static func render(_ hz: Double) -> (String, [Double]) {
        let v = max(0, min(999_999_999, Int(hz.rounded())))
        let digits = String(format: "%09d", v)
        var text = ""
        var weights: [Double] = []
        for (i, c) in digits.enumerated() {
            if i == 3 || i == 6 { text.append("."); weights.append(0) }
            text.append(c)
            weights.append(pow(10, Double(8 - i)))
        }
        return (text, weights)
    }

    // MARK: geometry

    /// Segment geometry ported from the plugin's own 7-seg renderer
    /// (src/dialDisplay.ts seg7svg), so the app's readout and the Stream Deck
    /// LCD are one display at two sizes rather than two designs.
    ///   DW  digit width       = DH * 0.56
    ///   T   segment thickness = max(3, DH * 0.10)
    ///   DOT decimal point     = T * 1.6 — a dot advances far less than a
    ///       digit, which is what closes the gaping separators a monospace
    ///       cell per character produced
    ///   CG  gap between cells = 3
    private var DH: CGFloat { max(24, bounds.height * 0.82) }
    private var DW: CGFloat { DH * 0.56 }
    private var T: CGFloat { max(3, DH * 0.10) }
    private var DOT: CGFloat { T * 1.6 }
    private let CG: CGFloat = 3

    private static let segs: [Character: String] = [
        "0": "abcdef", "1": "bc", "2": "abdeg", "3": "abcdg", "4": "bcfg",
        "5": "acdfg", "6": "acdefg", "7": "abc", "8": "abcdefg", "9": "abcdfg",
    ]

    /// Index of the first character worth showing: the leading zeros and the
    /// separator that trails them are dropped rather than dimmed, so the
    /// frequency starts at the readout's left edge and lines up under the
    /// station name above it. Three grey zeros there left the number floating a
    /// third of the way across the header, with the station name over nothing.
    ///
    /// The decades that disappear stay reachable: a step adds its weight rather
    /// than wrapping within the digit, so pushing the leftmost visible digit up
    /// carries the number into the next decade and the digit for it appears.
    ///
    /// With nothing significant at all — a frequency of zero — the last digit
    /// is kept, because a readout showing nothing is worse than one showing 0.
    static func significantStart(_ text: String) -> Int {
        let chars = Array(text)
        if let i = chars.firstIndex(where: { $0 != "0" && $0 != "." }) { return i }
        return max(0, chars.count - 1)
    }

    private struct Cell { let ch: Character; let x: CGFloat; let w: CGFloat; let weight: Double }

    /// Not named layout() — NSView already has one.
    private func cells() -> [Cell] {
        var out: [Cell] = []
        var cx: CGFloat = 0
        let start = Self.significantStart(text)
        for (i, c) in text.enumerated() where i >= start {
            let w: CGFloat = (c == ".") ? DOT : DW
            let weight: Double = i < weights.count ? weights[i] : 0
            out.append(Cell(ch: c, x: cx, w: w, weight: weight))
            cx += w + CG
        }
        return out
    }

    private var contentWidth: CGFloat {
        let last = cells().last
        let digits: CGFloat = last.map { $0.x + $0.w } ?? 0
        let unitW: CGFloat = (Self.unit as NSString).size(withAttributes: [.font: unitFont]).width
        return digits + 12 + unitW + 8
    }

    override var intrinsicContentSize: CGSize {
        CGSize(width: contentWidth, height: DH * 1.2)
    }

    /// The cell under the pointer, with its decade. The weight travels with the
    /// cell rather than being looked up by index: `cells()` no longer runs
    /// one-to-one with `weights` now that it starts at the first significant
    /// character, and an index into the wrong array tunes the wrong decade.
    private func hit(_ point: CGPoint) -> (index: Int, weight: Double)? {
        for (i, c) in cells().enumerated() where c.weight > 0 {
            if point.x >= c.x && point.x < c.x + c.w { return (i, c.weight) }
        }
        return nil
    }

    // MARK: interaction

#if canImport(UIKit)
    /// Tap the upper half of a digit to step that decade up, the lower half to
    /// step it down. The Mac hovers to show which digit is under the pointer;
    /// a finger has no hover, and the digit it is on is the one it is covering.
    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard let t = touches.first, freqHz > 0 else { return }
        let p = t.location(in: self)
        guard let h = hit(p) else { return }
        let delta = (p.y < bounds.height / 2 ? 1.0 : -1.0) * h.weight
        hoverIndex = h.index
        hoverUp = p.y < bounds.height / 2
        redraw()
        onTune?(max(0, freqHz + delta))
    }
    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        hoverIndex = nil
        redraw()
    }
    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        hoverIndex = nil
        redraw()
    }
#else
    override func mouseMoved(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        let i = hit(p)?.index
        let up = p.y < bounds.height / 2
        if i != hoverIndex || up != hoverUp { hoverIndex = i; hoverUp = up; redraw() }
    }
    override func mouseExited(with event: NSEvent) { hoverIndex = nil; redraw() }

    override func mouseDown(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        guard let h = hit(p), freqHz > 0 else { return }
        // Upper half increments, lower half decrements — the convention every
        // radio with a digit display uses.
        let delta = (p.y < bounds.height / 2 ? 1.0 : -1.0) * h.weight
        onTune?(max(0, freqHz + delta))
    }

    override func scrollWheel(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        guard let h = hit(p), freqHz > 0 else { return }
        let dir: Double = event.scrollingDeltaY > 0 ? 1 : (event.scrollingDeltaY < 0 ? -1 : 0)
        guard dir != 0 else { return }
        onTune?(max(0, freqHz + dir * h.weight))
    }
#endif

    // MARK: drawing

    private let litColor = XColor.white
    /// The unlit segments of a digit that is shown. Faint enough to read as the
    /// face of the display rather than as a value.
    private let offColor = XColor(white: 0.11, alpha: 1)

    /// One segment: a bar with its far corners cut, as the plugin draws them.
    private func segment(_ ctx: CGContext, _ r: CGRect, _ color: XColor) {
        let c = min(r.width, r.height) / 2
        ctx.beginPath()
        ctx.move(to: CGPoint(x: r.minX, y: r.minY))
        ctx.addLine(to: CGPoint(x: r.maxX, y: r.minY))
        ctx.addLine(to: CGPoint(x: r.maxX, y: r.maxY - c))
        ctx.addLine(to: CGPoint(x: r.maxX - c, y: r.maxY))
        ctx.addLine(to: CGPoint(x: r.minX + c, y: r.maxY))
        ctx.addLine(to: CGPoint(x: r.minX, y: r.maxY - c))
        ctx.closePath()
        ctx.setFillColor(color.cgColor)
        ctx.fillPath()
    }

    private func segmentRects(_ cx: CGFloat, _ oy: CGFloat) -> [(Character, CGRect)] {
        let half = DH / 2 - 3 * T / 2
        return [
            ("a", CGRect(x: cx + T, y: oy, width: DW - 2 * T, height: T)),
            ("b", CGRect(x: cx + DW - T, y: oy + T, width: T, height: half)),
            ("c", CGRect(x: cx + DW - T, y: oy + DH / 2 + T / 2, width: T, height: half)),
            ("d", CGRect(x: cx + T, y: oy + DH - T, width: DW - 2 * T, height: T)),
            ("e", CGRect(x: cx, y: oy + DH / 2 + T / 2, width: T, height: half)),
            ("f", CGRect(x: cx, y: oy + T, width: T, height: half)),
            ("g", CGRect(x: cx + T, y: oy + DH / 2 - T / 2, width: DW - 2 * T, height: T)),
        ]
    }

    override func draw(_ dirtyRect: CGRect) {
        guard let ctx = currentContext else { return }
        let oy = (bounds.height - DH) / 2
        // Everything above the first significant digit was dropped by cells(),
        // so what is left is all value and all lit.
        let list = cells()

        for (i, cell) in list.enumerated() {
            let onColor: XColor = litColor
            if hoverIndex == i {
                ctx.setFillColor(XColor(red: 0.349, green: 0.851, blue: 0.451, alpha: 0.18).cgColor)
                ctx.fill(CGRect(x: cell.x - CG / 2, y: hoverUp ? 0 : bounds.height / 2,
                                width: cell.w + CG, height: bounds.height / 2))
            }
            if cell.ch == "." {
                ctx.setFillColor(onColor.cgColor)
                ctx.fill(CGRect(x: cell.x, y: oy + DH - DOT, width: DOT, height: DOT))
                continue
            }
            let on = Self.segs[cell.ch] ?? ""
            for (id, rect) in segmentRects(cell.x, oy) {
                segment(ctx, rect, on.contains(id) ? onColor : offColor)
            }
        }

        let endX = (list.last.map { $0.x + $0.w } ?? 0) + 12
        (Self.unit as NSString).draw(at: CGPoint(x: endX, y: oy + DH - unitFont.pointSize * 1.15),
                                withAttributes: [.font: unitFont,
                                                 .foregroundColor: XColor(white: 0.72, alpha: 1)])
    }
}
