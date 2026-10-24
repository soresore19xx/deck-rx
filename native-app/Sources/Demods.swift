import Foundation
import Accelerate

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

/// The rate each mode is demodulated at, and how it gets there from the IQ.
///
/// The detectors used to run at the full IQ rate and only drop samples at the
/// very end. Two things followed from that, both measured on 2026-10-24:
/// - The cost grew with the square of the IQ rate (the WFM IF FIR has taps in
///   proportion to the rate and runs once per sample): 1 s of IQ took 0.49 s of
///   an M4 Max core at 1.024 MHz, 1.67 s at 2.4 MHz, 2.64 s at 3.2 MHz. Widening
///   the display made the audio break up.
/// - NFM, SSB and CW have no filter in front of that final drop, so noise from
///   the whole IQ width folded into the audio: SSB lost 10 dB at a 150 kHz
///   audio rate against none at all, NFM 20 dB below 150 kHz, CW 20 dB at 48.
/// So the channel is cut out first, by `Channelizer`, at the lowest rate that
/// still holds the mode's own passband — the receiver SDR++ is shaped the same
/// way — and the IQ width becomes a display setting that costs the audio
/// nothing. Every figure below comes from a filter or a signal, not a guess.
struct ChannelPlan: Equatable {
    /// IQ samples per channel sample. 1 = no channel stage at all.
    let decimation: Int
    /// What the detectors run at.
    let channelRate: Double
    /// Highest frequency the channel stage must pass untouched.
    let passHz: Double
    /// Nothing may alias back below this: the detector's own filter is still
    /// passing, or only partly stopping, up to here. The channel filter's
    /// stopband starts at `channelRate - protectHz`.
    let protectHz: Double
    /// Channel samples per audio sample.
    let audioDecimation: Int
    var audioRate: Double { channelRate / Double(audioDecimation) }

    /// Below this nothing is demodulated: a 9.5 kHz audio rate once put a 6 kHz
    /// tone out at 3.5 kHz (src/deviceSettings.ts `minAudioRate`).
    static let minAudioRate = 24_000.0
    /// What output hardware runs at. Audio above half of it is thrown away by
    /// the resampler in AudioSink, so producing it is wasted work.
    static let outputRate = 48_000.0
    /// The WFM IF filter's transition band as a share of its cutoff
    /// (`Demods.setWfmIfBandwidth`). The channel stage leaves exactly that much
    /// room, so it is never the narrower of the two.
    static let fmTransition = 0.25
    /// Stereo needs the discriminator output up to the 38 kHz subcarrier's
    /// upper sideband, 53 kHz, below Nyquist.
    static let mpxTopHz = 53_000.0
    /// Where a broadcast FM signal has next to nothing left: peak deviation
    /// plus twice the top of the multiplex, 75 + 2 x 53 kHz (the wider form of
    /// Carson's rule). The multipath equaliser works on the envelope, and a
    /// channel trimmed inside this ripples it.
    static let fmEqualiserPassHz = 75_000 + 2 * mpxTopHz
    /// The AM passband when the bandwidth is "no limit": ITU-R's 10 kHz audio
    /// ceiling for broadcast AM.
    static let amWidestAudioHz = 10_000.0

    /// How far above its cutoff an eighth-order Butterworth (48 dB/octave, the
    /// AM IF filter) has to go to reach 70 dB: 2^(70/48).
    static let iirSkirt = 2.75

