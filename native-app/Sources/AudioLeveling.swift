import Foundation

/// Output-stage loudness levelling, applied once just before the sink.
///
/// Port of `src/audioLeveling.ts`. Three stages, in this order and for these
/// reasons:
///
///   1. **Per-mode static makeup.** The demods leave audio at wildly different
///      levels — AM and CW are AGC'd inside the demodulator and to *different*
///      setpoints (16000 and 12000), while WFM, NFM and SSB are raw fixed gain
///      riding signal strength and the RF gain control. This is the primary
///      leveller: it aligns the bands with no dynamic motion at all, so there
///      is nothing to hear pumping.
///   2. **Adaptive output AGC — off by default.** It also tracks within-band
///      strength changes, but its level-riding is audible and not everyone
///      wants it. The static makeup alone is the default for that reason.
///   3. **Soft-knee limiter.** An instantaneous ceiling so the static gain can
///      run hot near full scale without hard-clipping. Peak-only, so it does
///      not breathe the way an AGC does.
enum AudioLeveling {

    /// Keyed by the SDR++ mode index — the numbering the plugin's MODE_MAKEUP
    /// uses, with the same values. Calibrated to bring each band to a common
    /// loudness with the AGC off. CW is below 1 because the demodulator's own
    /// AGC has already normalised the BFO tone.
    ///
    /// AM was 3 once: it over-drove envelope peaks into the limiter and the
    /// result was broadband distortion. 1.5 is about +3.5 dB and stays under
    /// the knee.
    static let modeMakeup: [Int: Double] = [
        0: 5,    // NFM
        1: 10,   // WFM
        2: 1.5,  // AM
        3: 5,    // DSB
        4: 3,    // USB
        5: 0.6,  // CW
        6: 3,    // LSB
        7: 5,    // RAW
    ]

    static let int16Max: Double = 32767

    /// Linear below `ceiling * kneeFrac`, then tanh-compressed up to — never
    /// past — the ceiling. C1-continuous at the knee, since tanh'(0) = 1
    /// matches the linear slope, so there is no kink to hear.
    static func softLimit(_ x: Double, ceiling: Double = int16Max,
                          kneeFrac: Double = 0.85) -> Double {
        let t = ceiling * kneeFrac
        let a = abs(x)
        if a <= t { return x }
        let span = ceiling - t
        let compressed = t + span * tanh((a - t) / span)
        return x < 0 ? -compressed : compressed
    }
}

/// Per-buffer output AGC. `gain` is what the caller multiplies onto the
/// makeup-scaled samples.
final class OutputLeveler {

    struct Config {
        /// Post-levelling RMS in int16 units. 7500 is about -12.8 dBFS.
        var targetRms: Double = 7500
        /// Caps how hard a weak signal — and its noise — gets pushed.
        var maxGain: Double = 16
        /// Lets a hot mode be attenuated rather than only boosted.
        var minGain: Double = 0.05
        /// Falling gain (too loud) is fast; rising gain (too quiet) is slow.
        var attackTc: Double = 0.12
        var releaseTc: Double = 1.5
        /// Below this input RMS the gain is held, so silence and noise do not
        /// get pumped up.
        var noiseFloorRms: Double = 40
        var enabled = false
    }

    private(set) var gain: Double = 1
    var config = Config()

    /// RMS over the makeup-applied buffer, interleaved samples included.
    static func rms(_ pcm: [Float], makeup: Double) -> Double {
        guard !pcm.isEmpty else { return 0 }
        var sumSq: Double = 0
        for v in pcm {
            let s = Double(v) * makeup
            sumSq += s * s
        }
        return (sumSq / Double(pcm.count)).squareRoot()
    }

    private func desiredGain(_ rms: Double) -> Double? {
        guard rms >= config.noiseFloorRms else { return nil }
        return min(max(config.targetRms / rms, config.minGain), config.maxGain)
    }

    /// Advances the gain one buffer toward the target. `dt` is the buffer
    /// duration in seconds.
    @discardableResult
    func observe(_ pcm: [Float], makeup: Double, dt: Double) -> Double {
        guard config.enabled else { gain = 1; return gain }
        guard let desired = desiredGain(Self.rms(pcm, makeup: makeup)) else { return gain }
        let tc = desired < gain ? config.attackTc : config.releaseTc
        let alpha = dt > 0 && tc > 0 ? 1 - exp(-dt / tc) : 1
        gain += (desired - gain) * alpha
        return gain
    }

    /// Jumps straight to the target with no time constant — for unmute, so
    /// audio returns at level instead of crawling up the slow release.
    @discardableResult
    func snap(_ pcm: [Float], makeup: Double) -> Double {
        guard config.enabled else { gain = 1; return gain }
        guard let desired = desiredGain(Self.rms(pcm, makeup: makeup)) else { return gain }
        gain = desired
        return gain
    }

    func reset() { gain = 1 }
}
