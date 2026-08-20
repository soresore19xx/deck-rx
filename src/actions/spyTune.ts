import { action, KeyAction, KeyUpEvent, SingletonAction, WillAppearEvent, DidReceiveSettingsEvent, SendToPluginEvent } from '@elgato/streamdeck';
import streamDeck from '@elgato/streamdeck';
import type { JsonObject } from '@elgato/utils';
import { spyService } from '../spyService.js';
import { svgB64, tuneSvg } from '../icons.js';
import { formatFreqLabel } from '../dialDisplay.js';
import { isFreqReceivable } from '../deviceBands.js';

const MODES = ['NFM', 'WFM', 'AM', 'DSB', 'USB', 'CW', 'LSB', 'RAW'];
export { type Preset, loadPresets, clearPresetsCache } from '../presetList.js';

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
