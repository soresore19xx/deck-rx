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
let wideIQ = makeIQ(rate: rate, count: 45_600, deviationHz: 50_000,
                    mpx: { sin(2 * .pi * 440 * $0) })
let audioDec = 4 * 12
let audioRate = rate / Double(audioDec)

/// Filter settings must match whatever the caller's config yields, or a
/// comparison against LocalRadio measures the settings rather than the routing.
func demodOutput(mode: Int, iq: Data,
                 ifCutoff: Double = 75_000, tau: Double = 75e-6) -> [Float] {
    let d = Demods()
    d.setWfmAudioBand(iqRate: rate)
    d.setWfmIfBandwidth(iqRate: rate, cutoffHz: ifCutoff)
    d.setDeemphasis(audioRate: audioRate, tau: tau)
    d.setupSSB(iqRate: rate, audioRate: audioRate)
    d.setupCW(iqRate: rate)
    switch mode {
    case NFM: return d.processFM(int16IQ: iq, decimate: audioDec)
    case WFM: return d.processWFM(int16IQ: iq, decimate: audioDec)
    case USB: return d.processSSB(int16IQ: iq, decimate: audioDec, upperSideband: true)
    case LSB: return d.processSSB(int16IQ: iq, decimate: audioDec, upperSideband: false)
    case CW:  return d.processCW(int16IQ: iq, decimate: audioDec)
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
let stereoIQ = makeIQ(rate: rate, count: 456_000, deviationHz: 50_000, mpx: { t in
    let lpr = (L(t) + R(t)) / 2, lmr = (L(t) - R(t)) / 2
    return lpr + 0.08 * cos(2 * .pi * 19_000 * t) + lmr * cos(2 * .pi * 38_000 * t)
})
let st = Demods()
st.setWfmAudioBand(iqRate: rate)
st.setWfmIfBandwidth(iqRate: rate, cutoffHz: 80_000)
st.setDeemphasis(audioRate: audioRate, tau: 50e-6)
let stOut = st.processWFMStereo(int16IQ: stereoIQ, decimate: audioDec)
check("stereo output is interleaved", stOut.count % 2 == 0 && !stOut.isEmpty)
check("pilot locks", st.stereoLocked, "pilot never reached the badge threshold")
// L and R carry different tones, so a真 stereo decode has them differ.
var l = [Float](), r = [Float]()
for i in stride(from: 0, to: stOut.count - 1, by: 2) { l.append(stOut[i]); r.append(stOut[i + 1]) }
let diff = zip(l, r).map { abs($0 - $1) }.reduce(0, +) / Float(max(1, l.count))
check("L and R differ", diff > 1e-4, "mean |L-R| = \(diff)")

section("mono FM on the same signal does not claim stereo")
let mono = Demods()
mono.setWfmAudioBand(iqRate: rate)
mono.setWfmIfBandwidth(iqRate: rate, cutoffHz: 80_000)
let monoIQ = makeIQ(rate: rate, count: 456_000, deviationHz: 50_000,
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
    check("per-mode step survives", back.step(for: WFM) == 100_000)
    check("step falls back to the global one", back.step(for: CW) == back.tuneStepHz)
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

section("soft limiter")
check("linear under the knee", near(AudioLeveling.softLimit(1000), 1000, 1e-9))
check("never exceeds the ceiling", AudioLeveling.softLimit(1e9) <= AudioLeveling.int16Max)
check("odd symmetry", near(AudioLeveling.softLimit(-40000), -AudioLeveling.softLimit(40000), 1e-9))

section("FFT")
if let fft = FFTPipeline(4096) {
    // A tone at exactly a bin centre, so there is no scalloping to argue about.
    let toneIQ = makeIQ(rate: 1, count: 4096, carrierOffsetHz: 0.25, amplitude: 0.5, noise: 0.001)
    if let bins = fft.process(int16IQ: toneIQ, smoothingFactor: 0) {
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

section("audio sink accepts the channel counts the modes need")
let sink = AudioSink()
check("mono starts", (try? sink.start(sourceRate: 9500, channels: 1)) != nil)
sink.stop()
check("stereo starts", (try? sink.start(sourceRate: 9500, channels: 2)) != nil)
sink.stop()

print("\n\(checks - failures)/\(checks) passed")
if failures > 0 {
    print("\(failures) FAILED")
    exit(1)
}
print("all green")
