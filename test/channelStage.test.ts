import { describe, it, expect } from 'vitest';
import { Demodulator, fmOutputScale, SSB_GAIN, NFM_GAIN, WFM_STEREO_GAIN } from '../src/demodulator.js';
import { Channelizer, channelPlan, FM_EQUALISER_PASS_HZ } from '../src/channel.js';

/**
 * The channel stage (src/channel.ts), checked the way the plugin runs it: the
 * stream's audio rate fixed, the IQ in SpyServer-sized packets. The figures
 * and their reasons are native-app's (Tests/ChannelTests.swift, the quality
 * bench of 2026-10-25); this is the same behaviour, held in place here.
 */

interface Carrier { offset: number; amp: number; dev?: number; fm?: (t: number) => number; am?: (t: number) => number }

/** int16 IQ as a receiver hands it over: made at 2.4 MHz or more and
 *  decimated through a filter, so an FM signal's tails do not fold back the
 *  way they would if sampled straight at a low rate. */
function makeIq(rate: number, seconds: number, cs: Carrier[], noise = 0,
                echo?: { delay: number; gain: number; rot: number }): Buffer {
  const k = Math.max(1, Math.ceil(2_400_000 / rate));
  const r = rate * k, n = Math.round(r * seconds);
  const I = new Float64Array(n), Q = new Float64Array(n);
  const ph = new Float64Array(cs.length);
  for (let i = 0; i < n; i++) {
    const t = i / r;
    cs.forEach((c, j) => {
      ph[j] += 2 * Math.PI * (c.offset + (c.dev ?? 0) * (c.fm ? c.fm(t) : 0)) / r;
      const a = c.amp * (1 + 0.6 * (c.am ? c.am(t) : 0));
      I[i] += a * Math.cos(ph[j]); Q[i] += a * Math.sin(ph[j]);
    });
  }
  if (echo) {
    const dl = Math.round(echo.delay * r), c = Math.cos(echo.rot) * echo.gain, s = Math.sin(echo.rot) * echo.gain;
    const i0 = I.slice(), q0 = Q.slice();
    for (let i = dl; i < n; i++) { I[i] += i0[i - dl] * c - q0[i - dl] * s; Q[i] += i0[i - dl] * s + q0[i - dl] * c; }
  }
  let seed = 0x5150;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
  const b = Buffer.alloc(n * 4);
  const q = (v: number) => Math.max(-32767, Math.min(32767, Math.round(v * 32767)));
  for (let i = 0; i < n; i++) {
    b.writeInt16LE(q(I[i] + noise * Math.sqrt(k) * rnd()), i * 4);
    b.writeInt16LE(q(Q[i] + noise * Math.sqrt(k) * rnd()), i * 4 + 2);
  }
  if (k === 1) return b;
  const edge = rate * 0.42;
  const ch = new Channelizer();
  ch.configure(r, { decimation: k, channelRate: rate, passHz: edge, protectHz: edge, audioDecimation: 1 });
  return ch.process(b);
}

/** Least-squares DC + tone; the rest is everything else. */
function sinad(x: Float64Array, rate: number, tone: number): number {
  const s0 = Math.floor(x.length / 2);
  const a = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], bb = [0, 0, 0];
  for (let i = s0; i < x.length; i++) {
    const t = 2 * Math.PI * tone * i / rate, f = [1, Math.cos(t), Math.sin(t)];
    for (let r = 0; r < 3; r++) { bb[r] += f[r] * x[i]; for (let c = 0; c < 3; c++) a[r][c] += f[r] * f[c]; }
  }
  for (let p = 0; p < 3; p++) for (let r = p + 1; r < 3; r++) {
    const m = a[r][p] / a[p][p];
    for (let c = p; c < 3; c++) a[r][c] -= m * a[p][c];
    bb[r] -= m * bb[p];
  }
  const v = [0, 0, 0];
  for (let r = 2; r >= 0; r--) { let s = bb[r]; for (let c = r + 1; c < 3; c++) s -= a[r][c] * v[c]; v[r] = s / a[r][r]; }
  let e = 0;
  for (let i = s0; i < x.length; i++) {
    const t = 2 * Math.PI * tone * i / rate;
    const d = x[i] - v[0] - v[1] * Math.cos(t) - v[2] * Math.sin(t); e += d * d;
  }
  return 10 * Math.log10(((v[1] ** 2 + v[2] ** 2) / 2) / (e / (x.length - s0)));
}

