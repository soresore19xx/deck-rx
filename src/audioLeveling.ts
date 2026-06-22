// Output-stage loudness leveling for the demodulated PCM.
//
// The demod modes leave the audio at wildly different levels: AM/CW are
// AGC'd inside the demodulator (to *different* setpoints, 16000 / 12000),
// while WFM / NFM / SSB are raw fixed-gain and ride signal strength + the
// RF-gain dial. Feeding those straight to the sink means band-to-band
// loudness jumps and deck-rx that's much quieter than other apps.
//
// Applied once just before audioOutput.write() (covers naudiodon + icecast):
//   1. per-mode makeup (MODE_MAKEUP) — a STATIC per-band gain that lifts each
//      mode to a common loudness. This is the PRIMARY leveller: it aligns the
//      bands and boosts the level with NO dynamic gain motion, so there's no
//      audible level-riding / pumping. Tunable per host via cfg.audioMakeup.
//   2. output AGC (OutputLeveler) — OPTIONAL (cfg.audioLeveling, default OFF).
//      A slow adaptive gain that also tracks within-band signal-strength
//      changes. Off by default: the dynamic level motion is audible and some
//      find it unpleasant, so the static makeup alone is the default.
//   3. soft limiter (softLimit) — instantaneous soft ceiling so the static
//      gain can run hot near full-scale without hard-clip distortion. Peak-
//      only; it does NOT cause the slow breathing an AGC does.
//
// cfg.audioGain is a master trim multiplied on top of the makeup (both modes).

/** Per-demod-mode STATIC makeup gain. Keyed on the numeric mode index
 *  (0=NFM 1=WFM 2=AM 3=DSB 4=USB 5=CW 6=LSB 7=RAW). These set the per-band
 *  output level directly (AGC off by default), so they're calibrated to bring
 *  each band to a common loudness. Starting estimates — AM/WFM are data-
 *  informed, the rest rougher; fine-tune by ear via cfg.audioMakeup (no
 *  rebuild) or here. CW is < 1 because the demod's CW AGC already normalises
 *  the BFO tone to ~12000. */
export const MODE_MAKEUP: Record<number, number> = {
  0: 5,    // NFM
  1: 10,   // WFM
  2: 3,    // AM
  3: 5,    // DSB (→ FM)
  4: 3,    // USB
  5: 0.6,  // CW (demod CW-AGC already at ~12000)
  6: 3,    // LSB
  7: 5,    // RAW (→ FM)
};

export const INT16_MAX = 32767;

/** Smooth soft-knee limiter. Linear below `ceil*kneeFrac`, then tanh-compressed
 *  up to (never past) `ceil`. C1-continuous at the knee (tanh'(0)=1 matches the
 *  linear slope) so there's no kink. Returns an integer in Int16 range. */
export function softLimit(x: number, ceil = INT16_MAX, kneeFrac = 0.85): number {
  const T = ceil * kneeFrac;
  const a = x < 0 ? -x : x;
  if (a <= T) return Math.round(x);
  const span = ceil - T;
  const compressed = T + span * Math.tanh((a - T) / span);
  return Math.round(x < 0 ? -compressed : compressed);
}

export interface LevelerCfg {
  /** Desired post-leveling RMS in Int16 units (~7500 ≈ -12.8 dBFS). */
  targetRms: number;
  /** Gain ceiling — caps how hard weak signals (and noise) get pushed. */
  maxGain: number;
  /** Gain floor — lets hot modes (SSB fixed 48000) be attenuated. */
  minGain: number;
  /** Time constant (s) for gain DECREASING (signal too loud) — fast. */
  attackTc: number;
  /** Time constant (s) for gain INCREASING (signal too quiet) — slow. */
  releaseTc: number;
  /** Below this makeup-applied input RMS, hold gain (don't pump up silence/noise). */
  noiseFloorRms: number;
  /** When false the AGC is bypassed (gain pinned to 1) — flat fallback. */
  enabled: boolean;
}

export const DEFAULT_LEVELER_CFG: LevelerCfg = {
  targetRms: 7500,
  maxGain: 16,
  minGain: 0.05,
  attackTc: 0.12,
  releaseTc: 1.5,
  noiseFloorRms: 40,
  enabled: true,
};

/** Stateful per-buffer output AGC. `gain` is the multiplier the caller applies
 *  to the makeup-scaled PCM. Drives buffer RMS toward cfg.targetRms with
 *  asymmetric attack/release; holds during near-silence and (caller's job)
 *  during mute. */
export class OutputLeveler {
  gain = 1;
  private cfg: LevelerCfg;

  constructor(cfg: Partial<LevelerCfg> = {}) {
    this.cfg = { ...DEFAULT_LEVELER_CFG, ...cfg };
  }

  configure(partial: Partial<LevelerCfg>): void {
    this.cfg = { ...this.cfg, ...partial };
  }

  getConfig(): Readonly<LevelerCfg> {
    return this.cfg;
  }

  /** RMS over all (interleaved) samples of the makeup-applied buffer. */
  static rms(pcm: Int16Array | number[], makeup: number): number {
    const n = pcm.length;
    if (n === 0) return 0;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const s = pcm[i] * makeup;
      sumSq += s * s;
    }
    return Math.sqrt(sumSq / n);
  }

  /** Advance `gain` one buffer toward the target. `dt` is the buffer duration
   *  in seconds (frames / audioRate). Returns the updated gain. */
  observe(pcm: Int16Array | number[], makeup: number, dt: number): number {
    if (!this.cfg.enabled) {
      this.gain = 1;
      return this.gain;
    }
    const rms = OutputLeveler.rms(pcm, makeup);
    if (rms < this.cfg.noiseFloorRms) return this.gain; // hold on near-silence
    let desired = this.cfg.targetRms / rms;
    if (desired > this.cfg.maxGain) desired = this.cfg.maxGain;
    else if (desired < this.cfg.minGain) desired = this.cfg.minGain;
    const tc = desired < this.gain ? this.cfg.attackTc : this.cfg.releaseTc;
    const alpha = dt > 0 && tc > 0 ? 1 - Math.exp(-dt / tc) : 1;
    this.gain += (desired - this.gain) * alpha;
    return this.gain;
  }

  /** Seed the gain straight to the target for this buffer (no time constant)
   *  — e.g. on unmute so audio returns at full level immediately instead of
   *  ramping up over the slow release TC. Holds on near-silence (nothing to
   *  seed against). Returns the updated gain. */
  snap(pcm: Int16Array | number[], makeup: number): number {
    if (!this.cfg.enabled) {
      this.gain = 1;
      return this.gain;
    }
    const rms = OutputLeveler.rms(pcm, makeup);
    if (rms < this.cfg.noiseFloorRms) return this.gain;
    let desired = this.cfg.targetRms / rms;
    if (desired > this.cfg.maxGain) desired = this.cfg.maxGain;
    else if (desired < this.cfg.minGain) desired = this.cfg.minGain;
    this.gain = desired;
    return this.gain;
  }

  reset(): void {
    this.gain = 1;
  }
}
