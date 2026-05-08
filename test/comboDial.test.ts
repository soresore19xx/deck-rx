// A3 — fake dial events against the Combo Options dial, asserting the
// resulting setFeedback payloads match the documented Mode/Step row state
// machine (preset ↔ vfo toggle + step cycling with both-end wrap to preset).

import { describe, it, expect, afterEach } from 'vitest';
import { startPlugin, type MockHarness } from './harness/streamDeckMock.js';

const COMBO_UUID = 'com.hogehoge.deck-rx.dial-options-combo';
const CTX = 'ctx-combo-1';

let harness: MockHarness | null = null;
afterEach(async () => { if (harness) { await harness.shutdown(); harness = null; } });

interface SetFeedbackMsg {
  event: 'setFeedback';
  context: string;
  payload: { 'options-display'?: string };
}

function decodeOptionsSvg(msg: unknown): string {
  const v = (msg as SetFeedbackMsg)?.payload?.['options-display'];
  if (typeof v !== 'string') return '';
  if (!v.startsWith('data:image/svg+xml;base64,')) return v;
  const b64 = v.slice('data:image/svg+xml;base64,'.length);
  return Buffer.from(b64, 'base64').toString('utf-8');
}

async function waitForCombFeedback(h: MockHarness): Promise<string> {
  const msg = await h.awaitMessage<SetFeedbackMsg>(
    m => (m as SetFeedbackMsg)?.event === 'setFeedback' && (m as SetFeedbackMsg)?.context === CTX,
    3000,
  );
  return decodeOptionsSvg(msg);
}

describe('A3 — Combo Options dial Mode/Step row', () => {
  it('initial render shows preset Mode in last row', async () => {
    harness = await startPlugin();
    await harness.willAppearDial(COMBO_UUID, CTX);
    await harness.settle(200);
    const svg = await waitForCombFeedback(harness);
    expect(svg).toMatch(/Mode/);
    expect(svg).toMatch(/Preset/);
  }, 10_000);

  it('dialRotate triggers re-render with focused selection', async () => {
    harness = await startPlugin();
    await harness.willAppearDial(COMBO_UUID, CTX);
    await harness.settle(200);
    // Drain the initial setFeedback so we observe only the post-rotate one.
    const cap = harness.startCapture();
    harness.dialRotate(COMBO_UUID, CTX, 1);
    await harness.settle(150);
    const fbs = cap.stop().filter(m => (m as { event?: string }).event === 'setFeedback');
    expect(fbs.length).toBeGreaterThan(0);
    // Selected-row sidebar uses fill="<accent>" with width="3". When focused,
    // it appears once on the active column (FM here). Initial unfocused render
    // omits it (focused=false). So a post-rotate render must contain a width=3
    // accent sidebar.
    const last = fbs[fbs.length - 1];
    const svg = decodeOptionsSvg(last);
    expect(svg).toMatch(/width="3"/);
  }, 10_000);

  it('preset → vfo on edit, vfo → preset on CCW past the smallest step', async () => {
    harness = await startPlugin();
    await harness.willAppearDial(COMBO_UUID, CTX);
    await harness.settle(200);

    // Navigate selectedIdx 0 → 6 (Mode/Step row), enter edit mode.
    for (let i = 0; i < 6; i++) harness.dialRotate(COMBO_UUID, CTX, 1);
    await harness.settle(100);
    harness.dialDown(COMBO_UUID, CTX);
    harness.dialUp(COMBO_UUID, CTX);
    await harness.settle(100);

    // CW edit on idx 6 in preset → toggles to vfo.
    harness.dialRotate(COMBO_UUID, CTX, 1);
    // Spin until we see "Step" text in a setFeedback payload (or fail after
    // a generous budget). spyService.setTuneMode → listener → render is
    // synchronous from the dial's perspective but goes through a couple of
    // queued microtasks + a config persistField write so we keep a margin.
    let vfoSvg = '';
    for (let attempt = 0; attempt < 20; attempt++) {
      const msg = await harness.awaitMessage<SetFeedbackMsg>(
        m => (m as SetFeedbackMsg)?.event === 'setFeedback' && (m as SetFeedbackMsg)?.context === CTX,
        2000,
      );
      const s = decodeOptionsSvg(msg);
      if (/>Step</.test(s)) { vfoSvg = s; break; }
    }
    expect(vfoSvg, 'Expected "Step" label after preset→vfo toggle').toMatch(/>Step</);
    // Both columns share the modeStepRow helper, so vfo mode renders "Step"
    // in both AM and FM columns. The default step is 9 kHz → "9k" should
    // appear as the value.
    expect(vfoSvg).toMatch(/>9k</);

    // Now CCW: cycle down through TUNE_STEP_VALUES then wrap back to preset.
    // List = [1, 10, 100, 1000, 5000, 9000, 10000, 25000, 50000, 100000,
    //        200000, 500000, 1000000]. Default after toggle is 9000 → 5
    // CCW reaches 1; one more wraps to preset. We send 8 CCW with margin.
    for (let i = 0; i < 8; i++) {
      harness.dialRotate(COMBO_UUID, CTX, -1);
      await harness.settle(40);
    }
    let presetSvg = '';
    for (let attempt = 0; attempt < 20; attempt++) {
      const msg = await harness.awaitMessage<SetFeedbackMsg>(
        m => (m as SetFeedbackMsg)?.event === 'setFeedback' && (m as SetFeedbackMsg)?.context === CTX,
        2000,
      );
      const s = decodeOptionsSvg(msg);
      if (/>Preset</.test(s)) { presetSvg = s; break; }
    }
    expect(presetSvg, 'Expected "Preset" after CCW past min step wraps').toMatch(/>Preset</);
  }, 20_000);
});
