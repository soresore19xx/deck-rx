import { readFileSync } from 'fs';
import { join } from 'path';

declare const __dirname: string;

// Path defaults to the bundled location (relative to bin/index.js after rollup).
// Overridable via DECK_RX_JP_STATIONS_PATH so the unit-test harness can point
// the loader at test/fixtures/ or another snapshot without touching prod state.
// Resolved per-call (mirroring presets.ts) so unit tests can flip
// DECK_RX_JP_STATIONS_PATH after module load — the previous module-init
// const captured the env at import time, defeating test isolation.
function dataPath(): string {
  return process.env.DECK_RX_JP_STATIONS_PATH ?? join(__dirname, '..', 'data', 'jp-stations.json');
}

export type JpBand = 'FM' | 'MW';

// JP DB regions. Each station scraped from a regional 総合通信局 page is
// tagged with its region; lookup filters the auto-scraped pool by the user's
// selected region so e.g. 90.5 MHz in 関東 doesn't surface 北海道's same-
// frequency relay station. `manualStations` entries are NOT region-tagged —
// they're consulted regardless of the active region (cross-region DX
// targets, AFN, NHK R2 hand-curated overrides, etc.).
export type JpRegion = 'kanto' | 'hokkaido' | 'tohoku' | 'tokai' | 'kinki' | 'chugoku' | 'kyushu' | 'okinawa';
export const JP_REGIONS: readonly JpRegion[] = ['kanto', 'hokkaido', 'tohoku', 'tokai', 'kinki', 'chugoku', 'kyushu', 'okinawa'];
export const JP_REGION_LABELS: Record<JpRegion, string> = {
  kanto: '関東',
  hokkaido: '北海道',
  tohoku: '東北',
  tokai: '東海',
  kinki: '近畿',
  chugoku: '中国',
  kyushu: '九州',
  okinawa: '沖縄',
};

export function isJpRegion(s: unknown): s is JpRegion {
  return typeof s === 'string' && (JP_REGIONS as readonly string[]).includes(s);
}

export interface JpStation {
  freqHz: number;
  band: JpBand;
  name: string;
  region?: JpRegion;  // undefined for manualStations (always consulted, region-independent)
  // Optional 送信地 (transmission site) annotation, scraped from the
  // parenthesised suffix in the 関東総合通信局 / 沖縄総通局 freq cells —
  // e.g. "594kHz(東京)" → siteName: "東京". Multiple physical relay sites
  // separated by 、 / ・ are kept verbatim ("父島、母島" / "東京・墨田").
  // Older jp-stations.json entries without this field still load fine.
  siteName?: string;
  // Optional 識別信号 (callsign), e.g. "JOAK" for NHK第1 東京 / "JOLF" for
  // ニッポン放送. Sourced from 総務省「無線局等情報検索」 (公共データ利用規約
  // 第1.0版, https://www.tele.soumu.go.jp/musen/) via scripts/fetch-callsigns.ts
  // and merged into the live data file. Some licensed transmitters (予備設備
  // 等) carry no callsign in the source — those entries simply omit this field.
  callsign?: string;
}

/**
 * Render a station for the dial header. Three transformations on top of the
 * raw `name`:
 *
 *   1. Channel inference for NHK — post-2025-03 NHKラジオ第2 closure, every
 *      surviving NHK MW transmitter is NHK第1; every NHK FM is NHK-FM. The
 *      scraped 法人名 is just "NHK" (alias of 日本放送協会), which would
 *      otherwise leave 33+ entries indistinguishable. We only special-case
 *      the canonical bare "NHK" — manual entries that explicitly say e.g.
 *      "NHKラジオ第2" pass through unchanged.
 *   2. Callsign infix — when callsign is present we insert it between the
 *      name (or channel-resolved name) and the site: "NHK第1 JOAK (東京)".
 *      Without callsign the name + site form is unchanged.
 *   3. Site annotation — when siteName is present we append it in
 *      half-width parens: "TOKYO FM" + "東京" → "TOKYO FM (東京)". Empty /
 *      missing siteName falls through to bare name.
 *
 * Width: long names + callsign + " (site)" can exceed the 200 px header but
 * `makeHeaderSvg` already auto-shrinks (14 → 12 → spacingAndGlyphs squeeze),
 * so callers don't need to pre-clip.
 */
