import { lookupEibi } from './eibi.js';
import { lookupJpStation, formatJpStationLabel, type JpRegion } from './japanStations.js';

// Station-name auto-lookup priority:
//   1. jp-stations.json — auto-scraped 総務省 region tables (filtered by the
//      user's active region) + region-independent manualStations. Wins for FM
//      (EIBI has no entries above 30 MHz) and for MW (covers domestic
//      Japanese stations EIBI doesn't list, e.g. NHK R1 594 kHz).
//   2. EIBI — international SW + some MW DX entries with day/time-aware match.
//   3. (caller falls back to the user's preset name when both return null.)
//
// Extracted from spyDialTune so the status feed can label the frequency the
// same way the LCD does, instead of growing a second lookup order that would
// drift from it.
export function autoStationLabel(freqHz: number, activeRegion: JpRegion): string | null {
  const jp = lookupJpStation(freqHz, activeRegion);
  if (jp) return formatJpStationLabel(jp);
  if (freqHz >= 16_000 && freqHz <= 30_000_000) {
    const e = lookupEibi(freqHz);
    if (e) return e.name;
  }
  return null;
}
