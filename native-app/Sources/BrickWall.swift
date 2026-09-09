import Accelerate
import Foundation

/// Linear-phase brick-wall low-pass: a Kaiser-windowed sinc, run as a direct
/// FIR through vDSP.
///
/// Why this exists rather than another Butterworth cascade. Measured against
/// SDR++ on 594 kHz with the same SpyServer and the same twenty seconds, the
/// AM audio here sat 60 dB louder in the 5-6 kHz octave — not because anything
/// was broken, but because an IIR skirt cannot turn that fast. On a 9 kHz
/// channel raster nothing above half the channel width belongs to the station
/// being listened to: it is the neighbours' splatter and the band noise, and
/// SDR++ removes it with an FFT filter that is flat to the edge and 85 dB down
/// immediately after. This is the same shape, arrived at the same way.
///
/// Direct convolution rather than overlap-save: a straight FIR has no block
/// bookkeeping to get wrong — the history carries the filter across packet
/// boundaries and the output is sample-for-sample with the input — and vDSP
/// makes it affordable. Measured on the default settings (2433 taps at the
/// 114 kHz audio rate, which is a 300 Hz transition at 100 dB) the app went
/// from 30% to 35% of a core with the spectrum drawing at the same time, so
/// the filter itself is around 5%.
///
/// The cost in time is a constant group delay of (taps-1)/2 — 11 ms here,
/// an order of magnitude below the sink's own cushion.
///
/// What it bought, against SDR++ on the same server and station, in dB
/// relative to the 0.3-3 kHz program band:
///
///        band     before    after    SDR++
///     4.0-4.5k      -9.5     -9.1     -9.0     (passband, all three agree)
///     4.5-4.8k     -19.0    -21.0    -35.3     (the transition; SDR++'s is narrower)
///     4.8-5.2k     -23.9   -104.1    -88.3
///     5.2-6.0k     -29.5   -101.1    -85.7
///     6.0-8.0k     -40.1    -97.1    -81.7
final class BrickWallLpf {

    private var taps: [Float] = []
    private var history: [Float] = []
    private var configuredFs: Double = 0
    private var configuredFc: Double = 0

    /// False when the filter could not be built (cutoff too near Nyquist, say);
    /// the caller then falls back to whatever it had.
    var isActive: Bool { !taps.isEmpty }

    /// `cutoffHz` is where the passband ends — the response is still flat
    /// there. The transition sits above it, so the stopband starts at
    /// `cutoffHz + transitionHz`.
    func configure(fs: Double, cutoffHz: Double,
                   transitionHz: Double = 300, stopbandDb: Double = 100) {
        guard fs > 0, cutoffHz > 0,
              cutoffHz + transitionHz < fs * 0.45 else {
            taps = []; history = []; configuredFs = 0; configuredFc = 0
            return
        }
        guard fs != configuredFs || cutoffHz != configuredFc else { return }

        // Kaiser's own design formulas: the order comes from the attenuation
        // and the transition width, the shape parameter from the attenuation
        // alone.
        let dw = 2 * Double.pi * transitionHz / fs
        var n = Int(((stopbandDb - 8) / (2.285 * dw)).rounded(.up)) + 1
        n = max(31, min(n, 4095))
        if n % 2 == 0 { n += 1 }          // odd, so the delay is a whole sample
        let beta: Double
        if stopbandDb > 50 {
            beta = 0.1102 * (stopbandDb - 8.7)
        } else if stopbandDb >= 21 {
            beta = 0.5842 * pow(stopbandDb - 21, 0.4) + 0.07886 * (stopbandDb - 21)
        } else {
            beta = 0
        }

        // The ideal cutoff goes in the middle of the transition, which is what
        // leaves the passband flat all the way to `cutoffHz`.
        let fcIdeal = (cutoffHz + transitionHz / 2) / fs
        let mid = Double(n - 1) / 2
        let i0Beta = Self.besselI0(beta)
        var t = [Float](repeating: 0, count: n)
        var sum = 0.0
        for i in 0..<n {
            let m = Double(i) - mid
            let sinc = m == 0 ? 2 * fcIdeal
                              : sin(2 * Double.pi * fcIdeal * m) / (Double.pi * m)
            let r = 2 * Double(i) / Double(n - 1) - 1
            let w = Self.besselI0(beta * (1 - r * r).squareRoot()) / i0Beta
            let v = sinc * w
            t[i] = Float(v)
            sum += v
        }
        // Unity at DC. Without it the window's own gain shows up as a level
        // change the moment the filter is switched in.
        if sum != 0 { for i in 0..<n { t[i] = Float(Double(t[i]) / sum) } }

        taps = t
        history = [Float](repeating: 0, count: n - 1)
        configuredFs = fs
        configuredFc = cutoffHz
    }

    func reset() {
        history = [Float](repeating: 0, count: max(0, taps.count - 1))
    }

    /// One packet in, the same number of samples out. The tail of this packet
    /// becomes the head of the next one's convolution, so there is no seam.
    func process(_ x: [Float]) -> [Float] {
        guard !taps.isEmpty, !x.isEmpty else { return x }
        let p = taps.count
        var padded = history
        padded.reserveCapacity(padded.count + x.count)
        padded.append(contentsOf: x)
        var out = [Float](repeating: 0, count: x.count)
        // vDSP_conv correlates; the taps are symmetric, so that is the same
        // thing as convolving with them.
        vDSP_conv(padded, 1, taps, 1, &out, 1, vDSP_Length(x.count), vDSP_Length(p))
        history = Array(padded.suffix(p - 1))
        return out
    }

    /// Modified Bessel function of the first kind, order 0 — the Kaiser
    /// window's definition. The series converges fast for the betas in use
    /// (about 10 for 100 dB); the iteration cap is a guard, not a working
    /// limit.
    private static func besselI0(_ x: Double) -> Double {
        var sum = 1.0, term = 1.0, k = 1.0
        while k < 200 {
            let half = x / (2 * k)
            term *= half * half
            sum += term
            if term < 1e-14 * sum { break }
            k += 1
        }
        return sum
    }
}