    static func make(iqRate: Double, mode: Int, fmBandwidthHz: Double,
                     amBandwidthHz: Double, ssbBandwidthHz: Double) -> ChannelPlan {
        guard iqRate > 0 else {
            return ChannelPlan(decimation: 1, channelRate: 0, passHz: 0, protectHz: 0, audioDecimation: 1)
        }
        let pass: Double, protect: Double, need: Double
        switch mode {
        case 0, 1, 3:
            // NFM, WFM, DSB: the IF FIR's cutoff is half the FM bandwidth,
            // clamped where that filter clamps it, and its skirt runs an eighth
            // of the cutoff either side. The channel passes the whole skirt
            // and keeps aliases off it, with a quarter of the cutoff of its own
            // transition.
            let fc = max(30_000, fmBandwidthHz / 2)
            let edge = fc * (1 + fmTransition / 2)
            // WFM's equaliser runs ahead of the IF filter and has to see the
            // whole FM signal, not the IF's share of it.
            pass = mode == 1 ? max(edge, fmEqualiserPassHz) : edge
            protect = edge
            var r = pass + protect + fc * fmTransition
            if mode == 1 { r = max(r, 2 * mpxTopHz * 1.1) }
            need = r
        case 2:
            pass = amBandwidthHz > 0 ? amBandwidthHz / 2 : amWidestAudioHz
            protect = pass * iirSkirt
            need = max(minAudioRate, pass + protect + pass)
        case 4, 5, 6:
            // The Weaver detector's whole band sits within its bandwidth of
            // the centre on one side; CW's tone and its filter are inside it.
            // Both are followed by fourth-order low-passes only.
            pass = max(ssbBandwidthHz, 3_000)
            protect = pass * iirSkirt
            need = max(minAudioRate, pass + protect + pass)
        default:
            // RAW plays silence; there is no channel to cut.
            return ChannelPlan(decimation: 1, channelRate: iqRate, passHz: iqRate / 2,
                               protectHz: iqRate / 2, audioDecimation: 1)
        }
        let dec = max(1, Int(iqRate / need))
        let ch = iqRate / Double(dec)
        // Only WFM has a filter in front of the detector's own sample drop (the
        // 15 kHz audio band, eighth order), so only WFM may drop samples there;
        // the rest are already at their audio rate.
        let audio = mode == 1 ? max(1, Int(ch / outputRate)) : 1
        return ChannelPlan(decimation: dec, channelRate: ch, passHz: pass, protectHz: protect,
                           audioDecimation: audio)
    }
}

/// Band-limits complex IQ to a channel and decimates it, in one FIR evaluated
/// only at the samples it keeps. int16 in, int16 out, so the detectors take the
/// buffer they always took.
///
/// The passband is flat to `passHz`; the stopband starts where anything in it
/// would alias back down below `protectHz` (`rate - protectHz`), Blackman
/// windowed, about -74 dB. Unity gain at DC.
final class Channelizer {
    private(set) var decimation = 1
    private var taps = [Float]()
    private var histI = [Float]()
    private var histQ = [Float]()
    /// Where the next kept output's window starts in the history.
    private var start = 0

    var isIdentity: Bool { taps.isEmpty }
    var tapCount: Int { taps.count }

    func configure(inRate: Double, plan: ChannelPlan) {
        decimation = plan.decimation
        histI.removeAll(keepingCapacity: true)
        histQ.removeAll(keepingCapacity: true)
        start = 0
        let outRate = inRate / Double(decimation)
        // Without decimation nothing aliases, but the band can still be wider
        // than the channel: the HF+'s 456 kHz holds a neighbour 200 kHz off,
        // and WFM's equaliser, ahead of the IF filter, must not see it. So the
        // filter stays, with its stop band from Nyquist instead, and goes only
        // when there is no room for a skirt at all.
        let stop = decimation > 1 ? outRate - plan.protectHz : inRate / 2
        guard stop > plan.passHz * 1.05 else { taps = []; return }
        let trans = max(1, stop - plan.passHz)
        let fc = (plan.passHz + stop) / 2
        // Blackman's main lobe, as ComplexFirLpf sizes it. Doubling and
        // quadrupling this changed nothing measurable (2026-10-25).
        var n = max(31, Int((5.5 * inRate / trans).rounded()))
        if n % 2 == 0 { n += 1 }
        let wc = 2 * Double.pi * fc / inRate
        let m = Double(n - 1) / 2
        var t = [Double](repeating: 0, count: n)
        var sum = 0.0
        for i in 0..<n {
            let k = Double(i) - m
            let sinc = k == 0 ? wc / Double.pi : sin(wc * k) / (Double.pi * k)
            let w = 0.42 - 0.5 * cos(2 * Double.pi * Double(i) / Double(n - 1))
                + 0.08 * cos(4 * Double.pi * Double(i) / Double(n - 1))
            t[i] = sinc * w; sum += t[i]
        }
        // Symmetric, so the dot product needs no reversal.
        taps = t.map { Float($0 / sum) }
        histI = [Float](repeating: 0, count: n - 1)
        histQ = [Float](repeating: 0, count: n - 1)
        primed = false
    }

