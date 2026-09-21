// Exhaustive tests for the settings that depend on which receiver is connected.
//
// The TypeScript half of a rule set that also lives in
// native-app/Sources/DeviceSettings.swift. The two cannot share code, so they
// share these numbers: Tests/DeviceSettingsTests.swift asserts the same floors,
// the same fallbacks and the same switching behaviour. A change on one side
// that is not made on the other will show up as a disagreement between the
// plugin and Solo on the same receiver.
//
// Why any of this exists: on 2026-09-21, pointing a client at a second
// SpyServer carrying an RTL-SDR Blog V4 while carrying the Airspy HF+'s stored
// `iqDecimation: 0` asked for 2.4 MHz. It connected, reported canControl, never
// tuned, and played noise.

import { describe, it, expect } from 'vitest';
import {
  RX_MODE, MAX_AUTO_IQ_RATE, minIQRate, minAudioRate, deviceKey, iqRateFor,
  decimationOffset, audioDecimation, defaultGainIndex, gainCeiling, isMediumwave,
  RTL_MW_GAIN_INDEX, RTL_HF_GAIN_INDEX,
  resolveDeviceSettings, adoptDeviceSettings, mergeProfileIntoConfig,
  type DeviceProfile,
} from '../src/deviceSettings.js';
import type { DeviceInfo } from '../src/SpyClient.js';

function info(over: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    deviceType: 3, deviceSerial: 1, maxSampleRate: 2_400_000, maxBandwidth: 2_400_000,
    decimationStages: 8, gainStages: 0, maxGainIndex: 29, minFrequency: 500_000,
    maxFrequency: 1_766_000_000, resolution: 0, minIQDecimation: 0, forcedIQFormat: 0,
    ...over,
  };
}

/** The two receivers in use, with the values their servers really report. */
const HFP = info({ deviceType: 2, deviceSerial: 0x3B528D80, maxSampleRate: 912_000,
                   maxGainIndex: 8, minFrequency: 0, maxFrequency: 1_700_000_000 });
const V4 = info({ deviceType: 3, deviceSerial: 1, maxSampleRate: 2_400_000, maxGainIndex: 29 });
const V4B = info({ deviceType: 3, deviceSerial: 2, maxSampleRate: 2_400_000, maxGainIndex: 29 });
const AIRSPY_ONE = info({ deviceType: 1, deviceSerial: 7, maxSampleRate: 10_000_000, maxGainIndex: 21 });
const UNKNOWN = info({ deviceType: 99, deviceSerial: 3, maxSampleRate: 768_000, maxGainIndex: 4 });
const FLOORED = info({ deviceType: 3, deviceSerial: 9, minIQDecimation: 2 });

const ALL_MODES = [RX_MODE.NFM, RX_MODE.WFM, RX_MODE.AM, RX_MODE.DSB, 4, 5];
const ALL_DEVICES: [string, DeviceInfo][] = [
  ['HF+', HFP], ['V4', V4], ['AirspyOne', AIRSPY_ONE],
  ['unknown', UNKNOWN], ['V4+minDec', FLOORED],
];

type Cfg = {
  iqDecimation?: number; audioDecimate?: number; amGain?: number; fmGain?: number;
  devices?: Record<string, DeviceProfile>;
};
const cfg = (o: Cfg = {}): Cfg => ({ iqDecimation: 1, audioDecimate: 4, ...o });

describe('floors', () => {
  it('WFM needs the widest IQ, for the 38 kHz stereo subcarrier', () => {
    expect(minIQRate(RX_MODE.WFM)).toBe(200_000);
  });
  it('narrow modes share one lower IQ floor', () => {
    for (const m of [RX_MODE.AM, RX_MODE.NFM, RX_MODE.DSB, 4, 5]) {
      expect(minIQRate(m)).toBe(96_000);
    }
  });
  it('WFM audio clears twice 38 kHz', () => {
    expect(minAudioRate(RX_MODE.WFM)).toBeGreaterThanOrEqual(76_000);
  });
  it('NFM sits between WFM and AM', () => {
    expect(minAudioRate(RX_MODE.NFM)).toBeLessThan(minAudioRate(RX_MODE.WFM));
    expect(minAudioRate(RX_MODE.NFM)).toBeGreaterThan(minAudioRate(RX_MODE.AM));
  });
  it('AM audio still passes a 9 kHz channel', () => {
    expect(minAudioRate(RX_MODE.AM) / 2).toBeGreaterThanOrEqual(9_000);
  });
});

