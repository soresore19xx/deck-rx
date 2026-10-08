// FftPipeline over packets smaller than the transform.
//
// SpyServer sends about 100 packets a second, so a packet is rate/100
// samples: 2944 for the V4 at 300 kS/s. The pipeline used to transform one
// packet at a time and returned nothing for any larger size, which froze the
// spectrum on the V4 at FFT 4096 (2026-10-08).

import { describe, it, expect } from 'vitest';
import { FftPipeline, pacedSmoothing } from '../src/fft.js';

/** A complex tone at `bin` of an N-point transform, int16 LE I/Q. */
function tone(samples: number, n: number, bin: number, startAt = 0): Buffer {
  const b = Buffer.alloc(samples * 4);
  for (let i = 0; i < samples; i++) {
    const ph = (2 * Math.PI * bin * (startAt + i)) / n;
    b.writeInt16LE(Math.round(8000 * Math.cos(ph)), i * 4);
    b.writeInt16LE(Math.round(8000 * Math.sin(ph)), i * 4 + 2);
  }
  return b;
}

function peakIndex(bins: Float32Array): number {
  let k = 0;
  for (let i = 1; i < bins.length; i++) if (bins[i] > bins[k]) k = i;
  return k;
}

describe('FftPipeline with packets smaller than N', () => {
  it('produces a frame once N samples have arrived over several packets', () => {
    const n = 4096, pkt = 2944;      // the V4 at 300 kS/s
    const fft = new FftPipeline(n);
    expect(fft.process(tone(pkt, n, 100, 0), 0)).toBeNull();
    const bins = fft.process(tone(pkt, n, 100, pkt), 0);
    expect(bins).not.toBeNull();
    expect(bins!.length).toBe(n);
    expect(peakIndex(bins!)).toBe(n / 2 + 100);
  });

  it('keeps producing frames packet after packet', () => {
    const n = 16384, pkt = 1120;     // the HF+ at 114 kS/s
    const fft = new FftPipeline(n);
    let frames = 0;
    for (let p = 0; p < 40; p++) {
      if (fft.process(tone(pkt, n, -300, p * pkt), 0)) frames++;
    }
    // 15 packets fill the window; every one after that yields a frame.
    expect(frames).toBe(40 - Math.ceil(n / pkt) + 1);
  });

  it('equals the transform of the same N samples handed over at once', () => {
    const n = 2048, pkt = 700;
    const whole = tone(4 * pkt, n, 37, 0);
    const a = new FftPipeline(n);
    let last: Float32Array | null = null;
    for (let p = 0; p < 4; p++) last = a.process(whole.subarray(p * pkt * 4, (p + 1) * pkt * 4), 0);
    const b = new FftPipeline(n);
    const once = b.process(whole.subarray(whole.length - n * 4), 0);
    expect(last).not.toBeNull();
    expect(Array.from(last!)).toEqual(Array.from(once!));
  });

  it('processPaced transforms at most once per interval, from every packet', () => {
    const n = 4096, pkt = 2944;
    const fft = new FftPipeline(n);
    let frames = 0;
    // 100 packets a second for one second, display at 16 fps.
    for (let p = 0; p < 100; p++) {
      if (fft.processPaced(tone(pkt, n, 50, p * pkt), 0, 1000 / 16, p * 10)) frames++;
    }
    expect(frames).toBeGreaterThanOrEqual(14);
    expect(frames).toBeLessThanOrEqual(16);
    // The window was fed by every packet, so it is still contiguous.
    expect(peakIndex(fft.processLatest(0)!)).toBe(n / 2 + 50);
  });

  it('pacedSmoothing keeps the averaging time, not the per-frame factor', () => {
    // Applying alpha = 1/16 four times leaves (15/16)^4 of the old value.
    const s = pacedSmoothing(16, 4);
    expect(1 - 1 / s).toBeCloseTo(Math.pow(15 / 16, 4), 12);
    expect(pacedSmoothing(16, 1)).toBe(16);
    expect(pacedSmoothing(1, 10)).toBe(1);   // off stays off
    expect(pacedSmoothing(0, 10)).toBe(0);
  });

  it('push without a transform still advances the window', () => {
    const n = 1024, pkt = 300;
    const fft = new FftPipeline(n);
    for (let p = 0; p < 3; p++) fft.push(tone(pkt, n, 10, p * pkt));
    expect(fft.processLatest(0)).toBeNull();      // 900 < 1024
    fft.push(tone(pkt, n, 10, 3 * pkt));
    expect(peakIndex(fft.processLatest(0)!)).toBe(n / 2 + 10);
  });
});
