import Foundation

/// A complex mixer, phase-continuous across buffers.
///
/// The receiver tunes by moving the device's own centre frequency, so every
/// retune re-centres the IQ window — and the spectrum drawn from it. Moving the
/// window's *contents* instead lets the demodulator sit anywhere inside it
/// while the device, and the display, stay where they are. That is what SDR++
/// calls the VFO: one device centre, a demodulator at an offset from it.
///
/// int16 in, int16 out, so every demodulator below takes the buffer it already
/// takes and none of them needs to know. The invariant is that after the shift
/// the buffer means exactly what it would have meant had the device been tuned
/// to the demodulator's own frequency — which is why this runs before the noise
/// reduction as well as before the detectors.
///
/// A rotation preserves magnitude, and a magnitude can be √2 times either
/// component, so a sample within 3 dB of full scale can saturate on the way
/// out. The server's own digital gain is computed to keep the IQ well below
/// that; the clamp is here so that the failure, if it ever comes, is a clipped
/// sample rather than a wrapped one.
struct IQShift {
    private var phase: Double = 0
    private var inc: Double = 0

    /// How far to move the window's contents, at the rate they arrive at. A
    /// demodulator sitting `offset` above the centre wants the contents brought
    /// down by that much, so the caller passes `-offset`.
    mutating func setShift(hz: Double, sampleRate: Double) {
        inc = sampleRate > 0 ? 2 * Double.pi * hz / sampleRate : 0
    }

    /// Nothing to do — the demodulator is on the device's own centre. The
    /// common case, and the one that has to cost nothing and change nothing.
    var isIdentity: Bool { inc == 0 }

    mutating func process(_ iq: Data) -> Data {
        guard inc != 0 else { return iq }
        let n = iq.count / 4
        guard n > 0 else { return iq }
        var out = Data(count: n * 4)
        var p = phase
        let step = inc
        iq.withUnsafeBytes { (src: UnsafeRawBufferPointer) in
            out.withUnsafeMutableBytes { (dst: UnsafeMutableRawBufferPointer) in
                guard let s = src.baseAddress, let d = dst.baseAddress else { return }
                for i in 0..<n {
                    let o = i * 4
                    let I = Double(s.loadUnaligned(fromByteOffset: o, as: Int16.self).littleEndian)
                    let Q = Double(s.loadUnaligned(fromByteOffset: o + 2, as: Int16.self).littleEndian)
                    let c = cos(p), sn = sin(p)
                    p += step
                    if p > Double.pi { p -= 2 * Double.pi } else if p < -Double.pi { p += 2 * Double.pi }
                    let ri = Int16(min(max((I * c - Q * sn).rounded(), -32767), 32767))
                    let rq = Int16(min(max((I * sn + Q * c).rounded(), -32767), 32767))
                    d.storeBytes(of: ri.littleEndian, toByteOffset: o, as: Int16.self)
                    d.storeBytes(of: rq.littleEndian, toByteOffset: o + 2, as: Int16.self)
                }
            }
        }
        phase = p
        return out
    }
}

/// Complex windowed-sinc FIR low-pass: the same real tap set applied to I and
/// Q in lock-step. Linear phase, Blackman window (~-74 dB stopband).
///
/// Ported from `ComplexFirLpf` in `src/dspFilters.ts`. The WFM IF stage needs a
/// steep skirt to reject the adjacent 100-kHz-spaced broadcast channel without
/// staircasing the wanted signal's Carson sidebands; the 8th-order Butterworth
/// this replaced managed only -24 dB/octave.
final class ComplexFirLpf {
    private var taps = [Double]()
    private var bufI = [Double]()
    private var bufQ = [Double]()
    private var head = 0
    private var n = 0
    private(set) var lastI: Double = 0
    private(set) var lastQ: Double = 0

    var tapCount: Int { n }