export function formatJpStationLabel(s: JpStation): string {
  let name = s.name;
  if (name === 'NHK') {
    name = s.band === 'MW' ? 'NHK第1' : 'NHK-FM';
  }
  if (s.callsign) name = `${name} ${s.callsign}`;
  return s.siteName ? `${name} (${s.siteName})` : name;
}

interface JpStationFile {
  // Auto-scraped from each 総合通信局 (PI Update Now button overwrites the
  // entries tagged with the currently-selected region; other regions stay).
  stations?: JpStation[];
  // Hand-curated. Never touched by the scraper. Used for stations the scraper
  // cannot see (NHK R2, AFN, MW DX targets outside any 関東 jurisdiction).
  manualStations?: JpStation[];
}

// Sidecar callsign DB sourced from 総務省「無線局等情報検索」 via
// scripts/fetch-callsigns.ts. Stored as a separate file so a re-fetch
// (~50 min, 公共データ利用規約 第1.0版 準拠) does not disturb the curated
// stations / manualStations data, and the join (freqHz match) happens at
// lookup time.
interface CallsignFile {
  callsigns?: Array<{
    freqHz: number;
    band: 'FM' | 'MW';
    callsign: string;
    location: string;
    operatorName: string;
  }>;
}

function callsignsPath(): string {
  return process.env.DECK_RX_CALLSIGNS_PATH
    ?? join(__dirname, '..', 'data', 'callsigns.json');
}

let stations: JpStation[] | null = null;
let manualStations: JpStation[] | null = null;
let callsigns: CallsignFile['callsigns'] | null = null;

function load(): { auto: JpStation[]; manual: JpStation[]; cs: NonNullable<CallsignFile['callsigns']> } {
  if (stations && manualStations && callsigns) return { auto: stations, manual: manualStations, cs: callsigns };
  try {
    const raw = readFileSync(dataPath(), 'utf-8');
    const data = JSON.parse(raw) as JpStationFile;
    const valid = (s: JpStation) => s.freqHz > 0 && !!s.name;
    stations       = (data.stations       ?? []).filter(valid);
    manualStations = (data.manualStations ?? []).filter(valid);
  } catch {
    stations = [];
    manualStations = [];
  }
  try {
    const raw = readFileSync(callsignsPath(), 'utf-8');
    const data = JSON.parse(raw) as CallsignFile;
    callsigns = (data.callsigns ?? []).filter(c => c.freqHz > 0 && !!c.callsign);
  } catch {
    callsigns = [];
  }
  return { auto: stations, manual: manualStations, cs: callsigns };
}

// Find the closest 総務省 callsign entry within the same tolerance the
// station scan uses (MW 500 Hz / FM 5 kHz). Multiple licensed transmitters
// can sit on the same nominal freq across regions, so we pick the smallest
// delta and ignore region — the caller (lookupJpStation) has already
// resolved a single region-correct station entry.
function findCallsign(freqHz: number, band: 'FM' | 'MW', list: NonNullable<CallsignFile['callsigns']>): string | undefined {
  const tol = band === 'FM' ? FM_TOLERANCE_HZ : MW_TOLERANCE_HZ;
  let best: string | undefined;
  let bestDelta = Infinity;
  for (const c of list) {
    if (c.band !== band) continue;
    const d = Math.abs(c.freqHz - freqHz);
    if (d <= tol && d < bestDelta) { best = c.callsign; bestDelta = d; }
  }
  return best;
}

export function getJpStationsPath(): string {
  return dataPath();
}

export function clearJpStationsCache(): void {
  stations = null;
  manualStations = null;
}

