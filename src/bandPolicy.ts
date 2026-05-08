// Band-policy helpers — small, side-effect-free decisions about which demod
// mode applies to a given frequency. Lives in its own module so the test
// harness can exercise the logic without pulling in the Stream Deck SDK or
// the spyService singleton.

/**
 * Pick the demod mode for a given freq when VFO-tuning across band boundaries.
 * USB / LSB / CW are intentionally not produced — they are listed in the PI
 * MODES array but the demodulator currently falls through to processFM for any
 * non-AM / non-WFM mode, so AM is the safer pick across MF / HF.
 *
 *   522 kHz – 1.71 MHz  →  AM   (Japanese MW)
 *   1.8 MHz – 30 MHz    →  AM   (SW broadcast — narrow-AM is the workable fallback)
 *   30 MHz – 76 MHz     →  NFM  (VHF low)
 *   76 MHz – 108 MHz    →  WFM  (FM broadcast band)
 *   > 108 MHz           →  NFM  (air / VHF / UHF)
 *   anything else       →  null (do not change current mode)
 */
export function autoDemodForFreq(hz: number): number | null {
  if (hz >=     522_000 && hz <=   1_710_000) return 2;
  if (hz >=   1_800_000 && hz <=  30_000_000) return 2;
  if (hz >=  30_000_000 && hz <   76_000_000) return 0;
  if (hz >=  76_000_000 && hz <= 108_000_000) return 1;
  if (hz >  108_000_000)                      return 0;
  return null;
}