    /// The history starts as the first sample repeated, not zeros. From zeros
    /// the output rises out of nothing over the filter's length, and WFM's
    /// equaliser, which judges by the envelope, took that ramp for an echo and
    /// set its taps by it; on a narrow-band signal nothing ever moved them
    /// back — mono SINAD 51 dB where it is 93 without the ramp (2026-10-25).
    private var primed = false

    func process(_ iq: Data) -> Data {
        guard !taps.isEmpty else { return iq }
        let n = iq.count / 4
        guard n > 0 else { return Data() }
        if !primed {
            primed = true
            iq.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
                let s = raw.bindMemory(to: Int16.self)
                let i0 = Float(Int16(littleEndian: s[0])), q0 = Float(Int16(littleEndian: s[1]))
                for k in 0..<histI.count { histI[k] = i0; histQ[k] = q0 }
            }
        }
        let base = histI.count
        histI.append(contentsOf: repeatElement(0, count: n))
        histQ.append(contentsOf: repeatElement(0, count: n))
        iq.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            let s = raw.bindMemory(to: Int16.self).baseAddress!
            histI.withUnsafeMutableBufferPointer { d in
                vDSP_vflt16(s, 2, d.baseAddress! + base, 1, vDSP_Length(n))
            }
            histQ.withUnsafeMutableBufferPointer { d in
                vDSP_vflt16(s + 1, 2, d.baseAddress! + base, 1, vDSP_Length(n))
            }
        }
        let len = taps.count, total = histI.count
        let count = total >= start + len ? (total - start - len) / decimation + 1 : 0
        var out = Data(count: count * 4)
        out.withUnsafeMutableBytes { (raw: UnsafeMutableRawBufferPointer) in
            let d = raw.bindMemory(to: Int16.self).baseAddress!
            taps.withUnsafeBufferPointer { tp in
            histI.withUnsafeBufferPointer { hi in
            histQ.withUnsafeBufferPointer { hq in
                var pos = start
                for k in 0..<count {
                    var vi: Float = 0, vq: Float = 0
                    vDSP_dotpr(tp.baseAddress!, 1, hi.baseAddress! + pos, 1, &vi, vDSP_Length(len))
                    vDSP_dotpr(tp.baseAddress!, 1, hq.baseAddress! + pos, 1, &vq, vDSP_Length(len))
                    d[k * 2] = Int16(max(-32767, min(32767, vi.rounded()))).littleEndian
                    d[k * 2 + 1] = Int16(max(-32767, min(32767, vq.rounded()))).littleEndian
                    pos += decimation
                }
            } } }
        }
        start += count * decimation
        // Drop what no later window reaches.
        let drop = min(start, total)
        histI.removeFirst(drop)
        histQ.removeFirst(drop)
        start -= drop
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

/// Constant-modulus blind equaliser (Godard, p = 2) for wide FM, between the
/// channel filter and the IF low-pass (Demods `wfmEq`). Ported from `CmaEqualizer` in
/// `src/dspFilters.ts`, constants intact; the comment there has the reasoning
/// and the 2026-10-21 measurement (echoes are what made stereo so much noisier
/// than mono).
final class CmaEqualizer {
    static let taps = 16
    static let ref = 3
    private var wI = [Double](repeating: 0, count: CmaEqualizer.taps)
    private var wQ = [Double](repeating: 0, count: CmaEqualizer.taps)
    private var hI = [Double]()
    private var hQ = [Double]()
    private var head = 0
    private var len = 0
    private var spacing = 1
    private var mu: Double = 0
    private var powAlpha: Double = 0
    private var pow: Double = 0
    private(set) var lastI: Double = 0
    private(set) var lastQ: Double = 0
    /// Taps about 2 µs apart whatever the rate; adaptation and power tracking
    /// scaled to run at the same speed in seconds.
    func configure(fs: Double) {
        spacing = max(1, Int((fs / 500_000).rounded()))
        len = (CmaEqualizer.taps - 1) * spacing + 1
        hI = [Double](repeating: 0, count: len)
        hQ = [Double](repeating: 0, count: len)
        let perSample = 500_000 / fs
        mu = 2e-4 * perSample
        powAlpha = min(1, 0.002 * perSample)
        reset()
    }

