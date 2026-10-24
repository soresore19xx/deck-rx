import Foundation
import Accelerate

// The channel stage (ChannelPlan / Channelizer in Demods.swift). What it has
// to prove is that cutting the channel out first costs nothing: each mode,
// through the receiver at a wide IQ rate, must sound as good as the same
// detector fed the full IQ rate and dropping no samples at all — the best this
// receiver could do before, at a cost no device could pay. Measured by SINAD of
// a 1 kHz tone inside the mode's audio band, with the tone fitted and taken
// out before the spectrum so window leakage cannot pose as noise.

private struct TestCarrier {
    var offset: Double, amp: Double, dev: Double = 0
    var fm: ((Double) -> Double)? = nil, am: ((Double) -> Double)? = nil
}

private func channelIQ(rate: Double, seconds: Double, _ cs: [TestCarrier], noise: Double) -> Data {
    let n = Int(rate * seconds)
    var d = Data(count: n * 4)
    var seed: UInt64 = 0x5150
    func rnd() -> Double {
        seed = seed &* 6364136223846793005 &+ 1442695040888963407
        return Double(Int64(bitPattern: seed >> 11)) / Double(1 << 53) - 0.5
    }
    var ph = [Double](repeating: 0, count: cs.count)
    d.withUnsafeMutableBytes { (raw: UnsafeMutableRawBufferPointer) in
        let p = raw.bindMemory(to: Int16.self)
        for i in 0..<n {
            let t = Double(i) / rate
            var I = 0.0, Q = 0.0
            for (k, c) in cs.enumerated() {
                ph[k] += 2 * Double.pi * (c.offset + c.dev * (c.fm?(t) ?? 0)) / rate
                let a = c.amp * (1 + 0.6 * (c.am?(t) ?? 0))
                I += a * cos(ph[k]); Q += a * sin(ph[k])
            }
            I += noise * rnd(); Q += noise * rnd()
            func s(_ v: Double) -> Int16 { Int16(max(-32768, min(32767, (v * 32767).rounded()))) }
            p[i * 2] = s(I).littleEndian; p[i * 2 + 1] = s(Q).littleEndian
        }
    }
    return d
}

/// SINAD (dB) of the `tone` in [lo, hi] over a power-of-two tail inside the
/// second half, so two rates are judged over the same settled stretch of time.
func toneSinad(_ x: [Float], rate: Double, lo: Double, hi: Double, tone: Double = 1000) -> Double {
    var n = 1; while n * 2 <= x.count / 2 { n *= 2 }
    guard n >= 1024 else { return -999 }
    let raw = x[(x.count - n)...].map(Double.init)
    let mean = raw.reduce(0, +) / Double(n)
    var c = 0.0, s = 0.0
    for i in 0..<n {
        let t = 2 * .pi * tone * Double(i) / rate
        c += (raw[i] - mean) * cos(t); s += (raw[i] - mean) * sin(t)
    }
    c *= 2 / Double(n); s *= 2 / Double(n)
    var seg = (0..<n).map { i -> Float in
        let t = 2 * .pi * tone * Double(i) / rate
        return Float(raw[i] - mean - c * cos(t) - s * sin(t))
    }
    var ms: Float = 0; vDSP_measqv(seg, 1, &ms, vDSP_Length(n))
    var w = [Float](repeating: 0, count: n); vDSP_hann_window(&w, vDSP_Length(n), Int32(vDSP_HANN_NORM))
    vDSP_vmul(seg, 1, w, 1, &seg, 1, vDSP_Length(n))
    let log2n = vDSP_Length(log2(Double(n)))
    let setup = vDSP_create_fftsetup(log2n, FFTRadix(kFFTRadix2))!
    var re = [Float](repeating: 0, count: n / 2), im = [Float](repeating: 0, count: n / 2)
    var mag = [Float](repeating: 0, count: n / 2)
    re.withUnsafeMutableBufferPointer { rp in im.withUnsafeMutableBufferPointer { ip in
        var sc = DSPSplitComplex(realp: rp.baseAddress!, imagp: ip.baseAddress!)
        seg.withUnsafeBufferPointer { sp in
            sp.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: n / 2) {
                vDSP_ctoz($0, 2, &sc, 1, vDSP_Length(n / 2)) } }
        vDSP_fft_zrip(setup, &sc, 1, log2n, FFTDirection(FFT_FORWARD))
        vDSP_zvmags(&sc, 1, &mag, 1, vDSP_Length(n / 2))
    } }
    vDSP_destroy_fftsetup(setup)
    let bin = rate / Double(n)
    var band = 0.0, all = 0.0
    for k in 1..<(n / 2) {
        all += Double(mag[k])
        let f = Double(k) * bin
        if f >= lo, f <= hi { band += Double(mag[k]) }
    }
    let rest = all > 0 ? Double(ms) * band / all : 0
    return 10 * log10(((c * c + s * s) / 2) / max(rest, 1e-30))
}

