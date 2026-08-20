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

    private let digitFont = NSFont.monospacedSystemFont(ofSize: 60, weight: .bold)
    private let unitFont = NSFont.monospacedSystemFont(ofSize: 22, weight: .medium)

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

    private var digitWidth: CGFloat { ("0" as NSString).size(withAttributes: [.font: digitFont]).width }

    override var intrinsicContentSize: NSSize {
        let w = digitWidth * CGFloat(text.count) + 12
            + ("Hz" as NSString).size(withAttributes: [.font: unitFont]).width + 10
        return NSSize(width: w, height: digitFont.pointSize * 1.25)
    }

    private func index(at point: NSPoint) -> Int? {
        let i = Int(point.x / digitWidth)
        guard i >= 0, i < weights.count, weights[i] > 0 else { return nil }
        return i
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

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let bright = NSColor.white
        let dim = NSColor(white: 0.30, alpha: 1)
        // Everything before the first non-zero digit is padding, not value.
        let firstSignificant = text.firstIndex { $0 != "0" && $0 != "." }
        var x: CGFloat = 0
        let baselineY = (bounds.height - digitFont.pointSize * 1.1) / 2

        for (i, c) in text.enumerated() {
            let idx = text.index(text.startIndex, offsetBy: i)
            let lead = firstSignificant.map { idx < $0 } ?? true
            let attrs: [NSAttributedString.Key: Any] = [
                .font: digitFont,
                .foregroundColor: c == "." ? dim : (lead ? dim : bright),
            ]
            if hoverIndex == i {
                let half = CGRect(x: x, y: hoverUp ? 0 : bounds.height / 2,
                                  width: digitWidth, height: bounds.height / 2)
                ctx.setFillColor(NSColor(red: 0.349, green: 0.851, blue: 0.451, alpha: 0.18).cgColor)
                ctx.fill(half)
            }
            let s = String(c) as NSString
            s.draw(at: CGPoint(x: x + (digitWidth - s.size(withAttributes: attrs).width) / 2, y: baselineY),
                   withAttributes: attrs)
            x += digitWidth
        }
        x += 10
        ("Hz" as NSString).draw(at: CGPoint(x: x, y: baselineY + digitFont.pointSize * 0.55),
                                withAttributes: [.font: unitFont,
                                                 .foregroundColor: NSColor(white: 0.55, alpha: 1)])
    }
}