    /// `transBw` is the width of the transition band. Blackman's main lobe is
    /// about 12pi/N rad/sample, so N ~ 5.5*fs/transBw. Odd tap counts only, so
    /// the impulse response stays symmetric and the phase stays linear.
    func setLowPass(fs: Double, fc: Double, transBw: Double) {
        var N = max(31, Int((5.5 * fs / max(1, transBw)).rounded()))
        if N % 2 == 0 { N += 1 }
        n = N
        if taps.count != N {
            taps = [Double](repeating: 0, count: N)
            bufI = [Double](repeating: 0, count: N)
            bufQ = [Double](repeating: 0, count: N)
        } else {
            for i in 0..<N { bufI[i] = 0; bufQ[i] = 0 }
        }
        head = 0
        let wc = 2 * Double.pi * fc / fs
        let M = Double(N - 1) / 2
        var sum: Double = 0
        for i in 0..<N {
            let k = Double(i) - M
            let sinc = k == 0 ? wc / Double.pi : sin(wc * k) / (Double.pi * k)
            let w = 0.42
                - 0.5 * cos(2 * Double.pi * Double(i) / Double(N - 1))
                + 0.08 * cos(4 * Double.pi * Double(i) / Double(N - 1))
            taps[i] = sinc * w
            sum += taps[i]
        }
        if sum != 0 { let inv = 1 / sum; for i in 0..<N { taps[i] *= inv } }
    }

    func step(_ iIn: Double, _ qIn: Double) {
        guard n > 0 else { lastI = iIn; lastQ = qIn; return }
        bufI[head] = iIn
        bufQ[head] = qIn
        var iOut: Double = 0, qOut: Double = 0
        var idx = head
        for k in 0..<n {
            let t = taps[k]
            iOut += t * bufI[idx]
            qOut += t * bufQ[idx]
            idx = idx > 0 ? idx - 1 : n - 1
        }
        head = head < n - 1 ? head + 1 : 0
        lastI = iOut
        lastQ = qOut
    }

    func reset() {
        for i in 0..<bufI.count { bufI[i] = 0; bufQ[i] = 0 }
        head = 0; lastI = 0; lastQ = 0
    }
}

/// Everything except AM: narrow FM, wide FM (mono and stereo), SSB and CW.
///
/// Ports of `processFM`, `processWFM`, `processWFMStereo`, `processSSB` and
/// `processCW` from `src/demodulator.ts`, structure and constants intact.
final class Demods {

    // MARK: shared

    private var prevI: Double = 0
    private var prevQ: Double = 0

    /// Post-detector audio shaping, shared by every mode below.
    private var audioLpf = Biquad()
    private var audioHpf = Biquad()
    private var audioLpfEnabled = false
    private var audioHpfEnabled = false

    func setAudioFilters(rate: Double, lowPassHz: Double, highPassHz: Double) {
        if lowPassHz > 0, lowPassHz < rate * 0.45 {
            audioLpf.setLowPass(fs: rate, fc: lowPassHz); audioLpfEnabled = true
        } else { audioLpfEnabled = false }
        if highPassHz > 0 {
            audioHpf.setHighPass(fs: rate, fc: highPassHz); audioHpfEnabled = true
        } else { audioHpfEnabled = false }
    }

    private func shape(_ v: Double) -> Double {
        var x = v
        if audioLpfEnabled { x = audioLpf.step(x) }
        if audioHpfEnabled { x = audioHpf.step(x) }
        return x
    }

    /// int16 domain in, -1...1 out — the same scale the plugin's sink is fed,
    /// so levels are directly comparable between the two paths.
    private static func toFloat(_ v: Double) -> Float {
        Float(min(max(v, -32767), 32767) / 32768)
    }

    // MARK: FM

    private let wfmIf = ComplexFirLpf()
    private var wfmIfRate: Double = 0
    private var deempAlpha: Double = 1
    private var deempY: Double = 0
    private var lprLpf = [Biquad](repeating: Biquad(), count: 4)
    private var lmrLpf = [Biquad](repeating: Biquad(), count: 4)
    private var pilotBpf = Biquad()
    private var lprConfigured = false
    private(set) var wfmInBandMeanPower: Double = 0

