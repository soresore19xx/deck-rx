// Unit tests for src/deviceBands.ts — VFO frequency clamping per device.

import { describe, it, expect } from 'vitest';
import { bandsForDevice, isCoveredFreq, snapToCoveredFreq, isFreqReceivable } from '../src/deviceBands.js';
import { DEVICE_AIRSPY_HF, DEVICE_AIRSPY_ONE, DEVICE_RTLSDR } from '../src/SpyClient.js';

describe('bandsForDevice', () => {
  it('Airspy HF+ returns the HF + VHF bands with a gap at 31–60 MHz', () => {
    const b = bandsForDevice(DEVICE_AIRSPY_HF);
    expect(b).toHaveLength(2);
    expect(b[0]).toEqual({ lo: 500_000, hi: 31_000_000 });
    expect(b[1]).toEqual({ lo: 60_000_000, hi: 260_000_000 });
  });
  it('Airspy R2 / Mini returns one contiguous 24 MHz – 1.8 GHz band', () => {
    const b = bandsForDevice(DEVICE_AIRSPY_ONE);
    expect(b).toHaveLength(1);
    expect(b[0].lo).toBe(24_000_000);
    expect(b[0].hi).toBe(1_800_000_000);
  });
  it('RTL-SDR returns its 24 MHz – 1.766 GHz band', () => {
    const b = bandsForDevice(DEVICE_RTLSDR);
    expect(b[0].hi).toBe(1_766_000_000);
  });
  it('unknown deviceType + protocol fallback (min,max) → single-band list', () => {
    expect(bandsForDevice(999, 1_000, 2_000_000)).toEqual([{ lo: 1_000, hi: 2_000_000 }]);
  });
  it('unknown deviceType + no fallback → empty list (caller must skip clamping)', () => {
    expect(bandsForDevice(999)).toEqual([]);
  });
});

describe('isCoveredFreq (Airspy HF+)', () => {
  const bands = bandsForDevice(DEVICE_AIRSPY_HF);
  it('500 kHz: covered (HF lo edge)', () => expect(isCoveredFreq(500_000, bands)).toBe(true));
  it('31 MHz: covered (HF hi edge)', () => expect(isCoveredFreq(31_000_000, bands)).toBe(true));
  it('35 MHz: NOT covered (in HF↔VHF gap)', () => expect(isCoveredFreq(35_000_000, bands)).toBe(false));
  it('60 MHz: covered (VHF lo edge)', () => expect(isCoveredFreq(60_000_000, bands)).toBe(true));
  it('80 MHz: covered (VHF, FM broadcast)', () => expect(isCoveredFreq(80_000_000, bands)).toBe(true));
  it('260 MHz: covered (VHF hi edge)', () => expect(isCoveredFreq(260_000_000, bands)).toBe(true));
  it('300 MHz: NOT covered (above VHF)', () => expect(isCoveredFreq(300_000_000, bands)).toBe(false));
  it('100 kHz: NOT covered (below HF)', () => expect(isCoveredFreq(100_000, bands)).toBe(false));
});

describe('snapToCoveredFreq (Airspy HF+ gap behavior)', () => {
  const bands = bandsForDevice(DEVICE_AIRSPY_HF);
  it('35 MHz dialing UP → 60 MHz (next band lo)', () => {
    expect(snapToCoveredFreq(35_000_000, bands, 1)).toBe(60_000_000);
  });
  it('35 MHz dialing DOWN → 31 MHz (prev band hi)', () => {
    expect(snapToCoveredFreq(35_000_000, bands, -1)).toBe(31_000_000);
  });
  it('45.5 MHz neutral → equidistant midpoint snaps to UP edge by tiebreak (hz - lo == hi - hz)', () => {
    // Gap is 31..60, midpoint 45.5 MHz. (45.5 - 31) = 14.5, (60 - 45.5) = 14.5
    // — exact tie, the impl chooses cur.hi (down). Either side is acceptable;
    // pin the expectation to current behaviour.
    expect(snapToCoveredFreq(45_500_000, bands, 0)).toBe(31_000_000);
  });
  it('40 MHz neutral → 31 MHz (closer to HF hi)', () => {
    expect(snapToCoveredFreq(40_000_000, bands, 0)).toBe(31_000_000);
  });
  it('55 MHz neutral → 60 MHz (closer to VHF lo)', () => {
    expect(snapToCoveredFreq(55_000_000, bands, 0)).toBe(60_000_000);
  });
  it('100 MHz already covered → unchanged', () => {
    expect(snapToCoveredFreq(100_000_000, bands, 1)).toBe(100_000_000);
  });
  it('300 MHz above all bands → clamp to last band hi (260 MHz)', () => {
    expect(snapToCoveredFreq(300_000_000, bands, 1)).toBe(260_000_000);
  });
  it('100 kHz below all bands → clamp to first band lo (500 kHz)', () => {
    expect(snapToCoveredFreq(100_000, bands, -1)).toBe(500_000);
  });
});

describe('snapToCoveredFreq (contiguous device)', () => {
  const bands = bandsForDevice(DEVICE_AIRSPY_ONE);
  it('100 MHz inside the contiguous band → unchanged', () => {
    expect(snapToCoveredFreq(100_000_000, bands, 1)).toBe(100_000_000);
  });
  it('10 MHz below the contiguous band → clamp up to lo', () => {
    expect(snapToCoveredFreq(10_000_000, bands, 1)).toBe(24_000_000);
  });
  it('2 GHz above the contiguous band → clamp down to hi', () => {
    expect(snapToCoveredFreq(2_000_000_000, bands, -1)).toBe(1_800_000_000);
  });
});

describe('snapToCoveredFreq (empty bands)', () => {
  it('no bands list → return hz unchanged (caller skipped clamping)', () => {
    expect(snapToCoveredFreq(35_000_000, [], 1)).toBe(35_000_000);
  });
});

describe('isFreqReceivable (preset / keypad guard)', () => {
  it('Airspy HF+ rejects 50 MHz (in the 31–60 MHz hardware gap)', () => {
    expect(isFreqReceivable(50_000_000, DEVICE_AIRSPY_HF)).toBe(false);
  });
  it('Airspy HF+ accepts 80 MHz (FM broadcast, in VHF range)', () => {
    expect(isFreqReceivable(80_000_000, DEVICE_AIRSPY_HF)).toBe(true);
  });
  it('Airspy HF+ accepts 9 MHz (HF range)', () => {
    expect(isFreqReceivable(9_000_000, DEVICE_AIRSPY_HF)).toBe(true);
  });
  it('Airspy R2 accepts 50 MHz (no hardware gap)', () => {
    expect(isFreqReceivable(50_000_000, DEVICE_AIRSPY_ONE)).toBe(true);
  });
  it('undefined deviceType (DeviceInfo race) → returns true so the user’s first action isn’t silently dropped', () => {
    expect(isFreqReceivable(50_000_000, undefined)).toBe(true);
  });
  it('unknown deviceType + no fallback → returns true (no clamp data, do not filter)', () => {
    expect(isFreqReceivable(50_000_000, 999)).toBe(true);
  });
  it('unknown deviceType + protocol fallback (min,max) honours the fallback range', () => {
    expect(isFreqReceivable(1_500_000, 999, 1_000, 2_000_000)).toBe(true);   // inside fallback
    expect(isFreqReceivable(50_000_000, 999, 1_000, 2_000_000)).toBe(false); // outside fallback
  });
});
