import { Biquad } from './dspFilters.js';

// AM AGC tuning constants (SDR++ port). Equivalents of dsp::demod::AM init
// args: setPoint (target |IQ|), maxGain (cap), maxOutputAmp (look-ahead
// trigger threshold). Output threshold is 10× setPoint to mirror SDR++'s
// (setPoint=1.0, maxOutputAmp=10.0) ratio — anything tighter would fire the
// O(N) look-ahead scan on every modulation peak of a typical broadcast AM
// (peak ≈ setPoint·1.8 at 80 % modulation), spiking CPU and producing
// audible glitches.
const AM_AGC_SET_POINT  = 16000;
const AM_AGC_MAX_GAIN   = 1e6;
const AM_AGC_MAX_OUTPUT = 160000;
// Look-ahead horizon — bounded so even if the threshold is mis-tuned the
// scan never grows beyond a fixed cost. 256 decimated samples ≈ 4.5 ms at
// 57 kHz audio rate, plenty to catch any imminent peak that matters.
const AM_AGC_LOOK_AHEAD_SAMPLES = 256;

export class Demodulator {
  private prevI = 0;
  private prevQ = 0;
  private amDc = 0;
  // De-emphasis IIR state (WFM)
  private deempY = 0;
  private deempL = 0;
  private deempR = 0;
  private deempAlpha = 1;
  // Audio band filters (apply at output rate, after de-emphasis).
  // Separate L/R instances — sharing one Biquad across stereo channels would
  // mix internal state z1/z2 between channels and destroy separation.
  private lpfL = new Biquad();
  private hpfL = new Biquad();
  private lpfR = new Biquad();
  private hpfR = new Biquad();
  private lpfEnabled = false;
  private hpfEnabled = false;
  // AM-specific bandwidth filter (post-envelope, before user LPF/HPF).
  // 4 cascaded biquads → 8th-order Butterworth at the audio bandwidth limit.
  // A single biquad let 9 kHz heterodyne beats (from 9 kHz-offset neighbours
  // surviving the IF stage at very low level) bleed into the audio, even
  // after the IF LPF cleaned up the I/Q.
  private amLpf: Biquad[] = Array.from({ length: 4 }, () => new Biquad());
  private amLpfEnabled = false;
  // Complex IF filter applied to I/Q BEFORE envelope detection.
  // 8 cascaded biquads → 16th-order Butterworth (~−96 dB/oct stopband).
  // The earlier 8th-order version still let 9 kHz-offset neighbour stations
  // through at ~−48 dB (one octave above 4.5 kHz cutoff), which the AM
  // envelope detector's nonlinearity demodulated as audible cross-talk
  // (e.g. 1305/1323 kHz audible while tuned to defunct 1314 kHz).
  private amIfLpfI: Biquad[] = Array.from({ length: 8 }, () => new Biquad());
  private amIfLpfQ: Biquad[] = Array.from({ length: 8 }, () => new Biquad());
  private amIfRate = 0;
  // Independent IF LPF copy used only by diagnostics so the production
  // filter state isn't disturbed by spectrum measurements.
  private diagIfLpfI: Biquad[] = Array.from({ length: 8 }, () => new Biquad());
  private diagIfLpfQ: Biquad[] = Array.from({ length: 8 }, () => new Biquad());
  // AM Carrier AGC — SDR++ port (dsp::loop::AGC + dsp::demod::AM CARRIER mode).
  // Tracks |IQ| amplitude with asymmetric attack/decay EWMA, applies
  // gain = setPoint/amp to the complex IQ stream BEFORE envelope detection.
  // Look-ahead clipping prevention scans the remainder of the buffer when
  // gain*amp would exceed AM_AGC_MAX_OUTPUT (e.g. AGC tracker far behind a
  // sudden peak), then snaps amp to the upcoming max and recomputes gain.
  private amAgcEnabled = false;
  private amAgcAmp = 0;          // EWMA-tracked input |IQ|; 0 ⇒ first sample triggers look-ahead
  private amAgcAttack = 50 / 57000;  // α per-sample at 57 kHz, default = SDR++ slider 50 (rate Hz)
  private amAgcDecay  = 5  / 57000;  // default = SDR++ slider 5
  // Synchronous AM detection (DSB sync). When enabled, a 2-nd order PLL
  // tracks the AM carrier phase and we de-rotate the IQ stream to recover
  // (1 + m(t))·amp directly on the I axis instead of the noisy
  // |I + jQ| envelope. Eliminates selective-fading distortion (carrier
  // dropout doesn't smear into the audio) and tolerates carrier-frequency
  // offsets — critical for HF/SW listening. Default OFF; envelope detect
  // remains the original path.
  private amSyncEnabled = false;
  private amSyncPhase = 0;       // PLL phase (rad)
  private amSyncFreq  = 0;       // PLL freq offset (rad/sample)
  private amSyncAlpha = 0;       // proportional loop coefficient (set per audioRate)
  private amSyncBeta  = 0;       // integral loop coefficient
  // Smoothed cos(phaseErr) for lock detection. 1 = perfectly locked, 0 = mid
  // acquisition, near-0 = unlocked. Used to gate the audio output during
  // pull-in so the loud carrier-baseband beat doesn't blast the speaker.
  private amSyncCos = 0;
  // Stereo decode filters (run at IQ rate)
  private lprLpf = new Biquad();    // L+R lowpass 15 kHz
  private lmrLpf = new Biquad();    // L-R lowpass 15 kHz
  private pilotBpf = new Biquad();  // 19 kHz pilot bandpass (PLL pre-filter)
  private stereoConfigured = false;
  // PLL state (Costas-style, locks to 19 kHz pilot, generates 38 kHz reference)
  private pllPhase = 0;
  private pllFreqOffset = 0;
  private pllPdI = 0;
  private pllPdQ = 0;
  private pllNominalDelta = 0;
  private pllAlpha = 0;
  private pllBeta = 0;
  private pllPdLpfAlpha = 0;
  // Pilot lock indicator (magnitude of phase-detector DC components)
  private pilotPower = 0;  // PLL lock magnitude (smoothed)
  private pllLocked = false;  // hysteresis state
  /** Linear power of 19 kHz pilot, smoothed. ~10x larger when stereo broadcast. */
  getPilotPower(): number { return this.pilotPower; }
  /** True iff the FM stereo PLL has hysteretic lock on the 19 kHz pilot.
   *  Used internally to gate L−R into the audio path. Thresholds (lock
   *  >0.0008 / unlock <0.0003) are intentionally LOW so weak / fluctuating
   *  pilots still produce audible stereo when present. NOT suitable for
   *  the STEREO badge — noise floor at 19 kHz alone can sustain pilot
   *  power above 0.0008 on a quiet channel, falsely tripping the lock.
   *  Use `getStereoBadgeLock()` for the dial's badge instead. */
  getPllLocked(): boolean { return this.pllLocked; }
  /** Stricter hysteretic lock (lock >0.005 / unlock <0.002) for the
   *  STEREO badge — well above the typical noise-floor pilot power on
   *  empty channels but below the bottom of the "actually receiving
   *  stereo" range (~0.001-0.05 per architecture.md). 5:2 hysteresis
   *  prevents flap; reset() clears so a freq / mode change starts at
   *  unlocked. */
  getStereoBadgeLock(): boolean { return this.stereoBadgeLocked; }
  private stereoBadgeLocked = false;
  // Diagnostic — RMS of IQ before/after the production IF LPF for one packet.
  private amDiagPreRms = 0;
  private amDiagPostRms = 0;
  // Last packet's post-IF-LPF I/Q (for diagnostic spectrum analysis from outside).
  private amDiagPostI: Float64Array = new Float64Array(0);
  private amDiagPostQ: Float64Array = new Float64Array(0);

