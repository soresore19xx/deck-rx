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
