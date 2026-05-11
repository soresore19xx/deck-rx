// Unit tests for src/presets.ts (deck-rx-owned preset store + SDR++
// importer). Each test points DECK_RX_PRESETS_PATH at a fresh tmpfile so
// it gets a clean store and does not collide with the production data
// directory. presets.ts evaluates the env vars on every call (not at
// module load), so a vanilla static import works — no resetModules needed.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, join } from 'path';
import { loadDeckRxPresets, saveDeckRxPresets, importFromSdrpp } from '../src/presets.js';
import { clearJpStationsCache } from '../src/japanStations.js';

const FIXTURE_DIR = resolve(__dirname, 'fixtures');
const SDRPP_FIXTURE = join(FIXTURE_DIR, 'sdrpp-source.json');
// Production JP DB doubles as the test fixture for JP-name lookup — its
// manualStations include HBC / STV / TBS / etc. The path is resolved per
// call inside japanStations.ts now, so flipping the env var below + a
// clearJpStationsCache() in beforeEach is enough for lookupJpStation to
// pick this up during importFromSdrpp.
const JP_STATIONS_PRODUCTION = resolve(__dirname, '..', 'com.hogehoge.deck-rx.sdPlugin', 'data', 'jp-stations.json');

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'deck-rx-presets-test-'));
  process.env.DECK_RX_PRESETS_PATH = join(sandbox, 'presets.json');
  process.env.DECK_RX_SDR_CONFIG_PATH = SDRPP_FIXTURE;
  process.env.DECK_RX_JP_STATIONS_PATH = JP_STATIONS_PRODUCTION;
  clearJpStationsCache();
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
  delete process.env.DECK_RX_PRESETS_PATH;
  delete process.env.DECK_RX_SDR_CONFIG_PATH;
  delete process.env.DECK_RX_JP_STATIONS_PATH;
  clearJpStationsCache();
});

describe('loadDeckRxPresets', () => {
  it('returns empty PresetFile when the file does not exist', async () => {
    const p = await loadDeckRxPresets();
    expect(p.lists).toEqual({});
  });

  it('returns parsed file when valid', async () => {
    writeFileSync(process.env.DECK_RX_PRESETS_PATH!, JSON.stringify({
      lists: { mine: { bookmarks: { 'TBSラジオ': { frequency: 90500000, bandwidth: 200000, mode: 1 } } } },
    }), 'utf-8');
    const p = await loadDeckRxPresets();
    expect(Object.keys(p.lists)).toEqual(['mine']);
    expect(p.lists.mine.bookmarks['TBSラジオ'].frequency).toBe(90500000);
  });

  it('falls back to empty when file is corrupt JSON', async () => {
    writeFileSync(process.env.DECK_RX_PRESETS_PATH!, 'not-valid-json{', 'utf-8');
    const p = await loadDeckRxPresets();
    expect(p.lists).toEqual({});
  });
});

describe('saveDeckRxPresets', () => {
  it('round-trips CJK broadcaster names cleanly', async () => {
    const original = {
      lists: {
        japan: {
          bookmarks: {
            'NHKラジオ第1':       { frequency: 594000,    bandwidth: 9000,   mode: 2 },
            'TBSラジオ':          { frequency: 90500000,  bandwidth: 200000, mode: 1 },
            '文化放送':           { frequency: 1134000,   bandwidth: 9000,   mode: 2 },
            'JA1RL net (40m)':    { frequency: 7110000,   bandwidth: 2400,   mode: 6 },
          },
        },
      },
    };
    await saveDeckRxPresets(original);
    expect(existsSync(process.env.DECK_RX_PRESETS_PATH!)).toBe(true);
    const fileContents = readFileSync(process.env.DECK_RX_PRESETS_PATH!, 'utf-8');
    // CJK should be present as native UTF-8, NOT escaped \uXXXX
    expect(fileContents).toContain('NHKラジオ第1');
    expect(fileContents).not.toContain('\\u');
    const reloaded = await loadDeckRxPresets();
    expect(reloaded.lists.japan.bookmarks['NHKラジオ第1'].frequency).toBe(594000);
    expect(reloaded.lists.japan.bookmarks['文化放送'].frequency).toBe(1134000);
  });
});

