import { describe, it, expect } from 'vitest';
import { Ifnr } from '../src/ifnr';

const FS = 48_000;

/** Speech-like: a wandering harmonic series in syllables, silent between them. */
function voice(n: number, seed = 1): Float64Array {
  const out = new Float64Array(n);
  let ph = 0, r = seed, target = 150, f0 = 150;
  const rnd = () => { r = (r * 16807) % 2147483647; return r / 2147483647; };
  for (let i = 0; i < n; i++) {
    if (i % Math.round(FS * 0.12) === 0) target = 110 + 80 * rnd();
    f0 += (target - f0) * 0.0005;
    ph += 2 * Math.PI * f0 / FS;
    const s4 = Math.sin(2 * Math.PI * 2 * i / FS);
    const syll = s4 > 0 ? s4 : 0;                 // half the time silent
    let s = 0;
    for (let h = 1; h <= 20; h++) s += Math.sin(h * ph) / h;
    out[i] = 4000 * syll * s;
  }
  return out;
}

function noise(n: number, rms: number, seed = 9): Float64Array {
  const out = new Float64Array(n);
  let r = seed;
  const u = () => { r = (r * 48271) % 2147483647; return r / 2147483647; };
  for (let i = 0; i < n; i++) {
    const a = Math.max(1e-12, u()), b = u();
    out[i] = rms * Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * b);
  }
  return out;
}

function run(x: Float64Array): Float64Array {
  const nr = new Ifnr();
  const out = new Float64Array(x.length);
  for (let o = 0; o < x.length; o += 4096) out.set(nr.process(x.subarray(o, Math.min(x.length, o + 4096))), o);
  return out;
}

const LAT = 2048;   // one block: the first output sample is the first input sample N samples on
function rmsOf(x: Float64Array, from: number, to: number, mask?: (i: number) => boolean): number {
  let s = 0, n = 0;
  for (let i = from; i < to; i++) if (!mask || mask(i)) { s += x[i] * x[i]; n++; }
  return Math.sqrt(s / Math.max(1, n));
}
const silent = (i: number) => Math.sin(2 * Math.PI * 2 * i / FS) < -0.3;   // between syllables

describe('Ifnr (audio noise reduction)', () => {
  it('takes the hiss between words down and keeps the words', () => {
    const n = FS * 8;
    const v = voice(n), w = noise(n, 400);
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = v[i] + w[i];
    const y = run(x);
    const from = FS * 3;
    // Between syllables: what is left of the noise.
    const floorDb = 20 * Math.log10(
      rmsOf(y, from, n, i => i >= LAT && silent(i - LAT)) / rmsOf(x, from, n, silent));
    expect(floorDb).toBeLessThan(-10);
    // In the syllables: the voice survives (output against the clean voice).
    const speechDb = 20 * Math.log10(
      rmsOf(y, from, n, i => i >= LAT && !silent(i - LAT)) / rmsOf(v, from, n, i => !silent(i)));
    expect(Math.abs(speechDb)).toBeLessThan(2.5);
  });

  it('lets the start of a consonant through (not muffled)', () => {
    // Hiss-like bursts in 2-4.5 kHz, 10 dB over the noise there, 100 ms every
    // half second: what an "s" or a "t" is to the estimator. The first 43 ms
    // of each is the frame DD used to judge by the silence before it.
    const n = FS * 8;
    const w = noise(n, 400);
    const c = new Float64Array(n);
    const amp = 408 * Math.sqrt(2 / 60);
    const starts: number[] = [];
    for (let s = FS; s + FS / 10 < n; s += FS / 2) {
      starts.push(s);
      for (let i = 0; i < FS / 10; i++) {
        let v = 0;
        for (let h = 0; h < 60; h++) v += Math.sin(2 * Math.PI * (2000 + h * 2500 / 60) * (s + i) / FS + h * h);
        c[s + i] = amp * v;
      }
    }
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = c[i] + w[i];
    const y = run(x);
    const head = Math.round(FS * 0.043);
    let eo = 0, ec = 0;
    for (const s of starts) if (s >= FS * 3) {
      for (let i = s; i < s + head; i++) { eo += y[i + LAT - 1] ** 2; ec += c[i] ** 2; }
    }
    const onsetDb = 10 * Math.log10(eo / ec);
    // -9.4 dB before ONSET_SNR, -5.1 with it.
    expect(onsetDb).toBeGreaterThan(-6.5);
  });

  it('sizes itself to the audio rate (noise alone at 114 kHz)', () => {
    const fs = 114_000, n = fs * 5;
    const w = noise(n, 400, 3);
    const nr = new Ifnr(fs);
    const y = new Float64Array(n);
    for (let o = 0; o < n; o += 8192) y.set(nr.process(w.subarray(o, Math.min(n, o + 8192))), o);
    expect(20 * Math.log10(rmsOf(y, fs * 3, n) / rmsOf(w, fs * 3, n))).toBeLessThan(-10);
  });

  it('cuts noise alone by the depth it is set to', () => {
    const n = FS * 5;
    const w = noise(n, 400, 5);
    for (const depth of [6, 9, 12, 15]) {
      const nr = new Ifnr();
      nr.setMaxCutDb(depth);
      const y = new Float64Array(n);
      for (let o = 0; o < n; o += 4096) y.set(nr.process(w.subarray(o, Math.min(n, o + 4096))), o);
      const cut = 20 * Math.log10(rmsOf(y, FS * 3, n) / rmsOf(w, FS * 3, n));
      // Not the full depth: now and then a bin of noise looks like signal.
      expect(cut).toBeLessThan(-depth + 1.5);
      expect(cut).toBeGreaterThan(-depth - 0.5);
    }
  });

  it('leaves a clean voice as it was', () => {
    const n = FS * 6;
    const v = voice(n, 4);
    const y = run(v);
    let e = 0, s = 0;
    for (let i = FS * 3; i < n; i++) { const d = y[i] - v[i - LAT]; e += d * d; s += v[i - LAT] ** 2; }
    // -12, not better: the pauses here are only 0.25 s, so the smoothed power
    // never falls far below the voice and the minimum tracker reads the
    // voice's quietest partials as noise. On air (954 kHz) the programme's
    // loud level moved by under 1 dB.
    expect(10 * Math.log10(e / s)).toBeLessThan(-12);
  });
});
