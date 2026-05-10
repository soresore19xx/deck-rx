/**
 * Brute-force 50 音 sweep for 総務省 broadcast callsign DB.
 *
 * 案 (3): 案 (1) の手書き法人名リスト方式と異なり、 NA= キーワードを
 * カタカナ 50 音 + 濁音 + 半濁音 + 漢字 broadcast 関連語を順次叩いて
 * sweep する方式。 案 (1) で漏れる operator も拾う網羅性重視。
 *
 * Usage: npx tsx scripts/fetch-callsigns-50on.ts
 *
 * 出力: com.hogehoge.deck-rx.sdPlugin/data/callsigns-50on.json (案 (1)
 * 結果と直接比較するため別ファイル、 main DB には merge しない)
 *
 * 出典/規約: 公共データ利用規約 第1.0版
 */

import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { scrapeMusenByOperatorNames, type MusenDetailEntry } from '../src/musenScraper.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'com.hogehoge.deck-rx.sdPlugin', 'data', 'callsigns-50on.json');

const KEYWORDS = [
  // カタカナ清音
  'ア','イ','ウ','エ','オ',
  'カ','キ','ク','ケ','コ',
  'サ','シ','ス','セ','ソ',
  'タ','チ','ツ','テ','ト',
  'ナ','ニ','ヌ','ネ','ノ',
  'ハ','ヒ','フ','ヘ','ホ',
  'マ','ミ','ム','メ','モ',
  'ヤ','ユ','ヨ',
  'ラ','リ','ル','レ','ロ',
  'ワ','ヲ','ン',
  // 濁音
  'ガ','ギ','グ','ゲ','ゴ','ジ','ズ','ダ','デ','ド','バ','ビ','ブ','ベ','ボ',
  // 半濁音
  'パ','ピ','プ','ペ','ポ',
  // 漢字 broadcast 頻出語
  '放送','協会','日本','東京','大阪','名古屋','福岡','札幌','仙台','広島',
  '株式会社','一般社団法人','一般財団法人','公益社団法人','公益財団法人',
];

function progress(label: string, done: number, total: number): void {
  process.stdout.write(`\r[${label}] ${done}/${total}`);
  if (done === total) process.stdout.write('\n');
}

async function run(): Promise<void> {
  const started = Date.now();
  console.log(`50-on sweep: ${KEYWORDS.length} keywords x (AM + FM)`);
  console.log(`Source: 公共データ利用規約 第1.0版 — https://www.tele.soumu.go.jp/musen/`);

  const fmExtra = await scrapeMusenByOperatorNames('04', KEYWORDS, {
    rateLimitMs: 1000,
    onProgress: (d, t) => progress('FM', d, t),
  });
  console.log(`FM unique entries: ${fmExtra.length}`);

  const amExtra = await scrapeMusenByOperatorNames('03', KEYWORDS, {
    rateLimitMs: 1000,
    onProgress: (d, t) => progress('AM', d, t),
  });
  console.log(`AM unique entries: ${amExtra.length}`);

  const all = [...fmExtra, ...amExtra].sort((a, b) =>
    a.freqHz - b.freqHz || a.callsign.localeCompare(b.callsign));

  const out = {
    _source: '総務省「無線局等情報検索」 (公共データ利用規約 第1.0版)',
    _url: 'https://www.tele.soumu.go.jp/musen/',
    _fetchedAt: new Date().toISOString(),
    _note: '50 音 + 濁/半濁 + 漢字 broadcast 頻出語 keyword sweep の結果。 案 (1) 比較用の別ファイル、 main DB には merge しない。',
    _keywords: KEYWORDS,
    callsigns: all,
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n', 'utf-8');
  const elapsed = Math.floor((Date.now() - started) / 1000);
  console.log(`Wrote ${all.length} entries to ${OUT}`);
  console.log(`Elapsed: ${Math.floor(elapsed / 60)}m ${elapsed % 60}s`);
}

run().catch((e) => {
  console.error('\nFAIL:', e);
  process.exit(1);
});