describe('the bug that started this', () => {
  it('a V4 given the HF+ stored 0 does not ask for 2.4 MHz', () => {
    const s = resolveDeviceSettings(V4, cfg({ iqDecimation: 0 }), RX_MODE.AM);
    expect(s.iqRate).not.toBe(2_400_000);
    expect(s.iqRate).toBe(150_000);
  });
  it('the HF+ itself still gets its full 912 kHz', () => {
    expect(resolveDeviceSettings(HFP, cfg({ iqDecimation: 0 }), RX_MODE.AM).iqRate).toBe(912_000);
  });
});

describe('every device x every mode', () => {
  for (const [name, dev] of ALL_DEVICES) {
    for (const mode of ALL_MODES) {
      it(`${name}/${mode} holds every invariant`, () => {
        const s = resolveDeviceSettings(dev, cfg({ iqDecimation: 0, audioDecimate: 4 }), mode);
        const reachable = iqRateFor(dev, 0) >= minIQRate(mode);
        if (reachable) {
          expect(s.iqRate).toBeGreaterThanOrEqual(minIQRate(mode));
          if (s.audioDecimate > 1) {
            expect(s.iqRate / s.audioDecimate).toBeGreaterThanOrEqual(minAudioRate(mode));
          }
        }
        expect(s.gainIndex).toBeLessThanOrEqual(dev.maxGainIndex);
        expect(s.audioDecimate).toBeGreaterThanOrEqual(1);
        expect(s.decStage).toBeGreaterThanOrEqual(dev.minIQDecimation);
        expect(s.decStage).toBe(s.iqDecimationOffset + dev.minIQDecimation);
        expect(s.iqRate).toBeGreaterThan(0);
      });
    }
  }
});

describe('stored values, both directions', () => {
  it('too high for the device is replaced', () => {
    expect(resolveDeviceSettings(V4, cfg({ iqDecimation: 0 }), RX_MODE.AM).iqRate)
      .toBeLessThanOrEqual(MAX_AUTO_IQ_RATE);
  });
  it('too low for the mode is replaced', () => {
    expect(resolveDeviceSettings(V4, cfg({ iqDecimation: 7 }), RX_MODE.AM).iqRate)
      .toBeGreaterThanOrEqual(minIQRate(RX_MODE.AM));
  });
  it('a workable stored stage is left alone', () => {
    expect(resolveDeviceSettings(V4, cfg({ iqDecimation: 4 }), RX_MODE.AM).iqDecimationOffset).toBe(4);
  });
  it('WFM rejects a stage AM accepts', () => {
    expect(resolveDeviceSettings(V4, cfg({ iqDecimation: 4 }), RX_MODE.WFM).iqDecimationOffset)
      .not.toBe(4);
  });
  it('an absurd stored offset is replaced, not passed through', () => {
    expect(resolveDeviceSettings(V4, cfg({ iqDecimation: 99 }), RX_MODE.AM).iqDecimationOffset)
      .toBeLessThanOrEqual(V4.decimationStages);
  });
});

describe('audio decimation', () => {
  it('HF+ at 912 kHz keeps 4 for WFM', () => {
    expect(audioDecimation(912_000, RX_MODE.WFM, 4)).toBe(4);
  });
  it('V4 at 150 kHz drops it so WFM keeps its subcarrier', () => {
    expect(150_000 / audioDecimation(150_000, RX_MODE.WFM, 4)).toBeGreaterThanOrEqual(96_000);
  });
  it('AM at 150 kHz is content with 4', () => {
    expect(audioDecimation(150_000, RX_MODE.AM, 4)).toBe(4);
  });
  it('NFM sits between them', () => {
    expect(audioDecimation(150_000, RX_MODE.NFM, 4)).toBe(2);
  });
  it('never returns less than 1, whatever it is handed', () => {
    for (const stored of [0, -3, 0.5, NaN]) {
      expect(audioDecimation(48_000, RX_MODE.WFM, stored as number)).toBeGreaterThanOrEqual(1);
    }
  });
  it('only ever halves, so it stays a power-of-two chain', () => {
    expect([1, 2, 4, 8]).toContain(audioDecimation(300_000, RX_MODE.WFM, 8));
  });
});

