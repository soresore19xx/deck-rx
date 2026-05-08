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

const FIXTURE_DIR = resolve(__dirname, 'fixtures');
const SDRPP_FIXTURE = join(FIXTURE_DIR, 'sdrpp-source.json');

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'deck-rx-presets-test-'));
  process.env.DECK_RX_PRESETS_PATH = join(sandbox, 'presets.json');
  process.env.DECK_RX_SDR_CONFIG_PATH = SDRPP_FIXTURE;
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
  delete process.env.DECK_RX_PRESETS_PATH;
  delete process.env.DECK_RX_SDR_CONFIG_PATH;
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
    const p = await loadDeckRxPresets();
    expect(Object.keys(p.lists).sort()).toEqual(['General', 'Imported']);
    expect(p.lists.General.bookmarks['Test FM 1'].frequency).toBe(80000000);
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
    writeFileSync(process.env.DECK_RX_PRESETS_PATH!, JSON.stringify({
      lists: {
        General: {
          bookmarks: {
            'Test FM 1': { frequency: 99999999, bandwidth: 12345, mode: 0 }, // user value
          },
        },
      },
    }), 'utf-8');
    const res = await importFromSdrpp();
    expect(res.skipped).toBeGreaterThanOrEqual(1);
    const p = await loadDeckRxPresets();
    expect(p.lists.General.bookmarks['Test FM 1'].frequency).toBe(99999999); // user value preserved
    expect(p.lists.General.bookmarks['Test FM 1'].bandwidth).toBe(12345);
    // Other bookmarks were still imported
    expect(p.lists.General.bookmarks['Test SW 1']).toBeTruthy();
  });

  it('rejects when SDR++ config is missing', async () => {
    process.env.DECK_RX_SDR_CONFIG_PATH = join(sandbox, 'no-such-file.json');
    await expect(importFromSdrpp()).rejects.toThrow();
  });
});
