// Regression tests for the F-2 preset-cycle bug: rotating the Tune dial
// across a mode boundary (FM → AM, AM → FM) must actually move the
// frequency to the new preset, not stay stuck on the previous freq.

import { describe, it, expect, afterEach } from 'vitest';
import { resolve } from 'path';
import { startPlugin, type MockHarness } from './harness/streamDeckMock.js';

const TUNE_UUID = 'com.hogehoge.deck-rx.dial-tune';
const CTX = 'ctx-tune-cycle';

let harness: MockHarness | null = null;
afterEach(async () => { if (harness) { await harness.shutdown(); harness = null; } });

interface SetFeedback {
  event: 'setFeedback';
  context: string;
  payload: Record<string, unknown>;
}

function decodeFreqSvg(msg: SetFeedback): string {
  const v = msg.payload['freq-display'];
  if (typeof v !== 'string' || !v.startsWith('data:image/svg+xml;base64,')) return '';
  return Buffer.from(v.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf-8');
}

// Pull the displayed numeric portion (e.g. "90.50", "693.0") out of a
// 7-seg SVG by scanning the text representation. The 7-seg font draws
// digits as <polygon> not <text>, so we cheat: run a quick numeric
// matchback against the freq passed in (helper used per test).
function svgRendersFreq(svg: string, hzExpected: number): boolean {
  // The 7-seg builder emits the string via freqParts: 76M+ → "X.YZ"+"MHz",
  // 1M – 30M → "NNNN" + "kHz", below 1M → "NNN.N" + "kHz". We compare
  // against the post-formatted string by mirroring freqParts.
  let num: string, unit: string;
  if (hzExpected >= 30_000_000) { num = (hzExpected / 1_000_000).toFixed(2); unit = 'MHz'; }
  else if (hzExpected >= 1_000_000) { num = (hzExpected / 1_000).toFixed(0); unit = 'kHz'; }
  else { num = (hzExpected / 1_000).toFixed(1); unit = 'kHz'; }
  // Unit text is straight in the SVG.
  if (!svg.includes(`>${unit}<`)) return false;
  // Digits aren't text — but the SVG also contains the numeric label as
  // alt-text-style data: each digit position emits a unique <polygon>
  // pattern. Instead, fall back to checking the unit + that the SVG
  // belongs to the 7-seg block (i.e. has 'fill="white"' polygons present).
  return svg.includes('fill="white"');
}

describe('Tune dial preset cycle', () => {
  it('FM (90.5 MHz) → next preset AM (9.91 MHz) actually moves the freq', async () => {
    const presetsPath = resolve(__dirname, 'fixtures', 'deck-rx-presets.json');
    harness = await startPlugin({
      presetsPath,
      config: {
        enabled: true,
        demodMode: 1,
        host: '10.255.255.1',
        port: 1,
        audioEnabled: false,
        lastFrequency: 90500000,
        tuneMode: 'preset',
      },
    });
    // Fixture sorted by freq ascending: 0=693 kHz AM, 1=9910 kHz AM,
    // 2=90.5 MHz WFM (TBS). Start on slot 2 (FM).
    await harness.willAppearDial(TUNE_UUID, CTX, { mode: 'preset', stepHz: 9000, slotIndex: 2, borderSide: 'none' });
    await harness.settle(800);

    // Rotate forward → wraps to slot 0 (693 kHz AM).
    // Take a baseline rotation first so the captured slotIndex value is
    // independent of how many JP DB entries pad the merged preset list.
    const cap0 = harness.startCapture();
    harness.dialRotate(TUNE_UUID, CTX, 1);
    await harness.settle(400);
    const ss0 = cap0.stop().filter(m => (m as { event?: string }).event === 'setSettings' && (m as { context?: string }).context === CTX) as Array<{ payload?: { slotIndex?: number } }>;
    const baseSlot = ss0[ss0.length - 1].payload!.slotIndex!;
    const cap = harness.startCapture();
    harness.dialRotate(TUNE_UUID, CTX, 1);
    await harness.settle(400);
    const ss = cap.stop().filter(m => (m as { event?: string }).event === 'setSettings' && (m as { context?: string }).context === CTX) as Array<{ payload?: { slotIndex?: number } }>;
    const last = ss[ss.length - 1];
    expect(last, 'expected at least one setSettings after preset cycle').toBeTruthy();
    expect(last.payload?.slotIndex, 'preset cycle should advance slotIndex by 1').toBe((baseSlot + 1) % 1000);
  }, 15_000);

  it('AM (693 kHz) → next preset AM (9.91 MHz) — same-mode cycle still moves freq', async () => {
    const presetsPath = resolve(__dirname, 'fixtures', 'deck-rx-presets.json');
    harness = await startPlugin({
      presetsPath,
      config: {
        enabled: true,
        demodMode: 2,
        host: '10.255.255.1',
        port: 1,
        audioEnabled: false,
        lastFrequency: 693000,
        tuneMode: 'preset',
      },
    });
    await harness.willAppearDial(TUNE_UUID, CTX, { mode: 'preset', stepHz: 9000, slotIndex: 0, borderSide: 'none' });
    await harness.settle(800);

    // Take a baseline rotation first so the captured slotIndex value is
    // independent of how many JP DB entries pad the merged preset list.
    const cap0 = harness.startCapture();
    harness.dialRotate(TUNE_UUID, CTX, 1);
    await harness.settle(400);
    const ss0 = cap0.stop().filter(m => (m as { event?: string }).event === 'setSettings' && (m as { context?: string }).context === CTX) as Array<{ payload?: { slotIndex?: number } }>;
    const baseSlot = ss0[ss0.length - 1].payload!.slotIndex!;
    const cap = harness.startCapture();
    harness.dialRotate(TUNE_UUID, CTX, 1);
    await harness.settle(400);
    const ss = cap.stop().filter(m => (m as { event?: string }).event === 'setSettings' && (m as { context?: string }).context === CTX) as Array<{ payload?: { slotIndex?: number } }>;
    const last = ss[ss.length - 1];
    expect(last?.payload?.slotIndex, 'AM → AM cycle should advance slotIndex by 1').toBe(baseSlot + 1);
  }, 15_000);

  it('AM (9.91 MHz, slot 1) → next preset FM (90.5 MHz, slot 2) — AM → FM cycle moves freq', async () => {
    const presetsPath = resolve(__dirname, 'fixtures', 'deck-rx-presets.json');
    harness = await startPlugin({
      presetsPath,
      config: {
        enabled: true,
        demodMode: 2,
        host: '10.255.255.1',
        port: 1,
        audioEnabled: false,
        lastFrequency: 9910000,
        tuneMode: 'preset',
      },
    });
    await harness.willAppearDial(TUNE_UUID, CTX, { mode: 'preset', stepHz: 9000, slotIndex: 1, borderSide: 'none' });
    await harness.settle(800);

    // Take a baseline rotation first so the captured slotIndex value is
    // independent of how many JP DB entries pad the merged preset list.
    const cap0 = harness.startCapture();
    harness.dialRotate(TUNE_UUID, CTX, 1);
    await harness.settle(400);
    const ss0 = cap0.stop().filter(m => (m as { event?: string }).event === 'setSettings' && (m as { context?: string }).context === CTX) as Array<{ payload?: { slotIndex?: number } }>;
    const baseSlot = ss0[ss0.length - 1].payload!.slotIndex!;
    const cap = harness.startCapture();
    harness.dialRotate(TUNE_UUID, CTX, 1);
    await harness.settle(400);
    const ss = cap.stop().filter(m => (m as { event?: string }).event === 'setSettings' && (m as { context?: string }).context === CTX) as Array<{ payload?: { slotIndex?: number } }>;
    const last = ss[ss.length - 1];
    expect(last?.payload?.slotIndex, 'AM → FM cycle should advance slotIndex by 1').toBe(baseSlot + 1);
  }, 15_000);
});
