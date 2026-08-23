import Foundation

/// Direct-form-II transposed biquad. Coefficient forms are the RBJ cookbook
/// ones, matching `src/dspFilters.ts` term for term.
struct Biquad {
    private var b0: Double = 1, b1: Double = 0, b2: Double = 0
    private var a1: Double = 0, a2: Double = 0
    private var z1: Double = 0, z2: Double = 0

    mutating func reset() { z1 = 0; z2 = 0 }

    mutating func setLowPass(fs: Double, fc: Double, q: Double = 0.7071067811865476) {
        let w = 2 * Double.pi * fc / fs
        let cw = cos(w), sw = sin(w)
        let alpha = sw / (2 * q)
        let a0 = 1 + alpha
        b0 = ((1 - cw) / 2) / a0
        b1 = (1 - cw) / a0
        b2 = ((1 - cw) / 2) / a0
        a1 = (-2 * cw) / a0
        a2 = (1 - alpha) / a0
    }

    mutating func setHighPass(fs: Double, fc: Double, q: Double = 0.7071067811865476) {
        let w = 2 * Double.pi * fc / fs
        let cw = cos(w), sw = sin(w)
        let alpha = sw / (2 * q)
        let a0 = 1 + alpha
        b0 = ((1 + cw) / 2) / a0
        b1 = (-(1 + cw)) / a0
        b2 = ((1 + cw) / 2) / a0
        a1 = (-2 * cw) / a0
        a2 = (1 - alpha) / a0
    }

    /// Band-pass with centre `fc` and quality factor `q`.
    mutating func setBandPass(fs: Double, fc: Double, q: Double) {
        let w = 2 * Double.pi * fc / fs
        let cw = cos(w), sw = sin(w)
        let alpha = sw / (2 * q)
        let a0 = 1 + alpha
        b0 = alpha / a0
        b1 = 0
        b2 = (-alpha) / a0
        a1 = (-2 * cw) / a0
        a2 = (1 - alpha) / a0
    }

    mutating func step(_ x: Double) -> Double {
        let y = b0 * x + z1
        z1 = b1 * x - a1 * y + z2
        z2 = b2 * x - a2 * y
        return y
    }
}

/// AM envelope / synchronous demodulator.
///
/// Ported from `processAM` in `src/demodulator.ts`. The constants and the
/// structure are not adjustable-looking numbers someone picked once — the AGC
/// look-ahead, the asymmetric lock gate and the 16th-order IF filter each
/// exist because of a specific failure. Read the comments before touching any
/// of them; the reasons came across with the code.
final class AMDemod {

    // SDR++-derived AGC constants (dsp::demod::AM CARRIER mode).
    private static let setPoint: Double = 16000
    private static let maxGain: Double = 1e6
    private static let maxOutput: Double = 160_000
    private static let lookAheadSamples = 256

    // Per-stage Q for a true 16th-order Butterworth: Q_k = 1/(2 sin((2k-1)pi/32)).
    private static let q8: [Double] = [0.5024193, 0.5226258, 0.5669004, 0.6471488,
                                       0.7881546, 1.0606777, 1.7224471, 5.1011487]
    // ... and 8th order, for the post-envelope audio filter.
    private static let q4: [Double] = [0.5097955791, 0.6013447997, 0.9, 2.5629154497]

    private var ifI = [Biquad](repeating: Biquad(), count: 8)
    private var ifQ = [Biquad](repeating: Biquad(), count: 8)
    private var audioLpf = [Biquad](repeating: Biquad(), count: 4)
    private var ifEnabled = false
    private var audioLpfEnabled = false

    private var dc: Double = 0
    private var agcAmp: Double = 0
    private var syncPhase: Double = 0
    private var syncFreq: Double = 0
    private var syncCos: Double = 0
    private var syncAlpha: Double = 0
    private var syncBeta: Double = 0

    /// Off by default, as in the plugin: the fixed-gain path is what the
    /// levelling stage downstream was tuned against.
    var agcEnabled = false
    var syncEnabled = false

    /// Scratch for the IF-filtered stream. Pass 2's look-ahead reads forward
    /// into it, so pass 1 has to complete over the whole packet first.
    private var postI = [Double]()
    private var postQ = [Double]()

    /// Sets both the post-envelope audio low-pass (at `audioRate`) and the
    /// complex IF low-pass on I/Q (at `iqRate`). The IF one is the load-bearing
    /// filter: without it an off-centre station bleeds through the envelope
    /// detector no matter what the receiver is tuned to.
    func setBandwidth(audioRate: Double, bandwidthHz: Double, iqRate: Double) {
        if bandwidthHz > 0, bandwidthHz < audioRate * 0.45 {
            for k in 0..<4 { audioLpf[k].setLowPass(fs: audioRate, fc: bandwidthHz, q: Self.q4[k]) }
            audioLpfEnabled = true
        } else {
            audioLpfEnabled = false
        }
        if iqRate > 0, bandwidthHz > 0 {
            // Complex bandwidth is twice the real bandwidth, so the cutoff is
            // half the figure the user set.
            let cutoff = bandwidthHz / 2
            for k in 0..<8 {
                ifI[k].setLowPass(fs: iqRate, fc: cutoff, q: Self.q8[k])
                ifQ[k].setLowPass(fs: iqRate, fc: cutoff, q: Self.q8[k])
            }
            ifEnabled = true
        }
    }

    /// Second-order PLL for synchronous detection, critically damped.
    /// `rate` is the rate at which samples are fed, i.e. the decimated one.
    func configureSync(rate: Double, loopBandwidthHz: Double = 100) {
        let wn = 2 * Double.pi * loopBandwidthHz / rate
        syncAlpha = 2 * 0.707 * wn
        syncBeta = wn * wn
    }

