// Speech-enhancement-quality noise reduction.
//
// Decision-directed a priori SNR estimator (Ephraim-Malah 1984) feeding a
// Wiener gain. The DD estimator smooths the SNR estimate using the previous
// frame's enhanced magnitude — that smoothing is what kills the "musical
// noise" that plain spectral subtraction produces.
//
//    γ_k(n) = |Y_k(n)|² / λ_d,k(n)                      (a posteriori SNR)
//    ξ_k(n) = α · |S_hat_k(n-1)|² / λ_d,k(n)
//             + (1-α) · max(γ_k(n) - 1, 0)               (DD a priori SNR)
//    G_k(n) = ξ_k / (1 + ξ_k)                           (Wiener gain)
//
// The noise PSD λ_d,k is minimum statistics (Martin 2001): per bin, the
// smallest SMOOTHED power seen across a sliding window of about 2.4 s,
// bias-corrected.
//
// Until 2026-10-21 the minimum was taken of each frame's raw |Y|². That is an
// exponential variable, and the smallest of ~112 of them sits around 1/112 of
// its mean, so even a bias of 4 left the noise estimate some 15 dB low and the
// gain at ~0.9: on medium-wave audio it took the hiss down by 1 dB where
// OnAir's NR took 15. This class was not used anywhere then (6b82142 replaced
// it with the FM IF tracking filter); it is now the audio NR of AM and SSB.
// Measured on the same recordings after the fix: hiss between words 12-15 dB
// down, the programme's loud level within 1 dB on a clean station (954 kHz).
//
// Frames of about 43 ms whatever the audio rate (2048 at 48 kHz), half
// overlapped. sqrt-Hann analysis × sqrt-Hann synthesis at 50 % overlap =
// combined Hann, which COLAs to 1 — a gain-of-1 pass is lossless. Latency is
// one frame.
import FFT from 'fft.js';

// Decision-directed smoothing weight. 0.95 — slightly faster than the
// canonical 0.98 so gain converges from initial unity within ~1 s.
const ALPHA_DD = 0.95;
const PSD_TAU_S = 0.13;          // periodogram smoothing before the minimum
const MS_SUBWINDOWS = 8;
const MS_SUBWINDOW_S = 0.3;      // 8 × 0.3 s: the minimum's memory
const MS_BIAS = 2.5;

export class Ifnr {
  /** The most a bin is turned down, linear. 0.18 ≈ -15 dB: deeper and the
   *  leftover noise starts to warble ("musical noise"). setMaxCutDb() moves it. */
  private gMin = 0.18;
  setMaxCutDb(db: number): void { this.gMin = Math.pow(10, -Math.max(3, Math.min(30, db)) / 20); }
  private rate = 0;
  private n = 0;
  private hop = 0;
  private framesPerSw = 14;
  private psdSmooth = 0.85;
  private psd = new Float64Array(0);   // smoothed |Y|² per bin
  private gains = new Float64Array(0);
  private fft: FFT | null = null;
  private window = new Float64Array(0);
  private inputBuf = new Float64Array(0);
  private inputPos = 0;
  private overlap = new Float64Array(0);
  private prevSignalMag2 = new Float64Array(0); // |S_hat_k(n-1)|², per bin
  // Minimum-statistics state: per bin, per sub-window minimum.
  // Layout: [subWindow * n + bin]. Current sub-window updates as new frames
  // arrive; once it ages out (every framesPerSw frames) we slide the ring
  // forward and reset the new "current" window to +Infinity.
  private msMin = new Float64Array(0);
  private msSubIdx = 0;
  private msFrameInSub = 0;
  // Diagnostic: running mean of the per-block average gain. 1.0 = pure
  // passthrough; lower = noise reduction is doing something.
  private diagAvgGain = 1.0;
  /** Average gain across bins, smoothed over blocks, for the diag log. */
  getAvgGain(): number { return this.diagAvgGain; }
  // Output ring — process() returns one output sample per input sample.
  private outBuf = new Float64Array(0);
  private outRead = 0;
  private outWrite = 0;
  private freqBuf: number[] = [];
  private timeBuf: number[] = [];

  constructor(rate = 48_000) { this.configure(rate); }

  /** Sizes the frames for this audio rate; a no-op at the rate it has. */
  configure(rate: number): void {
    if (rate === this.rate || !(rate > 0)) return;
    this.rate = rate;
    let n = 256;
    while (n < rate * 0.04) n <<= 1;
    this.n = n;
    this.hop = n / 2;
    const frameS = this.hop / rate;
    this.framesPerSw = Math.max(2, Math.round(MS_SUBWINDOW_S / frameS));
    this.psdSmooth = Math.exp(-frameS / PSD_TAU_S);
    this.fft = new FFT(n);
    this.window = new Float64Array(n);
    for (let i = 0; i < n; i++) this.window[i] = Math.sin(Math.PI * i / n);
    this.inputBuf = new Float64Array(n);
    this.overlap = new Float64Array(n);
    this.prevSignalMag2 = new Float64Array(n);
    this.psd = new Float64Array(n / 2 + 1);
    this.gains = new Float64Array(n / 2 + 1);
    this.msMin = new Float64Array(MS_SUBWINDOWS * n);
    // Generous output ring (4 × hop); pre-seeded with hop zeros so the very
    // first call returns silence rather than running out.
    this.outBuf = new Float64Array(this.hop * 4);
    this.freqBuf = this.fft.createComplexArray();
    this.timeBuf = this.fft.createComplexArray();
    this.reset();
  }

