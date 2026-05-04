import { action, KeyAction, KeyUpEvent, SingletonAction, WillAppearEvent, DidReceiveSettingsEvent, SendToPluginEvent } from '@elgato/streamdeck';
import streamDeck from '@elgato/streamdeck';
import type { JsonObject } from '@elgato/utils';
import { spyService } from '../spyService.js';
import { svgB64, tuneSvg } from '../icons.js';
import { formatFreqLabel } from '../dialDisplay.js';
import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

const SDR_CONFIG_PATH = join(homedir(), 'Library/Application Support/sdrpp/frequency_manager_config.json');

interface SdrBookmark { frequency: number; bandwidth: number; mode: number; }
interface SdrList { bookmarks: Record<string, SdrBookmark>; }
interface SdrConfig { lists: Record<string, SdrList>; }

const MODES = ['NFM', 'WFM', 'AM', 'DSB', 'USB', 'CW', 'LSB', 'RAW'];
export interface Preset { name: string; freq: number; bandwidth: number; mode: number; }
type TuneSettings = { slot?: number };

let presetsCache: Preset[] | null = null;

export async function loadPresets(): Promise<Preset[]> {
  const raw = await readFile(SDR_CONFIG_PATH, 'utf8');
  const cfg = JSON.parse(raw) as SdrConfig;
  const result: Preset[] = [];
  for (const list of Object.values(cfg.lists)) {
    for (const [name, bm] of Object.entries(list.bookmarks)) {
      result.push({ name, freq: Math.round(bm.frequency), bandwidth: bm.bandwidth, mode: bm.mode });
    }
  }
  result.sort((a, b) => a.freq - b.freq);
  presetsCache = result;
  return result;
}

async function getPreset(slot: number): Promise<Preset | null> {
  if (!presetsCache) presetsCache = await loadPresets().catch(() => []);
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
