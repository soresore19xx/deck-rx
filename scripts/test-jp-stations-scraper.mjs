#!/usr/bin/env node
// Run the JP-stations scraper against the cached Shift_JIS HTML at
// /tmp/soumu-kanto-radio.html (fetched via curl earlier) and print a summary.
// Usage: node scripts/test-jp-stations-scraper.mjs [path/to/page.html]
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { parse } from 'node-html-parser';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .trim();

function cleanOperatorName(raw) {
  let s = stripHtml(raw).trim();
  s = s.split(/[\r\n]+/)[0].trim();
  for (const p of ORG_PREFIXES) if (s.endsWith(p)) { s = s.slice(0, -p.length).trim(); break; }
  const parenMatch = s.match(/^.*?[（(]([^（）()]{1,30})[）)]\s*$/);
  if (parenMatch) {
    s = parenMatch[1].trim();
  } else {
    for (const p of ORG_PREFIXES) if (s.startsWith(p)) { s = s.slice(p.length); break; }
    s = s.trim();
  }
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
  const re = /(\d+\.\d+|\d{2,4})\s*(kHz|MHz)?/g;
  for (const m of text.matchAll(re)) {
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
      } else { break; }
    }
    result.push(row);
  }
  return result;
}

function parseAmTable(table) {
  const out = [];
  for (const row of expandRows(table)) {
    if (row.length < 4) continue;
    const name = cleanOperatorName(row[1]);
    if (!name) continue;
    for (const f of parseFreqList(row[2], 'kHz')) out.push({ freqHz: f.hz, band: f.band, name });
    for (const f of parseFreqList(row[3], 'kHz')) out.push({ freqHz: f.hz, band: f.band, name });
  }
  return out;
}
function parseFmTable(table) {
  const out = [];
  for (const row of expandRows(table)) {
    if (row.length < 4) continue;
    const name = cleanOperatorName(row[1]);
    if (!name) continue;
    for (const f of parseFreqList(row[2], 'MHz')) out.push({ freqHz: f.hz, band: f.band, name });
    for (const f of parseFreqList(row[3], 'MHz')) out.push({ freqHz: f.hz, band: f.band, name });
  }
  return out;
}
function parseCfmTable(table) {
  const out = [];
  for (const row of expandRows(table)) {
    if (row.length < 4) continue;
    const name = cleanOperatorName(row[1]);
    if (!name) continue;
    for (const f of parseFreqList(row[3], 'MHz')) out.push({ freqHz: f.hz, band: f.band, name });
  }
  return out;
}
function dedup(arr) {
  const seen = new Set();
  const out = [];
  for (const s of arr) {
    const k = `${s.freqHz}|${s.name}`;
    if (seen.has(k)) continue;
    seen.add(k); out.push(s);
  }
  return out;
}

const path = process.argv[2] ?? '/tmp/soumu-kanto-radio.utf8.html';
const html = readFileSync(path, 'utf-8');
const root = parse(html);

const all = [];
const breakdown = {};
for (const t of root.querySelectorAll('table.tableList')) {
  const summary = t.getAttribute('summary') ?? '';
  let arr = [];
  if (summary === '中波放送')              arr = parseAmTable(t);
  else if (summary === '趙短波放送')         arr = parseFmTable(t);
  else if (summary === '超短波放送')         arr = parseFmTable(t);
  else if (summary.endsWith('のコミュニティ放送')) arr = parseCfmTable(t);
  else continue;
  breakdown[summary] = arr.length;
  all.push(...arr);
}

const stations = dedup(all).sort((a, b) => a.freqHz - b.freqHz);
console.log(`Total entries: ${stations.length}`);
console.log('Breakdown:');
for (const [k, v] of Object.entries(breakdown)) console.log(`  ${k}: ${v}`);
console.log('---first 10---');
for (const s of stations.slice(0, 10)) console.log(`  ${(s.freqHz/1000).toFixed(0).padStart(7)} kHz  ${s.band}  ${s.name}`);
console.log('---last 10---');
for (const s of stations.slice(-10)) console.log(`  ${(s.freqHz/1000).toFixed(0).padStart(7)} kHz  ${s.band}  ${s.name}`);
console.log('---sample lookups---');
for (const target of [594, 693, 810, 78900, 81300, 89200, 90500, 91600, 92400, 93000, 94600]) {
  const tHz = target * 1000;
  const matches = stations.filter(s => Math.abs(s.freqHz - tHz) < (target > 50000 ? 50000 : 4000));
  console.log(`  ${target} kHz → ${matches.map(m => m.name).join(', ') || '(no match)'}`);
}
