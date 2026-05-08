// SSB demodulator unit tests. Synthetic single-tone I/Q is generated at a
// known audio frequency, fed through processSSB, and the resulting audio
// has its dominant frequency extracted via DFT. Correct demodulation lands
// the peak within ±20 Hz of the source tone; opposite-sideband demod should
// either suppress entirely or move the peak well outside that tolerance.

import { describe, it, expect } from 'vitest';
import { Demodulator } from '../src/demodulator.js';
import { generateCw, generateSsb, findPeakFreq } from './fixtures/iqGenerator.js';

const IQ_RATE = 12_000;        // 12 kHz, comfortably above the 3 kHz audio band
const AUDIO_RATE = IQ_RATE;    // decimate = 1 keeps the math simple in tests
const F_OFFSET = 1500;         // Weaver mid-band

function rms(pcm: Int16Array, channels = 2): number {
  let sum = 0;
  const N = Math.floor(pcm.length / channels);
  for (let i = 0; i < N; i++) sum += pcm[i * channels] ** 2;
  return Math.sqrt(sum / Math.max(1, N));
}

describe('processSSB — Weaver method', () => {
  it('USB demod recovers a 1 kHz tone from a USB-modulated IQ stream', () => {
    const iq = generateSsb({
      iqRate: IQ_RATE, durationSec: 0.34,
      audioFreqHz: 1000, sideBand: 'USB',
    });
    const d = new Demodulator();
    d.setupSsb(IQ_RATE, AUDIO_RATE, F_OFFSET);
    // Discard a settling window so LPF transients don't skew the FFT.
    d.processSSB(iq.subarray(0, 800 * 4), 1, 'USB');
    const pcm = d.processSSB(iq.subarray(800 * 4), 1, 'USB');
    const peak = findPeakFreq(pcm, AUDIO_RATE);
    expect(peak).toBeGreaterThanOrEqual(950);
    expect(peak).toBeLessThanOrEqual(1050);
  });

  it('LSB demod recovers a 1 kHz tone from an LSB-modulated IQ stream', () => {
    const iq = generateSsb({
      iqRate: IQ_RATE, durationSec: 0.34,
      audioFreqHz: 1000, sideBand: 'LSB',
    });
    const d = new Demodulator();
    d.setupSsb(IQ_RATE, AUDIO_RATE, F_OFFSET);
    d.processSSB(iq.subarray(0, 800 * 4), 1, 'LSB');
    const pcm = d.processSSB(iq.subarray(800 * 4), 1, 'LSB');
    const peak = findPeakFreq(pcm, AUDIO_RATE);
    expect(peak).toBeGreaterThanOrEqual(950);
    expect(peak).toBeLessThanOrEqual(1050);
  });

  it('opposite-sideband demod suppresses the signal heavily', () => {
    // USB-modulated source, run through LSB demod → should be heavily
    // attenuated (the LPF rejects the +2·f_off image). RMS comparison
    // against same-sideband demod gives the rejection ratio.
    const iq = generateSsb({
      iqRate: IQ_RATE, durationSec: 0.34,
      audioFreqHz: 1000, sideBand: 'USB',
    });
    const dCorrect = new Demodulator();
    dCorrect.setupSsb(IQ_RATE, AUDIO_RATE, F_OFFSET);
    dCorrect.processSSB(iq.subarray(0, 800 * 4), 1, 'USB'); // settle
    const correct = dCorrect.processSSB(iq.subarray(800 * 4), 1, 'USB');
    const dWrong = new Demodulator();
    dWrong.setupSsb(IQ_RATE, AUDIO_RATE, F_OFFSET);
    dWrong.processSSB(iq.subarray(0, 800 * 4), 1, 'LSB'); // settle
    const wrong = dWrong.processSSB(iq.subarray(800 * 4), 1, 'LSB');
    const correctRms = rms(correct);
    const wrongRms = rms(wrong);
    // Expect at least ~20 dB of suppression (factor of 10).
    expect(correctRms / Math.max(1, wrongRms)).toBeGreaterThan(10);
  });

  it('emits stereo-interleaved Int16 with L = R', () => {
    const iq = generateSsb({
      iqRate: IQ_RATE, durationSec: 0.1,
      audioFreqHz: 1000, sideBand: 'USB',
    });
    const d = new Demodulator();
    d.setupSsb(IQ_RATE, AUDIO_RATE, F_OFFSET);
    const pcm = d.processSSB(iq, 1, 'USB');
    expect(pcm.length).toBe((iq.length >> 2) * 2);
    for (let i = 0; i < pcm.length; i += 2) {
      expect(pcm[i]).toBe(pcm[i + 1]);
    }
  });

  it('decimate > 1 produces shorter output', () => {
    const iq = generateSsb({
      iqRate: IQ_RATE, durationSec: 0.1,
      audioFreqHz: 1000, sideBand: 'USB',
    });
    const d = new Demodulator();
    d.setupSsb(IQ_RATE, IQ_RATE / 2, F_OFFSET);
    const pcm = d.processSSB(iq, 2, 'USB');
    expect(pcm.length).toBe((iq.length >> 2) / 2 * 2);
  });
});

describe('processCW — BFO + Weaver', () => {
  it('produces an audible tone at the BFO pitch (~700 Hz) from an unmodulated carrier', () => {
    const iq = generateCw({ iqRate: IQ_RATE, durationSec: 0.34 });
    const d = new Demodulator();
    d.setupCw(IQ_RATE, AUDIO_RATE);
    d.processCW(iq.subarray(0, 800 * 4), 1); // settle
    const pcm = d.processCW(iq.subarray(800 * 4), 1);
    const peak = findPeakFreq(pcm, AUDIO_RATE);
    expect(peak).toBeGreaterThanOrEqual(650);
    expect(peak).toBeLessThanOrEqual(750);
  });

  it('honours custom BFO pitch', () => {
    const iq = generateCw({ iqRate: IQ_RATE, durationSec: 0.34 });
    const d = new Demodulator();
    d.setupCw(IQ_RATE, AUDIO_RATE, 500); // 500 Hz BFO instead of default 700
    d.processCW(iq.subarray(0, 800 * 4), 1);
    const pcm = d.processCW(iq.subarray(800 * 4), 1);
    const peak = findPeakFreq(pcm, AUDIO_RATE);
    expect(peak).toBeGreaterThanOrEqual(450);
    expect(peak).toBeLessThanOrEqual(550);
  });
});
