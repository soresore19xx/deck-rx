// Regression test for the SingletonAction listener-orphan leak fixed by the
// teardown()/disposeState() re-entry guards.
//
// Stream Deck SingletonAction holds ONE class instance per action UUID across
// every placement. The dial actions register their spyService listeners (+ a
// per-second clockTimer / footerTimer) in onWillAppear and tear them down in
// onWillDisappear. If a second willAppear arrives for the same context with
// NO intervening willDisappear (a real SD page-nav / profile-switch race),
// the pre-fix code minted a fresh closure set and orphaned the previous one
// in spyService's reference-keyed listener Sets — they could never be
// unsubscribed again and kept firing forever (slow heap growth, the leak
// class this audit chased).
//
// The fix makes onWillAppear idempotent: it tears down any prior subscriptions
// before registering new ones. This test asserts the observable consequence —
// after a re-fired willAppear, ONE discrete state change still produces ONE
// render, not two (which is what a doubled listener set would yield).

import { describe, it, expect, afterEach } from 'vitest';
import { startPlugin, type MockHarness } from './harness/streamDeckMock.js';

const VOL_UUID = 'com.hogehoge.deck-rx.dial-volume';
const CTX = 'ctx-vol-reentry';

let harness: MockHarness | null = null;
afterEach(async () => { if (harness) { await harness.shutdown(); harness = null; } });

// Raw willAppear (the harness's willAppearDial helper waits for setImage; for
// the re-fire we just want to inject the event without re-arming that wait).
function rawWillAppear(h: MockHarness, uuid: string, context: string): void {
  h.send({
    event: 'willAppear',
    action: uuid,
    context,
    device: 'dev-test-sdplus',
    payload: {
      controller: 'Encoder',
      coordinates: { column: 0, row: 0 },
      isInMultiAction: false,
      settings: {},
    },
  });
}

function countFeedback(frames: unknown[], context: string): number {
  return frames.filter(
    m => (m as { event?: string }).event === 'setFeedback'
      && (m as { context?: string }).context === context,
  ).length;
}

describe('SingletonAction re-entry — willAppear without willDisappear must not double-subscribe', () => {
  it('Volume dial: a re-fired willAppear leaves exactly one volume listener', async () => {
    harness = await startPlugin();        // enabled:false / audioEnabled:false sandbox
    // First appearance — registers the volume listener set + clockTimer.
    await harness.willAppearDial(VOL_UUID, CTX);
    await harness.settle(150);

    // Re-fire willAppear for the SAME context with NO willDisappear between.
    // Pre-fix this added a 2nd volume listener (and a 2nd clockTimer) while
    // orphaning the first.
    rawWillAppear(harness, VOL_UUID, CTX);
    await harness.settle(300);

    // One discrete state change: mute toggle (setMuted always fans out to
    // every live volume listener). Each listener invocation calls render()
    // → one setFeedback. So the frame count == the number of live listeners.
    const cap = harness.startCapture();
    harness.dialDown(VOL_UUID, CTX);
    harness.dialUp(VOL_UUID, CTX);        // → spyService.setMuted(!muted)
    await harness.settle(250);            // stay under the 1 s clockTimer cadence
    const frames = cap.stop();

    // Exactly one render. With the orphaned-listener leak this was 2.
    expect(countFeedback(frames, CTX)).toBe(1);
  }, 15_000);

  it('Volume dial: appear → disappear → appear cycle also leaves exactly one listener', async () => {
    // The balanced page-flip path. Verifies teardown() didn't over- or
    // under-unsubscribe: after a full cycle a single mute toggle still
    // produces exactly one render.
    harness = await startPlugin();
    await harness.willAppearDial(VOL_UUID, CTX);
    await harness.settle(150);
    harness.send({
      event: 'willDisappear', action: VOL_UUID, context: CTX, device: 'dev-test-sdplus',
      payload: { controller: 'Encoder', coordinates: { column: 0, row: 0 }, isInMultiAction: false, settings: {} },
    });
    await harness.settle(150);
    await harness.willAppearDial(VOL_UUID, CTX);
    await harness.settle(200);

    const cap = harness.startCapture();
    harness.dialDown(VOL_UUID, CTX);
    harness.dialUp(VOL_UUID, CTX);
    await harness.settle(250);
    const frames = cap.stop();

    expect(countFeedback(frames, CTX)).toBe(1);
  }, 15_000);
});
