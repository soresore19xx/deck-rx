import { describe, it, expect } from 'vitest';
import { Demodulator, SSB_GAIN } from '../src/demodulator';

const IQ = 114_000, DEC = 2, AR = IQ / DEC;

/** One USB "voice" tone 1 kHz above the dial, amplitude `a`, with a little noise. */
function usbTone(seconds: number, a: number, seed = 5): Buffer {
  const n = Math.round(IQ * seconds), b = Buffer.alloc(n * 4);
  let r = seed;
  const u = () => { r = (r * 48271) % 2147483647; return r / 2147483647 - 0.5; };
  for (let i = 0; i < n; i++) {
    const w = 2 * Math.PI * 1000 * i / IQ;
    b.writeInt16LE(Math.round(a * Math.cos(w) + 20 * u()), i * 4);
    b.writeInt16LE(Math.round(a * Math.sin(w) + 20 * u()), i * 4 + 2);
  }
  return b;
}

function level(agc: boolean, a: number): { rms: number; peak: number } {
  const d = new Demodulator();
  d.setupSsb(IQ, AR, 1200);
  d.setSsbAgc(agc, AR);
  const pcm = d.processSSB(usbTone(1.2, a), DEC, 'USB', SSB_GAIN);
  let s = 0, n = 0, peak = 0;
  for (let i = Math.round(AR * 0.6); i < pcm.length / 2; i++) {
    s += pcm[2 * i] ** 2; n++; peak = Math.max(peak, Math.abs(pcm[2 * i]));
  }
  return { rms: Math.sqrt(s / n), peak };
}

describe('SSB AGC', () => {
  it('brings a weak and a strong station to the same level', () => {
    const weak = level(true, 300), strong = level(true, 12000);
    expect(Math.abs(20 * Math.log10(strong.rms / weak.rms))).toBeLessThan(1.5);
    // Without it the same two are 32 dB apart.
    const w0 = level(false, 300), s0 = level(false, 12000);
    expect(20 * Math.log10(s0.rms / w0.rms)).toBeGreaterThan(30);
  });

  it('keeps a strong station off the rail', () => {
    expect(level(true, 16000).peak).toBeLessThan(32767);
  });

  it('lifts an empty channel no more than its ceiling', () => {
    const d = new Demodulator();
    d.setupSsb(IQ, AR, 1200);
    d.setSsbAgc(true, AR);
    const quiet = d.processSSB(usbTone(1.2, 0), DEC, 'USB', SSB_GAIN);
    const d0 = new Demodulator();
    d0.setupSsb(IQ, AR, 1200);
    const fixed = d0.processSSB(usbTone(1.2, 0), DEC, 'USB', SSB_GAIN);
    const rms = (p: Int16Array) => { let s = 0; for (let i = 0; i < p.length; i += 2) s += p[i] ** 2; return Math.sqrt(2 * s / p.length); };
    // The ceiling is +34 dB over the fixed gain; the fixed path's output here
    // is a few LSB, which its truncation to int16 shaves, so allow 2 dB.
    expect(20 * Math.log10(rms(quiet) / Math.max(1e-9, rms(fixed)))).toBeLessThan(36);
  });
});
