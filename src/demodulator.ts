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
  // Diagnostic — RMS of IQ before/after the production IF LPF for one packet.
  private amDiagPreRms = 0;
  private amDiagPostRms = 0;
  // Last packet's post-IF-LPF I/Q (for diagnostic spectrum analysis from outside).
  private amDiagPostI: Float64Array = new Float64Array(0);
  private amDiagPostQ: Float64Array = new Float64Array(0);
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
    this.amAgcGain = 1.0;  // critical: stale gain from previous station starves weak ones
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
    // AGC OFF path: now that the 16th-order IF LPF cleans the I/Q, post-
    // envelope AC amplitude is small but predictable. ×32 brings the output
    // level up to roughly match WFM/WFMStereo demod for typical broadcast
    // signal strengths so a single Volume setting works across modes.
    // Strong stations may clip on peaks; that's the trade-off for "no AGC".
    const fixedGain = this.amAgcEnabled ? gain : 32;
    // First pass at IQ rate: pre-envelope complex IF LPF (rejects off-center
    // stations within the wide IQ passband). Runs every IQ sample.
    const ifFilter = this.amIfRate > 0;
    let preSumSq = 0, postSumSq = 0;
    if (this.amDiagPostI.length !== inSamples) {
      this.amDiagPostI = new Float64Array(inSamples);
      this.amDiagPostQ = new Float64Array(inSamples);
    }
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
      if (i % decimate === 0 && oi < outSamples) {
        const mag = Math.sqrt(I * I + Q * Q);
        this.amDc = this.amDc * (1 - alpha) + mag * alpha;
        let v = (mag - this.amDc) * fixedGain;
        // AM bandwidth limit (post-envelope LPF, cascaded for steeper rolloff).
        if (this.amLpfEnabled) {
          v = this.amLpf[0].step(v);
          v = this.amLpf[1].step(v);
          v = this.amLpf[2].step(v);
          v = this.amLpf[3].step(v);
        }
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
    this.amDiagPreRms  = Math.sqrt(preSumSq  / Math.max(1, inSamples));
    this.amDiagPostRms = Math.sqrt(postSumSq / Math.max(1, inSamples));
    return out;
  }
}
