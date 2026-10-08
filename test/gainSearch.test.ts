// Automatic RF gain: the pieces that decide which gain wins (src/gainSearch.ts)
// and the file that remembers it (src/gainMemory.ts).

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  coarseGains, refineGains, channelCnDb, pickGain, gainMemoryKey, measureChannel,
} from '../src/gainSearch.js';

/** A flat floor with a raised block of `widthHz` centred on `atHz`. */
function spectrum(n: number, rate: number, floorDb: number, sigDb: number,
                  atHz: number, widthHz: number): Float32Array {
  const b = new Float32Array(n).fill(floorDb);
  for (let i = 0; i < n; i++) {
    const f = (i - n / 2) * rate / n;
    if (Math.abs(f - atHz) <= widthHz / 2) b[i] = sigDb;
  }
  return b;
}

describe('gain ladders', () => {
  it('coarse pass spans the range with the ends included', () => {
    expect(coarseGains(8)).toEqual([0, 2, 4, 6, 8]);
    expect(coarseGains(29)).toEqual([0, 6, 12, 18, 24, 29]);
    expect(coarseGains(0)).toEqual([0]);
  });
  it('refining tries the midpoints either side of the winner, inside the range', () => {
    expect(refineGains(12, 29, coarseGains(29))).toEqual([9, 15]);
    expect(refineGains(0, 29, coarseGains(29))).toEqual([3]);
    expect(refineGains(4, 8, coarseGains(8))).toEqual([3, 5]);
  });
});

describe('channelCnDb', () => {
  const n = 4096, rate = 300_000;
  it('reads the channel against the floor outside it (WFM)', () => {
    const cn = channelCnDb(spectrum(n, rate, -100, -60, 0, 180_000), rate, 0, 1);
    expect(cn).toBeCloseTo(40, 0);
  });
  it('AM measures ±4.5 kHz, so a neighbour 9 kHz away is floor-side', () => {
    const b = spectrum(n, rate, -100, -50, 0, 8_000);
    const neighbour = spectrum(n, rate, -100, -55, 27_000, 8_000);
    for (let i = 0; i < n; i++) b[i] = Math.max(b[i], neighbour[i]);
    const cn = channelCnDb(b, rate, 0, 2)!;
    expect(cn).toBeGreaterThan(45);   // the median floor ignores one neighbour
  });
  it('follows a VFO offset', () => {
    const cn = channelCnDb(spectrum(n, rate, -100, -70, 40_000, 9_000), rate, 40_000, 2);
    expect(cn).toBeCloseTo(30, 0);
  });
  it('USB looks above the carrier, LSB below', () => {
    expect(measureChannel(4)!.offsetHz).toBeGreaterThan(0);
    expect(measureChannel(6)!.offsetHz).toBeLessThan(0);
  });
  it('has nothing to say about RAW', () => {
    expect(channelCnDb(new Float32Array(n), rate, 0, 7)).toBeNull();
  });
});

describe('pickGain', () => {
  it('a weak station: C/N rises then plateaus — the low end of the plateau wins', () => {
    const r = [{ gain: 0, cn: 5 }, { gain: 6, cn: 12 }, { gain: 12, cn: 19.6 },
               { gain: 18, cn: 20 }, { gain: 24, cn: 19.8 }, { gain: 29, cn: 15 }];
    expect(pickGain(r)).toBe(12);
  });
  it('a strong station that overloads: the peak, not the top', () => {
    const r = [{ gain: 0, cn: 30 }, { gain: 6, cn: 34 }, { gain: 12, cn: 26 },
               { gain: 18, cn: 18 }, { gain: 24, cn: 12 }, { gain: 29, cn: 9 }];
    expect(pickGain(r)).toBe(6);
  });
  it('nothing measured, nothing picked', () => {
    expect(pickGain([])).toBeNull();
  });
});

describe('gain memory', () => {
  let file: string;
  beforeEach(async () => {
    file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gainmem-')), 'gain-memory.json');
    process.env.DECK_RX_GAIN_MEMORY_PATH = file;
    const m = await import('../src/gainMemory.js');
    m.resetGainMemoryCache();
  });
  it('remembers per receiver, channel (to 100 Hz) and mode, across a reload', async () => {
    const m = await import('../src/gainMemory.js');
    const v4 = gainMemoryKey('3:00000000', 79_500_000, 1);
    const hfp = gainMemoryKey('2:31313038', 79_500_000, 1);
    m.rememberGain(v4, 24);
    expect(m.recallGain(v4)).toBe(24);
    expect(m.recallGain(hfp)).toBeUndefined();
    expect(gainMemoryKey('3:00000000', 79_500_040, 1)).toBe(v4);
    m.resetGainMemoryCache();
    expect(m.recallGain(v4)).toBe(24);      // came back from disk
    m.forgetGain(v4);
    m.resetGainMemoryCache();
    expect(m.recallGain(v4)).toBeUndefined();
  });
});
