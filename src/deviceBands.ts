// Receivable-frequency table per SpyServer deviceType. The protocol's
// minFrequency / maxFrequency only express a single contiguous range, so
// non-contiguous frontends like the Airspy HF+ (HF + VHF, with a 31–60 MHz
// gap) need a hard-coded list. Used by the VFO step path so dialing into a
// gap snaps to the next covered band instead of letting the user park on a
// physically unreceivable freq and hear noise.

import { DEVICE_AIRSPY_HF, DEVICE_AIRSPY_ONE, DEVICE_RTLSDR } from './spyClient.js';

export interface DeviceBand { lo: number; hi: number; }

// Airspy HF+ Discovery: HF 0.5–31 MHz + VHF 60–260 MHz, hardware gap 31–60 MHz.
const AIRSPY_HF_BANDS:  DeviceBand[] = [
  { lo:    500_000, hi:   31_000_000 },
  { lo: 60_000_000, hi:  260_000_000 },
];
// Airspy R2 / Mini: 24 MHz – 1.8 GHz contiguous.
const AIRSPY_ONE_BANDS: DeviceBand[] = [{ lo: 24_000_000, hi: 1_800_000_000 }];
// Rafael R820T-class RTL-SDR dongles: 24 MHz – 1.766 GHz typical.
const RTLSDR_BANDS:     DeviceBand[] = [{ lo: 24_000_000, hi: 1_766_000_000 }];

/**
 * Resolve the receivable-band list for a given SpyServer deviceType.
 * Falls back to the protocol-reported single (min, max) range when the
 * deviceType is unrecognised so a future device still gets at least a
 * one-band clamp instead of unbounded VFO.
 */
export function bandsForDevice(deviceType: number, fallbackMin?: number, fallbackMax?: number): DeviceBand[] {
  if (deviceType === DEVICE_AIRSPY_HF)  return AIRSPY_HF_BANDS;
  if (deviceType === DEVICE_AIRSPY_ONE) return AIRSPY_ONE_BANDS;
  if (deviceType === DEVICE_RTLSDR)     return RTLSDR_BANDS;
  if (typeof fallbackMin === 'number' && typeof fallbackMax === 'number' && fallbackMax > fallbackMin) {
    return [{ lo: fallbackMin, hi: fallbackMax }];
  }
  return [];
}

/** True iff hz lies inside any covered band. */
export function isCoveredFreq(hz: number, bands: DeviceBand[]): boolean {
  for (const b of bands) if (hz >= b.lo && hz <= b.hi) return true;
  return false;
}

/**
 * Snap hz to the closest covered freq in the requested direction.
 *   direction > 0 (CW dial)  : if hz is in a gap or below all bands, jump
 *                              UP to the next band's lo.
 *   direction < 0 (CCW dial) : if hz is in a gap or above all bands, jump
 *                              DOWN to the prev band's hi.
 *   direction === 0          : clamp to the nearest gap edge.
 * If hz already lies in a covered band, return as-is. Returns hz unchanged
 * when bands is empty (deviceInfo not yet known / unrecognised device).
 */
export function snapToCoveredFreq(hz: number, bands: DeviceBand[], direction: number): number {
  if (bands.length === 0) return hz;
  if (isCoveredFreq(hz, bands)) return hz;
  const sorted = bands.slice().sort((a, b) => a.lo - b.lo);
  // Below everything: clamp up to the first band's lo regardless of direction
  // (no covered freq exists below).
  if (hz < sorted[0].lo) return sorted[0].lo;
  // Above everything: clamp down to the last band's hi.
  const last = sorted[sorted.length - 1];
  if (hz > last.hi) return last.hi;
  // In a gap between two bands.
  for (let i = 0; i < sorted.length - 1; i++) {
    const cur = sorted[i], next = sorted[i + 1];
    if (hz > cur.hi && hz < next.lo) {
      if (direction > 0) return next.lo;
      if (direction < 0) return cur.hi;
      return (hz - cur.hi) <= (next.lo - hz) ? cur.hi : next.lo;
    }
  }
  return hz; // unreachable when bands list is well-formed
}
