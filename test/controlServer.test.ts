// Integration tests for src/controlServer.ts — the loopback endpoint the
// BRIMFORD knob daemon (knobctl) drives the receiver through.
//
// The plugin runs sandboxed under the harness, so the control endpoint is off
// by default; `controlPort` opts this instance in on a port of its own and
// leaves the production plugin's 8771 alone.
//
// The mock SpyServer reports an Airspy HF+ (0.5–31 / 60–260 MHz, hardware gap
// 31–60 MHz), which is what makes the band-snap assertion meaningful.

import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'net';
import { resolve } from 'path';
import { startPlugin, type MockHarness } from './harness/streamDeckMock.js';

const TUNE_UUID = 'com.hogehoge.deck-rx.dial-tune';
const CTX = 'ctx-tune-control';
const PRESETS = resolve(__dirname, 'fixtures', 'deck-rx-presets.json');

let harness: MockHarness | null = null;
afterEach(async () => { if (harness) { await harness.shutdown(); harness = null; } });

/** Grab a port the OS just told us is free, so parallel runs don't collide. */
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

type Health = { ok: boolean; freq: number; volume: number; muted: boolean; enabled: boolean };

async function get(port: number, path: string): Promise<{ status: number; body: string }> {
  const r = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: r.status, body: await r.text() };
}
async function getJson(port: number, path: string): Promise<Record<string, number>> {
  const r = await fetch(`http://127.0.0.1:${port}${path}`);
  return await r.json() as Record<string, number>;
}
async function health(port: number): Promise<Health> {
  const r = await fetch(`http://127.0.0.1:${port}/health`);
  return await r.json() as Health;
}

/**
 * Boot a plugin whose config is deterministic for the assertions below.
 *
 * The Tune dial has to be on screen: spyService.connect() is driven from the
 * dial's onWillAppear, and it is that connect which restores lastFrequency.
 * With no dial appearing, the receiver never has a tuned freq for a relative
 * /tune to step from. Preset mode on purpose — in vfo mode the dial also
 * takes the freq from the server's CLIENT_SYNC frames, which the mock sends
 * zeroed and which would mask a missing force render in the LCD test.
 */
async function boot(
  port: number,
  config: Record<string, unknown> = {},
  dial: Record<string, unknown> = {},
  spectrumSocket?: string,
): Promise<MockHarness> {
  const h = await startPlugin({
    presetsPath: PRESETS,
    spyServer: true,
    controlPort: port,
    spectrumSocket,
    config: {
      enabled: true, audioEnabled: false, tuneMode: 'preset', demodMode: 2,
      lastFrequency: 594_000, tuneStepHz: 9_000, volume: 0.5, muted: false,
      ...config,
    },
  });
  await h.willAppearDial(TUNE_UUID, CTX, { mode: 'preset', stepHz: 9000, slotIndex: 0, borderSide: 'none', ...dial });
  return h;
}

