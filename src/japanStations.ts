import { readFileSync } from 'fs';
import { join } from 'path';

declare const __dirname: string;

const DATA_PATH = join(__dirname, '..', 'data', 'jp-stations.json');

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
}

interface JpStationFile {
  // Auto-scraped from each 総合通信局 (PI Update Now button overwrites the
  // entries tagged with the currently-selected region; other regions stay).
  stations?: JpStation[];
  // Hand-curated. Never touched by the scraper. Used for stations the scraper
  // cannot see (NHK R2, AFN, MW DX targets outside any 関東 jurisdiction).
  manualStations?: JpStation[];
}

let stations: JpStation[] | null = null;
let manualStations: JpStation[] | null = null;

function load(): { auto: JpStation[]; manual: JpStation[] } {
  if (stations && manualStations) return { auto: stations, manual: manualStations };
  try {
    const raw = readFileSync(DATA_PATH, 'utf-8');
    const data = JSON.parse(raw) as JpStationFile;
    const valid = (s: JpStation) => s.freqHz > 0 && !!s.name;
    stations       = (data.stations       ?? []).filter(valid);
    manualStations = (data.manualStations ?? []).filter(valid);
  } catch {
    stations = [];
    manualStations = [];
  }
  return { auto: stations, manual: manualStations };
}

export function getJpStationsPath(): string {
  return DATA_PATH;
}

export function clearJpStationsCache(): void {
  stations = null;
  manualStations = null;
}

// Frequency match tolerances are chosen so the registered grid (0.1 MHz for FM,
// 9 kHz for MW) doesn't produce false negatives if the user tunes a few hundred
// Hz off — but tight enough that adjacent grid slots don't bleed into each other.
const FM_TOLERANCE_HZ = 50_000;   // 50 kHz; adjacent FM stations are 100 kHz apart
const MW_TOLERANCE_HZ = 4_000;    // 4 kHz; adjacent MW stations are 9 kHz apart

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
  const { auto, manual } = load();

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
  if (m && a) return m.delta <= a.delta ? m.entry : a.entry;
  return (m ?? a)?.entry ?? null;
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
