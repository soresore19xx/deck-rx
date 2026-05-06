// Standalone smoke test that mirrors src/eibi.ts logic — no TS toolchain needed.
// Run: node scripts/test-eibi.mjs
//
// Intentionally a duplicate of the parser in src/eibi.ts so we can verify the EIBI
// data format independently of the TS build. If the TS module diverges, update
// both sides together.

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EIBI_PATH = join(__dirname, '..', 'com.hogehoge.deck-rx.sdPlugin', 'data', 'eibi.txt');

function parseLine(line) {
  if (line.length < 50) return null;
  const freqStr = line.slice(0, 14).trim();
  const timeStr = line.slice(14, 23).trim();
  const daysItuStr = line.slice(23, 34);
  const nameStr = line.slice(34, 58).trim();
  const freq = parseFloat(freqStr);
  if (!freq || !Number.isFinite(freq)) return null;
  const tm = /^(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(timeStr);
  if (!tm) return null;
  const sh = +tm[1], sm = +tm[2], eh = +tm[3], em = +tm[4];
  if (!nameStr || nameStr.includes('Jammer')) return null;
  const dItu = daysItuStr.trim().split(/\s+/).filter(s => s.length > 0);
  const dayCode = dItu.length >= 2 ? dItu[0] : '';
  if (dayCode === 'spur') return null;
  return {
    freqKhz: Math.round(freq),
    startMin: sh * 60 + sm,
    endMin: eh * 60 + em,
    dayCode,
    name: nameStr,
  };
}

const DAY_CODES = { Su: 0, Mo: 1, Tu: 2, We: 3, Th: 4, Fr: 5, Sa: 6 };
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function digitToDow(c) { const n = +c; if (n>=1 && n<=6) return n; if (n===7) return 0; return -1; }
function dayMatches(code, when) {
  if (!code) return true;
  if (['irr','spur','tent','alt','Last7','Tests','Days'].includes(code)) return true;
  const dow = when.getUTCDay();
  const dm = /^(\d{1,2})([A-Z][a-z]{2})$/.exec(code);
  if (dm) { const mi = MONTHS.indexOf(dm[2]); if (mi<0) return true; return when.getUTCDate()===+dm[1] && when.getUTCMonth()===mi; }
  const nth = /^(\d)\.([A-Z][a-z])$/.exec(code);
  if (nth) { const t = DAY_CODES[nth[2]]; if (t===undefined) return true; if (dow!==t) return false; return Math.floor((when.getUTCDate()-1)/7)+1 === +nth[1]; }
  const range = /^([A-Z][a-z])-([A-Z][a-z])$/.exec(code);
  if (range) { const f=DAY_CODES[range[1]], t=DAY_CODES[range[2]]; if (f===undefined||t===undefined) return true; return f<=t ? (dow>=f && dow<=t) : (dow>=f || dow<=t); }
  if (code.includes(',')) return code.split(',').some(p => dayMatches(p, when));
  if (/^\d+$/.test(code)) { for (const c of code) if (digitToDow(c)===dow) return true; return false; }
  if (code.length>=4 && code.length%2===0 && /^([A-Z][a-z])+$/.test(code)) { for (let i=0;i<code.length;i+=2) if (DAY_CODES[code.slice(i,i+2)]===dow) return true; return false; }
  if (DAY_CODES[code] !== undefined) return DAY_CODES[code] === dow;
  return true;
}

const text = readFileSync(EIBI_PATH, 'utf-8');
const all = [];
for (const raw of text.split('\n')) {
  const e = parseLine(raw.replace(/\r$/, ''));
  if (e) all.push(e);
}
all.sort((a, b) => a.freqKhz - b.freqKhz);
console.log(`Loaded ${all.length} EIBI entries from ${EIBI_PATH}`);

function isActive(e, nowMin) {
  if (e.startMin <= e.endMin) return nowMin >= e.startMin && nowMin <= e.endMin;
  return nowMin >= e.startMin || nowMin <= e.endMin;
}

function windowLen(e) {
  let n = e.endMin - e.startMin;
  if (n <= 0) n += 1440;
  return n;
}

function lookup(freqHz, when) {
  const freqKhz = Math.round(freqHz / 1000);
  const nowMin = when.getUTCHours() * 60 + when.getUTCMinutes();
  let lo = 0, hi = all.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (all[mid].freqKhz < freqKhz) lo = mid + 1;
    else hi = mid;
  }
  const matches = [];
  for (let i = lo; i < all.length && all[i].freqKhz === freqKhz; i++) {
    if (isActive(all[i], nowMin) && dayMatches(all[i].dayCode, when)) matches.push(all[i]);
  }
  matches.sort((a, b) => windowLen(a) - windowLen(b));
  return matches[0] ?? null;
}

