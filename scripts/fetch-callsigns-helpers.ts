/**
 * Helper for the validation mode of fetch-callsigns.ts: scrape only the FIRST
 * list page (100 entries) and walk those detail pages, instead of paginating
 * across all 7 list pages. Used to verify end-to-end before kicking off a
 * 25-minute full-band run.
 */

import {
  buildListUrl,
  buildDetailUrl,
  parseMusenListHtml,
  parseMusenDetailHtml,
  type MusenDetailEntry,
  type ScrapeOptions,
} from '../src/musenScraper.js';

const CHROME_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ja,en-US;q=0.7,en;q=0.3',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'same-origin',
  'Upgrade-Insecure-Requests': '1',
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function defaultFetch(url: string): Promise<string> {
  const res = await fetch(url, { headers: CHROME_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return res.text();
}

export async function scrapeOnePage(
  selectHSK: '03' | '04',
  opts: ScrapeOptions = {},
): Promise<MusenDetailEntry[]> {
  const fetchFn = opts.fetchFn ?? defaultFetch;
  const rateLimitMs = opts.rateLimitMs ?? 1000;
  const listHtml = await fetchFn(buildListUrl(selectHSK, 1));
  const entries = parseMusenListHtml(listHtml);
  const result: MusenDetailEntry[] = [];
  for (let i = 0; i < entries.length; i++) {
    await sleep(rateLimitMs);
    const html = await fetchFn(buildDetailUrl(entries[i].dfcd, entries[i].it));
    const detail = parseMusenDetailHtml(html);
    if (detail) result.push(detail);
    opts.onProgress?.(i + 1, entries.length);
  }
  return result;
}