    func reset() {
        for k in 0..<CmaEqualizer.taps { wI[k] = 0; wQ[k] = 0 }
        wI[CmaEqualizer.ref] = 1
        for i in 0..<hI.count { hI[i] = 0; hQ[i] = 0 }
        head = 0
        pow = 0
        lastI = 0; lastQ = 0
    }

    func step(_ iIn: Double, _ qIn: Double) {
        guard len > 0 else { lastI = iIn; lastQ = qIn; return }
        let p = iIn * iIn + qIn * qIn
        pow = pow > 0 ? pow + (p - pow) * powAlpha : p
        guard pow > 1e-12 else { lastI = iIn; lastQ = qIn; return }
        let scale = pow.squareRoot()
        let g = 1 / scale
        hI[head] = iIn * g
        hQ[head] = qIn * g
        // y = sum w[k] . x[n - k.D]
        var yI: Double = 0, yQ: Double = 0
        var idx = head
        for k in 0..<CmaEqualizer.taps {
            let xi = hI[idx], xq = hQ[idx]
            yI += wI[k] * xi - wQ[k] * xq
            yQ += wI[k] * xq + wQ[k] * xi
            idx -= spacing; if idx < 0 { idx += len }
        }
        let m = yI * yI + yQ * yQ
        guard m < 16 else {
            // Diverged (or NaN): start again from a pass-through, keep the power.
            let pw = pow
            reset()
            pow = pw
            lastI = iIn; lastQ = qIn
            return
        }
        // w[k] -= mu (|y|^2 - 1) . y . conj(x[n - k.D])
        let e = mu * (m - 1)
        let eI = e * yI, eQ = e * yQ
        idx = head
        for k in 0..<CmaEqualizer.taps {
            let xi = hI[idx], xq = hQ[idx]
            wI[k] -= eI * xi + eQ * xq
            wQ[k] -= eQ * xi - eI * xq
            idx -= spacing; if idx < 0 { idx += len }
        }
        head = head + 1 < len ? head + 1 : 0
        lastI = yI * scale
        lastQ = yQ * scale
    }
}

/// The output scales LocalRadio hands the demodulators — `AM_AGC_OFF_SCALE`,
/// `SSB_GAIN` and `CW_GAIN` in src/demodulator.ts, same values, same reasons
/// (the comment there has the measurements). Each keeps an IQ amplitude of
/// 16000, 6 dB above the strong locals, off the rail; Tests/main.swift checks
/// them at that input. None follows the RF gain (0ee600c).
enum OutputScale {
    /// With the carrier AGC off, AMDemod runs 32 x this: 2x.
    static let amAgcOff = 1.0 / 16.0
    static let ssb = 24_000.0
    /// CW with its AGC off only; with it on, the set point decides.
    static let cw = 24_000.0