// Each boot() spawns a real plugin process (~1.5 s), so related assertions
// share one instance rather than getting a harness each — the suite runs these
// files in parallel and a spawn storm here times other files out.
describe('controlServer — knob endpoints', () => {
  it('reports state, tunes, snaps out of the hardware gap, and rides volume / mute', async () => {
    const port = await freePort();
    harness = await boot(port);
    await harness.settle(1500);

    const h0 = await health(port);
    expect(h0.ok).toBe(true);
    expect(h0.freq).toBe(594_000);
    expect(h0.volume).toBeCloseTo(0.5, 5);
    expect(h0.muted).toBe(false);
    expect(h0.enabled).toBe(true);

    // Relative tune, both directions, in units of the receiver's tuneStepHz.
    expect((await get(port, '/tune?ticks=2')).status).toBe(200);
    expect((await health(port)).freq).toBe(612_000);   // 594 + 2 * 9 kHz
    await get(port, '/tune?ticks=-3');
    expect((await health(port)).freq).toBe(585_000);   // 612 - 3 * 9 kHz

    // Absolute tune, and the shared band math pulling an unreceivable freq
    // (40 MHz sits in the Airspy HF+ 31–60 MHz hardware gap) to a covered edge.
    await get(port, '/tune?hz=7200000');
    expect((await health(port)).freq).toBe(7_200_000);
    await get(port, '/tune?hz=40000000');
    expect((await health(port)).freq).toBe(31_000_000);

    // Volume: 2 % per tick, clamped at both ends.
    await get(port, '/volume?d=5');
    expect((await health(port)).volume).toBeCloseTo(0.6, 5);
    await get(port, '/volume?d=-10');
    expect((await health(port)).volume).toBeCloseTo(0.4, 5);
    await get(port, '/volume?d=100');
    expect((await health(port)).volume).toBe(1);
    await get(port, '/volume?d=-100');
    expect((await health(port)).volume).toBe(0);

    // Mute is a toggle, so a second press comes back.
    await get(port, '/mute?toggle=1');
    expect((await health(port)).muted).toBe(true);
    await get(port, '/mute?toggle=1');
    expect((await health(port)).muted).toBe(false);
  }, 25_000);

  it('toggles power, and refuses malformed requests without touching the receiver', async () => {
    const port = await freePort();
    harness = await boot(port);
    await harness.settle(1500);

    expect((await get(port, '/tune')).status).toBe(400);
    expect((await get(port, '/tune?ticks=abc')).status).toBe(400);
    expect((await get(port, '/volume')).status).toBe(400);
    expect((await get(port, '/mute')).status).toBe(400);        // toggle=1 required
    expect((await get(port, '/power?toggle=0')).status).toBe(400);
    expect((await get(port, '/nope')).status).toBe(404);
    const h = await health(port);
    expect(h.freq).toBe(594_000);
    expect(h.volume).toBeCloseTo(0.5, 5);
    expect(h.muted).toBe(false);

    // Power is the Tune dial's long press: tear the SpyServer link down.
    await get(port, '/power?toggle=1');
    await harness.settle(500);
    expect((await health(port)).enabled).toBe(false);
  }, 25_000);
});

describe('controlServer — the Tune dial keeps up with the knob', () => {
  it('a rotate right after a knob retune steps from the NEW freq, not the stale one', async () => {
    const port = await freePort();
    // vfo mode: a rotate here is a VFO step off the dial's own cached freq,
    // which is exactly the value a missing force render leaves stale. (In
    // preset mode a rotate cycles presets instead, so it cannot show this.)
    harness = await boot(port, { tuneMode: 'vfo' }, { mode: 'vfo' });
    await harness.settle(1500);

    // Rotate once first, so the dial's cached freq is populated. Without this
    // the dial would fall back to reading the service's freq on the next
    // rotate and the assertion below would pass even with no force render.
    harness.dialRotate(TUNE_UUID, CTX, 1);      // 594 → 603 kHz
    await harness.settle(400);                  // let its 200 ms debounce fire

    await get(port, '/tune?ticks=4');           // 603 + 4 * 9 = 639 kHz
    // Rotate immediately: the mock SpyServer echoes the tuned freq in its
    // CLIENT_SYNC frames (1 Hz) and the dial's vfo syncListener would adopt it
    // too, so acting inside that window keeps the force render the only thing
    // that can have updated the dial.
    harness.dialRotate(TUNE_UUID, CTX, 1);
    await harness.settle(600);

    const freqs = sentFreqs(harness);
    expect(freqs).toContain(648_000);           // 639 + 9 kHz — adopted
    expect(freqs).not.toContain(612_000);       // 603 + 9 kHz — stale
  }, 20_000);
});

describe('controlServer — preset mode follows the knob', () => {
  it('a retune off the selected preset redraws the freq instead of showing the preset', async () => {
    const port = await freePort();
    // Sit exactly on fixture preset slot 0 (693 kHz AM) so the dial starts
    // reconciled, then have the knob walk the receiver off it.
    const dialPort = port;
    harness = await boot(dialPort, { lastFrequency: 693_000, demodMode: 2 });
    await harness.settle(1500);

    // The footer timer redraws ~1 Hz. Two consecutive redraws must be
    // identical, or the "it changed" assertion below could pass on unrelated
    // churn rather than on the frequency.
    const a = harness.startCapture();
    await harness.settle(1100);
    const first = lastFreqDisplay(a.stop());
    const b = harness.startCapture();
    await harness.settle(1100);
    expect(first).not.toBeNull();
    expect(lastFreqDisplay(b.stop())).toBe(first);

    const c = harness.startCapture();
    await get(dialPort, '/tune?ticks=2');       // 693 + 2 * 9 = 711 kHz — no preset there
    await harness.settle(400);
    const after = lastFreqDisplay(c.stop());

    expect((await health(dialPort)).freq).toBe(711_000);
    expect(after).not.toBe(first);
  }, 25_000);

  it('a retune that lands exactly on a preset adopts that slot', async () => {
    const port = await freePort();
    harness = await boot(port, { lastFrequency: 693_000, demodMode: 2 });   // slot 0, AM
    await harness.settle(1500);

    const cap = harness.startCapture();
    await get(port, '/tune?hz=9910000');       // fixture slot 1, also AM — modes agree
    await harness.settle(400);
    // Plugin -> app setSettings carries the settings object as the payload itself.
    const settings = cap.stop().filter((m): m is { event: string; payload: { slotIndex?: number } } =>
      typeof m === 'object' && m !== null && (m as { event?: string }).event === 'setSettings');

    // The dial persists the reconciled slot, so a later onDidReceiveSettings
    // re-emit can't drag it back to the preset the knob tuned away from.
    expect(settings.map(x => x.payload?.slotIndex)).toContain(1);
  }, 25_000);
});

