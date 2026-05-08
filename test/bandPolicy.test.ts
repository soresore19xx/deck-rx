import { describe, it, expect } from 'vitest';
import { autoDemodForFreq } from '../src/bandPolicy.js';

describe('autoDemodForFreq', () => {
  it('Japanese MW band → AM (mode 2)', () => {
    expect(autoDemodForFreq(   522_000)).toBe(2);
    expect(autoDemodForFreq(   594_000)).toBe(2);
    expect(autoDemodForFreq( 1_008_000)).toBe(2);
    expect(autoDemodForFreq( 1_710_000)).toBe(2);
  });

  it('SW broadcast (outside amateur bands) → AM (mode 2)', () => {
    expect(autoDemodForFreq( 1_800_000)).toBe(2);  // just above MW
    expect(autoDemodForFreq( 6_055_000)).toBe(2);  // 49m broadcast
    expect(autoDemodForFreq(15_000_000)).toBe(2);  // 19m broadcast
    expect(autoDemodForFreq(30_000_000)).toBe(2);  // top of HF
  });

  it('amateur 160 m / 80 m / 40 m → CW lower edge, LSB upper segment', () => {
    // 160 m
    expect(autoDemodForFreq( 1_815_000)).toBe(5);  // CW slice
    expect(autoDemodForFreq( 1_840_000)).toBe(6);  // LSB
    // 80 m
    expect(autoDemodForFreq( 3_510_000)).toBe(5);  // CW
    expect(autoDemodForFreq( 3_550_000)).toBe(6);  // LSB
    expect(autoDemodForFreq( 3_700_000)).toBe(6);  // LSB voice
    // 40 m
    expect(autoDemodForFreq( 7_005_000)).toBe(5);  // CW
    expect(autoDemodForFreq( 7_100_000)).toBe(6);  // LSB voice
    expect(autoDemodForFreq( 7_200_000)).toBe(6);  // top edge LSB
  });

  it('amateur 20 m / 15 m / 10 m → CW lower edge, USB upper segment', () => {
    // 20 m
    expect(autoDemodForFreq(14_005_000)).toBe(5);  // CW
    expect(autoDemodForFreq(14_200_000)).toBe(4);  // USB voice
    expect(autoDemodForFreq(14_350_000)).toBe(4);  // top edge USB
    // 15 m
    expect(autoDemodForFreq(21_005_000)).toBe(5);  // CW
    expect(autoDemodForFreq(21_200_000)).toBe(4);  // USB
    // 10 m
    expect(autoDemodForFreq(28_005_000)).toBe(5);  // CW
    expect(autoDemodForFreq(28_500_000)).toBe(4);  // USB
    expect(autoDemodForFreq(29_500_000)).toBe(4);  // USB top
  });

  it('amateur band edges fall through to SW = AM', () => {
    // Just outside the 40 m segment → SW broadcast classification
    expect(autoDemodForFreq( 6_999_000)).toBe(2);
    expect(autoDemodForFreq( 7_201_000)).toBe(2);
    // Between bands
    expect(autoDemodForFreq(10_000_000)).toBe(2);
    expect(autoDemodForFreq(18_000_000)).toBe(2);
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