describe('default gain', () => {
  it('RTL-SDR starts at the bottom of its 29 steps', () => {
    // With no frequency to go on this is the mediumwave answer, which is the
    // safe one: see "gain by band" below.
    expect(defaultGainIndex(V4)).toBe(RTL_MW_GAIN_INDEX);
  });
  it('Airspy HF+ still starts at its maximum', () => {
    expect(defaultGainIndex(HFP)).toBe(HFP.maxGainIndex);
  });
  it('Airspy R2 and unknown devices keep the old default', () => {
    expect(defaultGainIndex(AIRSPY_ONE)).toBe(AIRSPY_ONE.maxGainIndex);
    expect(defaultGainIndex(UNKNOWN)).toBe(UNKNOWN.maxGainIndex);
  });
  it('a stored gain beats the default', () => {
    // On shortwave, where nothing caps it. Mediumwave has its own rule.
    expect(resolveDeviceSettings(V4, cfg({ amGain: 12 }), RX_MODE.AM, 6_030_000)
      .gainIndex).toBe(12);
  });
  it('a stored gain above the range is clamped, not rejected', () => {
    expect(resolveDeviceSettings(HFP, cfg({ amGain: 99 }), RX_MODE.AM).gainIndex)
      .toBe(HFP.maxGainIndex);
  });
  it('AM and FM gains stay separate', () => {
    const c = cfg({ amGain: 3, fmGain: 17 });
    expect(resolveDeviceSettings(V4, c, RX_MODE.AM, 6_030_000).gainIndex).toBe(3);
    expect(resolveDeviceSettings(V4, c, RX_MODE.WFM, 100_100_000).gainIndex).toBe(17);
  });
});

describe('keys and switching receivers', () => {
  it('separates two receivers of the same type', () => {
    expect(deviceKey(V4.deviceType, V4.deviceSerial))
      .not.toBe(deviceKey(V4B.deviceType, V4B.deviceSerial));
  });
  it('separates different types', () => {
    expect(deviceKey(HFP.deviceType, HFP.deviceSerial))
      .not.toBe(deviceKey(V4.deviceType, V4.deviceSerial));
  });
  it('matches the Swift key format, so the two halves agree', () => {
    expect(deviceKey(3, 1)).toBe('3:00000001');
    expect(deviceKey(2, 0x3B528D80)).toBe('2:3B528D80');
  });

  it('survives connect, switch, and coming back', () => {
    const hfpKey = deviceKey(HFP.deviceType, HFP.deviceSerial);
    const v4Key = deviceKey(V4.deviceType, V4.deviceSerial);
    const c: Cfg = cfg({ iqDecimation: 0, amGain: 0 });

    const s1 = resolveDeviceSettings(HFP, c, RX_MODE.AM);
    adoptDeviceSettings(s1, c, HFP, RX_MODE.AM);
    expect(s1.iqRate).toBe(912_000);
    expect(c.devices?.[hfpKey]?.iqDecimation).toBe(0);

    const s2 = resolveDeviceSettings(V4, c, RX_MODE.AM);
    adoptDeviceSettings(s2, c, V4, RX_MODE.AM);
    expect(s2.iqRate).toBe(150_000);
    expect(c.devices?.[v4Key]?.iqDecimation).toBe(s2.iqDecimationOffset);
    expect(c.devices?.[v4Key]?.iqDecimation).not.toBe(0);
    // the HF+'s own profile must be untouched by the visit
    expect(c.devices?.[hfpKey]?.iqDecimation).toBe(0);

    expect(resolveDeviceSettings(HFP, c, RX_MODE.AM).iqRate).toBe(912_000);
    const back = resolveDeviceSettings(V4, c, RX_MODE.AM);
    expect(back.iqDecimationOffset).toBe(s2.iqDecimationOffset);
    expect(back.iqRate).toBe(150_000);
  });

  it('a second identical dongle does not inherit its twin', () => {
    const c: Cfg = cfg({ iqDecimation: 0 });
    adoptDeviceSettings(resolveDeviceSettings(V4, c, RX_MODE.AM), c, V4, RX_MODE.AM);
    expect(c.devices?.[deviceKey(V4B.deviceType, V4B.deviceSerial)]).toBeUndefined();
    expect(resolveDeviceSettings(V4B, c, RX_MODE.AM).iqRate).toBeGreaterThanOrEqual(96_000);
  });

  it('re-adopting an unchanged profile changes nothing', () => {
    const c: Cfg = cfg({ iqDecimation: 0 });
    adoptDeviceSettings(resolveDeviceSettings(V4, c, RX_MODE.AM), c, V4, RX_MODE.AM);
    const first = JSON.stringify(c.devices);
    adoptDeviceSettings(resolveDeviceSettings(V4, c, RX_MODE.AM), c, V4, RX_MODE.AM);
    expect(JSON.stringify(c.devices)).toBe(first);
  });

  it('adopting in FM leaves the AM gain alone', () => {
    const c: Cfg = cfg({ iqDecimation: 4, amGain: 2, fmGain: 9 });
    const s = resolveDeviceSettings(V4, c, RX_MODE.WFM);
    adoptDeviceSettings(s, c, V4, RX_MODE.WFM);
    const k = deviceKey(V4.deviceType, V4.deviceSerial);
    expect(c.devices?.[k]?.amGain).toBe(2);
    expect(c.devices?.[k]?.fmGain).toBe(s.gainIndex);
  });
});

