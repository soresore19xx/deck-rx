import { parse, HTMLElement } from 'node-html-parser';
import type { JpStation, JpRegion } from './japanStations.js';
import { JP_REGION_LABELS } from './japanStations.js';

const KANTO_SOURCE_URL   = 'https://www.soumu.go.jp/soutsu/kanto/bc/radio/list/index.html';
const OKINAWA_SOURCE_URL = 'https://www.soumu.go.jp/soutsu/okinawa/johotuusin/ho_rd_frequency.html';

// Operator-name aliases for stations whose 総務省 法人名 is verbose or
// otherwise less recognisable than a common brand. Applied after the generic
// "株式会社" / "（株）" prefix strip and the parenthesised-brand extraction.
// Keep the list short and obvious — only when the LCD-friendly form is
// substantially more useful than the literal 法人名.
const NAME_ALIASES: Record<string, string> = {
  '日本放送協会': 'NHK',
  'アール・エフ・ラジオ日本': 'ラジオ日本',
  'LuckyFM茨城放送': 'LuckyFM',
};

// 法人形態 prefixes to strip so the LCD shows the brand-y portion of the name.
const ORG_PREFIXES = [
  '株式会社', '（株）', '(株)',
  '一般社団法人', '一般財団法人',
  '公益社団法人', '公益財団法人',
  '特定非営利活動法人',
];

const AM_BAND_HZ = { lo:    500_000, hi:   1_800_000 };
const FM_BAND_HZ = { lo: 76_000_000, hi: 108_000_000 };

function classifyBand(hz: number): 'FM' | 'MW' | null {
  if (hz >= FM_BAND_HZ.lo && hz <= FM_BAND_HZ.hi) return 'FM';
  if (hz >= AM_BAND_HZ.lo && hz <= AM_BAND_HZ.hi) return 'MW';
  return null;
}