describe('controlServer — preset stepping (press-and-turn)', () => {
  it('walks the preset list in both directions and wraps', async () => {
    const port = await freePort();
    // Fixture slots by freq asc: 0 = 693 kHz AM, 1 = 9910 kHz AM, 2 = 90.5 MHz WFM.
    harness = await boot(port, { lastFrequency: 693_000, demodMode: 2 });
    await harness.settle(1500);

    await get(port, '/preset?d=1');
    await harness.settle(300);
    expect((await health(port)).freq).toBe(9_910_000);

    await get(port, '/preset?d=-1');
    await harness.settle(300);
    expect((await health(port)).freq).toBe(693_000);

    // Backwards off the first slot wraps to the last one.
    await get(port, '/preset?d=-1');
    await harness.settle(300);
    expect((await health(port)).freq).toBe(90_500_000);
  }, 25_000);

  it('crossing into a different demod mode still lands on the chosen preset', async () => {
    const port = await freePort();
    // Slot 1 (9910 kHz) is AM; stepping up to slot 2 (90.5 MHz) is also a
    // mode change AM -> WFM, which fires the Tune dial's demodListener
    // auto-jump. The receiver must still end on the preset we asked for.
    harness = await boot(port, { lastFrequency: 9_910_000, demodMode: 2 });
    await harness.settle(1500);

    await get(port, '/preset?d=1');
    await harness.settle(600);
    const h = await health(port);
    expect(h.freq).toBe(90_500_000);
  }, 25_000);

  it('answers 409 (not a silent 200) when there is no preset to land on', async () => {
    const port = await freePort();
    // An empty preset store: the request is well-formed but the receiver has
    // nowhere to step. knobctl logs any non-2xx, so this must not be a 200.
    harness = await startPlugin({
      presetsPath: resolve(__dirname, 'fixtures', 'deck-rx-presets-empty.json'),
      spyServer: true,
      controlPort: port,
      config: {
        enabled: true, audioEnabled: false, tuneMode: 'preset', demodMode: 2,
        lastFrequency: 594_000, tuneStepHz: 9_000, volume: 0.5, muted: false,
      },
    });
    await harness.willAppearDial(TUNE_UUID, CTX, { mode: 'preset', stepHz: 9000, slotIndex: 0, borderSide: 'none' });
    await harness.settle(1500);

    const r = await get(port, '/preset?d=1');
    expect(r.status).toBe(409);
    expect(r.body).toBe('no-presets');
    expect((await health(port)).freq).toBe(594_000);   // receiver untouched
  }, 25_000);

  it('rejects a d that is not exactly +1 / -1', async () => {
    const port = await freePort();
    harness = await boot(port, { lastFrequency: 693_000, demodMode: 2 });
    await harness.settle(1500);
    expect((await get(port, '/preset')).status).toBe(400);
    expect((await get(port, '/preset?d=0')).status).toBe(400);
    expect((await get(port, '/preset?d=3')).status).toBe(400);
    expect((await get(port, '/preset?d=abc')).status).toBe(400);
    expect((await health(port)).freq).toBe(693_000);
  }, 25_000);
});

