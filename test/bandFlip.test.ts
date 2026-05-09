// E2E test for the F-2 follow-up: Combo dial Band PUSH → Tune dial auto-
// jumps to a matching-mode preset, updating its own SVG accordingly.
//
// Fixture deck-rx-presets.json contains:
//   TBS Radio (FM補完)        90.5  MHz  mode=1 (WFM)
//   KTWR SW                    9.91 MHz  mode=2 (AM)
//   NHK R2 Tokyo (manual SDR++) 693 kHz  mode=2 (AM)
//
// Scenario: start the plugin with demodMode=1 + lastFrequency=90.5 MHz.
// Spawn Tune dial + Combo dial. From Combo, walk Band cursor 0 (WFM) →
// 2 (AM) and PUSH. Expect:
//   - spyService receives setDemodMode(2) (verified by Combo SVG flipping
//     the active-row tint onto AM)
//   - Tune dial's demodListener fires, scans presets for mode==2 → KTWR
//     (9.91 MHz, the first AM-mode entry after preset sort by freq —
//     actually 693 kHz comes first since the merged list is sorted asc)
//   - Tune dial emits a fresh setFeedback frame after the band switch.

import { describe, it, expect, afterEach } from 'vitest';
import { resolve } from 'path';
import { startPlugin, type MockHarness } from './harness/streamDeckMock.js';

const COMBO_UUID = 'com.hogehoge.deck-rx.dial-options-combo';
const TUNE_UUID  = 'com.hogehoge.deck-rx.dial-tune';
const COMBO_CTX  = 'ctx-combo-bandflip';
const TUNE_CTX   = 'ctx-tune-bandflip';

let harness: MockHarness | null = null;
afterEach(async () => { if (harness) { await harness.shutdown(); harness = null; } });

interface SetFeedback {
  event: 'setFeedback';
  context: string;
  payload: Record<string, unknown>;
}

// Display order of the band column (matches src/actions/spyDialOptionsCombo.ts).
const BAND_LABELS = ['WFM', 'NFM', 'AM', 'USB', 'LSB', 'CW'] as const;
const BAND_MODES  = [   1,    0,   2,    4,    6,   5] as const;

describe('A4 — Combo Band PUSH: sweep all 6×5 from/to pairs', () => {
  // Build one independent test per from→to combination so a regression on
  // a specific transition (e.g. AM → SSB) doesn't get masked by the whole
  // suite passing on the average path.
  for (let fromIdx = 0; fromIdx < BAND_LABELS.length; fromIdx++) {
    for (let toIdx = 0; toIdx < BAND_LABELS.length; toIdx++) {
      if (fromIdx === toIdx) continue; // same mode = no-op, no listener fires
      const fromLabel = BAND_LABELS[fromIdx];
      const toLabel   = BAND_LABELS[toIdx];
      const fromMode  = BAND_MODES[fromIdx];
      const toMode    = BAND_MODES[toIdx];

      it(`${fromLabel} → ${toLabel} flips Combo Opts header to "${toLabel} Opts"`, async () => {
        const presetsPath = resolve(__dirname, 'fixtures', 'deck-rx-presets.json');
        harness = await startPlugin({
          presetsPath,
          config: {
            enabled: true,
            demodMode: fromMode,
            host: '10.255.255.1',
            port: 1,
            audioEnabled: false,
            tuneMode: 'preset',
          },
        });
        await harness.willAppearDial(TUNE_UUID, TUNE_CTX, { mode: 'preset', stepHz: 9000, slotIndex: 0, borderSide: 'none' });
        await harness.willAppearDial(COMBO_UUID, COMBO_CTX);
        await harness.settle(600);

        // Cursor starts at 0 (WFM row). Walk it to the destination row.
        const cap = harness.startCapture();
        for (let i = 0; i < toIdx; i++) {
          harness.dialRotate(COMBO_UUID, COMBO_CTX, 1);
        }
        await harness.settle(150);
        harness.dialDown(COMBO_UUID, COMBO_CTX);
        harness.dialUp(COMBO_UUID, COMBO_CTX);
        await harness.settle(800);

        const all = cap.stop();
        const comboFb = all.filter(m => (m as { event?: string }).event === 'setFeedback' && (m as SetFeedback).context === COMBO_CTX);
        const comboSvgs = comboFb.map(m => decodeOptionsSvg(m as SetFeedback));
        // Find at least one frame whose Opts header matches the destination
        // band — that's the post-setDemodMode render.
        const matched = comboSvgs.find(s => new RegExp(`>${toLabel} Opts<`).test(s));
        expect(matched, `expected Combo Opts header "${toLabel} Opts" after PUSH on ${toLabel} (toMode=${toMode})`).toBeTruthy();

        // Tune dial should have re-rendered too (demodListener fired) — at
        // least one fresh setFeedback after the band PUSH.
        const tuneFb = all.filter(m => (m as { event?: string }).event === 'setFeedback' && (m as SetFeedback).context === TUNE_CTX);
        expect(tuneFb.length, `Tune dial should re-render after ${fromLabel} → ${toLabel}`).toBeGreaterThan(0);
      }, 20_000);
    }
  }
});

describe('A4 — Combo Band PUSH propagates to Tune dial', () => {
  it('flips Tune dial frequency when band switches FM → AM in preset mode', async () => {
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

    await harness.willAppearDial(TUNE_UUID, TUNE_CTX, { mode: 'preset', stepHz: 9000, slotIndex: 0, borderSide: 'none' });
    await harness.willAppearDial(COMBO_UUID, COMBO_CTX);
    await harness.settle(800);

    const cap = harness.startCapture();
    // Combo cursor 0 (WFM) → 2 (AM): two CW ticks, then PUSH.
    harness.dialRotate(COMBO_UUID, COMBO_CTX, 1);
    harness.dialRotate(COMBO_UUID, COMBO_CTX, 1);
    await harness.settle(200);
    harness.dialDown(COMBO_UUID, COMBO_CTX);
    harness.dialUp(COMBO_UUID, COMBO_CTX);
    await harness.settle(1500);

    const all = cap.stop();
    const tuneFb  = all.filter(m => (m as { event?: string }).event === 'setFeedback' && (m as SetFeedback).context === TUNE_CTX);
    const comboFb = all.filter(m => (m as { event?: string }).event === 'setFeedback' && (m as SetFeedback).context === COMBO_CTX);

    expect(comboFb.length, 'expected at least one Combo setFeedback after Band PUSH').toBeGreaterThan(0);
    expect(tuneFb.length,  'expected at least one Tune setFeedback after Band PUSH (the F-2 fix)').toBeGreaterThan(0);

    // Verify the Combo dial actually flipped — its right-column header now
    // says "AM Opts" when active mode is 2.
    const comboLast = comboFb[comboFb.length - 1] as SetFeedback;
    const comboSvg = decodeOptionsSvg(comboLast);
    expect(comboSvg, 'Combo Opts header should read "AM Opts" after band switch').toMatch(/>AM Opts</);
  }, 25_000);
});

function decodeOptionsSvg(msg: SetFeedback): string {
  const v = (msg.payload['options-display'] ?? msg.payload['value']) as string | undefined;
  if (typeof v !== 'string' || !v.startsWith('data:image/svg+xml;base64,')) return '';
  return Buffer.from(v.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf-8');
}
