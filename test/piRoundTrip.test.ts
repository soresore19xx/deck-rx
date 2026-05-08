// A4 — Property Inspector round-trip tests. Asserts the message handlers
// in spyDialTune.onSendToPlugin (getJpRegion / setJpRegion / setTuneMode /
// getJpStationsStatus / etc.) react correctly and bounce the right
// sendToPropertyInspector replies back.

import { describe, it, expect, afterEach } from 'vitest';
import { startPlugin, type MockHarness } from './harness/streamDeckMock.js';

const TUNE_UUID = 'com.hogehoge.deck-rx.dial-tune';
const CTX = 'ctx-tune-1';

let harness: MockHarness | null = null;
afterEach(async () => { if (harness) { await harness.shutdown(); harness = null; } });

interface SendToPI {
  event: 'sendToPropertyInspector';
  context: string;
  payload: Record<string, unknown>;
}

async function spawnTuneDial(h: MockHarness): Promise<void> {
  await h.willAppearDial(TUNE_UUID, CTX, { mode: 'preset', stepHz: 9000, slotIndex: 0, borderSide: 'none' });
  // SDK gates sendToPropertyInspector replies on the PI being visible.
  // Mock that visibility so plugin → PI messages get sent on the wire.
  h.showPropertyInspector(TUNE_UUID, CTX);
  await h.settle(150);
}

async function awaitPI(h: MockHarness, action: string, timeoutMs = 3000): Promise<Record<string, unknown>> {
  const msg = await h.awaitMessage<SendToPI>(
    m => {
      const x = m as SendToPI;
      return x?.event === 'sendToPropertyInspector'
          && x?.context === CTX
          && (x?.payload as { action?: string })?.action === action;
    },
    timeoutMs,
  );
  return msg.payload;
}

describe('A4 — PI round-trip handlers in spyDialTune', () => {
  it('getJpRegion replies with current active region', async () => {
    harness = await startPlugin();
    await spawnTuneDial(harness);
    harness.sendToPlugin(TUNE_UUID, CTX, { action: 'getJpRegion' });
    const reply = await awaitPI(harness, 'jpRegion');
    expect(reply.region).toBe('kanto');
  }, 10_000);

  it('setJpRegion persists + bounces back jpStationsStatus with new region', async () => {
    harness = await startPlugin();
    await spawnTuneDial(harness);

    // First confirm starting region is kanto via getJpRegion.
    harness.sendToPlugin(TUNE_UUID, CTX, { action: 'getJpRegion' });
    expect((await awaitPI(harness, 'jpRegion')).region).toBe('kanto');

    // Switch to 近畿. Plugin replies with a fresh jpStationsStatus reflecting
    // the new region (count switches to the kinki entry pool).
    harness.sendToPlugin(TUNE_UUID, CTX, { action: 'setJpRegion', region: 'kinki' });
    const status = await awaitPI(harness, 'jpStationsStatus');
    expect(status.region).toBe('kinki');
    // Auto-scraped pool currently has only 関東 entries in the seed file →
    // count for kinki should be 0; manualCount should still report all 11
    // hand-curated entries (manualStations are region-tagged but the status
    // reports the absolute count regardless of active region).
    expect(status.count).toBe(0);
    expect(typeof status.manualCount).toBe('number');
    expect(status.manualCount).toBeGreaterThanOrEqual(11);

    // And getJpRegion now returns kinki.
    harness.sendToPlugin(TUNE_UUID, CTX, { action: 'getJpRegion' });
    expect((await awaitPI(harness, 'jpRegion')).region).toBe('kinki');
  }, 10_000);

  it('setJpRegion to a bogus value is rejected', async () => {
    harness = await startPlugin();
    await spawnTuneDial(harness);
    harness.sendToPlugin(TUNE_UUID, CTX, { action: 'setJpRegion', region: 'shikoku' });
    // No jpStationsStatus reply expected; getJpRegion still returns kanto.
    await harness.settle(150);
    harness.sendToPlugin(TUNE_UUID, CTX, { action: 'getJpRegion' });
    expect((await awaitPI(harness, 'jpRegion')).region).toBe('kanto');
  }, 10_000);

  it('setTuneMode propagates mode + step into spyService (PI Mode dropdown bug fix regression)', async () => {
    harness = await startPlugin();
    await spawnTuneDial(harness);

    // Capture all setFeedback messages from now on so we can verify the
    // header changes after the mode flip.
    const cap = harness.startCapture();

    // Send the same PI nudge that inspector.html dispatches when the user
    // picks "VFO step" from the Mode dropdown (per spyDialTune commit
    // 22e180b: PI Mode/Step changes now propagate to spyService).
    harness.sendToPlugin(TUNE_UUID, CTX, { action: 'setTuneMode', mode: 'vfo', stepHz: 100_000 });

    // Wait long enough for spyService.setTuneMode → tuneModeListener →
    // updateDisplay → setFeedback round-trip to settle.
    await harness.settle(300);

    const msgs = cap.stop();
    // We expect at least one setFeedback after the mode switch — the
    // Tune dial re-renders its header on tuneMode change. The header now
    // shows "VFO" prefix when in VFO mode (vs "<mode>  <preset name>"
    // in preset mode), so a header SVG containing "VFO" should be in
    // the captured stream.
    const headerWithVfo = msgs.find(m => {
      const x = m as { event?: string; payload?: { header?: string } };
      if (x?.event !== 'setFeedback') return false;
      const headerSvg = x.payload?.header;
      if (typeof headerSvg !== 'string' || !headerSvg.startsWith('data:image/svg+xml;base64,')) return false;
      const decoded = Buffer.from(headerSvg.split(',')[1], 'base64').toString('utf-8');
      return /VFO/.test(decoded);
    });
    expect(headerWithVfo, 'expected header to flip to VFO after setTuneMode').toBeTruthy();
  }, 10_000);
});
