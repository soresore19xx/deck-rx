import Accelerate
import Foundation

/// Audio noise reduction for AM / SSB / CW: decision-directed Wiener gain over
/// a minimum-statistics noise estimate. Ported from `Ifnr` in `src/ifnr.ts`,
/// constants and order intact; the comment there has the reasoning and the
/// 2026-10-21 measurements (hiss between words 12-15 dB down, a clean
/// station's loud level within 1 dB). Mono in place, one frame of latency.
final class AudioNr {
    private static let alphaDD = 0.95
    private static let psdTauS = 0.13
    private static let msSubwindows = 8
    private static let msSubwindowS = 0.3
    private static let msBias = 2.5

    private var gMin = 0.18
    func setMaxCutDb(_ db: Double) { gMin = pow(10, -max(3, min(30, db)) / 20) }

    private var rate = 0.0
    private var n = 0, hop = 0, framesPerSw = 14
    private var psdSmooth = 0.85
    private var log2n: vDSP_Length = 0
    private var setup: FFTSetupD?
    private var window = [Double](), inputBuf = [Double](), overlap = [Double]()
    private var inputPos = 0
    private var psd = [Double](), gains = [Double](), prevSignalMag2 = [Double]()
    private var msMin = [Double]()
    private var msSubIdx = 0, msFrameInSub = 0
    private var outBuf = [Double]()
    private var outRead = 0, outWrite = 0
    private var re = [Double](), im = [Double]()

    deinit { if let s = setup { vDSP_destroy_fftsetupD(s) } }

    func configure(rate: Double) {
        guard rate != self.rate, rate > 0 else { return }
        self.rate = rate
        var size = 256
        while Double(size) < rate * 0.04 { size <<= 1 }
        n = size; hop = size / 2
        let frameS = Double(hop) / rate
        framesPerSw = max(2, Int((AudioNr.msSubwindowS / frameS).rounded()))
        psdSmooth = exp(-frameS / AudioNr.psdTauS)
        if let s = setup { vDSP_destroy_fftsetupD(s) }
        log2n = vDSP_Length(log2(Double(size)).rounded())
        setup = vDSP_create_fftsetupD(log2n, FFTRadix(kFFTRadix2))
        window = (0..<size).map { sin(Double.pi * Double($0) / Double(size)) }
        inputBuf = [Double](repeating: 0, count: size)
        overlap = inputBuf
        psd = [Double](repeating: 0, count: size / 2 + 1)
        gains = psd; prevSignalMag2 = psd
        msMin = [Double](repeating: .infinity, count: AudioNr.msSubwindows * (size / 2 + 1))
        outBuf = [Double](repeating: 0, count: hop * 4)
        re = [Double](repeating: 0, count: size / 2); im = re
        reset()
    }

    func reset() {
        for i in 0..<psd.count { psd[i] = 0; prevSignalMag2[i] = 0 }
        for i in 0..<inputBuf.count { inputBuf[i] = 0; overlap[i] = 0 }
        for i in 0..<msMin.count { msMin[i] = .infinity }
        msSubIdx = 0; msFrameInSub = 0
        for i in 0..<outBuf.count { outBuf[i] = 0 }
        outRead = 0; outWrite = hop
        inputPos = 0
    }

    func process(_ x: inout [Float]) {
        guard setup != nil else { return }
        for i in 0..<x.count {
            inputBuf[inputPos] = Double(x[i]); inputPos += 1
            if inputPos == n {
                processBlock()
                for j in 0..<hop { inputBuf[j] = inputBuf[j + hop] }
                inputPos = hop
            }
            if outRead < outWrite { x[i] = Float(outBuf[outRead % outBuf.count]); outRead += 1 } else { x[i] = 0 }
        }
        if outRead >= outBuf.count { outRead -= outBuf.count; outWrite -= outBuf.count }
    }

