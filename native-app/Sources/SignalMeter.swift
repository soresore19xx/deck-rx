#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

/// Signal meter: a segmented bar over a labelled scale, with a peak that hangs
/// behind the reading.
///
/// It used to be a track with a fill — the same drawing as the Mac window's
/// `VolumeBar`,
/// which made an instrument look like a control you could drag. Nothing about a
/// signal reading is settable, and the two live on the same window. Three
/// things separate them now, and each earns its place: segments say "measured
/// in steps" the way every meter on a receiver does, the scale gives the
/// numbers somewhere to land so a level can be read rather than merely
/// compared, and the peak marker holds what a slider has no reason to hold —
/// the last strong moment of a signal that is fading in and out.
final class SignalMeter: XView {
    var tint: XColor = Pal.accent { didSet { redraw() } }
    /// Normalised 0-1 over the scale the ticks describe.
    var value: Double = 0 {
        didSet {
            // Falls a little on each update rather than following the reading
            // down. At the 4 Hz the status feed runs, this is a couple of
            // seconds from full scale to zero — long enough to catch a peak
            // that has already gone, short enough not to lie about the present.
            peak = max(value, peak - 0.012)
            redraw()
        }
    }
    private var peak: Double = 0
    /// Tick positions, 0-1 across the bar, with what to write under them.
    var ticks: [(at: Double, label: String)] = []

    private let barH: CGFloat = 12
    override var intrinsicContentSize: CGSize { CGSize(width: XView.noIntrinsicMetric, height: 30) }

    override func draw(_ dirtyRect: CGRect) {
        guard let ctx = currentContext else { return }
        let w = bounds.width
        // This view is not flipped, so the bar goes at the top and the scale
        // hangs below it. Drawn from y = 0 the numbers came out above the bar,
        // where the N meter's scale sat closer to the S meter's bar than to its
        // own — a scale has to belong to the thing it is under.
        let barY: CGFloat = bounds.height - barH

        // Segments rather than a continuous fill. 4 pt lit, 2 pt dark: any
        // finer and the gaps close up at this height into the solid bar this
        // was meant to stop being.
        let seg: CGFloat = 4, gap: CGFloat = 2
        let n = max(1, Int((w + gap) / (seg + gap)))
        let lit = Int((Double(n) * max(0, min(1, value))).rounded())
        let peakSeg = Int((Double(n) * max(0, min(1, peak))).rounded()) - 1
        for i in 0..<n {
            let x = CGFloat(i) * (seg + gap)
            let r = CGRect(x: x, y: barY, width: seg, height: barH)
            if i < lit {
                ctx.setFillColor(tint.cgColor)
            } else if i == peakSeg {
                // The peak reads as the same signal, not a second one: the
                // meter's own colour, dimmed, rather than a colour of its own.
                ctx.setFillColor(tint.withAlphaComponent(0.55).cgColor)
            } else {
                ctx.setFillColor(Pal.line.cgColor)
            }
            ctx.fill(r)
        }

        // Scale. Ticks rise from the numbers to just under the bar, so the
        // number belongs to a position rather than floating beneath it.
        let font = xMono(max(8, 10 * UI.scale), .regular)
        ctx.setStrokeColor(Pal.faint.withAlphaComponent(0.5).cgColor)
        ctx.setLineWidth(1)
        // Thin the scale when the bar is short: five numbers across 200 pt
        // overlap into a smear, and a scale that cannot be read is worse than
        // a coarser one that can. Ends and middle survive.
        let room = w / CGFloat(max(1, ticks.count))
        let shown = room >= 52 ? ticks
                  : ticks.enumerated().filter { $0.offset % 2 == 0 }.map { $0.element }
        for t in shown {
            let x = (w * CGFloat(max(0, min(1, t.at)))).rounded()
            let tx = min(max(0.5, x), w - 0.5)
            ctx.move(to: CGPoint(x: tx, y: barY - 2))
            ctx.addLine(to: CGPoint(x: tx, y: barY - 6))
            let str = t.label as NSString
            let size = str.size(withAttributes: [.font: font])
            // Clamped to the bar's ends: the outermost numbers would otherwise
            // hang off the meter and collide with what sits beside it.
            let lx = min(max(0, x - size.width / 2), w - size.width)
            str.draw(at: CGPoint(x: lx, y: barY - 8 - size.height),
                     withAttributes: [.font: font, .foregroundColor: Pal.faint])
        }
        ctx.strokePath()
    }
}
