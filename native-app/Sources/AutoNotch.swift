import Accelerate
import Foundation

/// Automatic notch for steady tones in AM and SSB audio: heterodyne whistles,
/// a neighbour's carrier, the 100 Hz ladder of mains hum on medium wave.
///
/// Ported from `AutoNotch` in `src/autoNotch.ts`, constants and order intact;
/// the comments there carry the reasoning and the 2026-10-21 measurements.
/// Mono in place (the sink duplicates to two channels afterwards).
final class AutoNotch {
    private static let maxNotches = 10
    private static let riseDb = 18.0
    private static let holdS = 0.4
    private static let releaseS = 1.0
    private static let fadeS = 0.02
    private static let notchBwHz = 20.0
    private static let fMin = 60.0, fMax = 5000.0
    private static let steadyDb = 6.0, followDb = 12.0, followRiseDb = 10.0

    private struct Track {
        var hz: Double, anchor: Double, db: Double, dbMin: Double, dbMax: Double
        var age: Double, unseen: Double
        var notch: Int
    }

    private struct Notch {
        var hz = 0.0, gain = 0.0, target = 0.0
        var b0 = 0.0, b2 = 0.0, a1 = 0.0, a2 = 0.0, z1 = 0.0, z2 = 0.0
        mutating func set(fs: Double, hz: Double) {
            self.hz = hz
            let w = 2 * Double.pi * hz / fs
            let alpha = sin(w) / (2 * (hz / AutoNotch.notchBwHz))
            let a0 = 1 + alpha
            b0 = alpha / a0; b2 = -alpha / a0
            a1 = -2 * cos(w) / a0; a2 = (1 - alpha) / a0
        }
        mutating func reset() { z1 = 0; z2 = 0; gain = 0; target = 0 }
        mutating func bp(_ x: Double) -> Double {
            let y = b0 * x + z1
            z1 = -a1 * y + z2
            z2 = b2 * x - a2 * y
            return y
        }
    }

    var enabled = false
    private var fs = 0.0
    private var n = 0
    private var hop = 0
    private var log2n: vDSP_Length = 0
    private var setup: FFTSetupD?
    private var win = [Double]()
    private var buf = [Double]()
    private var pos = 0
    private var sinceHop = 0
    private var re = [Double](), im = [Double]()
    private var prevRe = [Double](), prevIm = [Double]()
    private var havePrev = false
    private var mag = [Double]()
    private var tracks = [Track]()
    private var notches = [Notch](repeating: Notch(), count: AutoNotch.maxNotches)
    private var fadeStep = 0.0

    deinit { if let s = setup { vDSP_destroy_fftsetupD(s) } }

    /// Frequencies currently cut (Hz).
    var activeHz: [Int] { notches.filter { $0.target > 0 }.map { Int($0.hz.rounded()) } }

    func configure(fs: Double) {
        guard fs != self.fs, fs > 0 else { return }
        self.fs = fs
        var size = 1024
        while Double(size) < fs * 0.28 { size <<= 1 }
        n = size
        hop = size >> 3
        if let s = setup { vDSP_destroy_fftsetupD(s) }
        log2n = vDSP_Length(log2(Double(size)).rounded())
        setup = vDSP_create_fftsetupD(log2n, FFTRadix(kFFTRadix2))
        win = (0..<size).map { 0.5 - 0.5 * cos(2 * Double.pi * Double($0) / Double(size - 1)) }
        buf = [Double](repeating: 0, count: size)
        re = [Double](repeating: 0, count: size / 2); im = re
        prevRe = re; prevIm = re
        mag = [Double](repeating: 0, count: size / 2)
        fadeStep = 1 / (AutoNotch.fadeS * fs)
        reset()
    }

    func reset() {
        for i in 0..<buf.count { buf[i] = 0 }
        pos = 0; sinceHop = 0; havePrev = false
        tracks.removeAll()
        for k in 0..<notches.count { notches[k].reset() }
    }

    func process(_ x: inout [Float]) {
        guard enabled, fs > 0, setup != nil else { return }
        for i in 0..<x.count {
            let v = Double(x[i])
            buf[pos] = v
            pos = (pos + 1) % n
            sinceHop += 1
            if sinceHop >= hop { sinceHop = 0; analyse() }
            var y = v
            for k in 0..<AutoNotch.maxNotches {
                if notches[k].gain == 0 && notches[k].target == 0 { continue }
                notches[k].gain += max(-fadeStep, min(fadeStep, notches[k].target - notches[k].gain))
                // In series: each notch on what the last left (autoNotch.ts).
                y -= notches[k].gain * notches[k].bp(y)
            }
            x[i] = Float(y)
        }
    }

