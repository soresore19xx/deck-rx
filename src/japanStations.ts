import { readFileSync } from 'fs';
import { join } from 'path';

declare const __dirname: string;

const DATA_PATH = join(__dirname, '..', 'data', 'jp-stations.json');

export type JpBand = 'FM' | 'MW';

export interface JpStation {
  freqHz: number;
  band: JpBand;
  name: string;
}

interface JpStationFile {
  // Auto-scraped from 関東総合通信局 (PI Update Now button overwrites this).
  stations?: JpStation[];
  // Hand-curated. Never touched by the scraper. Used for stations the scraper
  // cannot see (NHK R2, AFN, MW DX targets outside the 関東 jurisdiction).
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

export function lookupJpStation(freqHz: number): JpStation | null {
  const band: JpBand | null =
    freqHz >= 76_000_000 && freqHz <= 108_000_000 ? 'FM' :
    freqHz >=    522_000 && freqHz <=   1_710_000 ? 'MW' :
    null;
  if (!band) return null;

  const tol = band === 'FM' ? FM_TOLERANCE_HZ : MW_TOLERANCE_HZ;
  const { auto, manual } = load();

  // manualStations wins on freqHz collision — those entries are deliberate
  // hand-curated overrides (e.g. "NHKラジオ第2" at 693 vs the scraper's
  // generic "NHK" naming, or a DX target outside the 関東 jurisdiction).
  const m = scan(manual, freqHz, band, tol);
  const a = scan(auto,   freqHz, band, tol);
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