describe('odd shapes', () => {
  it('the server own decimation floor is added on top of the offset', () => {
    const s = resolveDeviceSettings(FLOORED, cfg({ iqDecimation: 0 }), RX_MODE.AM);
    expect(s.decStage).toBe(s.iqDecimationOffset + 2);
    expect(s.iqRate).toBe(Math.round(2_400_000 / (1 << s.decStage)));
  });
  it('a device below every floor still resolves', () => {
    const tiny = info({ maxSampleRate: 48_000, decimationStages: 2, maxGainIndex: 4 });
    for (const mode of ALL_MODES) {
      const s = resolveDeviceSettings(tiny, cfg({ iqDecimation: 5 }), mode);
      expect(s.iqRate).toBeGreaterThan(0);
      expect(s.audioDecimate).toBeGreaterThanOrEqual(1);
      expect(s.decStage).toBeLessThanOrEqual(tiny.decimationStages);
    }
  });
  it('an empty config resolves to something usable', () => {
    const s = resolveDeviceSettings(V4, {}, RX_MODE.AM);
    expect(s.iqRate).toBeGreaterThanOrEqual(96_000);
    expect(s.gainIndex).toBe(RTL_MW_GAIN_INDEX);   // no frequency: the safe end
    expect(s.audioDecimate).toBeGreaterThanOrEqual(1);
  });
});

// Reported from the listening chair on 2026-09-21: strong stations audible on
// frequencies they are not on. Measured cause is gain, and the gain an 8 bit
// front end can stand is a property of the band, not of the demod mode.
describe('gain by band on an 8 bit front end', () => {
  const MW = 594_000, HF = 6_030_000;

  it('starts mediumwave at the bottom of the list and shortwave well up it', () => {
    expect(defaultGainIndex(V4, MW)).toBe(RTL_MW_GAIN_INDEX);
    expect(defaultGainIndex(V4, HF)).toBe(RTL_HF_GAIN_INDEX);
  });
  it('leaves every other receiver starting at its maximum', () => {
    for (const f of [MW, HF, 0]) {
      expect(defaultGainIndex(HFP, f)).toBe(HFP.maxGainIndex);
      expect(defaultGainIndex(AIRSPY_ONE, f)).toBe(AIRSPY_ONE.maxGainIndex);
    }
  });
  it('never asks for an index the device does not have', () => {
    const small = info({ deviceType: 3, maxGainIndex: 3 });
    expect(defaultGainIndex(small, HF)).toBe(3);
    expect(gainCeiling(small, MW)).toBeLessThanOrEqual(3);
  });
  it('treats an unknown frequency as mediumwave', () => {
    // Overload is the worse mistake: it hides stations rather than costing dB.
    expect(isMediumwave(0)).toBe(true);
    expect(defaultGainIndex(V4, 0)).toBe(RTL_MW_GAIN_INDEX);
  });
  it('puts the boundary at 2 MHz', () => {
    expect(isMediumwave(1_999_999)).toBe(true);
    expect(isMediumwave(2_000_000)).toBe(false);
  });

  // There was a mediumwave ceiling here for a day. It is gone: it applied when
  // a stream started and not when a gain was changed while listening, so the
  // control worked and then undid itself on the next connect. The band chooses
  // the default, and a value someone has actually chosen is theirs.
  it('keeps a stored gain on mediumwave rather than overriding it', () => {
    const s = resolveDeviceSettings(V4, cfg({ fmGain: 6 }), RX_MODE.DSB, MW);
    expect(s.gainIndex).toBe(6);
  });
  it('keeps that same stored gain on shortwave', () => {
    const s = resolveDeviceSettings(V4, cfg({ fmGain: 6 }), RX_MODE.DSB, HF);
    expect(s.gainIndex).toBe(6);
  });
  it('still clamps a stored gain to what the device has', () => {
    const s = resolveDeviceSettings(V4, cfg({ amGain: 99 }), RX_MODE.AM, MW);
    expect(s.gainIndex).toBe(V4.maxGainIndex);
  });
  it('does not cap a receiver that is not an 8 bit stick', () => {
    const s = resolveDeviceSettings(HFP, cfg({ amGain: 6 }), RX_MODE.AM, MW);
    expect(s.gainIndex).toBe(6);
  });
  it('changes nothing else about the resolution', () => {
    const a = resolveDeviceSettings(V4, cfg({ iqDecimation: 4 }), RX_MODE.AM, MW);
    const b = resolveDeviceSettings(V4, cfg({ iqDecimation: 4 }), RX_MODE.AM, HF);
    expect(a.iqRate).toBe(b.iqRate);
    expect(a.audioDecimate).toBe(b.audioDecimate);
    expect(a.decStage).toBe(b.decStage);
  });
});

