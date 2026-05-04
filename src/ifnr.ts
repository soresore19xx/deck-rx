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
// Noise PSD estimate λ_d,k uses asymmetric tracking that is HELD when the
// observed γ suggests strong signal — that prevents the floor from creeping
// up to a steady broadcast tone, which would otherwise cause progressive
// attenuation of the signal we wanted to keep.
//
// Block size N=2048 with HOP=N/2=1024 → frame rate 56 Hz at 57 kHz audio,
// well below the speech band so analysis-frame artifacts can't be heard.
// Per-block CPU is ~2 FFTs of 2048 + bin processing × 56 blocks/sec.
// Latency is HOP samples (~18 ms) — borderline but acceptable for radio.
//
// sqrt-Hann analysis × sqrt-Hann synthesis at 50 % overlap = combined Hann,
// which COLAs to 1 — i.e., a gain-of-1 pass is mathematically lossless.
import FFT from 'fft.js';

const N = 2048;
const HOP = N / 2;

// Decision-directed smoothing weight. 0.95 — slightly faster than the
// canonical 0.98 so gain converges from initial unity within ~1 s.
const ALPHA_DD = 0.95;
// Minimum gain (linear). 0.15 ≈ -16 dB attenuation cap. Below this, residual
// musical noise tends to peek through.
const G_MIN = 0.15;
// Minimum statistics noise estimator (Martin 2001):
//   per bin, track the smallest mag² seen across a sliding window (~2 sec),
//   then bias-correct. Bias 4 — much higher than Martin's textbook 1.5
//   because our sub-window count is only 8 and we work on broadband audio
//   where the per-bin minima underestimate the true noise variance more
//   aggressively. Without this the gain sat at ~0.95 (passthrough).
const MS_SUBWINDOWS = 8;
const MS_FRAMES_PER_SW = 14; // ~112 frames total ≈ 2 s @ 56 Hz frame rate
const MS_BIAS = 4.0;

export class Ifnr {
  private fft = new FFT(N);
  private window: Float64Array;
  private inputBuf: Float64Array;
  private inputPos = 0;
  private overlap: Float64Array;
  private prevSignalMag2: Float64Array; // |S_hat_k(n-1)|², per bin
  // Minimum-statistics state: per bin, per sub-window minimum of mag².
  // Layout: [subWindow * N + bin]. Current sub-window updates as new frames
  // arrive; once it ages out (every MS_FRAMES_PER_SW frames) we slide the
  // ring forward and reset the new "current" window to +Infinity.
  private msMin: Float64Array;
  private msSubIdx = 0;            // current sub-window we're filling
  private msFrameInSub = 0;        // frames in current sub-window so far
  // Diagnostic: running mean of the per-block average gain. 1.0 = pure
  // passthrough; lower = noise reduction is doing something.
  private diagAvgGain = 1.0;
  private diagBlocks = 0;
  /** Last average gain across all bins from the most recent processBlock.
   *  Used by the spyService diag log to confirm the NR is actually firing. */
  getAvgGain(): number { return this.diagAvgGain; }
  // Output ring with read/write indices — process() must return one output
  // sample per input sample so the upstream PCM rate is preserved. The first
  // HOP samples emitted are silence (the block-buffering latency).
  private outBuf: Float64Array;
  private outRead = 0;
  private outWrite = 0;
  private freqBuf: number[];
  private timeBuf: number[];

  constructor() {
    this.window = new Float64Array(N);
    for (let i = 0; i < N; i++) this.window[i] = Math.sin(Math.PI * i / N);
    this.inputBuf = new Float64Array(N);
    this.overlap = new Float64Array(N);
    this.prevSignalMag2 = new Float64Array(N);
    this.msMin = new Float64Array(MS_SUBWINDOWS * N);
    this.msMin.fill(Number.POSITIVE_INFINITY);
    // Generous output ring (4 × HOP) — only ever accumulates up to a couple
    // of HOPs ahead in steady state. Pre-seed HOP zeros to absorb the initial
    // block-fill latency so the very first call returns silence rather than
    // running out of output.
    this.outBuf = new Float64Array(HOP * 4);
    this.outWrite = HOP;
    this.freqBuf = this.fft.createComplexArray();
    this.timeBuf = this.fft.createComplexArray();
  }

  reset(): void {
    this.inputBuf.fill(0);
    this.overlap.fill(0);
    this.prevSignalMag2.fill(0);
    this.msMin.fill(Number.POSITIVE_INFINITY);
    this.msSubIdx = 0;
    this.msFrameInSub = 0;
    this.outBuf.fill(0);
    this.outRead = 0;
    this.outWrite = HOP;  // re-seed the silent warmup
    this.inputPos = 0;
  }

