import { action, DialDownEvent, DialRotateEvent, DialUpEvent, SingletonAction, WillAppearEvent, WillDisappearEvent, DidReceiveSettingsEvent, SendToPluginEvent } from '@elgato/streamdeck';
import streamDeck from '@elgato/streamdeck';
import type { JsonObject } from '@elgato/streamdeck';
import { getAudioOutputDevices, getCurrentAudioOutput } from '../audioDevices.js';
import { spyService } from '../spyService.js';
import { SyncInfo } from '../SpyClient.js';
import { svgB64, knobSvg } from '../icons.js';
import { makeHeaderSvg, makeBorderSvg, seg7svg, freqParts, rssiBandSvg, snrBarSvg } from '../dialDisplay.js';
import { loadPresets, Preset } from './spyTune.js';

type DialTuneSettings = {
  mode?: 'preset' | 'vfo';
  stepHz?: number;
  slotIndex?: number;
  borderSide?: 'left' | 'right' | 'center' | 'none';
};

const MODES = ['NFM','WFM','AM','DSB','USB','CW','LSB','RAW'];

function formatStep(hz: number): string {
  if (hz >= 1_000_000) return `${hz / 1_000_000}M`;
  if (hz >= 1_000)     return `${hz / 1_000}k`;
  return `${hz}`;
}

@action({ UUID: 'com.hogehoge.spyserver-ex.dial-tune' })
export class SpyDialTune extends SingletonAction<DialTuneSettings> {
  private dialMode: 'preset' | 'vfo' = 'preset';
  private currentFreq = 0;
  private stepHz = 9000;
  private slotIndex = 0;
  private borderSide: 'left'|'right'|'center'|'none' = 'none';
  private syncListener: ((s: SyncInfo) => void) | null = null;
  private connectListener: (() => void) | null = null;
  private tuneTimer: ReturnType<typeof setTimeout> | null = null;
  private lastAction: unknown = null;
  private presets: Preset[] = [];
  private footerTimer: ReturnType<typeof setInterval> | null = null;

  override async onWillAppear(ev: WillAppearEvent<DialTuneSettings>): Promise<void> {
    this.dialMode   = ev.payload.settings.mode ?? 'preset';
    this.stepHz     = ev.payload.settings.stepHz ?? 9000;
    this.slotIndex  = ev.payload.settings.slotIndex ?? 0;
    this.borderSide = ev.payload.settings.borderSide ?? 'none';
    this.lastAction = ev.action;
    this.presets = await loadPresets().catch(() => []);
    if (spyService.currentFreq > 0) this.currentFreq = spyService.currentFreq;

    this.syncListener = (s: SyncInfo) => {
      if (this.dialMode === 'vfo') {
        this.currentFreq = s.iqCenterFreq;
        this.updateDisplay(this.lastAction).catch(() => {});
      }
    };
    spyService.subscribe(this.syncListener);

    this.connectListener = () => {
      if (this.dialMode === 'preset' && this.presets.length > 0) {
        const p = this.presets[this.slotIndex];
        if (p?.freq) {
          if (spyService.currentFreq === 0) {
            // First run, no persisted state — seed freq + mode.
            spyService.setDemodMode(p.mode);
            spyService.setFrequency(p.freq);
          } else if (spyService.currentFreq === p.freq) {
            // The restored freq is OUR preset — make sure mode matches it,
            // covering older configs where demodMode lagged the freq change.
            spyService.setDemodMode(p.mode);
          }
        }
      } else if (this.dialMode === 'vfo' && this.currentFreq > 0 && spyService.currentFreq === 0) {
        spyService.setFrequency(this.currentFreq);
      }
      this.updateDisplay(this.lastAction).catch(() => {});
    };
    spyService.onConnect(this.connectListener);

    await ev.action.setImage(svgB64(knobSvg()));
    spyService.connect().catch((e) => streamDeck.logger.error(`[spyDialTune] ${e}`));
    // Periodically refresh footer (stereo-lock indicator updates from pilot power)
    this.footerTimer = setInterval(() => { this.updateDisplay(this.lastAction).catch(() => {}); }, 1000);
    await this.updateDisplay(ev.action);
  }

  override onWillDisappear(_ev: WillDisappearEvent<DialTuneSettings>): void {
    if (this.syncListener) { spyService.unsubscribe(this.syncListener); this.syncListener = null; }
    if (this.connectListener) { spyService.offConnect(this.connectListener); this.connectListener = null; }
    if (this.tuneTimer) { clearTimeout(this.tuneTimer); this.tuneTimer = null; }
    if (this.footerTimer) { clearInterval(this.footerTimer); this.footerTimer = null; }
    this.lastAction = null;
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<DialTuneSettings>): Promise<void> {
    this.dialMode   = ev.payload.settings.mode ?? 'preset';
    this.stepHz     = ev.payload.settings.stepHz ?? 9000;
    this.slotIndex  = ev.payload.settings.slotIndex ?? 0;
    this.borderSide = ev.payload.settings.borderSide ?? 'none';
    this.presets = await loadPresets().catch(() => []);
    await this.updateDisplay(ev.action);
  }