    private func processBlock() {
        guard let setup = setup else { return }
        let N = n, H = n / 2
        var frame = [Double](repeating: 0, count: N)
        for i in 0..<N { frame[i] = inputBuf[i] * window[i] }
        // Packed real FFT (vDSP): bins 1..H-1 in re/im, DC in re[0], Nyquist in
        // im[0]. Gains are real, so they apply to the packed form directly and
        // the inverse needs only the vDSP scale of 1 / (2N) put back.
        re.withUnsafeMutableBufferPointer { rp in
            im.withUnsafeMutableBufferPointer { ip in
                var sc = DSPDoubleSplitComplex(realp: rp.baseAddress!, imagp: ip.baseAddress!)
                frame.withUnsafeBufferPointer { fp in
                    fp.baseAddress!.withMemoryRebound(to: DSPDoubleComplex.self, capacity: H) {
                        vDSP_ctozD($0, 2, &sc, 1, vDSP_Length(H))
                    }
                }
                vDSP_fft_zripD(setup, &sc, 1, log2n, FFTDirection(FFT_FORWARD))
            }
        }
        // Powers in fft.js's scale (vDSP's forward output is twice it), so the
        // same constants mean the same thing.
        func power(_ k: Int) -> Double {
            if k == 0 { return re[0] * re[0] / 4 }
            if k == H { return im[0] * im[0] / 4 }
            return (re[k] * re[k] + im[k] * im[k]) / 4
        }
        let curOff = msSubIdx * (H + 1)
        let a = psdSmooth
        for k in 0...H {
            let mag2 = power(k)
            psd[k] = psd[k] > 0 ? a * psd[k] + (1 - a) * mag2 : mag2
            if psd[k] < msMin[curOff + k] { msMin[curOff + k] = psd[k] }
            var mn = Double.infinity
            for u in 0..<AudioNr.msSubwindows { mn = min(mn, msMin[u * (H + 1) + k]) }
            let lambda = mn == .infinity ? mag2 : mn * AudioNr.msBias
            let ls = lambda > 1e-12 ? lambda : 1e-12
            let gamma = mag2 / ls
            let xi = AudioNr.alphaDD * (prevSignalMag2[k] / ls) + (1 - AudioNr.alphaDD) * max(0, gamma - 1)
            let g = xi / (1 + xi)
            gains[k] = g < gMin ? gMin : g
        }
        var prev = gains[0]
        for k in 0...H {
            let cur = gains[k]
            let next = k < H ? gains[k + 1] : cur
            let g = 0.25 * prev + 0.5 * cur + 0.25 * next
            prev = cur
            if k == 0 { re[0] *= g } else if k == H { im[0] *= g } else { re[k] *= g; im[k] *= g }
            prevSignalMag2[k] = power(k)
        }
        msFrameInSub += 1
        if msFrameInSub >= framesPerSw {
            msFrameInSub = 0
            msSubIdx = (msSubIdx + 1) % AudioNr.msSubwindows
            let off = msSubIdx * (H + 1)
            for k in 0...H { msMin[off + k] = .infinity }
        }
        var outT = [Double](repeating: 0, count: N)
        re.withUnsafeMutableBufferPointer { rp in
            im.withUnsafeMutableBufferPointer { ip in
                var sc = DSPDoubleSplitComplex(realp: rp.baseAddress!, imagp: ip.baseAddress!)
                vDSP_fft_zripD(setup, &sc, 1, log2n, FFTDirection(FFT_INVERSE))
                outT.withUnsafeMutableBufferPointer { op in
                    op.baseAddress!.withMemoryRebound(to: DSPDoubleComplex.self, capacity: H) {
                        vDSP_ztocD(&sc, 1, $0, 2, vDSP_Length(H))
                    }
                }
            }
        }
        let scale = 1 / Double(2 * N)
        for i in 0..<N { overlap[i] += outT[i] * scale * window[i] }
        for i in 0..<hop { outBuf[outWrite % outBuf.count] = overlap[i]; outWrite += 1 }
        for i in 0..<hop { overlap[i] = overlap[i + hop] }
        for i in hop..<N { overlap[i] = 0 }
    }
}