  // SSB demod state (Weaver method). One shared Mix oscillator at f_off
  // (audio mid-band, default 1500 Hz) handles both the down-mix and up-mix
  // stages; the LPFs limit the audio bandwidth to ±f_off around the
  // suppressed carrier (so total audio band ≈ 0..3 kHz with the default).
  private ssbPhase = 0;
  private ssbPhaseInc = 0;
  private ssbLpfI: Biquad[] = Array.from({ length: 2 }, () => new Biquad());
  private ssbLpfQ: Biquad[] = Array.from({ length: 2 }, () => new Biquad());
  private ssbConfiguredIqRate = 0;
  private ssbConfiguredAudioRate = 0;
  private ssbConfiguredOffset = 0;
  getAmDiag(): { pre: number; post: number } {
    return { pre: this.amDiagPreRms, post: this.amDiagPostRms };
  }
  /** Single-bin DFT of the production-IF-LPF output captured during the
   *  most recent processAM() call. dBFS relative to int16 full-scale. */
  measurePostIfChannelPowers(iqRate: number, offsetsHz: number[]): number[] {
    const N = this.amDiagPostI.length;
    if (N === 0) return offsetsHz.map(() => -120);
    const out: number[] = [];
    for (const f of offsetsHz) {
      const w = 2 * Math.PI * f / iqRate;
      let accI = 0, accQ = 0;
      for (let n = 0; n < N; n++) {
        const c = Math.cos(w * n);
        const s = Math.sin(w * n);
        accI += this.amDiagPostI[n] * c + this.amDiagPostQ[n] * s;
        accQ += this.amDiagPostQ[n] * c - this.amDiagPostI[n] * s;
      }
      const meanSq = (accI * accI + accQ * accQ) / (N * N);
      const dbfs = meanSq > 1 ? 10 * Math.log10(meanSq / (32767 * 32767)) : -120;
      out.push(dbfs);
    }
    return out;
  }

  reset(): void {
    this.prevI = 0; this.prevQ = 0;
    this.amDc = 0;
    this.amAgcAmp = 0;  // 0 ⇒ first sample of new station triggers look-ahead, normalises immediately
    this.amSyncPhase = 0;
    this.amSyncFreq = 0;
    this.amSyncCos = 0;
    this.deempY = this.deempL = this.deempR = 0;
    this.lpfL.reset(); this.hpfL.reset();
    this.lpfR.reset(); this.hpfR.reset();
    for (const b of this.amLpf) b.reset();
    for (const b of this.amIfLpfI) b.reset();
    for (const b of this.amIfLpfQ) b.reset();
    this.lprLpf.reset(); this.lmrLpf.reset();
    this.pilotBpf.reset();
    this.pilotPower = 0;
    this.pllPhase = 0;
    this.pllFreqOffset = 0;
    this.pllPdI = 0;
    this.pllPdQ = 0;
    this.pllLocked = false;
    this.stereoBadgeLocked = false;
    this.ssbPhase = 0;
    for (const b of this.ssbLpfI) b.reset();
    for (const b of this.ssbLpfQ) b.reset();
    this.cwPhase = 0;
  }

