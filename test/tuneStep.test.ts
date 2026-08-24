// Which step a band is tuned in (src/spyService.ts).
//
// The step used to be remembered per demod mode, and medium wave and short
// wave are both AM — so tuning across 1.6 MHz carried MW's 9 kHz onto the
// 49 m band, where the channels sit 5 kHz apart and every press landed
// between two stations. FM had the opposite problem: its list started at
// 10 kHz against a 100 kHz broadcast raster, so a fresh install crawled.
//
// These are the tables that fix both, and they are the kind of thing that is
// silently wrong for a long time — the receiver still tunes, it just never
// lands on a station.

import { describe, it, expect } from 'vitest';
import {
  stepBandFor,
  defaultTuneStepFor,
  tuneStepKey,
  tuneStepValuesForMode,
} from '../src/spyService.js';

const NFM = 0, WFM = 1, AM = 2, USB = 4, CW = 5, LSB = 6;

describe('stepBandFor', () => {
  it('puts long and medium wave together', () => {
    expect(stepBandFor(153_000)).toBe('mw');     // LW, Europe
    expect(stepBandFor(594_000)).toBe('mw');     // NHK 1
    expect(stepBandFor(1_602_000)).toBe('mw');   // top of the JP MW band
  });

  it('calls everything else on HF short wave', () => {
    expect(stepBandFor(1_800_000)).toBe('sw');   // 160 m, the first rung above MW
    expect(stepBandFor(6_055_000)).toBe('sw');   // Radio Nikkei, 49 m
    expect(stepBandFor(15_400_000)).toBe('sw');  // 19 m
    expect(stepBandFor(29_999_999)).toBe('sw');
  });

  it('everything above 30 MHz is VHF and up', () => {
    expect(stepBandFor(30_000_000)).toBe('vhf');
    expect(stepBandFor(80_000_000)).toBe('vhf'); // FM broadcast
  });
});

describe('defaultTuneStepFor', () => {
  it('FM broadcast steps a whole channel', () => {
    expect(defaultTuneStepFor(WFM, 80_000_000)).toBe(100_000);
  });

  it('medium wave keeps the 9 kHz raster', () => {
    expect(defaultTuneStepFor(AM, 594_000)).toBe(9_000);
  });

  it('short wave broadcast is 5 kHz, not medium wave 9', () => {
    expect(defaultTuneStepFor(AM, 6_055_000)).toBe(5_000);
    expect(defaultTuneStepFor(AM, 9_760_000)).toBe(5_000);
  });

  it('narrow FM takes the common VHF raster', () => {
    expect(defaultTuneStepFor(NFM, 145_000_000)).toBe(12_500);
  });

  it('SSB and CW start somewhere usable, raster or not', () => {
    // No channel grid on HF voice, but a default still beats inheriting one:
    // arriving from WFM's 100 kHz snapped USB to the top of its list, 10 kHz,
    // which steps clean over every signal it is meant to find.
    expect(defaultTuneStepFor(USB, 7_100_000)).toBe(1_000);
    expect(defaultTuneStepFor(LSB, 3_800_000)).toBe(1_000);
    expect(defaultTuneStepFor(CW, 7_010_000)).toBe(100);
  });

  it('every default is a value its own mode can actually be set to', () => {
    for (const [mode, hz] of [[WFM, 80_000_000], [NFM, 145_000_000],
                              [AM, 594_000], [AM, 6_055_000],
                              [USB, 7_100_000], [LSB, 3_800_000],
                              [CW, 7_010_000]] as const) {
      const d = defaultTuneStepFor(mode, hz);
      expect(d).not.toBeNull();
      expect(tuneStepValuesForMode(mode)).toContain(d);
    }
  });
});

describe('tuneStepKey', () => {
  it('splits AM by band, so one does not inherit the other', () => {
    expect(tuneStepKey(AM, 594_000)).toBe('2:mw');
    expect(tuneStepKey(AM, 6_055_000)).toBe('2:sw');
    expect(tuneStepKey(AM, 594_000)).not.toBe(tuneStepKey(AM, 6_055_000));
  });

  it('leaves every other mode keyed by the mode alone', () => {
    expect(tuneStepKey(WFM, 80_000_000)).toBe('1');
    expect(tuneStepKey(NFM, 145_000_000)).toBe('0');
    expect(tuneStepKey(CW, 7_010_000)).toBe('5');
  });

  it('the medium-wave key is the one a pre-split config can be read as', () => {
    // Old configs filed AM's step under a bare "2", chosen on medium wave,
    // because that is where the old 9 kHz default sat. spyService reads that
    // as the MW entry; short wave starts from its own default instead.
    expect(tuneStepKey(AM, 594_000)).toBe('2:mw');
  });
});
