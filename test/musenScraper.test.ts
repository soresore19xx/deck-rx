/**
 * Unit tests for src/musenScraper.ts. Covers list-page DFCD enumeration
 * and detail-page (識別信号 / 周波数 / 設置場所 / 法人名) extraction
 * against fixture HTML captured 2026-05-10 from
 * https://www.tele.soumu.go.jp/musen/SearchServlet (公共データ利用規約 第1.0版).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  parseMusenListHtml,
  parseMusenDetailHtml,
  buildListUrl,
  buildDetailUrl,
} from '../src/musenScraper.js';

const FIXTURES = join(__dirname, 'fixtures');
const LIST_AM   = readFileSync(join(FIXTURES, 'musen_list_am.html'),    'utf-8');
const DETAIL_JOWN = readFileSync(join(FIXTURES, 'musen_detail_stv_jown.html'), 'utf-8');
const DETAIL_NHK_JOVK = readFileSync(join(FIXTURES, 'musen_detail_nhk_jovk.html'), 'utf-8');
const DETAIL_TOKYOFM = readFileSync(join(FIXTURES, 'musen_detail_tokyofm_joau.html'), 'utf-8');

describe('buildListUrl / buildDetailUrl', () => {
  it('builds AM/SW list URL with correct SelectHSK + paging', () => {
    expect(buildListUrl('03', 1)).toContain('SelectHSK=03');
    expect(buildListUrl('03', 1)).toContain('SC=1');
    expect(buildListUrl('03', 101)).toContain('SC=101');
  });
  it('builds FM list URL with SelectHSK=04', () => {
    expect(buildListUrl('04', 1)).toContain('SelectHSK=04');
  });
  it('builds detail URL with given DFCD + IT (per-entry, not fixed)', () => {
    expect(buildDetailUrl('0000008760', 'J')).toBe(
      'https://www.tele.soumu.go.jp/musen/SearchServlet?pageID=4&IT=J&DFCD=0000008760&DD=1&styleNumber=01',
    );
    expect(buildDetailUrl('0000010504', 'I')).toBe(
      'https://www.tele.soumu.go.jp/musen/SearchServlet?pageID=4&IT=I&DFCD=0000010504&DD=1&styleNumber=01',
    );
  });
});

describe('parseMusenListHtml', () => {
  it('extracts 100 entries from a single 100-per-page result', () => {
    const entries = parseMusenListHtml(LIST_AM);
    expect(entries.length).toBe(100);
  });
  it('extracts dfcd as numeric string + raw 法人名 + prefecture', () => {
    const entries = parseMusenListHtml(LIST_AM);
    const first = entries[0];
    expect(first.dfcd).toMatch(/^\d{10}$/);
    expect(first.rawName.length).toBeGreaterThan(0);
    expect(first.prefecture).toMatch(/北海道/);    // page 1 starts with 北海道
  });
  it('first entry is 株式会社ＳＴＶラジオ in 北海道函館市 (anchor entry of the AM page)', () => {
    const entries = parseMusenListHtml(LIST_AM);
    const stv = entries[0];
    expect(stv.rawName).toContain('ＳＴＶラジオ');
    expect(stv.prefecture).toBe('北海道函館市');
    expect(stv.dfcd).toBe('0000008760');
  });
});

describe('parseMusenDetailHtml', () => {
  it('extracts callsign / freq / location / operator from the STV-JOWN detail page', () => {
    const d = parseMusenDetailHtml(DETAIL_JOWN);
    expect(d).not.toBeNull();
    if (!d) return;
    expect(d.callsign).toBe('JOWN');
    expect(d.freqHz).toBe(639_000);
    expect(d.band).toBe('MW');
    expect(d.location).toBe('北海道函館市');
    expect(d.operatorName).toContain('ＳＴＶラジオ');
  });

  it('returns null for a page missing the 電波の型式 row (defensive: malformed input)', () => {
    // Strip the 電波の型式 row entirely (label tr + value tr) — actual HTML
    // is <td id="deftd" colspan="4">電波の型式…</td> on one tr, value tr
    // following. Removing the label text causes extractDetailField to return
    // '' which fails the freq match → parser bails cleanly.
    const stripped = DETAIL_JOWN.replace('電波の型式、周波数及び空中線電力', '');
    expect(parseMusenDetailHtml(stripped)).toBeNull();
  });

  it('handles NHK detail where callsign appears BEFORE the masked text ("JOVK *****" instead of "***** JOWN")', () => {
    const d = parseMusenDetailHtml(DETAIL_NHK_JOVK);
    expect(d).not.toBeNull();
    if (!d) return;
    expect(d.callsign).toBe('JOVK');
    expect(d.operatorName).toContain('日本放送協会');
  });

  it('handles TOKYO FM JOAU-FM 親局 with nested-table 電波の型式 cell — regression: nextElementSibling returned <td>, not <tr>, for label rows whose value tr contains nested <table>', () => {
    const d = parseMusenDetailHtml(DETAIL_TOKYOFM);
    expect(d).not.toBeNull();
    if (!d) return;
    expect(d.callsign).toBe('JOAU-FM');
    expect(d.freqHz).toBe(80_000_000);
    expect(d.band).toBe('FM');
    expect(d.operatorName).toContain('エフエム東京');
    expect(d.location).toContain('東京都港区');
  });

  it('returns null when freqHz falls outside MW (522-1710 kHz) and FM (76-108 MHz)', () => {
    // Simulate a SW broadcast (e.g. Radio Nikkei 6.055 MHz) by rewriting the freq cell.
    const sw = DETAIL_JOWN.replace('639', '6055');
    expect(parseMusenDetailHtml(sw)).toBeNull();
  });
});