// The field failure of 2026-09-21, which none of the above caught because they
// all stop at the resolver: filing a profile has to leave the other receivers'
// profiles alone. Writing this process's whole config back does not.
describe('filing a profile into the config on disk', () => {
  const v4: DeviceProfile = { iqDecimation: 4, amGain: 1, fmGain: 4, audioDecimate: 4 };
  const hf: DeviceProfile = { iqDecimation: 3, amGain: 1, fmGain: 4, audioDecimate: 4 };

  it('keeps the profiles it does not know about', () => {
    const onDisk: Record<string, unknown> = { host: 'x', devices: { '3:00000000': v4 } };
    mergeProfileIntoConfig(onDisk, '2:31313038', hf);
    expect(onDisk.devices).toEqual({ '3:00000000': v4, '2:31313038': hf });
  });
  it('survives a round trip in both directions', () => {
    const onDisk: Record<string, unknown> = {};
    mergeProfileIntoConfig(onDisk, '3:00000000', v4);
    mergeProfileIntoConfig(onDisk, '2:31313038', hf);
    mergeProfileIntoConfig(onDisk, '3:00000000', v4);
    expect(Object.keys(onDisk.devices as object).sort())
      .toEqual(['2:31313038', '3:00000000']);
  });
  it('leaves every other setting in the file untouched', () => {
    const onDisk: Record<string, unknown> = {
      host: '192.168.0.143', port: 8888, volume: 0.41, presets: [1, 2, 3],
    };
    mergeProfileIntoConfig(onDisk, '2:31313038', hf);
    expect(onDisk.host).toBe('192.168.0.143');
    expect(onDisk.port).toBe(8888);
    expect(onDisk.volume).toBe(0.41);
    expect(onDisk.presets).toEqual([1, 2, 3]);
  });
  it('applies the top-level values it is given', () => {
    const onDisk: Record<string, unknown> = { iqDecimation: 1, amGain: 7 };
    mergeProfileIntoConfig(onDisk, '3:00000000', v4, { iqDecimation: 4, amGain: 1 });
    expect(onDisk.iqDecimation).toBe(4);
    expect(onDisk.amGain).toBe(1);
  });
  it('creates the map when the file has none', () => {
    const onDisk: Record<string, unknown> = { host: 'x' };
    mergeProfileIntoConfig(onDisk, '2:31313038', hf);
    expect(onDisk.devices).toEqual({ '2:31313038': hf });
  });
  // A config is a file a human can edit, so `devices` can be anything.
  for (const junk of [null, 'nonsense', 42, [1, 2], true] as unknown[]) {
    it(`replaces a devices field that is ${JSON.stringify(junk)}`, () => {
      const onDisk: Record<string, unknown> = { devices: junk };
      mergeProfileIntoConfig(onDisk, '2:31313038', hf);
      expect(onDisk.devices).toEqual({ '2:31313038': hf });
    });
  }
});
