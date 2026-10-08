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
// rises, plateaus, then falls. The lowest gain within a decibel of the best is
// kept — the plateau's low end has the most headroom against overload.
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
  const ch = measureChannel(mode);
  const n = bins.length;
  if (!ch || n < 64 || iqRate <= 0) return null;
  const hzPerBin = iqRate / n;
  const centre = centreOffsetHz + ch.offsetHz;
  const half = ch.widthHz / 2;
  // Stay off the decimation filter's skirts at the span edges.
  const edge = iqRate * 0.45;
  let sum = 0, count = 0;
  const floor: number[] = [];
  for (let i = 0; i < n; i++) {
    const f = (i - n / 2) * hzPerBin;
    if (Math.abs(f) > edge) continue;
    const d = Math.abs(f - centre);
    if (d <= half) { sum += Math.pow(10, bins[i] / 10); count++; }
    else if (d > half * 1.2 + hzPerBin) floor.push(bins[i]);
  }
  if (count < 1 || floor.length < 16) return null;
  floor.sort((a, b) => a - b);
  const floorDb = floor[floor.length >> 1];
  return 10 * Math.log10(sum / count) - floorDb;
}

/** The lowest gain whose C/N is within `toleranceDb` of the best. */
export function pickGain(results: Array<{ gain: number; cn: number }>, toleranceDb = 1): number | null {
  if (results.length === 0) return null;
  const best = Math.max(...results.map(r => r.cn));
  const ok = results.filter(r => r.cn >= best - toleranceDb).map(r => r.gain);
  return Math.min(...ok);
}

/** Key for the remembered gain: receiver, channel to 100 Hz, demod mode. */
export function gainMemoryKey(devKey: string, freqHz: number, mode: number): string {
  return `${devKey}|${Math.round(freqHz / 100) * 100}|${mode}`;
}
