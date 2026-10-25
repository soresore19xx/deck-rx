// The IQ width a user picks (`/iq`, the Tune dial's "IQ rate" row, Deck RX's
// IQ menu), end to end: the running plugin against the mock SpyServer, its
// audio to a file so the stream really starts. Before 2026-10-25 the plugin
// had no way to set it at all: it took the narrowest width the mode allowed,
// which on the V4 over SpyServer is 300 kHz.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import net from 'net';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { startPlugin, type MockHarness } from './harness/streamDeckMock.js';

let harness: MockHarness | null = null;
let dir = '';
afterEach(async () => {
  if (harness) { await harness.shutdown(); harness = null; }
  if (dir) { rmSync(dir, { recursive: true, force: true }); dir = ''; }
});

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => res(port));
    });
  });
}

type Menu = { choices: { offset: number; rateHz: number }[]; currentHz: number; chosen: number | null };

async function until<T>(get: () => Promise<T>, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  let v = await get();
  while (!ok(v) && Date.now() < end) { await new Promise(r => setTimeout(r, 100)); v = await get(); }
  return v;
}

describe('the IQ width', () => {
  it('lists the receiver widths, takes a pick, restarts the stream at it, and files it', async () => {
    const port = await freePort();
    dir = mkdtempSync(resolve(tmpdir(), 'deck-rx-iq-'));
    // An AM carrier: anything will do, the stream only has to run.
    const iq = (_rate: number, samples: number) => {
      const b = Buffer.alloc(samples * 4);
      for (let k = 0; k < samples; k++) b.writeInt16LE(8000, k * 4);
      return b;
    };
    harness = await startPlugin({
      spyServer: { iq },
      audioFile: resolve(dir, 'out.pcm'),
      controlPort: port,
      config: { enabled: true, audioEnabled: true, demodMode: 2, lastFrequency: 594_000,
                iqDecimation: 1, audioDecimate: 4, volume: 0.2, autoGain: false },
    });
    const menu = () => fetch(`http://127.0.0.1:${port}/iq`).then(r => r.json() as Promise<Menu>);

    // The mock is an HF+: 912 kHz, minimum decimation 1, eight stages. Its
    // widths from 456 kHz down, none under 100 kHz.
    const before = await until(menu, m => m.currentHz > 0);
    expect(before.choices).toEqual([
      { offset: 0, rateHz: 456_000 }, { offset: 1, rateHz: 228_000 }, { offset: 2, rateHz: 114_000 },
    ]);
    expect(before.currentHz).toBe(228_000);

    const r = await fetch(`http://127.0.0.1:${port}/iq?offset=2`);
    expect(r.status).toBe(200);
    const after = await until(menu, m => m.currentHz === 114_000);
    expect(after.currentHz).toBe(114_000);
    expect(after.chosen).toBe(2);
    // On the wire: the decimation stage is the offset past the minimum.
    const dec = harness.spySettings.filter(s => s.setting === 102).map(s => s.value);
    expect(dec[dec.length - 1]).toBe(3);
    // Filed under the receiver, where the next connect reads it first.
    const cfg = JSON.parse(readFileSync(harness.configPath, 'utf8')) as
      { devices?: Record<string, { iqDecimation?: number }> };
    expect(Object.values(cfg.devices ?? {}).some(p => p.iqDecimation === 2)).toBe(true);

    // Not one of its widths: refused, nothing changed.
    expect((await fetch(`http://127.0.0.1:${port}/iq?offset=7`)).status).toBe(409);
    expect((await menu()).currentHz).toBe(114_000);
  }, 40_000);
});