  /** Configure the SSB Weaver oscillator + LPF. Idempotent — re-applies
   *  only when the (iqRate, audioRate, fOffset) triple changes. */
  setupSsb(iqRate: number, audioRate: number, fOffsetHz = 1500): void {
    if (this.ssbConfiguredIqRate === iqRate &&
        this.ssbConfiguredAudioRate === audioRate &&
        this.ssbConfiguredOffset === fOffsetHz) return;
    this.ssbPhaseInc = 2 * Math.PI * fOffsetHz / iqRate;
    // 4th-order Butterworth LPF (2 cascaded biquads). Q values:
    //   Q_k = 1/(2·sin((2k−1)·π/8)),  k=1..2  →  0.5412, 1.3066
    const Q4 = [0.5411961001, 1.3065629649];
    for (let k = 0; k < 2; k++) {
      this.ssbLpfI[k].setLowPass(audioRate, fOffsetHz, Q4[k]);
      this.ssbLpfQ[k].setLowPass(audioRate, fOffsetHz, Q4[k]);
    }
    this.ssbConfiguredIqRate = iqRate;
    this.ssbConfiguredAudioRate = audioRate;
    this.ssbConfiguredOffset = fOffsetHz;
  }

  // CW demod state — direct frequency-shift (NOT the Weaver path SSB takes).
  // CW receives an *unsuppressed* carrier (DC after direct conversion); the
  // BFO oscillator simply rotates the complex IQ by +f_bfo so the carrier
  // appears as an audible f_bfo tone. Weaver-style up/down mix would null
  // the DC out — wrong shape for CW.
  private cwPhase = 0;
  private cwPhaseInc = 0;
  private cwConfiguredIqRate = 0;
  private cwConfiguredBfo = 0;

  /** Configure for CW reception. f_bfo (default 700 Hz) is the audible
   *  pitch the unmodulated carrier will be shifted to. Pre-tune the
   *  receiver so the CW signal sits exactly on the suppressed-carrier
   *  reference (= IQ DC); the BFO mix lifts it into the audio band. */
  setupCw(iqRate: number, _audioRate: number, bfoHz = 700): void {
    if (this.cwConfiguredIqRate === iqRate && this.cwConfiguredBfo === bfoHz) return;
    this.cwPhaseInc = 2 * Math.PI * bfoHz / iqRate;
    this.cwConfiguredIqRate = iqRate;
    this.cwConfiguredBfo = bfoHz;
    void _audioRate; // reserved for a future narrow audio bandpass
  }

  /** CW demodulator: rotate the complex IQ stream by +f_bfo so the
   *  unmodulated carrier (DC at direct-conversion baseband) becomes an
   *  audible tone at f_bfo. Output = real part of the rotated stream. */
  // CW direct-shift demod produces audio at the BFO tone amplitude, which
  // for typical 国内 amateur signals lands well below AM envelope levels.
  // Same 4x boost (12000 → 48000) as processSSB above for matching
  // output loudness.
  processCW(iq: Buffer, decimate: number, gain = 48000): Int16Array {
    const inSamples = iq.length >> 2;
    const outSamples = Math.floor(inSamples / decimate);
    const out = new Int16Array(outSamples * 2);
    let oi = 0;
    for (let i = 0; i < inSamples; i++) {
      const I = iq.readInt16LE(i * 4);
      const Q = iq.readInt16LE(i * 4 + 2);
      const c = Math.cos(this.cwPhase);
      const s = Math.sin(this.cwPhase);
      // Rotate IQ by +f_bfo: new_I = I·cos − Q·sin, new_Q = I·sin + Q·cos.
      // Audio = real part = new_I.
      const audio = I * c - Q * s;
      this.cwPhase += this.cwPhaseInc;
      if (this.cwPhase > 2 * Math.PI) this.cwPhase -= 2 * Math.PI;
      if (i % decimate !== 0 || oi >= outSamples) continue;
      const v = (audio * gain) / 16000;
      const sample = v >= 32767 ? 32767 : v <= -32767 ? -32767 : (v | 0);
      out[oi * 2] = sample;
      out[oi * 2 + 1] = sample;
      oi++;
    }
    return out;
  }

  /**
   * Single-sideband demodulator using the Weaver method.
   *
   *   Stage 1: mix the IQ stream down by f_off (audio mid-band)
   *      I'(t) =  I·cos(ω·t) + Q·sin(ω·t)
   *      Q'(t) = -I·sin(ω·t) + Q·cos(ω·t)
   *   Stage 2: low-pass filter both at f_off → keeps ±f_off → 0..2·f_off
   *            after the up-mix (typical voice band 0..3 kHz with f_off=1.5 k)
   *   Stage 3: mix back up by f_off
   *      USB(t) = I'·cos(ω·t) − Q'·sin(ω·t)
   *
   * LSB shares the USB code path by flipping the sign of the input Q before
   * mixing — equivalent to running Weaver against the conjugate IQ stream,
   * which inverts which sideband survives the LPF stage.
   *
   * Output is stereo-interleaved Int16 (L = R = audio).
   * Caller must invoke setupSsb() once after constructing the demodulator
   * (or whenever iqRate / audioRate / fOffset change).
   */
  // SSB Weaver demod outputs roughly 4x quieter audio than AM envelope
  // detection for the same input IQ level (narrow 2.4 kHz audio band +
  // demod path divides energy across in-phase / quadrature). With the
  // earlier `gain = 12000` default, 国内 ham QSOs at typical signal
  // strength were barely audible even at SDR RF gain 8/8 — bumped to
  // 48000 (4x) so signals come out at ~AM listening level.
  processSSB(iq: Buffer, decimate: number, sideBand: 'USB' | 'LSB', gain = 48000): Int16Array {
    const inSamples = iq.length >> 2;
    const outSamples = Math.floor(inSamples / decimate);
    const out = new Int16Array(outSamples * 2);
    const qSign = sideBand === 'USB' ? 1 : -1;
    let oi = 0;
    for (let i = 0; i < inSamples; i++) {
      const I =          iq.readInt16LE(i * 4);
      const Q = qSign * iq.readInt16LE(i * 4 + 2);
      const c = Math.cos(this.ssbPhase);
      const s = Math.sin(this.ssbPhase);
      const Ip =  I * c + Q * s;   // mix-down I  (rotate IQ by −ω·t)
      const Qp = -I * s + Q * c;   // mix-down Q
      this.ssbPhase += this.ssbPhaseInc;
      if (this.ssbPhase > 2 * Math.PI) this.ssbPhase -= 2 * Math.PI;
      if (i % decimate !== 0 || oi >= outSamples) continue;
      // LPF runs at audio rate (post-decimation).
      let lpI = Ip;
      for (const b of this.ssbLpfI) lpI = b.step(lpI);
      let lpQ = Qp;
      for (const b of this.ssbLpfQ) lpQ = b.step(lpQ);
      // Up-mix (USB convention; the Q-sign flip above gives us LSB for free).
      const audio = lpI * c - lpQ * s;
      const v = (audio * gain) / 16000;
      const sample = v >= 32767 ? 32767 : v <= -32767 ? -32767 : (v | 0);
      out[oi * 2] = sample;
      out[oi * 2 + 1] = sample;
      oi++;
    }
    return out;
  }

