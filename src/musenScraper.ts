/**
 * 総務省 無線局等情報検索 (https://www.tele.soumu.go.jp/musen/) を出典に
 * 放送局の callsign (識別信号) + 設置場所 + 周波数 + 法人名を一括取得する
 * scraper モジュール。
 *
 * 出典: 総務省「無線局等情報検索」 (https://www.tele.soumu.go.jp/musen/)
 * 当データは「公共データ利用規約 (第1.0版)」に準拠して利用しています。
 *   - https://www.soumu.go.jp/menu_kyotsuu/policy/tyosaku.html
 *
 * 利用条件:
 *   - 出典明記必須 (本コメント + README + jp-stations.json の `_source` フィールド)
 *   - 編集・加工した場合は加工した旨を明記 (callsigns.json は raw 抽出 + 我々の
 *     freqHz / band 正規化を含む)
 *   - 第三者の権利侵害にあたる用途には使用しない (放送局の公開情報のみ取得)
 *
 * 取得対象:
 *   - SelectHSK=03  AM・短波 放送 (中波・短波)
 *   - SelectHSK=04  超短波 放送 (FM)
 *
 * 各取得 entry は detail page から以下を抽出:
 *   - 識別信号 (例: JOAK)
 *   - 周波数 (例: 594 kHz)
 *   - 無線設備の設置場所 (例: 東京都港区)
 *   - 免許人の氏名又は名称 (例: 日本放送協会)
 *
 * Rate limit: 1 req/sec (sequential, courtesy delay)。 700 局スケールで 12-15 分。
 */

import { parse, HTMLElement } from 'node-html-parser';

// CloudFront WAF が plain User-Agent を弾くため、 詳細ページ取得時は
// Chrome 風の Accept / Sec-Fetch-* / Accept-Language / UA 一式が必須。
// 抜くと CloudFront が "Error from cloudfront" を返して 403 になる。
const CHROME_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ja,en-US;q=0.7,en;q=0.3',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'same-origin',
  'Upgrade-Insecure-Requests': '1',
};

const BASE = 'https://www.tele.soumu.go.jp/musen/SearchServlet';

// 検索結果ページ URL を組み立てる。
//   selectHSK: '03' = AM/SW, '04' = FM
//   sc: 検索結果オフセット (1, 101, 201, ...)
//   dc: 1 ページあたりの件数 (固定 100 が最大)
export function buildListUrl(selectHSK: '03' | '04', sc: number, dc = 100): string {
  return `${BASE}?SK=2&DC=${dc}&SC=${sc}&pageID=3&CONFIRM=0&SelectID=2&SelectHSK=${selectHSK}&MK=BBC`;
}

// detail page の URL は list page の <a class="m-link" href="..."> から
// 取り出した DFCD + IT を直接埋め込む。 IT はエントリごとに 'I' / 'J' /
// その他があり、 list anchor の href にしか書かれていない (固定値ではない)。
// IT 違いを叩くと 「詳細画面を表示できません」 / 「システムエラー」 で blocked。
export function buildDetailUrl(dfcd: string, it: string): string {
  return `${BASE}?pageID=4&IT=${it}&DFCD=${dfcd}&DD=1&styleNumber=01`;
}

export interface MusenListEntry {
  /** 詳細ページ識別子 (10桁ゼロ埋め数字、例 "0000008760") */
  dfcd: string;
  /** detail URL の IT 値 (例 'I', 'J') — anchor href から抽出 */
  it: string;
  /** 法人名 (cleanOperatorName を通す前の生文字列) */
  rawName: string;
  /** 都道府県市町村 (例 "北海道函館市") */
  prefecture: string;
}

/**
 * 検索結果ページから (DFCD + 名称 + 都道府県) のタプル配列を抽出する。
 * 1 ページに最大 100 件、 全件取得時は SC=1, 101, 201... と回す。
 */
