// === Claude origin ===
// Created/placed by Anthropic Claude Code at: 2026-10-25-030000
// Quality bench: the receiver measured the way it is used (LocalRadio, packet
// by packet, every IQ rate, neighbour / echo / weak / off-centre). Lists every
// rule that fails. Nothing here fixes anything.
// ====================
//
// Rules:
//   packets   any packet length gives what one call gives (SINAD within 0.5 dB)
//   rates     a case scores within 1.5 dB of its best IQ rate
//   floor     clean SINAD / separation at least the mode's floor
//   neighbour a neighbour costs at most 3 dB against the same case alone
//   offset    a station off the centre scores as one on it, within 1 dB
//   cpu       under 0.25 s of one core per second of IQ (-O, this machine)
import Foundation
import Accelerate

struct Carrier {
    var offset: Double, amp: Double, dev: Double = 0
    var fm: ((Double) -> Double)? = nil
    var am: ((Double) -> Double)? = nil
}

/// What a receiver hands over at `rate`: generated at 2.4 MHz or more and
/// decimated through a filter, the way the HF+ and the V4 do it themselves.
/// Sampling an FM signal straight at a low rate folds its tails back into the
/// band — a synthetic fault, worth 26 dB of stereo separation at 300 kHz.
func makeIQ(rate: Double, seconds: Double, _ cs: [Carrier], noise: Double,
            echo: (delay: Double, gain: Double, rot: Double)? = nil) -> Data {
    let k = max(1, Int((2_400_000 / rate).rounded(.up)))
    let raw = makeRawIQ(rate: rate * Double(k), seconds: seconds, cs, noise: noise * Double(k).squareRoot(), echo: echo)
    guard k > 1 else { return raw }
    let edge = rate * 0.42
    let plan = ChannelPlan(decimation: k, channelRate: rate, passHz: edge, protectHz: edge, audioDecimation: 1)
    let ch = Channelizer(); ch.configure(inRate: rate * Double(k), plan: plan)
    return ch.process(raw)
}

func makeRawIQ(rate: Double, seconds: Double, _ cs: [Carrier], noise: Double,
               echo: (delay: Double, gain: Double, rot: Double)? = nil) -> Data {
    let n = Int(rate * seconds)
    var I = [Double](repeating: 0, count: n), Q = [Double](repeating: 0, count: n)
    var ph = [Double](repeating: 0, count: cs.count)
    for k in 0..<n {
        let t = Double(k) / rate
        for (j, c) in cs.enumerated() {
            ph[j] += 2 * Double.pi * (c.offset + c.dev * (c.fm?(t) ?? 0)) / rate
            let a = c.amp * (1 + 0.6 * (c.am?(t) ?? 0))
            I[k] += a * cos(ph[j]); Q[k] += a * sin(ph[j])
        }
    }
    if let e = echo {
        let dl = Int((e.delay * rate).rounded())
        let c = cos(e.rot) * e.gain, s = sin(e.rot) * e.gain
        let i0 = I, q0 = Q
        for k in dl..<n {
            I[k] += i0[k - dl] * c - q0[k - dl] * s
            Q[k] += i0[k - dl] * s + q0[k - dl] * c
        }
    }
    var seed: UInt64 = 0x5150
    func gauss() -> Double {
        seed = seed &* 6364136223846793005 &+ 1442695040888963407
        let u1 = max(1e-12, Double(seed >> 11) / Double(1 << 53))
        seed = seed &* 6364136223846793005 &+ 1442695040888963407
        let u2 = Double(seed >> 11) / Double(1 << 53)
        return (-2 * log(u1)).squareRoot() * cos(2 * Double.pi * u2)
    }
    var d = Data(count: n * 4)
    d.withUnsafeMutableBytes { (raw: UnsafeMutableRawBufferPointer) in
        let p = raw.bindMemory(to: Int16.self)
        for k in 0..<n {
            func s(_ v: Double) -> Int16 { Int16(max(-32767, min(32767, (v * 32767).rounded()))) }
            p[k * 2] = s(I[k] + noise * gauss()).littleEndian
            p[k * 2 + 1] = s(Q[k] + noise * gauss()).littleEndian
        }
    }
    return d
}

/// Noise per I/Q component for a carrier-to-noise ratio measured in `bw`.
func noiseFor(cnrDb: Double, amp: Double, bw: Double, rate: Double) -> Double {
    let noiseInBw = amp * amp / pow(10, cnrDb / 10)
    return (noiseInBw * rate / bw / 2).squareRoot()
}

/// Amplitude of the `hz` tone in `x`, least squares (fitTone).
func toneLevel(_ x: [Float], hz: Double, rate: Double) -> Double {
    let (_, c, s) = fitTone(x.map(Double.init), rate: rate, tone: hz)
    return (c * c + s * s).squareRoot()
}

