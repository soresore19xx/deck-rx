/**
 * callsigns.json 差分レポータ。
 *
 * 想定 workflow:
 *   cp com.hogehoge.deck-rx.sdPlugin/data/callsigns.json{,.old}
 *   npx tsx scripts/fetch-callsigns.ts                           # 全量 fetch (50-60 min)
 *   npx tsx scripts/diff-callsigns.ts \
 *       com.hogehoge.deck-rx.sdPlugin/data/callsigns.json.old \
 *       com.hogehoge.deck-rx.sdPlugin/data/callsigns.json
 *
 * 出力カテゴリ:
 *   ADDED   - 新規 license (前回 fetch に無い freqHz+band+callsign)
 *   REMOVED - 廃止 license (前回 fetch にあった freqHz+band+callsign が今回欠落)
 *   CHANGED - 同 (freqHz, band, callsign) で location / operatorName が更新
 *
 * 各 entry を (freqHz, band, callsign) でキー化して比較。 freqHz だけだと
 * 同じ周波数で異なる送信所 (中継局) を見落とすので 3 軸結合キーが正解。
 *
 * Exit code:
 *   0 — 差分あり/なしに関わらず正常完了
 *   1 — 引数不足 / ファイル読込失敗
 */

import { readFileSync } from 'fs';

interface CallsignEntry {
  freqHz: number;
  band: 'FM' | 'MW';
  callsign: string;
  location: string;
  operatorName: string;
}

interface CallsignFile {
  callsigns?: CallsignEntry[];
}

const OLD = process.argv[2];
const NEW = process.argv[3];
if (!OLD || !NEW) {
  console.error('Usage: npx tsx scripts/diff-callsigns.ts <old.json> <new.json>');
  process.exit(1);
}

function load(path: string): CallsignEntry[] {
  try {
    const raw = readFileSync(path, 'utf-8');
    const data = JSON.parse(raw) as CallsignFile;
    return data.callsigns ?? [];
  } catch (e) {
    console.error(`FAIL load ${path}:`, e);
    process.exit(1);
  }
}

function key(c: CallsignEntry): string {
  return `${c.freqHz}|${c.band}|${c.callsign}`;
}

function fmtFreq(hz: number, band: 'FM' | 'MW'): string {
  if (band === 'FM') return `${(hz / 1_000_000).toFixed(1).padStart(7)} MHz`;
  return `${(hz / 1_000).toFixed(0).padStart(7)} kHz`;
}

function fmtEntry(c: CallsignEntry, prefix: string): string {
  const f = fmtFreq(c.freqHz, c.band);
  return `  ${prefix} ${f} ${c.band} ${c.callsign.padEnd(10)} ${c.location.slice(0, 40).padEnd(40)} ${c.operatorName.slice(0, 30)}`;
}

const oldMap = new Map<string, CallsignEntry>();
const newMap = new Map<string, CallsignEntry>();
for (const c of load(OLD)) oldMap.set(key(c), c);
for (const c of load(NEW)) newMap.set(key(c), c);

const added: CallsignEntry[] = [];
const removed: CallsignEntry[] = [];
const changed: Array<{ old: CallsignEntry; new: CallsignEntry; fields: string[] }> = [];

for (const [k, n] of newMap) {
  const o = oldMap.get(k);
  if (!o) { added.push(n); continue; }
  const fields: string[] = [];
  if (o.location     !== n.location)     fields.push('location');
  if (o.operatorName !== n.operatorName) fields.push('operatorName');
  if (fields.length > 0) changed.push({ old: o, new: n, fields });
}
for (const [k, o] of oldMap) {
  if (!newMap.has(k)) removed.push(o);
}

// Sort each list by freq for readability.
const byFreq = (a: CallsignEntry, b: CallsignEntry) => a.freqHz - b.freqHz;
added.sort(byFreq);
removed.sort(byFreq);
changed.sort((a, b) => a.new.freqHz - b.new.freqHz);

console.log(`OLD: ${oldMap.size} entries (${OLD})`);
console.log(`NEW: ${newMap.size} entries (${NEW})`);
console.log('');

console.log(`ADDED (${added.length}):`);
for (const c of added) console.log(fmtEntry(c, '+'));

console.log('');
console.log(`REMOVED (${removed.length}):`);
for (const c of removed) console.log(fmtEntry(c, '-'));

console.log('');
console.log(`CHANGED (${changed.length}):`);
for (const { old, new: n, fields } of changed) {
  console.log(fmtEntry(n, '~'));
  for (const f of fields) {
    const ov = (old as unknown as Record<string, string>)[f];
    const nv = (n   as unknown as Record<string, string>)[f];
    console.log(`      ${f}:`);
    console.log(`        - ${ov}`);
    console.log(`        + ${nv}`);
  }
}
