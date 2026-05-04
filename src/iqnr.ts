// IF-domain noise reduction — SDR++ FMIF tracking-filter port.
//
// Reference: AlexandreRouma/SDRPlusPlus core/src/dsp/noise_reduction/fm_if.h
// (class dsp::noise_reduction::FMIF). The radio module enables this filter
// only for WFM and NFM demodulators (getFMIFNRAllowed() is true for those,
// false for AM/SSB/CW). We mirror that policy: setMode(mode=2 AM) bypasses.
//
// Algorithm — single-bin tracking via tiny sliding FFT:
//   For each input IQ sample, compute a Nuttall-windowed forward FFT over
//   the last `bins` samples, find the bin with the largest magnitude, keep
//   ONLY that bin (zero all others) and inverse-FFT to recover one output
//   sample. This works because an FM signal at any instant occupies a single
//   instantaneous frequency — picking the strongest bin tracks the signal
//   and discards the broadband noise filling the rest of the IF passband.
//
// Math note (IFFT skip):
//   If X[k] is zero except at k=idx with value V, then
//     x[n] = (V/N) * exp(+j·2π·idx·n/N)
//   Evaluating at n = N/2 gives x[N/2] = V * (-1)^idx / N.
//   So we don't actually need to run an inverse FFT — we just multiply the
//   max bin's complex value by ±1/N depending on bin parity. Same answer,
//   half the FFT cost.
//
// Latency: bins/2 samples (e.g. 16 samples at WFM bins=32 = ~70 µs at
//   228 kHz IQ rate). Negligible.
//
// Presets (bin count) match SDR++ ifnrTaps:
//   - 32  Broadcast WFM
//   - 31  NFM Narrow Band
//   - 15  NFM Voice
//   - 9   NOAA APT (not exposed here)
import FFT from 'fft.js';

export type DemodMode = 0 | 1 | 2;  // 0=NFM, 1=WFM, 2=AM

const BINS_WFM = 32;
const BINS_NFM = 15;       // SDR++ "Voice" preset; the default for NFM
// const BINS_NFM_NARROW = 31;  // Narrow Band preset, not selected from UI yet

// Nuttall window — same window function SDR++ uses (gui::dsp::window::nuttall).
// Coefficients from Albert H. Nuttall, "Some Windows with Very Good Sidelobe
// Behavior", IEEE Trans. ASSP, 1981 (Eq. 21, the 4-term -98 dB version).
function nuttall(n: number, N: number): number {
  const a0 = 0.355768;
  const a1 = 0.487396;
  const a2 = 0.144232;
  const a3 = 0.012604;
  const x = (2 * Math.PI * n) / N;
  return a0 - a1 * Math.cos(x) + a2 * Math.cos(2 * x) - a3 * Math.cos(3 * x);
}

export class IqNr {
  private bins = BINS_WFM;
  private fft: FFT;
  private window: Float64Array;
  // Sliding history of the last (bins - 1) IQ samples. New samples from each
  // processBuffer call are concatenated logically with this history; after
  // the call we keep the last (bins - 1) samples for next time.
  private histI: Float64Array;
  private histQ: Float64Array;
  private fftIn: number[];   // fft.js complex interleaved
  private fftOut: number[];
  private active = true;
  private diagAvgKeep = 1.0;  // running fraction of energy retained (≈ peak/total)

  constructor() {
    this.fft = new FFT(this.bins);
    this.window = this.buildWindow(this.bins);
    this.histI = new Float64Array(this.bins - 1);
    this.histQ = new Float64Array(this.bins - 1);
    this.fftIn = this.fft.createComplexArray();
    this.fftOut = this.fft.createComplexArray();
  }

  private buildWindow(bins: number): Float64Array {
    const w = new Float64Array(bins);
    // SDR++ passes (i, _bins - 1) which is the standard symmetric Nuttall
    // sampling. We replicate that.
    for (let i = 0; i < bins; i++) w[i] = nuttall(i, bins - 1);
    return w;
  }

  private setBins(bins: number): void {
    if (bins === this.bins) return;
    this.bins = bins;
    this.fft = new FFT(bins);
    this.window = this.buildWindow(bins);
    this.histI = new Float64Array(bins - 1);
    this.histQ = new Float64Array(bins - 1);
    this.fftIn = this.fft.createComplexArray();
    this.fftOut = this.fft.createComplexArray();
  }

