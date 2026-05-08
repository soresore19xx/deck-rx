import { describe, it, expect } from 'vitest';
import { autoDemodForFreq } from '../src/bandPolicy.js';

describe('autoDemodForFreq', () => {
  it('Japanese MW band → AM (mode 2)', () => {
    expect(autoDemodForFreq(   522_000)).toBe(2);
    expect(autoDemodForFreq(   594_000)).toBe(2);
    expect(autoDemodForFreq( 1_008_000)).toBe(2);
    expect(autoDemodForFreq( 1_710_000)).toBe(2);
  });

  it('SW band → AM (mode 2) — USB/LSB unimplemented', () => {
    expect(autoDemodForFreq( 1_800_000)).toBe(2);
    expect(autoDemodForFreq( 6_055_000)).toBe(2);
    expect(autoDemodForFreq(15_000_000)).toBe(2);
    expect(autoDemodForFreq(30_000_000)).toBe(2);
  });

  it('VHF low (30–76 MHz) → NFM (mode 0)', () => {
    expect(autoDemodForFreq(30_000_000)).toBe(2); // boundary belongs to SW
    expect(autoDemodForFreq(40_000_000)).toBe(0);
    expect(autoDemodForFreq(75_999_999)).toBe(0);
  });

  it('FM broadcast (76–108 MHz) → WFM (mode 1)', () => {
    expect(autoDemodForFreq( 76_000_000)).toBe(1);
    expect(autoDemodForFreq( 88_100_000)).toBe(1);
    expect(autoDemodForFreq( 90_500_000)).toBe(1);
    expect(autoDemodForFreq(108_000_000)).toBe(1);
  });

  it('above FM band → NFM (mode 0)', () => {
    expect(autoDemodForFreq(118_000_000)).toBe(0);
    expect(autoDemodForFreq(144_000_000)).toBe(0);
  });

  it('out of any band → null', () => {
    expect(autoDemodForFreq(0)).toBe(null);
    expect(autoDemodForFreq(100)).toBe(null);
    expect(autoDemodForFreq( 1_750_000)).toBe(null);   // gap between MW and SW
  });
});
