import AVFoundation
import Foundation

// Test runner for the standalone receiver.
//
// Deliberately not XCTest: the app is built with a bare `swiftc` invocation and
// nothing else, and a test target that needs a different toolchain than the
// thing it tests is a second build to keep working.
//
// What belongs here is behaviour that is cheap to get wrong and silent when it
// is. The mode-index mapping is the case in point — SDR++ assigns those numbers,
// every preset carries one, and getting them wrong demodulates FM as narrow FM
// with no error anywhere. It cost a round of deploying to two machines and
// listening. One assertion would have caught it before the first build.

var failures = 0
var checks = 0

func check(_ name: String, _ cond: @autoclosure () -> Bool, _ detail: @autoclosure () -> String = "") {
    checks += 1
    if cond() {
        print("  ok   \(name)")
    } else {
        failures += 1
        let d = detail()
        print("  FAIL \(name)\(d.isEmpty ? "" : "  — \(d)")")
    }
}

func near(_ a: Double, _ b: Double, _ tol: Double) -> Bool { abs(a - b) <= tol }

func section(_ s: String) { print("\n== \(s) ==") }

// MARK: synthetic signals

/// Interleaved int16 LE IQ. `mpx` is evaluated per sample and frequency-
/// modulates the carrier; `amAmp` amplitude-modulates it instead when given.
func makeIQ(rate: Double, count: Int,
            carrierOffsetHz: Double = 0,
            deviationHz: Double = 0,
            amplitude: Double = 0.4,
            noise: Double = 0.002,
            mpx: ((Double) -> Double)? = nil,
            am: ((Double) -> Double)? = nil) -> Data {
    var d = Data(capacity: count * 4)
    var seed: UInt64 = 0x5150
    func rnd() -> Double {
        seed = seed &* 6364136223846793005 &+ 1442695040888963407
        return Double(Int64(bitPattern: seed >> 11)) / Double(1 << 53) - 0.5
    }
    var phase = 0.0
    for i in 0..<count {
        let t = Double(i) / rate
        var I: Double, Q: Double
        if let am {
            let a = amplitude * (1 + 0.6 * am(t))
            let ph = 2 * Double.pi * carrierOffsetHz * t
            I = a * cos(ph); Q = a * sin(ph)
        } else {
            let m = mpx?(t) ?? 0
            phase += 2 * Double.pi * (carrierOffsetHz + deviationHz * m) / rate
            I = amplitude * cos(phase); Q = amplitude * sin(phase)
        }
        I += noise * rnd(); Q += noise * rnd()
        func s(_ v: Double) -> Int16 { Int16(max(-32768, min(32767, (v * 32767).rounded()))) }
        withUnsafeBytes(of: s(I).littleEndian) { d.append(contentsOf: $0) }
        withUnsafeBytes(of: s(Q).littleEndian) { d.append(contentsOf: $0) }
    }
    return d
}

func rms(_ a: [Float]) -> Double {
    a.isEmpty ? 0 : (a.reduce(0.0) { $0 + Double($1) * Double($1) } / Double(a.count)).squareRoot()
}

// MARK: mode indices

// The numbering is SDR++'s and travels inside every preset. Named here so a
// test reads as intent rather than as a magic number.
let NFM = 0, WFM = 1, AM = 2, DSB = 3, USB = 4, CW = 5, LSB = 6, RAW = 7

section("the readout groups in threes, read as kHz")
// The digits are dotted in threes and the unit label says kHz, so the last
// group is the fraction of a kilohertz: 000.954.000 is 954.000 kHz. Labelling
// the same digits Hz made that group read as a fraction of the wrong unit.
// The decades below are in Hz regardless — the unit is a label, and the tuning
// arithmetic underneath it never changes.
do {
    let (t, w) = FreqView.render(954_000)
    check("954 kHz groups as 000.954.000", t == "000.954.000", t)
    check("the unit label is kHz", FreqView.unit == "kHz", FreqView.unit)
    check("one weight per character", w.count == t.count, "\(w.count) vs \(t.count)")
    check("separators carry no decade", w[3] == 0 && w[7] == 0, "\(w[3]), \(w[7])")
    check("first digit is the 100 MHz decade", w[0] == 100_000_000, "\(w[0])")
    check("last digit is the 1 Hz decade", w.last == 1, "\(w.last ?? -1)")
    check("1134 kHz groups as 001.134.000", FreqView.render(1_134_000).0 == "001.134.000",
          FreqView.render(1_134_000).0)
    check("the top of the range still fits", FreqView.render(999_999_999).0 == "999.999.999",
          FreqView.render(999_999_999).0)
    check("zero reads as all zeros", FreqView.render(0).0 == "000.000.000", FreqView.render(0).0)
}

// The leading zeros are dropped from the layout, not dimmed, so the frequency
// starts at the readout's left edge under the station name.
do {
    check("954 kHz starts at the 100 kHz digit",
          FreqView.significantStart("000.954.000") == 4, "\(FreqView.significantStart("000.954.000"))")
    check("9740 kHz keeps one more digit",
          FreqView.significantStart("009.740.000") == 2, "\(FreqView.significantStart("009.740.000"))")
    check("100 MHz drops nothing",
          FreqView.significantStart("100.000.000") == 0, "\(FreqView.significantStart("100.000.000"))")
    check("a separator alone is never the start",
          FreqView.significantStart("000.000.001") == 10, "\(FreqView.significantStart("000.000.001"))")
    check("all zeros keep the last digit",
          FreqView.significantStart("000.000.000") == 10, "\(FreqView.significantStart("000.000.000"))")
    check("the placeholder survives", FreqView.significantStart("—") == 0,
          "\(FreqView.significantStart("—"))")
}

section("the preset list groups by band")
// Coarse on purpose: metre-band grouping fragments a real store into almost as
// many headings as entries, because half of what is worth listening to on HF
// sits between the broadcast bands.
check("medium wave", Receiver.bandName(ofHz: 594_000) == "MW")
check("the top of the JP MW band", Receiver.bandName(ofHz: 1_602_000) == "MW")
check("160 m is already short wave", Receiver.bandName(ofHz: 1_800_000) == "SW")
check("49 m", Receiver.bandName(ofHz: 6_055_000) == "SW")
check("between the bands is still short wave", Receiver.bandName(ofHz: 9_975_000) == "SW")
check("the top of HF", Receiver.bandName(ofHz: 29_999_999) == "SW")
check("30 MHz is FM's group", Receiver.bandName(ofHz: 30_000_000) == "FM")
check("FM broadcast", Receiver.bandName(ofHz: 80_000_000) == "FM")
check("above the FM band", Receiver.bandName(ofHz: 145_000_000) == "VHF")

section("mode indices agree with SDR++ and the plugin")
check("MODE_NAMES order", MODE_NAMES == ["NFM", "WFM", "AM", "DSB", "USB", "CW", "LSB", "RAW"],
      "got \(MODE_NAMES)")
check("modeName(1) is WFM", modeName(WFM) == "WFM")

section("per-mode makeup is keyed by the same indices")
// Values from src/audioLeveling.ts MODE_MAKEUP. WFM louder than NFM is the
// tell: swapping the two indices swaps these and nothing else complains.
check("NFM makeup 5", AudioLeveling.modeMakeup[NFM] == 5, "\(AudioLeveling.modeMakeup[NFM] ?? -1)")
check("WFM makeup 10", AudioLeveling.modeMakeup[WFM] == 10, "\(AudioLeveling.modeMakeup[WFM] ?? -1)")
check("AM makeup 1.5", AudioLeveling.modeMakeup[AM] == 1.5)
check("CW below unity", (AudioLeveling.modeMakeup[CW] ?? 9) < 1)
check("LSB and USB match", AudioLeveling.modeMakeup[LSB] == AudioLeveling.modeMakeup[USB])

