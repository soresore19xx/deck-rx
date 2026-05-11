import { action, KeyAction, KeyUpEvent, SingletonAction, WillAppearEvent, DidReceiveSettingsEvent, SendToPluginEvent } from '@elgato/streamdeck';
import streamDeck from '@elgato/streamdeck';
import type { JsonObject } from '@elgato/utils';
import { spyService } from '../spyService.js';
import { svgB64, tuneSvg } from '../icons.js';
import { formatFreqLabel } from '../dialDisplay.js';
import { type JpRegion } from '../japanStations.js';
import { loadDeckRxPresets, flattenPresets } from '../presets.js';
import { isFreqReceivable } from '../deviceBands.js';

const MODES = ['NFM', 'WFM', 'AM', 'DSB', 'USB', 'CW', 'LSB', 'RAW'];
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
export function clearPresetsCache(): void {
  presetsCache = null;
  presetsCacheRegion = null;
}

async function getPreset(slot: number): Promise<Preset | null> {
  // Refresh the cache if the active region has changed since it was last
  // built (region switch from PI fires this implicitly via clearPresetsCache,
  // but a defensive comparison here keeps slotting consistent if a caller
  // forgot to invalidate).
  const activeRegion = spyService.getJpActiveRegion();
  if (!presetsCache || presetsCacheRegion !== activeRegion) {
    presetsCache = await loadPresets(activeRegion).catch(() => []);
  }
  const p = presetsCache[slot - 1];
  return p?.freq ? p : null;
}

function slotTitle(p: Preset | null, slot: number): string {
  if (!p) return `#${slot}\n---`;
  return `${p.name}\n${formatFreqLabel(p.freq)}`;
}

// suppress unused import warning
void MODES;

@action({ UUID: 'com.hogehoge.deck-rx.tune' })
export class SpyTune extends SingletonAction<TuneSettings> {
  override async onWillAppear(ev: WillAppearEvent<TuneSettings>): Promise<void> {
    const slot = ev.payload.settings.slot ?? 1;
    const p = await getPreset(slot);
    await (ev.action as KeyAction<TuneSettings>).setImage(svgB64(tuneSvg()));
    await ev.action.setTitle(slotTitle(p, slot));
    spyService.connect().catch((e) => streamDeck.logger.error(`[spyTune] ${e}`));
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<TuneSettings>): Promise<void> {
    const slot = ev.payload.settings.slot ?? 1;
    const p = await getPreset(slot);
    await ev.action.setTitle(slotTitle(p, slot));
  }

  override async onKeyUp(ev: KeyUpEvent<TuneSettings>): Promise<void> {
    const slot = ev.payload.settings.slot ?? 1;
    const p = await getPreset(slot);
    if (!p) return;
    // Refuse the tune if the connected device's hardware can't reach this
    // freq (Airspy HF+ has a 31–60 MHz gap, etc.). Without this guard a
    // slot bound to e.g. 50 MHz would silently send a freq the SDR can't
    // tune and the user would just hear noise.
    const dev = spyService.getDeviceInfo();
    if (dev && !isFreqReceivable(p.freq, dev.deviceType, dev.minFrequency, dev.maxFrequency)) {
      await (ev.action as KeyAction<TuneSettings>).showAlert();
      return;
    }
    spyService.setDemodMode(p.mode);
    spyService.setFrequency(p.freq);
    await (ev.action as KeyAction<TuneSettings>).showOk();
  }

  override async onSendToPlugin(ev: SendToPluginEvent<JsonObject, TuneSettings>): Promise<void> {
    if (ev.payload['action'] === 'getPresets') {
      const presets = await loadPresets().catch(() => []);
      await streamDeck.ui.sendToPropertyInspector({
        action: 'presets',
        presets: presets as unknown as JsonObject[],
      });
    }
  }
}
