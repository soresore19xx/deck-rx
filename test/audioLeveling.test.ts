import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  softLimit,
  OutputLeveler,
  MODE_MAKEUP,
  DEFAULT_LEVELER_CFG,
  INT16_MAX,
} from '../src/audioLeveling.js';

// A constant-magnitude alternating buffer [+A,-A,+A,-A,…] has RMS = A, so we
// can dial an exact pre-leveling level for the AGC under test.
function constRms(amp: number, len = 1024): Int16Array {
  const pcm = new Int16Array(len);
  for (let i = 0; i < len; i++) pcm[i] = i % 2 === 0 ? amp : -amp;
  return pcm;
}

describe('softLimit', () => {
  it('is identity (rounded) below the knee', () => {
    expect(softLimit(0)).toBe(0);
    expect(softLimit(1000)).toBe(1000);
    expect(softLimit(-1000)).toBe(-1000);
    // knee = 0.85 * 32767 = 27851.95
    expect(softLimit(20000)).toBe(20000);
  });

  it('never exceeds the Int16 ceiling, even for huge input', () => {
    expect(softLimit(1e9)).toBeLessThanOrEqual(INT16_MAX);
    expect(softLimit(-1e9)).toBeGreaterThanOrEqual(-INT16_MAX);
    expect(softLimit(1e9)).toBeGreaterThan(0);
    expect(softLimit(-1e9)).toBeLessThan(0);
  });

  it('is monotonic increasing through the knee', () => {
    let prev = -Infinity;
    for (let x = 25000; x <= 60000; x += 500) {
      const y = softLimit(x);
      expect(y).toBeGreaterThanOrEqual(prev);
      prev = y;
    }
  });

  it('is continuous at the knee (no kink)', () => {
    const T = Math.round(0.85 * INT16_MAX); // 27852
    expect(Math.abs(softLimit(T) - T)).toBeLessThanOrEqual(1);
    expect(Math.abs(softLimit(T + 1) - (T + 1))).toBeLessThanOrEqual(2);
  });

  it('is odd-symmetric', () => {
    expect(softLimit(40000)).toBe(-softLimit(-40000));
  });
});

describe('OutputLeveler', () => {
  it('converges so that rms × gain ≈ targetRms', () => {
    const lv = new OutputLeveler();
    const buf = constRms(1000); // raw rms 1000 → wants gain targetRms/1000
    const want = DEFAULT_LEVELER_CFG.targetRms / 1000;
    for (let i = 0; i < 2000; i++) lv.observe(buf, 1, 0.01);
    expect(lv.gain).toBeGreaterThan(want - 0.2);
    expect(lv.gain).toBeLessThan(want + 0.2);
    expect(1000 * lv.gain).toBeCloseTo(DEFAULT_LEVELER_CFG.targetRms, -2);
  });

  it('makeup is compensated by the AGC in steady state', () => {
    // Same raw signal, different makeup → same final level (rms × makeup × gain).
    const buf = constRms(1000);
    const a = new OutputLeveler();
    const b = new OutputLeveler();
    for (let i = 0; i < 3000; i++) {
      a.observe(buf, 1, 0.01);
      b.observe(buf, 3, 0.01);
    }
    const finalA = 1000 * 1 * a.gain;
    const finalB = 1000 * 3 * b.gain;
    expect(finalB).toBeCloseTo(finalA, -2);
  });

  it('holds gain on near-silence (does not pump up noise)', () => {
    const lv = new OutputLeveler();
    lv.gain = 3;
    const silent = constRms(5); // rms 5 < noiseFloorRms 40
    for (let i = 0; i < 100; i++) lv.observe(silent, 1, 0.01);
    expect(lv.gain).toBe(3);
  });

  it('attack (gain down) is faster than release (gain up)', () => {
    const loud = constRms(1000); // desired gain = targetRms/1000
    const want = DEFAULT_LEVELER_CFG.targetRms / 1000;
    const down = new OutputLeveler();
    down.gain = want + 5; // desired < gain → attack
    const beforeDown = Math.abs(down.gain - want);
    down.observe(loud, 1, 0.01);
    const downMove = beforeDown - Math.abs(down.gain - want);

    const up = new OutputLeveler();
    up.gain = 1; // desired > gain → release
    const beforeUp = Math.abs(up.gain - want);
    up.observe(loud, 1, 0.01);
    const upMove = beforeUp - Math.abs(up.gain - want);

    expect(downMove).toBeGreaterThan(upMove);
  });

  it('respects maxGain and minGain rails', () => {
    const weak = new OutputLeveler();
    const tiny = constRms(50); // rms 50 → wants gain 100, capped at maxGain 12
    for (let i = 0; i < 5000; i++) weak.observe(tiny, 1, 0.01);
    expect(weak.gain).toBeLessThanOrEqual(DEFAULT_LEVELER_CFG.maxGain + 1e-6);

    const hot = new OutputLeveler();
    const huge = constRms(30000); // rms 30000 → wants gain ~0.17
    for (let i = 0; i < 5000; i++) hot.observe(huge, 1, 0.01);
    expect(hot.gain).toBeGreaterThanOrEqual(DEFAULT_LEVELER_CFG.minGain - 1e-6);
    expect(hot.gain).toBeLessThan(1);
  });

  it('is bypassed (gain pinned to 1) when disabled', () => {
    const lv = new OutputLeveler({ enabled: false });
    lv.gain = 7;
    const buf = constRms(1000);
    lv.observe(buf, 1, 0.01);
    expect(lv.gain).toBe(1);
  });

  it('snap() seeds straight to target in one call (no ramp)', () => {
    const lv = new OutputLeveler();
    const buf = constRms(1000); // wants gain targetRms/1000
    const want = DEFAULT_LEVELER_CFG.targetRms / 1000;
    lv.snap(buf, 1);
    expect(lv.gain).toBeGreaterThan(want - 0.1);
    expect(lv.gain).toBeLessThan(want + 0.1);
  });

  it('snap() holds on near-silence and is bypassed when disabled', () => {
    const hold = new OutputLeveler();
    hold.gain = 2;
    hold.snap(constRms(5), 1); // below noise floor
    expect(hold.gain).toBe(2);

    const off = new OutputLeveler({ enabled: false });
    off.gain = 3;
    off.snap(constRms(1000), 1);
    expect(off.gain).toBe(1);
  });

  it('configure() updates the target live', () => {
    const lv = new OutputLeveler();
    lv.configure({ targetRms: 10000 });
    const buf = constRms(1000); // wants gain 10
    for (let i = 0; i < 3000; i++) lv.observe(buf, 1, 0.01);
    expect(lv.gain).toBeGreaterThan(9.5);
    expect(lv.gain).toBeLessThan(10.5);
  });
});

