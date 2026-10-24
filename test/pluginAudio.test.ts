// The plugin's whole audio path, end to end: a mock SpyServer streams IQ in
// packets, the running plugin connects, starts its stream and demodulates
// through its channel stage (src/channel.ts), and its audio goes to a file
// (DECK_RX_AUDIO_FILE) instead of a device — nothing is played. What comes
// out is measured: a 1 kHz tone has to come out clean for every mode family.
//
// Written on 2026-10-25 after the channel stage went into src/spyService.ts:
// the unit tests (test/channelStage.test.ts) drive the Demodulator directly,
// and nothing else ran the wiring in between — the rates the detectors are
// set up at, the divisor handed to them, the scale.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { startPlugin, type MockHarness } from './harness/streamDeckMock.js';

let harness: MockHarness | null = null;
afterEach(async () => { if (harness) { await harness.shutdown(); harness = null; } });

function iqFor(kind: 'fm' | 'am' | 'usb') {
  return (rate: number, samples: number): Buffer => {
    const b = Buffer.alloc(samples * 4);
    let ph = 0;
    for (let k = 0; k < samples; k++) {
      const t = k / rate;
      let I: number, Q: number;
      if (kind === 'fm') {
        ph += 2 * Math.PI * 75_000 * (Math.sin(2 * Math.PI * 1000 * t) / 2) / rate;
        I = 0.3 * Math.cos(ph); Q = 0.3 * Math.sin(ph);
      } else if (kind === 'am') {
        I = 0.3 * (1 + 0.6 * Math.sin(2 * Math.PI * 1000 * t)); Q = 0;
      } else {
        I = 0.3 * Math.cos(2 * Math.PI * 1000 * t); Q = 0.3 * Math.sin(2 * Math.PI * 1000 * t);
      }
      b.writeInt16LE(Math.round(I * 32767), k * 4);
      b.writeInt16LE(Math.round(Q * 32767), k * 4 + 2);
    }
    return b;
  };
}

/** SINAD of the 1 kHz tone on the left channel, least squares, over the last half. */
function sinad(pcm: Int16Array, rate: number, channels: number): number {
  const n = Math.floor(pcm.length / channels), s0 = Math.floor(n / 2);
  const a = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], bb = [0, 0, 0];
  for (let i = s0; i < n; i++) {
    const t = 2 * Math.PI * 1000 * i / rate, f = [1, Math.cos(t), Math.sin(t)], x = pcm[i * channels];
    for (let r = 0; r < 3; r++) { bb[r] += f[r] * x; for (let c = 0; c < 3; c++) a[r][c] += f[r] * f[c]; }
  }
  for (let p = 0; p < 3; p++) for (let r = p + 1; r < 3; r++) {
    const m = a[r][p] / a[p][p];
    for (let c = p; c < 3; c++) a[r][c] -= m * a[p][c];
    bb[r] -= m * bb[p];
  }
  const v = [0, 0, 0];
  for (let r = 2; r >= 0; r--) { let s = bb[r]; for (let c = r + 1; c < 3; c++) s -= a[r][c] * v[c]; v[r] = s / a[r][r]; }
  let e = 0;
  for (let i = s0; i < n; i++) {
    const t = 2 * Math.PI * 1000 * i / rate;
    const d = pcm[i * channels] - v[0] - v[1] * Math.cos(t) - v[2] * Math.sin(t); e += d * d;
  }
  return 10 * Math.log10(((v[1] ** 2 + v[2] ** 2) / 2) / Math.max(e / (n - s0), 1e-30));
}

async function run(mode: number, kind: 'fm' | 'am' | 'usb', freq: number): Promise<number> {
  const dir = mkdtempSync(resolve(tmpdir(), 'deck-rx-audio-'));
  const audioFile = resolve(dir, 'out.pcm');
  harness = await startPlugin({
    spyServer: { iq: iqFor(kind) },
    audioFile,
    // Volume down and the automatic gain off: the tone is a strong signal
    // (0.3 of full scale), which at full volume rides SSB's x3 makeup into the
    // soft limiter by design, and the gain search mutes while it steps.
    config: { enabled: true, audioEnabled: true, demodMode: mode, lastFrequency: freq,
              iqDecimation: 1, audioDecimate: 4, volume: 0.2, autoGain: false },
  });
  // Connect, start the stream, run ~2.5 s of audio.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !(existsSync(audioFile) && readFileSync(audioFile).length > 456_000 / 4 * 4 * 2.5)) {
    await harness.settle(250);
  }
  const meta = JSON.parse(readFileSync(`${audioFile}.json`, 'utf8')) as { sampleRate: number; channels: number };
  const raw = readFileSync(audioFile);
  const pcm = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 2));
  return sinad(pcm, meta.sampleRate, meta.channels);
}

describe('plugin audio path, end to end (no sound)', () => {
  it('WFM: a 1 kHz tone comes out clean through the channel stage', async () => {
    expect(await run(1, 'fm', 80_000_000)).toBeGreaterThan(40);
  }, 30_000);
  it('AM: a 1 kHz tone comes out clean', async () => {
    expect(await run(2, 'am', 954_000)).toBeGreaterThan(35);
  }, 30_000);
  it('USB: a tone 1 kHz up comes out at 1 kHz, clean', async () => {
    expect(await run(4, 'usb', 7_100_000)).toBeGreaterThan(35);
  }, 30_000);
});