export function parseMusenListHtml(html: string): MusenListEntry[] {
  const root = parse(html);
  const out: MusenListEntry[] = [];
  // 各局は <table> 内の <tr> で 1 行、 1 列目に <a class="m-link"> が入る。
  for (const a of root.querySelectorAll('a.m-link')) {
    const href = a.getAttribute('href') ?? '';
    const dm = /[?&]DFCD=(\d+)/.exec(href);
    const itm = /[?&]IT=([A-Z])/.exec(href);
    if (!dm || !itm) continue;
    const dfcd = dm[1];
    const it = itm[1];
    const rawName = a.text.trim();
    if (!rawName) continue;
    // 都道府県は同じ <tr> 内の次の <td>。 a の親を辿って tr を取る。
    let tr: HTMLElement | null = a.parentNode as HTMLElement | null;
    while (tr && tr.tagName !== 'TR') tr = tr.parentNode as HTMLElement | null;
    let prefecture = '';
    if (tr) {
      const tds = tr.querySelectorAll('td');
      // tds[0] = 名称セル (anchor 入り), tds[1] = 都道府県セル
      if (tds.length >= 2) {
        prefecture = tds[1].text.trim();
      }
    }
    out.push({ dfcd, it, rawName, prefecture });
  }
  return out;
}

export interface MusenDetailEntry {
  callsign: string;
  freqHz: number;
  band: 'FM' | 'MW';
  location: string;
  operatorName: string;
}

// detail page のフィールド抽出。 ラベルは <td id="deftd"> で (h ではない)、
// 値の格納場所は 2 パターンある:
//
//   (A) 同 <tr> 内の隣接 <td> に値:
//         <tr><td id="deftd">識別信号</td><td colspan="3">***** JOWN</td></tr>
//       label 側 td が colspan="4" でない場合に該当 (識別信号 / 免許人の氏名)
//
//   (B) ラベル <td colspan="4"> + 次 <tr> の <td colspan="4"> に値:
//         <tr><td id="deftd" colspan="4">無線設備の設置場所</td></tr>
//         <tr><td colspan="4">北海道函館市</td></tr>
//       label が単独行で width 全幅を取る場合 (設置場所 / 電波の型式)
//
// 両パターン対応するため、 ラベル td を見つけたら同 tr に他の td があるか
// 確認 → 無ければ次 tr の td を採用する流れ。
function extractDetailField(root: HTMLElement, labelText: string): string {
  for (const td of root.querySelectorAll('td')) {
    if (td.text.trim() !== labelText) continue;
    const tr = td.parentNode as HTMLElement | null;
    if (!tr) continue;
    const tds = tr.querySelectorAll('td');
    // 同 tr 内に複数 td → Pattern A: 末尾 td が値 (label 自身を除く)
    if (tds.length >= 2) {
      const valueTd = tds[tds.length - 1];
      if (valueTd !== td) return valueTd.text.replace(/\s+/g, ' ').trim();
    }
    // Pattern B: 次の <tr> の最初の td が値
    let nextTr = tr.nextElementSibling as HTMLElement | null;
    while (nextTr && nextTr.tagName !== 'TR') {
      nextTr = nextTr.nextElementSibling as HTMLElement | null;
    }
    if (nextTr) {
      const nextTd = nextTr.querySelector('td');
      if (nextTd) return nextTd.text.replace(/\s+/g, ' ').trim();
    }
  }
  return '';
}

/**
 * 詳細ページから (callsign + freq + 設置場所 + 法人名) を抽出。
 * 失敗時 (パース不能 / 必須フィールド欠落) は null を返す。
 *
 * 識別信号フィールドは免許番号がマスクされた行と callsign 行が混在し、
 * 順序は局によって異なる ("***** JOWN" / "JOVK *****")。 callsign 形は
 * 日本の放送局 = J[A-Z]{2,4} + optional "-FM" 等のサフィックス、 これを
 * 先頭から (順序非依存に) 1 件抽出する。
 *
 * 周波数フィールドは "A3E&nbsp;&nbsp;...&nbsp;639&nbsp;kHz" のように
 * 電波の型式 (A3E / F8E 等) + 周波数 + 空中線電力 が混在。 数値 + 単位を
 * 抽出して Hz 化する。 範囲表記 ("87.0〜108.0 MHz" 等) は 1 件目を取る。
 */
