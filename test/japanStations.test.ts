import { describe, it, expect } from 'vitest';
import { resolve } from 'path';

// Point the loader at the live data file before importing the module under
// test (the env var is read once at module-load time inside japanStations.ts).
process.env.DECK_RX_JP_STATIONS_PATH = resolve(
  __dirname, '..', 'com.hogehoge.deck-rx.sdPlugin', 'data', 'jp-stations.json',
);

const { lookupJpStation, isJpRegion, JP_REGIONS, JP_REGION_LABELS } =
  await import('../src/japanStations.js');

// Tests run against the live com.hogehoge.deck-rx.sdPlugin/data/jp-stations.json,
// which after the latest commit contains:
//   stations[]:        166 entries, all region: 'kanto' (auto-scraped)
//   manualStations[]:  11 entries with region tags (kanto/hokkaido/tohoku/
//                      tokai/kinki/chugoku/kyushu)
// Tests check the region-filter logic against known entries from that file.

describe('JpRegion catalogue', () => {
  it('exposes all 8 regions', () => {
    expect(JP_REGIONS).toEqual(['kanto', 'hokkaido', 'tohoku', 'tokai', 'kinki', 'chugoku', 'kyushu', 'okinawa']);
    expect(JP_REGIONS.length).toBe(8);
  });

  it('JP_REGION_LABELS covers every region', () => {
    for (const r of JP_REGIONS) {
      expect(JP_REGION_LABELS[r]).toBeTruthy();
    }
  });

  it('isJpRegion accepts known regions, rejects others', () => {
    expect(isJpRegion('kanto')).toBe(true);
    expect(isJpRegion('hokkaido')).toBe(true);
    expect(isJpRegion('tohoku')).toBe(true);
    expect(isJpRegion('tokai')).toBe(true);
    expect(isJpRegion('hokuriku')).toBe(false);
    expect(isJpRegion('shikoku')).toBe(false);
    expect(isJpRegion('xxx')).toBe(false);
    expect(isJpRegion(undefined)).toBe(false);
    expect(isJpRegion(123)).toBe(false);
  });
});

describe('lookupJpStation — region filter on manualStations', () => {
  it('1008 kHz ABCラジオ hits in kinki, misses in kanto', () => {
    const inKinki = lookupJpStation(1_008_000, 'kinki');
    expect(inKinki?.name).toBe('ABCラジオ');
    expect(inKinki?.band).toBe('MW');

    const inKanto = lookupJpStation(1_008_000, 'kanto');
    expect(inKanto).toBeNull();
  });

  it('810 kHz AFN Eagle 810 hits in kanto, misses in kinki', () => {
    const inKanto = lookupJpStation(810_000, 'kanto');
    expect(inKanto?.name).toBe('AFN Eagle 810');

    const inKinki = lookupJpStation(810_000, 'kinki');
    expect(inKinki).toBeNull();
  });

  it('1287 kHz HBCラジオ hits in hokkaido only', () => {
    expect(lookupJpStation(1_287_000, 'hokkaido')?.name).toBe('HBCラジオ');
    expect(lookupJpStation(1_287_000, 'kanto')).toBeNull();
    expect(lookupJpStation(1_287_000, 'tohoku')).toBeNull();
  });

  it('1260 kHz TBCラジオ hits in tohoku only (newly added region)', () => {
    expect(lookupJpStation(1_260_000, 'tohoku')?.name).toBe('TBCラジオ');
    expect(lookupJpStation(1_260_000, 'kanto')).toBeNull();
  });

  it('1332 kHz 東海ラジオ hits in tokai only (newly added region)', () => {
    expect(lookupJpStation(1_332_000, 'tokai')?.name).toBe('東海ラジオ');
    expect(lookupJpStation(1_332_000, 'kinki')).toBeNull();
  });
});

describe('lookupJpStation — region filter on auto-scraped pool', () => {
  it('594 kHz NHK hits in kanto (auto-scraped 関東 entry)', () => {
    const e = lookupJpStation(594_000, 'kanto');
    expect(e?.name).toBe('NHK');
    expect(e?.band).toBe('MW');
  });

  it('594 kHz misses in kinki (no kinki auto entry, no kinki manual at 594)', () => {
    expect(lookupJpStation(594_000, 'kinki')).toBeNull();
  });
});

describe('lookupJpStation — out-of-band', () => {
  it('returns null outside MW and FM bands', () => {
    expect(lookupJpStation(100, 'kanto')).toBeNull();
    expect(lookupJpStation(50_000_000, 'kanto')).toBeNull();
    expect(lookupJpStation(200_000_000, 'kanto')).toBeNull();
  });
});
