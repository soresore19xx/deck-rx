// loadPresets tests. Points the loader at a fixture preset store and the live
// jp-stations.json, so the region argument is exercised without touching the
// user's own bookmarks.
//
// These used to assert that the JP DB was merged into the list. It is not, and
// deliberately: 32a5e99 made the store the sole source of records because
// merging every station in a region inflated the roster with entries nobody
// imported. The tests were not updated with it and had been failing since,
// asserting a behaviour that had been removed on purpose.
import { describe, it, expect, beforeAll } from 'vitest';
import { resolve } from 'path';

const PROJECT = resolve(__dirname, '..');

beforeAll(() => {
  process.env.DECK_RX_PRESETS_PATH = resolve(__dirname, 'fixtures', 'deck-rx-presets.json');
  process.env.DECK_RX_JP_STATIONS_PATH = resolve(PROJECT, 'com.hogehoge.deck-rx.sdPlugin', 'data', 'jp-stations.json');
});

// Late-import after env vars are set — module reads them at module-load time.
async function importLoader() {
  const mod = await import('../src/actions/spyTune.js');
  return mod;
}

describe('loadPresets — the store is the sole source of records', () => {
  it('without region: deck-rx preset entries only', async () => {
    const { loadPresets, clearPresetsCache } = await importLoader();
    clearPresetsCache();
    const presets = await loadPresets();
    // deck-rx fixture has 3 entries; without region we should not pick up
    // anything from the JP DB.
    expect(presets.length).toBe(3);
    const freqs = new Set(presets.map(p => p.freq));
    expect(freqs.has(90_500_000)).toBe(true);   // TBS Radio
    expect(freqs.has(9_910_000)).toBe(true);    // KTWR SW
    expect(freqs.has(693_000)).toBe(true);      // NHK R2 manual
    // 関東 NHK 594 should NOT be present yet.
    expect(freqs.has(594_000)).toBe(false);
  });

  it('the region does not add records', async () => {
    // The argument exists for cache-keying and for the render-time name
    // lookup, not for the roster. Same count whichever region is asked for.
    const { loadPresets, clearPresetsCache } = await importLoader();
    clearPresetsCache();
    const kanto = await loadPresets('kanto');
    clearPresetsCache();
    const kinki = await loadPresets('kinki');
    clearPresetsCache();
    const none = await loadPresets();
    expect(kanto.length).toBe(3);
    expect(kinki.length).toBe(3);
    expect(none.length).toBe(3);
    // And the JP DB's own 関東 entries stay out of it.
    expect(kanto.some(p => p.freq === 594_000)).toBe(false);
    expect(kinki.some(p => p.freq === 1_008_000)).toBe(false);
  });

  it('every fixture entry survives unchanged', async () => {
    const { loadPresets, clearPresetsCache } = await importLoader();
    clearPresetsCache();
    const byFreq = new Map((await loadPresets('kanto')).map(p => [p.freq, p]));
    // The store's own name wins: nothing rewrites it at load time.
    expect(byFreq.get(90_500_000)?.name).toBe('TBS Radio (FM補完)');
    expect(byFreq.get(9_910_000)?.name).toBe('KTWR SW');
    expect(byFreq.get(693_000)?.name).toBe('NHK R2 Tokyo (manual SDR++)');
  });

  it('is sorted by frequency', async () => {
    const { loadPresets, clearPresetsCache } = await importLoader();
    clearPresetsCache();
    const freqs = (await loadPresets('kanto')).map(p => p.freq);
    expect(freqs).toEqual([...freqs].sort((a, b) => a - b));
  });

  it('carries the store bandwidth and mode through', async () => {
    const { loadPresets, clearPresetsCache } = await importLoader();
    clearPresetsCache();
    const byFreq = new Map((await loadPresets('kanto')).map(p => [p.freq, p]));
    // Mode indices are SDR++'s: 1 = WFM, 2 = AM.
    expect(byFreq.get(90_500_000)?.mode).toBe(1);
    expect(byFreq.get(693_000)?.mode).toBe(2);
    expect(byFreq.get(693_000)?.bandwidth).toBeGreaterThan(0);
  });
});
