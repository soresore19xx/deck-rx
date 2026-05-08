import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  parseSoumuKantoHtml,
  parseSoumuOkinawaHtml,
  parseFmListHtml,
} from '../src/japanStationsScraper.js';

const FIXTURES = join(__dirname, 'fixtures');
const KANTO_HTML    = readFileSync(join(FIXTURES, 'kanto.html'),    'utf-8');
const OKINAWA_HTML  = readFileSync(join(FIXTURES, 'okinawa.html'),  'utf-8');
const FM_LIST_HTML  = readFileSync(join(FIXTURES, 'fm-list.html'),  'utf-8');

// Fixture snapshots are real captures of the live 総務省 / 総通局 pages on
// 2026-05-08. Counts may drift on re-snapshot (the upstream pages do change
// when new CFM stations get licensed / FM補完 frequencies are added), so
// assertions check shape + lower bounds rather than exact totals.

describe('parseSoumuKantoHtml', () => {
  it('returns a healthy 関東 station list', () => {
    const stations = parseSoumuKantoHtml(KANTO_HTML);
    expect(stations.length).toBeGreaterThanOrEqual(150);
  });

  it('includes the well-known 関東 anchors', () => {
    const stations = parseSoumuKantoHtml(KANTO_HTML);
    const byFreq = new Map(stations.map(s => [s.freqHz, s]));

    expect(byFreq.get(594_000)?.name).toMatch(/NHK/);                  // NHK R1 東京 親局
    expect(byFreq.get(81_300_000)?.name).toMatch(/J.WAVE/i);           // 81.3 MHz J-WAVE
    expect(byFreq.get(80_000_000)?.name).toMatch(/TOKYO FM|TOKYOFM|エフエム東京/i); // 80.0 MHz TOKYO FM (法人名は「エフエム東京」)
  });

  it('FM補完中継局 周波数を含む', () => {
    const stations = parseSoumuKantoHtml(KANTO_HTML);
    const fm = stations.filter(s => s.band === 'FM');
    const mw = stations.filter(s => s.band === 'MW');
    expect(fm.length).toBeGreaterThan(50);
    expect(mw.length).toBeGreaterThan(10);
  });
});

describe('parseSoumuOkinawaHtml', () => {
  it('returns 30+ entries (4 AM ops × 11 sites + FM + CFM, dedup-aware)', () => {
    const stations = parseSoumuOkinawaHtml(OKINAWA_HTML);
    expect(stations.length).toBeGreaterThanOrEqual(30);
  });

  it('parses ※-marker FM-補完 cells alongside AM kHz', () => {
    const stations = parseSoumuOkinawaHtml(OKINAWA_HTML);
    // 738 kHz NHK第一 沖縄 親局 (AM)
    expect(stations.some(s => s.freqHz === 738_000 && s.band === 'MW')).toBe(true);
    // 88.1 MHz NHK 沖縄 親局 (FM, table 2)
    expect(stations.some(s => s.freqHz === 88_100_000 && s.band === 'FM')).toBe(true);
    // 92.1 MHz 琉球放送 ※ FM 補完 (inline-marked from AM table)
    expect(stations.some(s => s.freqHz === 92_100_000 && s.band === 'FM')).toBe(true);
  });
});

describe('parseFmListHtml — region-filtered FM extraction', () => {
  it('hokkaido yields 民放FM + ワイドFM (around ~20 entries)', () => {
    const stations = parseFmListHtml(FM_LIST_HTML, 'hokkaido');
    expect(stations.length).toBeGreaterThanOrEqual(15);
    expect(stations.length).toBeLessThan(40);
    expect(stations.every(s => s.band === 'FM')).toBe(true);
  });

  it('kinki yields 民放FM + ワイドFM (around ~30 entries)', () => {
    const stations = parseFmListHtml(FM_LIST_HTML, 'kinki');
    expect(stations.length).toBeGreaterThanOrEqual(20);
    expect(stations.length).toBeLessThan(50);
  });

  it('chugoku yields ~50+ entries (中継局多数)', () => {
    const stations = parseFmListHtml(FM_LIST_HTML, 'chugoku');
    expect(stations.length).toBeGreaterThanOrEqual(40);
  });

  it('kyushu does NOT contain 沖縄 / 琉球 broadcasters', () => {
    const stations = parseFmListHtml(FM_LIST_HTML, 'kyushu');
    expect(stations.length).toBeGreaterThanOrEqual(20);
    // The fix introduced for the kyusyu_okinawa shared block — without it,
    // エフエム沖縄 / 琉球放送 / ラジオ沖縄 leak into kyushu when the FM放送局
    // ul (only saga has an id) carries id-less broadcasters.
    expect(stations.every(s => !/沖縄|琉球/.test(s.name))).toBe(true);
  });

  it('tohoku yields 民放FM (newly supported region)', () => {
    const stations = parseFmListHtml(FM_LIST_HTML, 'tohoku');
    expect(stations.length).toBeGreaterThanOrEqual(20);
  });

  it('tokai yields 民放FM (newly supported region)', () => {
    const stations = parseFmListHtml(FM_LIST_HTML, 'tokai');
    expect(stations.length).toBeGreaterThanOrEqual(15);
  });
});
