// loadPresets region-merge tests. Points the loader at a fixture SDR++
// config and the live jp-stations.json so the merge / dedup logic is
// exercised end-to-end without the user's actual SDR++ bookmarks.
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

describe('loadPresets — deck-rx presets + JP DB merge', () => {
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

  it('with region=kanto: merged with auto-scraped 関東 entries', async () => {
    const { loadPresets, clearPresetsCache } = await importLoader();
    clearPresetsCache();
    const presets = await loadPresets('kanto');
    expect(presets.length).toBeGreaterThan(3);  // includes 関東 entries
    const byFreq = new Map(presets.map(p => [p.freq, p]));
    // 関東 NHK 594 from the auto-scraped pool
    expect(byFreq.get(594_000)?.name).toBe('NHK');
    // 90.5 MHz collision: deck-rx fixture has "TBS Radio (FM補完)", JP DB has
    // "TBSラジオ". JP DB wins on freq collision per loadPresets dedup rule.
    expect(byFreq.get(90_500_000)?.name).toBe('TBSラジオ');
    // 9910 kHz only in deck-rx fixture — preserved untouched.
    expect(byFreq.get(9_910_000)?.name).toBe('KTWR SW');
  });

  it('with region=kinki: 関東 auto entries are gone, ABCラジオ is in', async () => {
    const { loadPresets, clearPresetsCache } = await importLoader();
    clearPresetsCache();
    const presets = await loadPresets('kinki');
    const byFreq = new Map(presets.map(p => [p.freq, p]));
    // ABCラジオ at 1008 kHz comes from manualStations[region=kinki]
    expect(byFreq.get(1_008_000)?.name).toBe('ABCラジオ');
    // 関東 NHK 594 (auto-scraped, region=kanto) MUST NOT leak into kinki
    expect(byFreq.has(594_000)).toBe(false);
    // deck-rx fixture entries are still there
    expect(byFreq.get(9_910_000)?.name).toBe('KTWR SW');
  });

  it('region switch produces different lists', async () => {
    const { loadPresets, clearPresetsCache } = await importLoader();
    clearPresetsCache();
    const kantoList = await loadPresets('kanto');
    clearPresetsCache();
    const kinkiList = await loadPresets('kinki');
    expect(kantoList.length).not.toBe(kinkiList.length);
    // The two regions should have non-identical name sets
    const kantoNames = new Set(kantoList.map(p => p.name));
    const kinkiNames = new Set(kinkiList.map(p => p.name));
    expect(kantoNames.has('NHK')).toBe(true);          // 関東 NHK
    expect(kinkiNames.has('ABCラジオ')).toBe(true);    // 近畿 manualStations
  });

  it('preset bandwidth/mode follow the JP DB band classification', async () => {
    const { loadPresets, clearPresetsCache } = await importLoader();
    clearPresetsCache();
    const presets = await loadPresets('kanto');
    const byFreq = new Map(presets.map(p => [p.freq, p]));
    const nhkAm = byFreq.get(594_000);
    expect(nhkAm?.mode).toBe(2);          // AM
    expect(nhkAm?.bandwidth).toBe(9_000);
    // Pick any FM band entry (there are many); just sanity-check shape
    const fmEntry = presets.find(p => p.freq >= 76_000_000 && p.freq <= 108_000_000 && p.name !== 'TBS Radio (FM補完)');
    expect(fmEntry?.mode).toBe(1);        // WFM
    expect(fmEntry?.bandwidth).toBe(200_000);
  });
});
