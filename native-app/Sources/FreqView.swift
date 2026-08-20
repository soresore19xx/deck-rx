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
    private var unit = ""
    /// Hz weight of each character in `text`; 0 for the decimal point.
    private var weights: [Double] = []
    private var hoverIndex: Int?
    private var hoverUp = true

    private let digitFont = NSFont.monospacedSystemFont(ofSize: 68, weight: .bold)
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
        let (num, u) = formatFreq(freqHz)
        text = num
        unit = u
        weights = Self.weights(for: num, unitScale: u == "MHz" ? 1_000_000 : 1_000)
        invalidateIntrinsicContentSize()
        needsDisplay = true
    }

    /// Hz value of one step of each character position.
    static func weights(for text: String, unitScale: Double) -> [Double] {
        let chars = Array(text)
        let dot = chars.firstIndex(of: ".")
        let intCount = dot ?? chars.count
        var out = [Double](repeating: 0, count: chars.count)
        for (i, c) in chars.enumerated() where c.isNumber {
            if i < intCount {
                out[i] = unitScale * pow(10, Double(intCount - 1 - i))
            } else {
                out[i] = unitScale * pow(10, -Double(i - intCount))
            }
        }
        return out
    }

    // MARK: geometry

    private var digitWidth: CGFloat { ("0" as NSString).size(withAttributes: [.font: digitFont]).width }

    override var intrinsicContentSize: NSSize {
        let w = digitWidth * CGFloat(text.count) + 12
            + (unit as NSString).size(withAttributes: [.font: unitFont]).width + 10
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
        let attrs: [NSAttributedString.Key: Any] = [.font: digitFont, .foregroundColor: NSColor.white]
        var x: CGFloat = 0
        let baselineY = (bounds.height - digitFont.pointSize * 1.1) / 2

        for (i, c) in text.enumerated() {
            let s = String(c) as NSString
            // A hovered digit shows which half you are over, so the click's
            // direction is never a guess.
            if hoverIndex == i {
                let half = CGRect(x: x, y: hoverUp ? 0 : bounds.height / 2,
                                  width: digitWidth, height: bounds.height / 2)
                ctx.setFillColor(NSColor(red: 0.349, green: 0.851, blue: 0.451, alpha: 0.16).cgColor)
                ctx.fill(half)
            }
            s.draw(at: CGPoint(x: x + (digitWidth - s.size(withAttributes: attrs).width) / 2, y: baselineY),
                   withAttributes: attrs)
            x += digitWidth
        }
        x += 12
        (unit as NSString).draw(at: CGPoint(x: x, y: baselineY + digitFont.pointSize * 0.52),
                                withAttributes: [.font: unitFont,
                                                 .foregroundColor: NSColor(red: 0.863, green: 0.871, blue: 0.886, alpha: 1)])
    }
}
