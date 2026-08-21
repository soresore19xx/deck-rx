import AppKit

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
final class FreqView: NSView {
    /// Called with the frequency to tune to, in Hz.
    var onTune: ((Double) -> Void)?

    private var freqHz: Double = 0
    private var text = "—"
    /// Hz weight of each character in `text`; 0 for the decimal point.
    private var weights: [Double] = []
    private var hoverIndex: Int?
    private var hoverUp = true

    private let digitFont = NSFont.monospacedSystemFont(ofSize: 72, weight: .bold)
    private let unitFont = NSFont.monospacedSystemFont(ofSize: 26, weight: .medium)

    override var isFlipped: Bool { true }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        let area = NSTrackingArea(rect: .zero,
                                  options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect],
                                  owner: self, userInfo: nil)
        addTrackingArea(area)
    }
    required init?(coder: NSCoder) { fatalError() }

    func set(freqHz: Double) {
        guard freqHz != self.freqHz else { return }
        self.freqHz = freqHz
        (text, weights) = Self.render(freqHz)
        invalidateIntrinsicContentSize()
        needsDisplay = true
    }

    /// Full Hz, grouped in threes: 000.954.000. Every decade from 100 MHz down
    /// to 1 Hz is on screen and therefore clickable, which a unit-switching
    /// readout cannot offer — in MHz form the smallest digit was 10 kHz, so
    /// nothing finer could be tuned by hand, and the set of digits moved under
    /// the cursor whenever the display crossed a unit boundary. Leading zeros
    /// are drawn dim, so "954 kHz" still reads at a glance.
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

    private struct Cell { let ch: Character; let x: CGFloat; let w: CGFloat; let weight: Double }

    /// Not named layout() — NSView already has one.
    private func cells() -> [Cell] {
        var out: [Cell] = []
        var cx: CGFloat = 0
        for (i, c) in text.enumerated() {
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
        let unitW: CGFloat = ("Hz" as NSString).size(withAttributes: [.font: unitFont]).width
        return digits + 12 + unitW + 8
    }

    override var intrinsicContentSize: NSSize {
        NSSize(width: contentWidth, height: DH * 1.2)
    }

    private func index(at point: NSPoint) -> Int? {
        for (i, c) in cells().enumerated() where c.weight > 0 {
            if point.x >= c.x && point.x < c.x + c.w { return i }
        }
        return nil
    }

    // MARK: interaction

    override func mouseMoved(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        let i = index(at: p)
        let up = p.y < bounds.height / 2
        if i != hoverIndex || up != hoverUp { hoverIndex = i; hoverUp = up; needsDisplay = true }
    }
    override func mouseExited(with event: NSEvent) { hoverIndex = nil; needsDisplay = true }

    override func mouseDown(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        guard let i = index(at: p), freqHz > 0 else { return }
        // Upper half increments, lower half decrements — the convention every
        // radio with a digit display uses.
        let delta = (p.y < bounds.height / 2 ? 1.0 : -1.0) * weights[i]
        onTune?(max(0, freqHz + delta))
    }

    override func scrollWheel(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        guard let i = index(at: p), freqHz > 0 else { return }
        let dir: Double = event.scrollingDeltaY > 0 ? 1 : (event.scrollingDeltaY < 0 ? -1 : 0)
        guard dir != 0 else { return }
        onTune?(max(0, freqHz + dir * weights[i]))
    }

    // MARK: drawing

    private let litColor = NSColor.white
    // Leading zeros: clearly present, clearly not the value. At 0.26 they read
    // as smudges on a black panel rather than as digits.
    private let leadColor = NSColor(white: 0.38, alpha: 1)
    private let offColor = NSColor(white: 0.11, alpha: 1)

    /// One segment: a bar with its far corners cut, as the plugin draws them.
    private func segment(_ ctx: CGContext, _ r: CGRect, _ color: NSColor) {
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

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let oy = (bounds.height - DH) / 2
        let list = cells()
        // Everything before the first non-zero digit is padding, not value: it
        // stays lit but dim, the way a real display shows leading zeros.
        let firstSignificant = list.firstIndex { $0.ch != "0" && $0.ch != "." }

        for (i, cell) in list.enumerated() {
            let lead = firstSignificant.map { i < $0 } ?? true
            let onColor: NSColor = lead ? leadColor : litColor
            if hoverIndex == i {
                ctx.setFillColor(NSColor(red: 0.349, green: 0.851, blue: 0.451, alpha: 0.18).cgColor)
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
        ("Hz" as NSString).draw(at: CGPoint(x: endX, y: oy + DH - unitFont.pointSize * 1.15),
                                withAttributes: [.font: unitFont,
                                                 .foregroundColor: NSColor(white: 0.72, alpha: 1)])
    }
}