    /// Clears only what would otherwise be heard as a click or a thump on a
    /// retune. Filter state is deliberately left alone: it decays on its own,
    /// and zeroing it just trades one transient for another.
    func resetForRetune() {
        dc = 0; agcAmp = 0; syncPhase = 0; syncFreq = 0; syncCos = 0
    }

    func reset() {
        resetForRetune()
        for i in 0..<8 { ifI[i].reset(); ifQ[i].reset() }
        for i in 0..<4 { audioLpf[i].reset() }
    }

    /// Demodulates one packet of interleaved int16 LE IQ into mono float
    /// samples in -1...1, decimating by `decimate`.
    ///
    /// `gainScale` is the user's RF-gain ratio. With AGC off the fixed gain is
    /// scaled by it so the gain control still works as a volume control — the
    /// Airspy HF+ has on-chip AGC that smooths over LNA changes, so without
    /// this the dial would do almost nothing audible.
    func process(int16IQ iq: Data, decimate: Int, gainScale: Double = 1) -> [Float] {
        let inSamples = iq.count / 4
        guard inSamples > 0, decimate > 0 else { return [] }
        let outSamples = inSamples / decimate
        guard outSamples > 0 else { return [] }

        if postI.count != inSamples {
            postI = [Double](repeating: 0, count: inSamples)
            postQ = [Double](repeating: 0, count: inSamples)
        }

        // Pass 1: IF filter over the whole packet.
        iq.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            let base = raw.baseAddress!
            for i in 0..<inSamples {
                let o = i * 4
                var I = Double(base.loadUnaligned(fromByteOffset: o, as: Int16.self).littleEndian)
                var Q = Double(base.loadUnaligned(fromByteOffset: o + 2, as: Int16.self).littleEndian)
                if ifEnabled {
                    for k in 0..<8 { I = ifI[k].step(I); Q = ifQ[k].step(Q) }
                }
                postI[i] = I
                postQ[i] = Q
            }
        }

        // Pass 2: AGC and detection at the decimated rate.
        let gs = min(max(gainScale, 0), 1)
        let fixedGain = agcEnabled ? 1.0 : 32.0 * gs
        let alphaDc = 0.001
        // Per-sample IIR factors. SDR++ expresses these as a rate in Hz over
        // the sample rate; 50 and 5 at 57 kHz are the plugin's defaults and
        // the numbers the AM path was tuned with.
        let atk = 50.0 / 57000.0, dcy = 5.0 / 57000.0
        let invAtk = 1 - atk, invDec = 1 - dcy

        var out = [Float](repeating: 0, count: outSamples)
        var oi = 0
        var i = 0
        while i < inSamples && oi < outSamples {
            var I = postI[i]
            var Q = postQ[i]

            if agcEnabled {
                let carrier = (I * I + Q * Q).squareRoot()
                if carrier != 0 {
                    agcAmp = carrier > agcAmp ? agcAmp * invAtk + carrier * atk
                                              : agcAmp * invDec + carrier * dcy
                }
                var g = min(Self.setPoint / max(agcAmp, 1e-3), Self.maxGain)
                // Look-ahead clip prevention. When the tracker is behind
                // reality — fresh start, or a sudden jump in amplitude —
                // gain x carrier can exceed the safe ceiling. Scan a bounded
                // window ahead for the next peak, snap to it, recompute.
                if carrier * g > Self.maxOutput {
                    var maxAmp = carrier
                    let limit = min(inSamples, i + Self.lookAheadSamples * decimate)
                    var j = i + decimate
                    while j < limit {
                        let a = (postI[j] * postI[j] + postQ[j] * postQ[j]).squareRoot()
                        if a > maxAmp { maxAmp = a }
                        j += decimate
                    }
                    agcAmp = maxAmp
                    g = min(Self.setPoint / max(maxAmp, 1e-3), Self.maxGain)
                }
                I *= g
                Q *= g
            }

            var v: Double
            if syncEnabled {
                let c = cos(syncPhase), s = sin(syncPhase)
                let dI = I * c + Q * s
                let dQ = -I * s + Q * c
                let phaseErr = atan2(dQ, dI)
                syncFreq += syncBeta * phaseErr
                syncPhase += syncFreq + syncAlpha * phaseErr
                if syncPhase > Double.pi { syncPhase -= 2 * Double.pi }
                else if syncPhase < -Double.pi { syncPhase += 2 * Double.pi }
                // Lock indicator, asymmetric on purpose: rising follows fast
                // (~5 ms) so the gate opens as soon as the PLL acquires,
                // falling follows slowly (~500 ms) so a phase wobble during
                // selective fading does not chop the audio.
                let mag = (dI * dI + dQ * dQ).squareRoot()
                let cosErr = mag > 1e-3 ? dI / mag : 0
                let lockAlpha = cosErr > syncCos ? 0.0035 : 3.51e-5
                syncCos = (1 - lockAlpha) * syncCos + lockAlpha * cosErr
                let lockGate = min(max((syncCos - 0.3) / 0.5, 0), 1)
                dc = dc * (1 - alphaDc) + dI * alphaDc
                v = (dI - dc) * fixedGain * lockGate
            } else {
                let mag = (I * I + Q * Q).squareRoot()
                dc = dc * (1 - alphaDc) + mag * alphaDc
                v = (mag - dc) * fixedGain
            }

            if audioLpfEnabled {
                for k in 0..<4 { v = audioLpf[k].step(v) }
            }

            // int16 domain throughout, converted at the very end — same scale
            // the plugin's sink receives, so levels are comparable.
            let clipped = min(max(v, -32767), 32767)
            out[oi] = Float(clipped / 32768)
            oi += 1
            i += decimate
        }
        return out
    }
}
