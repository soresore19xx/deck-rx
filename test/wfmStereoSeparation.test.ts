import { describe, it, expect } from 'vitest';
import { Demodulator } from '../src/demodulator';

/**
 * Stereo separation on a standard-compliant composite.
 *
 * The generator matters more than the decoder here. Zenith-GE (ITU-R BS.450,
 * 47 CFR 73.322) carries the pilot and the suppressed subcarrier as sin(psi)
 * and sin(2*psi) — both crossing zero going positive at the same instant. The
 * test signal this repo used before 2026-09-12 built BOTH from cosine: self
 * consistent, so a decoder whose 38 kHz reference was in quadrature with the
 * real thing passed every assertion while delivering 0.0 dB of separation on
 * air. Generate the standard relationship, and the separation figure means
 * something.
 */
const DEV = 75_000;      // real WFM peak deviation, not the 50 kHz once used here

function composite(rate: number, seconds: number, left: number, right: number): Buffer {
  const n = Math.round(rate * seconds);
  const b = Buffer.alloc(n * 4);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const psi = 2 * Math.PI * 19_000 * t;
    const L = left > 0 ? Math.sin(2 * Math.PI * left * t) : 0;
    const R = right > 0 ? Math.sin(2 * Math.PI * right * t) : 0;
    const mpx = 0.9 * ((L + R) / 2 + ((L - R) / 2) * Math.sin(2 * psi))
              + 0.1 * Math.sin(psi);
    ph += 2 * Math.PI * DEV * mpx / rate;
    b.writeInt16LE(Math.round(8000 * Math.cos(ph)), i * 4);
    b.writeInt16LE(Math.round(8000 * Math.sin(ph)), i * 4 + 2);
  }
  return b;
}

/** Amplitude of one tone in one channel of interleaved PCM. */
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

function decode(rate: number, bwHz: number, iq: Buffer, decimate: number) {
  const d = new Demodulator();
  d.setStereo(rate);
  d.setWfmIfBandwidth(rate, bwHz / 2);
  d.setDeemphasis(rate / decimate, 50e-6);
  return { pcm: d.processWFMStereo(iq, decimate, 2000), audioRate: rate / decimate };
}

describe('WFM stereo separation', () => {
  // Both IQ rates the receiver actually runs at (SpyServer decimation offset
  // 1 and 0 on an Airspy HF+).
  for (const rate of [456_000, 912_000]) {
    it(`keeps left in left at ${rate / 1000} kHz IQ`, () => {
      const iq = composite(rate, 0.7, 1000, 0);          // left only
      const { pcm, audioRate } = decode(rate, 200_000, iq, 4);
      const skip = Math.round(audioRate * 0.3);          // PLL pull-in
      const wanted = tone(pcm, 0, 1000, audioRate, skip);
      const leak   = tone(pcm, 1, 1000, audioRate, skip);
      const sepDb  = 20 * Math.log10(wanted / Math.max(1e-30, leak));
      // Orientation first: a sign error in the 38 kHz reference separates just
      // as well and swaps the channels, which no level check would notice.
      expect(wanted).toBeGreaterThan(leak);
      expect(sepDb).toBeGreaterThan(30);
    });
  }

  it('recovers a difference signal at all, which the cosine reference did not', () => {
    // Independent tones left and right: Side/Mid is then about 0 dB. The
    // pre-2026-09-12 decoder returned L = R here (Side/Mid below -40 dB).
    const rate = 456_000;
    const iq = composite(rate, 0.7, 440, 1320);
    const { pcm, audioRate } = decode(rate, 200_000, iq, 4);
    const skip = Math.round(audioRate * 0.3);
    let mid = 0, side = 0, n = 0;
    for (let i = skip; i < pcm.length / 2; i++) {
      const m = (pcm[i * 2] + pcm[i * 2 + 1]) / 2;
      const s = (pcm[i * 2] - pcm[i * 2 + 1]) / 2;
      mid += m * m; side += s * s; n++;
    }
    const smDb = 10 * Math.log10((side / n) / (mid / n));
    expect(smDb).toBeGreaterThan(-6);
  });
});
