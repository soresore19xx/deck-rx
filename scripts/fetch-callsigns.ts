/**
 * One-shot bootstrap fetcher for src/data/callsigns.json.
 *
 * 出典: 総務省「無線局等情報検索」 (https://www.tele.soumu.go.jp/musen/)
 * 公共データ利用規約 (第1.0版) に準拠して取得・再配布しています:
 *   https://www.soumu.go.jp/menu_kyotsuu/policy/tyosaku.html
 *
 * 使い方:
 *   npx tsx scripts/fetch-callsigns.ts             # AM + FM 全件 (~25 分)
 *   npx tsx scripts/fetch-callsigns.ts --validate  # AM 1 page (100 局) のみ
 *
 * 出力: com.hogehoge.deck-rx.sdPlugin/data/callsigns.json
 *   {
 *     "_source": "総務省「無線局等情報検索」 (公共データ利用規約 第1.0版)",
 *     "_url": "https://www.tele.soumu.go.jp/musen/",
 *     "_fetchedAt": "<ISO timestamp>",
 *     "callsigns": [
 *       { "freqHz": 594000, "band": "MW", "callsign": "JOAK",
 *         "location": "東京都港区", "operatorName": "日本放送協会" },
 *       ...
 *     ]
 *   }
 *
 * Rate limit: 1 req/sec sequential (courtesy)。 ban / 503 はまず出ないが、
 * 万一 transient error が出たら 5 sec 待って 1 回だけリトライ。
 */

import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { scrapeMusenBroadcasts, type MusenDetailEntry } from '../src/musenScraper.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'com.hogehoge.deck-rx.sdPlugin', 'data', 'callsigns.json');

const VALIDATE = process.argv.includes('--validate');

function progressBar(done: number, total: number, label: string): void {
  const pct = total > 0 ? Math.floor((done / total) * 100) : 0;
  const bar = '█'.repeat(Math.floor(pct / 5)).padEnd(20, '░');
  process.stdout.write(`\r[${label}] ${bar} ${pct}% (${done}/${total})`);
  if (done === total) process.stdout.write('\n');
}

async function run(): Promise<void> {
  const started = Date.now();
  console.log(`Starting fetch from 総務省 無線局等情報検索 (1 req/sec, ${VALIDATE ? 'AM 1 page only' : 'AM + FM full'})...`);
  console.log(`出典: 公共データ利用規約 (第1.0版) — https://www.tele.soumu.go.jp/musen/`);
  console.log('');

  let amResults: MusenDetailEntry[] = [];
  let fmResults: MusenDetailEntry[] = [];

  // AM/SW (SelectHSK=03)
  if (VALIDATE) {
    // Only fetch list page 1 + first 100 detail pages — for quick smoke test.
    const { scrapeOnePage } = await import('./fetch-callsigns-helpers.js');
    amResults = await scrapeOnePage('03', { rateLimitMs: 1000, onProgress: (d, t) => progressBar(d, t, 'AM smoke') });
  } else {
    amResults = await scrapeMusenBroadcasts('03', {
      rateLimitMs: 1000,
      onProgress: (d, t) => progressBar(d, t, 'AM/SW'),
    });
  }
  console.log(`AM/SW: ${amResults.length} entries`);

  if (!VALIDATE) {
    fmResults = await scrapeMusenBroadcasts('04', {
      rateLimitMs: 1000,
      onProgress: (d, t) => progressBar(d, t, 'FM   '),
    });
    console.log(`FM:    ${fmResults.length} entries`);
  }

  const all = [...amResults, ...fmResults];
  const out = {
    _source: '総務省「無線局等情報検索」 (公共データ利用規約 第1.0版)',
    _url: 'https://www.tele.soumu.go.jp/musen/',
    _fetchedAt: new Date().toISOString(),
    _note: '本データは 公共データ利用規約 第1.0版 (https://www.soumu.go.jp/menu_kyotsuu/policy/tyosaku.html) に準拠し総務省公開情報から取得・再配布しています。 編集・加工: freqHz / band 正規化のみ。',
    callsigns: all,
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n', 'utf-8');
  const elapsed = Math.floor((Date.now() - started) / 1000);
  console.log(`\nWrote ${all.length} entries to ${OUT}`);
  console.log(`Elapsed: ${Math.floor(elapsed / 60)}m ${elapsed % 60}s`);
}

run().catch((e) => {
  console.error('\nFAIL:', e);
  process.exit(1);
});
