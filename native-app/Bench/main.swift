// === Claude origin ===
// Created/placed by Anthropic Claude Code at: 2026-09-08-070000
// Demodulator benchmarks. Whether an IQ rate can be run with audio comes down
// to one number — how long a second of IQ takes to process — so that is all
// this measures. No GUI, no receiver, no server.
// ====================
import Foundation

/// One medium-wave station, synthesised: carrier, modulation and noise. The
/// content does not change the cost, but a buffer of zeroes does — branch
/// prediction and denormals make it look faster than any real signal.
func makeIQ(samples: Int, rate: Double, toneHz: Double = 12_000) -> Data {
    var d = Data(count: samples * 4)
    d.withUnsafeMutableBytes { (raw: UnsafeMutableRawBufferPointer) in
        let p = raw.baseAddress!
        var seed: UInt64 = 0x2545F4914F6CDD1D
        for i in 0..<samples {
            let t = Double(i) / rate
            let env = 8000.0 * (1 + 0.5 * sin(2 * .pi * 400 * t))
            seed = seed &* 6364136223846793005 &+ 1442695040888963407
            let n = Double(Int32(truncatingIfNeeded: seed >> 33)) / Double(Int32.max) * 300
            let I = env * cos(2 * .pi * toneHz * t) + n
            let Q = env * sin(2 * .pi * toneHz * t) + n
            p.storeBytes(of: Int16(max(-32767, min(32767, I))).littleEndian,
                         toByteOffset: i * 4, as: Int16.self)
            p.storeBytes(of: Int16(max(-32767, min(32767, Q))).littleEndian,
                         toByteOffset: i * 4 + 2, as: Int16.self)
        }
    }
    return d
}

func bench(_ name: String, iqRate: Double, seconds: Double = 1.0,
           packet: Int = 4096, _ body: (Data) -> Int) {
    let total = Int(iqRate * seconds)
    let chunk = makeIQ(samples: packet, rate: iqRate)
    var produced = 0
    let t0 = Date()
    var done = 0
    while done < total {
        produced += body(chunk)
        done += packet
    }
    let el = Date().timeIntervalSince(t0)
    // Load is the fraction of realtime used: 1.0 is exactly keeping up.
    print(String(format: "  %-28s %6.3f s for %.1f s of IQ  -> load %5.1f%%  (out %d)",
                 (name as NSString).utf8String!, el, seconds, el / seconds * 100, produced))
}

let rates: [Double] = [456_000, 912_000]
print("=== AM (16th-order IF, AGC, detector) ===")
for r in rates {
    let am = AMDemod()
    am.setBandwidth(audioRate: r / 8, bandwidthHz: 9000, iqRate: r)
    am.configureSync(rate: r / 8)
    am.agcEnabled = true
    bench("AM \(Int(r/1000))k", iqRate: r) { am.process(int16IQ: $0, decimate: 8).count }
}

print("=== VFO mixer (every tune inside the window goes through it) ===")
for r in rates {
    var sh = IQShift()
    sh.setShift(hz: -50_000, sampleRate: r)
    bench("IQShift \(Int(r/1000))k", iqRate: r) { sh.process($0).count }
}

print("=== WFM (FIR IF, phase detector) ===")
for r in rates {
    let d = Demods()
    d.setWfmIfBandwidth(iqRate: r, cutoffHz: 150_000)
    d.setWfmAudioBand(iqRate: r)
    d.setDeemphasis(audioRate: r / 8, tau: 50e-6)
    bench("WFM \(Int(r/1000))k", iqRate: r) { d.processWFM(int16IQ: $0, decimate: 8).count }
}

// --- Output level: the same signal through the AM path at each IQ rate ---
print("=== AM output level (same signal and settings, IQ rate apart) ===")
for r in rates {
    let am = AMDemod()
    let audioRate = r / 4                      // audioDecimate 4, as shipped
    am.setBandwidth(audioRate: audioRate, bandwidthHz: 9000, iqRate: r)
    am.configureSync(rate: audioRate)
    am.agcEnabled = true
    am.agcAttack = 50 / audioRate
    am.agcDecay = 5 / audioRate
    // Carrier at the centre, as it is once tuned.
    let iq = makeIQ(samples: Int(r) / 2, rate: r, toneHz: 0)
    var rms = 0.0, n = 0
    // Three passes to settle the AGC; the last one is the measurement.
    for pass in 0..<3 {
        let out = am.process(int16IQ: iq, decimate: 4)
        if pass == 2 {
            for v in out { rms += Double(v) * Double(v) }
            n = out.count
        }
    }
    let level = n > 0 ? (rms / Double(n)).squareRoot() : 0
    print(String(format: "  IQ %4.0f k -> audio %6.0f Hz  RMS %.5f  (%.1f dBFS)",
                 r / 1000, audioRate, level, 20 * log10(max(level, 1e-9))))
}

print("=== AM output level (sync detect on, as the app runs it) ===")
for r in rates {
    let am = AMDemod()
    let audioRate = r / 4
    am.setBandwidth(audioRate: audioRate, bandwidthHz: 9000, iqRate: r)
    am.configureSync(rate: audioRate)
    am.agcEnabled = true
    am.syncEnabled = true
    am.agcAttack = 200 / audioRate      // the app's AGC attack
    am.agcDecay = 1 / audioRate         // the app's AGC decay
    let iq = makeIQ(samples: Int(r) / 2, rate: r, toneHz: 0)
    var rms = 0.0, n = 0
    for pass in 0..<4 {
        let out = am.process(int16IQ: iq, decimate: 4)
        if pass == 3 {
            for v in out { rms += Double(v) * Double(v) }
            n = out.count
        }
    }
    let level = n > 0 ? (rms / Double(n)).squareRoot() : 0
    print(String(format: "  IQ %4.0f k -> audio %6.0f Hz  RMS %.5f  (%.1f dBFS)",
                 r / 1000, audioRate, level, 20 * log10(max(level, 1e-9))))
}
