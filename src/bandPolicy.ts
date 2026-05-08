// Band-policy helpers — small, side-effect-free decisions about which demod
// mode applies to a given frequency. Lives in its own module so the test
// harness can exercise the logic without pulling in the Stream Deck SDK or
// the spyService singleton.
//
// Demod mode numbers (matching MODES = ['NFM','WFM','AM','DSB','USB','CW','LSB','RAW']):
//   0 = NFM, 1 = WFM, 2 = AM, 4 = USB, 5 = CW, 6 = LSB

/**
 * Pick the demod mode for a given freq when VFO-tuning across band boundaries.
 *
 * Coverage (JA Region-3 amateur band conventions; see also IARU Region 3 band plan):
 *
 *   MW (522 kHz – 1.710 MHz)            →  AM
 *
 *   160 m amateur 1.810 – 1.825 MHz      →  CW
 *   160 m amateur 1.825 – 1.875 MHz      →  LSB
 *
 *   80 m amateur 3.500 – 3.525 MHz       →  CW
 *   80 m amateur 3.525 – 3.805 MHz       →  LSB
 *
 *   40 m amateur 7.000 – 7.030 MHz       →  CW
 *   40 m amateur 7.030 – 7.200 MHz       →  LSB
 *
 *   20 m amateur 14.000 – 14.070 MHz     →  CW
 *   20 m amateur 14.070 – 14.350 MHz     →  USB
 *
 *   15 m amateur 21.000 – 21.070 MHz     →  CW
 *   15 m amateur 21.070 – 21.450 MHz     →  USB
 *
 *   10 m amateur 28.000 – 28.070 MHz     →  CW
 *   10 m amateur 28.070 – 29.700 MHz     →  USB
 *
 *   SW broadcast (rest of 1.8 – 30 MHz)  →  AM (international shortwave broadcast)
 *
 *   VHF low 30 – 76 MHz                  →  NFM
 *   FM broadcast 76 – 108 MHz            →  WFM
 *   VHF / UHF > 108 MHz                  →  NFM
 *
 *   anything else (gaps below MW etc.)   →  null (do not change current mode)
 *
 * Note: only the lower CW segment of each amateur band is hard-coded; the
 * higher CW / data sub-segments (e.g. 14.070–14.099 MHz on 20 m) blur into
 * the SSB segment in practice and are left to the SSB pick. Operators who
 * want CW outside the dial-defined CW slice can flip Mode manually in PI.
 */
export function autoDemodForFreq(hz: number): number | null {
  // MW
  if (hz >=     522_000 && hz <=   1_710_000) return 2;

  // 160 m
  if (hz >=   1_810_000 && hz <    1_825_000) return 5;
  if (hz >=   1_825_000 && hz <    1_875_000) return 6;

  // 80 m
  if (hz >=   3_500_000 && hz <    3_525_000) return 5;
  if (hz >=   3_525_000 && hz <    3_805_000) return 6;

  // 40 m
  if (hz >=   7_000_000 && hz <    7_030_000) return 5;
  if (hz >=   7_030_000 && hz <=   7_200_000) return 6;

  // 20 m
  if (hz >=  14_000_000 && hz <   14_070_000) return 5;
  if (hz >=  14_070_000 && hz <=  14_350_000) return 4;

  // 15 m
  if (hz >=  21_000_000 && hz <   21_070_000) return 5;
  if (hz >=  21_070_000 && hz <=  21_450_000) return 4;

  // 10 m
  if (hz >=  28_000_000 && hz <   28_070_000) return 5;
  if (hz >=  28_070_000 && hz <=  29_700_000) return 4;

  // SW broadcast and other HF outside amateur bands
  if (hz >=   1_800_000 && hz <=  30_000_000) return 2;

  // VHF / FM / above
  if (hz >=  30_000_000 && hz <   76_000_000) return 0;
  if (hz >=  76_000_000 && hz <= 108_000_000) return 1;
  if (hz >  108_000_000)                      return 0;
  return null;
}