    /// FM gains at `fmReferenceIQRate` — `WFM_GAIN`, `WFM_STEREO_GAIN`,
    /// `NFM_GAIN` and `fmOutputScale` in src/demodulator.ts. The detectors
    /// return the phase step per IQ sample, so a fixed gain made FM louder the
    /// lower the IQ rate: at iqDecimation 2 on the HF+ (228 kHz) this app
    /// played FM 6-8 dB above AM at the same depth (2026-09-30).
    static let wfm = 3_000.0
    static let wfmStereo = 2_000.0
    static let nfm = 6_000.0
    static let fmReferenceIQRate = 456_000.0
    static func fm(iqRate: Double) -> Double {
        iqRate > 0 ? iqRate / fmReferenceIQRate : 1
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
    /// Multipath equaliser (CmaEqualizer), ahead of the IF filter. It sat
    /// after it until 2026-10-25, where it was handed a signal the IF filter
    /// had already trimmed: no longer constant in modulus, so the equaliser
    /// "corrected" the trim and the correction landed in L-R. On a clean
    /// left-only signal (250 kHz IF, 343 kHz channel) that cost 10.6 dB of
    /// separation averaged over 400 Hz-7 kHz; ahead of the filter, fed the
    /// channel's ±181 kHz (ChannelPlan.fmEqualiserPassHz), it costs nothing
    /// measurable, and an 8.8 us -10 dB echo is cleaned further than before
    /// (Tests/ChannelTests.swift).
    private let wfmEq = CmaEqualizer()
    private var wfmEqOn = true
    /// 19 kHz notches after the 15 kHz LPFs: the 8th-order Butterworth is only
    /// ~16 dB down at 19 kHz, and the pilot reached the audio at -20 dB under
    /// the programme (2026-10-21). L-R needs one too — the 38 kHz mix puts the
    /// pilot back at 19 kHz.
    private var lprNotch = Biquad()
    private var lmrNotch = Biquad()
    private var deempAlpha: Double = 1
    private var deempY: Double = 0
    private var lprLpf = [Biquad](repeating: Biquad(), count: 4)
    private var lmrLpf = [Biquad](repeating: Biquad(), count: 4)
    private var pilotBpf = Biquad()
    private var lprConfigured = false
    private(set) var wfmInBandMeanPower: Double = 0
    /// Share of the channel's power the IF filter took away, last buffer.
    private(set) var wfmOutsideShare: Double = 0
    private var eqGateOpen = true

    /// The equaliser assumes one constant-modulus signal in its input, and a
    /// second station breaks that: with a neighbour 200 kHz off, even 20 dB
    /// down, it took a lone tone's SINAD from 93 to about 50 dB, at either
    /// place in the chain, where without it nothing moved (2026-10-25). An
    /// echo is the station itself, delayed, and stays inside its own band; a
    /// neighbour brings power the IF filter then takes away. So the share the
    /// IF filter removed tells the two apart, and the equaliser waits while a
    /// neighbour is there.
    private func updateEqGate(inBand: Double, channel: Double) {
        guard channel > 0 else { return }
        wfmOutsideShare = max(0, 1 - inBand / channel)
        let wasOpen = eqGateOpen
        if eqGateOpen, wfmOutsideShare > Self.eqGateClose { eqGateOpen = false }
        else if !eqGateOpen, wfmOutsideShare < Self.eqGateOpen { eqGateOpen = true }
        if wasOpen && !eqGateOpen { wfmEq.reset() }
    }
    /// Measured 2026-10-25 (2.4 MHz and 456 kHz, 250 kHz IF): a lone station
    /// spills at most -30.2 dB past the IF filter — full-deviation stereo at
    /// 15 kHz, an 8.8 µs echo, or noise down to 28 dB SNR — and a neighbour
    /// 200 kHz off lifts that to -22 dB at -20 dB, -12 dB at -10 dB. Shut
    /// above -26 dB, open again below -28: both clear of the lone station.
    static let eqGateClose = pow(10, -26.0 / 10)
    static let eqGateOpen = pow(10, -28.0 / 10)

    /// How quiet the WFM discriminator is: its power in 66-84 kHz, above
    /// everything a broadcast carries (L-R ends at 53 kHz, RDS at 59.4), and
    /// the samples it was summed over, for the last block. The discriminator
    /// reads radians, whatever the RF level, so the mean is comparable across
    /// gains; not over the whole power, which the programme moves (speech,
    /// music, a pause). Noise only, it is large; once the station quiets the
    /// receiver it falls. Gain
    /// search judges WFM by it — the spectrum's C/N cannot see the FM
    /// threshold, and on 78.9 MHz chose gain 18 where only 24 was listenable
    /// (2026-10-16). Both sums are 0 when the band cannot be measured (IQ
    /// rate under 200 kHz, or an IF filter narrower than the band).
    private(set) var wfmQuietSum: Double = 0
    private(set) var wfmQuietCount: Double = 0
    private var quietBpf = [Biquad](repeating: Biquad(), count: 2)
    private var quietReady = false

    // Stereo pilot PLL.
    private var pllPhase: Double = 0
    private var pllNominalDelta: Double = 0
    /// Undoes the discriminator's droop at the 38 kHz subcarrier. The phase
    /// step between two samples is the frequency averaged over one sample
    /// period, a one-sample moving average with response sinc(f / fs): L-R
    /// rides at 38 kHz and comes out that much smaller than L+R, and a gain
    /// error e between the two caps separation at 20 log(2 / e). Measured
    /// without any IF filter, 2026-10-25: 39.9 dB at 343 kHz, 50.2 at 600 kHz,
    /// 64.2 at 1.2 MHz, against 40.0 / 49.6 / 61.7 from the formula. Harmless
    /// at the rates this ran at before (0.3 % at 912 kHz) and the whole story
    /// at the channel rate.
    private var lmrDroop: Double = 1
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
        if wfmIfRate != iqRate { wfmEq.configure(fs: iqRate) }
        wfmIfRate = iqRate
        quietReady = iqRate >= 200_000 && fc >= 90_000
        if quietReady { for k in 0..<2 { quietBpf[k].setBandPass(fs: iqRate, fc: 75_000, q: 3) } }
    }

