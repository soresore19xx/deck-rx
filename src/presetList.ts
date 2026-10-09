// The preset list, split out of actions/spyTune.ts so it can be loaded without
// the Stream Deck SDK. The control server needs it for /preset, and the
// headless entry must not drag the plugin runtime in through that import.
// actions/spyTune.ts re-exports these, so existing importers are unaffected.

import { type JpRegion } from './japanStations.js';
import { loadDeckRxPresets, flattenPresets } from './presets.js';

export interface Preset { name: string; freq: number; bandwidth: number; mode: number; }
type TuneSettings = { slot?: number };

// presetsCache keyed on the region it was built for so a region-switch
// invalidates the previous list. Null = unfilled.
let presetsCache: Preset[] | null = null;
let presetsCacheRegion: JpRegion | undefined | null = null;

/**
 * Build the preset list. SDR++'s frequency_manager_config.json (imported via
 * the PI "Import from SDR++" button into the deck-rx-owned presets.json)
 * is the SOLE SOURCE of preset records — the count equals the bookmark
 * file's entry count regardless of active region.
 *
 * The `region` argument is kept for cache-keying because the dial's
 * render-time `autoStationLabel(freq, region)` enriches each row's
 * displayed name from the JP DB / callsign DB for the active region, and
 * the cache should rebuild on a region switch so the PI list refreshes
 * its labels. Records themselves are NOT added from the JP DB — earlier
 * we merged in every region station which inflated the preset roster
 * with entries the user never imported.
 *
 * Result is sorted by freq ascending.
 */
export async function loadPresets(region?: JpRegion): Promise<Preset[]> {
  const file = await loadDeckRxPresets();
  const local: Preset[] = flattenPresets(file).map(b => ({
    name: b.name, freq: b.freq, bandwidth: b.bandwidth, mode: b.mode,
  }));
  const result = local.sort((a, b) => a.freq - b.freq);
  presetsCache = result;
  presetsCacheRegion = region;
  return result;
}

/** Drop the cached preset list — call after a region switch so the next
 *  getPreset() rebuilds against the new region's JP DB pool. */
const presetsChangedListeners = new Set<() => void>();
/** Called when the preset file changed under the plugin (a sync brought in
 *  another device's edit): whoever holds a copy of the list re-reads it. */
export function subscribePresetsChanged(fn: () => void): void { presetsChangedListeners.add(fn); }
export function unsubscribePresetsChanged(fn: () => void): void { presetsChangedListeners.delete(fn); }
export function notifyPresetsChanged(): void {
  clearPresetsCache();
  for (const fn of presetsChangedListeners) { try { fn(); } catch { /* one listener does not stop the rest */ } }
}

export function clearPresetsCache(): void {
  presetsCache = null;
  presetsCacheRegion = null;
}