  setDeemphasis(audioRate: number, tau: number): void {
    if (tau <= 0) { this.deempAlpha = 1; return; }
    const dt = 1 / audioRate;
    this.deempAlpha = dt / (tau + dt);
  }

  /**
   * AM bandwidth — sets BOTH the post-envelope audio LPF (audioRate) AND the
   * pre-envelope complex IF LPF on I/Q (iqRate). The complex IF filter is the
   * critical one: without it, off-center stations bleed through the envelope
   * detector regardless of tuned frequency.
   */
  setAmBandwidth(audioRate: number, bwHz: number, iqRate?: number): void {
    // Post-envelope audio LPF: 8th-order Butterworth via 4 cascaded biquads.
    // Per-stage Q for true Butterworth: Q_k = 1/(2·sin((2k−1)π/16)), k=1..4.
    if (bwHz > 0 && bwHz < audioRate * 0.45) {
      const Q4 = [0.5097955791, 0.6013447997, 0.9000000000, 2.5629154497];
      for (let k = 0; k < 4; k++) this.amLpf[k].setLowPass(audioRate, bwHz, Q4[k]);
      this.amLpfEnabled = true;
    } else {
      this.amLpfEnabled = false;
    }
    // IF LPF on I/Q at half bandwidth (complex bandwidth = 2× real BW).
    // 16th-order Butterworth via 8 cascaded biquads. Per-stage Q values for
    // a true Butterworth response: Q_k = 1/(2·sin((2k−1)π/32)), k=1..8.
    if (typeof iqRate === 'number' && iqRate > 0 && bwHz > 0) {
      this.amIfRate = iqRate;
      const cutoff = bwHz / 2;
      const Q8 = [
        0.5024193, 0.5226258, 0.5669004, 0.6471488,
        0.7881546, 1.0606777, 1.7224471, 5.1011487,
      ];
      for (let k = 0; k < 8; k++) {
        this.amIfLpfI[k].setLowPass(iqRate, cutoff, Q8[k]);
        this.amIfLpfQ[k].setLowPass(iqRate, cutoff, Q8[k]);
      }
    }
  }
  /** Carrier AGC for AM. Attack/decay are per-sample IIR factors α (0..1).
   *  Convert from SDR++ rate (1/τ_seconds) at the caller via α = rate / fs. */
  setAmAgc(enabled: boolean, attack?: number, decay?: number): void {
    this.amAgcEnabled = enabled;
    if (typeof attack === 'number') this.amAgcAttack = Math.max(0, Math.min(1, attack));
    if (typeof decay  === 'number') this.amAgcDecay  = Math.max(0, Math.min(1, decay));
    if (!enabled) this.amAgcAmp = 0;
  }

  /** Synchronous AM detection. Configures a 2-nd order PLL with critically
   *  damped 10 Hz natural frequency (slow enough to ignore audio modulation
   *  > 50 Hz, fast enough for SW propagation drift). audioRate is the rate
   *  at which processAM is called per output sample (i.e. the decimated
   *  audio rate). */
  setAmSync(enabled: boolean, audioRate: number): void {
    const wasEnabled = this.amSyncEnabled;
    this.amSyncEnabled = enabled;
    if (audioRate > 0) {
      // 30 Hz natural freq: fast enough to pull-in ±1 kHz offsets in
      // ~1 second, slow enough to ignore the 50 Hz+ audio band on AM.
      const wn = 2 * Math.PI * 30 / audioRate;  // rad/sample
      const zeta = 0.707;
      this.amSyncAlpha = 2 * zeta * wn;
      this.amSyncBeta  = wn * wn;
    }
    if (!wasEnabled && enabled) {
      this.amSyncPhase = 0;
      this.amSyncFreq = 0;
      this.amSyncCos = 0;
    }
  }

  setAudioFilters(audioRate: number, lpfHz: number, hpfHz: number): void {
    if (lpfHz > 0 && lpfHz < audioRate * 0.45) {
      this.lpfL.setLowPass(audioRate, lpfHz);
      this.lpfR.setLowPass(audioRate, lpfHz);
      this.lpfEnabled = true;
    } else {
      this.lpfEnabled = false;
    }
    if (hpfHz > 0) {
      this.hpfL.setHighPass(audioRate, hpfHz);
      this.hpfR.setHighPass(audioRate, hpfHz);
      this.hpfEnabled = true;
    } else {
      this.hpfEnabled = false;
    }
  }