section("bandwidth follows the FM family")
var cfg = RadioConfig()
cfg.fmBandwidthHz = 150_000
cfg.amBandwidthHz = 9_000
check("NFM uses FM bandwidth", cfg.bandwidth(for: NFM) == 150_000)
check("WFM uses FM bandwidth", cfg.bandwidth(for: WFM) == 150_000)
check("DSB uses FM bandwidth", cfg.bandwidth(for: DSB) == 150_000)
check("AM uses AM bandwidth", cfg.bandwidth(for: AM) == 9_000)
check("USB uses AM bandwidth", cfg.bandwidth(for: USB) == 9_000)

section("IF noise reduction is FM-only, with the right bin count")
// SDR++ restricts FMIF to the FM demodulators; 32 bins for broadcast, 16 for
// narrow. Feeding a signal through and seeing whether it changes is the only
// way to observe `active` from outside.
let nrRate = 456_000.0
let nrIQ = makeIQ(rate: nrRate, count: 4096, carrierOffsetHz: -30_000,
                  deviationHz: 5_000, mpx: { sin(2 * .pi * 1000 * $0) })
for (m, name, shouldFilter) in [(NFM, "NFM", true), (WFM, "WFM", true),
                                (AM, "AM", false), (USB, "USB", false), (CW, "CW", false)] {
    let nr = IqNr()
    nr.setMode(m)
    let out = nr.process(nrIQ)
    let changed = out != nrIQ
    check("NR \(shouldFilter ? "runs" : "bypasses") for \(name)", changed == shouldFilter)
}
// Bin count is the other half of setMode and active/bypass cannot see it.
// 32 bins for broadcast against 16 for narrow is a different filter, so the
// same input must come out different — swapping the two indices is otherwise
// silent.
let nrW = IqNr(); nrW.setMode(WFM)
let nrN = IqNr(); nrN.setMode(NFM)
check("WFM and NFM use different bin counts", nrW.process(nrIQ) != nrN.process(nrIQ))
// "Different" passes just as happily when the two are swapped, which is the
// bug. Pin the actual sizes: SDR++'s broadcast preset is 32 taps and its voice
// preset 15, rounded to 16 for a power-of-two transform.
check("WFM selects 32 bins", nrW.bins == 32, "\(nrW.bins)")
check("NFM selects 16 bins", nrN.bins == 16, "\(nrN.bins)")

section("demod routing sends each mode to the right detector")
// A signal that is unambiguously wideband FM: 50 kHz deviation. Narrow FM will
// produce something, but wide FM produces far more of it. Routing WFM into the
// narrow path — the bug this catches — leaves the output an order of magnitude
// down, so the check is a level ratio rather than an exact match.
let rate = 456_000.0
let wideIQ = makeIQ(rate: rate, count: 45_600, deviationHz: 75_000,
                    mpx: { sin(2 * .pi * 440 * $0) })
// The plugin's own config: audioDecimate 4 over a 456 kHz IQ rate = 114 kHz.
let audioDec = 4
let audioRate = rate / Double(audioDec)

/// Filter settings must match whatever the caller's config yields, or a
/// comparison against LocalRadio measures the settings rather than the routing.
func demodOutput(mode: Int, iq: Data,
                 ifCutoff: Double = 75_000, tau: Double = 75e-6) -> [Float] {
    let dec = audioDec
    let aRate = audioRate
    let d = Demods()
    d.setWfmAudioBand(iqRate: rate)
    d.setWfmIfBandwidth(iqRate: rate, cutoffHz: ifCutoff)
    d.setDeemphasis(audioRate: aRate, tau: tau)
    d.setupSSB(iqRate: rate, audioRate: aRate)
    d.setupCW(iqRate: rate)
    switch mode {
    case NFM: return d.processFM(int16IQ: iq, decimate: dec)
    case WFM: return d.processWFM(int16IQ: iq, decimate: dec)
    case USB: return d.processSSB(int16IQ: iq, decimate: dec, upperSideband: true)
    case LSB: return d.processSSB(int16IQ: iq, decimate: dec, upperSideband: false)
    case CW:  return d.processCW(int16IQ: iq, decimate: dec)
    default:  return []
    }
}
let wfmOut = demodOutput(mode: WFM, iq: wideIQ)
let nfmOut = demodOutput(mode: NFM, iq: wideIQ)
check("WFM produces audio", rms(wfmOut) > 0.001, "rms \(rms(wfmOut))")
check("NFM produces audio", rms(nfmOut) > 0.001, "rms \(rms(nfmOut))")
check("WFM and NFM are not the same path",
      abs(rms(wfmOut) - rms(nfmOut)) / max(rms(wfmOut), rms(nfmOut)) > 0.2,
      "wfm \(rms(wfmOut)) nfm \(rms(nfmOut))")

section("LocalRadio routes each mode index to the right demodulator")
// The routing that was wrong. Comparing LocalRadio's output against the
// demodulator called directly is what pins index to detector — the level
// checks above prove the detectors work, not that the right one is picked.
var lrCfg = RadioConfig()
lrCfg.fmStereo = false            // mono, so the comparison is one channel
lrCfg.audioDecimate = 4
for (m, name) in [(NFM, "NFM"), (WFM, "WFM"), (USB, "USB"), (LSB, "LSB"), (CW, "CW")] {
    // A fresh receiver per mode: filter state carries across a mode change in
    // real use too, but a test that depends on the order it ran in is a test
    // that will lie eventually.
    let lr = LocalRadio()
    lr.config = lrCfg
    lr.mode = m
    let viaRadio = lr.demodulateForTesting(wideIQ, iqRate: UInt32(rate))
    let direct = demodOutput(mode: m, iq: wideIQ,
                             ifCutoff: lrCfg.fmBandwidthHz / 2, tau: lrCfg.deemphasisTau)
    let n = min(viaRadio.count, direct.count)
    let same = n > 0 && zip(viaRadio.prefix(n), direct.prefix(n)).allSatisfy { abs($0 - $1) < 1e-6 }
    check("mode \(m) routes to \(name)", same,
          "radio rms \(rms(viaRadio)) vs \(name) rms \(rms(direct))")
}

section("FM audio comes back at the frequency it went in at")
// The bug this catches: FM ran at the AM audio rate (9.5 kHz) while its
// anti-alias filter sat at 15 kHz, so everything above 4.75 kHz folded back
// down. A 6 kHz tone — where a sibilant keeps its energy — came out at
// 3.5 kHz, and speech sounded like it had a lisp.
//
// Goertzel rather than an FFT: two frequencies are all this asks about.
func tonePower(_ x: [Float], rate: Double, hz: Double) -> Double {
    guard rate > 0, !x.isEmpty else { return 0 }
    let k = 2 * cos(2 * Double.pi * hz / rate)
    var s1 = 0.0, s2 = 0.0
    for v in x {
        let s0 = Double(v) + k * s1 - s2
        s2 = s1; s1 = s0
    }
    return abs(s1 * s1 + s2 * s2 - k * s1 * s2)
}

let toneHz = 6_000.0
let toneIQ = makeIQ(rate: rate, count: 91_200, deviationHz: 20_000, noise: 0,
                    mpx: { sin(2 * .pi * toneHz * $0) })
