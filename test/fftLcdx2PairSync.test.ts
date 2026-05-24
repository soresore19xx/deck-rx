// Regression: when an FFT-LCDX2 panel willAppears next to a sibling that is
// already alive, it must adopt the sibling's shared state (dbCeil, dbFloor,
// zoom, axis, lcdMode, fftSize, vZoomIndex) instead of rendering with its
// own potentially-stale persisted settings.
//
// Bug scenario (observed 2026-05-25): user edited dbCeil=-10 via PI on
// FFT-L while FFT-R was off-screen (different Stream Deck page).
// applyToSibling skipped FFT-R because it wasn't in `states`. FFT-R's disk
// stayed at -20. On the next page switch both panels willAppear; FFT-R
// loaded -20 and the pair rendered with mismatched gridlines (left ceil -10,
// right ceil -20).
//
// Fix: willAppear consults findSibling() AFTER applySettings; if a sibling
// already exists, copy its in-memory snapshot over our just-loaded one and
// persist it back so disk converges too.

import { describe, it, expect, afterEach } from 'vitest';
import { startPlugin, type MockHarness } from './harness/streamDeckMock.js';

const FFT_UUID = 'com.hogehoge.deck-rx.dial-fft-lcdx2';
const CTX_L = 'ctx-fft-lcdx2-left';
const CTX_R = 'ctx-fft-lcdx2-right';

let harness: MockHarness | null = null;
afterEach(async () => { if (harness) { await harness.shutdown(); harness = null; } });

// Send a willAppear with explicit Encoder coordinates so the two panels
// can be placed adjacent (col=2 + col=3). The harness's built-in
// willAppearDial hardcodes (0,0) which would put both at the same slot
// and break the sibling adjacency check.
async function willAppearAt(h: MockHarness, context: string, column: number, settings: Record<string, unknown>) {
  h.send({
    event: 'willAppear',
    action: FFT_UUID,
    context,
    device: 'dev-test-sdplus',
    payload: {
      controller: 'Encoder' as const,
      coordinates: { column, row: 0 },
      isInMultiAction: false,
      settings,
    },
  });
  // Wait for the first setFeedback on this context — the FFT-LCDX2 dial
  // renders to the encoder's LCD touch strip (setFeedback), not to the
  // knob image (setImage). Arrival of setFeedback confirms onWillAppear
  // ran the render path, which is after the reconciliation under test.
  await h.awaitMessage<unknown>((m) => {
    const msg = m as { event?: string; context?: string };
    return msg?.event === 'setFeedback' && msg?.context === context;
  }, 4000);
}

describe('FFT LCDX2 pair sync — willAppear reconciles with live sibling', () => {
  it('second panel adopts live sibling dbCeil/dbFloor even when its own persisted settings disagree', async () => {
    harness = await startPlugin({
      config: {
        enabled: false,        // no SpyServer connect → fully isolated
        audioEnabled: false,
        demodMode: 1,
      },
    });

    // FFT-L comes up first with a freshly-edited dbCeil/dbFloor pair, in
    // wide pair mode. Its sibling FFT-R is not on screen yet.
    await willAppearAt(harness, CTX_L, 2, {
      lcdMode: 'wide',
      dbCeil: -10,
      dbFloor: -100,
      zoomIndex: 2,
      vZoomIndex: 3,
      fftSize: 1024,
      axisMode: 'v',
    });

    // Now FFT-R appears with STALE persisted settings — the defaults a
    // user would have if they never touched its PI. Without reconciliation
    // it would render at dbCeil=-20 / dbFloor=-110 etc., out of step with
    // its live left sibling.
    const cap = harness.startCapture();
    await willAppearAt(harness, CTX_R, 3, {
      lcdMode: 'wide',
      dbCeil: -20,
      dbFloor: -110,
      zoomIndex: 0,
      vZoomIndex: 0,
      fftSize: 512,
      axisMode: 'h',
    });
    const events = cap.stop();

    // Reconciliation should have triggered exactly one setSettings echo on
    // FFT-R carrying the adopted sibling snapshot. Find it and assert all
    // shared fields snapped to the left panel's values.
    const setSettings = events.filter((m): m is { event: 'setSettings'; context: string; payload: Record<string, unknown> } => {
      const x = m as { event?: string; context?: string };
      return x?.event === 'setSettings' && x?.context === CTX_R;
    });
    expect(setSettings.length).toBeGreaterThanOrEqual(1);
    const adopted = setSettings[setSettings.length - 1].payload;
    expect(adopted.dbCeil).toBe(-10);
    expect(adopted.dbFloor).toBe(-100);
    expect(adopted.zoomIndex).toBe(2);
    expect(adopted.vZoomIndex).toBe(3);
    expect(adopted.fftSize).toBe(1024);
    expect(adopted.axisMode).toBe('v');
    expect(adopted.lcdMode).toBe('wide');
  });

  it('lone panel willAppearing with no sibling does NOT emit a reconciliation setSettings', async () => {
    harness = await startPlugin({
      config: { enabled: false, audioEnabled: false, demodMode: 1 },
    });
    const cap = harness.startCapture();
    await willAppearAt(harness, CTX_L, 2, {
      lcdMode: 'wide',
      dbCeil: -10,
      dbFloor: -100,
      zoomIndex: 1,
      vZoomIndex: 1,
      fftSize: 1024,
      axisMode: 'h',
    });
    const events = cap.stop();
    const setSettings = events.filter((m) => (m as { event?: string }).event === 'setSettings');
    // No sibling means no adoption — first arrival keeps its own persisted
    // settings without re-persisting them as a no-op echo.
    expect(setSettings.length).toBe(0);
  });
});
