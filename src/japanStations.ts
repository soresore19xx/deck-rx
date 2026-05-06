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
  stations: JpStation[];
}

let stations: JpStation[] | null = null;

function load(): JpStation[] {
  if (stations) return stations;
  try {
    const raw = readFileSync(DATA_PATH, 'utf-8');
    const data = JSON.parse(raw) as JpStationFile;
    stations = (data.stations ?? []).filter(s => s.freqHz > 0 && s.name);
  } catch {
    stations = [];
  }
  return stations;
}

// Frequency match tolerances are chosen so the registered grid (0.1 MHz for FM,
// 9 kHz for MW) doesn't produce false negatives if the user tunes a few hundred
// Hz off — but tight enough that adjacent grid slots don't bleed into each other.
const FM_TOLERANCE_HZ = 50_000;   // 50 kHz; adjacent FM stations are 100 kHz apart
const MW_TOLERANCE_HZ = 4_000;    // 4 kHz; adjacent MW stations are 9 kHz apart

export function lookupJpStation(freqHz: number): JpStation | null {
  const band: JpBand | null =
    freqHz >= 76_000_000 && freqHz <= 108_000_000 ? 'FM' :
    freqHz >=    522_000 && freqHz <=   1_710_000 ? 'MW' :
    null;
  if (!band) return null;

  const tol = band === 'FM' ? FM_TOLERANCE_HZ : MW_TOLERANCE_HZ;
  let best: JpStation | null = null;
  let bestDelta = Infinity;
  for (const s of load()) {
    if (s.band !== band) continue;
    const d = Math.abs(s.freqHz - freqHz);
    if (d <= tol && d < bestDelta) {
      best = s;
      bestDelta = d;
    }
  }
  return best;
}

export function jpStationCount(): number {
  return load().length;
}