describe('controlServer — demod mode', () => {
  it('reports and sets the mode, so a front-end can follow a preset out of AM', async () => {
    const port = await freePort();
    harness = await boot(port, { demodMode: 2, lastFrequency: 693_000 });
    await harness.settle(1500);

    expect((await getJson(port, '/mode')).mode).toBe(2);           // AM
    expect((await getJson(port, '/mode?m=1')).mode).toBe(1);       // WFM
    expect((await getJson(port, '/mode')).mode).toBe(1);

    // Tuning to an FM preset is mode + frequency; frequency alone lands the
    // receiver on the right MHz in the wrong demod, which is silence.
    await get(port, '/tune?hz=90500000');
    await harness.settle(300);
    const h = await health(port);
    expect(h.freq).toBe(90_500_000);
    expect((await getJson(port, '/mode')).mode).toBe(1);

    expect((await get(port, '/mode?m=99')).status).toBe(400);
    expect((await get(port, '/mode?m=abc')).status).toBe(400);
  }, 25_000);
});

describe('controlServer — VFO step', () => {
  it('reports the step and its ladder, sets one directly, and cycles', async () => {
    const port = await freePort();
    harness = await boot(port, { tuneStepHz: 10_000, demodMode: 2 });
    await harness.settle(1500);

    const base = await getJson(port, '/step') as unknown as { stepHz: number; values: number[] };
    expect(base.stepHz).toBe(10_000);
    // The ladder comes from the receiver so a front-end never hard-codes it.
    expect(base.values).toContain(9_000);

    // 9 kHz is the Japanese medium-wave channel spacing — the case that made
    // this endpoint necessary, since a 10 kHz step cannot land on 954 kHz.
    const set = await getJson(port, '/step?hz=9000') as unknown as { stepHz: number };
    expect(set.stepHz).toBe(9_000);
    await get(port, '/tune?ticks=1');
    expect((await health(port)).freq).toBe(603_000);   // 594 + 9 kHz

    // Cycling walks the ladder in both directions.
    expect((await getJson(port, '/step?d=1') as unknown as { stepHz: number }).stepHz).toBe(10_000);
    expect((await getJson(port, '/step?d=-1') as unknown as { stepHz: number }).stepHz).toBe(9_000);
    expect((await get(port, '/step?hz=0')).status).toBe(400);
  }, 25_000);
});

describe('controlServer — spectrum display settings', () => {
  it('reports current settings, applies changes, and clamps what it cannot do', async () => {
    const port = await freePort();
    const sock = `/tmp/deck-rx-spec-${process.pid}-${Math.random().toString(36).slice(2, 7)}.sock`;
    harness = await boot(port, {}, {}, sock);
    await harness.settle(1500);

    const base = await getJson(port, '/spectrum');
    expect(base.fftSize).toBe(1024);       // seeded default
    expect(base.fps).toBe(30);
    expect(base.smoothSpeed).toBe(30);

    const applied = await getJson(port, '/spectrum?fft=2048&fps=15&smooth=16');
    expect(applied).toEqual({ fftSize: 2048, fps: 15, smoothSpeed: 16 });
    // The change sticks: a bare read reports the new values.
    expect(await getJson(port, '/spectrum')).toEqual({ fftSize: 2048, fps: 15, smoothSpeed: 16 });

    // Out-of-range asks come back clamped rather than rejected, so a front-end
    // can offer a slider without policing the pipeline's limits itself.
    const clamped = await getJson(port, '/spectrum?fft=99999&fps=500&smooth=99999');
    expect(clamped.fftSize).toBe(4096);
    expect(clamped.fps).toBe(60);
    expect(clamped.smoothSpeed).toBe(1000);
    expect((await getJson(port, '/spectrum?smooth=0')).smoothSpeed).toBe(1);
    // Non-power-of-two sizes snap to the nearest one the FFT can build.
    expect((await getJson(port, '/spectrum?fft=700')).fftSize).toBe(512);
    expect((await get(port, '/spectrum?fps=abc')).status).toBe(400);
    expect((await get(port, '/spectrum?smooth=abc')).status).toBe(400);
  }, 25_000);
});

/** Last freq-display image the Tune dial pushed (7-seg digits, base64 SVG). */
function lastFreqDisplay(msgs: unknown[]): string | null {
  const fbs = msgs.filter((m): m is { event: string; context: string; payload: Record<string, unknown> } =>
    typeof m === 'object' && m !== null
    && (m as { event?: string }).event === 'setFeedback'
    && (m as { context?: string }).context === CTX);
  for (let i = fbs.length - 1; i >= 0; i--) {
    const v = fbs[i].payload?.['freq-display'];
    if (typeof v === 'string') return v;
  }
  return null;
}

/** IQ_FREQUENCY values the plugin pushed to the (mock) SpyServer. */
function sentFreqs(h: MockHarness): number[] {
  return h.spySettings.filter(s => s.setting === 101).map(s => s.value);
}
