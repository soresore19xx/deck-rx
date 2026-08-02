// Regression tests for the "freq resets to a fixed preset on every SD
// restart / reconnect" bug (2026-07-26 handoff, root-caused 2026-08-02):
// lastFrequency persistence + restore had existed since e67e50f, but
// connect()'s config-restore block fires demodModeListeners and the Tune
// dial's demodListener used to treat that hydration fire as a user band
// change — auto-jumping to the first matching-mode preset, overwriting the
// just-restored freq in memory AND (500 ms later, via the setFrequency
// persist debounce) on disk.
//
// Fixture preset list (sorted by freq asc): 0 = 693 kHz AM (NHK R2),
// 1 = 9910 kHz AM (KTWR), 2 = 90.5 MHz WFM (TBS). The mock SpyServer
// reports an Airspy HF+ (0.5–31 / 60–260 MHz, hardware gap 31–60 MHz).

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { startPlugin, type MockHarness } from './harness/streamDeckMock.js';

const TUNE_UUID = 'com.hogehoge.deck-rx.dial-tune';
const CTX = 'ctx-tune-restore';
const SETTING_IQ_FREQUENCY = 101;
const PRESETS = resolve(__dirname, 'fixtures', 'deck-rx-presets.json');

let harness: MockHarness | null = null;
afterEach(async () => { if (harness) { await harness.shutdown(); harness = null; } });

function cfgOnDisk(h: MockHarness): Record<string, unknown> {
  return JSON.parse(readFileSync(h.configPath, 'utf8'));
}
function sentFreqs(h: MockHarness): number[] {
  return h.spySettings.filter(s => s.setting === SETTING_IQ_FREQUENCY).map(s => s.value);
}

describe('last-tuned frequency survives a plugin restart', () => {
  it('restored lastFrequency is NOT stomped by the demod-restore auto-jump', async () => {
    harness = await startPlugin({
      presetsPath: PRESETS,
      spyServer: true,
      config: { enabled: true, audioEnabled: false, tuneMode: 'preset', demodMode: 2, lastFrequency: 9_910_000 },
    });
    await harness.willAppearDial(TUNE_UUID, CTX, { mode: 'preset', stepHz: 9000, slotIndex: 1, borderSide: 'none' });
    await harness.settle(1500);
    // Bug signature: the hydration fire jumped to the FIRST mode-2 preset
    // (693 kHz) and its setFrequency persisted the stomped value to disk.
    expect(sentFreqs(harness)).not.toContain(693_000);
    expect(cfgOnDisk(harness).lastFrequency).toBe(9_910_000);
  }, 20_000);

  it('reconciles slotIndex onto the preset matching the restored freq', async () => {
    harness = await startPlugin({
      presetsPath: PRESETS,
      spyServer: true,
      config: { enabled: true, audioEnabled: false, tuneMode: 'preset', demodMode: 1, lastFrequency: 90_500_000 },
    });
    const cap = harness.startCapture();
    // slotIndex 0 is deliberately stale (Band-PUSH auto-jumps don't
    // setSettings) — the connect-time reconciliation must adopt slot 2
    // (90.5 MHz) and persist it.
    await harness.willAppearDial(TUNE_UUID, CTX, { mode: 'preset', stepHz: 9000, slotIndex: 0, borderSide: 'none' });
    await harness.settle(1500);
    const ss = cap.stop().filter(m =>
      (m as { event?: string }).event === 'setSettings' && (m as { context?: string }).context === CTX
    ) as Array<{ payload?: { slotIndex?: number } }>;
    expect(ss.length, 'connect-time reconciliation should persist the matching slot').toBeGreaterThan(0);
    expect(ss[ss.length - 1].payload?.slotIndex).toBe(2);
    expect(cfgOnDisk(harness).lastFrequency).toBe(90_500_000);
  }, 20_000);

  it('true first run (no lastFrequency) still seeds presets[slotIndex]', async () => {
    harness = await startPlugin({
      presetsPath: PRESETS,
      spyServer: true,
      config: { enabled: true, audioEnabled: false, tuneMode: 'preset', demodMode: 1 },
    });
    await harness.willAppearDial(TUNE_UUID, CTX, { mode: 'preset', stepHz: 9000, slotIndex: 1, borderSide: 'none' });
    await harness.settle(1500);
    expect(sentFreqs(harness)).toContain(9_910_000);
    expect(cfgOnDisk(harness).lastFrequency).toBe(9_910_000);
  }, 20_000);

  it('restored freq inside the Airspy HF+ 31–60 MHz gap falls back to the preset seed', async () => {
    harness = await startPlugin({
      presetsPath: PRESETS,
      spyServer: true,
      config: { enabled: true, audioEnabled: false, tuneMode: 'preset', demodMode: 0, lastFrequency: 45_000_000 },
    });
    await harness.willAppearDial(TUNE_UUID, CTX, { mode: 'preset', stepHz: 9000, slotIndex: 1, borderSide: 'none' });
    await harness.settle(1500);
    // 45 MHz is unreceivable on the HF+ → seed presets[1] (9910 kHz AM),
    // whose setFrequency then persists the receivable freq.
    expect(cfgOnDisk(harness).lastFrequency).toBe(9_910_000);
  }, 20_000);
});