export function parseMusenDetailHtml(html: string): MusenDetailEntry | null {
  const root = parse(html);
  const callsignRaw = extractDetailField(root, '識別信号');
  // 日本の放送局 callsign 形 "J" + 2-4 letters + optional "-FM"/"-DTV" 等。
  // 文字列内の出現位置 (先頭 / 末尾 / 中間) は局により違うので最初の合致を採る。
  const csMatch = /\b(J[A-Z]{2,4}(?:-[A-Z]+)?)\b/.exec(callsignRaw);
  const callsign = csMatch?.[1] ?? '';
  const operatorName = extractDetailField(root, '免許人の氏名又は名称');
  const location = extractDetailField(root, '無線設備の設置場所');
  const freqField = extractDetailField(root, '電波の型式、周波数及び空中線電力');
  // 周波数 + 単位 のペアを探す (型式・出力ノイズを跨いで先頭の (数値,単位) を採用)
  const freqMatch = /(\d+(?:\.\d+)?)\s*(kHz|MHz)/.exec(freqField);
  if (!callsign || !freqMatch || !operatorName) return null;
  const value = parseFloat(freqMatch[1]);
  const unit = freqMatch[2];
  const freqHz = unit === 'MHz' ? Math.round(value * 1_000_000) : Math.round(value * 1_000);
  // band 判定: MW = 522-1710 kHz, FM = 76-108 MHz。 短波放送 (Radio Nikkei
  // 等) は 'MW' に丸めずに null 返却で除外 — 当 plugin は MW + FM のみ扱う。
  let band: 'FM' | 'MW';
  if (freqHz >= 76_000_000 && freqHz <= 108_000_000) band = 'FM';
  else if (freqHz >= 500_000 && freqHz <= 1_710_000) band = 'MW';
  else return null;
  return {
    callsign,
    freqHz,
    band,
    location,
    operatorName,
  };
}

/**
 * 検索結果ページ全件 (paginate) → detail page を順次 fetch して callsign DB
 * を構築する。 以下のオプションでカスタマイズ:
 *   - rateLimitMs: detail fetch 間隔 (default 1000ms = 1 req/sec)
 *   - onProgress: 進捗 callback (取得済件数 + 総件数)
 *   - fetchFn: 単体 fetch 関数を差し替え可 (test fixture / mock 用)
 *
 * 出力は MusenDetailEntry の配列。 並びは取得順 (北海道 → 沖縄)。
 */
export interface ScrapeOptions {
  rateLimitMs?: number;
  onProgress?: (done: number, total: number) => void;
  fetchFn?: (url: string) => Promise<string>;
}

async function defaultFetch(url: string): Promise<string> {
  const res = await fetch(url, { headers: CHROME_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return res.text();
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export async function scrapeMusenBroadcasts(selectHSK: '03' | '04', opts: ScrapeOptions = {}): Promise<MusenDetailEntry[]> {
  const fetchFn = opts.fetchFn ?? defaultFetch;
  const rateLimitMs = opts.rateLimitMs ?? 1000;
  // Step 1: 1 ページ目を引いて全件数を確認する。 検索結果ページ冒頭の
  // "1 〜 100 / 621" の "/ <total>" から total を読む。
  const firstHtml = await fetchFn(buildListUrl(selectHSK, 1));
  // Result page header format: "全 2306 件中 1 - 100 件を表示". Normalise
  // whitespace before regex so &nbsp; / line breaks don't trip us up.
  const normalised = firstHtml.replace(/\s+/g, ' ');
  const totalMatch = /全\s*([\d,]+)\s*件中/.exec(normalised);
  const total = totalMatch ? parseInt(totalMatch[1].replace(/,/g, ''), 10) : 0;
  if (total === 0) throw new Error('Failed to read total count from list page header');
  // Step 2: ページごとに DFCD を集める。
  const allEntries: MusenListEntry[] = [...parseMusenListHtml(firstHtml)];
  const PAGE_SIZE = 100;
  for (let sc = PAGE_SIZE + 1; sc <= total; sc += PAGE_SIZE) {
    await sleep(rateLimitMs);
    const html = await fetchFn(buildListUrl(selectHSK, sc));
    allEntries.push(...parseMusenListHtml(html));
  }
  // Step 3: 各 DFCD の detail page を fetch。 IT は entry ごと固有。
  const result: MusenDetailEntry[] = [];
  for (let i = 0; i < allEntries.length; i++) {
    await sleep(rateLimitMs);
    const html = await fetchFn(buildDetailUrl(allEntries[i].dfcd, allEntries[i].it));
    const detail = parseMusenDetailHtml(html);
    if (detail) result.push(detail);
    opts.onProgress?.(i + 1, allEntries.length);
  }
  return result;
}