  /** Configure stereo decode filters and PLL for given IQ rate. */
  setStereo(iqRate: number): void {
    this.lprLpf.setLowPass(iqRate, 15000);
    this.lmrLpf.setLowPass(iqRate, 15000);
    this.pilotBpf.setBandPass(iqRate, 19000, 30);
    // PLL coefficients: standard 2nd-order PLL with damping = 1/√2,
    // loop bandwidth ~50 Hz (FM stereo industry typical 30-100 Hz).
    this.pllNominalDelta = 2 * Math.PI * 19000 / iqRate;
    const bwHz = 50;
    const damp = Math.SQRT1_2;
    const omegaN = 2 * Math.PI * bwHz;
    this.pllAlpha = 2 * damp * omegaN / iqRate;
    this.pllBeta = (omegaN * omegaN) / (iqRate * iqRate);
    // Phase-detector LPF cutoff at 5x loop BW for stable PD output
    this.pllPdLpfAlpha = Math.min(1, 2 * Math.PI * (bwHz * 5) / iqRate);
    this.stereoConfigured = true;
  }
  isStereoConfigured(): boolean { return this.stereoConfigured; }

  // FM discriminator — for NFM (no de-emphasis, narrower deviation). Mono PCM out.
  processFM(iq: Buffer, decimate: number, gain = 12000): Int16Array {
    const inSamples = iq.length >> 2;
    const outSamples = Math.floor(inSamples / decimate);
    const out = new Int16Array(outSamples * 2);
    let oi = 0;
    for (let i = 0; i < inSamples; i++) {
      const I = iq.readInt16LE(i * 4);
      const Q = iq.readInt16LE(i * 4 + 2);
      const denom = I * this.prevI + Q * this.prevQ;
      const numer = Q * this.prevI - I * this.prevQ;
      let r = 0;
      if (Math.abs(denom) + Math.abs(numer) > 1) r = Math.atan2(numer, denom);
      this.prevI = I;
      this.prevQ = Q;
      if (i % decimate === 0 && oi < outSamples) {
        let v = r;
        if (this.lpfEnabled) v = this.lpfL.step(v);
        if (this.hpfEnabled) v = this.hpfL.step(v);
        v *= gain;
        const s = v >= 32767 ? 32767 : v <= -32767 ? -32767 : (v | 0);
        out[oi * 2] = s; out[oi * 2 + 1] = s;
        oi++;
      }
    }
    return out;
  }

  // WFM mono — discriminator + de-emphasis IIR + audio filters. Stereo-interleaved out (L=R).
  // Also runs the pilot BPF in parallel so the UI can detect stereo broadcasts.
  processWFM(iq: Buffer, decimate: number, gain = 8000): Int16Array {
    const inSamples = iq.length >> 2;
    const outSamples = Math.floor(inSamples / decimate);
    const out = new Int16Array(outSamples * 2);
    let oi = 0;
    const a = this.deempAlpha;
    const beta = 0.001;
    for (let i = 0; i < inSamples; i++) {
      const I = iq.readInt16LE(i * 4);
      const Q = iq.readInt16LE(i * 4 + 2);
      const denom = I * this.prevI + Q * this.prevQ;
      const numer = Q * this.prevI - I * this.prevQ;
      let r = 0;
      if (Math.abs(denom) + Math.abs(numer) > 1) r = Math.atan2(numer, denom);
      this.prevI = I;
      this.prevQ = Q;
      // Pilot tracking (always-on while WFM)
      if (this.stereoConfigured) {
        const p = this.pilotBpf.step(r);
        this.pilotPower = (1 - beta) * this.pilotPower + beta * p * p;
      }
      if (i % decimate === 0 && oi < outSamples) {
        this.deempY = a * r + (1 - a) * this.deempY;
        let v = this.deempY;
        if (this.lpfEnabled) v = this.lpfL.step(v);
        if (this.hpfEnabled) v = this.hpfL.step(v);
        v *= gain;
        const s = v >= 32767 ? 32767 : v <= -32767 ? -32767 : (v | 0);
        out[oi * 2] = s; out[oi * 2 + 1] = s;
        oi++;
      }
    }
    return out;
  }

