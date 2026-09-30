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
import {
  Demodulator, AM_AGC_OFF_SCALE, SSB_GAIN, CW_GAIN,
  WFM_GAIN, WFM_STEREO_GAIN, NFM_GAIN, fmOutputScale,
} from '../src/demodulator.js';
import { MODE_MAKEUP } from '../src/audioLeveling.js';

const IQ_RATE = 150_000;
const DEC = 4;                         // audio at 37.5 kHz, as the V4 profile runs
const AUDIO_RATE = IQ_RATE / DEC;
const SECONDS = 1.5;

/** Interleaved int16 IQ. `amp` is the carrier amplitude in int16 units. */
function iqBuffer(n: number, f: (t: number) => [number, number]): Buffer {
  return iqBufferAt(IQ_RATE, n, f);
}

function iqBufferAt(rate: number, n: number, f: (t: number) => [number, number]): Buffer {
  const b = Buffer.alloc(n * 4);
  for (let k = 0; k < n; k++) {
    const [i, q] = f(k / rate);
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

// The FM detectors return the phase step per IQ sample, so a fixed gain made
// FM louder the lower the IQ rate: the Mac app at 228 kHz (HF+, iqDecimation
// 2) played FM 6-8 dB above AM at the same modulation depth, the plugin at
// 456 kHz 0-3 dB (2026-09-30). fmOutputScale() takes the rate back out.
describe('FM loudness does not depend on the IQ rate', () => {
  const RATES = [228_000, 456_000, 600_000, 912_000];   // HF+ offsets 2/1/0, V4 at 2.4 M / 4
  const DEV_PCT = 50;
  const rmsDb = (pcm: Int16Array, makeup = 1): number => {
    const s = pcm.subarray(pcm.length >> 1);
    let a = 0;
    for (const v of s) a += (v * makeup) ** 2;
    return 20 * Math.log10(Math.sqrt(a / s.length) / 32768);
  };
  const fmTone = (rate: number, devHz: number): Buffer => {
    const beta = devHz / 1000;
    return iqBufferAt(rate, Math.floor(rate * 0.6), (t) => {
      const p = beta * Math.sin(2 * Math.PI * 1000 * t);
      return [8000 * Math.cos(p), 8000 * Math.sin(p)];
    });
  };
  const wfm = (rate: number, stereo: boolean): number => {
    const dec = Math.round(rate / 57_000);
    const d = new Demodulator();
    d.setStereo(rate);
    d.setDeemphasis(rate / dec, 50e-6);
    const iq = fmTone(rate, 75_000 * DEV_PCT / 100);
    const scale = fmOutputScale(rate);
    return rmsDb(stereo
      ? d.processWFMStereo(iq, dec, WFM_STEREO_GAIN * scale)
      : d.processWFM(iq, dec, WFM_GAIN * scale), MODE_MAKEUP[1]);
  };
  const nfm = (rate: number): number => {
    const dec = Math.round(rate / 57_000);
    const d = new Demodulator();
    return rmsDb(d.processFM(fmTone(rate, 2500), dec, NFM_GAIN * fmOutputScale(rate)), MODE_MAKEUP[0]);
  };
  const amAgcOn = (): number => {
    const d = new Demodulator();
    d.setAmBandwidth(AUDIO_RATE, 9000, IQ_RATE);
    d.setAmAgc(true);
    const iq = iqBuffer(N, (t) => [8000 * (1 + DEV_PCT / 100 * Math.sin(2 * Math.PI * 1000 * t)), 0]);
    return rmsDb(d.processAM(iq, DEC, AM_AGC_OFF_SCALE), MODE_MAKEUP[2]);
  };

  const ref = { mono: wfm(456_000, false), stereo: wfm(456_000, true), nfm: nfm(456_000) };
  const am = amAgcOn();
  for (const rate of RATES) {
    it(`WFM mono, stereo and NFM at ${rate / 1000} kHz come out as at 456 kHz`, () => {
      expect(Math.abs(wfm(rate, false) - ref.mono)).toBeLessThan(0.5);
      expect(Math.abs(wfm(rate, true) - ref.stereo)).toBeLessThan(0.5);
      expect(Math.abs(nfm(rate) - ref.nfm)).toBeLessThan(0.5);
    });
    it(`WFM at ${rate / 1000} kHz stays within 5 dB of AM (carrier AGC on) at the same depth`, () => {
      expect(Math.abs(wfm(rate, false) - am)).toBeLessThan(5);
      expect(Math.abs(wfm(rate, true) - am)).toBeLessThan(5);
    });
  }
});