    // Stereo pilot PLL.
    private var pllPhase: Double = 0
    private var pllNominalDelta: Double = 0
    private var pllAlpha: Double = 0
    private var pllBeta: Double = 0
    private var pllPdLpfAlpha: Double = 0
    private var pllPdI: Double = 0
    private var pllPdQ: Double = 0
    private var pllFreqOffset: Double = 0
    private var pilotPower: Double = 0
    private var deempL: Double = 0
    private var deempR: Double = 0
    private var audioLpfR = Biquad()
    private var audioHpfR = Biquad()
    /// Whether the badge should say STEREO. Stricter than the audio path's own
    /// threshold: the L-R mix runs regardless, but the badge should only appear
    /// when pilot power is confidently clear of the noise floor.
    private(set) var stereoLocked = false
    /// The smoothed lock metric itself. A boolean says the badge is off; this
    /// says whether the pilot is absent, marginal, or present but under the
    /// threshold — three different problems that look identical from outside.
    var pilotMetric: Double { pilotPower }

    /// Transition band is 25 % of the cutoff: a tight skirt with a bounded tap
    /// count. The lower clamp keeps the 19 kHz pilot inside the passband; the
    /// upper one stays under Nyquist so stopband ripple cannot alias back in.
    func setWfmIfBandwidth(iqRate: Double, cutoffHz: Double) {
        let minCut: Double = 30_000
        let maxCut = max(minCut + 1, iqRate * 0.45)
        let fc = min(max(cutoffHz, minCut), maxCut)
        wfmIf.setLowPass(fs: iqRate, fc: fc, transBw: max(5000, fc * 0.25))
        wfmIfRate = iqRate
    }

    func setDeemphasis(audioRate: Double, tau: Double) {
        guard tau > 0 else { deempAlpha = 1; return }
        let dt = 1 / audioRate
        deempAlpha = dt / (tau + dt)
    }

    /// The 15 kHz low-pass on the discriminator output, at IQ rate. It was
    /// stereo-only once, and mono was the louder of the two for it: pilot and
    /// subcarrier sidebands rode straight through the gentle de-emphasis IIR.
    func setWfmAudioBand(iqRate: Double) {
        let q8: [Double] = [0.5097955791, 0.6012682811, 0.8999762110, 2.5629154802]
        for k in 0..<4 {
            lprLpf[k].setLowPass(fs: iqRate, fc: 15000, q: q8[k])
            lmrLpf[k].setLowPass(fs: iqRate, fc: 15000, q: q8[k])
        }
        pilotBpf.setBandPass(fs: iqRate, fc: 19000, q: 30)
        // Second-order PLL, damping 1/sqrt(2), loop bandwidth 50 Hz — the
        // middle of the 30-100 Hz the broadcast industry uses. The phase
        // detector's low-pass sits at five times the loop bandwidth.
        pllNominalDelta = 2 * Double.pi * 19000 / iqRate
        let bw = 50.0, damp = 0.7071067811865476
        let wn = 2 * Double.pi * bw
        pllAlpha = 2 * damp * wn / iqRate
        pllBeta = (wn * wn) / (iqRate * iqRate)
        pllPdLpfAlpha = min(1, 2 * Double.pi * (bw * 5) / iqRate)
        lprConfigured = true
        if wfmIfRate == 0 { setWfmIfBandwidth(iqRate: iqRate, cutoffHz: 80000) }
    }

    /// The right channel needs its own filter state; sharing one biquad between
    /// L and R mixes the two channels through the filter memory.
    func setStereoAudioFilters(rate: Double, lowPassHz: Double, highPassHz: Double) {
        if lowPassHz > 0, lowPassHz < rate * 0.45 { audioLpfR.setLowPass(fs: rate, fc: lowPassHz) }
        if highPassHz > 0 { audioHpfR.setHighPass(fs: rate, fc: highPassHz) }
    }