/// RMS of `x` inside [lo, hi] Hz: Hann window, scaled to the unwindowed mean square.
private func bandRms(_ x: [Float], rate: Double, lo: Double, hi: Double) -> Double {
    var n = 1; while n * 2 <= x.count { n *= 2 }
    var seg = Array(x[(x.count - n)...])
    var ms: Float = 0; vDSP_measqv(seg, 1, &ms, vDSP_Length(n))
    var w = [Float](repeating: 0, count: n); vDSP_hann_window(&w, vDSP_Length(n), Int32(vDSP_HANN_NORM))
    vDSP_vmul(seg, 1, w, 1, &seg, 1, vDSP_Length(n))
    let log2n = vDSP_Length(log2(Double(n)))
    let setup = vDSP_create_fftsetup(log2n, FFTRadix(kFFTRadix2))!
    var re = [Float](repeating: 0, count: n / 2), im = [Float](repeating: 0, count: n / 2)
    var mag = [Float](repeating: 0, count: n / 2)
    re.withUnsafeMutableBufferPointer { rp in im.withUnsafeMutableBufferPointer { ip in
        var sc = DSPSplitComplex(realp: rp.baseAddress!, imagp: ip.baseAddress!)
        seg.withUnsafeBufferPointer { sp in
            sp.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: n / 2) {
                vDSP_ctoz($0, 2, &sc, 1, vDSP_Length(n / 2)) } }
        vDSP_fft_zrip(setup, &sc, 1, log2n, FFTDirection(FFT_FORWARD))
        vDSP_zvmags(&sc, 1, &mag, 1, vDSP_Length(n / 2))
    } }
    vDSP_destroy_fftsetup(setup)
    var band = 0.0, all = 0.0
    for k in 1..<(n / 2) {
        all += Double(mag[k])
        let f = Double(k) * rate / Double(n)
        if f >= lo, f <= hi { band += Double(mag[k]) }
    }
    return (Double(ms) * band / max(all, 1e-30)).squareRoot()
}

private func toneLevel(_ x: [Float], hz: Double, rate: Double) -> Double {
    var re = 0.0, im = 0.0
    for (i, v) in x.enumerated() {
        let t = 2 * .pi * hz * Double(i) / rate
        re += Double(v) * cos(t); im += Double(v) * sin(t)
    }
    return (re * re + im * im).squareRoot() / Double(max(1, x.count))
}

