// Settings whose right value depends on WHICH receiver is connected.
//
// The port of native-app/Sources/DeviceSettings.swift, rule for rule. The two
// cannot share code, so they share this comment instead: any change here has to
// land there as well, and both are covered by tests that spell out the same
// numbers (test/deviceSettings.test.ts and Tests/DeviceSettingsTests.swift).
//
// The problem: several settings travel as offsets and divisors rather than
// absolute values. `iqDecimation` is a number of halvings, `audioDecimate` is a
// divisor, and a gain is an index into a list whose length the device chooses.
// A value picked on one receiver therefore means something different on the
// next, and deck-rx stored exactly one set.
//
// On 2026-09-21 that broke in the field. Pointing a client at a second
// SpyServer carrying an RTL-SDR Blog V4, while carrying the Airspy HF+'s stored
// `iqDecimation: 0`, asked for 2.4 MHz. It connected, reported canControl, never
// tuned at all, and produced nothing but noise.
//
// SDR++ avoids this by keying a `devices` map by name and serial in every
// source config it writes (spyserver_config.json, rtl_sdr_config.json,
// airspyhf_config.json). `Config.devices` is the same idea.

import { DEVICE_RTLSDR, type DeviceInfo } from './SpyClient.js';

/** 0=NFM 1=WFM 2=AM 3=DSB, as `demodMode` has always numbered them. */
export const RX_MODE = { NFM: 0, WFM: 1, AM: 2, DSB: 3 } as const;

/** Stereo lives on WFM alone. */
export function isWideFM(mode: number): boolean { return mode === RX_MODE.WFM; }

/** What differs per receiver. Absolutes (frequency, bandwidth, volume) do not. */
export interface DeviceProfile {
  iqDecimation?: number;
  amGain?: number;
  fmGain?: number;
  audioDecimate?: number;
}

export interface DeviceSettings {
  /** Absolute stage sent to the server: offset plus the device's own floor. */
  decStage: number;
  iqRate: number;
  /** Clamped to this device's maxGainIndex. */
  gainIndex: number;
  audioDecimate: number;
  /** The offset that produced decStage, i.e. what belongs in the profile. */
  iqDecimationOffset: number;
}

/**
 * Lowest IQ rate that still carries the mode. WFM occupies about 100 kHz once
 * deviation and the stereo subcarrier are counted; everything else here is
 * narrow (NFM 12.5 kHz, AM 9 kHz, SSB under 3 kHz). 96 kHz is also what the
 * unattended probes ask for, so a capture and a listen agree.
 */
export function minIQRate(mode: number): number {
  return isWideFM(mode) ? 200_000 : 96_000;
}

/**
 * Highest IQ rate to pick on a device's behalf. Not a hardware limit — a
 * refusal to default anywhere near a device's maximum. SpyServer's RTL-SDR
 * support is thin (its own floor for these sits at 24 MHz until
 * minimum_frequency is set) and SDRangel carries the same shape of bug: issue
 * #2521, "Decimation lower than 16/8 causes reception issues on RTL-SDR Blog
 * V4". A user who asks for the top rate still gets it.
 */
export const MAX_AUTO_IQ_RATE = 1_000_000;

/**
 * Lowest audio rate that still carries the mode. WFM stereo puts its pilot at
 * 19 kHz and the difference signal at 38 kHz, so nothing below 76 kHz keeps
 * stereo at all. NFM's 12.5 kHz is happy at 48 kHz. AM, DSB, SSB and CW live
 * inside a few kHz.
 *
 * Getting this wrong is not subtle and has happened here: a 9.5 kHz audio rate
 * once put a 6 kHz tone out at 3.5 kHz.
 */
export function minAudioRate(mode: number): number {
  if (mode === RX_MODE.WFM) return 96_000;
  if (mode === RX_MODE.NFM) return 48_000;
  return 24_000;
}