/// Least-squares DC + tone. Projecting onto cos and sin alone is exact only
/// over a whole number of cycles; otherwise it leaves the tone's own residue
/// at -68 dB and a measurement of the code reads like a fault in it.
func fitTone(_ v: [Double], rate: Double, tone: Double) -> (Double, Double, Double) {
    var a = [[Double]](repeating: [0, 0, 0], count: 3), b = [0.0, 0.0, 0.0]
    for i in 0..<v.count {
        let t = 2 * Double.pi * tone * Double(i) / rate
        let f = [1, cos(t), sin(t)]
        for r in 0..<3 { b[r] += f[r] * v[i]; for c in 0..<3 { a[r][c] += f[r] * f[c] } }
    }
    for p in 0..<3 {   // Gaussian elimination, 3 x 3
        for r in (p + 1)..<3 {
            let m = a[r][p] / a[p][p]
            for c in p..<3 { a[r][c] -= m * a[p][c] }
            b[r] -= m * b[p]
        }
    }
    var x = [0.0, 0.0, 0.0]
    for r in stride(from: 2, through: 0, by: -1) {
        var s = b[r]
        for c in (r + 1)..<3 { s -= a[r][c] * x[c] }
        x[r] = s / a[r][r]
    }
    return (x[0], x[1], x[2])
}