// JST = UTC+9. Test cases below are written in UTC for clarity.
function utc(h, m) { const d = new Date(); d.setUTCHours(h, m, 0, 0); return d; }
// Fixed UTC date helpers for day-of-week-sensitive cases (so the suite is
// reproducible regardless of when it runs).
function utcOn(y, mo, d, h, mi) { return new Date(Date.UTC(y, mo - 1, d, h, mi)); }
const WED_2026_05_06 = (h, m) => utcOn(2026, 5, 6, h, m);  // Wednesday
const SAT_2026_05_09 = (h, m) => utcOn(2026, 5, 9, h, m);  // Saturday

// Lookup tie-breaker: when multiple entries are active at `now` on the same kHz,
// the shortest-window entry wins (= most specific schedule slot). The cases below
// reflect that policy.
const cases = [
  { hz: 6055_000,  t: utc(0, 0),   expect: 'Radio Nikkei' },        // JST 09:00
  { hz: 6055_000,  t: utc(8, 0),   expect: 'Radio Nikkei' },        // JST 17:00
  { hz: 6055_000,  t: utc(14, 30), expect: 'Radio Nikkei' },        // narrow We-only slot
  { hz: 6000_000,  t: utc(12, 0),  expect: 'Radio Habana Cuba' },   // Habana 1100-1300 wins over CNR1 1100-1805
  { hz: 6000_000,  t: utc(2, 0),   expect: 'IRIB' },                // IRIB 0050-0220 wins over Habana 0000-0600
  { hz: 7335_000,  t: utc(15, 0),  expect: 'CNR' },
  // Day-filter regression: 6115 kHz on Wed 09:00 UTC must pick Mo-Fr Nikkei 2,
  // not the SaSu / 4May SE-TA2 entries (which my pre-day-filter parser preferred
  // by tie-break order).
  { hz: 6115_000,  t: WED_2026_05_06(9, 0),  expect: 'Radio Nikkei 2' },
  // 6115 kHz on Sat 11:00 UTC: SE-TA2's SaSu 1000-1200 slot is active.
  { hz: 6115_000,  t: SAT_2026_05_09(11, 0), expect: 'SE-TA2' },
  // 6115 kHz on Sat 09:00 UTC: nothing real is scheduled. The only daily entry is
  // Voz Missionária flagged "spur" (parasitic emission), which we drop at parse
  // time → result is null, not a fake match.
  { hz: 6115_000,  t: SAT_2026_05_09(9, 0),  expect: null },
];

let failures = 0;
for (const c of cases) {
  const r = lookup(c.hz, c.t);
  const got = r ? `${r.freqKhz} kHz "${r.name}" ${pad(r.startMin)}-${pad(r.endMin)}` : '(none)';
  const ok = c.expect === null
    ? r === null
    : (r !== null && r.name.includes(c.expect));
  console.log(`${ok ? 'OK ' : 'FAIL'}  ${c.hz / 1000} kHz @ UTC ${pad2(c.t.getUTCHours())}:${pad2(c.t.getUTCMinutes())}  →  ${got}  (expect: ${c.expect === null ? 'null' : `contains "${c.expect}"`})`);
  if (!ok) failures++;
}

function pad(min) { const h = Math.floor(min / 60), m = min % 60; return `${pad2(h)}:${pad2(m)}`; }
function pad2(n) { return String(n).padStart(2, '0'); }

console.log('---');
console.log(`Now (UTC ${pad2(new Date().getUTCHours())}:${pad2(new Date().getUTCMinutes())}):`);
const live = [3925_000, 6055_000, 9740_000, 11760_000, 15170_000];
for (const hz of live) {
  const r = lookup(hz, new Date());
  console.log(`  ${hz / 1000} kHz  →  ${r ? `${r.name}  (${pad(r.startMin)}-${pad(r.endMin)} UTC)` : '(none)'}`);
}

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}