  // WFM stereo — pilot-tone stereo decoding at IQ rate, then decimate.
  // Pipeline: FM-demod → [L+R LPF] [pilot → PLL → 38kHz ref → L-R mix → LPF]
  // → de-emph → matrix (lpr ± lmr) → output L,R interleaved.
  processWFMStereo(iq: Buffer, decimate: number, gain = 6000): Int16Array {
    if (!this.stereoConfigured) return this.processWFM(iq, decimate, gain);
    const inSamples = iq.length >> 2;
    const outSamples = Math.floor(inSamples / decimate);
    const out = new Int16Array(outSamples * 2);
    let oi = 0;
    const a = this.deempAlpha;
    for (let i = 0; i < inSamples; i++) {
      const I = iq.readInt16LE(i * 4);
      const Q = iq.readInt16LE(i * 4 + 2);
      const denom = I * this.prevI + Q * this.prevQ;
      const numer = Q * this.prevI - I * this.prevQ;
      let demod = 0;
      if (Math.abs(denom) + Math.abs(numer) > 1) demod = Math.atan2(numer, denom);
      this.prevI = I;
      this.prevQ = Q;

      // L+R baseband from FM-demodulated signal
      const lpr = this.lprLpf.step(demod);
      // Pilot extraction (narrow BPF for clean 19 kHz tone)
      const pilot = this.pilotBpf.step(demod);
      // ── PLL ── lock VCO phase to pilot ──────────────────────────────
      const cosV = Math.cos(this.pllPhase);
      const sinV = Math.sin(this.pllPhase);
      // Phase detector: mix pilot with quadrature VCO, LPF to DC components
      const ie = pilot * cosV;
      const qe = pilot * sinV;
      this.pllPdI += this.pllPdLpfAlpha * (ie - this.pllPdI);
      this.pllPdQ += this.pllPdLpfAlpha * (qe - this.pllPdQ);
      // Phase error (signed). For pilot = A·cos(ωt+φ), pdI ≈ A/2·cos(φ), pdQ ≈ -A/2·sin(φ)
      const phaseErr = -Math.atan2(this.pllPdQ, this.pllPdI);
      // PI loop filter (clamp integrator: ±0.05 rad/sample ≈ ±1.8 kHz freq offset
      // at 228 kHz IQ rate — far more than any FM stereo pilot drift, prevents
      // unbounded windup if a non-pilot signal is mistakenly tracked).
      this.pllFreqOffset += this.pllBeta * phaseErr;
      if (this.pllFreqOffset >  0.05) this.pllFreqOffset =  0.05;
      else if (this.pllFreqOffset < -0.05) this.pllFreqOffset = -0.05;
      const freqAdj = this.pllAlpha * phaseErr + this.pllFreqOffset;
      // Advance VCO phase, wrap to (-π, π]
      this.pllPhase += this.pllNominalDelta + freqAdj;
      while (this.pllPhase >  Math.PI) this.pllPhase -= 2 * Math.PI;
      while (this.pllPhase < -Math.PI) this.pllPhase += 2 * Math.PI;
      // Lock indicator (smoothed) — needs to discriminate "locked to a real
      // pilot" from "PLL latched onto a noise burst" since the PLL tries
      // to lock onto the strongest in-band signal regardless of what it is.
      //
      // For a real pilot at lock: pdI ≈ A/2, pdQ ≈ 0 (clean phase).
      // For PLL latched to noise: BOTH pdI and pdQ have similar magnitude
      // (random phase, no preferred direction). Magnitude `sqrt(pdI²+pdQ²)`
      // is positive in both cases (Rayleigh-biased on noise), and signed
      // pdI alone gets a noise-floor positive bias too because the PLL
      // tracks correlated phase even on noise.
      //
      // Phase-coherence test: `pdI − |pdQ|`. Real lock → A/2 − 0 = A/2.
      // Noise lock → both random with similar variance → averages to ~0
      // (or negative). This cleanly separates "phase coherent on a real
      // 19 kHz tone" from "PLL is just stalking RF noise."
      //
      // Threshold hysteresis below works unchanged: real-pilot pdI−|pdQ|
      // is the same magnitude as before, but noise-floor reading drops
      // toward 0 instead of positive bias.
      const lockMetric = this.pllPdI - Math.abs(this.pllPdQ);
      this.pilotPower = 0.999 * this.pilotPower + 0.001 * lockMetric;
      // 38 kHz reference: phase-locked, unit amplitude (just take cosine of doubled phase)
      const ref38 = Math.cos(2 * this.pllPhase);
      // Recover L−R baseband: mix demod with 38 kHz reference (×2 to compensate for
      // the cos·cos averaging factor of 1/2), then LPF
      const lmr = this.lmrLpf.step(demod * ref38 * 2);

      if (i % decimate === 0 && oi < outSamples) {
        // Hysteresis: typical stereo broadcasts give pilotPower ~0.001-0.05
        // depending on signal strength (we observed 0.0007 on weak signals).
        if (this.pllLocked) {
          if (this.pilotPower < 0.0003) this.pllLocked = false;
        } else {
          if (this.pilotPower > 0.0008) this.pllLocked = true;
        }
        // Separate hysteretic state with stricter thresholds for the
        // dial's STEREO badge — the L−R audio gate above wants to capture
        // weak stereo (low thresholds), but the badge should only show
        // when we're confidently above noise-floor pilot power on a quiet
        // channel.
        if (this.stereoBadgeLocked) {
          if (this.pilotPower < 0.002) this.stereoBadgeLocked = false;
        } else {
          if (this.pilotPower > 0.005) this.stereoBadgeLocked = true;
        }
        const lmrUsed = this.pllLocked ? lmr : 0;
        this.deempL = a * lpr + (1 - a) * this.deempL;
        this.deempR = a * lmrUsed + (1 - a) * this.deempR;
        let L = this.deempL + this.deempR;
        let R = this.deempL - this.deempR;
        if (this.lpfEnabled) { L = this.lpfL.step(L); R = this.lpfR.step(R); }
        if (this.hpfEnabled) { L = this.hpfL.step(L); R = this.hpfR.step(R); }
        L *= gain; R *= gain;
        out[oi * 2]     = L >= 32767 ? 32767 : L <= -32767 ? -32767 : (L | 0);
        out[oi * 2 + 1] = R >= 32767 ? 32767 : R <= -32767 ? -32767 : (R | 0);
        oi++;
      }
    }
    return out;
  }

