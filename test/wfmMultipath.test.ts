import { describe, it, expect } from 'vitest';
import { Demodulator } from '../src/demodulator';

/**
 * Two things found on 2026-10-21 by running one 80.0 MHz IQ recording through
 * this demodulator and through OnAir: the 19 kHz pilot reached the audio at
 * −20 dB under the programme, and L−R carried 2-4 dB more noise, which was
 * multipath (OnAir's constant-modulus equaliser switched off matched ours).
 *
 * The composite is Zenith-GE as in wfmStereoSeparation.test.ts: pilot and
 * subcarrier as sin(psi) and sin(2 psi), 75 kHz peak deviation.
 */
const DEV = 75_000;

function composite(rate: number, seconds: number, left: number): { i: Float64Array; q: Float64Array } {
  const n = Math.round(rate * seconds);
  const i = new Float64Array(n), q = new Float64Array(n);
  let ph = 0;
  for (let k = 0; k < n; k++) {
    const t = k / rate;
    const psi = 2 * Math.PI * 19_000 * t;
    const L = Math.sin(2 * Math.PI * left * t);
    const mpx = 0.9 * (L / 2 + (L / 2) * Math.sin(2 * psi)) + 0.1 * Math.sin(psi);
    ph += 2 * Math.PI * DEV * mpx / rate;
    i[k] = Math.cos(ph); q[k] = Math.sin(ph);
  }
  return { i, q };
}

/** Adds one echo, `delay` samples late, `gain` as large, turned by `rot` rad. */
function withEcho(s: { i: Float64Array; q: Float64Array }, delay: number, gain: number, rot: number): Buffer {
  const n = s.i.length;
  const b = Buffer.alloc(n * 4);
  const c = Math.cos(rot) * gain, d = Math.sin(rot) * gain;
  for (let k = 0; k < n; k++) {
    let I = s.i[k], Q = s.q[k];
    if (k >= delay) {
      const ei = s.i[k - delay], eq = s.q[k - delay];
      I += ei * c - eq * d;
      Q += ei * d + eq * c;
    }
    b.writeInt16LE(Math.round(6000 * I), k * 4);
    b.writeInt16LE(Math.round(6000 * Q), k * 4 + 2);
  }
  return b;
}

function tone(pcm: Int16Array, ch: number, hz: number, rate: number, skip: number): number {
  let re = 0, im = 0, n = 0;
  for (let i = skip; i < pcm.length / 2; i++) {
    const w = 2 * Math.PI * hz * i / rate;
    re += pcm[i * 2 + ch] * Math.cos(w);
    im -= pcm[i * 2 + ch] * Math.sin(w);
    n++;
  }
  return Math.sqrt((re * re + im * im) / (n * n));
}

/** Everything in the right channel that is not the 1 kHz leak: echo damage. */
function residual(pcm: Int16Array, ch: number, skip: number): number {
  let s = 0, n = 0;
  for (let i = skip; i < pcm.length / 2; i++) { s += pcm[i * 2 + ch] ** 2; n++; }
  return Math.sqrt(s / n);
}

function decode(rate: number, iq: Buffer, decimate: number, eq: boolean) {
  const d = new Demodulator();
  d.setStereo(rate);
  d.setWfmIfBandwidth(rate, 110_000);
  d.setDeemphasis(rate / decimate, 50e-6);
  d.setWfmEqualizer(eq);
  // In pieces, as SpyServer delivers it, so state carries across calls.
  const parts: Int16Array[] = [];
  for (let o = 0; o < iq.length; o += 16384 * 4) {
    parts.push(d.processWFMStereo(iq.subarray(o, Math.min(iq.length, o + 16384 * 4)), decimate, 2000));
  }
  const pcm = new Int16Array(parts.reduce((a, p) => a + p.length, 0));
  let k = 0;
  for (const p of parts) { pcm.set(p, k); k += p.length; }
  return { pcm, audioRate: rate / decimate };
}

describe('WFM pilot notch', () => {
  it('keeps the 19 kHz pilot out of the audio', () => {
    const rate = 912_000;
    const iq = withEcho(composite(rate, 0.6, 1000), 0, 0, 0);
    const { pcm, audioRate } = decode(rate, iq, 2, true);
    const skip = Math.round(audioRate * 0.3);
    const prog = tone(pcm, 0, 1000, audioRate, skip);
    for (const ch of [0, 1]) {
      const pilot = tone(pcm, ch, 19_000, audioRate, skip);
      // Was −20 dB on air (an 8th-order Butterworth at 15 kHz is only ~16 dB
      // down at 19 kHz).
      expect(20 * Math.log10(pilot / prog)).toBeLessThan(-60);
    }
  });
});

describe('WFM multipath equaliser', () => {
  const rate = 912_000;
  // An 8.8 µs echo at −10 dB: a reflection off a building some 1.3 km further
  // round. Without the equaliser it puts the right channel only 17 dB under
  // the left on a left-only signal; with it, about 42 dB.
  const iq = withEcho(composite(rate, 1.5, 1000), 8, 0.3, 1.2);
  const skipS = 0.8;   // equaliser and PLL settled

  it('cleans the stereo a reflection has smeared', () => {
    const off = decode(rate, iq, 2, false);
    const on = decode(rate, iq, 2, true);
    const skip = Math.round(off.audioRate * skipS);
    const sideOff = residual(off.pcm, 1, skip), sideOn = residual(on.pcm, 1, skip);
    const progOn = tone(on.pcm, 0, 1000, on.audioRate, skip);
    // Left only, so everything in the right channel is damage.
    expect(20 * Math.log10(sideOn / sideOff)).toBeLessThan(-15);
    expect(20 * Math.log10(sideOn / progOn)).toBeLessThan(-35);
    expect(tone(on.pcm, 0, 1000, on.audioRate, skip)).toBeGreaterThan(tone(on.pcm, 1, 1000, on.audioRate, skip));
  });

  it('leaves a clean signal as it was', () => {
    const clean = withEcho(composite(rate, 1.5, 1000), 0, 0, 0);
    const off = decode(rate, clean, 2, false);
    const on = decode(rate, clean, 2, true);
    const skip = Math.round(off.audioRate * skipS);
    const sepOff = 20 * Math.log10(tone(off.pcm, 0, 1000, off.audioRate, skip) / residual(off.pcm, 1, skip));
    const sepOn = 20 * Math.log10(tone(on.pcm, 0, 1000, on.audioRate, skip) / residual(on.pcm, 1, skip));
    // The taps never sit perfectly still (step-size noise): about 1 dB at 42.
    expect(sepOn).toBeGreaterThan(sepOff - 1.5);
  });
});