    /// Multipath equaliser on/off (WFM). On by default.
    func setWfmEqualizer(_ on: Bool) {
        if on && !wfmEqOn { wfmEq.reset() }
        wfmEqOn = on
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
        // q 4: about 4.8 kHz wide, all of it above the 15 kHz audio band.
        lprNotch.setNotch(fs: iqRate, fc: 19000, q: 4)
        lmrNotch.setNotch(fs: iqRate, fc: 19000, q: 4)
        pilotBpf.setBandPass(fs: iqRate, fc: 19000, q: 30)
        // Second-order PLL, damping 1/sqrt(2), loop bandwidth 50 Hz — the
        // middle of the 30-100 Hz the broadcast industry uses. The phase
        // detector's low-pass sits at five times the loop bandwidth.
        pllNominalDelta = 2 * Double.pi * 19000 / iqRate
        let x = Double.pi * 38_000 / iqRate
        lmrDroop = x > 0 ? x / sin(x) : 1
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
        let (outSamples, first) = takePicks(inSamples, decimate)
        guard outSamples > 0 else { return [] }
        var nextPick = first
        var out = [Float](repeating: 0, count: outSamples * 2)
        var oi = 0
        var inBandSum: Double = 0
        var chanSum: Double = 0
        let eqActive = wfmEqOn && wfmIfRate > 0 && eqGateOpen
        var quietSum: Double = 0, totalSum: Double = 0
        let a = deempAlpha

        iq.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            let base = raw.baseAddress!
            for i in 0..<inSamples {
                let o = i * 4
                var I = Double(base.loadUnaligned(fromByteOffset: o, as: Int16.self).littleEndian)
                var Q = Double(base.loadUnaligned(fromByteOffset: o + 2, as: Int16.self).littleEndian)
                // The equaliser before the IF filter (see `wfmEq`).
                if eqActive { wfmEq.step(I, Q); I = wfmEq.lastI; Q = wfmEq.lastQ }
                // What the IF filter is handed, so the share it removes is its
                // own doing: an echo the equaliser cancels lowers the power too.
                chanSum += I * I + Q * Q
                if wfmIfRate > 0 { wfmIf.step(I, Q); I = wfmIf.lastI; Q = wfmIf.lastQ }
                inBandSum += I * I + Q * Q
                let denom = I * prevI + Q * prevQ
                let numer = Q * prevI - I * prevQ
                var demod: Double = 0
                if abs(denom) + abs(numer) > 1 { demod = atan2(numer, denom) }
                prevI = I
                prevQ = Q
                if quietReady {
                    var q = demod
                    for k in 0..<2 { q = quietBpf[k].step(q) }
                    quietSum += q * q; totalSum += 1
                }

                var lpr = demod
                for k in 0..<4 { lpr = lprLpf[k].step(lpr) }
                lpr = lprNotch.step(lpr)
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

                // Two things have to be right here, and the second was wrong
                // from the day the PLL was written until 2026-09-12.
                //
                // 1. The doubled reference has to come from the phase the pilot
                //    was measured against — `pllPhase` has already been advanced
                //    a sample by the loop above, and a sample is 15 degrees at
                //    19 kHz, so 30 degrees at 38 kHz.
                // 2. Double it with SINE, not cosine. The broadcast standard
                //    (Zenith-GE, ITU-R BS.450) carries the pilot and the
                //    suppressed subcarrier as sin(psi) and sin(2.psi), crossing
                //    zero going positive together. The loop locks cosV onto the
                //    pilot, so cosV = sin(psi) and phase = psi - 90 deg; the
                //    reference is sin(2.psi) = -sin(2.phase) = -2.sinV.cosV.
                //    cos(2.phase) is in quadrature with that: the coherent L-R
                //    came out ZERO and every broadcast was mono. The synthetic
                //    test signal used cos for the pilot AND the subcarrier, so
                //    it was self-consistent and never caught it. Measured on a
                //    standard-compliant signal: cos form 0.0 dB separation,
                //    this form 48 dB. The sign matters — +2.sinV.cosV separates
                //    equally well but hands back L and R swapped.
                let ref38 = -2 * sinV * cosV
                // x2 compensates the 1/2 from cos.cos.
                var lmr = demod * ref38 * 2 * lmrDroop
                for k in 0..<4 { lmr = lmrLpf[k].step(lmr) }
                lmr = lmrNotch.step(lmr)

                guard i == nextPick, oi < outSamples else { continue }
                nextPick += decimate
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
        updateEqGate(inBand: inBandSum, channel: chanSum)
        wfmQuietSum = quietSum; wfmQuietCount = totalSum
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
        let (outSamples, first) = takePicks(inSamples, decimate)
        guard outSamples > 0 else { return [] }
        var nextPick = first
        var out = [Float](repeating: 0, count: outSamples)
        var oi = 0
        var inBandSum: Double = 0
        var chanSum: Double = 0
        let eqActive = wfmEqOn && wfmIfRate > 0 && eqGateOpen
        var quietSum: Double = 0, totalSum: Double = 0
        let quiet = wide && quietReady

        iq.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            let base = raw.baseAddress!
            for i in 0..<inSamples {
                let o = i * 4
                var I = Double(base.loadUnaligned(fromByteOffset: o, as: Int16.self).littleEndian)
                var Q = Double(base.loadUnaligned(fromByteOffset: o + 2, as: Int16.self).littleEndian)
                // The equaliser before the IF filter (see `wfmEq`).
                if wide && eqActive { wfmEq.step(I, Q); I = wfmEq.lastI; Q = wfmEq.lastQ }
                chanSum += I * I + Q * Q   // what the IF filter is handed (see the stereo path)
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
                if quiet {
                    var q = r
                    for k in 0..<2 { q = quietBpf[k].step(q) }
                    quietSum += q * q; totalSum += 1
                }

                var band = r
                if wide && lprConfigured {
                    for k in 0..<4 { band = lprLpf[k].step(band) }
                    band = lprNotch.step(band)
                }
                if i == nextPick && oi < outSamples {
                    nextPick += decimate
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
        updateEqGate(inBand: inBandSum, channel: chanSum)
        wfmQuietSum = quietSum; wfmQuietCount = totalSum
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
    // SSB AGC, off by default: SSB_AGC_* in src/demodulator.ts, same values.
    private var ssbAgcEnabled = false
    private var ssbAgcAmp: Double = 0
    private var ssbAgcAttack: Double = 0
    private var ssbAgcDecay: Double = 0
    private var ssbAgcRate: Double = 0
    private static let ssbSetPoint: Double = 12000
    private static let ssbMaxGain: Double = 50 * (24000.0 / 16000.0)

    func setSsbAgc(_ enabled: Bool, audioRate: Double) {
        if enabled != ssbAgcEnabled { ssbAgcAmp = 0 }
        ssbAgcEnabled = enabled
        if audioRate > 0 && audioRate != ssbAgcRate {
            ssbAgcRate = audioRate
            ssbAgcAttack = 1 - exp(-1 / (0.002 * audioRate))
            ssbAgcDecay = 1 - exp(-1 / (0.5 * audioRate))
        }
    }

    func processSSB(int16IQ iq: Data, decimate: Int, upperSideband: Bool,
                    gain: Double = 48000) -> [Float] {
        let inSamples = iq.count / 4
        guard inSamples > 0, decimate > 0 else { return [] }
        let (outSamples, first) = takePicks(inSamples, decimate)
        guard outSamples > 0 else { return [] }
        var nextPick = first
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
                guard i == nextPick, oi < outSamples else { continue }
                nextPick += decimate
                var lpI = ip, lpQ = qp
                for k in 0..<2 { lpI = ssbLpfI[k].step(lpI); lpQ = ssbLpfQ[k].step(lpQ) }
                let audio = lpI * c - lpQ * s
                if ssbAgcEnabled && ssbAgcRate > 0 {
                    let m = (lpI * lpI + lpQ * lpQ).squareRoot()
                    ssbAgcAmp += (m > ssbAgcAmp ? ssbAgcAttack : ssbAgcDecay) * (m - ssbAgcAmp)
                    out[oi] = Self.toFloat(audio * min(Self.ssbSetPoint / max(ssbAgcAmp, 1e-3), Self.ssbMaxGain))
                } else {
                    out[oi] = Self.toFloat(audio * gain / 16000)
                }
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
    private var cwRate: Double = 0

    func setupCW(iqRate: Double, bfoHz: Double = 700, audioBwHz: Double = 2400) {
        cwRate = iqRate
        cwPhaseInc = 2 * Double.pi * bfoHz / iqRate
        let q: [Double] = [0.5411961001, 1.3065629649]
        for k in 0..<2 { cwLpf[k].setLowPass(fs: iqRate, fc: audioBwHz, q: q[k]) }
    }

    func processCW(int16IQ iq: Data, decimate: Int, gain: Double = 96000) -> [Float] {
        let inSamples = iq.count / 4
        guard inSamples > 0, decimate > 0 else { return [] }
        let (outSamples, first) = takePicks(inSamples, decimate)
        guard outSamples > 0 else { return [] }
        var nextPick = first
        var out = [Float](repeating: 0, count: outSamples)
        var oi = 0
        // Attack and decay as a rate over the sample rate, SDR++ style. Decay
        // is deliberately slow so the gain stays up through the gaps between
        // dots and dashes instead of pumping on every one. Over the rate the
        // AGC actually runs at: this was 114000 written in, the one audio rate
        // the plugin's config produced, so any other rate moved both time
        // constants with it.
        let aRate = cwRate > 0 ? cwRate / Double(decimate) : 114_000
        let atk = 30.0 / aRate, dcy = 2.0 / aRate
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
                guard i == nextPick, oi < outSamples else { continue }
                nextPick += decimate
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

    /// Input samples to skip before the next one kept. Each detector used to
    /// keep sample i when i % decimate == 0, counting from each packet's own
    /// start, and drop the remainder: a packet that was not a multiple of the
    /// divisor lost samples and restarted the grid at every packet. Harmless
    /// while packets and divisors were both powers of two; with the channel
    /// stage's divisors (6, 7, 9 ...) or rtl_tcp's arbitrary reads, a 1 kHz
    /// tone came out at 13 dB SINAD instead of 93 (2026-10-25).
    private var pickPhase = 0

    /// How many samples of `n` to keep at `d`, and the index of the first.
    private func takePicks(_ n: Int, _ d: Int) -> (count: Int, first: Int) {
        let first = pickPhase
        let count = n > first ? (n - first - 1) / d + 1 : 0
        pickPhase = first + count * d - n
        return (count, first)
    }

    /// Another station has other echoes: the equaliser starts from a pass-through.
    func resetForRetune() { prevI = 0; prevQ = 0; wfmEq.reset() }

    func reset() {
        pickPhase = 0
        prevI = 0; prevQ = 0
        deempY = 0
        ssbPhase = 0; cwPhase = 0; cwAgcAmp = 0; ssbAgcAmp = 0
        audioLpf.reset(); audioHpf.reset()
        wfmIf.reset()
        pllPhase = 0; pllPdI = 0; pllPdQ = 0; pllFreqOffset = 0
        pilotPower = 0; deempL = 0; deempR = 0; stereoLocked = false
        audioLpfR.reset(); audioHpfR.reset()
        pilotBpf.reset()
        for k in 0..<2 { quietBpf[k].reset() }
        for i in 0..<4 { lprLpf[i].reset(); lmrLpf[i].reset() }
        lprNotch.reset(); lmrNotch.reset()
        wfmEq.reset()
        for i in 0..<2 { ssbLpfI[i].reset(); ssbLpfQ[i].reset(); cwLpf[i].reset() }
    }
}