    private func analyse() {
        guard let setup = setup else { return }
        let half = n >> 1
        var frame = [Double](repeating: 0, count: n)
        for i in 0..<n { frame[i] = buf[(pos + i) % n] * win[i] }
        // Packed real FFT: bin k (1..half-1) in re[k] + j im[k], DC in re[0]
        // and Nyquist in im[0]; everything scaled by 2, which a level in dB
        // relative to its neighbours and a phase step do not notice.
        re.withUnsafeMutableBufferPointer { rp in
            im.withUnsafeMutableBufferPointer { ip in
                var sc = DSPDoubleSplitComplex(realp: rp.baseAddress!, imagp: ip.baseAddress!)
                frame.withUnsafeBufferPointer { fp in
                    fp.baseAddress!.withMemoryRebound(to: DSPDoubleComplex.self, capacity: half) {
                        vDSP_ctozD($0, 2, &sc, 1, vDSP_Length(half))
                    }
                }
                vDSP_fft_zripD(setup, &sc, 1, log2n, FFTDirection(FFT_FORWARD))
            }
        }
        mag[0] = 10 * log10(re[0] * re[0] + 1e-12)
        for k in 1..<half { mag[k] = 10 * log10(re[k] * re[k] + im[k] * im[k] + 1e-12) }
        let binHz = fs / Double(n)
        let kLo = max(3, Int((AutoNotch.fMin / binHz).rounded(.up)))
        let kHi = min(half - 4, Int((AutoNotch.fMax / binHz).rounded(.down)))
        let span = max(8, Int((150 / binHz).rounded()))
        var found = [(hz: Double, db: Double, rise: Double)]()
        var around = [Double]()
        if kLo <= kHi {
            for k in kLo...kHi {
                let m = mag[k]
                if m < mag[k - 1] || m < mag[k + 1] || m < mag[k - 2] || m < mag[k + 2] { continue }
                around.removeAll(keepingCapacity: true)
                for j in max(1, k - span)...min(half - 1, k + span) where abs(j - k) > 2 { around.append(mag[j]) }
                around.sort()
                let rise = m - around[around.count >> 1]
                if rise < AutoNotch.followRiseDb { continue }
                let a = mag[k - 1], c = mag[k + 1]
                let d = a - 2 * m + c
                let off = d != 0 ? 0.5 * (a - c) / d : 0
                var hz = (Double(k) + off) * binHz
                if havePrev {
                    let pr = prevRe[k], pi = prevIm[k]
                    var dph = atan2(im[k] * pr - re[k] * pi, re[k] * pr + im[k] * pi)
                        - 2 * Double.pi * Double(k) * Double(hop) / Double(n)
                    dph -= 2 * Double.pi * (dph / (2 * Double.pi)).rounded()
                    let fine = (Double(k) + dph * Double(n) / (2 * Double.pi * Double(hop))) * binHz
                    if abs(fine - hz) < binHz { hz = fine }
                }
                found.append((hz, m, rise))
            }
        }
        prevRe = re; prevIm = im; havePrev = true
        let dt = Double(hop) / fs
        for t in 0..<tracks.count { tracks[t].unseen += dt }
        for f in found {
            var best = -1
            for t in 0..<tracks.count {
                let tr = tracks[t]
                if tr.unseen <= 0 { continue }
                let ok = abs(tr.hz - f.hz) <= 1.5 * binHz && (tr.notch >= 0
                    ? abs(tr.db - f.db) <= AutoNotch.followDb
                    : f.rise >= AutoNotch.riseDb && abs(tr.db - f.db) <= 6)
                if ok && (best < 0 || abs(tr.hz - f.hz) < abs(tracks[best].hz - f.hz)) { best = t }
            }
            if best >= 0 {
                var b = tracks[best]
                let gap = b.unseen > 1.5 * dt
                if f.rise >= AutoNotch.riseDb { b.hz = 0.7 * b.hz + 0.3 * f.hz }
                b.db = 0.7 * b.db + 0.3 * f.db
                b.age += b.unseen; b.unseen = 0
                b.dbMin = min(b.dbMin, f.db); b.dbMax = max(b.dbMax, f.db)
                let wandered = abs(f.hz - b.anchor) > max(0.6 * binHz, 2)
                if b.notch < 0 && (gap || wandered || b.dbMax - b.dbMin > AutoNotch.steadyDb) {
                    b.anchor = f.hz; b.age = 0; b.dbMin = f.db; b.dbMax = f.db
                }
                tracks[best] = b
            } else if f.rise >= AutoNotch.riseDb && tracks.count < 32 {
                tracks.append(Track(hz: f.hz, anchor: f.hz, db: f.db, dbMin: f.db, dbMax: f.db,
                                    age: 0, unseen: 0, notch: -1))
            }
        }
        for t in 0..<tracks.count where tracks[t].notch >= 0 && tracks[t].unseen > AutoNotch.releaseS {
            notches[tracks[t].notch].target = 0
            tracks[t].notch = -1
        }
        tracks.removeAll { $0.unseen > AutoNotch.releaseS && $0.notch < 0 }
        let ready = tracks.indices.filter { tracks[$0].notch < 0 && tracks[$0].age >= AutoNotch.holdS && tracks[$0].unseen == 0 }
            .sorted { tracks[$0].db > tracks[$1].db }
        for t in ready {
            guard let slot = notches.firstIndex(where: { $0.target == 0 && $0.gain == 0 }) else { break }
            tracks[t].notch = slot
            notches[slot].reset()
            notches[slot].set(fs: fs, hz: tracks[t].hz)
            notches[slot].target = 1
        }
        for t in 0..<tracks.count where tracks[t].notch >= 0 && tracks[t].unseen == 0
            && abs(notches[tracks[t].notch].hz - tracks[t].hz) > 0.5 {
            notches[tracks[t].notch].set(fs: fs, hz: tracks[t].hz)
        }
    }
}
