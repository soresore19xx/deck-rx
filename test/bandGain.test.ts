// Gain kept per band, through the running plugin and its config file.
//
// test/deviceSettings.test.ts covers the resolver. This covers what it cannot:
// that a retune crossing a band picks the other band's gains up, and that a
// gain changed while listening lands in the slot for the band being listened
// to — on disk, where the next connect reads it. The resolver's own tests
// passed on 2026-09-21 while the file round trip lost a receiver's profile,
// which is why this one exists.
//
// The mock SpyServer reports an Airspy HF+ (deviceType 2, serial 0,
// maxGainIndex 8), so the profile key is 2:00000000.

import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'net';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { startPlugin, type MockHarness } from './harness/streamDeckMock.js';

const TUNE_UUID = 'com.hogehoge.deck-rx.dial-tune';
const CTX = 'ctx-tune-bandgain';
const PRESETS = resolve(__dirname, 'fixtures', 'deck-rx-presets.json');
const KEY = '2:00000000';

let harness: MockHarness | null = null;
afterEach(async () => { if (harness) { await harness.shutdown(); harness = null; } });

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => res(port));
    });
  });
}

type Gains = { am: number; fm: number; max: number };
async function gains(port: number): Promise<Gains> {
  const r = await fetch(`http://127.0.0.1:${port}/options`);
  return (await r.json() as { gain: Gains }).gain;
}
async function get(port: number, path: string): Promise<number> {
  return (await fetch(`http://127.0.0.1:${port}${path}`)).status;
}
type Profile = { amGain?: number; fmGain?: number; iqDecimation?: number;
                 gains?: Record<string, { am?: number; fm?: number }> };
function profileOnDisk(h: MockHarness): Profile {
  const cfg = JSON.parse(readFileSync(h.configPath, 'utf8')) as { devices?: Record<string, Profile> };
  return cfg.devices?.[KEY] ?? {};
}

describe('gain per band, end to end', () => {
  it('follows the band on retune and files a change under the band in use', async () => {
    const port = await freePort();
    harness = await startPlugin({
      presetsPath: PRESETS,
      spyServer: true,
      controlPort: port,
      config: {
        enabled: true, audioEnabled: false, tuneMode: 'vfo', demodMode: 2,
        lastFrequency: 594_000, tuneStepHz: 9_000,
        // Top-level values that belong to no band in particular, as an older
        // config has them. The slots below must win over them.
        amGain: 5, fmGain: 6,
        devices: { [KEY]: {
          iqDecimation: 1, audioDecimate: 4, amGain: 5, fmGain: 6,
          gains: { mw: { am: 2, fm: 3 }, hf: { am: 7, fm: 8 } },
        } },
      },
    });
    await harness.willAppearDial(TUNE_UUID, CTX, { mode: 'vfo', stepHz: 9000, borderSide: 'none' });
    await harness.settle(1500);

    // Connected on mediumwave: the mw slot, not the top-level 5 / 6.
    expect(await gains(port)).toMatchObject({ am: 2, fm: 3 });

    // Across to shortwave and back.
    expect(await get(port, '/tune?hz=6030000')).toBe(200);
    await harness.settle(200);
    expect(await gains(port)).toMatchObject({ am: 7, fm: 8 });
    expect(await get(port, '/tune?hz=594000')).toBe(200);
    await harness.settle(200);
    expect(await gains(port)).toMatchObject({ am: 2, fm: 3 });

    // A retune inside a band leaves the gain alone.
    expect(await get(port, '/tune?hz=810000')).toBe(200);
    await harness.settle(200);
    expect(await gains(port)).toMatchObject({ am: 2, fm: 3 });

    // Change the AM gain on shortwave: it goes into hf.am, and only there.
    expect(await get(port, '/tune?hz=6030000')).toBe(200);
    await harness.settle(200);
    expect(await get(port, '/options?set=gain&value=4')).toBe(200);
    await harness.settle(300);
    const p = profileOnDisk(harness);
    expect(p.gains).toEqual({ mw: { am: 2, fm: 3 }, hf: { am: 4, fm: 8 } });
    // The rest of the profile is carried, not dropped by the write.
    expect(p.iqDecimation).toBe(1);

    // And it is what shortwave comes back to after a trip to mediumwave.
    expect(await get(port, '/tune?hz=594000')).toBe(200);
    await harness.settle(200);
    expect((await gains(port)).am).toBe(2);
    expect(await get(port, '/tune?hz=6030000')).toBe(200);
    await harness.settle(200);
    expect((await gains(port)).am).toBe(4);
  }, 30_000);
});