    /// Wide FM with pilot-tone stereo. Returns interleaved L,R.
    ///
    /// L-R is mixed in unconditionally, as SDR++ does. Gating it to zero below
    /// a pilot threshold gave clean mono on an empty channel, but a scope
    /// comparison on noise showed what it cost: correlation pinned at +1.00,
    /// the image collapsed to a line, where SDR++ showed a proper uncorrelated
    /// cloud. On a real broadcast the gate was fully open anyway.
    func processWFMStereo(int16IQ iq: Data, decimate: Int, gain: Double = 2000) -> [Float] {
        guard lprConfigured else {
            let mono = processWFM(int16IQ: iq, decimate: decimate, gain: gain)
            var out = [Float](repeating: 0, count: mono.count * 2)
            for i in 0..<mono.count { out[i * 2] = mono[i]; out[i * 2 + 1] = mono[i] }
            return out
        }
        let inSamples = iq.count / 4
        guard inSamples > 0, decimate > 0 else { return [] }
        let outSamples = inSamples / decimate
        guard outSamples > 0 else { return [] }
        var out = [Float](repeating: 0, count: outSamples * 2)
        var oi = 0
        var inBandSum: Double = 0
        let a = deempAlpha

        iq.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            let base = raw.baseAddress!
            for i in 0..<inSamples {
                let o = i * 4
                var I = Double(base.loadUnaligned(fromByteOffset: o, as: Int16.self).littleEndian)
                var Q = Double(base.loadUnaligned(fromByteOffset: o + 2, as: Int16.self).littleEndian)
                if wfmIfRate > 0 { wfmIf.step(I, Q); I = wfmIf.lastI; Q = wfmIf.lastQ }
                inBandSum += I * I + Q * Q
                let denom = I * prevI + Q * prevQ
                let numer = Q * prevI - I * prevQ
                var demod: Double = 0
                if abs(denom) + abs(numer) > 1 { demod = atan2(numer, denom) }
                prevI = I
                prevQ = Q

                var lpr = demod
                for k in 0..<4 { lpr = lprLpf[k].step(lpr) }
                let pilot = pilotBpf.step(demod)

                let cosV = cos(pllPhase), sinV = sin(pllPhase)
                pllPdI += pllPdLpfAlpha * (pilot * cosV - pllPdI)
                pllPdQ += pllPdLpfAlpha * (pilot * sinV - pllPdQ)
                let phaseErr = -atan2(pllPdQ, pllPdI)
                // Clamp the integrator: 0.05 rad/sample is far more offset than
                // any real pilot drifts, and it stops windup if the loop latches
                // onto something that is not a pilot at all.
                pllFreqOffset += pllBeta * phaseErr
                pllFreqOffset = min(max(pllFreqOffset, -0.05), 0.05)
                pllPhase += pllNominalDelta + pllAlpha * phaseErr + pllFreqOffset
                while pllPhase > Double.pi { pllPhase -= 2 * Double.pi }
                while pllPhase < -Double.pi { pllPhase += 2 * Double.pi }

                // Phase-coherence test rather than raw magnitude. A real pilot
                // at lock gives pdI ~ A/2 and pdQ ~ 0; a loop stalking noise
                // gives both a similar random magnitude, so pdI - |pdQ| lands
                // near zero. Magnitude alone reads positive in both cases.
                let lockMetric = pllPdI - abs(pllPdQ)
                pilotPower = 0.999 * pilotPower + 0.001 * lockMetric

                let ref38 = cos(2 * pllPhase)
                // x2 compensates the 1/2 from cos.cos.
                var lmr = demod * ref38 * 2
                for k in 0..<4 { lmr = lmrLpf[k].step(lmr) }

                guard i % decimate == 0, oi < outSamples else { continue }
                if stereoLocked {
                    if pilotPower < 0.002 { stereoLocked = false }
                } else if pilotPower > 0.005 {
                    stereoLocked = true
                }
                deempL = a * lpr + (1 - a) * deempL
                deempR = a * lmr + (1 - a) * deempR
                var L = deempL + deempR
                var R = deempL - deempR
                if audioLpfEnabled { L = audioLpf.step(L); R = audioLpfR.step(R) }
                if audioHpfEnabled { L = audioHpf.step(L); R = audioHpfR.step(R) }
                out[oi * 2] = Self.toFloat(L * gain)
                out[oi * 2 + 1] = Self.toFloat(R * gain)
                oi += 1
            }
        }
        wfmInBandMeanPower = inSamples > 0 ? inBandSum / Double(inSamples) : 0
        return out
    }

    /// Narrow FM: discriminator straight into the audio filters.
    func processFM(int16IQ iq: Data, decimate: Int, gain: Double = 6000) -> [Float] {
        demodFM(iq, decimate: decimate, gain: gain, wide: false)
    }

    /// Wide FM, mono. Discriminator, 15 kHz band limit, de-emphasis, audio.
    func processWFM(int16IQ iq: Data, decimate: Int, gain: Double = 3000) -> [Float] {
        demodFM(iq, decimate: decimate, gain: gain, wide: true)
    }

    private func demodFM(_ iq: Data, decimate: Int, gain: Double, wide: Bool) -> [Float] {
        let inSamples = iq.count / 4
        guard inSamples > 0, decimate > 0 else { return [] }
        let outSamples = inSamples / decimate
        guard outSamples > 0 else { return [] }
        var out = [Float](repeating: 0, count: outSamples)
        var oi = 0
        var inBandSum: Double = 0

        iq.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            let base = raw.baseAddress!
            for i in 0..<inSamples {
                let o = i * 4
                var I = Double(base.loadUnaligned(fromByteOffset: o, as: Int16.self).littleEndian)
                var Q = Double(base.loadUnaligned(fromByteOffset: o + 2, as: Int16.self).littleEndian)
                // Band-limit before the discriminator, or wideband noise clicks
                // the atan2 output. Passthrough until the rate is known.
                if wfmIfRate > 0 {
                    wfmIf.step(I, Q)
                    I = wfmIf.lastI
                    Q = wfmIf.lastQ
                }
                inBandSum += I * I + Q * Q
                let denom = I * prevI + Q * prevQ
                let numer = Q * prevI - I * prevQ
                var r: Double = 0
                if abs(denom) + abs(numer) > 1 { r = atan2(numer, denom) }
                prevI = I
                prevQ = Q

                var band = r
                if wide && lprConfigured {
                    for k in 0..<4 { band = lprLpf[k].step(band) }
                }
                if i % decimate == 0 && oi < outSamples {
                    var v: Double
                    if wide {
                        deempY = deempAlpha * band + (1 - deempAlpha) * deempY
                        v = deempY
                    } else {
                        v = r
                    }
                    v = shape(v) * gain
                    out[oi] = Self.toFloat(v)
                    oi += 1
                }
            }
        }
        wfmInBandMeanPower = inSamples > 0 ? inBandSum / Double(inSamples) : 0
        return out
    }

    // MARK: SSB (Weaver)

    private var ssbPhase: Double = 0
    private var ssbPhaseInc: Double = 0
    private var ssbLpfI = [Biquad](repeating: Biquad(), count: 2)
    private var ssbLpfQ = [Biquad](repeating: Biquad(), count: 2)

    /// Weaver: mix down by the audio mid-band offset, low-pass both arms at
    /// that offset, mix back up. LSB comes free by conjugating the input.
    func setupSSB(iqRate: Double, audioRate: Double, offsetHz: Double = 1500) {
        ssbPhaseInc = 2 * Double.pi * offsetHz / iqRate
        // 4th-order Butterworth: Q_k = 1/(2 sin((2k-1)pi/8)).
        let q: [Double] = [0.5411961001, 1.3065629649]
        for k in 0..<2 {
            ssbLpfI[k].setLowPass(fs: audioRate, fc: offsetHz, q: q[k])
            ssbLpfQ[k].setLowPass(fs: audioRate, fc: offsetHz, q: q[k])
        }
    }

    /// The 48000 default is four times the original: the Weaver path splits
    /// energy across two arms over a 2.4 kHz band, so it came out about that
    /// much quieter than AM envelope detection on the same signal.
    func processSSB(int16IQ iq: Data, decimate: Int, upperSideband: Bool,
                    gain: Double = 48000) -> [Float] {
        let inSamples = iq.count / 4
        guard inSamples > 0, decimate > 0 else { return [] }
        let outSamples = inSamples / decimate
        guard outSamples > 0 else { return [] }
        var out = [Float](repeating: 0, count: outSamples)
        var oi = 0
        let qSign: Double = upperSideband ? 1 : -1

        iq.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            let base = raw.baseAddress!
            for i in 0..<inSamples {
                let o = i * 4
                let I = Double(base.loadUnaligned(fromByteOffset: o, as: Int16.self).littleEndian)
                let Q = qSign * Double(base.loadUnaligned(fromByteOffset: o + 2, as: Int16.self).littleEndian)
                let c = cos(ssbPhase), s = sin(ssbPhase)
                let ip = I * c + Q * s
                let qp = -I * s + Q * c
                ssbPhase += ssbPhaseInc
                if ssbPhase > 2 * Double.pi { ssbPhase -= 2 * Double.pi }
                guard i % decimate == 0, oi < outSamples else { continue }
                var lpI = ip, lpQ = qp
                for k in 0..<2 { lpI = ssbLpfI[k].step(lpI); lpQ = ssbLpfQ[k].step(lpQ) }
                let audio = lpI * c - lpQ * s
                out[oi] = Self.toFloat(audio * gain / 16000)
                oi += 1
            }
        }
        return out
    }

    // MARK: CW

    private var cwPhase: Double = 0
    private var cwPhaseInc: Double = 0
    private var cwLpf = [Biquad](repeating: Biquad(), count: 2)
    private var cwAgcAmp: Double = 0
    var cwAgcEnabled = true
    private static let cwSetPoint: Double = 12000
    private static let cwMaxGain: Double = 5000

    /// `bfoHz` is the pitch an unmodulated carrier is shifted to. The low-pass
    /// runs at IQ rate so it anti-aliases the decimation and band-limits the
    /// audio in one cascade.
    func setupCW(iqRate: Double, bfoHz: Double = 700, audioBwHz: Double = 2400) {
        cwPhaseInc = 2 * Double.pi * bfoHz / iqRate
        let q: [Double] = [0.5411961001, 1.3065629649]
        for k in 0..<2 { cwLpf[k].setLowPass(fs: iqRate, fc: audioBwHz, q: q[k]) }
    }

    func processCW(int16IQ iq: Data, decimate: Int, gain: Double = 96000) -> [Float] {
        let inSamples = iq.count / 4
        guard inSamples > 0, decimate > 0 else { return [] }
        let outSamples = inSamples / decimate
        guard outSamples > 0 else { return [] }
        var out = [Float](repeating: 0, count: outSamples)
        var oi = 0
        // Attack and decay as a rate over the sample rate, SDR++ style. Decay
        // is deliberately slow so the gain stays up through the gaps between
        // dots and dashes instead of pumping on every one.
        let atk = 30.0 / 114000.0, dcy = 2.0 / 114000.0
        let invAtk = 1 - atk, invDec = 1 - dcy

        iq.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            let base = raw.baseAddress!
            for i in 0..<inSamples {
                let o = i * 4
                let I = Double(base.loadUnaligned(fromByteOffset: o, as: Int16.self).littleEndian)
                let Q = Double(base.loadUnaligned(fromByteOffset: o + 2, as: Int16.self).littleEndian)
                let c = cos(cwPhase), s = sin(cwPhase)
                let audio = I * c - Q * s
                cwPhase += cwPhaseInc
                if cwPhase > 2 * Double.pi { cwPhase -= 2 * Double.pi }
                var filt = audio
                for k in 0..<2 { filt = cwLpf[k].step(filt) }
                guard i % decimate == 0, oi < outSamples else { continue }
                var v: Double
                if cwAgcEnabled {
                    let a = abs(filt)
                    cwAgcAmp = a > cwAgcAmp ? cwAgcAmp * invAtk + a * atk
                                            : cwAgcAmp * invDec + a * dcy
                    v = filt * min(Self.cwSetPoint / max(cwAgcAmp, 1e-3), Self.cwMaxGain)
                } else {
                    v = filt * gain / 16000
                }
                out[oi] = Self.toFloat(v)
                oi += 1
            }
        }
        return out
    }

    // MARK: lifecycle

    func resetForRetune() { prevI = 0; prevQ = 0 }

    func reset() {
        prevI = 0; prevQ = 0
        deempY = 0
        ssbPhase = 0; cwPhase = 0; cwAgcAmp = 0
        audioLpf.reset(); audioHpf.reset()
        wfmIf.reset()
        pllPhase = 0; pllPdI = 0; pllPdQ = 0; pllFreqOffset = 0
        pilotPower = 0; deempL = 0; deempR = 0; stereoLocked = false
        audioLpfR.reset(); audioHpfR.reset()
        pilotBpf.reset()
        for i in 0..<4 { lprLpf[i].reset(); lmrLpf[i].reset() }
        for i in 0..<2 { ssbLpfI[i].reset(); ssbLpfQ[i].reset(); cwLpf[i].reset() }
    }
}
