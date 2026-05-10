/**
 * Supplemental fetch for major broadcasters NOT returned by the default
 * SelectHSK=04 sweep — typically 中央放送局 like TOKYO FM (株式会社エフエム
 * 東京) and J-WAVE (株式会社Ｊ－ＷＡＶＥ) whose 親局 license falls outside
 * the default broadcast-station-list query for unclear reasons.
 *
 * Re-runs targeted NA= name searches against 総務省 and merges the new
 * entries into existing callsigns.json (dedup by callsign+freqHz+band+location).
 *
 * Usage: npx tsx scripts/fetch-callsigns-supplement.ts
 *
 * 出典/規約: 既存 fetch-callsigns.ts と同様 (公共データ利用規約 第1.0版)
 */

import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { scrapeMusenByOperatorNames, type MusenDetailEntry } from '../src/musenScraper.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'com.hogehoge.deck-rx.sdPlugin', 'data', 'callsigns.json');

// 中央放送局含む major 関東 / 中京 / 近畿 民放 FM 親局 + 全 NHK FM。
// keyword は 法人正式名称 (株式会社含む) で検索。 SelectHSK=04 デフォルト
// sweep に出てこなかった entries を補完する目的。
const FM_KEYWORDS = [
  '株式会社エフエム東京',         // TOKYO FM JOAU-FM 80.0
  '株式会社Ｊ－ＷＡＶＥ',         // J-WAVE JOAV-FM 81.3
  '日本放送協会',                 // NHK FM 全国
];

const AM_KEYWORDS = [
  '日本放送協会',                 // NHK第1 全国
  '株式会社ＴＢＳラジオ',         // TBS JOKR
  '株式会社ニッポン放送',         // LF JOLF
  '株式会社文化放送',             // QR JOQR
];

interface CallsignFile {
  _source?: string;
  _url?: string;
  _fetchedAt?: string;
  _note?: string;
  callsigns?: MusenDetailEntry[];
}

function progress(label: string, done: number, total: number): void {
  process.stdout.write(`\r[${label}] ${done}/${total}`);
  if (done === total) process.stdout.write('\n');
}

async function run(): Promise<void> {
  const started = Date.now();
  console.log(`Supplemental fetch (NA= name keyword) for major broadcasters...`);

  const fmExtra = await scrapeMusenByOperatorNames('04', FM_KEYWORDS, {
    rateLimitMs: 1000,
    onProgress: (d, t) => progress('FM extra', d, t),
  });
  console.log(`FM extra: ${fmExtra.length} new candidates`);

  const amExtra = await scrapeMusenByOperatorNames('03', AM_KEYWORDS, {
    rateLimitMs: 1000,
    onProgress: (d, t) => progress('AM extra', d, t),
  });
  console.log(`AM extra: ${amExtra.length} new candidates`);

  const all = [...fmExtra, ...amExtra];

  // Merge with existing callsigns.json. Dedup key: callsign + freqHz + band.
  // Same key with different location is treated as identical (one license per
  // (callsign, freq, band) typically) — just keep the longer/newer location.
  const raw = readFileSync(OUT, 'utf-8');
  const existing = JSON.parse(raw) as CallsignFile;
  const existingMap = new Map<string, MusenDetailEntry>();
  for (const c of existing.callsigns ?? []) {
    existingMap.set(`${c.callsign}|${c.freqHz}|${c.band}`, c);
  }
  let added = 0, updated = 0;
  for (const c of all) {
    const k = `${c.callsign}|${c.freqHz}|${c.band}`;
    if (!existingMap.has(k)) { existingMap.set(k, c); added++; }
    else { updated++; }
  }
  const merged = Array.from(existingMap.values()).sort((a, b) => a.freqHz - b.freqHz || a.callsign.localeCompare(b.callsign));
  const out = {
    ...existing,
    _fetchedAt: new Date().toISOString(),
    callsigns: merged,
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n', 'utf-8');
  const elapsed = Math.floor((Date.now() - started) / 1000);
  console.log(`Merged: +${added} new entries, ${updated} duplicates skipped`);
  console.log(`Total now: ${merged.length} entries → ${OUT}`);
  console.log(`Elapsed: ${Math.floor(elapsed / 60)}m ${elapsed % 60}s`);
}

run().catch((e) => {
  console.error('\nFAIL:', e);
  process.exit(1);
});