function stripHtml(s: string): string {
  // Replace <br /> family with newline, strip the rest of the tags, decode &nbsp;.
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function cleanOperatorName(raw: string): string {
  let s = stripHtml(raw).trim();
  // The 法人名 cell sometimes carries an annotation on a second line —
  // e.g. "InterFM897<br>（外国語放送）" — which after stripHtml becomes
  // "InterFM897\n（外国語放送）". Keep only the first line so the
  // annotation doesn't leak into the LCD label.
  s = s.split(/[\r\n]+/)[0].trim();
  // Some entries put the 法人形態 at the END instead of the start:
  //   "横浜エフエム放送株式会社" → "横浜エフエム放送"
  // Trim once from either end before the rest of the cleanup runs.
  for (const p of ORG_PREFIXES) {
    if (s.endsWith(p)) { s = s.slice(0, -p.length).trim(); break; }
  }
  // CFM rows commonly carry a parenthesised brand at the end of the 法人名:
  //   "葛飾エフエム放送株式会社（かつしかFM）"  → "かつしかFM"
  //   "アクティブレイン(SKYWAVE FM)"          → "SKYWAVE FM"
  //   "茅ヶ崎エフエム(EBOSHI RADIO STATION)"   → "EBOSHI RADIO STATION"
  // Prefer that brand for LCD legibility — it's the broadcaster's outward-
  // facing name. Fall through to the prefix-strip path when no end-paren.
  const parenMatch = s.match(/^.*?[（(]([^（）()]{1,30})[）)]\s*$/);
  if (parenMatch) {
    s = parenMatch[1].trim();
  } else {
    for (const p of ORG_PREFIXES) {
      if (s.startsWith(p)) { s = s.slice(p.length); break; }
    }
    s = s.trim();
  }
  return NAME_ALIASES[s] ?? s;
}

// Extract all (freqHz, band) pairs from a table cell. Matches `594kHz`,
// `82.6MHz`, and bare decimal numbers (`82.5`) — the latter falls back to
// `defaultUnit`. The 2-4 digit / decimal-required lookahead in the regex
// avoids scooping up stray digits like 「FM補完中継局」 sub-strings.
function parseFreqList(html: string, defaultUnit: 'kHz' | 'MHz'): { hz: number; band: 'FM' | 'MW' }[] {
  const text = stripHtml(html);
  const out: { hz: number; band: 'FM' | 'MW' }[] = [];
  const re = /(\d+\.\d+|\d{2,4})\s*(kHz|MHz)?/g;
  for (const m of text.matchAll(re)) {
    const value = parseFloat(m[1]);
    const unit = (m[2] as 'kHz' | 'MHz' | undefined) ?? defaultUnit;
    const hz = unit === 'MHz' ? Math.round(value * 1_000_000) : Math.round(value * 1_000);
    const band = classifyBand(hz);
    if (!band) continue;   // out-of-range / spurious match
    out.push({ hz, band });
  }
  return out;
}

// Walk a <table> expanding any rowspan="N" so each output row has every
// column populated. node-html-parser preserves rowspan as a plain attribute,
// so we maintain a per-column "carry-over" buffer and pull from it before
// consuming the next physical <td> in the current <tr>.
function expandRows(table: HTMLElement): string[][] {
  const result: string[][] = [];
  const carry: Array<{ value: string; remaining: number }> = [];
  for (const tr of table.querySelectorAll('tr')) {
    const tds = tr.querySelectorAll('td');
    if (tds.length === 0) continue; // header row
    const row: string[] = [];
    let tdIdx = 0;
    let col = 0;
    while (tdIdx < tds.length || (carry[col] && carry[col].remaining > 0)) {
      if (carry[col] && carry[col].remaining > 0) {
        row[col] = carry[col].value;
        carry[col].remaining--;
        col++;
      } else if (tdIdx < tds.length) {
        const td = tds[tdIdx++];
        const rowspan = parseInt(td.getAttribute('rowspan') ?? '1', 10);
        const value = td.innerHTML;
        row[col] = value;
        if (rowspan > 1) carry[col] = { value, remaining: rowspan - 1 };
        col++;
      } else {
        break;
      }
    }
    result.push(row);
  }
  return result;
}

// 中波 (AM) table: cols [#, name, parentFreq, relayFreq]
// Both freq columns may contain multiple `594kHz(東京)\n927kHz(甲府)` style
// entries; explicit kHz/MHz suffix is always present in this table.
function parseAmTable(table: HTMLElement): JpStation[] {
  const out: JpStation[] = [];
  for (const row of expandRows(table)) {
    if (row.length < 4) continue;
    const name = cleanOperatorName(row[1]);
    if (!name) continue;
    for (const f of parseFreqList(row[2], 'kHz')) out.push({ freqHz: f.hz, band: f.band, name });
    for (const f of parseFreqList(row[3], 'kHz')) out.push({ freqHz: f.hz, band: f.band, name });
  }
  return out;
}

// 超短波 (FM) table: cols [#, name, parentFreq, relayFreq, area]
// Frequencies are bare numbers (column header says "親局周波数（MHz）").
// Rowspan compresses one operator across many sub-rows; expandRows handles it.
function parseFmTable(table: HTMLElement): JpStation[] {
  const out: JpStation[] = [];
  for (const row of expandRows(table)) {
    if (row.length < 4) continue;
    const name = cleanOperatorName(row[1]);
    if (!name) continue;
    for (const f of parseFreqList(row[2], 'MHz')) out.push({ freqHz: f.hz, band: f.band, name });
    for (const f of parseFreqList(row[3], 'MHz')) out.push({ freqHz: f.hz, band: f.band, name });
  }
  return out;
}

// コミュニティ放送 tables (one per prefecture): cols [#, name, location, freq]
// Default unit MHz (header literally says "周波数(MHz)").
function parseCfmTable(table: HTMLElement): JpStation[] {
  const out: JpStation[] = [];
  for (const row of expandRows(table)) {
    if (row.length < 4) continue;
    const name = cleanOperatorName(row[1]);
    if (!name) continue;
    for (const f of parseFreqList(row[3], 'MHz')) out.push({ freqHz: f.hz, band: f.band, name });
  }
  return out;
}

// Deduplicate (freqHz, name) so a parent freq listed in both AM 親局 and the
// equivalent FM 補完 中継局 doesn't surface twice. Keeps insertion order so
// AM-table-first wins on tie. Different name on same freq is preserved
// (different broadcasters at the same kHz across regions).
function dedup(stations: JpStation[]): JpStation[] {
  const seen = new Set<string>();
  const out: JpStation[] = [];
  for (const s of stations) {
    const key = `${s.freqHz}|${s.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

// Run the full parse over already-decoded UTF-8 HTML. Returns the merged
// station list across AM / FM / CFM (短波 is intentionally skipped — Radio
// Nikkei is covered by the EIBI database).
export function parseSoumuKantoHtml(html: string): JpStation[] {
  const root = parse(html);
  const tables = root.querySelectorAll('table.tableList');
  const out: JpStation[] = [];
  for (const t of tables) {
    const summary = t.getAttribute('summary') ?? '';
    if (summary === '中波放送')               out.push(...parseAmTable(t));
    else if (summary === '趙短波放送')          out.push(...parseFmTable(t));   // (sic) 総務省ページ表記
    else if (summary === '超短波放送')          out.push(...parseFmTable(t));   // future-proof if they fix the typo
    else if (summary.endsWith('のコミュニティ放送')) out.push(...parseCfmTable(t));
    // 短波放送 is skipped on purpose.
  }
  return dedup(out).sort((a, b) => a.freqHz - b.freqHz);
}

// Generic fetch + Shift_JIS decode. Each 総通局 page on www.soumu.go.jp ships
// as Shift_JIS; this helper returns the decoded HTML so each region's parser
// can run on a clean string. min-size guards against truncated/error responses
// the regional pages run from ~15 KB (沖縄) up to ~300 KB+ (関東) so the floor
// is intentionally loose.
async function fetchAndDecodeShiftJis(url: string): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  let resp: Response;
  try {
    resp = await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length < 10 * 1024) throw new Error(`response too small (${buf.length} bytes)`);
  return new TextDecoder('shift-jis').decode(buf);
}

// Fetch the 関東 list page and return the parsed station array. Each entry
// is tagged with region: 'kanto' so it can be filtered correctly at lookup time.
async function fetchKantoStations(): Promise<JpStation[]> {
  const html = await fetchAndDecodeShiftJis(KANTO_SOURCE_URL);
  const stations = parseSoumuKantoHtml(html);
  if (stations.length < 50) throw new Error(`too few entries parsed (${stations.length})`);
  return stations.map(s => ({ ...s, region: 'kanto' as const }));
}

// 沖縄 中波 (AM) cell — may contain BOTH AM kHz and an FM-補完 ※-prefixed MHz
// value, separated by <br>. The page caption literally says "※単位はMHz（FM）".
//   "738<br>※92.1" → AM 738 kHz + FM 92.1 MHz
//   "※82.6"        → FM 82.6 MHz only (no AM mainline at this site)
//   "549"           → AM 549 kHz only
//   "" or "　"      → empty (whitespace / NBSP)
// Returns the (hz, band) pairs found in the cell.
function parseOkinawaAmCell(html: string): { hz: number; band: 'FM' | 'MW' }[] {
  const text = stripHtml(html);
  const out: { hz: number; band: 'FM' | 'MW' }[] = [];
  for (const piece of text.split(/[\s　\r\n]+/)) {
    if (!piece) continue;
    const isMHz = piece.startsWith('※');
    const cleaned = piece.replace(/^※/, '');
    const m = cleaned.match(/^(\d+\.\d+|\d{2,4})$/);
    if (!m) continue;
    const value = parseFloat(m[1]);
    const hz = isMHz ? Math.round(value * 1_000_000) : Math.round(value * 1_000);
    const band = classifyBand(hz);
    if (!band) continue;
    out.push({ hz, band });
  }
  return out;
}

// 沖縄 中波 / FM テーブル: header row carries station names across the columns,
// each subsequent row's first <th> is a location (沖縄/名護/...), the rest are
// freq cells indexed by the matching column header.
//
// `cellParser`: how to extract (hz, band) from a single freq cell. AM table
// uses parseOkinawaAmCell (handles the ※ MHz inline marker); FM table uses
// the generic parseFreqList with defaultUnit='MHz'.
function parseOkinawaTransposedTable(
  table: HTMLElement,
  cellParser: (html: string) => { hz: number; band: 'FM' | 'MW' }[],
): JpStation[] {
  const trs = table.querySelectorAll('tr');
  if (trs.length < 2) return [];
  // Header row: first <th> is "局名" label, the remaining are station names.
  const headerCells = trs[0].querySelectorAll('th');
  const stationNames: string[] = [];
  for (let i = 1; i < headerCells.length; i++) {
    stationNames.push(cleanOperatorName(headerCells[i].innerHTML));
  }
  const out: JpStation[] = [];
  for (let r = 1; r < trs.length; r++) {
    const cells = trs[r].querySelectorAll('th, td');
    // cells[0] = location <th>, cells[1..] = freq <td> per station column.
    for (let i = 1; i < cells.length && i - 1 < stationNames.length; i++) {
      const name = stationNames[i - 1];
      if (!name) continue;
      for (const f of cellParser(cells[i].innerHTML)) {
        out.push({ freqHz: f.hz, band: f.band, name });
      }
    }
  }
  return out;
}

// 沖縄 コミュニティFM テーブル: 3 columns (市町村名, 局名, 周波数 MHz).
// Slightly different shape from 関東's 4-col CFM table so we can't reuse
// parseCfmTable directly.
function parseOkinawaCfmTable(table: HTMLElement): JpStation[] {
  const out: JpStation[] = [];
  const trs = table.querySelectorAll('tr');
  for (let r = 1; r < trs.length; r++) {  // skip header row
    const cells = trs[r].querySelectorAll('th, td');
    if (cells.length < 3) continue;
    const name = cleanOperatorName(cells[1].innerHTML);
    if (!name) continue;
    for (const f of parseFreqList(cells[2].innerHTML, 'MHz')) {
      out.push({ freqHz: f.hz, band: f.band, name });
    }
  }
  return out;
}

/**
 * Run the 沖縄 parse over already-decoded UTF-8 HTML. The page has three
 * tables (all `<table class="tableList">`), distinguished by their captions:
 *   1. 中波ラジオ放送局周波数一覧表（kHz）  — AM with inline ※ FM-補完 cells
 *   2. FM放送局周波数一覧表（MHz）          — pure FM
 *   3. コミュニティFM放送局周波数一覧表     — CFM
 * Returns the merged + de-duplicated + freq-sorted station list.
 */
export function parseSoumuOkinawaHtml(html: string): JpStation[] {
  const root = parse(html);
  const tables = root.querySelectorAll('table.tableList');
  const out: JpStation[] = [];
  for (const t of tables) {
    const caption = t.querySelector('caption')?.text ?? '';
    if (caption.includes('中波ラジオ')) {
      out.push(...parseOkinawaTransposedTable(t, parseOkinawaAmCell));
    } else if (caption.includes('FM放送局') && !caption.includes('コミュニティ')) {
      out.push(...parseOkinawaTransposedTable(t, h => parseFreqList(h, 'MHz')));
    } else if (caption.includes('コミュニティFM')) {
      out.push(...parseOkinawaCfmTable(t));
    }
  }
  return dedup(out).sort((a, b) => a.freqHz - b.freqHz);
}

// Fetch + parse the 沖縄 page; tags every entry with region: 'okinawa'.
async function fetchOkinawaStations(): Promise<JpStation[]> {
  const html = await fetchAndDecodeShiftJis(OKINAWA_SOURCE_URL);
  const stations = parseSoumuOkinawaHtml(html);
  // 沖縄 has far fewer stations than 関東 (4 AM operators × 11 sites + a few
  // FM main + ~10 CFM ≈ 30-60 entries). Floor at 5 just to catch a fully
  // empty / structurally-broken parse.
  if (stations.length < 5) throw new Error(`too few entries parsed (${stations.length})`);
  return stations.map(s => ({ ...s, region: 'okinawa' as const }));
}

/**
 * Region-aware scraper dispatcher. Returns stations with region pre-tagged
 * so the caller can merge results into the global stations[] without having
 * to remember which region was just scraped.
 *
 * Currently only `'kanto'` is implemented; the other regions throw a
 * descriptive "not yet implemented" error. The PI surfaces the error via
 * the existing renderJpStatus failure path.
 */
export async function scrapeJpStations(region: JpRegion): Promise<JpStation[]> {
  switch (region) {
    case 'kanto':
      return fetchKantoStations();
    case 'okinawa':
      return fetchOkinawaStations();
    case 'hokkaido':
    case 'kinki':
    case 'chugoku':
    case 'kyushu':
      throw new Error(`${JP_REGION_LABELS[region]} (${region}) scraper not yet implemented — coming in a follow-up release. ` +
        `For now, add stations manually to manualStations[].`);
    default: {
      const _exhaustive: never = region;
      throw new Error(`Unknown JP region: ${String(_exhaustive)}`);
    }
  }
}
