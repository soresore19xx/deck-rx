import { parse, HTMLElement } from 'node-html-parser';
import type { JpStation } from './japanStations.js';

const SOURCE_URL = 'https://www.soumu.go.jp/soutsu/kanto/bc/radio/list/index.html';

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

// Fetch the 関東 list page and return the parsed station array. The page is
// served as Shift_JIS — Node's built-in TextDecoder('shift-jis') handles the
// transcode without an extra dependency.
export async function fetchJpStations(): Promise<JpStation[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  let resp: Response;
  try {
    resp = await fetch(SOURCE_URL, { signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length < 30 * 1024) throw new Error(`response too small (${buf.length} bytes)`);
  const html = new TextDecoder('shift-jis').decode(buf);
  const stations = parseSoumuKantoHtml(html);
  if (stations.length < 50) throw new Error(`too few entries parsed (${stations.length})`);
  return stations;
}
