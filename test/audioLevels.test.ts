// How loud each demodulator comes out for a strong signal, at the scale the
// service actually passes it — not at a scale a test picks.
//
// Written after c8314d9. 0ee600c stopped using the RF gain as a volume control
// and passed a scale of 1 to every demodulator; with the carrier AGC off the AM
// path runs a fixed gain of 32 x that scale, and a local station on the V4
// clipped hard on the iPad. The demodulator tests had all passed: they call the
// demodulators with scales of their own, so the value the app hands over was
// never under test. These pin the app's values against a strong input.

import { describe, it, expect } from 'vitest';
import { Demodulator, AM_AGC_OFF_SCALE, SSB_GAIN, CW_GAIN } from '../src/demodulator.js';

const IQ_RATE = 150_000;
const DEC = 4;                         // audio at 37.5 kHz, as the V4 profile runs
const AUDIO_RATE = IQ_RATE / DEC;
const SECONDS = 1.5;

/** Interleaved int16 IQ. `amp` is the carrier amplitude in int16 units. */
function iqBuffer(n: number, f: (t: number) => [number, number]): Buffer {
  const b = Buffer.alloc(n * 4);
  for (let k = 0; k < n; k++) {
    const [i, q] = f(k / IQ_RATE);
    b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(i))), k * 4);
    b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(q))), k * 4 + 2);
  }
  return b;
}

/** Peak (0..1 of int16 full scale) and the share of samples at the rail,
 *  over the second half of the output (filters and AGCs have settled). */
function level(pcm: Int16Array): { peak: number; railPct: number } {
  const s = pcm.subarray(Math.floor(pcm.length / 2));
  let peak = 0, rail = 0;
  for (const v of s) {
    const a = Math.abs(v);
    if (a > peak) peak = a;
    if (a >= 32000) rail++;
  }
  return { peak: peak / 32768, railPct: (rail / s.length) * 100 };
}

const N = Math.floor(IQ_RATE * SECONDS);

describe('AM with the carrier AGC off, at the scale the service passes', () => {
  for (const amp of [8000, 16000]) {
    it(`does not clip a strong carrier (amplitude ${amp}, 80% modulated)`, () => {
      const d = new Demodulator();
      d.setAmBandwidth(AUDIO_RATE, 9000, IQ_RATE);
      d.setAmAgc(false);
      const iq = iqBuffer(N, (t) => {
        const env = amp * (1 + 0.8 * Math.sin(2 * Math.PI * 1000 * t));
        return [env, 0];
      });
      const out = level(d.processAM(iq, DEC, AM_AGC_OFF_SCALE));
      expect(out.railPct).toBe(0);
      expect(out.peak).toBeLessThan(0.99);
      expect(out.peak).toBeGreaterThan(0.05);   // and not so quiet it is useless
    });
  }
});

describe('SSB and CW, at the gain the service passes', () => {
  for (const amp of [8000, 16000]) {
    it(`USB does not clip a strong tone (amplitude ${amp})`, () => {
      const d = new Demodulator();
      d.setupSsb(IQ_RATE, AUDIO_RATE, 1200);
      const iq = iqBuffer(N, (t) => {
        const ph = 2 * Math.PI * 1000 * t;
        return [amp * Math.cos(ph), amp * Math.sin(ph)];
      });
      const out = level(d.processSSB(iq, DEC, 'USB', SSB_GAIN));
      expect(out.peak).toBeGreaterThan(0.05);
      expect(out.railPct).toBe(0);
    });
    it(`CW with its AGC off does not clip a strong tone (amplitude ${amp})`, () => {
      const d = new Demodulator();
      d.setupCw(IQ_RATE, AUDIO_RATE, 700);
      d.setCwAgc(false);
      const iq = iqBuffer(N, (t) => {
        const ph = 2 * Math.PI * 700 * t;
        return [amp * Math.cos(ph), amp * Math.sin(ph)];
      });
      const out = level(d.processCW(iq, DEC, CW_GAIN));
      expect(out.peak).toBeGreaterThan(0.05);
      expect(out.railPct).toBe(0);
    });
  }
});