function channelOf(pcm: Int16Array, ch: number): Float64Array {
  const o = new Float64Array(pcm.length / 2);
  for (let i = 0; i < o.length; i++) o[i] = pcm[i * 2 + ch];
  return o;
}

type Detect = (d: Demodulator, b: Buffer, dec: number, scale: number) => Int16Array;

/** The plugin's path: channel stage, then the detector, in 16384-sample packets. */
function viaChannel(iq: Buffer, iqRate: number, audioDec: number, mode: number, detect: Detect,
                    setup: (d: Demodulator, chRate: number, audioRate: number, wide: boolean) => void,
                    eq = true): { pcm: Int16Array; audioRate: number } {
  const plan = channelPlan(iqRate, audioDec, mode, mode === 1 ? 250_000 : 12_500, 9_000, 2_400);
  const ch = new Channelizer();
  ch.configure(iqRate, plan);
  const d = new Demodulator();
  setup(d, plan.channelRate, iqRate / audioDec, mode === 1);
  d.setWfmEqualizer(eq);
  const parts: Int16Array[] = [];
  for (let o = 0; o < iq.length; o += 65_536) {
    parts.push(detect(d, ch.process(iq.subarray(o, Math.min(iq.length, o + 65_536))), plan.audioDecimation,
                      fmOutputScale(plan.channelRate)));
  }
  const pcm = new Int16Array(parts.reduce((a, p) => a + p.length, 0));
  let k = 0; for (const p of parts) { pcm.set(p, k); k += p.length; }
  return { pcm, audioRate: iqRate / audioDec };
}

const wfmSetup = (d: Demodulator, r: number, ar: number, wide: boolean) => {
  d.setStereo(r); d.setWfmIfBandwidth(r, wide ? 125_000 : 6_250, wide); d.setDeemphasis(ar, 50e-6);
};
const left = (t: number) => {
  const psi = 2 * Math.PI * 19_000 * t, L = Math.sin(2 * Math.PI * 1000 * t);
  return 0.9 * (L / 2 + (L / 2) * Math.sin(2 * psi)) + 0.1 * Math.sin(psi);
};

describe('channel plan, the stream audio rate fixed', () => {
  it('HF+ 456 kHz, audio /4: WFM is not decimated, but filtered to the whole FM signal', () => {
    const p = channelPlan(456_000, 4, 1, 250_000, 9_000, 2_400);
    expect(p.decimation).toBe(1);
    expect(p.audioDecimation).toBe(4);
    expect(p.passHz).toBeGreaterThanOrEqual(FM_EQUALISER_PASS_HZ);
    const ch = new Channelizer(); ch.configure(456_000, p);
    expect(ch.isIdentity).toBe(false);
  });
  it('AM, SSB and CW go straight to the audio rate', () => {
    for (const m of [2, 4, 5, 6]) {
      const p = channelPlan(456_000, 4, m, 250_000, 9_000, 2_400);
      expect(p.decimation).toBe(4);
      expect(p.audioDecimation).toBe(1);
    }
  });
  it('V4 at 2.4 MHz, audio /4: WFM decimates by 4 and keeps a 600 kHz channel', () => {
    const p = channelPlan(2_400_000, 4, 1, 250_000, 9_000, 2_400);
    expect(p.decimation).toBe(4);
    expect(p.channelRate).toBe(600_000);
  });
  it('the divisor always divides the audio divisor', () => {
    for (const r of [228_000, 456_000, 912_000, 1_200_000, 2_400_000]) for (const a of [1, 2, 4, 8]) for (const m of [0, 1, 2, 4, 5]) {
      const p = channelPlan(r, a, m, 250_000, 9_000, 2_400);
      expect(a % p.decimation).toBe(0);
      expect(p.decimation * p.audioDecimation).toBe(a);
    }
  });
});

