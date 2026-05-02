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
  // Audio band filters (apply at output rate, after de-emphasis)
  private lpf = new Biquad();
  private hpf = new Biquad();
  private lpfEnabled = false;
  private hpfEnabled = false;
  // AM-specific bandwidth filter (post-envelope, before user LPF/HPF)
  private amLpf = new Biquad();
  private amLpfEnabled = false;
  // AM Carrier AGC
  private amAgcEnabled = false;
  private amAgcGain = 1.0;
  private amAgcAttack = 0.05;   // fast rise (per-sample factor)
  private amAgcDecay = 0.0005;  // slow fall
  // Stereo decode filters (run at IQ rate)
  private lprLpf = new Biquad();    // L+R lowpass 15 kHz
  private lmrLpf = new Biquad();    // L-R lowpass 15 kHz
  private pilotBpf = new Biquad();  // 19 kHz pilot bandpass
  private ref38Bpf = new Biquad();  // 38 kHz reference bandpass
  private stereoConfigured = false;
  // Pilot tone detector (running power)
  private pilotPower = 0;
  /** Linear power of 19 kHz pilot, smoothed. ~10x larger when stereo broadcast. */
  getPilotPower(): number { return this.pilotPower; }

  reset(): void {
    this.prevI = 0; this.prevQ = 0;
    this.amDc = 0;
    this.amAgcGain = 1.0;  // critical: stale gain from previous station starves weak ones
    this.deempY = this.deempL = this.deempR = 0;
    this.lpf.reset(); this.hpf.reset();
    this.lprLpf.reset(); this.lmrLpf.reset();
    this.pilotBpf.reset(); this.ref38Bpf.reset();
    this.pilotPower = 0;
  }

  setDeemphasis(audioRate: number, tau: number): void {
    if (tau <= 0) { this.deempAlpha = 1; return; }
    const dt = 1 / audioRate;
    this.deempAlpha = dt / (tau + dt);
  }

  /** AM bandwidth (audio LPF after envelope detection). 0 to disable. */
  setAmBandwidth(audioRate: number, bwHz: number): void {
    if (bwHz > 0 && bwHz < audioRate * 0.45) {
      this.amLpf.setLowPass(audioRate, bwHz);
      this.amLpfEnabled = true;
    } else {
      this.amLpfEnabled = false;
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
      this.lpf.setLowPass(audioRate, lpfHz);
      this.lpfEnabled = true;
    } else {
      this.lpfEnabled = false;
    }
    if (hpfHz > 0) {
      this.hpf.setHighPass(audioRate, hpfHz);
      this.hpfEnabled = true;
    } else {
      this.hpfEnabled = false;
    }
  }

  /** Configure stereo decode filters for given IQ (post-FM-demod) rate. */
  setStereo(iqRate: number): void {
    this.lprLpf.setLowPass(iqRate, 15000);
    this.lmrLpf.setLowPass(iqRate, 15000);
    this.pilotBpf.setBandPass(iqRate, 19000, 20);  // moderate Q for faster settling
    this.ref38Bpf.setBandPass(iqRate, 38000, 15);
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
        if (this.lpfEnabled) v = this.lpf.step(v);
        if (this.hpfEnabled) v = this.hpf.step(v);
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
        if (this.lpfEnabled) v = this.lpf.step(v);
        if (this.hpfEnabled) v = this.hpf.step(v);
        v *= gain;
        const s = v >= 32767 ? 32767 : v <= -32767 ? -32767 : (v | 0);
        out[oi * 2] = s; out[oi * 2 + 1] = s;
        oi++;
      }
    }
    return out;
  }

  // WFM stereo — pilot-tone stereo decoding at IQ rate, then decimate.
  // Pipeline: FM-demod → [L+R LPF] [pilot BPF → square → 38kHz BPF → mix → L-R LPF]
  // → de-emph → matrix → output L,R interleaved.
  processWFMStereo(iq: Buffer, decimate: number, gain = 8000): Int16Array {
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

      // Stereo decode at full IQ rate
      const lpr   = this.lprLpf.step(demod);                       // L+R baseband
      const pilot = this.pilotBpf.step(demod);                     // 19 kHz tone
      this.pilotPower = 0.999 * this.pilotPower + 0.001 * pilot * pilot;
      // Generate 38 kHz reference: square pilot → BPF → normalize by pilotPower
      // (pilot^2 amplitude = A^2/2; pilotPower≈A^2/2 → divide gives ~unit amplitude)
      const ref38Raw = this.ref38Bpf.step(pilot * pilot);
      const ref38 = this.pilotPower > 1e-4 ? ref38Raw / this.pilotPower : 0;
      // Mix demod with 38 kHz ref to demodulate L-R DSB-SC, then LPF
      const lmr   = this.lmrLpf.step(demod * ref38);

      if (i % decimate === 0 && oi < outSamples) {
        // De-emphasis on L+R and L-R separately. L-R from DSB-SC mix has half
        // amplitude (cos*cos averaging), so we apply 2x in the matrix below.
        this.deempL = a * lpr + (1 - a) * this.deempL;
        this.deempR = a * lmr + (1 - a) * this.deempR;
        let L = this.deempL + 2 * this.deempR;
        let R = this.deempL - 2 * this.deempR;
        if (this.lpfEnabled) { L = this.lpf.step(L); R = this.lpf.step(R); }
        if (this.hpfEnabled) { L = this.hpf.step(L); R = this.hpf.step(R); }
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
    const targetLevel = 20000;  // target post-AGC amplitude (int16 friendly)
    for (let i = 0; i < inSamples; i++) {
      if (i % decimate === 0 && oi < outSamples) {
        const I = iq.readInt16LE(i * 4);
        const Q = iq.readInt16LE(i * 4 + 2);
        const mag = Math.sqrt(I * I + Q * Q);
        this.amDc = this.amDc * (1 - alpha) + mag * alpha;
        let v = (mag - this.amDc) * gain;
        // AM bandwidth limit (post-envelope LPF)
        if (this.amLpfEnabled) v = this.amLpf.step(v);
        // Carrier AGC: track |v| with asymmetric attack/decay, normalize to target
        if (this.amAgcEnabled) {
          const absV = Math.abs(v) + 1;
          const factor = absV > this.amAgcGain ? this.amAgcAttack : this.amAgcDecay;
          this.amAgcGain += factor * (absV - this.amAgcGain);
          v = v * (targetLevel / Math.max(1, this.amAgcGain));
        }
        if (this.lpfEnabled) v = this.lpf.step(v);
        if (this.hpfEnabled) v = this.hpf.step(v);
        const s = v >= 32767 ? 32767 : v <= -32767 ? -32767 : (v | 0);
        out[oi * 2] = s; out[oi * 2 + 1] = s;
        oi++;
      }
    }
    return out;
  }
}