var toneCfg = RadioConfig()
toneCfg.fmStereo = false
toneCfg.audioDecimate = 4
let toneRadio = LocalRadio()
toneRadio.config = toneCfg
toneRadio.mode = WFM
// The head carries the IF filter and the de-emphasis settling into the answer.
// Kept short enough that the old, lower rate still leaves samples to measure —
// a regression has to fail on the tone being in the wrong place, not on an
// empty array.
let toneOut = Array(toneRadio.demodulateForTesting(toneIQ, iqRate: UInt32(rate)).dropFirst(800))
let toneRate = toneRadio.audioRate
check("the audio rate leaves Nyquist above the 15 kHz anti-alias filter",
      toneRate / 2 > 15_000, "audio rate \(toneRate)")
check("the decimation is the plugin's, with no extra factor",
      toneRadio.audioDecimate == toneCfg.audioDecimate,
      "\(toneRadio.audioDecimate) vs \(toneCfg.audioDecimate)")
let atTone = tonePower(toneOut, rate: toneRate, hz: toneHz)
let atMirror = tonePower(toneOut, rate: toneRate, hz: 3_500)
check("a 6 kHz tone is at 6 kHz, not folded to 3.5 kHz", atTone > atMirror * 10,
      "6 kHz \(atTone) vs 3.5 kHz \(atMirror)")

section("AM detects an amplitude-modulated carrier")
let amIQ = makeIQ(rate: rate, count: 45_600, carrierOffsetHz: 2_000,
                  amplitude: 0.3, am: { sin(2 * .pi * 1000 * $0) })
let amDemod = AMDemod()
amDemod.setBandwidth(audioRate: audioRate, bandwidthHz: 9_000, iqRate: rate)
let amOut = amDemod.process(int16IQ: amIQ, decimate: audioDec, gainScale: 0.5)
check("AM produces audio", rms(amOut) > 0.01, "rms \(rms(amOut))")

section("FM stereo locks on a real pilot")
// 19 kHz pilot plus an L-R subcarrier at 38 kHz, which is what a stereo
// broadcast is. This is the test the live check could not settle: on air the
// station might simply be mono.
let L = { (t: Double) in sin(2 * .pi * 440 * t) }
let R = { (t: Double) in sin(2 * .pi * 880 * t) }
let stereoIQ = makeIQ(rate: rate, count: 456_000, deviationHz: 75_000, mpx: { t in
    let lpr = (L(t) + R(t)) / 2, lmr = (L(t) - R(t)) / 2
    return lpr + 0.08 * sin(2 * .pi * 19_000 * t) + lmr * sin(2 * .pi * 38_000 * t)
})
let st = Demods()
st.setWfmAudioBand(iqRate: rate)
st.setWfmIfBandwidth(iqRate: rate, cutoffHz: 80_000)
st.setDeemphasis(audioRate: audioRate, tau: 50e-6)
let stOut = st.processWFMStereo(int16IQ: stereoIQ, decimate: audioDec)
check("stereo output is interleaved", stOut.count % 2 == 0 && !stOut.isEmpty)
check("pilot locks", st.stereoLocked, "pilot never reached the badge threshold")
// L and R carry different tones, so a true stereo decode has them differ.
var l = [Float](), r = [Float]()
for i in stride(from: 0, to: stOut.count - 1, by: 2) { l.append(stOut[i]); r.append(stOut[i + 1]) }
let diff = zip(l, r).map { abs($0 - $1) }.reduce(0, +) / Float(max(1, l.count))
check("L and R differ", diff > 1e-4, "mean |L-R| = \(diff)")

// How MUCH they differ, which "they differ" does not ask. A tone in one
// channel only: whatever appears in the other is crosstalk, and the ratio is
// the separation figure a receiver is judged on. This is the check that would
// have caught the 38 kHz reference being built from the phase the PLL had
// already advanced: the decode still looked stereo by every test above while
// L-R arrived scaled by cos 30 degrees, which is 23 dB — technically stereo,
// and not what anyone would call a stereo image. Flat across audio frequency,
// which is the signature of a matrix gain error rather than a filter.
func toneAmplitude(_ x: [Float], hz: Double, rate: Double) -> Double {
    var re = 0.0, im = 0.0
    for (i, v) in x.enumerated() {
        let t = 2 * .pi * hz * Double(i) / rate
        re += Double(v) * cos(t); im += Double(v) * sin(t)
    }
    let n = Double(max(1, x.count))
    return ((re * re + im * im) / (n * n)).squareRoot()
}
for toneHz in [100.0, 1000.0, 5000.0] {
    let sepIQ = makeIQ(rate: rate, count: 456_000, deviationHz: 75_000, mpx: { t in
        // Left only: L-R and L+R carry the same tone at the same level, so a
        // reference that is off in phase or gain lands audibly in the right.
        let lpr = sin(2 * .pi * toneHz * t) / 2, lmr = lpr
        return lpr + 0.08 * sin(2 * .pi * 19_000 * t) + lmr * sin(2 * .pi * 38_000 * t)
    })
    let sd = Demods()
    sd.setWfmAudioBand(iqRate: rate)
    // 200 kHz channel. At the real 75 kHz deviation a 150 kHz channel cannot
    // reach 30 dB however good the decoder is — the sweep below measures
    // 23.6 dB there against 34.7 dB at 200 kHz and 59 dB at 250 kHz, because
    // Carson wants 2*(75+53) = 256 kHz and the outer sidebands carrying the
    // 38 kHz subcarrier are the first thing a narrow IF throws away.
    sd.setWfmIfBandwidth(iqRate: rate, cutoffHz: 100_000)
    sd.setDeemphasis(audioRate: audioRate, tau: 50e-6)
    let o = sd.processWFMStereo(int16IQ: sepIQ, decimate: audioDec)
    var sl = [Float](), sr = [Float]()
    for i in stride(from: 0, to: o.count - 1, by: 2) { sl.append(o[i]); sr.append(o[i + 1]) }
    let settle = sl.count / 10          // the PLL is still pulling in
    sl = Array(sl[settle...]); sr = Array(sr[settle...])
    let wanted = toneAmplitude(sl, hz: toneHz, rate: audioRate)
    let leak = toneAmplitude(sr, hz: toneHz, rate: audioRate)
    let sepDb = 20 * log10(wanted / max(1e-30, leak))
    check("separation at \(Int(toneHz)) Hz is a stereo image, not a hint",
          sepDb > 30, String(format: "%.1f dB", sepDb))
}

section("mono FM on the same signal does not claim stereo")
let mono = Demods()
mono.setWfmAudioBand(iqRate: rate)
mono.setWfmIfBandwidth(iqRate: rate, cutoffHz: 80_000)
let monoIQ = makeIQ(rate: rate, count: 456_000, deviationHz: 75_000,
                    mpx: { sin(2 * .pi * 440 * $0) })
_ = mono.processWFMStereo(int16IQ: monoIQ, decimate: audioDec)
check("no pilot, no lock", !mono.stereoLocked)

section("config round-trips and falls back")
var c = RadioConfig()
c.host = "192.168.0.142"; c.port = 8888; c.mode = WFM
c.tuneStepByMode = ["1": 100_000, "2": 9_000]
let enc = JSONEncoder()
let dec = JSONDecoder()
if let data = try? enc.encode(c), let back = try? dec.decode(RadioConfig.self, from: data) {
    check("host survives", back.host == c.host)
    check("per-mode step survives", back.step(for: WFM, hz: 80_000_000) == 100_000)
    // AM is filed by band: the bare "2" a pre-split config carries belongs to
    // medium wave, and short wave falls through to its own 5 kHz raster.
    check("a bare AM step is read as medium wave",
          back.step(for: AM, hz: 954_000) == 9_000)
    check("short wave AM takes the band's raster",
          back.step(for: AM, hz: 6_055_000) == 5_000)
    check("a mode with nothing stored takes the band raster, not the global step",
          back.step(for: CW, hz: 7_000_000) == 100)
} else {
    check("config encodes and decodes", false, "encode or decode threw")
}
check("defaults are safe with no file", RadioConfig().host == "127.0.0.1")

