import Accelerate
import Foundation

/// Complex FFT over IQ, producing fftshift'd dBFS bins.
///
/// A transcription of `src/fft.ts` onto vDSP, deliberately bit-for-bit in its
/// definitions: same Hann window, same window-gain compensation, same 1/N²
/// power normalisation, same fftshift, same EWMA in the dB domain. Matching
/// exactly is the point — while both implementations exist, any difference
/// between the app and the plugin has to be attributable to something other
/// than the transform.
///
/// The EWMA runs on dB, not power. That is arguably wrong — averaging logs
/// biases low against averaging the powers, which is one candidate for the
/// peak difference against SDR++ — but it is what the plugin does today, and
/// changing the transform and its smoothing in the same step would make a
/// parity comparison meaningless. Fix it after parity is confirmed, not during
/// the port.
///
/// What vDSP buys over the hand-rolled Cooley-Tukey: sizes the JS version
/// cannot afford. The deck's ladder stops at 16384 because a 200x100 LCD had
/// no use for more and JS had no headroom; a window has both. 65536 is what
/// SDR++ is configured with here, and it is 12 dB of noise floor.
final class FFTPipeline {

    let n: Int
    private let log2n: vDSP_Length
    private let setup: FFTSetup
    private var window: [Float]
    /// 10·log10(N / Σw²) — puts a tone's dBFS back where it would be unwindowed.
    /// Hann costs about 6 dB; this adds it back.
    private let windowGainDb: Float

    private var realp: [Float]
    private var imagp: [Float]
    private var scratch: [Float]
    private var smoothed: [Float]?

    init?(_ size: Int) {
        guard size >= 4, size & (size - 1) == 0 else { return nil }
        n = size
        log2n = vDSP_Length(log2(Double(size)).rounded())
        guard let s = vDSP_create_fftsetup(log2n, FFTRadix(kFFTRadix2)) else { return nil }
        setup = s

        // Hann. Note the (n - 1) denominator: vDSP_hann_window with
        // vDSP_HANN_DENORM uses n, which is a different window by one sample
        // and would put the comparison off. Build it by hand to match.
        var w = [Float](repeating: 0, count: size)
        var sumSq: Double = 0
        for i in 0..<size {
            let v = 0.5 - 0.5 * cos(2 * Double.pi * Double(i) / Double(size - 1))
            w[i] = Float(v)
            sumSq += v * v
        }
        window = w
        windowGainDb = Float(10 * log10(Double(size) / sumSq))

        realp = [Float](repeating: 0, count: size)
        imagp = [Float](repeating: 0, count: size)
        scratch = [Float](repeating: 0, count: size)
    }

    deinit { vDSP_destroy_fftsetup(setup) }

    /// Process the most recent `n` complex samples of an interleaved int16 LE
    /// IQ buffer. Returns fftshift'd dBFS bins, or nil when the buffer is short.
    ///
    /// Taking the *most recent* n rather than the oldest is the lowest-latency
    /// choice between IQ arriving and the user seeing it, and is what the
    /// plugin does. It does mean samples between frames are never looked at.
    func process(int16IQ iq: Data, smoothAlpha: Float) -> [Float]? {
        let totalSamples = iq.count / 4
        guard totalSamples >= n else { return nil }
        let startByte = (totalSamples - n) * 4

        iq.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            let base = raw.baseAddress!.advanced(by: startByte)
            for i in 0..<n {
                let o = i * 4
                let I = base.loadUnaligned(fromByteOffset: o, as: Int16.self).littleEndian
                let Q = base.loadUnaligned(fromByteOffset: o + 2, as: Int16.self).littleEndian
                let wi = window[i] / 32768
                realp[i] = Float(I) * wi
                imagp[i] = Float(Q) * wi
            }
        }
        return transformAndScale(smoothAlpha: smoothAlpha)
    }

    /// Same, for already-normalised float samples (interleaved I,Q in ±1).
    func process(floatIQ iq: [Float], smoothAlpha: Float) -> [Float]? {
        let totalSamples = iq.count / 2
        guard totalSamples >= n else { return nil }
        let start = (totalSamples - n) * 2
        for i in 0..<n {
            let wi = window[i]
            realp[i] = iq[start + i * 2] * wi
            imagp[i] = iq[start + i * 2 + 1] * wi
        }
        return transformAndScale(smoothAlpha: smoothAlpha)
    }

    private func transformAndScale(smoothAlpha: Float) -> [Float] {
        var out = [Float](repeating: 0, count: n)

        realp.withUnsafeMutableBufferPointer { rp in
            imagp.withUnsafeMutableBufferPointer { ip in
                var split = DSPSplitComplex(realp: rp.baseAddress!, imagp: ip.baseAddress!)
                vDSP_fft_zip(setup, &split, 1, log2n, FFTDirection(kFFTDirection_Forward))
                // |X|² for every bin, in one pass.
                scratch.withUnsafeMutableBufferPointer { mp in
                    vDSP_zvmags(&split, 1, mp.baseAddress!, 1, vDSP_Length(n))
                }
            }
        }

        // Power normalisation 1/N², then dB, then the window gain back.
        // vDSP_vdbcon with flag 0 is 10·log10 (power), which is what we want —
        // flag 1 would be 20·log10 and read 6 dB per doubling too hot.
        var norm = Float(1.0 / (Double(n) * Double(n)))
        vDSP_vsmul(scratch, 1, &norm, &scratch, 1, vDSP_Length(n))
        // Floor before the log so a silent bin cannot produce -inf.
        var floorPower: Float = 1e-20
        vDSP_vthr(scratch, 1, &floorPower, &scratch, 1, vDSP_Length(n))
        var one: Float = 1
        vDSP_vdbcon(scratch, 1, &one, &scratch, 1, vDSP_Length(n), 0)
        var gain = windowGainDb
        vDSP_vsadd(scratch, 1, &gain, &scratch, 1, vDSP_Length(n))

        // fftshift: positive freqs k=0..N/2-1 land at idx half..N-1, negative
        // freqs k=N/2..N-1 at idx 0..half-1. So DC ends up at idx N/2.
        let half = n >> 1
        for k in 0..<half { out[k + half] = scratch[k] }
        for k in half..<n { out[k - half] = scratch[k] }

        // EWMA across frames, never across bins.
        // SDR++'s form, by way of the plugin (spectrumFeed.ts:172): the caller
        // hands in the coefficient itself rather than a divisor, because the
        // coefficient is normalised by the frame rate and only the caller knows
        // that. 1 is "follow the frame exactly", which is no smoothing at all.
        //
        // This port had it inverted — alpha = 1 / factor — so a larger number
        // meant more averaging where SDR++ and the plugin both mean less.
        if smoothAlpha < 1, smoothAlpha > 0 {
            if smoothed?.count != n {
                smoothed = out
            } else {
                let oneMinusA = 1 - smoothAlpha
                for i in 0..<n { smoothed![i] = smoothed![i] * oneMinusA + out[i] * smoothAlpha }
            }
            return smoothed!
        }
        smoothed = nil
        return out
    }
}
