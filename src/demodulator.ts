import { Biquad } from './dspFilters.js';

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
  // AM-specific bandwidth filter (post-envelope, before user LPF/HPF)
  private amLpf = new Biquad();
  private amLpfEnabled = false;
  // Complex IF filter applied to I/Q BEFORE envelope detection.
  // Without this, AM mode at e.g. 693 kHz captures any signal within
  // ±114 kHz (the IQ half-bandwidth) — including a strong 594 kHz station.
  private amIfLpfI = new Biquad();
  private amIfLpfQ = new Biquad();
  private amIfRate = 0;
  // AM Carrier AGC
  private amAgcEnabled = false;
  private amAgcGain = 1.0;
  private amAgcAttack = 0.05;   // fast rise (per-sample factor)
  private amAgcDecay = 0.0005;  // slow fall
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

  reset(): void {
    this.prevI = 0; this.prevQ = 0;
    this.amDc = 0;
    this.amAgcGain = 1.0;  // critical: stale gain from previous station starves weak ones
    this.deempY = this.deempL = this.deempR = 0;
    this.lpfL.reset(); this.hpfL.reset();
    this.lpfR.reset(); this.hpfR.reset();
    this.amLpf.reset();
    this.amIfLpfI.reset(); this.amIfLpfQ.reset();
    this.lprLpf.reset(); this.lmrLpf.reset();
    this.pilotBpf.reset();
    this.pilotPower = 0;
    this.pllPhase = 0;
    this.pllFreqOffset = 0;
    this.pllPdI = 0;
    this.pllPdQ = 0;
    this.pllLocked = false;
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
    if (bwHz > 0 && bwHz < audioRate * 0.45) {
      this.amLpf.setLowPass(audioRate, bwHz);
      this.amLpfEnabled = true;
    } else {
      this.amLpfEnabled = false;
    }
    // IF LPF on I/Q at half bandwidth (complex bandwidth = 2× real BW)
    if (typeof iqRate === 'number' && iqRate > 0 && bwHz > 0) {
      this.amIfRate = iqRate;
      const cutoff = bwHz / 2;
      this.amIfLpfI.setLowPass(iqRate, cutoff);
      this.amIfLpfQ.setLowPass(iqRate, cutoff);
    }
  }
  /** Carrier AGC for AM. Attack/decay are per-sample IIR factors (0..1). */
  setAmAgc(enabled: boolean, attack?: number, decay?: number): void {
    this.amAgcEnabled = enabled;
    if (typeof attack === 'number') this.amAgcAttack = Math.max(0, Math.min(1, attack));
    if (typeof decay  === 'number') this.amAgcDecay  = Math.max(0, Math.min(1, decay));
    if (!enabled) this.amAgcGain = 1.0;
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
  processFM(iq: Buffer, decimate: number, gain = 24000): Int16Array {
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
  processWFM(iq: Buffer, decimate: number, gain = 16000): Int16Array {
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
  processWFMStereo(iq: Buffer, decimate: number, gain = 12000): Int16Array {
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
      // Lock magnitude (smoothed) — used by UI as stereo lock indicator
      const pdMag = Math.sqrt(this.pllPdI * this.pllPdI + this.pllPdQ * this.pllPdQ);
      this.pilotPower = 0.999 * this.pilotPower + 0.001 * pdMag;
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

  // AM envelope detector with DC removal, optional bandwidth filter, AGC, and user filters.
  processAM(iq: Buffer, decimate: number, gain = 8): Int16Array {
    const inSamples = iq.length >> 2;
    const outSamples = Math.floor(inSamples / decimate);
    const out = new Int16Array(outSamples * 2);
    let oi = 0;
    const alpha = 0.001;
    // AGC ON path: tracks mean |v|, normalises to targetLevel. Peaks are ~3x
    // mean for typical AM, so targetLevel=10000 keeps peaks within int16.
    const targetLevel = 10000;
    // AGC OFF path: pre-IF-filter signal has noise dominating (gain=8 sized
    // for that). Post-IF-filter gives cleaner / larger AC amplitude — bring
    // gain down to keep peaks within int16 without runaway.
    const fixedGain = this.amAgcEnabled ? gain : 2;
    // First pass at IQ rate: pre-envelope complex IF LPF (rejects off-center
    // stations within the wide IQ passband). Runs every IQ sample.
    const ifFilter = this.amIfRate > 0;
    for (let i = 0; i < inSamples; i++) {
      const Iraw = iq.readInt16LE(i * 4);
      const Qraw = iq.readInt16LE(i * 4 + 2);
      const I = ifFilter ? this.amIfLpfI.step(Iraw) : Iraw;
      const Q = ifFilter ? this.amIfLpfQ.step(Qraw) : Qraw;
      if (i % decimate === 0 && oi < outSamples) {
        const mag = Math.sqrt(I * I + Q * Q);
        this.amDc = this.amDc * (1 - alpha) + mag * alpha;
        let v = (mag - this.amDc) * fixedGain;
        // AM bandwidth limit (post-envelope LPF)
        if (this.amLpfEnabled) v = this.amLpf.step(v);
        // Carrier AGC: track |v| with asymmetric attack/decay, normalize to target
        if (this.amAgcEnabled) {
          const absV = Math.abs(v) + 1;
          const factor = absV > this.amAgcGain ? this.amAgcAttack : this.amAgcDecay;
          this.amAgcGain += factor * (absV - this.amAgcGain);
          v = v * (targetLevel / Math.max(1, this.amAgcGain));
        }
        if (this.lpfEnabled) v = this.lpfL.step(v);
        if (this.hpfEnabled) v = this.hpfL.step(v);
        const s = v >= 32767 ? 32767 : v <= -32767 ? -32767 : (v | 0);
        out[oi * 2] = s; out[oi * 2 + 1] = s;
        oi++;
      }
    }
    return out;
  }
}
