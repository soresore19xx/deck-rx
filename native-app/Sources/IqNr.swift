import Accelerate
import Foundation

/// IF-domain noise reduction: SDR++'s FMIF tracking filter.
///
/// Port of `src/iqnr.ts`, itself a port of SDR++'s
/// `dsp::noise_reduction::FMIF`. Per input sample, take a Nuttall-windowed FFT
/// over the last `bins` samples, keep only the strongest bin and inverse-
/// transform. An FM signal occupies one instantaneous frequency at any moment,
/// so tracking the peak bin follows the signal and throws away the broadband
/// noise filling the rest of the IF passband.
///
/// No inverse FFT is needed. If X[k] is zero except at k = idx with value V,
/// then x[n] = (V/N)·exp(+j2pi·idx·n/N), and at n = N/2 that is V·(-1)^idx / N.
/// Half the transform cost for the same answer.
///
/// SDR++ enables this only for the FM demodulators, and so does this: any
/// other mode passes through untouched.
final class IqNr {

    private static let binsWFM = 32
    /// SDR++'s Voice preset is 15 taps. Rounded up to a power of two here for
    /// the same reason the TypeScript did — one tap makes no difference to the
    /// estimator's behaviour.
    private static let binsNFM = 16

    /// Readable so a test can assert which preset a mode selected. Checking
    /// only that two modes differ passes just as happily when they are swapped.
    private(set) var bins = IqNr.binsWFM
    private var window = [Double]()
    private var histI = [Double]()
    private var histQ = [Double]()
    private var active = false

    private var setup: FFTSetup?
    private var log2n: vDSP_Length = 0
    private var re = [Float]()
    private var im = [Float]()

    /// Running fraction of spectral energy retained — peak bin over total.
    /// Diagnostic only, but it is the one number that says whether the filter
    /// is tracking a signal or chewing on noise.
    private(set) var averageKeep: Double = 1

    init() { setBins(IqNr.binsWFM) }
    deinit { if let s = setup { vDSP_destroy_fftsetup(s) } }

    /// Nuttall, the 4-term -98 dB version (Nuttall 1981, Eq. 21) — the same
    /// window SDR++ uses. Sampled over `bins - 1`, matching its call.
    private static func nuttall(_ n: Int, _ N: Int) -> Double {
        let x = 2 * Double.pi * Double(n) / Double(N)
        return 0.355768 - 0.487396 * cos(x) + 0.144232 * cos(2 * x) - 0.012604 * cos(3 * x)
    }

    private func setBins(_ b: Int) {
        guard b != bins || setup == nil else { return }
        bins = b
        if let s = setup { vDSP_destroy_fftsetup(s) }
        log2n = vDSP_Length(log2(Double(b)).rounded())
        setup = vDSP_create_fftsetup(log2n, FFTRadix(kFFTRadix2))
        window = (0..<b).map { Self.nuttall($0, b - 1) }
        histI = [Double](repeating: 0, count: b - 1)
        histQ = [Double](repeating: 0, count: b - 1)
        re = [Float](repeating: 0, count: b)
        im = [Float](repeating: 0, count: b)
    }

    /// SDR++ numbering: 0 NFM, 1 WFM. Everything else bypasses,
    /// which is SDR++'s policy and not an arbitrary one — the peak-bin trick
    /// only holds for a signal with a single instantaneous frequency.
    func setMode(_ mode: Int) {
        guard mode == 0 || mode == 1 else { active = false; return }
        active = true
        setBins(mode == 1 ? Self.binsWFM : Self.binsNFM)
    }

    func reset() {
        for i in 0..<histI.count { histI[i] = 0; histQ[i] = 0 }
        averageKeep = 1
    }

    /// Interleaved int16 LE in, the same length out. Output sample i lags its
    /// input by bins/2 samples — about 70 us at 456 kHz, which is nothing.
    func process(_ iqIn: Data) -> Data {
        guard active, let setup else { return iqIn }
        let count = iqIn.count / 4
        guard count > 0 else { return iqIn }
        let b = bins
        let histLen = b - 1
        var out = Data(count: iqIn.count)
        var keepSum: Double = 0

        iqIn.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            let base = raw.baseAddress!
            func sample(_ pos: Int) -> (Double, Double) {
                if pos < histLen { return (histI[pos], histQ[pos]) }
                let ni = pos - histLen
                let i = Double(base.loadUnaligned(fromByteOffset: ni * 4, as: Int16.self).littleEndian)
                let q = Double(base.loadUnaligned(fromByteOffset: ni * 4 + 2, as: Int16.self).littleEndian)
                return (i, q)
            }
            out.withUnsafeMutableBytes { (o: UnsafeMutableRawBufferPointer) in
                let ob = o.baseAddress!
                for i in 0..<count {
                    for n in 0..<b {
                        let (sI, sQ) = sample(i + n)
                        let w = window[n]
                        re[n] = Float(sI * w)
                        im[n] = Float(sQ * w)
                    }
                    re.withUnsafeMutableBufferPointer { rp in
                        im.withUnsafeMutableBufferPointer { ip in
                            var split = DSPSplitComplex(realp: rp.baseAddress!, imagp: ip.baseAddress!)
                            vDSP_fft_zip(setup, &split, 1, log2n, FFTDirection(kFFTDirection_Forward))
                        }
                    }
                    var maxMag2: Float = -1, total: Float = 0
                    var maxIdx = 0
                    for k in 0..<b {
                        let m2 = re[k] * re[k] + im[k] * im[k]
                        total += m2
                        if m2 > maxMag2 { maxMag2 = m2; maxIdx = k }
                    }
                    // x[N/2] = X[idx] * (-1)^idx / N
                    let scale = Double(maxIdx % 2 == 0 ? 1 : -1) / Double(b)
                    let outI = Double(re[maxIdx]) * scale
                    let outQ = Double(im[maxIdx]) * scale
                    keepSum += total > 0 ? Double(maxMag2 / total) : 1
                    let oI = Int16(min(max(outI, -32768), 32767))
                    let oQ = Int16(min(max(outQ, -32768), 32767))
                    ob.storeBytes(of: oI.littleEndian, toByteOffset: i * 4, as: Int16.self)
                    ob.storeBytes(of: oQ.littleEndian, toByteOffset: i * 4 + 2, as: Int16.self)
                }
            }

            // Slide the history to the last (bins - 1) samples of
            // "[history; input]".
            if count >= histLen {
                let start = count - histLen
                for n in 0..<histLen {
                    let ni = start + n
                    histI[n] = Double(base.loadUnaligned(fromByteOffset: ni * 4, as: Int16.self).littleEndian)
                    histQ[n] = Double(base.loadUnaligned(fromByteOffset: ni * 4 + 2, as: Int16.self).littleEndian)
                }
            } else {
                let keep = histLen - count
                for n in 0..<keep { histI[n] = histI[n + count]; histQ[n] = histQ[n + count] }
                for n in 0..<count {
                    histI[keep + n] = Double(base.loadUnaligned(fromByteOffset: n * 4, as: Int16.self).littleEndian)
                    histQ[keep + n] = Double(base.loadUnaligned(fromByteOffset: n * 4 + 2, as: Int16.self).littleEndian)
                }
            }
        }

        averageKeep = 0.95 * averageKeep + 0.05 * (keepSum / Double(count))
        return out
    }
}
