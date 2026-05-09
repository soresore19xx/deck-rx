// A3 — fake dial events against the Combo Options dial, asserting the
// resulting setFeedback payloads match the F-2 layout: left column lists 6
// demod bands (WFM/NFM/AM/USB/LSB/CW) plus a Mode/Step bottom row, right
// column shows mode-dependent option rows (AM/FM/SSB shapes differ). The
// cursor is a single continuous index across both columns; PUSH on a Band
// row immediately calls setDemodMode (no edit-mode roundtrip).

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

  it('initial render shows Band column with all 6 mode labels and active-row highlight', async () => {
    harness = await startPlugin();
    await harness.willAppearDial(COMBO_UUID, CTX);
    await harness.settle(200);
    const svg = await waitForCombFeedback(harness);
    // All 6 band labels are present in the left column.
    for (const label of ['WFM', 'NFM', 'AM', 'USB', 'LSB', 'CW']) {
      expect(svg, `expected band label "${label}"`).toMatch(new RegExp(`>${label}<`));
    }
    // Default config has demodMode 1 (WFM, BAND_LABELS[0]); the active-mode
    // row gets a saturated blue fill (#0055cc) + bright cyan side rail
    // (#00ddff) + yellow ● dot so the live mode is unmistakable.
    expect(svg, 'expected saturated active-row blue fill').toMatch(/fill="#0055cc"/);
    expect(svg, 'expected bright cyan active-row rail').toMatch(/fill="#00ddff"/);
  }, 10_000);

  it('PUSH on Band row triggers setDemodMode (cursor 2 → AM)', async () => {
    harness = await startPlugin();
    await harness.willAppearDial(COMBO_UUID, CTX);
    await harness.settle(200);

    // Initial active band is NFM (idx 1). Move cursor to AM (idx 2).
    harness.dialRotate(COMBO_UUID, CTX, 1);
    harness.dialRotate(COMBO_UUID, CTX, 1);
    await harness.settle(100);

    // PUSH (dialDown + dialUp) on a Band row → setDemodMode immediately.
    // We can't observe the spyService side directly from the harness, but we
    // can assert that the next setFeedback shows the bullet moved to AM and
    // the right column flipped to AM Options shape (BW/CAGC/Sync/Atk/Dec/
    // Gain — the FM column would show Deemph/IFNR instead).
    const cap = harness.startCapture();
    harness.dialDown(COMBO_UUID, CTX);
    harness.dialUp(COMBO_UUID, CTX);
    await harness.settle(300);
    const fbs = cap.stop().filter(m => (m as { event?: string }).event === 'setFeedback');
    expect(fbs.length).toBeGreaterThan(0);

    // Walk the captured stream — the post-setDemodMode render is the last
    // one to contain "CAGC" (AM-only label).
    const amSvg = fbs.map(decodeOptionsSvg).find(s => /CAGC/.test(s));
    expect(amSvg, 'expected an AM-shaped Opts column after PUSH on AM band').toBeTruthy();
    // Sanity: the FM-only label "Deemph" should NOT be in that frame.
    expect(amSvg!).not.toMatch(/Deemph/);
  }, 15_000);

  it('hydrates persisted demodMode at startup (regression for connect-time listener fire)', async () => {
    // Bug: spyService.connect() assigned cfg.demodMode to currentDemodMode
    // without notifying subscribers, so the Combo dial's local mirror stayed
    // at default (1) and the Opts column rendered the wrong shape on first
    // paint after a restart with an SSB mode persisted.
    //
    // Fix at src/spyService.ts: after the assignment, fire the
    // demodModeListeners. This test asserts the dial's final post-hydration
    // setFeedback shape matches the persisted mode (USB → SSB Opts shape).
    harness = await startPlugin({ config: {
      enabled: true,
      demodMode: 4,           // USB
      host: '10.255.255.1',   // unroutable so TCP just times out
      port: 1,
      audioEnabled: false,
    } });
    const cap = harness.startCapture();
    await harness.willAppearDial(COMBO_UUID, CTX);
    await harness.settle(2500);
    const fbs = cap.stop().filter(m => (m as { event?: string }).event === 'setFeedback' && (m as SetFeedbackMsg).context === CTX);
    expect(fbs.length).toBeGreaterThan(0);
    // Last setFeedback must reflect the hydrated SSB mode (BFO row present).
    const lastSvg = decodeOptionsSvg(fbs[fbs.length - 1]);
    expect(lastSvg, 'expected SSB Opts shape after connect-time hydration').toMatch(/>BFO</);
    // And the Band column's active-mode fill should sit on the USB row
    // (BAND_LABELS index 3 = USB → bg rect y = 12 + 4*12 - (ROW_H-2) = 50,
    // height ROW_H=12). Look for the saturated-blue rect at that band.
    expect(lastSvg).toMatch(/<rect[^>]*y="50"[^>]*height="12"[^>]*fill="#0055cc"/);
  }, 15_000);

  it('Opts column shrinks from 6 rows (FM/AM) to 3 rows (SSB) when cursor is on USB band and confirmed', async () => {
    harness = await startPlugin();
    await harness.willAppearDial(COMBO_UUID, CTX);
    await harness.settle(200);

    // Cursor 0=WFM → 3 = USB band (3 ticks CW from idx 0).
    for (let i = 0; i < 3; i++) harness.dialRotate(COMBO_UUID, CTX, 1);
    await harness.settle(150);
    harness.dialDown(COMBO_UUID, CTX);
    harness.dialUp(COMBO_UUID, CTX);
    let ssbSvg = '';
    for (let attempt = 0; attempt < 20; attempt++) {
      const msg = await harness.awaitMessage<SetFeedbackMsg>(
        m => (m as SetFeedbackMsg)?.event === 'setFeedback' && (m as SetFeedbackMsg)?.context === CTX,
        2000,
      );
      const s = decodeOptionsSvg(msg);
      if (/>BFO</.test(s)) { ssbSvg = s; break; }
    }
    expect(ssbSvg, 'expected SSB-shaped Opts column with BFO row after USB band confirm').toMatch(/>BFO</);
    // SSB shape has BW + BFO + Gain only; the AM-only "CAGC" or FM-only
    // "Deemph" labels MUST NOT be present.
    expect(ssbSvg).not.toMatch(/CAGC/);
    expect(ssbSvg).not.toMatch(/Deemph/);
  }, 15_000);

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

    // Navigate selectedIdx 0 → 6 (Mode/Step row at Band column bottom), enter
    // edit mode. Band cells (idx 0..5) are non-edit; idx 6 = Mode/Step is
    // edit-toggleable.
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
    // Mode/Step row sits in the Band column bottom (single position). The
    // default step is 9 kHz → "9k" should appear as the value.
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
