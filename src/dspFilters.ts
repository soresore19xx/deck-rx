/**
 * Biquad IIR filter — second order, transposed direct form II.
 * Standard RBJ cookbook coefficients.
 */
export class Biquad {
  private b0 = 1; private b1 = 0; private b2 = 0;
  private a1 = 0; private a2 = 0;
  private z1 = 0; private z2 = 0;

  reset(): void { this.z1 = 0; this.z2 = 0; }

  /** Low-pass at cutoff fc (Hz) with quality factor q (default 0.7071 = Butterworth). */
  setLowPass(fs: number, fc: number, q = Math.SQRT1_2): void {
    const w = 2 * Math.PI * fc / fs;
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    const alpha = sw / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = ((1 - cw) / 2) / a0;
    this.b1 = (1 - cw) / a0;
    this.b2 = ((1 - cw) / 2) / a0;
    this.a1 = (-2 * cw) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  /** High-pass at cutoff fc (Hz). */
  setHighPass(fs: number, fc: number, q = Math.SQRT1_2): void {
    const w = 2 * Math.PI * fc / fs;
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    const alpha = sw / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = ((1 + cw) / 2) / a0;
    this.b1 = (-(1 + cw)) / a0;
    this.b2 = ((1 + cw) / 2) / a0;
    this.a1 = (-2 * cw) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  /** Band-pass with center frequency fc and quality factor q. */
  setBandPass(fs: number, fc: number, q: number): void {
    const w = 2 * Math.PI * fc / fs;
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    const alpha = sw / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = alpha / a0;
    this.b1 = 0;
    this.b2 = (-alpha) / a0;
    this.a1 = (-2 * cw) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  /** Process one sample. */
  step(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

/**
 * Complex windowed-sinc FIR low-pass — applies the same real-valued LPF
 * tap set to both the I and Q channels in lock-step. Linear-phase, sharp
 * transition (designed to a user-specified transition bandwidth), Blackman
 * window for ~−74 dB stopband attenuation.
 *
 * Used for the WFM IF stage: a steep skirt is needed to reject the
 * 100-kHz-spaced adjacent broadcast FM channel without staircasing the
 * legitimate FM signal's Carson sidebands. The previous 8th-order
 * Butterworth IIR (Biquad cascade) had only −24 dB/oct in the stopband;
 * a sinc FIR can hit −74 dB right past the cutoff if given enough taps.
 *
 * step(I, Q) writes the filtered output to `lastI` / `lastQ` rather than
 * returning a tuple — keeps the hot loop allocation-free.
 */
export class ComplexFirLpf {
  private taps: Float64Array = new Float64Array(0);
  private bufI: Float64Array = new Float64Array(0);
  private bufQ: Float64Array = new Float64Array(0);
  private head = 0;
  private N = 0;
  /** Most recent filtered I sample, populated by step(). */
  lastI = 0;
  /** Most recent filtered Q sample, populated by step(). */
  lastQ = 0;

  /** Design a real LPF with Blackman-windowed sinc taps.
   *  @param fs       sample rate (Hz)
   *  @param fc       −6 dB cutoff (Hz, one-sided)
   *  @param transBw  width of the transition band (Hz). Smaller = sharper
   *                  skirt but more taps (≈ 5.5·fs/transBw with Blackman).
   */
  setLowPass(fs: number, fc: number, transBw: number): void {
    // Tap count: Blackman window's main-lobe width ≈ 12π/N rad/sample, so
    // N ≈ 5.5·fs/transBw gives the requested transition band. Floor at 31
    // taps and force odd so the impulse response is symmetric about its
    // centre (preserves linear phase).
    let N = Math.max(31, Math.round(5.5 * fs / Math.max(1, transBw)));
    if ((N & 1) === 0) N += 1;
    this.N = N;
    if (this.taps.length !== N) {
      this.taps = new Float64Array(N);
      this.bufI = new Float64Array(N);
      this.bufQ = new Float64Array(N);
    } else {
      this.bufI.fill(0);
      this.bufQ.fill(0);
    }
    this.head = 0;
    const wc = 2 * Math.PI * fc / fs;
    const M = (N - 1) / 2;
    let sum = 0;
    for (let n = 0; n < N; n++) {
      const k = n - M;
      // sinc(wc·k/π); at k=0 use the limit value wc/π
      const sinc = k === 0 ? wc / Math.PI : Math.sin(wc * k) / (Math.PI * k);
      // Blackman window: 0.42 − 0.5·cos(2π·n/(N−1)) + 0.08·cos(4π·n/(N−1))
      const w = 0.42
              - 0.5  * Math.cos(2 * Math.PI * n / (N - 1))
              + 0.08 * Math.cos(4 * Math.PI * n / (N - 1));
      const tap = sinc * w;
      this.taps[n] = tap;
      sum += tap;
    }
    // Normalise for unity DC gain
    if (sum !== 0) {
      const inv = 1 / sum;
      for (let n = 0; n < N; n++) this.taps[n] *= inv;
    }
  }

  step(iIn: number, qIn: number): void {
    const N = this.N;
    if (N === 0) { this.lastI = iIn; this.lastQ = qIn; return; }
    const taps = this.taps;
    const bufI = this.bufI;
    const bufQ = this.bufQ;
    bufI[this.head] = iIn;
    bufQ[this.head] = qIn;
    let iOut = 0, qOut = 0;
    let idx = this.head;
    for (let k = 0; k < N; k++) {
      const t = taps[k];
      iOut += t * bufI[idx];
      qOut += t * bufQ[idx];
      idx = idx > 0 ? idx - 1 : N - 1;
    }
    this.head = this.head < N - 1 ? this.head + 1 : 0;
    this.lastI = iOut;
    this.lastQ = qOut;
  }

  reset(): void {
    this.bufI.fill(0);
    this.bufQ.fill(0);
    this.head = 0;
    this.lastI = 0;
    this.lastQ = 0;
  }

  /** Tap count — useful for diagnostics. */
  getTapCount(): number { return this.N; }
}