  /** Push input samples, get back the SAME number of output samples. The
   *  first HOP samples are silence (the algorithm's block-fill latency);
   *  steady state is sample-for-sample at the same audio rate. */
  process(input: Float64Array): Float64Array {
    const out = new Float64Array(input.length);
    for (let i = 0; i < input.length; i++) {
      // Push one input sample
      this.inputBuf[this.inputPos++] = input[i];
      if (this.inputPos === N) {
        this.processBlock();  // appends HOP samples to the output ring
        this.inputBuf.copyWithin(0, HOP);
        this.inputPos = HOP;
      }
      // Pull one output sample (or silence if the ring drained — only on
      // very first call before any block has emitted)
      if (this.outRead < this.outWrite) {
        out[i] = this.outBuf[this.outRead++ % this.outBuf.length];
      } else {
        out[i] = 0;
      }
    }
    // Compact the ring when we've drained a long way to avoid integer growth
    if (this.outRead >= this.outBuf.length) {
      this.outRead -= this.outBuf.length;
      this.outWrite -= this.outBuf.length;
    }
    return out;
  }

  private processBlock(): void {
    // Analysis windowing
    const windowed: number[] = new Array(N);
    for (let i = 0; i < N; i++) windowed[i] = this.inputBuf[i] * this.window[i];

    // Forward FFT
    this.fft.realTransform(this.freqBuf, windowed);
    this.fft.completeSpectrum(this.freqBuf);

    // Per-bin DD-Wiener processing with minimum-statistics noise estimate
    const curOff = this.msSubIdx * N;
    let gainSum = 0;
    for (let k = 0; k < N; k++) {
      const re = this.freqBuf[2 * k];
      const im = this.freqBuf[2 * k + 1];
      const mag2 = re * re + im * im;

      // Update current sub-window minimum
      if (mag2 < this.msMin[curOff + k]) this.msMin[curOff + k] = mag2;

      // Noise estimate λ_d,k = bias × min over all sub-windows for bin k
      let mn = Number.POSITIVE_INFINITY;
      for (let u = 0; u < MS_SUBWINDOWS; u++) {
        const v = this.msMin[u * N + k];
        if (v < mn) mn = v;
      }
      const lambda = mn === Number.POSITIVE_INFINITY ? mag2 : mn * MS_BIAS;
      const lambdaSafe = lambda > 1e-12 ? lambda : 1e-12;

      // a posteriori SNR
      const gamma = mag2 / lambdaSafe;
      // Decision-directed a priori SNR
      const xiDD = ALPHA_DD * (this.prevSignalMag2[k] / lambdaSafe)
                 + (1 - ALPHA_DD) * Math.max(0, gamma - 1);
      // Wiener gain
      let g = xiDD / (1 + xiDD);
      if (g < G_MIN) g = G_MIN;
      gainSum += g;

      const newRe = re * g;
      const newIm = im * g;
      this.freqBuf[2 * k]     = newRe;
      this.freqBuf[2 * k + 1] = newIm;
      this.prevSignalMag2[k] = newRe * newRe + newIm * newIm;
    }
    // Update diag stats (smoothed across many blocks for a steady reading)
    this.diagAvgGain = 0.95 * this.diagAvgGain + 0.05 * (gainSum / N);
    this.diagBlocks++;
    // Advance the minimum-statistics sub-window ring after every frame
    this.msFrameInSub++;
    if (this.msFrameInSub >= MS_FRAMES_PER_SW) {
      this.msFrameInSub = 0;
      this.msSubIdx = (this.msSubIdx + 1) % MS_SUBWINDOWS;
      // Reset the new "current" window so it can collect fresh minima
      const next = this.msSubIdx * N;
      for (let k = 0; k < N; k++) this.msMin[next + k] = Number.POSITIVE_INFINITY;
    }

    // Inverse FFT
    this.fft.inverseTransform(this.timeBuf, this.freqBuf);

    // Synthesis window + overlap-add
    for (let i = 0; i < N; i++) this.overlap[i] += this.timeBuf[2 * i] * this.window[i];

    // Emit the now-stable HOP samples into the output ring
    for (let i = 0; i < HOP; i++) {
      this.outBuf[this.outWrite++ % this.outBuf.length] = this.overlap[i];
    }

    // Slide overlap left, zero-fill the new tail
    this.overlap.copyWithin(0, HOP);
    for (let i = HOP; i < N; i++) this.overlap[i] = 0;
  }
}
