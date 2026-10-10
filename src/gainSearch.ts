// Automatic RF gain: try a handful of gain indices on a station, keep the one
// with the best carrier-to-noise, and remember it per receiver and channel.
//
// Why: one gain per receiver and band cannot serve both ends of FM broadcast
// on the V4 — high enough for a neighbouring prefecture's 79.5 MHz overloads
// the strong Tokyo stations, low enough for those loses 79.5 (user,
// 2026-10-08). Software cannot repair an overloaded or noise-buried signal
// after the ADC, but it can choose the gain before it.
//
// The measure is C/N from one spectrum: mean power inside the channel against
// the median bin outside it. Too little gain and the receiver's own noise sets
// the floor; too much and overload raises it (and intermod fills it), so C/N
// rises, plateaus, then falls. The gain kept is where the plateau starts —
// the step after which the floor rises along with the signal (pickGain) —
// which also has the most headroom against overload.
//
// Pure: spyService (and the Swift port) drive the receiver and feed spectra in.

/** Channel used for the measurement, per demod mode (0 NFM 1 WFM 2 AM 3 DSB
 *  4 USB 5 CW 6 LSB 7 RAW): centre offset from the tuned frequency and width.
 *  Fixed rather than the demod's own filter settings, so a narrowed AM filter
 *  does not change which gain is chosen. */
export function measureChannel(mode: number): { offsetHz: number; widthHz: number } | null {
  switch (mode) {
    case 0: return { offsetHz: 0, widthHz: 12_500 };
    case 1: return { offsetHz: 0, widthHz: 180_000 };
    case 2: case 3: return { offsetHz: 0, widthHz: 9_000 };
    case 4: return { offsetHz: 1_500, widthHz: 3_000 };
    case 6: return { offsetHz: -1_500, widthHz: 3_000 };
    case 5: return { offsetHz: 0, widthHz: 500 };
    default: return null;      // RAW: nothing to demodulate, nothing to judge
  }
}

/** The coarse pass: about six points spread over 0..maxGain, ends included.
 *  HF+ (8) → 0 2 4 6 8 … V4 (29) → 0 6 12 18 24 29. */
export function coarseGains(maxGain: number): number[] {
  if (maxGain <= 0) return [0];
  const step = Math.max(1, Math.round(maxGain / 5));
  const out: number[] = [];
  for (let g = 0; g < maxGain; g += step) out.push(g);
  out.push(maxGain);
  return [...new Set(out)];
}

/** The refining pass: the midpoints either side of the best coarse point. */
export function refineGains(best: number, maxGain: number, coarse: number[]): number[] {
  const step = coarse.length > 1 ? coarse[1] - coarse[0] : 1;
  const half = Math.floor(step / 2);
  if (half < 1) return [];
  return [best - half, best + half]
    .filter(g => g >= 0 && g <= maxGain && !coarse.includes(g));
}

/**
 * C/N in dB from one fftshift'd dBFS spectrum (bin N/2 = the IQ centre).
 * `centreOffsetHz` is where the tuned frequency sits relative to the IQ
 * centre (non-zero when the receiver tunes with a VFO offset). Null when the
 * channel or the floor has too few bins to mean anything.
 */
export function channelCnDb(bins: ArrayLike<number>, iqRate: number,
                            centreOffsetHz: number, mode: number): number | null {
  return channelLevels(bins, iqRate, centreOffsetHz, mode)?.cn ?? null;
}

/** Modes whose signal reference is the strongest bin in the channel (the
 *  carrier) rather than the channel's mean: AM, DSB, CW. A carrier's level
 *  stands still under modulation; the mean of a 9 kHz AM channel over 60 ms
 *  moves by decibels with what is being said. */
function hasCarrier(mode: number): boolean { return mode === 2 || mode === 3 || mode === 5; }

/**
 * The channel's levels from one spectrum: `cn` as channelCnDb, `signalDb` (the
 * carrier for AM / DSB / CW, the channel mean otherwise) and `floorDb` (the
 * median bin outside the channel), both dBFS. pickGain compares how far each
 * moves between two gains.
 */
