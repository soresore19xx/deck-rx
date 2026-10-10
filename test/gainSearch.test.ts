// Automatic RF gain: the pieces that decide which gain wins (src/gainSearch.ts)
// and the file that remembers it (src/gainMemory.ts).

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  coarseGains, refineGains, channelCnDb, channelLevels, pickGain, gainMemoryKey, measureChannel,
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
  it('the best C/N right under overload is passed over for headroom (V4 90.5 MHz)', () => {
    const r = [{ gain: 0, cn: 30.3, peakDb: -17.4 }, { gain: 3, cn: 39.1, peakDb: -8.6 },
               { gain: 6, cn: 45.6, peakDb: -1.7 }, { gain: 9, cn: 6.7, peakDb: 0 }];
    expect(pickGain(r)).toBe(3);
  });
  it('a weak station with headroom everywhere is unaffected (V4 79.5 MHz)', () => {
    const r = [{ gain: 18, cn: 23.5, peakDb: -17.3 }, { gain: 21, cn: 25.3, peakDb: -12.2 },
               { gain: 24, cn: 26.4, peakDb: -8.7 }, { gain: 27, cn: 26.5, peakDb: -5.2 }];
    expect(pickGain(r)).toBe(24);
  });
  it('every gain over the line: the lowest one tried', () => {
    expect(pickGain([{ gain: 3, cn: 20, peakDb: -2 }, { gain: 0, cn: 10, peakDb: -4 }])).toBe(0);
  });
  it('no station at any gain: nothing picked (V4 92.4 MHz)', () => {
    const r = [{ gain: 0, cn: 0.6, peakDb: -36.8 }, { gain: 6, cn: 1.2, peakDb: -36.4 },
               { gain: 12, cn: 0.9, peakDb: -19.5 }, { gain: 29, cn: 1.1, peakDb: -7.4 }];
    expect(pickGain(r)).toBeNull();
  });
  it('nothing measured, nothing picked', () => {
    expect(pickGain([])).toBeNull();
  });
});

describe('pickGain with levels: stop where the floor starts to follow the gain', () => {
  // dB per step for the V4 ladder is roughly the index gap, close enough here.
  const at = (gain: number, signalDb: number, floorDb: number, peakDb = -30) =>
    ({ gain, signalDb, floorDb, cn: signalDb - floorDb, peakDb });
  it('medium wave: the antenna noise rules from 6 up, so a lucky 24 does not win', () => {
    // Floor flat from 0 to 6 (the receiver's own), then rising with the gain.
    // 24 reads 1.5 dB better C/N by chance; the old rule took it.
    const r = [at(0, -70, -110), at(6, -64, -108), at(12, -58, -101),
               at(18, -52, -95), at(24, -42, -87.5), at(29, -41, -84)];
    expect(pickGain(r)).toBe(6);
    expect(pickGain(r.map(({ gain, cn, peakDb }) => ({ gain, cn, peakDb })))).toBe(24);
  });
  it('a quiet band: the floor stays put, so the climb goes on', () => {
    const r = [at(0, -80, -110), at(6, -74, -110), at(12, -68, -109.5),
               at(18, -62, -108), at(24, -56, -102), at(29, -51, -97)];
    expect(pickGain(r)).toBe(18);
  });
  it('overload: intermod lifts the floor faster than the signal', () => {
    const r = [at(0, -40, -110), at(6, -34, -109), at(12, -29, -95)];
    expect(pickGain(r)).toBe(6);
  });
  it('the signal stops rising (compression): stop below', () => {
    const r = [at(0, -40, -110), at(6, -34, -109.5), at(12, -34, -109)];
    expect(pickGain(r)).toBe(6);
  });
  it('a station not yet clear of the floor is climbed out of', () => {
    // At 0 the carrier is lost in the receiver's noise and the levels say
    // nothing; C/N improving is the only guide until it stands clear.
    const r = [at(0, -108, -110), at(6, -102, -110), at(12, -96, -110), at(18, -90, -105)];
    expect(pickGain(r)).toBe(12);
  });
  it('headroom still comes first', () => {
    const r = [at(0, -30, -110, -14), at(6, -24, -110, -4), at(12, -18, -110, -1)];
    expect(pickGain(r)).toBe(0);
  });
  it('the order the steps were measured in does not matter', () => {
    const r = [at(12, -58, -101), at(0, -70, -110), at(9, -61, -106), at(6, -64, -108)];
    expect(pickGain(r)).toBe(6);
  });
});