describe('channel stage, end to end', () => {
  it('SSB at 456 kHz / 4: as clean as the old full-rate path, not worse', () => {
    const rate = 456_000, iq = makeIq(rate, 1.0, [{ offset: 1000, amp: 0.3 }], 0.05);
    const ssb: Detect = (d, b, dec) => d.processSSB(b, dec, 'USB', SSB_GAIN);
    const setup = (d: Demodulator, r: number, ar: number) => d.setupSsb(r, ar, 1200);
    const got = viaChannel(iq, rate, 4, 4, ssb, setup);
    const old = new Demodulator(); old.setupSsb(rate, rate / 4, 1200);
    const ref = old.processSSB(iq, 4, 'USB', SSB_GAIN);
    const sGot = sinad(channelOf(got.pcm, 0), got.audioRate, 1000), sRef = sinad(channelOf(ref, 0), rate / 4, 1000);
    expect(sGot).toBeGreaterThanOrEqual(sRef - 0.5);
  });

  it('NFM: a station 25 kHz off no longer comes through', () => {
    const rate = 456_000;
    const want: Carrier = { offset: 0, amp: 0.3, dev: 2_500, fm: (t) => Math.sin(2 * Math.PI * 1000 * t) };
    const other: Carrier = { offset: 25_000, amp: 0.3, dev: 2_500, fm: (t) => Math.sin(2 * Math.PI * 2700 * t) };
    const nfm: Detect = (d, b, dec, sc) => d.processFM(b, dec, NFM_GAIN * sc);
    const alone = viaChannel(makeIq(rate, 0.6, [want], 0.002), rate, 4, 0, nfm, wfmSetup);
    const both = viaChannel(makeIq(rate, 0.6, [want, other], 0.002), rate, 4, 0, nfm, wfmSetup);
    const a = sinad(channelOf(alone.pcm, 0), alone.audioRate, 1000), b = sinad(channelOf(both.pcm, 0), both.audioRate, 1000);
    expect(b).toBeGreaterThanOrEqual(a - 3);
  });

  it('WFM stereo: the equaliser costs a clean signal nothing and cleans an echo', () => {
    const rate = 456_000;
    const st: Detect = (d, b, dec, sc) => d.processWFMStereo(b, dec, WFM_STEREO_GAIN * sc);
    const sep = (pcm: Int16Array, ar: number) => {
      // Separation from the residual in the right channel against the left tone.
      const l = channelOf(pcm, 0), r = channelOf(pcm, 1);
      let pl = 0, pr = 0;
      for (let i = Math.floor(l.length / 2); i < l.length; i++) { pl += l[i] * l[i]; pr += r[i] * r[i]; }
      void ar;
      return 10 * Math.log10(pl / Math.max(pr, 1e-30));
    };
    const clean = makeIq(rate, 1.0, [{ offset: 0, amp: 0.3, dev: 75_000, fm: left }]);
    const echo = makeIq(rate, 1.0, [{ offset: 0, amp: 0.3, dev: 75_000, fm: left }], 0, { delay: 8.8e-6, gain: 0.3, rot: 1.2 });
    const cOff = viaChannel(clean, rate, 4, 1, st, wfmSetup, false), cOn = viaChannel(clean, rate, 4, 1, st, wfmSetup, true);
    const eOff = viaChannel(echo, rate, 4, 1, st, wfmSetup, false), eOn = viaChannel(echo, rate, 4, 1, st, wfmSetup, true);
    expect(sep(cOn.pcm, cOn.audioRate)).toBeGreaterThanOrEqual(sep(cOff.pcm, cOff.audioRate) - 0.5);
    expect(sep(eOn.pcm, eOn.audioRate)).toBeGreaterThanOrEqual(sep(eOff.pcm, eOff.audioRate) + 10);
  });

  it('WFM: a neighbour 200 kHz off at the same level leaves the wanted station', () => {
    const rate = 456_000;
    const want: Carrier = { offset: 0, amp: 0.3, dev: 75_000, fm: (t) => Math.sin(2 * Math.PI * 1000 * t) / 2 };
    const other: Carrier = { offset: 200_000, amp: 0.3, dev: 75_000, fm: (t) => Math.sin(2 * Math.PI * 2700 * t) };
    const mono: Detect = (d, b, dec, sc) => d.processWFM(b, dec, 3000 * sc);
    const alone = viaChannel(makeIq(rate, 0.6, [want]), rate, 4, 1, mono, wfmSetup);
    const both = viaChannel(makeIq(rate, 0.6, [want, other]), rate, 4, 1, mono, wfmSetup);
    const a = sinad(channelOf(alone.pcm, 0), alone.audioRate, 1000), b = sinad(channelOf(both.pcm, 0), both.audioRate, 1000);
    expect(b).toBeGreaterThan(40);
    expect(b).toBeGreaterThanOrEqual(Math.min(a, 70) - 10);
  });
});