  reset(): void {
    this.psd.fill(0);
    this.inputBuf.fill(0);
    this.overlap.fill(0);
    this.prevSignalMag2.fill(0);
    this.msMin.fill(Number.POSITIVE_INFINITY);
    this.msSubIdx = 0;
    this.msFrameInSub = 0;
    this.outBuf.fill(0);
    this.outRead = 0;
    this.outWrite = this.hop;  // re-seed the silent warmup
    this.inputPos = 0;
  }

  /** Push input samples, get back the SAME number of output samples, one
   *  frame late. */
  process(input: Float64Array): Float64Array {
    const out = new Float64Array(input.length);
    for (let i = 0; i < input.length; i++) {
      this.inputBuf[this.inputPos++] = input[i];
      if (this.inputPos === this.n) {
        this.processBlock();  // appends hop samples to the output ring
        this.inputBuf.copyWithin(0, this.hop);
        this.inputPos = this.hop;
      }
      out[i] = this.outRead < this.outWrite ? this.outBuf[this.outRead++ % this.outBuf.length] : 0;
    }
    if (this.outRead >= this.outBuf.length) {
      this.outRead -= this.outBuf.length;
      this.outWrite -= this.outBuf.length;
    }
    return out;
  }

  private processBlock(): void {
    const N = this.n, HOP = this.hop, fft = this.fft!;
    const windowed: number[] = new Array(N);
    for (let i = 0; i < N; i++) windowed[i] = this.inputBuf[i] * this.window[i];
    fft.realTransform(this.freqBuf, windowed);
    fft.completeSpectrum(this.freqBuf);

    // Per-bin DD-Wiener with the minimum-statistics noise estimate, on the
    // non-negative half; the mirrored half takes the same gain.
    const H = N / 2;
    const curOff = this.msSubIdx * N;
    const a = this.psdSmooth;
    for (let k = 0; k <= H; k++) {
      const re = this.freqBuf[2 * k];
      const im = this.freqBuf[2 * k + 1];
      const mag2 = re * re + im * im;
      this.psd[k] = this.psd[k] > 0 ? a * this.psd[k] + (1 - a) * mag2 : mag2;
      if (this.psd[k] < this.msMin[curOff + k]) this.msMin[curOff + k] = this.psd[k];
      let mn = Number.POSITIVE_INFINITY;
      for (let u = 0; u < MS_SUBWINDOWS; u++) {
        const v = this.msMin[u * N + k];
        if (v < mn) mn = v;
      }
      const lambda = mn === Number.POSITIVE_INFINITY ? mag2 : mn * MS_BIAS;
      const lambdaSafe = lambda > 1e-12 ? lambda : 1e-12;
      const gamma = mag2 / lambdaSafe;
      const xiDD = ALPHA_DD * (this.prevSignalMag2[k] / lambdaSafe)
                 + (1 - ALPHA_DD) * Math.max(0, gamma - 1);
      const g = xiDD / (1 + xiDD);
      this.gains[k] = g < this.gMin ? this.gMin : g;
    }
    // Smooth the gains across frequency (1-2-1): an isolated bin let through
    // or cut on its own is the warble of "musical noise".
    let gainSum = 0;
    let prev = this.gains[0];
    for (let k = 0; k <= H; k++) {
      const cur = this.gains[k];
      const next = k < H ? this.gains[k + 1] : cur;
      const g = 0.25 * prev + 0.5 * cur + 0.25 * next;
      prev = cur;
      gainSum += g;
      this.freqBuf[2 * k] *= g; this.freqBuf[2 * k + 1] *= g;
      if (k > 0 && k < H) { this.freqBuf[2 * (N - k)] *= g; this.freqBuf[2 * (N - k) + 1] *= g; }
      const re = this.freqBuf[2 * k], im = this.freqBuf[2 * k + 1];
      this.prevSignalMag2[k] = re * re + im * im;
    }
    this.diagAvgGain = 0.95 * this.diagAvgGain + 0.05 * (gainSum / (H + 1));
    this.msFrameInSub++;
    if (this.msFrameInSub >= this.framesPerSw) {
      this.msFrameInSub = 0;
      this.msSubIdx = (this.msSubIdx + 1) % MS_SUBWINDOWS;
      const next = this.msSubIdx * N;
      for (let k = 0; k < N; k++) this.msMin[next + k] = Number.POSITIVE_INFINITY;
    }

    fft.inverseTransform(this.timeBuf, this.freqBuf);
    for (let i = 0; i < N; i++) this.overlap[i] += this.timeBuf[2 * i] * this.window[i];
    for (let i = 0; i < HOP; i++) this.outBuf[this.outWrite++ % this.outBuf.length] = this.overlap[i];
    this.overlap.copyWithin(0, HOP);
    for (let i = HOP; i < N; i++) this.overlap[i] = 0;
  }
}
