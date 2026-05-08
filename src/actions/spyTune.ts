import { action, KeyAction, KeyUpEvent, SingletonAction, WillAppearEvent, DidReceiveSettingsEvent, SendToPluginEvent } from '@elgato/streamdeck';
import streamDeck from '@elgato/streamdeck';
import type { JsonObject } from '@elgato/utils';
import { spyService } from '../spyService.js';
import { svgB64, tuneSvg } from '../icons.js';
import { formatFreqLabel } from '../dialDisplay.js';
import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { getJpStationsForRegion, type JpRegion, type JpStation } from '../japanStations.js';

// Path defaults to the SDR++ config dir for the production user. Overridable
// via DECK_RX_SDR_CONFIG_PATH so the unit-test harness can point at a
// fixture. (Same env-override convention as DECK_RX_CONFIG_PATH /
// DECK_RX_JP_STATIONS_PATH.)
const SDR_CONFIG_PATH = process.env.DECK_RX_SDR_CONFIG_PATH ??
  join(homedir(), 'Library/Application Support/sdrpp/frequency_manager_config.json');

interface SdrBookmark { frequency: number; bandwidth: number; mode: number; }
interface SdrList { bookmarks: Record<string, SdrBookmark>; }
interface SdrConfig { lists: Record<string, SdrList>; }

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
 *   1. SDR++ frequency_manager_config.json bookmarks (if available)
 *   2. JP DB entries for the requested region (auto entries tagged with
 *      `region` + manualStations entries either tagged for the same region
 *      or untagged = truly global)
 * On freq collision the JP DB entry overrides the SDR++ entry — preserves
 * the band-correct broadcaster name from the most recent scrape rather
 * than whatever label the user happened to set in SDR++. The freq +
 * bandwidth + mode of the SDR++ entry are still effectively replaced
 * (the preset cycler uses the JP DB defaults).
 * Result is sorted by freq ascending.
 */
export async function loadPresets(region?: JpRegion): Promise<Preset[]> {
  const sdr: Preset[] = [];
  try {
    const raw = await readFile(SDR_CONFIG_PATH, 'utf8');
    const cfg = JSON.parse(raw) as SdrConfig;
    for (const list of Object.values(cfg.lists)) {
      for (const [name, bm] of Object.entries(list.bookmarks)) {
        sdr.push({ name, freq: Math.round(bm.frequency), bandwidth: bm.bandwidth, mode: bm.mode });
      }
    }
  } catch { /* no SDR++ config — fall through to JP DB only */ }

  const byFreq = new Map<number, Preset>();
  for (const p of sdr) byFreq.set(p.freq, p);
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