func runChannelTests() {
    section("channel stage: each mode's rate comes from its own passband")
    let c = RadioConfig()
    func plan(_ r: Double, _ m: Int) -> ChannelPlan {
        ChannelPlan.make(iqRate: r, mode: m, fmBandwidthHz: c.fmBandwidthHz,
                         amBandwidthHz: c.amBandwidthHz, ssbBandwidthHz: c.ssbBandwidthHz)
    }
    let w = plan(2_400_000, RxMode.wfm)
    // The equaliser's 181 kHz passed whole, nothing aliasing onto the IF's skirt
    // (140.6 kHz), 31.25 kHz between: 352.5 kHz, and 2.4 MHz / 6 is the first
    // rate above it.
    check("WFM at 2.4 MHz runs at 400 kHz: the whole FM signal, the IF skirt kept clear, and room",
          w.decimation == 6 && w.channelRate >= 352_000 && w.passHz >= ChannelPlan.fmEqualiserPassHz, "\(w)")
    check("NFM does not carry the equaliser's width", plan(2_400_000, RxMode.nfm).passHz < ChannelPlan.fmEqualiserPassHz)
    check("and leaves the detector to drop to the output's rate, not below 24 kHz",
          w.audioRate >= ChannelPlan.minAudioRate && w.audioRate <= 2 * ChannelPlan.outputRate, "\(w.audioRate)")
    let a = plan(2_400_000, RxMode.am)
    check("AM at 2.4 MHz runs at 24 kHz", a.decimation == 100 && a.audioRate == 24_000, "\(a)")
    let u = plan(3_200_000, 4)
    check("SSB at 3.2 MHz runs at or just above 24 kHz",
          u.channelRate >= 24_000 && u.channelRate < 25_000 && u.audioDecimation == 1, "\(u)")
    check("an IQ rate that is already narrow is left alone (the HF+'s 456 kHz on WFM)",
          plan(456_000, RxMode.wfm).decimation == 1)
    check("nothing runs under the 24 kHz floor (V4 at 250 kHz, AM)",
          plan(250_000, RxMode.am).channelRate >= ChannelPlan.minAudioRate)
    var narrow = c; narrow.fmBandwidthHz = 100_000
    let wn = ChannelPlan.make(iqRate: 2_400_000, mode: RxMode.wfm, fmBandwidthHz: narrow.fmBandwidthHz,
                              amBandwidthHz: c.amBandwidthHz, ssbBandwidthHz: c.ssbBandwidthHz)
    check("a narrower FM bandwidth keeps room for the 53 kHz stereo multiplex",
          wn.channelRate / 2 > ChannelPlan.mpxTopHz, "\(wn)")

    section("channel stage: as clean as the full IQ rate, at 2.4 MHz")
    let iqRate = 2_400_000.0
    let tone = { (t: Double) in sin(2 * Double.pi * 1000 * t) }
    let mpx = { (t: Double) -> Double in
        let lpr = sin(2 * Double.pi * 1000 * t) / 2
        return lpr + 0.08 * sin(2 * .pi * 19_000 * t) + lpr * sin(2 * .pi * 38_000 * t)
            + 0.04 * sin(2 * .pi * 57_000 * t)
    }
    struct Case { let name: String; let mode: Int; let hi: Double; let carriers: [TestCarrier] }
    let cases = [
        Case(name: "WFM", mode: RxMode.wfm, hi: 15_000, carriers: [TestCarrier(offset: 0, amp: 0.4, dev: 75_000, fm: mpx)]),
        Case(name: "NFM", mode: RxMode.nfm, hi: 15_000, carriers: [TestCarrier(offset: 0, amp: 0.4, dev: 2_500, fm: tone)]),
        Case(name: "AM", mode: RxMode.am, hi: 4_500, carriers: [TestCarrier(offset: 0, amp: 0.3, am: tone)]),
        Case(name: "USB", mode: 4, hi: 3_000, carriers: [TestCarrier(offset: 1_000, amp: 0.3)]),
        Case(name: "CW", mode: 5, hi: 3_000, carriers: [TestCarrier(offset: 300, amp: 0.3)]),
    ]
    for k in cases {
        // A second: CW's AGC attack is 30 per second, and a shorter run
        // measured it still climbing.
        let iq = channelIQ(rate: iqRate, seconds: 1.0, k.carriers, noise: 0.05)
        // The receiver: VFO, channel stage, detector, as in use.
        let lr = LocalRadio()
        lr.config = c
        lr.mode = k.mode
        StationMono.shared.set(freqHz: Double(lr.frequency), mono: false)
        let t0 = Date()
        var got = lr.demodulateForTesting(iq, iqRate: UInt32(iqRate))
        let spent = Date().timeIntervalSince(t0) / 1.0
        let gotRate = lr.audioRate
        // The reference: the same detector at the full IQ rate, nothing dropped.
        let d = Demods(), am = AMDemod()
        d.setWfmAudioBand(iqRate: iqRate)
        d.setWfmIfBandwidth(iqRate: iqRate, cutoffHz: c.fmBandwidthHz / 2)
        d.setDeemphasis(audioRate: iqRate, tau: c.deemphasisTau)
        d.setupSSB(iqRate: iqRate, audioRate: iqRate)
        d.setupCW(iqRate: iqRate)
        let lpf = c.fmLowPass ? 15_000 : iqRate * 0.45
        d.setAudioFilters(rate: iqRate, lowPassHz: lpf, highPassHz: c.fmHighPass ? 30 : 0)
        d.setStereoAudioFilters(rate: iqRate, lowPassHz: lpf, highPassHz: c.fmHighPass ? 30 : 0)
        am.setBandwidth(audioRate: iqRate, bandwidthHz: c.amBandwidthHz, iqRate: iqRate)
        am.configureSync(rate: iqRate)
        am.agcAttack = max(0, min(1, c.amAgcAttack / iqRate))
        am.agcDecay = max(0, min(1, c.amAgcDecay / iqRate))
        am.agcEnabled = c.amCarrierAgc
        am.syncEnabled = c.amSync
        var ref: [Float]
        switch k.mode {
        case RxMode.wfm: ref = d.processWFMStereo(int16IQ: iq, decimate: 1)
        case RxMode.nfm: ref = d.processFM(int16IQ: iq, decimate: 1)
        case 4: ref = d.processSSB(int16IQ: iq, decimate: 1, upperSideband: true, gain: OutputScale.ssb)
        case 5: ref = d.processCW(int16IQ: iq, decimate: 1)
        default: ref = am.process(int16IQ: iq, decimate: 1)
        }
        var sepGot = 0.0, sepRef = 0.0
        if k.mode == RxMode.wfm {
            func split(_ o: [Float]) -> ([Float], [Float]) {
                var l = [Float](), r = [Float]()
                for i in stride(from: 0, to: o.count - 1, by: 2) { l.append(o[i]); r.append(o[i + 1]) }
                return (l, r)
            }
            let (gl, gr) = split(got), (rl, rr) = split(ref)
            let gs = gl.count / 5, rs = rl.count / 5
            sepGot = 20 * log10(toneLevel(Array(gl[gs...]), hz: 1000, rate: gotRate)
                                / max(1e-30, toneLevel(Array(gr[gs...]), hz: 1000, rate: gotRate)))
            sepRef = 20 * log10(toneLevel(Array(rl[rs...]), hz: 1000, rate: iqRate)
                                / max(1e-30, toneLevel(Array(rr[rs...]), hz: 1000, rate: iqRate)))
            got = gl; ref = rl
        }
        let sGot = toneSinad(got, rate: gotRate, lo: 50, hi: k.hi)
        let sRef = toneSinad(ref, rate: iqRate, lo: 50, hi: k.hi)
        print(String(format: "  %@: %.0f kHz SINAD %.2f dB vs full rate %.2f dB%@   CPU %.3f s per s of IQ",
                     k.name, gotRate / 1000, sGot, sRef,
                     k.mode == RxMode.wfm ? String(format: ", separation %.1f vs %.1f dB", sepGot, sepRef) : "",
                     spent))
        check("\(k.name) through the channel stage is within 0.5 dB of the full rate",
              sGot >= sRef - 0.5, String(format: "%.2f vs %.2f", sGot, sRef))
        // Separation through the receiver (equaliser on) is printed; the
        // sections below check it with the equaliser in and out.
        // CPU is printed, not checked: this suite is built without -O.
    }

    section("channel stage: stereo separation, equaliser off")
    // The 38 kHz droop of the discriminator (Demods.lmrDroop) was the whole
    // difference: 39.9 dB at 343 kHz before it was undone, 60.8 after.
    let sepIQ = channelIQ(rate: iqRate, seconds: 1.0, [TestCarrier(offset: 0, amp: 0.4, dev: 75_000, fm: { t in
        let lpr = sin(2 * Double.pi * 1000 * t) / 2
        return lpr + 0.08 * sin(2 * .pi * 19_000 * t) + lpr * sin(2 * .pi * 38_000 * t)
    })], noise: 0)
    func separation(channel: Bool) -> Double {
        let p = channel ? plan(iqRate, RxMode.wfm)
            : ChannelPlan(decimation: 1, channelRate: iqRate, passHz: 0, protectHz: 0, audioDecimation: 1)
        let ch = Channelizer()
        ch.configure(inRate: iqRate, plan: p)
        let d = Demods()
        d.setWfmAudioBand(iqRate: p.channelRate)
        d.setWfmIfBandwidth(iqRate: p.channelRate, cutoffHz: c.fmBandwidthHz / 2)
        d.setDeemphasis(audioRate: p.audioRate, tau: c.deemphasisTau)
        d.setWfmEqualizer(false)
        let o = d.processWFMStereo(int16IQ: ch.process(sepIQ), decimate: p.audioDecimation)
        var l = [Float](), r = [Float]()
        for i in stride(from: 0, to: o.count - 1, by: 2) { l.append(o[i]); r.append(o[i + 1]) }
        let s = l.count / 3
        return 20 * log10(toneLevel(Array(l[s...]), hz: 1000, rate: p.audioRate)
                          / max(1e-30, toneLevel(Array(r[s...]), hz: 1000, rate: p.audioRate)))
    }
    let sepCh = separation(channel: true), sepFull = separation(channel: false)
    check("WFM through the channel stage keeps the full rate's separation",
          sepCh >= sepFull - 1 && sepCh > 55, String(format: "%.1f vs %.1f dB", sepCh, sepFull))

    section("multipath equaliser: costs a clean signal nothing, cleans an echo")
    // The composite and echo of test/wfmMultipath.test.ts: left-only tone,
    // Zenith-GE pilot and subcarrier, an 8.8 us echo at -10 dB.
    func eqRun(tone: Double, echo: Bool, eq: Bool) -> (leak: Double, band: Double) {
        let n = Int(iqRate * 1.5)
        var iI = [Double](repeating: 0, count: n), iQ = [Double](repeating: 0, count: n)
        var ph = 0.0
        for k in 0..<n {
            let t = Double(k) / iqRate
            let psi = 2 * Double.pi * 19_000 * t
            let L = sin(2 * Double.pi * tone * t)
            ph += 2 * Double.pi * 75_000 * (0.9 * (L / 2 + (L / 2) * sin(2 * psi)) + 0.1 * sin(psi)) / iqRate
            iI[k] = cos(ph); iQ[k] = sin(ph)
        }
        let delay = Int((8.8e-6 * iqRate).rounded()), g = echo ? 0.3 : 0
        let ec = cos(1.2) * g, es = sin(1.2) * g
        var iq = Data(count: n * 4)
        iq.withUnsafeMutableBytes { (raw: UnsafeMutableRawBufferPointer) in
            let p = raw.bindMemory(to: Int16.self)
            for k in 0..<n {
                var I = iI[k], Q = iQ[k]
                if k >= delay { I += iI[k - delay] * ec - iQ[k - delay] * es; Q += iI[k - delay] * es + iQ[k - delay] * ec }
                p[k * 2] = Int16((6000 * I).rounded()); p[k * 2 + 1] = Int16((6000 * Q).rounded())
            }
        }
        let p = plan(iqRate, RxMode.wfm)
        let ch = Channelizer(); ch.configure(inRate: iqRate, plan: p)
        let d = Demods()
        d.setWfmAudioBand(iqRate: p.channelRate)
        d.setWfmIfBandwidth(iqRate: p.channelRate, cutoffHz: c.fmBandwidthHz / 2)
        d.setDeemphasis(audioRate: p.audioRate, tau: 50e-6)
        d.setWfmEqualizer(eq)
        var out = [Float]()
        var o = 0
        while o < iq.count {   // in packets, so the state carries across calls
            out += d.processWFMStereo(int16IQ: ch.process(iq.subdata(in: o..<min(iq.count, o + 65_536))),
                                      decimate: p.audioDecimation)
            o += 65_536
        }
        var l = [Float](), r = [Float]()
        for i in stride(from: 0, to: out.count - 1, by: 2) { l.append(out[i]); r.append(out[i + 1]) }
        let s = Int(p.audioRate * 0.8)
        let L = Array(l[s...]), R = Array(r[s...])
        let lv = toneLevel(L, hz: tone, rate: p.audioRate)
        // Everything in the right channel up to 15 kHz is damage on a left-only signal.
        let rBand = bandRms(R, rate: p.audioRate, lo: 50, hi: 15_000)
        return (20 * log10(lv / max(1e-30, toneLevel(R, hz: tone, rate: p.audioRate))),
                20 * log10(lv * 0.7071 / max(1e-30, rBand)))
    }
    var lossSum = 0.0, worst = 0.0
    for tone in [400.0, 1000, 3000, 7000] {
        let off = eqRun(tone: tone, echo: false, eq: false), on = eqRun(tone: tone, echo: false, eq: true)
        let eOff = eqRun(tone: tone, echo: true, eq: false), eOn = eqRun(tone: tone, echo: true, eq: true)
        print(String(format: "  %4.0f Hz clean: separation %.1f off / %.1f on    echo: right-channel damage %.1f off / %.1f on dB below the tone",
                     tone, off.leak, on.leak, eOff.band, eOn.band))
        lossSum += off.leak - on.leak; worst = max(worst, off.leak - on.leak)
        check("the equaliser cleans a \(Int(tone)) Hz tone's echo by 15 dB or more", eOn.band >= eOff.band + 15,
              String(format: "%.1f vs %.1f", eOn.band, eOff.band))
    }
    // It sat after the IF filter until 2026-10-25 and cost 10.6 dB here on
    // average (Demods `wfmEq`). The worst tone, 3 kHz, still gives up 2.1 dB
    // of 64.
    check("on a clean signal it costs under 1 dB of separation on average, 2.5 at worst",
          lossSum / 4 < 1 && worst < 2.5, String(format: "mean %.2f, worst %.2f dB", lossSum / 4, worst))
}
