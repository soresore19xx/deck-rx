import Accelerate
import Foundation

/// An HF weather fax picture, 8-bit grey, one byte per pixel, row-major.
struct WefaxImage {
    let width: Int
    let height: Int
    let pixels: [UInt8]
}

/// Turns a stretch of int16 IQ into a weather fax picture.
///
/// A transcription of `~/.claude-work/scripts/wefax_decode.js`, which is the
/// implementation that actually produced a readable JMH chart from 7795 kHz on
/// 2026-09-01. Constants, stage order and the level-detection method are copied
/// rather than re-derived: the JS got the levels wrong twice before landing on
/// the histogram method below, and re-deciding that here would be re-running the
/// same two mistakes.
///
/// Nothing in here is specific to the receiver — it takes the IQ the rest of the
/// app already has, at whatever rate that arrives, so it works equally on a live
/// stream and on a recording.
final class WefaxDecoder {

    struct Params {
        /// Lines per minute. JMH charts are 120.
        var lpm: Double = 120
        /// Index of cooperation. 576 gives the standard 1809 px line.
        var ioc: Double = 576
        /// FM deviation. White sits at +dev, black at -dev — the HF fax
        /// convention of white 2300 Hz / black 1500 Hz about a 1900 Hz centre.
        var deviationHz: Double = 400
        /// The rate the demodulator runs at. The IQ is decimated to the nearest
        /// integer division of this.
        var workRateTarget: Double = 6000
        var lpfCutoffHz: Double = 1200
        init() {}
    }

    private let params: Params
    private var log: ((String) -> Void)?

    init(params: Params = Params(), log: ((String) -> Void)? = nil) {
        self.params = params
        self.log = log
    }

    var lineWidth: Int { Int((Double.pi * params.ioc).rounded()) }

    // MARK: - entry point

    func decode(int16IQ iq: Data, iqRate: Double) -> WefaxImage? {
        let nIn = iq.count / 4
        guard nIn > 0, iqRate > 0 else { return nil }

        let decim = max(1, Int((iqRate / params.workRateTarget).rounded()))
        let workRate = iqRate / Double(decim)
        log?("in: \(nIn) samples @ \(Int(iqRate)) Hz (\(String(format: "%.1f", Double(nIn) / iqRate)) s), decim \(decim) -> \(Int(workRate)) Hz")

        let offHz = carrierOffsetHz(iq, nIn: nIn, iqRate: iqRate)
        let fHz = demodulate(iq, nIn: nIn, iqRate: iqRate, decim: decim, workRate: workRate, offsetHz: offHz)
        guard fHz.count > 16 else { return nil }

        let period = linePeriod(fHz, workRate: workRate)
        return render(fHz, period: period)
    }

    // MARK: - 1. carrier offset

    /// FM spreads its energy over the deviation, so the peak bin is not the
    /// centre; the power-weighted centroid is. A residual offset shows up as a
    /// uniform grey shift across the whole picture.
    private func carrierOffsetHz(_ iq: Data, nIn: Int, iqRate: Double) -> Double {
        let n = 8192
        guard nIn >= n else { return 0 }
        let maxWindows = 48
        let step = max(n, nIn / maxWindows)

        var hann = [Double](repeating: 0, count: n)
        for i in 0..<n { hann[i] = 0.5 - 0.5 * cos(2 * Double.pi * Double(i) / Double(n)) }

        var acc = [Double](repeating: 0, count: n)
        var windows = 0
        var off = 0
        while off + n <= nIn && windows < maxWindows {
            var re = [Double](repeating: 0, count: n)
            var im = [Double](repeating: 0, count: n)
            iq.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
                guard let base = raw.baseAddress else { return }
                for i in 0..<n {
                    let o = (off + i) * 4
                    let I = Double(base.loadUnaligned(fromByteOffset: o, as: Int16.self).littleEndian)
                    let Q = Double(base.loadUnaligned(fromByteOffset: o + 2, as: Int16.self).littleEndian)
                    re[i] = I / 32768 * hann[i]
                    im[i] = Q / 32768 * hann[i]
                }
            }
            fft(&re, &im)
            for i in 0..<n { acc[i] += re[i] * re[i] + im[i] * im[i] }
            windows += 1
            off += step
        }
        guard windows > 0 else { return 0 }