  /**
   * Diagnostic: same single-bin DFT as measureChannelPowers, but applied
   * AFTER pushing the IQ stream through an independent copy of the IF LPF
   * (configured to the supplied bandwidth). Compare bin-by-bin against the
   * raw measurement to verify the IF LPF is delivering its theoretical
   * −96 dB/oct rolloff in practice.
   */
  measureFilteredChannelPowers(iq: Buffer, iqRate: number, bwHz: number, offsetsHz: number[]): number[] {
    const N = iq.length >> 2;
    if (N === 0 || iqRate <= 0 || bwHz <= 0) return offsetsHz.map(() => -120);
    // Configure + reset the diagnostic filter chain (16th-order Butterworth)
    const cutoff = bwHz / 2;
    const Q = [
      0.5024193, 0.5226258, 0.5669004, 0.6471488,
      0.7881546, 1.0606777, 1.7224471, 5.1011487,
    ];
    for (let k = 0; k < 8; k++) {
      this.diagIfLpfI[k].setLowPass(iqRate, cutoff, Q[k]);
      this.diagIfLpfQ[k].setLowPass(iqRate, cutoff, Q[k]);
      this.diagIfLpfI[k].reset();
      this.diagIfLpfQ[k].reset();
    }
    // Filter the whole buffer into temp arrays (Float64 to keep precision
    // since high-Q biquad outputs span a wide dynamic range).
    const Ifilt = new Float64Array(N);
    const Qfilt = new Float64Array(N);
    for (let n = 0; n < N; n++) {
      let I = iq.readInt16LE(n * 4);
      let Q2 = iq.readInt16LE(n * 4 + 2);
      for (let k = 0; k < 8; k++) {
        I  = this.diagIfLpfI[k].step(I);
        Q2 = this.diagIfLpfQ[k].step(Q2);
      }
      Ifilt[n] = I;
      Qfilt[n] = Q2;
    }
    // Skip the first chunk of samples to let the high-Q stages settle.
    const skip = Math.min(N - 1, Math.round(iqRate * 0.005)); // 5 ms warmup
    const useN = N - skip;
    const out: number[] = [];
    for (const f of offsetsHz) {
      const w = 2 * Math.PI * f / iqRate;
      let accI = 0, accQ = 0;
      for (let n = skip; n < N; n++) {
        const c = Math.cos(w * n);
        const s = Math.sin(w * n);
        accI += Ifilt[n] * c + Qfilt[n] * s;
        accQ += Qfilt[n] * c - Ifilt[n] * s;
      }
      const meanSq = (accI * accI + accQ * accQ) / (useN * useN);
      // Same int16 full-scale reference as measureChannelPowers (so the
      // two outputs can be subtracted directly to read filter attenuation).
      const dbfs = meanSq > 1 ? 10 * Math.log10(meanSq / (32767 * 32767)) : -120;
      out.push(dbfs);
    }
    return out;
  }

  /**
   * Diagnostic: power at each requested baseband-frequency offset, computed
   * from the raw IQ stream by single-bin DFT (Goertzel-style). Returns dBFS
   * (relative to int16 full-scale carrier). Useful to spot which neighbour
   * station is bleeding into the AM demodulator.
   */
  measureChannelPowers(iq: Buffer, iqRate: number, offsetsHz: number[]): number[] {
    const N = iq.length >> 2;
    if (N === 0 || iqRate <= 0) return offsetsHz.map(() => -120);
    const out: number[] = [];
    for (const f of offsetsHz) {
      const w = 2 * Math.PI * f / iqRate;
      let accI = 0, accQ = 0;
      // (I + jQ) · exp(−jωt)  =  (I + jQ)(cos ωt − j sin ωt)
      //                      =  (I·cos + Q·sin) + j(Q·cos − I·sin)
      for (let n = 0; n < N; n++) {
        const I = iq.readInt16LE(n * 4);
        const Q = iq.readInt16LE(n * 4 + 2);
        const c = Math.cos(w * n);
        const s = Math.sin(w * n);
        accI += I * c + Q * s;
        accQ += Q * c - I * s;
      }
      // Mean-square magnitude, normalised to int16 full-scale carrier (32767²).
      const meanSq = (accI * accI + accQ * accQ) / (N * N);
      const dbfs = meanSq > 1 ? 10 * Math.log10(meanSq / (32767 * 32767)) : -120;
      out.push(dbfs);
    }
    return out;
  }

