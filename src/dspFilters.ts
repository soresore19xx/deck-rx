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

  /** Notch at fc (Hz): infinite depth at fc, -3 dB width fc/q. */
  setNotch(fs: number, fc: number, q: number): void {
    const w = 2 * Math.PI * fc / fs;
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    const alpha = sw / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = 1 / a0;
    this.b1 = (-2 * cw) / a0;
    this.b2 = 1 / a0;
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

/**
 * Constant-modulus blind equaliser (Godard, p = 2) for wide FM, run on the
 * band-limited IQ just before the discriminator.
 *
 * An FM signal has a constant envelope. A reflection arriving a few µs late
 * (buildings, in town) adds to it, and the sum ripples in amplitude and is
 * wrong in phase; the discriminator turns that phase error into noise and
 * distortion, most of it high in the multiplex where the 38 kHz L−R
 * subcarrier lives. So stereo gets much noisier than mono while L+R looks
 * fine. The equaliser adapts an FIR that makes the envelope constant again,
 * which removes the echo without knowing anything about it.
 *
 * Measured on 80.0 MHz from the balcony (2026-10-21, same IQ through both):
 * the L−R noise floor of this demodulator sat 2-4 dB over OnAir's, and OnAir
 * with its equaliser switched off matched ours within 0.3 dB in every band.
 *
 * 16 taps spaced about 2 µs apart (every D samples, D = fs / 500 kHz rounded),
 * the reference tap 3 in: echoes up to ~24 µs late and ~6 µs early. The input
 * is normalised by its running power so the step size does not depend on the
 * RF level, and the output is scaled back so the discriminator sees the same
 * magnitudes as before. A blown-up output (|y|² ≥ 16, or NaN) restarts the
 * taps from a pass-through.
 *
 * The price: the taps never sit perfectly still, and on a clean synthetic
 * signal that costs separation — 61 → 50 dB at a 250 kHz channel, 35 → 30 at
 * 200 kHz (left-only 1 kHz, 456 kHz IQ). Still far past what anyone hears; the
 * echo it removes cost 17 → 42 dB in test/wfmMultipath.test.ts.
 */
export class CmaEqualizer {
  static readonly TAPS = 16;
  static readonly REF = 3;
  private wI = new Float64Array(CmaEqualizer.TAPS);
  private wQ = new Float64Array(CmaEqualizer.TAPS);
  private hI: Float64Array = new Float64Array(0);
  private hQ: Float64Array = new Float64Array(0);
  private head = 0;
  private len = 0;
  private spacing = 1;
  private mu = 0;
  private powAlpha = 0;
  private pow = 0;
  lastI = 0;
  lastQ = 0;

  configure(fs: number): void {
    this.spacing = Math.max(1, Math.round(fs / 500_000));
    this.len = (CmaEqualizer.TAPS - 1) * this.spacing + 1;
    this.hI = new Float64Array(this.len);
    this.hQ = new Float64Array(this.len);
    // Per-sample constants, scaled so the adaptation and the power tracking
    // run at the same speed in seconds whatever the IQ rate.
    const perSample = 500_000 / fs;
    this.mu = 2e-4 * perSample;
    this.powAlpha = Math.min(1, 0.002 * perSample);
    this.reset();
  }

  reset(): void {
    this.wI.fill(0); this.wQ.fill(0);
    this.wI[CmaEqualizer.REF] = 1;
    this.hI.fill(0); this.hQ.fill(0);
    this.head = 0;
    this.pow = 0;
    this.lastI = 0; this.lastQ = 0;
  }

  step(iIn: number, qIn: number): void {
    const len = this.len;
    if (len === 0) { this.lastI = iIn; this.lastQ = qIn; return; }
    const p = iIn * iIn + qIn * qIn;
    this.pow = this.pow > 0 ? this.pow + (p - this.pow) * this.powAlpha : p;
    if (!(this.pow > 1e-12)) { this.lastI = iIn; this.lastQ = qIn; return; }
    const scale = Math.sqrt(this.pow);
    const g = 1 / scale;
    const hI = this.hI, hQ = this.hQ, wI = this.wI, wQ = this.wQ, D = this.spacing;
    hI[this.head] = iIn * g;
    hQ[this.head] = qIn * g;
    // y = sum w[k] · x[n − k·D]
    let yI = 0, yQ = 0;
    let idx = this.head;
    for (let k = 0; k < CmaEqualizer.TAPS; k++) {
      const xi = hI[idx], xq = hQ[idx];
      yI += wI[k] * xi - wQ[k] * xq;
      yQ += wI[k] * xq + wQ[k] * xi;
      idx -= D; if (idx < 0) idx += len;
    }
    const m = yI * yI + yQ * yQ;
    if (!(m < 16)) {
      // Diverged: start again from a pass-through, keep the power estimate.
      const pw = this.pow;
      this.reset();
      this.pow = pw;
      this.lastI = iIn; this.lastQ = qIn;
      return;
    }
    // w[k] −= µ (|y|² − 1) · y · conj(x[n − k·D])
    const e = this.mu * (m - 1);
    const eI = e * yI, eQ = e * yQ;
    idx = this.head;
    for (let k = 0; k < CmaEqualizer.TAPS; k++) {
      const xi = hI[idx], xq = hQ[idx];
      wI[k] -= eI * xi + eQ * xq;
      wQ[k] -= eQ * xi - eI * xq;
      idx -= D; if (idx < 0) idx += len;
    }
    this.head = this.head + 1 < len ? this.head + 1 : 0;
    this.lastI = yI * scale;
    this.lastQ = yQ * scale;
  }
}