describe('output stage, against the standalone app', () => {
  // The two receivers run the same three stages with the same constants, so
  // they can be compared by arithmetic rather than by ear. This side checks the
  // plugin's arrays in the shared fixture; native-app/Tests/main.swift checks
  // the app's. The fixture's comment says what the one real difference is and
  // why it is not settled: the volume sits inside the limiter here and outside
  // it there.
  const golden = JSON.parse(readFileSync(
    resolve(__dirname, 'fixtures', 'audioOutputGolden.json'), 'utf8',
  )) as {
    input: number[];
    params: { mode: number; makeup: number; audioGain: number };
    cases: Array<{ name: string; volume: number; plugin: number[]; solo: number[] }>;
  };

  it('the fixture agrees with MODE_MAKEUP about the mode it claims', () => {
    expect(MODE_MAKEUP[golden.params.mode]).toBe(golden.params.makeup);
  });

  for (const c of golden.cases) {
    it(`reproduces the plugin's output at volume ${c.volume}`, () => {
      const g = c.volume * golden.params.makeup * golden.params.audioGain;
      // The AGC is off by default, so leveler.gain is 1 and the ramp across the
      // buffer is flat — what spyService's loop then computes per sample is
      // exactly this.
      const out = golden.input.map(x => softLimit(x * g));
      expect(out).toEqual(c.plugin);
    });

    it(`agrees with the app below the knee at volume ${c.volume}`, () => {
      // Below the limiter's knee both are a plain multiply, so the topologies
      // cannot differ there. This is the half that must never drift.
      const knee = INT16_MAX * 0.85;
      const g = c.volume * golden.params.makeup * golden.params.audioGain;
      let compared = 0;
      golden.input.forEach((x, i) => {
        if (Math.abs(x) * golden.params.makeup * golden.params.audioGain > knee) return;
        compared++;
        // Rounding is the only licensed difference: the plugin returns an
        // integer from softLimit, the app stays in float.
        expect(Math.abs(c.plugin[i] - c.solo[i])).toBeLessThanOrEqual(0.5);
        expect(c.plugin[i]).toBe(Math.round(x * g));
      });
      expect(compared).toBeGreaterThan(5);
    });
  }

  it('the two topologies coincide when nothing is attenuated', () => {
    const control = golden.cases.find(c => c.volume === 1.0);
    expect(control, 'the fixture needs its volume 1.0 control case').toBeTruthy();
    control!.plugin.forEach((p, i) => {
      expect(Math.abs(p - control!.solo[i])).toBeLessThanOrEqual(0.5);
    });
  });

  it('records how far apart they are above the knee at the volume in use', () => {
    const c = golden.cases.find(x => x.volume === 0.41)!;
    const i = golden.input.indexOf(24000);   // the AM AGC's look-ahead ceiling
    const dB = 20 * Math.log10(Math.abs(c.solo[i]) / Math.abs(c.plugin[i]));
    // Not a preference, a measurement: the app compresses this peak and the
    // plugin does not. If either topology changes this number moves, which is
    // the point of asserting it.
    expect(dB).toBeLessThan(-0.7);
    expect(dB).toBeGreaterThan(-1.1);
  });
});
