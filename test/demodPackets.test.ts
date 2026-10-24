import { describe, it, expect } from 'vitest';
import { Demodulator } from '../src/demodulator.js';

/**
 * Each detector kept sample i when i % decimate === 0 within its own packet
 * and dropped the remainder, so a packet that was not a multiple of the
 * divisor broke the time base at every packet. rtl_tcp's reads are any
 * length. Found and measured in native-app on 2026-10-25 (Demods.swift
 * `pickPhase`): a 1 kHz WFM tone at 13 dB SINAD instead of 93 with
 * 16384-sample packets at a divisor of 9.
 */
const RATE = 456_000;
const DEC = 9;

function fmIq(seconds: number): Buffer {
  const n = Math.round(RATE * seconds);
  const b = Buffer.alloc(n * 4);
  let ph = 0;
  for (let k = 0; k < n; k++) {
    ph += 2 * Math.PI * 75_000 * (Math.sin(2 * Math.PI * 1000 * k / RATE) / 2) / RATE;
    b.writeInt16LE(Math.round(9830 * Math.cos(ph)), k * 4);
    b.writeInt16LE(Math.round(9830 * Math.sin(ph)), k * 4 + 2);
  }
  return b;
}

function amIq(seconds: number): Buffer {
  const n = Math.round(RATE * seconds);
  const b = Buffer.alloc(n * 4);
  for (let k = 0; k < n; k++) {
    b.writeInt16LE(Math.round(9830 * (1 + 0.6 * Math.sin(2 * Math.PI * 1000 * k / RATE))), k * 4);
    b.writeInt16LE(0, k * 4 + 2);
  }
  return b;
}

type Run = (d: Demodulator, b: Buffer) => Int16Array;

function both(make: () => Demodulator, iq: Buffer, run: Run): [Int16Array, Int16Array] {
  const whole = run(make(), iq);
  const d = make();
  const parts: Int16Array[] = [];
  const packet = 16_385 * 4;
  for (let o = 0; o < iq.length; o += packet) parts.push(run(d, iq.subarray(o, Math.min(iq.length, o + packet))));
  const split = new Int16Array(parts.reduce((a, p) => a + p.length, 0));
  let k = 0;
  for (const p of parts) { split.set(p, k); k += p.length; }
  return [whole, split];
}

function maxDiff(a: Int16Array, b: Int16Array): number {
  let m = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

describe('detectors keep their decimation across packets', () => {
  const make = (): Demodulator => {
    const d = new Demodulator();
    d.setStereo(RATE);
    d.setWfmIfBandwidth(RATE, 125_000);
    d.setDeemphasis(RATE / DEC, 50e-6);
    d.setWfmEqualizer(false);   // its taps adapt per call; this is about the time base
    d.setupSsb(RATE, RATE / DEC, 1200);
    d.setupCw(RATE, RATE / DEC, 700);
    return d;
  };
  const fm = fmIq(0.5), am = amIq(0.5);
  const cases: [string, Buffer, Run][] = [
    ['WFM stereo', fm, (d, b) => d.processWFMStereo(b, DEC, 2000)],
    ['WFM', fm, (d, b) => d.processWFM(b, DEC, 3000)],
    ['NFM', fm, (d, b) => d.processFM(b, DEC, 6000)],
    ['USB', fm, (d, b) => d.processSSB(b, DEC, 'USB', 48000)],
    ['CW', fm, (d, b) => d.processCW(b, DEC, 96000)],
    ['AM', am, (d, b) => d.processAM(b, DEC, 1)],
  ];
  for (const [name, iq, run] of cases) {
    it(`${name}: 16385-sample packets give what one call gives`, () => {
      const [whole, split] = both(make, iq, run);
      expect(split.length).toBe(whole.length);
      expect(maxDiff(whole, split)).toBeLessThanOrEqual(1);
    });
  }
});