describe('importFromSdrpp', () => {
  it('imports all SDR++ bookmarks into deck-rx presets on first run', async () => {
    const res = await importFromSdrpp();
    expect(res.added).toBe(3);   // fixture has 3 bookmarks total
    expect(res.skipped).toBe(0);
    expect(res.migrated).toBe(0);
    const p = await loadDeckRxPresets();
    expect(Object.keys(p.lists).sort()).toEqual(['General', 'Imported']);
    // 80 MHz hits the kanto JP DB (TOKYO FM at 80.000 MHz), so the SDR++
    // "Test FM 1" placeholder gets renamed during import. Look up by freq
    // instead of relying on the SDR++ name.
    const general = Object.values(p.lists.General.bookmarks);
    expect(general.find(b => b.frequency === 80000000), 'expected 80 MHz preset').toBeTruthy();
    expect(general.find(b => b.frequency === 9910000),  'expected 9.91 MHz SW preset').toBeTruthy();
    // SW (9.91 MHz) has no JP DB hit → keeps SDR++ name "Test SW 1"
    expect(p.lists.General.bookmarks['Test SW 1'].frequency).toBe(9910000);
    expect(p.lists.Imported.bookmarks['Test USB'].frequency).toBe(14300000);
  });

  it('is idempotent — re-importing skips already-present bookmarks', async () => {
    const first = await importFromSdrpp();
    expect(first.added).toBe(3);
    const second = await importFromSdrpp();
    expect(second.added).toBe(0);
    expect(second.skipped).toBe(3);
  });

  it('preserves user-edited deck-rx entries with the same name', async () => {
    // Pre-populate deck-rx presets with a user-named bookmark that collides
    // with an SDR++ source name. Import must NOT overwrite the user version.
    // Use "Test SW 1" because SW frequencies don't hit the JP DB so the
    // SDR++ side keeps its name and a real collision can occur.
    writeFileSync(process.env.DECK_RX_PRESETS_PATH!, JSON.stringify({
      lists: {
        General: {
          bookmarks: {
            'Test SW 1': { frequency: 99999999, bandwidth: 12345, mode: 0 }, // user value
          },
        },
      },
    }), 'utf-8');
    const res = await importFromSdrpp();
    expect(res.skipped).toBeGreaterThanOrEqual(1);
    const p = await loadDeckRxPresets();
    expect(p.lists.General.bookmarks['Test SW 1'].frequency).toBe(99999999); // user value preserved
    expect(p.lists.General.bookmarks['Test SW 1'].bandwidth).toBe(12345);
    // Other bookmarks were still imported (e.g. 80 MHz TOKYO FM rename or
    // the original "Test SW 1" displaced — at least one new entry exists).
    const general = Object.values(p.lists.General.bookmarks);
    expect(general.find(b => b.frequency === 80000000), 'expected 80 MHz preset to be added').toBeTruthy();
  });

  it('rejects when SDR++ config is missing', async () => {
    process.env.DECK_RX_SDR_CONFIG_PATH = join(sandbox, 'no-such-file.json');
    await expect(importFromSdrpp()).rejects.toThrow();
  });

  it('dedup is freq-keyed: SDR++ ASCII name skipped when same freq already CJK-named', async () => {
    // Regression: prior to the freq-keyed dedup, this scenario produced
    // duplicate-freq entries in presets.json (one ASCII + one CJK).
    writeFileSync(process.env.DECK_RX_PRESETS_PATH!, JSON.stringify({
      lists: {
        General: {
          bookmarks: {
            'HBCラジオ': { frequency: 1287000, bandwidth: 9000, mode: 2 },
          },
        },
      },
    }), 'utf-8');
    const sdrSrc = join(sandbox, 'sdrpp-collide.json');
    writeFileSync(sdrSrc, JSON.stringify({
      lists: {
        General: {
          bookmarks: {
            'MW HBC Radio': { frequency: 1287000, bandwidth: 9000, mode: 2 },
          },
        },
      },
    }, null, 4));
    process.env.DECK_RX_SDR_CONFIG_PATH = sdrSrc;
    const res = await importFromSdrpp();
    expect(res.added).toBe(0);
    expect(res.skipped).toBe(1);
    const p = await loadDeckRxPresets();
    const general = Object.values(p.lists.General.bookmarks);
    expect(general.filter(b => b.frequency === 1287000).length).toBe(1);
    expect(p.lists.General.bookmarks['HBCラジオ']).toBeTruthy();
    expect(p.lists.General.bookmarks['MW HBC Radio']).toBeUndefined();
  });

  it('migrates pre-existing duplicate-freq entries (ASCII + CJK) on next import', async () => {
    // Simulates the 2026-05 regression state: presets.json grew to hold
    // both the old ASCII name and the post-CJK-rename name at the same
    // freq. Next import must collapse them via dedupBookmarksByFreq.
    writeFileSync(process.env.DECK_RX_PRESETS_PATH!, JSON.stringify({
      lists: {
        General: {
          bookmarks: {
            'MW HBC Radio': { frequency: 1287000, bandwidth: 9000, mode: 2 },
            'HBCラジオ':    { frequency: 1287000, bandwidth: 9000, mode: 2 },
            'MW STV Radio': { frequency: 1440000, bandwidth: 9000, mode: 2 },
            'STVラジオ':    { frequency: 1440000, bandwidth: 9000, mode: 2 },
            // Untouched non-duplicate entries pass through
            'Test SW 1':    { frequency: 9910000, bandwidth: 5000, mode: 2 },
          },
        },
      },
    }), 'utf-8');
    // Empty SDR++ source so nothing is added — exercise the pre-clean only
    const sdrSrc = join(sandbox, 'sdrpp-empty.json');
    writeFileSync(sdrSrc, JSON.stringify({ lists: { General: { bookmarks: {} } } }, null, 4));
    process.env.DECK_RX_SDR_CONFIG_PATH = sdrSrc;
    const res = await importFromSdrpp();
    expect(res.migrated).toBe(2);
    const p = await loadDeckRxPresets();
    expect(p.lists.General.bookmarks['HBCラジオ']).toBeTruthy();
    expect(p.lists.General.bookmarks['STVラジオ']).toBeTruthy();
    expect(p.lists.General.bookmarks['MW HBC Radio']).toBeUndefined();
    expect(p.lists.General.bookmarks['MW STV Radio']).toBeUndefined();
    expect(p.lists.General.bookmarks['Test SW 1']).toBeTruthy();
  });

  it('replaces ASCII placeholder names with the JP DB CJK broadcaster name', async () => {
    // SDR++ uses ASCII labels like "MW HBC Radio" / "MW STV Radio"; the
    // import path should swap those for the JP DB names ("HBCラジオ",
    // "STVラジオ") so the deck-rx preset list reads in 日本語. SW / NW
    // bookmarks (no JP DB hit) keep their original SDR++ name.
    const sdrSrc = join(sandbox, 'sdrpp-jp-source.json');
    writeFileSync(sdrSrc, JSON.stringify({
      bookmarkDisplayMode: 0,
      lists: {
        General: {
          bookmarks: {
            'MW HBC Radio': { frequency: 1287000, bandwidth: 9000, mode: 2 },
            'MW STV Radio': { frequency: 1440000, bandwidth: 9000, mode: 2 },
            'MW TBS':        { frequency:  954000, bandwidth: 9000, mode: 2 },
            'SW KTWR':       { frequency: 9910000, bandwidth: 5000, mode: 2 },
          },
        },
      },
      selectedList: 'General',
    }, null, 4));
    process.env.DECK_RX_SDR_CONFIG_PATH = sdrSrc;
    const res = await importFromSdrpp();
    expect(res.added).toBe(4);
    const p = await loadDeckRxPresets();
    const bk = p.lists.General.bookmarks;
    // JP DB hits (manualStations have hokkaido/kanto entries)
    expect(bk['HBCラジオ'], 'HBC should be renamed').toBeTruthy();
    expect(bk['STVラジオ'], 'STV should be renamed').toBeTruthy();
    expect(bk['TBSラジオ'], 'TBS should be renamed (kanto manual)').toBeTruthy();
    // No JP DB entry for 9910 kHz SW → original SDR++ name retained
    expect(bk['SW KTWR'], 'SW KTWR should keep its SDR++ name').toBeTruthy();
    // The original ASCII names should NOT remain
    expect(bk['MW HBC Radio']).toBeUndefined();
    expect(bk['MW STV Radio']).toBeUndefined();
    expect(bk['MW TBS']).toBeUndefined();
  });
});
