// A2 smoke test — verifies the Stream Deck mock harness can spawn the plugin,
// complete the WebSocket registration handshake, send a synthetic event back
// in, and shut down cleanly.

import { describe, it, expect, afterEach } from 'vitest';
import { startPlugin, type MockHarness } from './harness/streamDeckMock.js';

let harness: MockHarness | null = null;

afterEach(async () => {
  if (harness) {
    await harness.shutdown();
    harness = null;
  }
});

describe('A2 — Stream Deck mock harness', () => {
  it('plugin spawns, connects, completes registration', async () => {
    harness = await startPlugin();
    expect(harness.plugin.pid).toBeGreaterThan(0);
    expect(harness.client.readyState).toBe(1); // WebSocket.OPEN
  }, 10_000);

  it('plugin survives a synthetic willAppear event without crashing', async () => {
    harness = await startPlugin();
    // Send a willAppear for the Tune dial action so the plugin instantiates
    // SpyDialTune. With master=OFF in config the spyService.connect() path
    // bails immediately, no SpyServer call leaks out.
    harness.send({
      event: 'willAppear',
      action: 'com.hogehoge.deck-rx.dial-tune',
      context: 'ctx-tune-1',
      device: 'dev-test-sdplus',
      payload: {
        controller: 'Encoder',
        coordinates: { column: 0, row: 0 },
        isInMultiAction: false,
        settings: { mode: 'preset', stepHz: 9000, slotIndex: 0, borderSide: 'none' },
      },
    });
    // Give it a moment to render (the dial calls setImage + setFeedback during onWillAppear).
    const setImage = await harness.awaitMessage(
      (m: any) => m?.event === 'setImage' && m?.context === 'ctx-tune-1',
      4000,
    );
    expect(setImage).toBeTruthy();
    // Plugin process still alive
    expect(harness.plugin.exitCode).toBe(null);
  }, 15_000);
});