  /**
   * Set demod mode. SDR++ disables FMIF for AM/SSB/CW; we follow that policy
   * by setting active=false for mode 2 (AM). The IqRateHz parameter is kept
   * in the signature for symmetry with the prior version even though FMIF's
   * behaviour doesn't depend on absolute sample rate.
   */
  setMode(mode: DemodMode, _iqRateHz: number): void {
    if (mode === 2) {
      this.active = false;
      return;
    }
    this.active = true;
    this.setBins(mode === 1 ? BINS_WFM : BINS_NFM);
  }

  reset(): void {
    this.histI.fill(0);
    this.histQ.fill(0);
    this.diagAvgKeep = 1.0;
  }

  getAvgGain(): number { return this.diagAvgKeep; }

  /**
   * Process an interleaved Int16 LE IQ Buffer and return a Buffer of the
   * same length. When inactive (AM mode), returns the input unchanged.
   * Output sample i has a fixed delay of (bins/2) samples relative to the
   * corresponding input — much shorter than the OLA pipeline this replaced.
   */
  processBuffer(iqIn: Buffer): Buffer {
    if (!this.active) return iqIn;

    const count = iqIn.length >> 2;
    const bins = this.bins;
    const out = Buffer.alloc(iqIn.length);
    const win = this.window;
    const fftIn = this.fftIn;
    const fftOut = this.fftOut;
    const histI = this.histI;
    const histQ = this.histQ;
    const histLen = bins - 1;

    // Inline accumulator for diagnostic gain (peak bin energy / total energy).
    let keepSum = 0;

    for (let i = 0; i < count; i++) {
      // Build the windowed FFT input. Window covers samples [i..i+bins) in
      // the conceptual concatenated buffer "[history; iqIn]". Lookup splits
      // between histI/Q and the raw iqIn.
      for (let n = 0; n < bins; n++) {
        const pos = i + n;
        let sI: number, sQ: number;
        if (pos < histLen) {
          sI = histI[pos];
          sQ = histQ[pos];
        } else {
          const ni = pos - histLen;  // sample index into iqIn
          sI = iqIn.readInt16LE(ni * 4);
          sQ = iqIn.readInt16LE(ni * 4 + 2);
        }
        const w = win[n];
        fftIn[2 * n]     = sI * w;
        fftIn[2 * n + 1] = sQ * w;
      }

      // Forward FFT only — no inverse needed (see math note in file header).
      this.fft.transform(fftOut, fftIn);

      // Find the bin with the largest |X[k]|².
      let maxMag2 = -1;
      let maxIdx = 0;
      let totalMag2 = 0;
      for (let k = 0; k < bins; k++) {
        const re = fftOut[2 * k];
        const im = fftOut[2 * k + 1];
        const m2 = re * re + im * im;
        totalMag2 += m2;
        if (m2 > maxMag2) { maxMag2 = m2; maxIdx = k; }
      }

      // Reconstruct the center IFFT tap analytically:
      //   x[N/2] = X[idx] * (-1)^idx / N
      const sign = (maxIdx & 1) === 0 ? 1 : -1;
      const scale = sign / bins;
      const outI = fftOut[2 * maxIdx]     * scale;
      const outQ = fftOut[2 * maxIdx + 1] * scale;

      // Diagnostic: fraction of total spectral energy preserved.
      keepSum += totalMag2 > 0 ? maxMag2 / totalMag2 : 1;

      // Clip to int16
      const oI = outI >= 32767 ? 32767 : outI <= -32768 ? -32768 : (outI | 0);
      const oQ = outQ >= 32767 ? 32767 : outQ <= -32768 ? -32768 : (outQ | 0);
      out.writeInt16LE(oI, i * 4);
      out.writeInt16LE(oQ, i * 4 + 2);
    }

    // Slide history: keep last (bins - 1) samples of the conceptual buffer.
    if (count >= histLen) {
      // History entirely from the tail of iqIn.
      const start = count - histLen;
      for (let n = 0; n < histLen; n++) {
        const ni = start + n;
        histI[n] = iqIn.readInt16LE(ni * 4);
        histQ[n] = iqIn.readInt16LE(ni * 4 + 2);
      }
    } else {
      // Drop `count` from the front of history, append all of iqIn.
      const keep = histLen - count;
      for (let n = 0; n < keep; n++) {
        histI[n] = histI[n + count];
        histQ[n] = histQ[n + count];
      }
      for (let n = 0; n < count; n++) {
        histI[keep + n] = iqIn.readInt16LE(n * 4);
        histQ[keep + n] = iqIn.readInt16LE(n * 4 + 2);
      }
    }

    if (count > 0) {
      const inst = keepSum / count;
      this.diagAvgKeep = 0.95 * this.diagAvgKeep + 0.05 * inst;
    }

    return out;
  }
}