        let binHz = iqRate / Double(n)
        let lim = Int((1500 / binHz).rounded())
        var num = 0.0, den = 0.0
        for k in -lim...lim {
            let p = acc[((k % n) + n) % n]
            num += p * (Double(k) * binHz)
            den += p
        }
        let centroid = den > 0 ? num / den : 0
        log?("carrier: centroid \(String(format: "%.1f", centroid)) Hz")
        return centroid
    }

    // MARK: - 2/3. shift, low-pass, decimate, FM demodulate

    private func demodulate(_ iq: Data, nIn: Int, iqRate: Double,
                            decim: Int, workRate: Double, offsetHz: Double) -> [Double] {
        let nOut = nIn / decim
        guard nOut > 1 else { return [] }

        // Windowed-sinc low-pass, evaluated only at the samples we keep.
        let taps = 4 * decim + 1
        let fc = params.lpfCutoffHz / iqRate
        var h = [Double](repeating: 0, count: taps)
        var sum = 0.0
        for i in 0..<taps {
            let m = Double(i) - Double(taps - 1) / 2
            let s = m == 0 ? 2 * fc : sin(2 * Double.pi * fc * m) / (Double.pi * m)
            let bl = 0.42
                - 0.5 * cos(2 * Double.pi * Double(i) / Double(taps - 1))
                + 0.08 * cos(4 * Double.pi * Double(i) / Double(taps - 1))
            h[i] = s * bl
            sum += h[i]
        }
        for i in 0..<taps { h[i] /= sum }

        // The JS recomputes the mixer inside the tap loop; it is a pure function
        // of the input index, so hoisting it out is the same arithmetic done
        // once instead of `taps` times.
        let inc = -2 * Double.pi * offsetHz / iqRate
        var mixI = [Double](repeating: 0, count: nIn)
        var mixQ = [Double](repeating: 0, count: nIn)
        iq.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            guard let base = raw.baseAddress else { return }
            for idx in 0..<nIn {
                let b = idx * 4
                let I = Double(base.loadUnaligned(fromByteOffset: b, as: Int16.self).littleEndian) / 32768
                let Q = Double(base.loadUnaligned(fromByteOffset: b + 2, as: Int16.self).littleEndian) / 32768
                let p = inc * Double(idx)
                let c = cos(p), s = sin(p)
                mixI[idx] = I * c - Q * s
                mixQ[idx] = I * s + Q * c
            }
        }

        var zi = [Double](repeating: 0, count: nOut)
        var zq = [Double](repeating: 0, count: nOut)
        let half = (taps - 1) >> 1
        for o in 0..<nOut {
            let base = o * decim
            var ar = 0.0, ai = 0.0
            for t in 0..<taps {
                let idx = base + t - half
                if idx < 0 || idx >= nIn { continue }
                ar += mixI[idx] * h[t]
                ai += mixQ[idx] * h[t]
            }
            zi[o] = ar
            zq[o] = ai
        }

        // Instantaneous frequency.
        var fHz = [Double](repeating: 0, count: nOut)
        for n in 1..<nOut {
            let dr = zi[n] * zi[n - 1] + zq[n] * zq[n - 1]
            let di = zq[n] * zi[n - 1] - zi[n] * zq[n - 1]
            fHz[n] = atan2(di, dr) * workRate / (2 * Double.pi)
        }
        fHz[0] = fHz.count > 1 ? fHz[1] : 0
        return fHz
    }

    // MARK: - 4. line period

    /// The nominal period slants the picture if it is even slightly off. Search
    /// a narrow range and keep the period where consecutive lines agree best —
    /// the chart's own graticule supplies the correlation.
    private func linePeriod(_ fHz: [Double], workRate: Double) -> Double {
        let nominal = workRate * 60 / params.lpm
        var bestP = nominal
        var bestS = -2.0
        var p = nominal * 0.997
        while p <= nominal * 1.003 {
            let s = periodScore(fHz, period: p)
            if s > bestS { bestS = s; bestP = p }
            p += 0.05
        }
        log?("line period: nominal \(String(format: "%.2f", nominal)) -> \(String(format: "%.2f", bestP)) (corr \(String(format: "%.3f", bestS)))")
        return bestP
    }

    /// How well a candidate period stacks the lines on top of each other.
    ///
    /// Correlating each line against the next one was the first attempt and it
    /// is too weak to use: on a real 7795 kHz capture it scored 0.066 and picked
    /// 2998.40 where the truth was 3000.0, which sheared the chart across a
    /// third of its width. Two adjacent lines of a weather chart are mostly
    /// blank paper, so the correlation is dominated by noise.
    ///
    /// Averaging every line into one row instead is the whole picture voting at
    /// once. At the right period the coastlines, the graticule and the phasing
    /// bar land in the same columns and the averaged row develops structure; at
    /// the wrong period they smear and it flattens. The variance of that row is
    /// the score, and it grows with the number of lines rather than drowning in
    /// them.
    private func periodScore(_ fHz: [Double], period: Double) -> Double {
        let nOut = fHz.count
        let lines = Int(Double(nOut) / period)
        guard lines >= 8 else { return -1 }
        let w = 512
        var col = [Double](repeating: 0, count: w)
        var used = 0
        for l in 0..<lines {
            var ok = true
            for x in 0..<w {
                let i = Int((Double(l) * period + Double(x) * period / Double(w)).rounded())
                if i >= nOut { ok = false; break }
                col[x] += fHz[i]
            }
            if !ok { break }
            used += 1
        }
        guard used >= 8 else { return -1 }
        var mean = 0.0
        for x in 0..<w { col[x] /= Double(used); mean += col[x] }
        mean /= Double(w)
        var varc = 0.0
        for x in 0..<w { let d = col[x] - mean; varc += d * d }
        return varc / Double(w)
    }

    // MARK: - 5. render

    private func render(_ fHz: [Double], period: Double) -> WefaxImage? {
        let width = lineWidth
        let nOut = fHz.count
        let nLines = Int(Double(nOut) / period)
        guard nLines > 0 else { return nil }

        let (black, white) = levels(fHz)
        let margin = 0.12 * (white - black)
        let lo = black - margin
        let hi = white + margin
        let span = hi - lo
        guard span > 0 else { return nil }
        log?("levels: black \(Int(black)) Hz / white \(Int(white)) Hz (separation \(Int(white - black)) Hz, nominal \(Int(2 * params.deviationHz)))")

        var px = [UInt8](repeating: 0, count: width * nLines)
        for l in 0..<nLines {
            for x in 0..<width {
                let idx = Int((Double(l) * period + Double(x) * period / Double(width)).rounded())
                let v = idx < nOut ? fHz[idx] : lo
                let g = (255 * (v - lo) / span).rounded()
                px[l * width + x] = UInt8(max(0, min(255, g)))
            }
        }

        // Weather charts are mostly white paper. A dark median means the
        // sideband convention came out reversed.
        var sample = [UInt8]()
        var i = 0
        while i < px.count { sample.append(px[i]); i += 997 }
        sample.sort()
        let med = sample.isEmpty ? 128 : Int(sample[sample.count / 2])
        if med < 110 {
            for k in 0..<px.count { px[k] = 255 - px[k] }
            log?("polarity: inverted (median was \(med))")
        } else {
            log?("polarity: as received (median \(med))")
        }

        return WefaxImage(width: width, height: nLines, pixels: px)
    }

    /// A fax carries exactly two levels, so find them rather than assume where
    /// they sit. Percentiles measure the noise between the strokes; the median
    /// lands on whichever level covers more of the page, which is the white
    /// paper, so centring on it pushes the paper to mid grey. The histogram has
    /// a peak at each level — take the two strongest that are far enough apart.
    private func levels(_ fHz: [Double]) -> (black: Double, white: Double) {
        let bin = 8.0, lim = 1200.0
        let nb = Int(2 * lim / bin)
        var hist = [Double](repeating: 0, count: nb)
        for v in fHz {
            let b = Int((v + lim) / bin)
            if b >= 0 && b < nb { hist[b] += 1 }
        }
        var smooth = [Double](repeating: 0, count: nb)
        for b in 0..<nb {
            var s = 0.0, c = 0.0
            for k in -2...2 where b + k >= 0 && b + k < nb { s += hist[b + k]; c += 1 }
            smooth[b] = s / c
        }
        let hzOf = { (b: Int) -> Double in Double(b) * bin - lim + bin / 2 }

        var p1 = 0
        for b in 1..<nb where smooth[b] > smooth[p1] { p1 = b }
        var p2 = -1
        for b in 0..<nb {
            if abs(hzOf(b) - hzOf(p1)) < 300 { continue }
            if p2 < 0 || smooth[b] > smooth[p2] { p2 = b }
        }
        var white = hzOf(p1)
        var black = p2 >= 0 ? hzOf(p2) : white - 2 * params.deviationHz
        if black > white { swap(&black, &white) }
        return (black, white)
    }

    // MARK: - plain radix-2 FFT, in place

    private func fft(_ re: inout [Double], _ im: inout [Double]) {
        let n = re.count
        var j = 0
        for i in 1..<n {
            var bit = n >> 1
            while j & bit != 0 { j ^= bit; bit >>= 1 }
            j ^= bit
            if i < j { re.swapAt(i, j); im.swapAt(i, j) }
        }
        var len = 2
        while len <= n {
            let ang = -2 * Double.pi / Double(len)
            let wr = cos(ang), wi = sin(ang)
            var i = 0
            while i < n {
                var cr = 1.0, ci = 0.0
                for k in 0..<(len / 2) {
                    let ur = re[i + k], ui = im[i + k]
                    let vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci
                    let vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr
                    re[i + k] = ur + vr
                    im[i + k] = ui + vi
                    re[i + k + len / 2] = ur - vr
                    im[i + k + len / 2] = ui - vi
                    let ncr = cr * wr - ci * wi
                    ci = cr * wi + ci * wr
                    cr = ncr
                }
                i += len
            }
            len <<= 1
        }
    }
}

extension WefaxImage {
    /// Binary PGM, so a decode can be eyeballed without a UI.
    func pgmData() -> Data {
        var d = Data("P5\n\(width) \(height)\n255\n".utf8)
        d.append(contentsOf: pixels)
        return d
    }
}