  // AM envelope detector. Pipeline (with AGC ON):
  //   IQ → 16-th order IF LPF → CARRIER AGC (gain to normalise |IQ|) →
  //   envelope detect → DC blocker → AM LPF → user LPF/HPF → Int16
  // The AGC runs BEFORE envelope detection (matching SDR++ CARRIER mode);
  // operating on the complex amplitude makes weak/strong stations come out
  // at the same loudness AND avoids the audio-domain clipping that the
  // previous post-envelope AGC suffered from (initial overshoot when
  // amAgcGain started at 1.0 → first big sample produced gain ≈ 10000).
  // gainScale (0..1) lets the AGC OFF path act as a proper volume control
  // off the user's amGain ratio. With AGC ON this parameter is ignored
  // (the AGC normalises to setPoint regardless of input amplitude).
  processAM(iq: Buffer, decimate: number, gainScale = 1): Int16Array {
    const inSamples = iq.length >> 2;
    const outSamples = Math.floor(inSamples / decimate);
    const out = new Int16Array(outSamples * 2);
    const alphaDc = 0.001;
    // AGC OFF path uses a fixed gain after envelope detection, scaled by
    // the user's RF-gain ratio so the gain dial functions as a volume
    // control (Airspy HF+ has on-chip AGC that smooths over LNA changes,
    // so without this scaling the dial would have ~no audible effect).
    // ×32 at full gain lands AM at roughly WFM loudness for a single
    // Volume setting. Strong stations may clip on peaks — that's the
    // intentional trade-off for "no AGC".
    const gs = gainScale < 0 ? 0 : gainScale > 1 ? 1 : gainScale;
    const fixedGain = this.amAgcEnabled ? 1 : 32 * gs;
    const ifFilter = this.amIfRate > 0;
    if (this.amDiagPostI.length !== inSamples) {
      this.amDiagPostI = new Float64Array(inSamples);
      this.amDiagPostQ = new Float64Array(inSamples);
    }

    // Pass 1: IF LPF and population of amDiagPostI/Q. This must run in full
    // before pass 2 because the AGC look-ahead in pass 2 reads forward into
    // amDiagPostI/Q to pre-empt clipping when the tracker is far behind.
    let preSumSq = 0, postSumSq = 0;
    for (let i = 0; i < inSamples; i++) {
      const Iraw = iq.readInt16LE(i * 4);
      const Qraw = iq.readInt16LE(i * 4 + 2);
      let I = Iraw, Q = Qraw;
      preSumSq += Iraw * Iraw + Qraw * Qraw;
      if (ifFilter) {
        for (let k = 0; k < 8; k++) {
          I = this.amIfLpfI[k].step(I);
          Q = this.amIfLpfQ[k].step(Q);
        }
      }
      this.amDiagPostI[i] = I;
      this.amDiagPostQ[i] = Q;
      postSumSq += I * I + Q * Q;
    }
    this.amDiagPreRms  = Math.sqrt(preSumSq  / Math.max(1, inSamples));
    this.amDiagPostRms = Math.sqrt(postSumSq / Math.max(1, inSamples));

    // Pass 2: AGC + envelope detect at the decimated audio rate.
    const atk = this.amAgcAttack;
    const dec = this.amAgcDecay;
    const invAtk = 1 - atk;
    const invDec = 1 - dec;
    let oi = 0;
    for (let i = 0; i < inSamples && oi < outSamples; i += decimate) {
      let I = this.amDiagPostI[i];
      let Q = this.amDiagPostQ[i];

      if (this.amAgcEnabled) {
        const carrierAmp = Math.sqrt(I * I + Q * Q);
        if (carrierAmp !== 0) {
          this.amAgcAmp = (carrierAmp > this.amAgcAmp)
            ? this.amAgcAmp * invAtk + carrierAmp * atk
            : this.amAgcAmp * invDec + carrierAmp * dec;
        }
        let agcGain = Math.min(
          AM_AGC_SET_POINT / Math.max(this.amAgcAmp, 1e-3),
          AM_AGC_MAX_GAIN,
        );
        // Look-ahead clipping prevention. When the tracker is behind reality
        // (initial state, sudden amplitude jump), gain·carrierAmp can exceed
        // the safe output ceiling. Scan a bounded window of upcoming samples
        // to find the next peak, snap amAgcAmp to it, and recompute gain.
        if (carrierAmp * agcGain > AM_AGC_MAX_OUTPUT) {
          let maxAmp = carrierAmp;
          const limit = Math.min(
            inSamples,
            i + AM_AGC_LOOK_AHEAD_SAMPLES * decimate,
          );
          for (let j = i + decimate; j < limit; j += decimate) {
            const Ij = this.amDiagPostI[j];
            const Qj = this.amDiagPostQ[j];
            const a = Math.sqrt(Ij * Ij + Qj * Qj);
            if (a > maxAmp) maxAmp = a;
          }
          this.amAgcAmp = maxAmp;
          agcGain = Math.min(
            AM_AGC_SET_POINT / Math.max(maxAmp, 1e-3),
            AM_AGC_MAX_GAIN,
          );
        }
        I *= agcGain;
        Q *= agcGain;
      }

      let v: number;
      if (this.amSyncEnabled) {
        // PLL-driven sync detection: rotate IQ by -syncPhase to bring carrier
        // to true 0 Hz, then take I (= (1 + m(t))·carrierAmp). amDc still
        // tracks the carrier DC offset for subtraction.
        const c = Math.cos(this.amSyncPhase);
        const s = Math.sin(this.amSyncPhase);
        const dI = I * c + Q * s;
        const dQ = -I * s + Q * c;
        const phaseErr = Math.atan2(dQ, dI);
        this.amSyncFreq  += this.amSyncBeta * phaseErr;
        this.amSyncPhase += this.amSyncFreq + this.amSyncAlpha * phaseErr;
        if (this.amSyncPhase > Math.PI) this.amSyncPhase -= 2 * Math.PI;
        else if (this.amSyncPhase < -Math.PI) this.amSyncPhase += 2 * Math.PI;
        // Lock indicator: smoothed cos(phaseErr) with asymmetric attack/
        // release. Rising (locking) follows fast (~5 ms TC) so the gate
        // opens promptly once PLL acquires. Falling (unlocking) follows
        // slowly (~500 ms TC) so a momentary phase wobble during SW
        // selective fading doesn't drop the gate — audio keeps playing
        // through brief fades and only mutes if the unlock persists.
        const mag = Math.sqrt(dI * dI + dQ * dQ);
        const cosErr = mag > 1e-3 ? dI / mag : 0;
        const lockAlpha = cosErr > this.amSyncCos ? 0.0035 : 3.51e-5;
        this.amSyncCos = (1 - lockAlpha) * this.amSyncCos + lockAlpha * cosErr;
        const lockGate = Math.max(0, Math.min(1, (this.amSyncCos - 0.3) / 0.5));
        this.amDc = this.amDc * (1 - alphaDc) + dI * alphaDc;
        v = (dI - this.amDc) * fixedGain * lockGate;
      } else {
        const mag = Math.sqrt(I * I + Q * Q);
        this.amDc = this.amDc * (1 - alphaDc) + mag * alphaDc;
        v = (mag - this.amDc) * fixedGain;
      }

      if (this.amLpfEnabled) {
        v = this.amLpf[0].step(v);
        v = this.amLpf[1].step(v);
        v = this.amLpf[2].step(v);
        v = this.amLpf[3].step(v);
      }
      if (this.lpfEnabled) v = this.lpfL.step(v);
      if (this.hpfEnabled) v = this.hpfL.step(v);

      const s = v >= 32767 ? 32767 : v <= -32767 ? -32767 : (v | 0);
      out[oi * 2] = s; out[oi * 2 + 1] = s;
      oi++;
    }
    return out;
  }
}
