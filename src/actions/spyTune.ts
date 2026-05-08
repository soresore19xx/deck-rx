import { action, KeyAction, KeyUpEvent, SingletonAction, WillAppearEvent, DidReceiveSettingsEvent, SendToPluginEvent } from '@elgato/streamdeck';
import streamDeck from '@elgato/streamdeck';
import type { JsonObject } from '@elgato/utils';
import { spyService } from '../spyService.js';
import { svgB64, tuneSvg } from '../icons.js';
import { formatFreqLabel } from '../dialDisplay.js';
import { getJpStationsForRegion, type JpRegion, type JpStation } from '../japanStations.js';
import { loadDeckRxPresets, flattenPresets } from '../presets.js';

const MODES = ['NFM', 'WFM', 'AM', 'DSB', 'USB', 'CW', 'LSB', 'RAW'];
export interface Preset { name: string; freq: number; bandwidth: number; mode: number; }
type TuneSettings = { slot?: number };

// presetsCache keyed on the region it was built for so a region-switch
// invalidates the previous list. Null = unfilled.
let presetsCache: Preset[] | null = null;
let presetsCacheRegion: JpRegion | undefined | null = null;

/** Convert a JP DB station entry into the same Preset shape SDR++ uses, so
 *  both sources merge cleanly into one list.
 *  Bandwidth defaults: FM band → 200 kHz, MW band → 9 kHz.
 *  Mode: FM band → 1 (WFM), MW band → 2 (AM). */
function jpStationToPreset(s: JpStation): Preset {
  const isFm = s.band === 'FM';
  return {
    name: s.name,
    freq: s.freqHz,
    bandwidth: isFm ? 200_000 : 9_000,
    mode: isFm ? 1 : 2,
  };
}

/**
 * Build the full preset list, optionally tagged for a JP region.
 * Sources, in merge order:
 *   1. deck-rx-owned presets.json bookmarks (UTF-8 clean, supports CJK
 *      broadcaster names — populated by hand or via the PI "Import from
 *      SDR++" button which reads SDR++'s frequency_manager_config.json)
 *   2. JP DB entries for the requested region (auto entries tagged with
 *      region + manualStations entries either tagged for the same region
 *      or untagged = truly global)
 * On freq collision the JP DB entry overrides the deck-rx entry —
 * preserves the band-correct broadcaster name from the most recent scrape
 * rather than whatever label the user typed in. The freq + bandwidth +
 * mode of the deck-rx entry are still effectively replaced (the preset
 * cycler uses the JP DB defaults).
 * Result is sorted by freq ascending.
 */
export async function loadPresets(region?: JpRegion): Promise<Preset[]> {
  const file = await loadDeckRxPresets();
  const local: Preset[] = flattenPresets(file).map(b => ({
    name: b.name, freq: b.freq, bandwidth: b.bandwidth, mode: b.mode,
  }));

  const byFreq = new Map<number, Preset>();
  for (const p of local) byFreq.set(p.freq, p);
  if (region) {
    for (const s of getJpStationsForRegion(region)) {
      byFreq.set(s.freqHz, jpStationToPreset(s));  // JP DB wins on freq collision
    }
  }
  const result = Array.from(byFreq.values()).sort((a, b) => a.freq - b.freq);
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
