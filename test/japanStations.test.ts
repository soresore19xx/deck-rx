import { describe, it, expect } from 'vitest';
import { resolve } from 'path';

// Point the loader at the live data file before importing the module under
// test (the env var is read once at module-load time inside japanStations.ts).
process.env.DECK_RX_JP_STATIONS_PATH = resolve(
  __dirname, '..', 'com.hogehoge.deck-rx.sdPlugin', 'data', 'jp-stations.json',
);

// Same env override for the callsigns sidecar.
process.env.DECK_RX_CALLSIGNS_PATH = resolve(
  __dirname, '..', 'com.hogehoge.deck-rx.sdPlugin', 'data', 'callsigns.json',
);

const { lookupJpStation, lookupCallsign, formatJpStationLabel, isJpRegion, JP_REGIONS, JP_REGION_LABELS } =
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

describe('lookupJpStation — tolerance window (regression: VFO off-channel must NOT match)', () => {
  // Bug 2026-05-10: with MW tolerance 4 kHz, VFO-tuning 590-598 kHz (any of
  // those 1 kHz steps near NHK東京 594) all surfaced "NHK" on the dial header,
  // implying "on-channel" while the user was 4 kHz off — far past the AM
  // bandwidth, no signal actually receivable. Tolerance now 500 Hz for MW
  // (and 5 kHz for FM) so only freqs essentially on-grid match.
  it('MW 590 kHz does NOT match 594 kHz NHK (4 kHz off-channel)', () => {
    expect(lookupJpStation(590_000, 'kanto')).toBeNull();
  });
  it('MW 598 kHz does NOT match 594 kHz NHK (4 kHz off-channel)', () => {
    expect(lookupJpStation(598_000, 'kanto')).toBeNull();
  });
  it('MW 593 kHz still matches 594 kHz NHK (1 kHz off — within absorb-rounding window)', () => {
    expect(lookupJpStation(593_500, 'kanto')?.name).toBe('NHK');
  });
  it('FM 80.003 MHz still matches 80.0 MHz TOKYO FM (3 kHz drift, within 5 kHz window)', () => {
    expect(lookupJpStation(80_003_000, 'kanto')).not.toBeNull();
  });
  it('FM 80.020 MHz does NOT match 80.0 MHz (20 kHz off — outside 5 kHz tolerance)', () => {
    expect(lookupJpStation(80_020_000, 'kanto')).toBeNull();
  });
  it('FM 80.050 MHz does NOT match 80.0 MHz (50 kHz off — mid-channel, off-channel)', () => {
    expect(lookupJpStation(80_050_000, 'kanto')).toBeNull();
  });
});

describe('lookupJpStation — out-of-band', () => {
  it('returns null outside MW and FM bands', () => {
    expect(lookupJpStation(100, 'kanto')).toBeNull();
    expect(lookupJpStation(50_000_000, 'kanto')).toBeNull();
    expect(lookupJpStation(200_000_000, 'kanto')).toBeNull();
  });
});

describe('formatJpStationLabel — display formatting', () => {
  it('NHK MW infers 第1 channel (post-2025-03 第2 closure)', () => {
    expect(formatJpStationLabel({ freqHz: 594_000, band: 'MW', name: 'NHK' })).toBe('NHK第1');
  });
  it('NHK FM renders as NHK-FM', () => {
    expect(formatJpStationLabel({ freqHz: 82_500_000, band: 'FM', name: 'NHK' })).toBe('NHK-FM');
  });
  it('NHK MW + siteName appends "(site)"', () => {
    expect(formatJpStationLabel({ freqHz: 594_000, band: 'MW', name: 'NHK', siteName: '東京' })).toBe('NHK第1 (東京)');
  });
  it('NHK FM + multi-site siteName preserves the verbatim string', () => {
    expect(formatJpStationLabel({ freqHz: 82_500_000, band: 'FM', name: 'NHK', siteName: '東京・墨田' })).toBe('NHK-FM (東京・墨田)');
  });
  it('non-NHK name passes through unchanged', () => {
    expect(formatJpStationLabel({ freqHz: 80_000_000, band: 'FM', name: 'TOKYO FM' })).toBe('TOKYO FM');
  });
  it('non-NHK + siteName appends parens', () => {
    expect(formatJpStationLabel({ freqHz: 80_000_000, band: 'FM', name: 'TOKYO FM', siteName: '東京' })).toBe('TOKYO FM (東京)');
  });
  it('manual-curated name "NHKラジオ第2" passes through unchanged (only bare "NHK" is auto-channelled)', () => {
    expect(formatJpStationLabel({ freqHz: 693_000, band: 'MW', name: 'NHKラジオ第2' })).toBe('NHKラジオ第2');
  });
  it('693 kHz NHKラジオ第2 has been removed from manualStations (2025-03 closure)', () => {
    expect(lookupJpStation(693_000, 'kanto')).toBeNull();
  });

  // 識別信号 (callsign) is the third format axis, sourced from 総務省 via
  // scripts/fetch-callsigns.ts. The infix sits between the (channel-resolved)
  // name and the parens-site, so all three pieces compose cleanly.
  it('NHK MW + callsign + siteName: "NHK第1 JOAK (東京)"', () => {
    expect(formatJpStationLabel({
      freqHz: 594_000, band: 'MW', name: 'NHK', callsign: 'JOAK', siteName: '東京',
    })).toBe('NHK第1 JOAK (東京)');
  });
  it('NHK FM + callsign + siteName: "NHK-FM JOAK-FM (東京・墨田)"', () => {
    expect(formatJpStationLabel({
      freqHz: 82_500_000, band: 'FM', name: 'NHK', callsign: 'JOAK-FM', siteName: '東京・墨田',
    })).toBe('NHK-FM JOAK-FM (東京・墨田)');
  });
  it('non-NHK + callsign + siteName: "TBSラジオ JOKR (東京)"', () => {
    expect(formatJpStationLabel({
      freqHz: 954_000, band: 'MW', name: 'TBSラジオ', callsign: 'JOKR', siteName: '東京',
    })).toBe('TBSラジオ JOKR (東京)');
  });
  it('callsign without siteName: "TBSラジオ JOKR"', () => {
    expect(formatJpStationLabel({
      freqHz: 954_000, band: 'MW', name: 'TBSラジオ', callsign: 'JOKR',
    })).toBe('TBSラジオ JOKR');
  });
});

describe('lookupJpStation with sidecar callsign DB (regression: cross-region preset)', () => {
  it('594 kHz NHK東京 親局 → callsign JOAK joined from sidecar', () => {
    const e = lookupJpStation(594_000, 'kanto');
    expect(e?.name).toBe('NHK');
    expect(e?.callsign).toBe('JOAK');
  });
  it('954 kHz TBSラジオ → callsign JOKR joined from sidecar', () => {
    const e = lookupJpStation(954_000, 'kanto');
    expect(e?.callsign).toBe('JOKR');
  });
  it('lookupCallsign is region-independent — 1179 kHz JOOR for kanto user', () => {
    // 1179 kHz MBSラジオ is region-tagged kinki, so a kanto user's
    // lookupJpStation returns null. lookupCallsign still surfaces JOOR
    // so the preset-name fallback path can append it.
    expect(lookupJpStation(1_179_000, 'kanto')).toBeNull();
    expect(lookupCallsign(1_179_000)).toBe('JOOR');
  });
  it('lookupCallsign returns undefined for out-of-band freq', () => {
    expect(lookupCallsign(50_000_000)).toBeUndefined();
  });
});
