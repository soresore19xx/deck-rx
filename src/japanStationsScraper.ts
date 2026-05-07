import { parse, HTMLElement } from 'node-html-parser';
import type { JpStation, JpRegion } from './japanStations.js';
import { JP_REGION_LABELS } from './japanStations.js';

const KANTO_SOURCE_URL   = 'https://www.soumu.go.jp/soutsu/kanto/bc/radio/list/index.html';
const OKINAWA_SOURCE_URL = 'https://www.soumu.go.jp/soutsu/okinawa/johotuusin/ho_rd_frequency.html';

// 全国民放FM局・ワイドFM局一覧 — single page that lists every commercial FM
// broadcaster across all 47 prefectures, grouped under <div class="area_list">
// blocks identified by an area class on the <h2 class="area_list_title <area>">.
// We only pull the four regions whose 総通局 page does NOT itself have a
// frequency list (北海道 / 近畿 / 中国 / 九州). 関東 + 沖縄 keep their dedicated
// 総通局 scrapers since those pages also expose AM and CFM frequencies.
//
// Caveats of this source:
//   - Commercial broadcasters only — NHK FM is NOT listed (use manualStations
//     for the NHK FM frequencies in each region until a separate source lands).
//   - AM is not present at all (manualStations covers a few major MW DX
//     targets per region — MBS / TBC / RKB / HBC / RCC / STV — already).
//   - Page-side typo: 中国 area class is `cyugoku`, not `chugoku`.
const FM_LIST_URL = 'https://www.soumu.go.jp/menu_seisaku/ictseisaku/housou_suishin/fm-list.html';

const FM_LIST_AREA_TO_REGION: Record<string, JpRegion> = {
  hokkaido: 'hokkaido',
  tohoku:   'tohoku',
  tokai:    'tokai',
  kinki:    'kinki',
  cyugoku:  'chugoku',
};

// Prefectures inside the kyusyu_okinawa area block that belong to 九州.
// The page splits its broadcasters across TWO top-level <ul> blocks
// ("FM補完放送局(ワイドFM)" + "FM放送局"). Only some <li> wrappers carry an
// id="<prefecture>" — the second ul has just one (saga) and the rest are
// id-less, so we cannot rely on a sticky "current prefecture" flag carried
// from the first ul. Instead we decide per-broadcaster:
//   1. Use the wrapper li's id when present (id="okinawa" → 沖縄;
//      id ∈ KYUSHU_PREFECTURES → 九州).
//   2. Fall back to the broadcaster name — anything containing 沖縄 / 琉球
//      is treated as 沖縄, otherwise 九州.
const KYUSHU_PREFECTURES = new Set([
  'fukuoka', 'saga', 'nagasaki', 'kumamoto',
  'oita', 'miyazaki', 'kagoshima',
]);
const OKINAWA_NAME_RE = /沖縄|琉球/;

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

/**
 * Parse the 全国民放FM局・ワイドFM局一覧 page for one of the four supported
 * regions. The page layout: each region is a <div class="area_list"> with a
 * <h2 class="area_list_title <area>"> header; inside, top-level <li> entries
 * each contain a <ul class="housou"> whose first <li> is the operator name
 * and remaining <li> items are "（地域名）xx.xMHz" frequency rows.
 */
export function parseFmListHtml(html: string, targetRegion: 'hokkaido' | 'tohoku' | 'tokai' | 'kinki' | 'chugoku' | 'kyushu'): JpStation[] {
  const root = parse(html);
  const out: JpStation[] = [];
  for (const areaList of root.querySelectorAll('div.area_list')) {
    const titleEl = areaList.querySelector('h2.area_list_title');
    if (!titleEl) continue;
    const cls = titleEl.getAttribute('class') ?? '';
    const areaClass = cls.split(/\s+/).find(c => c !== 'area_list_title') ?? '';
    const isKyushuOkinawaArea = areaClass === 'kyusyu_okinawa';
    const directRegion = FM_LIST_AREA_TO_REGION[areaClass];
    // Skip area blocks irrelevant to the request.
    if (!isKyushuOkinawaArea && directRegion !== targetRegion) continue;
    if (isKyushuOkinawaArea && targetRegion !== 'kyushu') continue;
    // Each area_list contains TWO top-level <ul> blocks (one per broadcaster
    // category — "FM補完放送局(ワイドFM)" + "FM放送局"). We need to walk both;
    // querying just .querySelector('ul') silently misses half the broadcasters.
    for (const topUl of areaList.querySelectorAll('ul')) {
      if (topUl.parentNode !== areaList) continue;  // skip nested ul.housou
      for (const li of topUl.querySelectorAll('li')) {
        if (li.parentNode !== topUl) continue;  // depth-1 only (skip nested .housou items)
        const housou = li.querySelector('ul.housou');
        if (!housou) continue;
        const items = housou.querySelectorAll('li');
        if (items.length < 2) continue;
        const operatorName = cleanOperatorName(items[0].innerHTML);
        if (!operatorName) continue;
        // For kyusyu_okinawa area, decide per-broadcaster whether to keep:
        //   1. wrapper id="okinawa" / "saga"/etc → trust it
        //   2. wrapper has no id → infer from broadcaster name (沖縄/琉球 → 沖縄)
        // This avoids a sticky "previous prefecture" flag that would
        // misclassify the FM放送局 ul (only one id="saga" marker, rest id-less).
        if (isKyushuOkinawaArea) {
          const id = li.getAttribute('id') ?? '';
          let isOkinawa: boolean;
          if (id === 'okinawa') isOkinawa = true;
          else if (KYUSHU_PREFECTURES.has(id)) isOkinawa = false;
          else isOkinawa = OKINAWA_NAME_RE.test(operatorName);
          if (isOkinawa) continue;  // target is 'kyushu' — drop 沖縄 entries
        }
        for (let i = 1; i < items.length; i++) {
          const text = stripHtml(items[i].innerHTML);
          const m = text.match(/(\d+\.\d+)\s*MHz/);
          if (!m) continue;
          const hz = Math.round(parseFloat(m[1]) * 1_000_000);
          const band = classifyBand(hz);
          if (band !== 'FM') continue;
          out.push({ freqHz: hz, band, name: operatorName });
        }
      }
    }
  }
  return dedup(out).sort((a, b) => a.freqHz - b.freqHz);
}

// Fetch + parse the 全国民放FM局一覧 for one of 北海道 / 近畿 / 中国 / 九州.
// Tags every entry with the requested region.
async function fetchFmListStations(region: 'hokkaido' | 'tohoku' | 'tokai' | 'kinki' | 'chugoku' | 'kyushu'): Promise<JpStation[]> {
  const html = await fetchAndDecodeShiftJis(FM_LIST_URL);
  const stations = parseFmListHtml(html, region);
  if (stations.length < 5) throw new Error(`too few entries parsed for ${region} (${stations.length})`);
  return stations.map(s => ({ ...s, region: region as JpRegion }));
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
    case 'tohoku':
    case 'tokai':
    case 'kinki':
    case 'chugoku':
    case 'kyushu':
      return fetchFmListStations(region);
    default: {
      const _exhaustive: never = region;
      throw new Error(`Unknown JP region: ${String(_exhaustive)}`);
    }
  }
}
