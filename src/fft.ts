// Minimal radix-2 in-place complex FFT for the FFT Display dial.
// Stays inside this file (no npm dep) — N=512 takes ~0.05 ms on M1, the
// dial runs at 16 fps so total cost is well under 1 % of one core.
//
// Public API:
//   const fft = new FftPipeline(N);           // N must be power of 2
//   fft.process(iqBuffer, smoothingFactor)    // returns Float32Array of dBFS bins
//                                             // arranged from −fs/2 → +fs/2 (fftshift'd)
//
// smoothingFactor matches the SDR++ "FFT Smoothing" semantics: larger
// value = more averaging. α = 1 / smoothingFactor per processed frame.
// smoothingFactor <= 1 disables smoothing (each frame is shown raw).

export class FftPipeline {
  readonly N: number;
  private readonly window: Float32Array;       // Hann
  private readonly windowGainDb: number;        // -10·log10(sum(w²)/N) compensation
  private readonly cosTable: Float32Array;
  private readonly sinTable: Float32Array;
  private readonly rev: Uint32Array;
  private readonly re: Float32Array;
  private readonly im: Float32Array;
  private smoothed: Float32Array | null = null;

  constructor(n: number) {
    if (n < 4 || (n & (n - 1)) !== 0) {
      throw new Error(`FFT size must be power of 2, got ${n}`);
    }
    this.N = n;
    // Hann window — strong main-lobe shape with first sidelobe at -31 dB.
    this.window = new Float32Array(n);
    let wSumSq = 0;
    for (let i = 0; i < n; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
      this.window[i] = w;
      wSumSq += w * w;
    }
    // Power-loss compensation so the dBFS reading of a tone matches the
    // unwindowed amplitude. Hann loses ~6 dB → add it back.
    this.windowGainDb = 10 * Math.log10(n / wSumSq);
    // Twiddle factors for the largest stage; smaller stages re-use them
    // by stride-stepping. exp(-j·2π·k/N) for k = 0..N/2-1.
    this.cosTable = new Float32Array(n / 2);
    this.sinTable = new Float32Array(n / 2);
    for (let k = 0; k < n / 2; k++) {
      const phi = (-2 * Math.PI * k) / n;
      this.cosTable[k] = Math.cos(phi);
      this.sinTable[k] = Math.sin(phi);
    }
    // Bit-reverse permutation lookup (one-time).
    this.rev = new Uint32Array(n);
    let bits = 0;
    for (let t = n; t > 1; t >>= 1) bits++;
    for (let i = 0; i < n; i++) {
      let v = i, r = 0;
      for (let b = 0; b < bits; b++) { r = (r << 1) | (v & 1); v >>>= 1; }
      this.rev[i] = r;
    }
    this.re = new Float32Array(n);
    this.im = new Float32Array(n);
  }

  /** Process the last N IQ samples from an int16-LE I/Q buffer. Returns
   *  a freshly-allocated Float32Array of fftshift'd dBFS bins (length N).
   *  bin 0 = −fs/2 + Δf, bin N/2 = DC (center freq), bin N-1 = +fs/2.
   *  Returns null when the buffer doesn't have N complex samples.
   */
  process(iq: Buffer, smoothingFactor: number): Float32Array | null {
    const N = this.N;
    const totalIqSamples = iq.length >> 2;        // 4 bytes per (I,Q) pair
    if (totalIqSamples < N) return null;
    // Take the most recent N samples — gives the lowest latency between
    // the IQ arriving and the user seeing it on the LCD.
    const startSample = totalIqSamples - N;
    const startByte = startSample * 4;
    const w = this.window;
    const re = this.re, im = this.im, rev = this.rev;
    for (let i = 0; i < N; i++) {
      const off = startByte + i * 4;
      const I = iq.readInt16LE(off);
      const Q = iq.readInt16LE(off + 2);
      // Normalise to ±1 full-scale and window in one pass.
      const wi = w[i] / 32768;
      const j = rev[i];
      re[j] = I * wi;
      im[j] = Q * wi;
    }
    // Iterative Cooley-Tukey, butterflies in place.
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1;
      const tableStep = N / size;
      for (let i = 0; i < N; i += size) {
        let kk = 0;
        for (let j = i; j < i + half; j++) {
          const c = this.cosTable[kk];
          const s = this.sinTable[kk];
          const tr = re[j + half] * c - im[j + half] * s;
          const ti = re[j + half] * s + im[j + half] * c;
          re[j + half] = re[j] - tr;
          im[j + half] = im[j] - ti;
          re[j] += tr;
          im[j] += ti;
          kk += tableStep;
        }
      }
    }
    // Convert to power dBFS, with Hann power loss compensated. Output
    // is fftshift'd: idx 0 ↔ bin N/2 (-fs/2 + Δf), idx N/2 ↔ bin 0 (DC),
    // idx N-1 ↔ bin N/2 - 1 (+fs/2 - Δf).
    const out = new Float32Array(N);
    const half = N >> 1;
    const norm = 1 / (N * N);
    for (let k = 0; k < N; k++) {
      const power = (re[k] * re[k] + im[k] * im[k]) * norm;
      const db = power > 1e-20 ? 10 * Math.log10(power) + this.windowGainDb : -200;
      // fftshift: positive freqs k=0..N/2-1 → display idx half..N-1
      //            negative freqs k=N/2..N-1 → display idx 0..half-1
      const idx = k < half ? k + half : k - half;
      out[idx] = db;
    }
    // EWMA smoothing across frames (NOT across bins).
    if (smoothingFactor > 1) {
      if (!this.smoothed || this.smoothed.length !== N) {
        this.smoothed = new Float32Array(out);
      } else {
        const a = 1 / smoothingFactor;
        const oneMinusA = 1 - a;
        for (let i = 0; i < N; i++) {
          this.smoothed[i] = this.smoothed[i] * oneMinusA + out[i] * a;
        }
      }
      // Caller gets a fresh copy so they can mutate freely.
      return new Float32Array(this.smoothed);
    }
    this.smoothed = null;
    return out;
  }

  /** Reset smoothing history — call when the IQ source resets (band
   *  change, reconnect) so the smoother doesn't average across regimes. */
  resetSmoothing(): void {
    this.smoothed = null;
  }
}