/** Stable identity: the type alone will not do, two RTL dongles are both 3. */
export function deviceKey(type: number, serial: number): string {
  return `${type}:${(serial >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}

/**
 * IQ rate a given offset would produce on this device.
 *
 * `Math.pow`, not `1 << n`: JavaScript's shift is 32 bit and takes its count
 * modulo 32, so a nonsense stored offset of 99 becomes a shift of 3 and a
 * perfectly reasonable-looking 300 kHz — which then passes the sanity check and
 * gets sent to the server. (Swift's `<<` returns 0 for an over-wide shift, so
 * the port did not have this hole and the shared tests caught the difference.)
 */
export function iqRateFor(info: DeviceInfo, offset: number): number {
  return info.maxSampleRate / Math.pow(2, offset + info.minIQDecimation);
}

/**
 * Keep a stored offset while the rate it produces is usable here; otherwise the
 * lowest rate that still covers the mode.
 */
export function decimationOffset(info: DeviceInfo, stored: number, mode: number): number {
  const floor = minIQRate(mode);
  const storedRate = iqRateFor(info, stored);
  if (storedRate >= floor && storedRate <= MAX_AUTO_IQ_RATE) return stored;
  let s = 0;
  while (s + 1 <= info.decimationStages && iqRateFor(info, s + 1) >= floor) s++;
  return s;
}

/** Halve a stored divisor until the audio rate clears the mode's floor. */
export function audioDecimation(iqRate: number, mode: number, stored: number): number {
  const floor = minAudioRate(mode);
  // A config is a file a human can edit, so `stored` can be anything at all.
  // Math.floor(NaN) is NaN and Math.max(1, NaN) is NaN, which would divide the
  // audio rate into nothing without ever throwing.
  const n = Math.floor(stored);
  let d = Number.isFinite(n) && n >= 1 ? n : 1;
  while (d > 1 && iqRate / d < floor) d = Math.floor(d / 2);
  return Math.max(1, d);
}

/**
 * Where to start a receiver's gain when nothing has been stored for it.
 *
 * An 8 bit front end is a different proposition: on the V4 the top of the range
 * saturates mediumwave outright. Measured 2026-09-21 at 774 kHz — C/N 31.7 dB
 * at index 0, 11.6 at 1, 3.1 at 2 — while the strong locals (594/810/954/1134/
 * 1242, all powerful in central Tokyo) barely moved and hid the collapse.
 */
export function defaultGainIndex(info: DeviceInfo, freqHz = 0): number {
  if (info.deviceType !== DEVICE_RTLSDR) return info.maxGainIndex;
  const idx = isMediumwave(freqHz) ? RTL_MW_GAIN_INDEX : RTL_HF_GAIN_INDEX;
  return Math.min(idx, info.maxGainIndex);
}

/**
 * Where mediumwave stops mattering for this decision. Below it sit the local
 * transmitters that saturate an 8 bit front end; above it the band is quiet
 * enough that the same setting throws away sensitivity.
 */
export const RTL_MW_TOP_HZ = 2_000_000;
/** ~0.9 dB on the tuner's 29 step list: 0.00% clipped, and within 0.7 dB of
 *  the HF+ on the same antenna (594 kHz, 2026-09-21). */
export const RTL_MW_GAIN_INDEX = 1;
/** ~32.8 dB, the same list. Nothing saturates on shortwave and the floor of
 *  the list throws about 6 dB of SNR away (measured the same day). */
export const RTL_HF_GAIN_INDEX = 17;

/** An unknown frequency counts as mediumwave: overload is the worse mistake. */
export function isMediumwave(freqHz: number): boolean {
  return !(freqHz >= RTL_MW_TOP_HZ);
}

/**
 * The highest gain index worth allowing here — a ceiling, not a preference.
 *
 * On an 8 bit front end tuned to mediumwave, gain is not a trade: it is
 * destructive. Measured 2026-09-21 on the V4 through the same antenna, index 0
 * against index 5: the 594 kHz carrier fell from 51 to 32 dB over the floor,
 * the noise floor at 1100 kHz rose by 39 dB, the count of stations visible
 * around 750 kHz went from 11 to 3, and the band filled with narrow peaks off
 * the 9 kHz raster — stations that are not there. A stored gain from another
 * band (deck-rx keeps one per demod mode, so SSB on mediumwave would reach for
 * the shortwave value) must not be able to do that.
 */
export function gainCeiling(info: DeviceInfo, freqHz: number): number {
  if (info.deviceType === DEVICE_RTLSDR && isMediumwave(freqHz)) {
    return Math.min(RTL_MW_GAIN_INDEX, info.maxGainIndex);
  }
  return info.maxGainIndex;
}

/** Everything above, applied in order, for one connection. */
export function resolveDeviceSettings(
  info: DeviceInfo,
  cfg: { iqDecimation?: number; audioDecimate?: number; amGain?: number; fmGain?: number;
         devices?: Record<string, DeviceProfile> },
  mode: number,
  freqHz = 0,
): DeviceSettings {
  const profile = cfg.devices?.[deviceKey(info.deviceType, info.deviceSerial)];

  const offset = decimationOffset(info, profile?.iqDecimation ?? cfg.iqDecimation ?? 1, mode);
  const decStage = offset + info.minIQDecimation;
  const iqRate = Math.round(info.maxSampleRate / Math.pow(2, decStage));

  const storedGain = mode === RX_MODE.AM ? (profile?.amGain ?? cfg.amGain)
                                         : (profile?.fmGain ?? cfg.fmGain);
  const gainIndex = Math.min(storedGain ?? defaultGainIndex(info, freqHz),
                             gainCeiling(info, freqHz));

  const audioDecimate = audioDecimation(
    iqRate, mode, profile?.audioDecimate ?? cfg.audioDecimate ?? 1);

  return { decStage, iqRate, gainIndex, audioDecimate, iqDecimationOffset: offset };
}

/**
 * Fold resolved settings back into the config and file them under this
 * receiver, so the next connection restores them rather than re-deriving them.
 * Mutates `cfg` in place, the way the plugin's config is handled elsewhere.
 */
export function adoptDeviceSettings(
  s: DeviceSettings,
  cfg: { iqDecimation?: number; audioDecimate?: number; amGain?: number; fmGain?: number;
         devices?: Record<string, DeviceProfile> },
  info: DeviceInfo,
  mode: number,
): void {
  cfg.iqDecimation = s.iqDecimationOffset;
  cfg.audioDecimate = s.audioDecimate;
  if (mode === RX_MODE.AM) cfg.amGain = s.gainIndex; else cfg.fmGain = s.gainIndex;
  if (!cfg.devices) cfg.devices = {};
  cfg.devices[deviceKey(info.deviceType, info.deviceSerial)] = {
    iqDecimation: s.iqDecimationOffset,
    amGain: cfg.amGain,
    fmGain: cfg.fmGain,
    audioDecimate: s.audioDecimate,
  };
}

/**
 * Merge one receiver's profile into the config as it sits on disk.
 *
 * The point is the word merge. Writing this process's whole config back —
 * which is what the first version of this did — replaces the `devices` map
 * with whatever this process happens to hold, and every profile it does not
 * know about is lost. Measured on the deck on 2026-09-21: connect to the V4,
 * which files `3:00000000`, reconnect to the HF+, and the V4's entry was gone.
 *
 * `onDisk` is mutated and returned, so the caller can write it straight out.
 * A `devices` that is missing, null, or not an object at all (a config is a
 * file a human can edit) is replaced by a fresh map rather than crashing.
 */
export function mergeProfileIntoConfig(
  onDisk: Record<string, unknown>,
  key: string,
  profile: DeviceProfile,
  top: Record<string, unknown> = {},
): Record<string, unknown> {
  Object.assign(onDisk, top);
  const existing = onDisk.devices;
  const devices: Record<string, unknown> =
    existing !== null && typeof existing === 'object' && !Array.isArray(existing)
      ? existing as Record<string, unknown>
      : {};
  devices[key] = profile;
  onDisk.devices = devices;
  return onDisk;
}
