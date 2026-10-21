import { describe, it, expect } from 'vitest';
import { AutoNotch } from '../src/autoNotch';

const FS = 57_000;

/** Speech-like: a harmonic series whose pitch wanders 110-190 Hz and whose
 *  loudness comes and goes in syllables, as a voice's partials do. */
function voice(n: number, seed = 1): Float64Array {
  const out = new Float64Array(n);
  let ph = 0, r = seed;
  const rnd = () => { r = (r * 16807) % 2147483647; return r / 2147483647; };
  let target = 150, f0 = 150;
  for (let i = 0; i < n; i++) {
    if (i % Math.round(FS * 0.12) === 0) target = 110 + 80 * rnd();
    f0 += (target - f0) * 0.0005;
    ph += 2 * Math.PI * f0 / FS;
    const syll = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * i / FS);
    let s = 0;
    for (let h = 1; h <= 20; h++) s += Math.sin(h * ph) / h;
    out[i] = 3000 * syll * s;
  }
  return out;
}

function tones(n: number, list: [number, number][]): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) for (const [hz, a] of list) out[i] += a * Math.sin(2 * Math.PI * hz * i / FS);
  return out;
}

function toPcm(x: Float64Array): Int16Array {
  const p = new Int16Array(x.length * 2);
  for (let i = 0; i < x.length; i++) { const v = Math.round(x[i]); p[2 * i] = v; p[2 * i + 1] = v; }
  return p;
}

function run(an: AutoNotch, pcm: Int16Array): Int16Array {
  const out = pcm.slice();
  for (let o = 0; o < out.length; o += 4096 * 2) an.process(out.subarray(o, Math.min(out.length, o + 4096 * 2)), 2);
  return out;
}

/** Amplitude of one tone in channel 0 over [from, to). */
function amp(p: Int16Array, hz: number, from: number, to: number): number {
  let re = 0, im = 0;
  for (let i = from; i < to; i++) {
    const w = 2 * Math.PI * hz * i / FS;
    re += p[2 * i] * Math.cos(w); im -= p[2 * i] * Math.sin(w);
  }
  return 2 * Math.sqrt(re * re + im * im) / (to - from);
}

function make(): AutoNotch { const a = new AutoNotch(); a.configure(FS); a.enabled = true; return a; }

describe('AutoNotch', () => {
  it('takes a heterodyne whistle out of speech', () => {
    const n = FS * 4;
    const v = voice(n);
    const w = tones(n, [[1000, 2000]]);
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = v[i] + w[i];
    const out = run(make(), toPcm(x));
    const before = amp(toPcm(x), 1000, FS * 2, FS * 4);
    const after = amp(out, 1000, FS * 2, FS * 4);
    expect(20 * Math.log10(after / before)).toBeLessThan(-25);
  });

  it('takes out the 100 Hz ladder of mains hum', () => {
    const n = FS * 3;
    const ladder: [number, number][] = [[100, 1500], [200, 1000], [300, 800], [400, 600]];
    const x = tones(n, ladder);
    const v = voice(n, 7);
    for (let i = 0; i < n; i++) x[i] += 0.3 * v[i];
    const out = run(make(), toPcm(x));
    // Hum stood 15-28 dB over its surroundings on air. The notches must run
    // in series: in parallel each band-pass's skirt landed on the other tones
    // and 400 Hz came out only 12 dB down.
    for (const [hz] of ladder) {
      const d = 20 * Math.log10(amp(out, hz, FS * 2, FS * 3) / amp(toPcm(x), hz, FS * 2, FS * 3));
      expect(d, `${hz} Hz`).toBeLessThan(-25);
    }
  });

  it('leaves speech alone when there is no tone', () => {
    const n = FS * 4;
    const pcm = toPcm(voice(n, 3));
    const an = make();
    const out = run(an, pcm);
    let e = 0, s = 0;
    for (let i = FS; i < n; i++) { const d = out[2 * i] - pcm[2 * i]; e += d * d; s += pcm[2 * i] ** 2; }
    expect(10 * Math.log10(e / s)).toBeLessThan(-30);
  });

  it('lets go when the tone stops, and does nothing while off', () => {
    const n = FS * 4;     // the notch holds on for a second after the tone
    const x = tones(n, [[1500, 2000]]);
    for (let i = FS * 2; i < n; i++) x[i] = 0;
    const an = make();
    run(an, toPcm(x));
    expect(an.activeHz()).toEqual([]);
    const off = new AutoNotch(); off.configure(FS);
    const pcm = toPcm(tones(FS, [[1500, 2000]]));
    expect(Array.from(run(off, pcm))).toEqual(Array.from(pcm));
  });
});