// A file written by an older build lacks whatever fields were added since.
// The synthesised decoder treats that as a whole-object failure, so every
// setting reverts at once — which is how a machine with autoDirect true on
// disk came up not connecting, and said nothing.
let partial = """
{"host":"192.168.0.142","port":8888,"autoDirect":true,"mode":1}
"""
if let old = try? dec.decode(RadioConfig.self, from: Data(partial.utf8)) {
    check("known keys survive a file missing newer ones", old.host == "192.168.0.142" && old.port == 8888,
          "host \(old.host) port \(old.port)")
    check("autoDirect survives", old.autoDirect)
    check("absent keys take their default", old.jpRegion == "kanto" && old.audioDecimate == 4,
          "region \(old.jpRegion) dec \(old.audioDecimate)")
} else {
    check("a partial config still decodes", false, "decode threw on missing keys")
}
// Every stored property must survive a round trip. The decoder is written by
// hand so that a file missing newer keys still loads, and the cost of that is
// a key list someone has to remember to extend — uiScale was added and not
// added there, so the setting was written to disk, read back as the default,
// and silently did nothing.
//
// No field list here either: encode a default, mutate the JSON generically,
// and require the re-encoded result to match. A dropped key shows up as a
// value that reverted.
if let baseline = try? enc.encode(RadioConfig()),
   var obj = try? JSONSerialization.jsonObject(with: baseline) as? [String: Any] {
    for (k, v) in obj {
        // `as? Bool` is not a type test here: JSONSerialization hands back
        // NSNumber for everything, so a numeric 1 matched Bool and got flipped
        // to false. CFBoolean is the only reliable way to tell them apart, and
        // getting it wrong made the check fail on fields that were fine.
        if CFGetTypeID(v as CFTypeRef) == CFBooleanGetTypeID() {
            obj[k] = !((v as? Bool) ?? false)
        } else if let n = v as? NSNumber {
            obj[k] = n.doubleValue + 7
        } else if let str = v as? String {
            obj[k] = str + "-x"
        }
        // dictionaries stay as they are
    }
    if let mutated = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]),
       let decoded = try? dec.decode(RadioConfig.self, from: mutated),
       let again = try? enc.encode(decoded),
       let back = try? JSONSerialization.jsonObject(with: again) as? [String: Any] {
        // Compared by type, not by description: JSONSerialization gives back
        // NSNumber for both Int and Double, so 12 and 12.0 stringify
        // differently while meaning the same thing. The first version of this
        // check failed on 25 fields for that reason alone.
        func same(_ a: Any?, _ b: Any?) -> Bool {
            guard let a, let b else { return false }
            let aBool = CFGetTypeID(a as CFTypeRef) == CFBooleanGetTypeID()
            let bBool = CFGetTypeID(b as CFTypeRef) == CFBooleanGetTypeID()
            if aBool != bBool { return false }
            if aBool { return (a as? Bool) == (b as? Bool) }
            if let x = a as? NSNumber, let y = b as? NSNumber { return x.doubleValue == y.doubleValue }
            if let x = a as? String, let y = b as? String { return x == y }
            if let x = a as? [String: Any], let y = b as? [String: Any] { return x.count == y.count }
            return false
        }
        var lost: [String] = []
        for (k, want) in obj where !same(back[k], want) { lost.append(k) }
        check("every field survives a round trip", lost.isEmpty,
              "not decoded: \(lost.sorted().joined(separator: ", "))")
    } else {
        check("mutated config re-encodes", false)
    }
} else {
    check("a default config encodes", false)
}

// And an outright broken file must not take the app down with it.
check("garbage does not decode", (try? dec.decode(RadioConfig.self, from: Data("not json".utf8))) == nil)

section("a touch lands on the band's own raster")
// One pixel of an unzoomed 456 kHz window is half a kilohertz, so a frequency
// read off a finger is between channels every time. 954 kHz is the case that
// proves it: a receiver that cannot snap to the 9 kHz raster cannot reach it.
check("medium wave lands on the 9 kHz raster", snapToStep(956_120, step: 9_000) == 954_000)
check("FM lands on the 100 kHz raster", snapToStep(82_461_000, step: 100_000) == 82_500_000)
check("it rounds, not truncates", snapToStep(80_049_000, step: 100_000) == 80_000_000)
check("short wave takes its own 5 kHz raster", snapToStep(6_053_400, step: 5_000) == 6_055_000)
check("no step means no snap", snapToStep(6_053_400, step: 0) == 6_053_400)
check("never below zero", snapToStep(-1, step: 9_000) == 0)

