// Integration tests for the SSB Options dial. Spawns the plugin via the
// mock harness and asserts the panel content + dim behaviour against
// demod-mode changes.

import { describe, it, expect, afterEach } from 'vitest';
import { startPlugin, type MockHarness } from './harness/streamDeckMock.js';

const SSB_UUID = 'com.hogehoge.deck-rx.dial-ssb-options';
const CTX = 'ctx-ssb-1';

let harness: MockHarness | null = null;
afterEach(async () => { if (harness) { await harness.shutdown(); harness = null; } });

interface SetFeedbackMsg { event: 'setFeedback'; context: string; payload: { 'options-display'?: string }; }

function decodeSvg(msg: unknown): string {
  const v = (msg as SetFeedbackMsg)?.payload?.['options-display'];
  if (typeof v !== 'string' || !v.startsWith('data:image/svg+xml;base64,')) return '';
  return Buffer.from(v.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf-8');
}

async function waitForFeedback(h: MockHarness): Promise<string> {
  const msg = await h.awaitMessage<SetFeedbackMsg>(
    m => (m as SetFeedbackMsg)?.event === 'setFeedback' && (m as SetFeedbackMsg)?.context === CTX,
    3000,
  );
  return decodeSvg(msg);
}

describe('SSB Options dial', () => {
  it('initial render contains BW + BFO labels', async () => {
    harness = await startPlugin();
    await harness.willAppearDial(SSB_UUID, CTX);
    await harness.settle(200);
    const svg = await waitForFeedback(harness);
    expect(svg).toMatch(/>BW</);
    expect(svg).toMatch(/>BFO</);
    // Defaults: 2400 Hz BW → "2.4k"; 700 Hz BFO → "700"
    expect(svg).toMatch(/>2\.4k</);
    expect(svg).toMatch(/>700</);
  }, 10_000);

  it('dialRotate while focused moves the highlighted row', async () => {
    harness = await startPlugin();
    await harness.willAppearDial(SSB_UUID, CTX);
    await harness.settle(200);
    const cap = harness.startCapture();
    harness.dialRotate(SSB_UUID, CTX, 1);
    await harness.settle(150);
    const fbs = cap.stop().filter(m => (m as { event?: string }).event === 'setFeedback');
    expect(fbs.length).toBeGreaterThan(0);
    const svg = decodeSvg(fbs[fbs.length - 1]);
    // A focused selection always emits the width=3 accent sidebar.
    expect(svg).toMatch(/width="3"/);
  }, 10_000);

  it('panel is dim when demod mode is not SSB / CW', async () => {
    // Default config has demodMode 1 (WFM), so the dial spawns dimmed.
    harness = await startPlugin();
    await harness.willAppearDial(SSB_UUID, CTX);
    await harness.settle(200);
    const svg = await waitForFeedback(harness);
    expect(svg).toMatch(/opacity="0\.30"/);
  }, 10_000);
});