export function channelLevels(bins: ArrayLike<number>, iqRate: number,
                              centreOffsetHz: number, mode: number):
    { cn: number; signalDb: number; floorDb: number } | null {
  const ch = measureChannel(mode);
  const n = bins.length;
  if (!ch || n < 64 || iqRate <= 0) return null;
  const hzPerBin = iqRate / n;
  const centre = centreOffsetHz + ch.offsetHz;
  const half = ch.widthHz / 2;
  // Stay off the decimation filter's skirts at the span edges.
  const edge = iqRate * 0.45;
  let sum = 0, count = 0, top = -Infinity;
  const floor: number[] = [];
  for (let i = 0; i < n; i++) {
    const f = (i - n / 2) * hzPerBin;
    if (Math.abs(f) > edge) continue;
    const d = Math.abs(f - centre);
    if (d <= half) { sum += Math.pow(10, bins[i] / 10); count++; if (bins[i] > top) top = bins[i]; }
    else if (d > half * 1.2 + hzPerBin) floor.push(bins[i]);
  }
  if (count < 1 || floor.length < 16) return null;
  floor.sort((a, b) => a - b);
  const floorDb = floor[floor.length >> 1];
  const meanDb = 10 * Math.log10(sum / count);
  return { cn: meanDb - floorDb, signalDb: hasCarrier(mode) ? top : meanDb, floorDb };
}

/** IQ peak allowed at the chosen gain. C/N peaks on the step just below the
 *  one that overloads, so the best-C/N gain sits at the edge: on the V4
 *  90.5 MHz peaked at -1.7 dBFS and 82.5 MHz at -0.3 on the gains C/N chose
 *  (2026-10-09), one step under 1-7 % of samples at full scale. A strong
 *  station's level moves with fading and the rest of the band, so keep 6 dB. */
export const GAIN_MAX_PEAK_DBFS = -6;

/** Below this best C/N there is no station to judge by (V4 92.4 MHz read
 *  0.6-1.2 dB at every gain and the search filed 0, 2026-10-09). Then nothing
 *  is chosen and the band's gain stays. */
export const GAIN_MIN_CN_DB = 6;

/** A step up is worth taking while the floor rises by less than this share
 *  of what the signal rose by. At a half, the noise arriving from the antenna
 *  already matches the receiver's own; past it, more gain lifts the floor
 *  with the signal and buys at most a decibel or two of C/N. */
export const GAIN_FLOOR_RISE_SHARE = 0.5;

export interface GainResult { gain: number; cn: number; peakDb?: number;
                              signalDb?: number; floorDb?: number }

/**
 * The gain to keep. Among the gains whose IQ peak leaves the headroom, climb
 * from the lowest and stop at the first step where the floor rises by
 * GAIN_FLOOR_RISE_SHARE or more of the signal's rise, or the signal stops
 * rising — the noise is then the antenna's, not the receiver's, and more gain
 * only lifts the floor. Until the station stands GAIN_MIN_CN_DB clear of the
 * floor, any step that improves C/N is taken.
 *
 * The rule before this one took the lowest gain within `toleranceDb` of the
 * best C/N, and is still what runs when a result carries no signal/floor
 * levels. It chose 24-26 on medium-wave stations where 6-12 gave the same
 * C/N: one 60 ms measure of an AM channel moves by decibels with the
 * programme, so the "best" was whichever high gain caught a loud moment, and
 * the floor stood 15-20 dB higher for nothing (user, 2026-10-10).
 *
 * If no gain leaves the headroom, the lowest gain tried. null when nothing
 * was measured or no gain shows a station at all.
 */
export function pickGain(results: GainResult[],
                         toleranceDb = 1, maxPeakDb = GAIN_MAX_PEAK_DBFS): number | null {
  if (results.length === 0) return null;
  if (Math.max(...results.map(r => r.cn)) < GAIN_MIN_CN_DB) return null;
  const clean = results.filter(r => r.peakDb === undefined || r.peakDb <= maxPeakDb);
  if (clean.length === 0) return Math.min(...results.map(r => r.gain));
  if (clean.some(r => r.signalDb === undefined || r.floorDb === undefined)) {
    const best = Math.max(...clean.map(r => r.cn));
    const ok = clean.filter(r => r.cn >= best - toleranceDb).map(r => r.gain);
    return Math.min(...ok);
  }
  const up = [...clean].sort((a, b) => a.gain - b.gain);
  let at = up[0];
  for (const next of up.slice(1)) {
    if (at.cn < GAIN_MIN_CN_DB) {
      if (next.cn > at.cn) { at = next; continue; }
      break;
    }
    const dSignal = next.signalDb! - at.signalDb!;
    const dFloor = next.floorDb! - at.floorDb!;
    if (dSignal <= 0 || dFloor >= GAIN_FLOOR_RISE_SHARE * dSignal) break;
    at = next;
  }
  return at.gain;
}

/** Key for the remembered gain: receiver, channel to 100 Hz, demod mode. */
export function gainMemoryKey(devKey: string, freqHz: number, mode: number): string {
  return `${devKey}|${Math.round(freqHz / 100) * 100}|${mode}`;
}
