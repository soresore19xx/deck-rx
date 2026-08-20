// Tuning math, shared by the Stream Deck+ Tune dial (src/actions/spyDialTune.ts)
// and the local control server that drives the plugin from an external knob.
// Both paths MUST step identically: copying the formulas would let the Airspy
// HF+ 31–60 MHz hardware-gap handling drift apart between them.

import { bandsForDevice, snapToCoveredFreq, isFreqReceivable } from './deviceBands.js';
import type { DeviceInfo } from './SpyClient.js';

/**
 * Resolve the frequency a relative tick count lands on.
 *
 *   next = clamp0(baseHz + ticks * stepHz), then snapped to a covered band.
 *
 * Snapping keeps the user off a hardware-gap freq (Airspy HF+ has a 31–60 MHz
 * dead zone) and inside the device's published edges. The snap direction is
 * the sign of `ticks`, so stepping UP through a gap jumps to the next band's
 * lo and stepping DOWN jumps to the previous band's hi.
 *
 * `ticks === 0` snaps downwards, matching the dial's original expression
 * (`ticks > 0 ? 1 : -1`). A zero-tick call is a no-op rotate in practice; the
 * behaviour is pinned here only so callers cannot observe a difference.
 *
 * `dev` is `spyService.getDeviceInfo()`. When it is null — no DeviceInfo yet —
 * the band list is empty and snapToCoveredFreq returns the raw freq unclamped,
 * so an early rotate is never silently swallowed.
 */
export function nextFreqForTicks(
  baseHz: number,
  ticks: number,
  stepHz: number,
  dev: DeviceInfo | null,
): number {
  const raw = Math.max(0, baseHz + ticks * stepHz);
  const bands = dev ? bandsForDevice(dev.deviceType, dev.minFrequency, dev.maxFrequency) : [];
  const dir = ticks > 0 ? 1 : -1;
  return snapToCoveredFreq(raw, bands, dir);
}

/** The two preset fields the slot walk needs. Preset itself carries more. */
export interface PresetSlot { freq: number; mode: number; }

/**
 * Walk the preset list by `ticks` slots and return where we land, or null when
 * there is nothing to land on.
 *
 * Presets the connected hardware cannot receive are skipped: an Airspy HF+ has
 * a 31–60 MHz hardware gap, so a 50 MHz NFM entry exists on disk but is not
 * tunable. When NO preset in the list is covered, the walk gives up and
 * returns null so the caller leaves state alone rather than landing on a
 * frequency that would only produce noise.
 *
 * The list wraps in both directions. `ticks === 0` counts as one step forward,
 * matching the dial's original expression (`ticks >= 0 ? 1 : -1` with a
 * minimum of one step) — a zero-tick rotate is not a thing the hardware emits.
 */
export function nextPresetSlot(
  presets: readonly PresetSlot[],
  slotIndex: number,
  ticks: number,
  dev: DeviceInfo | null,
): number | null {
  const len = presets.length;
  if (len === 0) return null;
  const isCovered = (idx: number): boolean => {
    const p = presets[idx];
    return !!p && (!dev || isFreqReceivable(p.freq, dev.deviceType, dev.minFrequency, dev.maxFrequency));
  };
  const dir = ticks >= 0 ? 1 : -1;
  const steps = Math.max(1, Math.abs(ticks));
  let next = slotIndex;
  let landed = false;
  for (let s = 0; s < steps; s++) {
    let attempts = len;
    do {
      next = ((next + dir) % len + len) % len;
      attempts--;
    } while (!isCovered(next) && attempts > 0);
    if (!isCovered(next)) return null;
    landed = true;
  }
  return landed ? next : null;
}