func sinad(_ x: [Float], rate: Double, tone: Double, lo: Double, hi: Double) -> Double {
    var n = 1; while n * 2 <= x.count / 2 { n *= 2 }
    guard n >= 1024 else { return -999 }
    let raw = x[(x.count - n)...].map(Double.init)
    let (mean, c, s) = fitTone(raw, rate: rate, tone: tone)
    var seg = (0..<n).map { i -> Float in
        let t = 2 * Double.pi * tone * Double(i) / rate
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
    var band = 0.0, all = 0.0
    for k in 1..<(n / 2) {
        all += Double(mag[k])
        let f = Double(k) * rate / Double(n)
        if f >= lo, f <= hi { band += Double(mag[k]) }
    }
    let rest = all > 0 ? Double(ms) * band / all : 0
    return 10 * log10(((c * c + s * s) / 2) / max(rest, 1e-30))
}

let NFM = 0, WFM = 1, AM = 2, USB = 4, CW = 5

struct Score { var sinad: Double; var sep: Double?; var cpu: Double; var rate: Double }

/// Packet lengths: nil = one call; > 0 = fixed; < 0 = rtl_tcp-like, varying.
func runRadio(mode: Int, stereo: Bool, iq: Data, iqRate: Double, packet: Int?,
              offset: Double = 0, tone: Double, band: (Double, Double)) -> Score {
    let lr = LocalRadio()
    var c = RadioConfig()
    c.mode = mode
    lr.config = c
    lr.mode = mode
    StationMono.shared.set(freqHz: Double(lr.frequency), mono: !stereo)
    var packets = [Data]()
    if let packet {
        var o = 0
        var seed: UInt32 = 7
        while o < iq.count {
            var len = packet
            if packet < 0 { seed = seed &* 1664525 &+ 1013904223; len = 512 + Int(seed % 32_000) }
            let e = min(iq.count, o + len * 4)
            packets.append(iq.subdata(in: o..<e)); o = e
        }
    } else { packets = [iq] }
    let t0 = Date()
    let out = lr.demodulatePacketsForTesting(packets, iqRate: UInt32(iqRate), vfoOffsetHz: offset, equaliser: ProcessInfo.processInfo.environment["QUALITY_EQ"] != "0")
    let cpu = Date().timeIntervalSince(t0) / (Double(iq.count / 4) / iqRate)
    let ar = lr.audioRate
    if mode == WFM {
        var l = [Float](), r = [Float]()
        for i in stride(from: 0, to: out.count - 1, by: 2) { l.append(out[i]); r.append(out[i + 1]) }
        let s = l.count / 3
        let sep = stereo ? 20 * log10(toneLevel(Array(l[s...]), hz: tone, rate: ar)
                                      / max(1e-30, toneLevel(Array(r[s...]), hz: tone, rate: ar))) : nil
        return Score(sinad: sinad(l, rate: ar, tone: tone, lo: band.0, hi: band.1), sep: sep, cpu: cpu, rate: ar)
    }
    return Score(sinad: sinad(out, rate: ar, tone: tone, lo: band.0, hi: band.1), sep: nil, cpu: cpu, rate: ar)
}

struct ModeCase {
    let name: String, mode: Int, stereo: Bool, tone: Double, band: (Double, Double)
    let bw: Double
    let floor: Double
    let sepFloor: Double?
    let wanted: (Double) -> Carrier
    let neighbourOffset: Double
}
let left = { (t: Double) -> Double in
    let psi = 2 * Double.pi * 19_000 * t
    let L = sin(2 * Double.pi * 1000 * t)
    return 0.9 * (L / 2 + (L / 2) * sin(2 * psi)) + 0.1 * sin(psi)
}
let modes: [ModeCase] = [
    ModeCase(name: "WFM stereo", mode: WFM, stereo: true, tone: 1000, band: (50, 15_000), bw: 200_000,
             floor: 45, sepFloor: 45, wanted: { Carrier(offset: 0, amp: $0, dev: 75_000, fm: left) }, neighbourOffset: 300_000),
    ModeCase(name: "WFM mono", mode: WFM, stereo: false, tone: 1000, band: (50, 15_000), bw: 200_000,
             floor: 50, sepFloor: nil, wanted: { Carrier(offset: 0, amp: $0, dev: 75_000, fm: { sin(2 * Double.pi * 1000 * $0) / 2 }) }, neighbourOffset: 300_000),
    ModeCase(name: "NFM", mode: NFM, stereo: false, tone: 1000, band: (50, 3_000), bw: 12_500,
             floor: 40, sepFloor: nil, wanted: { Carrier(offset: 0, amp: $0, dev: 2_500, fm: { sin(2 * Double.pi * 1000 * $0) }) }, neighbourOffset: 25_000),
    ModeCase(name: "AM", mode: AM, stereo: false, tone: 1000, band: (50, 4_500), bw: 9_000,
             floor: 40, sepFloor: nil, wanted: { Carrier(offset: 0, amp: $0, am: { sin(2 * Double.pi * 1000 * $0) }) }, neighbourOffset: 9_000),
    ModeCase(name: "USB", mode: USB, stereo: false, tone: 1000, band: (300, 2_700), bw: 2_400,
             floor: 40, sepFloor: nil, wanted: { Carrier(offset: 1_000, amp: $0) }, neighbourOffset: 5_000),
    ModeCase(name: "CW", mode: CW, stereo: false, tone: 1000, band: (300, 2_700), bw: 500,
             floor: 40, sepFloor: nil, wanted: { Carrier(offset: 300, amp: $0) }, neighbourOffset: 3_000),
]
let rates: [(Double, String)] = [(912_000, "HF+ 912k"), (456_000, "HF+ 456k"), (228_000, "HF+ 228k"),
                                 (3_200_000, "V4 3.2M"), (2_400_000, "V4 2.4M"), (1_024_000, "V4 1.024M"),
                                 (300_000, "V4 300k")]
let only = ProcessInfo.processInfo.environment["QUALITY_ONLY"]
let onlyRate = ProcessInfo.processInfo.environment["QUALITY_RATE"]
let seconds = 1.0
var failures = [String]()
func fail(_ s: String) { failures.append(s); print("  FAIL \(s)") }
func f1(_ v: Double) -> String { String(format: "%6.1f", v) }

for m in modes where only == nil || m.name == only {
    print("\n== \(m.name) ==")
    print("  rate        audio   clean  (sep)   packets  rtl-like  weak    neighbour  offset   echo     cpu")
    var cleanByRate = [(String, Double, Double?)]()
    for (rate, label) in rates where onlyRate == nil || label == onlyRate {
        let amp = 0.3
        let clean = makeIQ(rate: rate, seconds: seconds, [m.wanted(amp)],
                           noise: noiseFor(cnrDb: 50, amp: amp, bw: m.bw, rate: rate))
        let one = runRadio(mode: m.mode, stereo: m.stereo, iq: clean, iqRate: rate, packet: nil, tone: m.tone, band: m.band)
        let fixed = runRadio(mode: m.mode, stereo: m.stereo, iq: clean, iqRate: rate, packet: 16_384, tone: m.tone, band: m.band)
        let rtl = runRadio(mode: m.mode, stereo: m.stereo, iq: clean, iqRate: rate, packet: -1, tone: m.tone, band: m.band)
        let weakIQ = makeIQ(rate: rate, seconds: seconds, [m.wanted(amp)],
                            noise: noiseFor(cnrDb: 20, amp: amp, bw: m.bw, rate: rate))
        let weak = runRadio(mode: m.mode, stereo: m.stereo, iq: weakIQ, iqRate: rate, packet: 16_384, tone: m.tone, band: m.band)
        var nb: Score? = nil
        if m.neighbourOffset < rate / 2 * 0.9 {
            var other = m.wanted(amp); other.offset += m.neighbourOffset
            if m.mode == WFM || m.mode == NFM { other.fm = { sin(2 * Double.pi * 2700 * $0) } }
            if m.mode == AM { other.am = { sin(2 * Double.pi * 2700 * $0) } }
            let iq = makeIQ(rate: rate, seconds: seconds, [m.wanted(amp), other],
                            noise: noiseFor(cnrDb: 50, amp: amp, bw: m.bw, rate: rate))
            nb = runRadio(mode: m.mode, stereo: m.stereo, iq: iq, iqRate: rate, packet: 16_384, tone: m.tone, band: m.band)
        }
        // As far off the centre as the receiver itself would leave a station
        // (LocalRadio.maxVfoOffsetHz), a quarter of the IQ at most.
        let off = min(rate / 4, max(0, rate * 0.42 - RadioConfig().bandwidth(for: m.mode) / 2))
        var shifted = m.wanted(amp); shifted.offset += off
        let offIQ = makeIQ(rate: rate, seconds: seconds, [shifted],
                           noise: noiseFor(cnrDb: 50, amp: amp, bw: m.bw, rate: rate))
        let offR = runRadio(mode: m.mode, stereo: m.stereo, iq: offIQ, iqRate: rate, packet: 16_384,
                            offset: off, tone: m.tone, band: m.band)
        var echoText = "   -   "
        if m.mode == WFM {
            let eIQ = makeIQ(rate: rate, seconds: seconds, [m.wanted(amp)],
                             noise: noiseFor(cnrDb: 50, amp: amp, bw: m.bw, rate: rate), echo: (8.8e-6, 0.3, 1.2))
            let e = runRadio(mode: m.mode, stereo: m.stereo, iq: eIQ, iqRate: rate, packet: 16_384, tone: m.tone, band: m.band)
            echoText = f1(e.sinad) + (e.sep.map { String(format: "(%4.1f)", $0) } ?? "")
        }
        print("  \(label.padding(toLength: 10, withPad: " ", startingAt: 0)) \(String(format: "%5.0fk", one.rate / 1000)) \(f1(one.sinad)) \(one.sep.map { String(format: "(%4.1f)", $0) } ?? "      ") \(f1(fixed.sinad))   \(f1(rtl.sinad))  \(f1(weak.sinad))  \(nb.map { f1($0.sinad) } ?? "    - ")     \(f1(offR.sinad))  \(echoText)  \(String(format: "%.3f", fixed.cpu))")
        fflush(stdout)

        let tag = "\(m.name) @ \(label)"
        // An IQ narrower than the mode's channel cannot carry it: broadcast
        // stereo needs the whole FM signal (ChannelPlan's WFM rate, 352.5 kHz
        // at the 250 kHz IF), and 228 or 300 kHz is physically short of it.
        // Reported as a limit, not judged.
        let need = ChannelPlan.make(iqRate: 1e9, mode: m.mode, fmBandwidthHz: RadioConfig().bandwidth(for: m.mode),
                                    amBandwidthHz: 9_000, ssbBandwidthHz: 2_400).channelRate
        if m.stereo, rate < need {
            print("    (limit: \(label) is narrower than the \(Int(need / 1000)) kHz channel stereo needs)")
            continue
        }
        if abs(fixed.sinad - one.sinad) > 0.5 || abs(rtl.sinad - one.sinad) > 0.5 {
            fail("\(tag): packets change SINAD (one call \(f1(one.sinad)), 16384 \(f1(fixed.sinad)), rtl-like \(f1(rtl.sinad)))")
        }
        if one.sinad < m.floor { fail("\(tag): clean SINAD \(f1(one.sinad)) under the floor \(m.floor)") }
        if let f = m.sepFloor, let s = one.sep, s < f { fail("\(tag): stereo separation \(f1(s)) under \(f)") }
        if let nb, nb.sinad < fixed.sinad - 3 { fail("\(tag): a neighbour at +\(Int(m.neighbourOffset / 1000)) kHz costs \(f1(fixed.sinad - nb.sinad)) dB") }
        if abs(offR.sinad - fixed.sinad) > 1 { fail("\(tag): off the centre \(f1(offR.sinad)) vs \(f1(fixed.sinad)) on it") }
        if fixed.cpu > 0.25 { fail("\(tag): CPU \(String(format: "%.3f", fixed.cpu)) s per s of IQ") }
        cleanByRate.append((label, one.sinad, one.sep))
    }
    let best = cleanByRate.map { $0.1 }.max() ?? 0
    let bestSep = cleanByRate.compactMap { $0.2 }.max()
    for (label, s, sep) in cleanByRate {
        if s < best - 1.5 { fail("\(m.name) @ \(label): clean SINAD \(f1(s)), \(f1(best - s)) dB under the best rate") }
        if let sep, let bestSep, sep < bestSep - 1.5 { fail("\(m.name) @ \(label): separation \(f1(sep)), \(f1(bestSep - sep)) dB under the best rate") }
    }
}

print("\n==== \(failures.count) rule(s) failed ====")
for f in failures { print("  - \(f)") }
exit(failures.isEmpty ? 0 : 1)