describe('channelLevels', () => {
  const n = 4096, rate = 300_000;
  it('AM: the carrier is the reference, not the mean of the channel', () => {
    const b = spectrum(n, rate, -100, -80, 0, 8_000);
    b[n / 2] = -40;                          // carrier
    const lv = channelLevels(b, rate, 0, 2)!;
    expect(lv.signalDb).toBeCloseTo(-40, 5);
    expect(lv.floorDb).toBeCloseTo(-100, 5);
    expect(lv.cn).toBeLessThan(60);          // C/N stays the channel mean
  });
  it('WFM: the mean of the channel', () => {
    const lv = channelLevels(spectrum(n, rate, -100, -60, 0, 180_000), rate, 0, 1)!;
    expect(lv.signalDb).toBeCloseTo(-60, 0);
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
  it('an auto gain is trusted for an hour, then measured again', async () => {
    const m = await import('../src/gainMemory.js');
    const k = gainMemoryKey('3:00000000', 1_440_000, 2);
    const t0 = 1_760_000_000_000;
    m.rememberGain(k, 0, t0);
    expect(m.autoGainFresh(k, t0 + 59 * 60_000)).toBe(true);
    expect(m.autoGainFresh(k, t0 + m.AUTO_GAIN_MAX_AGE_MS)).toBe(false);
    expect(m.recallGain(k)).toBe(0);             // still the fallback meanwhile
    m.rememberGain(k, 0, t0 + m.AUTO_GAIN_MAX_AGE_MS);   // same gain, new time
    expect(m.autoGainFresh(k, t0 + m.AUTO_GAIN_MAX_AGE_MS + 1)).toBe(true);
    m.resetGainMemoryCache();
    expect(m.autoGainFresh(k, t0 + m.AUTO_GAIN_MAX_AGE_MS + 1)).toBe(true);  // from disk
  });
  it('a gain filed without a time (the rule before f3898dc) is measured again', async () => {
    const m = await import('../src/gainMemory.js');
    const k = gainMemoryKey('3:00000000', 1_440_000, 2);
    fs.writeFileSync(file, JSON.stringify({ version: 1, gains: { [k]: 24 }, saved: {} }));
    m.resetGainMemoryCache();
    expect(m.recallGain(k)).toBe(24);
    expect(m.autoGainFresh(k)).toBe(false);
  });
  it('a gain changed by sync loses this device\'s time, an unchanged one keeps it', async () => {
    const m = await import('../src/gainMemory.js');
    const a = gainMemoryKey('3:00000000', 1_440_000, 2);
    const b = gainMemoryKey('3:00000000', 954_000, 2);
    m.rememberGain(a, 0); m.rememberGain(b, 6);
    m.replaceGainMaps({ [a]: 0, [b]: 12 }, {});
    expect(m.autoGainFresh(a)).toBe(true);
    expect(m.autoGainFresh(b)).toBe(false);
  });
  it('a saved gain wins over the auto one and survives the next search', async () => {
    const m = await import('../src/gainMemory.js');
    const k = gainMemoryKey('3:00000000', 90_500_000, 1);
    m.rememberGain(k, 3);
    expect(m.gainSource(k)).toBe('auto');
    m.saveGain(k, 9);
    m.rememberGain(k, 6);                    // a later search files its own
    expect(m.recallGain(k)).toBe(9);
    expect(m.gainSource(k)).toBe('saved');
    m.resetGainMemoryCache();
    expect(m.recallGain(k)).toBe(9);         // came back from disk
    m.forgetGain(k);
    expect(m.gainSource(k)).toBeUndefined();
  });
});