  override async onDialRotate(ev: DialRotateEvent<DialTuneSettings>): Promise<void> {
    if (this.dialMode === 'preset') {
      if (!this.presets.length) return;
      this.slotIndex = ((this.slotIndex + ev.payload.ticks) % this.presets.length + this.presets.length) % this.presets.length;
      await ev.action.setSettings({ ...ev.payload.settings, slotIndex: this.slotIndex });
      const p = this.presets[this.slotIndex];
      this.currentFreq = p.freq;
      spyService.setDemodMode(p.mode);
      spyService.setFrequency(p.freq);
      await this.updateDisplay(ev.action);
    } else {
      const base = this.currentFreq > 0 ? this.currentFreq : spyService.currentFreq;
      if (base <= 0) return;
      const next = Math.max(0, base + ev.payload.ticks * this.stepHz);
      this.currentFreq = next;
      await this.updateDisplay(ev.action);
      if (this.tuneTimer) clearTimeout(this.tuneTimer);
      this.tuneTimer = setTimeout(() => { this.tuneTimer = null; spyService.setFrequency(next); }, 200);
    }
  }

  override onDialDown(_ev: DialDownEvent<DialTuneSettings>): void {}
  override onDialUp(_ev: DialUpEvent<DialTuneSettings>): void {}

  override async onSendToPlugin(ev: SendToPluginEvent<JsonObject, DialTuneSettings>): Promise<void> {
    if (ev.payload['action'] === 'getPresets') {
      const presets = await loadPresets().catch(() => []);
      await streamDeck.ui.sendToPropertyInspector({ action: 'presets', presets: presets as unknown as JsonObject[] });
    }
    if (ev.payload['action'] === 'getAudioDevices') {
      const [devices, current, audioCfg] = await Promise.all([
        getAudioOutputDevices().catch(() => []),
        getCurrentAudioOutput().catch(() => ''),
        spyService.getAudioPersistedConfig(),
      ]);
      const savedName = audioCfg.deviceName || 'default';
      await streamDeck.ui.sendToPropertyInspector({
        action: 'audioDevices',
        devices: devices as unknown as JsonObject[],
        current,
        savedName,
        audioEnabled: audioCfg.audioEnabled,
      });
    }
    if (ev.payload['action'] === 'setAudioConfig') {
      const { audioEnabled, deviceName } = ev.payload as { audioEnabled?: boolean; deviceName?: string };
      await spyService.updateAudioConfig({
        audioEnabled,
        ffmpeg: deviceName ? { deviceName } : undefined,
      }).catch((e) => streamDeck.logger.error(`[spyDialTune] updateAudioConfig: ${e}`));
    }
  }

  private async updateDisplay(action: unknown): Promise<void> {
    if (!action) return;
    const a = action as { setFeedback: (f: Record<string, unknown>) => Promise<void> };
    const stereoLock = spyService.getPilotPower() > 0.005;
    const rssiDbfs = spyService.getRssiDbfs();
    const snrDb    = spyService.getSnrDb();
    // RSSI: -100..-20 dBFS → 0..100 %. Red threshold (10/17 ≈ 59 %) ≈ -53 dBFS.
    // Tuned so a "moderate FM station" (~−50 dBFS via Airspy HF+) shows a few red
    // segments — matching ATS-Mini's S9 visual feedback.
    const rssiPct = Math.max(0, Math.min(100, (rssiDbfs + 100) * 100 / 80));
    // SNR: 0..50 dB → 0..100 %.
    const snrPct  = Math.max(0, Math.min(100, snrDb * 100 / 50));
    const snrNum  = snrDb > 0.5 ? `${Math.round(snrDb)}` : '-';
    const rssiNum = rssiDbfs > -119 ? `${Math.round(rssiDbfs)}` : '-';
    const meters: Record<string, unknown> = {
      'snr-bar':  snrBarSvg(snrPct),
      'snr-num':  snrNum,
      'rssi-bar': rssiBandSvg(rssiPct),
      'rssi-num': rssiNum,
    };
    if (this.dialMode === 'preset') {
      const p = this.presets[this.slotIndex];
      const freq = p?.freq ?? 0;
      const { num, unit } = freqParts(freq);
      const modeStr = p ? (MODES[p.mode] ?? '') : '';
      const header = p ? `${modeStr}  ${p.name}` : 'No presets';
      const isFM = p?.mode === 1;
      await a.setFeedback({
        ...meters,
        header:        makeHeaderSvg(header, isFM && stereoLock),
        'freq-display': svgB64(seg7svg(num, unit, 200, 55)),
        border:         makeBorderSvg(this.borderSide),
      });
    } else {
      const freq = this.currentFreq > 0 ? this.currentFreq : spyService.currentFreq;
      const { num, unit } = freqParts(freq);
      await a.setFeedback({
        ...meters,
        header:        makeHeaderSvg(`VFO  step:${formatStep(this.stepHz)}`, stereoLock),
        'freq-display': svgB64(seg7svg(num, unit, 200, 55)),
        border:         makeBorderSvg(this.borderSide),
      });
    }
  }
}
