// Regression test for the SSB/CW Band PUSH fallback.
//
// Bug: when user PUSHes USB / LSB / CW band on the Combo Options dial, the
// Tune dial's demodListener scans presets for the new mode. JP DB and SDR++
// imports include only AM + FM stations, so the scan returns -1 → freq
// stays on the previous mode's value (e.g. 80 MHz FM under USB demod = noise).
//
// Fix: when no matching-mode preset exists, fall back to a band-representative
// default freq (USB → 14.200 MHz / CW → 7.025 / LSB → 7.100 / NFM → 145.0 /
// AM → 594 kHz / WFM → 80.0). slotIndex is intentionally NOT touched so
// returning to AM/FM later restores the original preset.

import { describe, it, expect, afterEach } from 'vitest';
import { resolve } from 'path';
import { startPlugin, type MockHarness } from './harness/streamDeckMock.js';

const COMBO_UUID = 'com.hogehoge.deck-rx.dial-options-combo';
const TUNE_UUID  = 'com.hogehoge.deck-rx.dial-tune';
const COMBO_CTX  = 'ctx-combo-fallback';
const TUNE_CTX   = 'ctx-tune-fallback';

let harness: MockHarness | null = null;
afterEach(async () => { if (harness) { await harness.shutdown(); harness = null; } });

interface SetFeedback {
  event: 'setFeedback';
  context: string;
  payload: { 'freq-display'?: string; header?: string };
}

function decodeHeaderSvg(msg: unknown): string {
  const v = (msg as SetFeedback)?.payload?.header;
  if (typeof v !== 'string') return '';
  if (!v.startsWith('data:image/svg+xml;base64,')) return v;
  const b64 = v.slice('data:image/svg+xml;base64,'.length);
  return Buffer.from(b64, 'base64').toString('utf-8');
}

// Header SVG renders the station name (or "LINK"/"OFF" prefix when offline /
// disabled) as <text>...</text>. Strip tags + collapse spaces so we can
// substring-match cleanly.
function headerText(svg: string): string {
  return svg.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

const BAND_LABELS = ['WFM', 'NFM', 'AM', 'USB', 'LSB', 'CW'] as const;

describe('A6 — SSB/CW Band PUSH fallback (no matching preset)', () => {
  // Each non-AM/FM Band PUSH should activate the fallback path. The
  // observable signal in test (offline TCP, so freq display is forced to
  // "-----") is the HEADER text: in preset mode the header attributes the
  // station name (e.g. "FMわたらせ JOFW-FM"); in fallback the attribution
  // is suppressed so the header becomes just "LINK" (offline prefix only)
  // — proving the fallback render branch took over.
  const SSB_CASES = [
    { label: 'USB', toIdx: 3 },
    { label: 'CW',  toIdx: 5 },
    { label: 'LSB', toIdx: 4 },
    { label: 'NFM', toIdx: 1 },
  ];
  for (const c of SSB_CASES) {
    it(`${c.label} band PUSH suppresses preset-name attribution in header (fallback active)`, async () => {
      const presetsPath = resolve(__dirname, 'fixtures', 'deck-rx-presets.json');
      harness = await startPlugin({
        presetsPath,
        config: {
          enabled: true,
          demodMode: 1,            // WFM live initially → preset slot 0 hits
          host: '10.255.255.1',
          port: 1,
          audioEnabled: false,
          tuneMode: 'preset',
        },
      });
      await harness.willAppearDial(TUNE_UUID, TUNE_CTX, { mode: 'preset', stepHz: 100_000, slotIndex: 0, borderSide: 'none' });
      await harness.willAppearDial(COMBO_UUID, COMBO_CTX);
      await harness.settle(600);

      // Snapshot header BEFORE PUSH — should carry preset attribution
      const initialFb = await harness.awaitMessage(
        m => (m as { event?: string }).event === 'setFeedback' && (m as SetFeedback).context === TUNE_CTX,
        2000,
      );
      const initialHeader = headerText(decodeHeaderSvg(initialFb));
      expect(initialHeader.length, 'initial header should be non-empty').toBeGreaterThan(0);
      // Sanity: preset attribution present (some non-LINK text after the prefix)
      expect(initialHeader.replace(/^LINK\s*/, '').replace(/^OFF\s*/, '').length,
        'initial header should attribute a preset station').toBeGreaterThan(0);

      // PUSH on destination band row
      const cap = harness.startCapture();
      for (let i = 0; i < c.toIdx; i++) {
        harness.dialRotate(COMBO_UUID, COMBO_CTX, 1);
      }
      await harness.settle(150);
      harness.dialDown(COMBO_UUID, COMBO_CTX);
      harness.dialUp(COMBO_UUID, COMBO_CTX);
      await harness.settle(800);

      const all = cap.stop();
      const tuneFb = all.filter(
        m => (m as { event?: string }).event === 'setFeedback' && (m as SetFeedback).context === TUNE_CTX,
      );
      expect(tuneFb.length, 'Tune dial must re-render on band switch').toBeGreaterThan(0);

      // Walk the post-PUSH frames; at least one should show the bare
      // "LINK"-only header (no preset attribution) — that's the fallback
      // render branch firing.
      const headers = tuneFb.map(m => headerText(decodeHeaderSvg(m)));
      const fallbackFrame = headers.find(h => h === 'LINK' || h === '');
      expect(
        fallbackFrame !== undefined,
        `expected at least one bare-LINK header after ${c.label} PUSH; saw: ${JSON.stringify(headers)}`,
      ).toBe(true);
    }, 15_000);
  }
});