// Frequency match tolerances are chosen so the registered grid (0.1 MHz for FM,
// 9 kHz for MW) doesn't produce false negatives if the user tunes a few hundred
// Hz off — but tight enough that adjacent grid slots don't bleed into each other.
// Lookup tolerance windows. These exist to absorb integer-rounding error
// at the source (jp-stations.json) vs. SpyServer's setFrequency echo and
// nothing more — they should NOT be wide enough to match a freq the user
// is genuinely off-channel from. Earlier values (MW 4 kHz, FM 50 kHz) were
// half-channel-grid permissive: tuning 590 kHz (4 kHz off NHK東京 594)
// would still surface "NHK", giving a false on-channel impression while
// the carrier is too far off to actually receive. The narrower windows
// below mean only freqs the dial actually lands on (1 kHz / 100 kHz step
// grid for MW / FM) match.
const FM_TOLERANCE_HZ =  5_000;   // 5 kHz; well inside the 100 kHz channel grid
const MW_TOLERANCE_HZ =    500;   // 500 Hz; absorbs float drift, no adjacent match

// Scan one station list for the closest match within tolerance.
function scan(list: JpStation[], freqHz: number, band: JpBand, tol: number): { entry: JpStation; delta: number } | null {
  let best: JpStation | null = null;
  let bestDelta = Infinity;
  for (const s of list) {
    if (s.band !== band) continue;
    const d = Math.abs(s.freqHz - freqHz);
    if (d <= tol && d < bestDelta) {
      best = s;
      bestDelta = d;
    }
  }
  return best ? { entry: best, delta: bestDelta } : null;
}

export function lookupJpStation(freqHz: number, activeRegion?: JpRegion): JpStation | null {
  const band: JpBand | null =
    freqHz >= 76_000_000 && freqHz <= 108_000_000 ? 'FM' :
    freqHz >=    522_000 && freqHz <=   1_710_000 ? 'MW' :
    null;
  if (!band) return null;

  const tol = band === 'FM' ? FM_TOLERANCE_HZ : MW_TOLERANCE_HZ;
  const { auto, manual, cs } = load();

  // Region filter: when activeRegion is supplied, both auto and manual pools
  // are filtered to entries tagged with that region. Untagged entries (no
  // region field) are kept — those are treated as truly global (e.g. a
  // future entry that should hit regardless of which region the user
  // selected). The asymmetry of the old design (manual = always global)
  // caused 近畿 ABCラジオ etc. to leak into 関東 lookups; this filter fixes
  // that while still allowing intentional global entries via untagged rows.
  const inRegion = (s: JpStation): boolean =>
    !activeRegion || !s.region || s.region === activeRegion;
  const filteredAuto   = auto.filter(inRegion);
  const filteredManual = manual.filter(inRegion);

  // manualStations wins on freqHz collision — those entries are deliberate
  // hand-curated overrides (e.g. "NHKラジオ第2" at 693 vs the scraper's
  // generic "NHK" naming).
  const m = scan(filteredManual, freqHz, band, tol);
  const a = scan(filteredAuto,   freqHz, band, tol);
  let best: JpStation | null = null;
  if (m && a) best = m.delta <= a.delta ? m.entry : a.entry;
  else best = (m ?? a)?.entry ?? null;
  if (!best) return null;
  // Annotate with callsign from the sidecar 総務省 DB if not already set.
  // Manually-curated entries that already carry a callsign keep theirs.
  if (!best.callsign) {
    const cscall = findCallsign(freqHz, band, cs);
    if (cscall) best = { ...best, callsign: cscall };
  }
  return best;
}

export function jpStationCount(): number {
  const { auto, manual } = load();
  return auto.length + manual.length;
}

export function jpStationCountAuto(): number {
  return load().auto.length;
}

export function jpStationCountForRegion(region: JpRegion): number {
  return load().auto.filter(s => s.region === region).length;
}

export function jpStationCountManual(): number {
  return load().manual.length;
}

/**
 * Bulk fetch every entry tagged for `region`. Used by the preset list to
 * surface JP DB stations alongside the user's SDR++ bookmarks (region
 * matches: auto entries with the exact tag + manual entries that are either
 * tagged for the same region or untagged = truly global).
 */
export function getJpStationsForRegion(region: JpRegion): JpStation[] {
  const { auto, manual } = load();
  return [
    ...auto.filter(s => s.region === region),
    ...manual.filter(s => !s.region || s.region === region),
  ];
}
