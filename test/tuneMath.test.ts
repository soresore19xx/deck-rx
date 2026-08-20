// Unit tests for src/tuneMath.ts — the VFO step math shared by the Tune dial
// and the local control server. These pin the behaviour the dial had inline
// before the extraction, so a future control-server change can't quietly
// re-tune how the Stream Deck+ dial steps.

import { describe, it, expect } from 'vitest';
import { nextFreqForTicks, nextPresetSlot } from '../src/tuneMath.js';
import { DEVICE_AIRSPY_HF, DEVICE_AIRSPY_ONE, type DeviceInfo } from '../src/SpyClient.js';

// Only the four fields tuneMath reads are meaningful; the rest satisfy the type.
function devInfo(deviceType: number, minFrequency: number, maxFrequency: number): DeviceInfo {
  return {
    deviceType, deviceSerial: 0, maxSampleRate: 768_000, maxBandwidth: 768_000,
    decimationStages: 8, gainStages: 0, maxGainIndex: 0,
    minFrequency, maxFrequency, resolution: 0, minIQDecimation: 0, forcedIQFormat: 0,
  } as DeviceInfo;
}

const HF_PLUS = devInfo(DEVICE_AIRSPY_HF, 500_000, 260_000_000);

describe('nextFreqForTicks — plain stepping', () => {
  it('one tick up adds one step', () => {
    expect(nextFreqForTicks(594_000, 1, 9_000, HF_PLUS)).toBe(603_000);
  });
  it('one tick down subtracts one step', () => {
    expect(nextFreqForTicks(594_000, -1, 9_000, HF_PLUS)).toBe(585_000);
  });
  it('multi-tick flicks multiply by the step', () => {
    expect(nextFreqForTicks(80_000_000, 5, 100_000, HF_PLUS)).toBe(80_500_000);
    expect(nextFreqForTicks(80_000_000, -5, 100_000, HF_PLUS)).toBe(79_500_000);
  });
  it('zero ticks stays put inside a covered band', () => {
    expect(nextFreqForTicks(80_000_000, 0, 100_000, HF_PLUS)).toBe(80_000_000);
  });
});

describe('nextFreqForTicks — Airspy HF+ 31–60 MHz hardware gap', () => {
  it('dialing UP into the gap jumps to the VHF band lo (60 MHz)', () => {
    expect(nextFreqForTicks(30_900_000, 2, 100_000, HF_PLUS)).toBe(60_000_000);
  });
  it('dialing DOWN into the gap jumps to the HF band hi (31 MHz)', () => {
    expect(nextFreqForTicks(60_100_000, -2, 100_000, HF_PLUS)).toBe(31_000_000);
  });
  it('landing exactly on a band edge is left alone', () => {
    expect(nextFreqForTicks(30_900_000, 1, 100_000, HF_PLUS)).toBe(31_000_000);
    expect(nextFreqForTicks(60_100_000, -1, 100_000, HF_PLUS)).toBe(60_000_000);
  });
  it('a huge upward flick from HF still lands on the VHF lo, not past it', () => {
    // 20 MHz + 200 * 100 kHz = 40 MHz, i.e. mid-gap.
    expect(nextFreqForTicks(20_000_000, 200, 100_000, HF_PLUS)).toBe(60_000_000);
  });
});

describe('nextFreqForTicks — device edges', () => {
  it('below the HF lo edge clamps up to 500 kHz', () => {
    expect(nextFreqForTicks(530_000, -10, 9_000, HF_PLUS)).toBe(500_000);
  });
  it('above the VHF hi edge clamps down to 260 MHz', () => {
    expect(nextFreqForTicks(259_900_000, 10, 100_000, HF_PLUS)).toBe(260_000_000);
  });
  it('never returns a negative freq', () => {
    expect(nextFreqForTicks(100_000, -1_000, 9_000, null)).toBe(0);
  });
});

describe('nextFreqForTicks — device variants', () => {
  it('contiguous device (Airspy R2) steps without any gap handling', () => {
    const r2 = devInfo(DEVICE_AIRSPY_ONE, 24_000_000, 1_800_000_000);
    expect(nextFreqForTicks(100_000_000, 3, 1_000_000, r2)).toBe(103_000_000);
  });
  it('unknown deviceType falls back to the protocol-reported (min,max)', () => {
    const other = devInfo(999, 1_000_000, 30_000_000);
    expect(nextFreqForTicks(29_900_000, 5, 100_000, other)).toBe(30_000_000);
  });
  it('no DeviceInfo yet: steps unclamped instead of swallowing the rotate', () => {
    expect(nextFreqForTicks(40_000_000, 1, 100_000, null)).toBe(40_100_000);
  });
});

describe('nextPresetSlot', () => {
  // Mirrors the fixture list: 0 = 693 kHz AM, 1 = 9910 kHz AM, 2 = 90.5 MHz WFM.
  const list = [
    { freq:    693_000, mode: 2 },
    { freq:  9_910_000, mode: 2 },
    { freq: 90_500_000, mode: 1 },
  ];
  it('steps forward and wraps at the end', () => {
    expect(nextPresetSlot(list, 0,  1, HF_PLUS)).toBe(1);
    expect(nextPresetSlot(list, 2,  1, HF_PLUS)).toBe(0);
  });
  it('steps backward and wraps at the start', () => {
    expect(nextPresetSlot(list, 1, -1, HF_PLUS)).toBe(0);
    expect(nextPresetSlot(list, 0, -1, HF_PLUS)).toBe(2);
  });
  it('multi-tick rotates move that many slots', () => {
    expect(nextPresetSlot(list, 0,  2, HF_PLUS)).toBe(2);
    expect(nextPresetSlot(list, 0, -2, HF_PLUS)).toBe(1);
  });
  it('zero ticks counts as one step forward, as the dial always did', () => {
    expect(nextPresetSlot(list, 0, 0, HF_PLUS)).toBe(1);
  });
  it('skips a preset the connected device cannot receive', () => {
    // 45 MHz sits in the Airspy HF+ 31–60 MHz hardware gap.
    const withGap = [list[0], { freq: 45_000_000, mode: 3 }, list[2]];
    expect(nextPresetSlot(withGap, 0, 1, HF_PLUS)).toBe(2);
    expect(nextPresetSlot(withGap, 2, -1, HF_PLUS)).toBe(0);
  });
  it('returns null when no preset at all is receivable', () => {
    const allGap = [{ freq: 40_000_000, mode: 3 }, { freq: 45_000_000, mode: 3 }];
    expect(nextPresetSlot(allGap, 0, 1, HF_PLUS)).toBeNull();
  });
  it('returns null on an empty list instead of landing nowhere', () => {
    expect(nextPresetSlot([], 0, 1, HF_PLUS)).toBeNull();
  });
  it('with no DeviceInfo every preset counts as receivable', () => {
    const withGap = [list[0], { freq: 45_000_000, mode: 3 }, list[2]];
    expect(nextPresetSlot(withGap, 0, 1, null)).toBe(1);
  });
});
