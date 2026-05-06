// One-shot regenerator for com.hogehoge.deck-rx.sdPlugin/data/jp-stations.json.
// Reads the cached 関東総通局 HTML from /tmp/soumu-kanto-radio.utf8.html (or
// path passed as argv[2]), runs the same parser as src/japanStationsScraper.ts,
// and writes the cleaned `stations` array back. `manualStations` and
// `_comment` are preserved verbatim from the existing file.
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { parse } from 'node-html-parser';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET = join(__dirname, '..', 'com.hogehoge.deck-rx.sdPlugin', 'data', 'jp-stations.json');

const NAME_ALIASES = {
  '日本放送協会': 'NHK',
  'アール・エフ・ラジオ日本': 'ラジオ日本',
  'LuckyFM茨城放送': 'LuckyFM',
};
const ORG_PREFIXES = [
  '株式会社', '（株）', '(株)',
  '一般社団法人', '一般財団法人',
  '公益社団法人', '公益財団法人',
  '特定非営利活動法人',
];

const stripHtml = (s) => s
  .replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();

function cleanOperatorName(raw) {
  let s = stripHtml(raw).trim();
  s = s.split(/[\r\n]+/)[0].trim();
  for (const p of ORG_PREFIXES) if (s.endsWith(p)) { s = s.slice(0, -p.length).trim(); break; }
  const m = s.match(/^.*?[（(]([^（）()]{1,30})[）)]\s*$/);
  if (m) s = m[1].trim();
  else { for (const p of ORG_PREFIXES) if (s.startsWith(p)) { s = s.slice(p.length); break; } s = s.trim(); }
  return NAME_ALIASES[s] ?? s;
}

function classifyBand(hz) {
  if (hz >= 76_000_000 && hz <= 108_000_000) return 'FM';
  if (hz >=    500_000 && hz <=   1_800_000) return 'MW';
  return null;
}

function parseFreqList(html, defaultUnit) {
  const text = stripHtml(html);
  const out = [];
  for (const m of text.matchAll(/(\d+\.\d+|\d{2,4})\s*(kHz|MHz)?/g)) {
    const value = parseFloat(m[1]);
    const unit = m[2] ?? defaultUnit;
    const hz = unit === 'MHz' ? Math.round(value * 1_000_000) : Math.round(value * 1_000);
    const band = classifyBand(hz);
    if (!band) continue;
    out.push({ hz, band });
  }
  return out;
}

function expandRows(table) {
  const result = [];
  const carry = [];
  for (const tr of table.querySelectorAll('tr')) {
    const tds = tr.querySelectorAll('td');
    if (tds.length === 0) continue;
    const row = [];
    let tdIdx = 0, col = 0;
    while (tdIdx < tds.length || (carry[col] && carry[col].remaining > 0)) {
      if (carry[col] && carry[col].remaining > 0) {
        row[col] = carry[col].value; carry[col].remaining--; col++;
      } else if (tdIdx < tds.length) {
        const td = tds[tdIdx++];
        const rs = parseInt(td.getAttribute('rowspan') ?? '1', 10);
        const v = td.innerHTML;
        row[col] = v;
        if (rs > 1) carry[col] = { value: v, remaining: rs - 1 };
        col++;
      } else break;
    }
    result.push(row);
  }
  return result;
}

const parseAm = (t) => {
  const out = [];
  for (const r of expandRows(t)) {
    if (r.length < 4) continue;
    const n = cleanOperatorName(r[1]); if (!n) continue;
    for (const f of parseFreqList(r[2], 'kHz')) out.push({ freqHz: f.hz, band: f.band, name: n });
    for (const f of parseFreqList(r[3], 'kHz')) out.push({ freqHz: f.hz, band: f.band, name: n });
  }
  return out;
};
const parseFm = (t) => {
  const out = [];
  for (const r of expandRows(t)) {
    if (r.length < 4) continue;
    const n = cleanOperatorName(r[1]); if (!n) continue;
    for (const f of parseFreqList(r[2], 'MHz')) out.push({ freqHz: f.hz, band: f.band, name: n });
    for (const f of parseFreqList(r[3], 'MHz')) out.push({ freqHz: f.hz, band: f.band, name: n });
  }
  return out;
};
const parseCfm = (t) => {
  const out = [];
  for (const r of expandRows(t)) {
    if (r.length < 4) continue;
    const n = cleanOperatorName(r[1]); if (!n) continue;
    for (const f of parseFreqList(r[3], 'MHz')) out.push({ freqHz: f.hz, band: f.band, name: n });
  }
  return out;
};
const dedup = (arr) => {
  const seen = new Set(), out = [];
  for (const s of arr) { const k = `${s.freqHz}|${s.name}`; if (seen.has(k)) continue; seen.add(k); out.push(s); }
  return out;
};

const htmlPath = process.argv[2] ?? '/tmp/soumu-kanto-radio.utf8.html';
const html = readFileSync(htmlPath, 'utf-8');
const root = parse(html);
const all = [];
for (const t of root.querySelectorAll('table.tableList')) {
  const sum = t.getAttribute('summary') ?? '';
  if (sum === '中波放送') all.push(...parseAm(t));
  else if (sum === '趙短波放送' || sum === '超短波放送') all.push(...parseFm(t));
  else if (sum.endsWith('のコミュニティ放送')) all.push(...parseCfm(t));
}
const stations = dedup(all).sort((a, b) => a.freqHz - b.freqHz);

const cur = JSON.parse(readFileSync(TARGET, 'utf-8'));
const next = { _comment: cur._comment, stations, manualStations: cur.manualStations ?? [] };
writeFileSync(TARGET, JSON.stringify(next, null, 2) + '\n');
console.log(`Wrote ${stations.length} stations + ${(cur.manualStations ?? []).length} manualStations to ${TARGET}`);
