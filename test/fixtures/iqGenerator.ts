// Synthetic I/Q signal generators for unit-testing demodulators. All output
// matches the SpyServer wire format (Int16 little-endian, 4 bytes per sample
// = I + Q) so it can be passed to demodulator.process* unmodified.

import { Buffer } from 'buffer';

interface IqOptsBase {
  iqRate: number;            // sample rate of the I/Q stream (Hz)
  durationSec: number;       // length of the buffer in seconds
  carrierOffsetHz?: number;  // baseband offset of the modulated signal (default 0 = exact tune)
  amplitude?: number;        // I/Q peak (Int16 scale), default 8000
}

export interface CwOpts extends IqOptsBase {}
export interface SsbOpts extends IqOptsBase {
  audioFreqHz: number;       // single-tone audio frequency to encode
  sideBand: 'USB' | 'LSB';
}
export interface AmOpts extends IqOptsBase {
  audioFreqHz: number;
  modulationDepth?: number;  // 0..1, default 0.5
}

/** Continuous-wave (unmodulated carrier) at carrierOffsetHz. CW receivers add
 *  a BFO tone to make the carrier audible. */
export function generateCw(o: CwOpts): Buffer {
  const N = Math.floor(o.iqRate * o.durationSec);
  const A = o.amplitude ?? 8000;
  const f = o.carrierOffsetHz ?? 0;
  const buf = Buffer.alloc(N * 4);
  for (let i = 0; i < N; i++) {
    const t = i / o.iqRate;
    const I = A * Math.cos(2 * Math.PI * f * t);
    const Q = A * Math.sin(2 * Math.PI * f * t);
    buf.writeInt16LE(Math.round(I), i * 4);
    buf.writeInt16LE(Math.round(Q), i * 4 + 2);
  }
  return buf;
}

/** Single-sideband test tone. The IQ contains exactly one analytic-signal
 *  spectral line at carrierOffsetHz ± audioFreqHz (USB → +, LSB → −). A correct
 *  USB demodulator tuned to carrierOffset should output a sine wave at
 *  audioFreqHz. */
export function generateSsb(o: SsbOpts): Buffer {
  const N = Math.floor(o.iqRate * o.durationSec);
  const A = o.amplitude ?? 8000;
  const fc = o.carrierOffsetHz ?? 0;
  const sign = o.sideBand === 'USB' ? +1 : -1;
  const f = fc + sign * o.audioFreqHz;
  const buf = Buffer.alloc(N * 4);
  for (let i = 0; i < N; i++) {
    const t = i / o.iqRate;
    const I = A * Math.cos(2 * Math.PI * f * t);
    const Q = A * Math.sin(2 * Math.PI * f * t);
    buf.writeInt16LE(Math.round(I), i * 4);
    buf.writeInt16LE(Math.round(Q), i * 4 + 2);
  }
  return buf;
}

/** AM-modulated carrier: envelope = (1 + m·cos(2π·fa·t)). Used for sanity-
 *  checking the AM demod and as a "should NOT decode cleanly with SSB demod"
 *  reference. */
export function generateAm(o: AmOpts): Buffer {
  const N = Math.floor(o.iqRate * o.durationSec);
  const A = o.amplitude ?? 8000;
  const fc = o.carrierOffsetHz ?? 0;
  const fa = o.audioFreqHz;
  const m = o.modulationDepth ?? 0.5;
  const buf = Buffer.alloc(N * 4);
  for (let i = 0; i < N; i++) {
    const t = i / o.iqRate;
    const env = 1 + m * Math.cos(2 * Math.PI * fa * t);
    const I = A * env * Math.cos(2 * Math.PI * fc * t);
    const Q = A * env * Math.sin(2 * Math.PI * fc * t);
    buf.writeInt16LE(Math.round(I), i * 4);
    buf.writeInt16LE(Math.round(Q), i * 4 + 2);
  }
  return buf;
}

/** Find the dominant audio frequency in a stereo Int16 PCM buffer (assumes
 *  L = R). Uses naive DFT over a power-of-2 window — fast enough for tests
 *  with ≤ 4096 samples per channel. */
export function findPeakFreq(pcm: Int16Array, sampleRate: number, channels = 2): number {
  const M = Math.floor(pcm.length / channels);
  // Round down to power of 2 so the DFT bin spacing is uniform.
  const N = 1 << Math.floor(Math.log2(M));
  const re: number[] = new Array(N);
  for (let i = 0; i < N; i++) re[i] = pcm[i * channels];
  // Naive DFT — O(N²) but tests are small.
  let peakBin = 0, peakMag = 0;
  const halfN = N >> 1;
  for (let k = 1; k < halfN; k++) {
    let sumR = 0, sumI = 0;
    for (let n = 0; n < N; n++) {
      const phase = -2 * Math.PI * k * n / N;
      sumR += re[n] * Math.cos(phase);
      sumI += re[n] * Math.sin(phase);
    }
    const mag = sumR * sumR + sumI * sumI;
    if (mag > peakMag) { peakMag = mag; peakBin = k; }
  }
  return (peakBin * sampleRate) / N;
}