section("AM and FM keep their own RF gain")
// FM detects an angle, so the server-side gain moves the RSSI and nothing
// else; the plugin carries the index into the demodulator's output gain
// instead (spyService.ts:1349). Two values, because AM wants it pulled down
// against a strong medium-wave neighbour and FM wants all of it.
var g = RadioConfig()
g.amGain = 3
if let data = try? enc.encode(g), let back = try? dec.decode(RadioConfig.self, from: data) {
    check("a chosen AM gain survives", back.amGain == 3)
    check("an unset FM gain stays unset", back.fmGain == nil)
}
// A file written before the split carries one `gain`, chosen in AM.
if let old = try? dec.decode(RadioConfig.self, from: Data(#"{"gain":4}"#.utf8)) {
    check("a pre-split gain migrates to AM", old.amGain == 4)
    check("and leaves FM to the device maximum", old.fmGain == nil)
} else {
    check("a pre-split config decodes", false)
}
let gr = LocalRadio()
gr.config.amGain = nil; gr.config.fmGain = nil
check("an unset gain resolves to the device maximum",
      gr.amGainIndex == gr.maxGainIndex && gr.fmGainIndex == gr.maxGainIndex,
      "am \(gr.amGainIndex) fm \(gr.fmGainIndex) max \(gr.maxGainIndex)")
gr.config.amGain = 99
check("and is clamped to it", gr.amGainIndex == gr.maxGainIndex)
gr.config.amGain = 2; gr.config.fmGain = 7
gr.mode = AM
check("AM asks for the AM index", gr.gain == 2)
gr.mode = WFM
check("FM asks for the FM index", gr.gain == 7)
gr.mode = USB
check("SSB rides the FM index, as the demodulators do", gr.gain == 7)

section("the demodulator can sit inside the window")
// Tuning by moving the device re-centres the window on every tune, and a
// display that jumps cannot be aimed with. Moving the window's contents
// instead keeps the device — and the spectrum — still. A tone 10 kHz above
// the centre, brought down by 10 kHz, has to come out at DC: every sample at
// the same phase, so the vector sum is the whole run rather than a circle
// that cancels itself.
let vfoRate = 96_000.0, vfoToneHz = 10_000.0, vfoToneAmp = 12000.0
let vfoToneN = 4096
var vfoToneData = Data(count: vfoToneN * 4)
vfoToneData.withUnsafeMutableBytes { (b: UnsafeMutableRawBufferPointer) in
    for i in 0..<vfoToneN {
        let ph = 2 * Double.pi * vfoToneHz * Double(i) / vfoRate
        b.storeBytes(of: Int16((cos(ph) * vfoToneAmp).rounded()).littleEndian,
                     toByteOffset: i * 4, as: Int16.self)
        b.storeBytes(of: Int16((sin(ph) * vfoToneAmp).rounded()).littleEndian,
                     toByteOffset: i * 4 + 2, as: Int16.self)
    }
}
var sh = IQShift()
let untouched = sh.process(vfoToneData)
check("no offset leaves the buffer exactly as it was", sh.isIdentity && untouched == vfoToneData)
sh.setShift(hz: -vfoToneHz, sampleRate: vfoRate)
let shifted = sh.process(vfoToneData)
var sumI = 0.0, sumQ = 0.0, magSum = 0.0
shifted.withUnsafeBytes { (b: UnsafeRawBufferPointer) in
    for i in 0..<vfoToneN {
        let I = Double(b.loadUnaligned(fromByteOffset: i * 4, as: Int16.self).littleEndian)
        let Q = Double(b.loadUnaligned(fromByteOffset: i * 4 + 2, as: Int16.self).littleEndian)
        sumI += I; sumQ += Q
        magSum += (I * I + Q * Q).squareRoot()
    }
}
check("a tone brought onto the centre stops rotating",
      (sumI * sumI + sumQ * sumQ).squareRoot() > magSum * 0.999,
      "sum \((sumI * sumI + sumQ * sumQ).squareRoot()) of \(magSum)")
check("and keeps the amplitude it arrived with", near(magSum / Double(vfoToneN), vfoToneAmp, 2))

// Where a target leaves the demodulator, or nil when the device has to move.
check("a target inside the window moves the demodulator, not the device",
      LocalRadio.vfoOffset(target: 954_000, center: 1_134_000, maxOffset: 187_000) == -180_000)
check("one outside it moves the device",
      LocalRadio.vfoOffset(target: 594_000, center: 1_134_000, maxOffset: 187_000) == nil)
check("the edge itself counts as inside",
      LocalRadio.vfoOffset(target: 1_321_000, center: 1_134_000, maxOffset: 187_000) == 187_000)
// A preset is not a step along the band: the window is expected to arrive too,
// even when the demodulator alone could have reached the station. Without this
// the spectrum stays where the last pan left it while the marker walks off to
// the edge, which is what "the display stopped following the receiver" is.
check("a jump asks for the window, not only the demodulator",
      LocalRadio.vfoOffset(target: 954_000, center: 1_134_000, maxOffset: 187_000,
                           recenter: true) == nil)

section("control arriving means going where you were told")
// SpyServer gives control to the first client and drops everyone else's
// retunes without a word. The loser is not wrong about where it wants to be —
// it simply cannot get there — so the edge where control arrives is when it
// pays that back. Missing this is what "FM stopped receiving" was: the app
// kept demodulating the band the departed client had left the device on.
check("control arriving, and the device is elsewhere, reclaims",
      LocalRadio.shouldReclaim(was: false, now: true, wanted: 81_300_000, deviceFreq: 7_325_000))
check("already in control changes nothing",
      !LocalRadio.shouldReclaim(was: true, now: true, wanted: 81_300_000, deviceFreq: 7_325_000))
check("losing control does not retune",
      !LocalRadio.shouldReclaim(was: true, now: false, wanted: 81_300_000, deviceFreq: 7_325_000))
check("control arriving on the frequency we wanted re-issues nothing",
      !LocalRadio.shouldReclaim(was: false, now: true, wanted: 81_300_000, deviceFreq: 81_300_000))
check("nothing wanted yet, nothing to reclaim",
      !LocalRadio.shouldReclaim(was: false, now: true, wanted: 0, deviceFreq: 7_325_000))

section("a jump reaches the receiver as a jump")
// The rule above is only worth having if the call sites ask for it. Every
// control in the Mac window is routed through `Receiver`, so that is where the
// flag has to survive — the preset list once shared the plain tune call with
// the digits and the trace click, and the window then followed only the
// presets that happened to fall outside the IQ span.
var tuneCalls: [(hz: Int, recenter: Bool)] = []
Receiver.direct = Receiver.DirectControl(
    status: { Receiver.Status() },
    tuneHz: { hz, recenter in tuneCalls.append((hz, recenter)) },
    tuneTicks: { _ in },
    mode: { _ in },
    volume: { _ in },
    toggleMute: { })
Receiver.tune(hz: 954_000)
check("aiming leaves the window where it is", tuneCalls.last?.recenter == false)
Receiver.jump(to: Receiver.bands[0])
check("a band button brings the window along", tuneCalls.last?.recenter == true)

// And the raster a pointer tune snaps to comes from the same receiver. The
// standalone bundle owns one of its own, but it only drives it while `direct`
// is installed; as a front-end onto the plugin its own receiver is not even
// connected, and reading the step off it snapped an FM click onto the 1 kHz
// raster the config was left on.
check("the local step is used while the local receiver is the live one",
      Receiver.tuneStepInForce(localStep: 12_345) == 12_345)
Receiver.direct = nil
var askedLocal = false
_ = Receiver.tuneStepInForce(localStep: { askedLocal = true; return 12_345 }())
check("and is not even consulted when it is not", !askedLocal)

section("the window's override ends when the receiver settles anywhere")
// The view holds an absolute centre while a pan is catching up, and drops it
// when a frame arrives from there.
check("a frame from where the view is waiting ends it",
      SpectrumView.overrideDone(target: 1_134_000, previous: 954_000, frame: 1_134_000))
check("a frame from where it was does not",
      !SpectrumView.overrideDone(target: 1_134_000, previous: 954_000, frame: 954_000))
// The case that parked the window: a preset chosen while the pan was still
// settling sends the device to a third frequency, and the centre the view is
// waiting for is then one nothing will report again.
check("a frame from a third frequency ends it too",
      SpectrumView.overrideDone(target: 1_134_000, previous: 954_000, frame: 594_000))
check("the first frame of all is not a move",
      !SpectrumView.overrideDone(target: 1_134_000, previous: 0, frame: 954_000))

section("frame smoothing actually smooths")
// The transform takes the coefficient itself, SDR++'s way: 1 follows the frame
// exactly (no averaging) and a small number barely moves. The port had this
// inverted — alpha = 1 / factor — so a larger setting meant *more* averaging
// where SDR++ and the plugin both mean less.
func iqTone(_ n: Int, amp: Double, hz: Double, rate: Double) -> Data {
    var d = Data(count: n * 4)
    d.withUnsafeMutableBytes { (b: UnsafeMutableRawBufferPointer) in
        for i in 0..<n {
            let ph = 2 * Double.pi * hz * Double(i) / rate
            b.storeBytes(of: Int16((cos(ph) * amp).rounded()).littleEndian, toByteOffset: i * 4, as: Int16.self)
            b.storeBytes(of: Int16((sin(ph) * amp).rounded()).littleEndian, toByteOffset: i * 4 + 2, as: Int16.self)
        }
    }
    return d
}
let sm = FFTPipeline(1024)!
let loud = iqTone(1024, amp: 12000, hz: 10_000, rate: 96_000)
let quiet = iqTone(1024, amp: 40, hz: 10_000, rate: 96_000)
if let a = sm.process(int16IQ: loud, smoothAlpha: 0.02),
   let b = sm.process(int16IQ: quiet, smoothAlpha: 0.02),
   let raw = FFTPipeline(1024)!.process(int16IQ: quiet, smoothAlpha: 1) {
    let peak = a.firstIndex(of: a.max()!)!
    check("a loud frame is drawn as loud", a[peak] > raw[peak] + 20,
          "loud \(a[peak]) raw-quiet \(raw[peak])")
    // One frame at alpha 0.02 moves the bin a fiftieth of the way down, so it
    // must still be nearer the loud reading than the quiet one.
    check("the next frame barely moves it", abs(b[peak] - a[peak]) < abs(b[peak] - raw[peak]),
          "loud \(a[peak]) smoothed \(b[peak]) raw \(raw[peak])")
    // And with smoothing off it lands on the raw reading immediately.
    let off = FFTPipeline(1024)!
    _ = off.process(int16IQ: loud, smoothAlpha: 1)
    if let c = off.process(int16IQ: quiet, smoothAlpha: 1) {
        check("alpha 1 follows the frame", near(Double(c[peak]), Double(raw[peak]), 0.001),
              "off \(c[peak]) raw \(raw[peak])")
    }
} else {
    check("the pipeline produced frames", false)
}

section("soft limiter")
check("linear under the knee", near(AudioLeveling.softLimit(1000), 1000, 1e-9))
check("never exceeds the ceiling", AudioLeveling.softLimit(1e9) <= AudioLeveling.int16Max)
check("odd symmetry", near(AudioLeveling.softLimit(-40000), -AudioLeveling.softLimit(40000), 1e-9))

section("FFT")
if let fft = FFTPipeline(4096) {
    // A tone at exactly a bin centre, so there is no scalloping to argue about.
    let toneIQ = makeIQ(rate: 1, count: 4096, carrierOffsetHz: 0.25, amplitude: 0.5, noise: 0.001)
    if let bins = fft.process(int16IQ: toneIQ, smoothAlpha: 1) {
        var peakIdx = 0, peak = -Float.greatestFiniteMagnitude
        for (i, v) in bins.enumerated() where v > peak { peak = v; peakIdx = i }
        check("peak lands where fftshift puts it", peakIdx == 3072, "bin \(peakIdx)")
        // Power-normalised, so a tone reads 10*log10(1.5) = 1.76 dB light.
        check("tone level within the Hann ENBW offset", near(Double(peak), -7.78, 0.3),
              "\(peak) dBFS")
    } else { check("FFT produced bins", false) }
} else { check("FFT constructs at 4096", false) }
check("FFT rejects a non-power-of-two", FFTPipeline(1000) == nil)

section("preset store")
let tmp = NSTemporaryDirectory() + "drx-tests-\(getpid())"
try? FileManager.default.createDirectory(atPath: tmp, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(atPath: tmp) }
let src = tmp + "/sdrpp.json"
let dst = tmp + "/presets.json"
let srcJSON = """
{"lists":{"General":{"bookmarks":{
 "MW TBS":{"frequency":954000,"bandwidth":9000.0,"mode":2},
 "FM NHK":{"frequency":82500000,"bandwidth":150000.0,"mode":1}}}}}
"""
try? srcJSON.write(toFile: src, atomically: true, encoding: .utf8)
try? "{\"lists\":{}}".write(toFile: dst, atomically: true, encoding: .utf8)
if let r = try? PresetStore.importFromSdrpp(sdrPath: src, storePath: dst) {
    check("both bookmarks imported", r.added == 2, "added \(r.added)")
    let loaded = PresetStore.load(path: dst)
    let entries = loaded["General"] ?? [:]
    check("mode travels with the preset", entries.values.contains { $0.mode == WFM },
          "modes \(entries.values.map(\.mode))")
    // Re-importing must not duplicate: frequency is identity.
    if let again = try? PresetStore.importFromSdrpp(sdrPath: src, storePath: dst) {
        check("re-import adds nothing", again.added == 0 && again.skipped == 2,
              "added \(again.added) skipped \(again.skipped)")
    }
} else {
    check("import runs", false, "threw")
}

section("a dropped link is retried, and a deliberate stop is not")
// Connecting to a port nothing listens on fails, and the receiver must keep
// trying: SpyServer being down for an hour is normal, and a receiver that
// gives up means noticing by ear that the radio went quiet.
let rc = LocalRadio()
var rcCfg = RadioConfig()
rcCfg.host = "127.0.0.1"; rcCfg.port = 1        // nothing listens here
rc.config = rcCfg
rc.connect()
// Longer than the client's 5 s connect timeout: 127.0.0.1:1 is not refused
// here, it is dropped, so the failure arrives on the timeout rather than
// immediately. Waiting 1.5 s asserted against a connection still in progress.
Thread.sleep(forTimeInterval: 6.5)
check("a failed connect reports why", rc.lastError != nil, "lastError nil")
check("and is not left claiming a connection", !rc.isConnected)
rc.disconnect()
Thread.sleep(forTimeInterval: 0.3)
let errAfterStop = rc.lastError
Thread.sleep(forTimeInterval: 2.5)
// After disconnect the retry loop must be silent: an unchanged error string
// is the observable form of "no further attempts".
check("disconnect stops the retries", rc.lastError == errAfterStop,
      "error moved to \(rc.lastError ?? "nil")")

// Quitting is a stop too, and a stricter one: the audio device, the server's
// single control slot and — on the USB source — the Airspy itself are all
// held by the process, so they have to be handed back before it goes rather
// than dropped for something else to notice.
let sd = LocalRadio()
var sdCfg = RadioConfig()
sdCfg.host = "127.0.0.1"; sdCfg.port = 1
sd.config = sdCfg
sd.audioEnabled = true
sd.connect()
sd.shutdown()
check("shutdown turns the audio off", !sd.audioEnabled)
check("and leaves nothing claiming a connection", !sd.isConnected)
// The point of `shutdown` over `disconnect` is that it has finished when it
// returns; a source with nothing to wait for still has to answer it.
check("a source with no hardware to release still answers shutdown",
      { let c = SpyClient(); c.shutdown(); return true }())

section("the reader tracks the ring depth instead of drifting off it")
// The sender's clock and the device's differ by tens of ppm. With a fixed
// ratio the ring can only fill until it overflows or empty until it underruns;
// this loop is what holds it at the target depth instead.
check("a shallow ring slows the reader down",
      AudioSink.trackedRate(fillFrames: 100, target: 1000, current: 1) < 1)
check("a deep ring speeds it up",
      AudioSink.trackedRate(fillFrames: 5000, target: 1000, current: 1) > 1)
check("at the target it does not move",
      near(AudioSink.trackedRate(fillFrames: 1000, target: 1000, current: 1), 1, 1e-12))
// Approached, not jumped to: a ratio that steps is heard as a pitch waver.
check("one step is small",
      AudioSink.trackedRate(fillFrames: 1_000_000, target: 1000, current: 1) < 1.0002)
var tracked = 1.0
for _ in 0..<1000 {
    tracked = AudioSink.trackedRate(fillFrames: 1_000_000, target: 1000, current: tracked)
}
check("and converges inside the 0.4% cap", tracked > 1.0035 && tracked <= 1.0041,
      "settled at \(tracked)")
var starved = 1.0
for _ in 0..<1000 {
    starved = AudioSink.trackedRate(fillFrames: 0, target: 1000, current: starved)
}
check("the same cap holds on the empty side", starved < 0.9965 && starved >= 0.9959,
      "settled at \(starved)")

section("audio sink accepts the channel counts the modes need")
let sink = AudioSink()
check("mono starts", (try? sink.start(sourceRate: 9500, channels: 1)) != nil)
sink.stop()
check("stereo starts", (try? sink.start(sourceRate: 9500, channels: 2)) != nil)
sink.stop()

section("output stage, against the plugin")
// The plugin and this app run the same three stages with the same constants, so
// the two can be compared by arithmetic instead of by listening to them. The
// fixture is shared: test/audioLeveling.test.ts checks its `plugin` arrays
// against the plugin's own code, this checks its `solo` arrays against ours.
// Its comment carries the one real difference and why it is not settled here —
// the volume sits outside the limiter in this app and inside it in the plugin.
outputStageCheck: do {
    // Walk up from this file until the fixture turns up, rather than counting
    // directories: how swiftc records #filePath depends on how it was invoked,
    // and a hard-coded number of steps was already wrong once.
    let rel = "test/fixtures/audioOutputGolden.json"
    var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    var found: URL?
    for _ in 0..<6 {
        let candidate = dir.appendingPathComponent(rel)
        if FileManager.default.fileExists(atPath: candidate.path) { found = candidate; break }
        dir = dir.deletingLastPathComponent()
    }
    let fixture = found ?? URL(fileURLWithPath: rel)
    guard let data = try? Data(contentsOf: fixture),
          let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let input = root["input"] as? [Double],
          let params = root["params"] as? [String: Any],
          let mode = params["mode"] as? Int,
          let makeupExpected = params["makeup"] as? Double,
          let audioGain = params["audioGain"] as? Double,
          let cases = root["cases"] as? [[String: Any]] else {
        check("the shared output-stage fixture loads", false, fixture.path)
        break outputStageCheck
    }
    check("the fixture agrees with modeMakeup about the mode it claims",
          AudioLeveling.modeMakeup[mode] == makeupExpected,
          "\(AudioLeveling.modeMakeup[mode] ?? -1) vs \(makeupExpected)")

    // What LocalRadio.level() does, followed by what AudioSink.write() does.
    // Kept as the same two steps in the same order rather than folded into one
    // expression, because the order is the thing under test: makeup here, then
    // volume and only then the limiter — the plugin's order. Until 2026-09-10
    // the limiter was in the first step, which cost this app 0.91 dB on an AM
    // peak the plugin passed through.
    func outputStage(_ x: Double, volume: Double, makeup: Double) -> Double {
        let levelled = Float(x / 32768) * Float(makeup)              // level()
        let out = Float(AudioLeveling.softLimit(
            Double(levelled * Float(volume)) * 32768) / 32768)       // sink
        return Double(out) * 32768
    }

    for c in cases {
        guard let name = c["name"] as? String,
              let volume = c["volume"] as? Double,
              let expected = c["solo"] as? [Double] else { continue }
        let makeup = (AudioLeveling.modeMakeup[mode] ?? 1) * audioGain
        var worst = 0.0
        var worstAt = 0.0
        for (i, x) in input.enumerated() {
            let got = outputStage(x, volume: volume, makeup: makeup)
            let d = abs(got - expected[i])
            if d > worst { worst = d; worstAt = x }
        }
        // 0.05 covers the fixture carrying one decimal place, nothing more.
        check("reproduces this app's output at volume \(volume) (\(name))",
              worst <= 0.05, "worst \(worst) at input \(worstAt)")
    }

    // Both sides of the fixture, at every volume: the two now agree across the
    // whole vector rather than only below the limiter's knee.
    for c in cases {
        guard let name = c["name"] as? String,
              let plugin = c["plugin"] as? [Double],
              let solo = c["solo"] as? [Double] else { continue }
        var worst = 0.0
        var worstAt = 0.0
        for (i, p) in plugin.enumerated() {
            let d = abs(p - solo[i])
            if d > worst { worst = d; worstAt = input[i] }
        }
        // 0.5 is int16 rounding, the only difference left: the plugin returns an
        // integer from softLimit and this app stays in float.
        check("agrees with the plugin at every input (\(name))",
              worst <= 0.5, "worst \(worst) at input \(worstAt)")
    }

    // The row the regression lived on: input 24000 is AM_AGC_MAX_OUTPUT, where
    // the carrier AGC's look-ahead puts peaks. This app used to compress it to
    // 13293 while the plugin passed 14760.
    if let c = cases.first(where: { ($0["volume"] as? Double) == 0.41 }),
       let i = input.firstIndex(of: 24000) {
        let makeup = (AudioLeveling.modeMakeup[mode] ?? 1) * audioGain
        let got = outputStage(24000, volume: 0.41, makeup: makeup)
        check("the AM peak this app used to lose is back", abs(got - 14760) <= 0.5,
              "\(got), fixture says \((c["solo"] as? [Double])?[i] ?? -1)")
    } else {
        check("the fixture has the 0.41 case and its 24000 row", false)
    }
}

section("a frequency the hardware cannot reach is clamped, not obeyed")
// The spectrum shows more band than the device can tune to — the IQ window is
// wider than the gap to the bottom of its range — so a click can aim below the
// minimum. Obeying it moved the centre down a window at a time until the
// readout said 0 kHz and the axis ran negative.
do {
    let lo: UInt32 = 500_000, hi: UInt32 = 260_000_000
    check("below the bottom comes back as the bottom",
          LocalRadio.clampToDevice(366_000, min: lo, max: hi) == lo)
    check("zero is not a frequency this receiver has",
          LocalRadio.clampToDevice(0, min: lo, max: hi) == lo)
    check("above the top comes back as the top",
          LocalRadio.clampToDevice(300_000_000, min: lo, max: hi) == hi)
    check("inside the range is left alone",
          LocalRadio.clampToDevice(594_000, min: lo, max: hi) == 594_000)
    check("a device that reports no range is not second-guessed",
          LocalRadio.clampToDevice(42, min: 0, max: 0) == 42)
}

section("stereo separation across the IQ rates the receiver actually runs")
// The separation checks above all run at 456 kHz, which is one of the rates the
// device offers and not the one a listener is necessarily on. A decoder whose
// pilot loop or 38 kHz reference is tuned for one rate can collapse at another,
// and that failure is invisible to a test that only ever uses the first.
do {
    let toneHz = 1000.0
    for dev in [50_000.0, 75_000.0] {
      print("  [deviation \(Int(dev/1000)) kHz]")
      let appFilters = true, noise = 0.02
      for r in [912_000.0] {
        for bw in [150_000.0, 200_000.0, 250_000.0, 300_000.0] {
            let dec = 4
            let aRate = r / Double(dec)
            let iq = makeIQ(rate: r, count: Int(r), deviationHz: dev, noise: noise, mpx: { t in
                let lpr = sin(2 * .pi * toneHz * t) / 2, lmr = lpr
                return lpr + 0.08 * sin(2 * .pi * 19_000 * t) + lmr * sin(2 * .pi * 38_000 * t)
            })
            let d = Demods()
            d.setWfmAudioBand(iqRate: r)
            d.setWfmIfBandwidth(iqRate: r, cutoffHz: bw / 2)
            d.setDeemphasis(audioRate: aRate, tau: 50e-6)
            // What `LocalRadio.configureDemods` does and this test did not: with
            // the audio low pass switched off the cutoff is 0.45 of the audio
            // rate, which at 228 kHz is 102 kHz. Leaving these out was why the
            // test read 47 dB while the receiver delivered 31 dB down.
            if appFilters {
                let lpf = aRate * 0.45
                d.setAudioFilters(rate: aRate, lowPassHz: lpf, highPassHz: 0)
                d.setStereoAudioFilters(rate: aRate, lowPassHz: lpf, highPassHz: 0)
            }
            let o = d.processWFMStereo(int16IQ: iq, decimate: dec)
            var sl = [Float](), sr = [Float]()
            for i in stride(from: 0, to: o.count - 1, by: 2) { sl.append(o[i]); sr.append(o[i + 1]) }
            guard sl.count > 100 else { print("  \(Int(r/1000))k bw \(Int(bw/1000))k: no audio"); continue }
            let settle = sl.count / 10
            sl = Array(sl[settle...]); sr = Array(sr[settle...])
            let amp = toneAmplitude(sl, hz: toneHz, rate: aRate)
            let leak = toneAmplitude(sr, hz: toneHz, rate: aRate)
            // What DigiCheck's Lissajous shows: +1 is a line at 45 degrees,
            // which is mono however loud the two channels are.
            var num = 0.0, dl = 0.0, dr = 0.0
            for i in 0..<min(sl.count, sr.count) {
                let a = Double(sl[i]), b = Double(sr[i])
                num += a * b; dl += a * a; dr += b * b
            }
            let corr = num / max(1e-30, (dl * dr).squareRoot())
            // Side against Mid, which is the shape a Lissajous draws.
            var mid = 0.0, side = 0.0
            for i in 0..<min(sl.count, sr.count) {
                let a = Double(sl[i]), b = Double(sr[i])
                mid += ((a + b) / 2) * ((a + b) / 2); side += ((a - b) / 2) * ((a - b) / 2)
            }
            let sm = 10 * log10(max(side, 1e-30) / max(mid, 1e-30))
            print(String(format: "  IQ %4dk  bw %3dk : separation %6.2f dB   Side/Mid %+6.2f dB   corr %+.4f   pilot %.4f   lock %@",
                         Int(r/1000), Int(bw/1000), 20 * log10(amp / max(1e-30, leak)),
                         sm, corr, d.pilotMetric, d.stereoLocked ? "yes" : "NO"))
        }
      }
    }
}

section("IFNR on WFM stereo: what it buys and what it costs")
// The impression to check is "the hiss goes down and the stereo image goes with
// it" — and with FM stereo the level moves too, because losing L-R changes the
// loudness and not only the width. So all of it is measured on one signal, at
// several signal strengths: noise, separation, level, and the pilot.
//
// IFNR keeps only the strongest FFT bin of the IQ per sample. At 456 kHz with
// 32 bins that quantises the instantaneous frequency to a 14.25 kHz grid, and
// the MPX components that carry the stereo — a 19 kHz pilot at 8% and an L-R
// subcarrier at 38 kHz — are small next to L+R. They are what the peak-bin
// choice throws away first. Measuring at one strength only would have told
// half the story: the filter is meant for a signal buried in hiss.
do {
    let toneHz = 1000.0
    func leftOnly(_ noise: Double) -> Data {
        makeIQ(rate: rate, count: 456_000, deviationHz: 75_000, noise: noise, mpx: { t in
            let lpr = sin(2 * .pi * toneHz * t) / 2, lmr = lpr
            return lpr + 0.08 * sin(2 * .pi * 19_000 * t) + lmr * sin(2 * .pi * 38_000 * t)
        })
    }
    func measure(_ iq: Data, nr useNr: Bool) -> (snr: Double, sep: Double, lvl: Double, locked: Bool) {
        var body = iq
        if useNr {
            let n = IqNr()
            n.setMode(1)                      // WFM
            body = n.process(iq)
        }
        let d = Demods()
        d.setWfmAudioBand(iqRate: rate)
        d.setWfmIfBandwidth(iqRate: rate, cutoffHz: 75_000)
        d.setDeemphasis(audioRate: audioRate, tau: 50e-6)
        let o = d.processWFMStereo(int16IQ: body, decimate: audioDec)
        var sl = [Float](), sr = [Float]()
        for i in stride(from: 0, to: o.count - 1, by: 2) { sl.append(o[i]); sr.append(o[i + 1]) }
        let settle = sl.count / 10            // the PLL is still pulling in
        sl = Array(sl[settle...]); sr = Array(sr[settle...])
        let amp = toneAmplitude(sl, hz: toneHz, rate: audioRate)
        let leak = toneAmplitude(sr, hz: toneHz, rate: audioRate)
        // toneAmplitude returns A/2 for a tone of amplitude A, so the tone's
        // own RMS is sqrt(2) times it. What is left of the total is noise.
        let lvl = rms(sl)
        let toneRms = amp * 2.0.squareRoot()
        let noiseRms = max(1e-30, lvl * lvl - toneRms * toneRms).squareRoot()
        return (20 * log10(toneRms / noiseRms),
                20 * log10(amp / max(1e-30, leak)),
                lvl, d.stereoLocked)
    }
    print("  IQ noise |        SNR off / on        |    separation off / on     | level")
    var everHelped = false
    for noise in [0.02, 0.1, 0.3, 0.6] {
        let iq = leftOnly(noise)
        let off = measure(iq, nr: false), on = measure(iq, nr: true)
        if on.snr > off.snr + 1 { everHelped = true }
        print(String(format: "  %7.2f  | %6.2f -> %6.2f dB (%+5.2f) | %6.2f -> %6.2f dB (%+6.2f) | %+5.2f dB  pilot %@/%@",
                     noise, off.snr, on.snr, on.snr - off.snr,
                     off.sep, on.sep, on.sep - off.sep,
                     20 * log10(on.lvl / max(1e-30, off.lvl)),
                     off.locked ? "ok" : "LOST", on.locked ? "ok" : "LOST"))
    }
    // What the table says, as assertions, so any of it moving shows up. Read
    // these together: the quiet IFNR delivers is bought with the image, not
    // earned by cleaning the signal. The residual it removes is largely the
    // noise that rode in on L-R, so "SNR" rises by about 9 dB while
    // separation falls by 22 dB, and at the weakest signal even that
    // dividend is gone. Measured 2026-09-12, after the 38 kHz reference was
    // corrected; the earlier readings were taken through a decoder that
    // recovered no L-R at all, so both of these once read the other way.
    _ = everHelped
    let strong = leftOnly(0.02), weak = leftOnly(0.6)
    let sOff = measure(strong, nr: false), sOn = measure(strong, nr: true)
    let wOff = measure(weak, nr: false), wOn = measure(weak, nr: true)
    check("IFNR costs the stereo image, and not a little",
          sOn.sep < sOff.sep - 20, String(format: "%.1f -> %.1f dB", sOff.sep, sOn.sep))
    check("it costs it on a weak signal too, so strength is no excuse",
          wOn.sep < wOff.sep - 20, String(format: "%.1f -> %.1f dB", wOff.sep, wOn.sep))
    check("IFNR changes the level audibly, so it is not a free switch",
          abs(20 * log10(sOn.lvl / max(1e-30, sOff.lvl))) > 2,
          String(format: "%+.2f dB", 20 * log10(sOn.lvl / max(1e-30, sOff.lvl))))
    check("the quiet IFNR buys comes out of the image, not out of the noise",
          sOn.snr > sOff.snr + 5 && sOn.sep < sOff.sep - 20,
          String(format: "SNR %.2f -> %.2f dB, separation %.1f -> %.1f dB",
                 sOff.snr, sOn.snr, sOff.sep, sOn.sep))
    check("on the weakest signal even that stops paying",
          wOn.snr < wOff.snr + 1, String(format: "%.2f -> %.2f dB", wOff.snr, wOn.snr))
    // The badge is the part a listener cannot check: the pilot still locks
    // while there is no separation left, so the display says STEREO either way.
    check("the pilot still locks with IFNR on, which is why the badge misleads",
          sOn.locked, "it did not lock - the badge story changed")
}

print("\n\(checks - failures)/\(checks) passed")
if failures > 0 {
    print("\(failures) FAILED")
    exit(1)
}
print("all green")
