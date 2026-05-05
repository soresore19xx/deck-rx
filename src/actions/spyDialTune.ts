import { action, DialDownEvent, DialRotateEvent, DialUpEvent, SingletonAction, WillAppearEvent, WillDisappearEvent, DidReceiveSettingsEvent, SendToPluginEvent } from '@elgato/streamdeck';
import streamDeck from '@elgato/streamdeck';
import type { JsonObject } from '@elgato/streamdeck';
import { getAudioOutputDevices, getCurrentAudioOutput } from '../audioDevices.js';
import { spyService } from '../spyService.js';
import { SyncInfo } from '../SpyClient.js';
import { svgB64, knobSvg, dimSvg } from '../icons.js';
import { dumpTuneLcd } from '../dialDisplay.js';
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

@action({ UUID: 'com.hogehoge.deck-rx.dial-tune' })
export class SpyDialTune extends SingletonAction<DialTuneSettings> {
  private dialMode: 'preset' | 'vfo' = 'preset';
  private currentFreq = 0;
  private stepHz = 9000;
  private slotIndex = 0;
  private borderSide: 'left'|'right'|'center'|'none' = 'none';
  private syncListener: ((s: SyncInfo) => void) | null = null;
  private connectListener: (() => void) | null = null;
  private enabledListener: ((on: boolean) => void) | null = null;
  private connStateListener: ((c: boolean) => void) | null = null;
  private enabled = true;
  private connected = false;
  private tuneTimer: ReturnType<typeof setTimeout> | null = null;
  private lastAction: unknown = null;
  private presets: Preset[] = [];
  private footerTimer: ReturnType<typeof setInterval> | null = null;
  // Long-press master ON/OFF: 2-second hold required to toggle. Short
  // presses do nothing — prevents accidental power-cycling when the user
  // bumps the encoder.
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private longPressFired = false;
  private tuneModeListener: ((m: 'preset' | 'vfo') => void) | null = null;
  private tuneStepListener: ((s: number) => void) | null = null;

  override async onWillAppear(ev: WillAppearEvent<DialTuneSettings>): Promise<void> {
    this.dialMode   = spyService.getTuneMode();
    this.stepHz     = spyService.getTuneStepHz();
    this.slotIndex  = ev.payload.settings.slotIndex ?? 0;
    this.borderSide = ev.payload.settings.borderSide ?? 'none';
    this.lastAction = ev.action;
    this.presets = await loadPresets().catch(() => []);
    if (spyService.currentFreq > 0) this.currentFreq = spyService.currentFreq;
    this.tuneModeListener = (m) => { this.dialMode = m; this.updateDisplay(ev.action).catch(() => {}); };
    spyService.subscribeTuneMode(this.tuneModeListener);
    this.tuneStepListener = (s) => { this.stepHz = s; this.updateDisplay(ev.action).catch(() => {}); };
    spyService.subscribeTuneStep(this.tuneStepListener);

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

    this.enabledListener = (on: boolean) => {
      this.enabled = on;
      this.updateDisplay(this.lastAction).catch(() => {});
    };
    spyService.subscribeEnabled(this.enabledListener);

    this.connStateListener = (c: boolean) => {
      this.connected = c;
      this.updateDisplay(this.lastAction).catch(() => {});
    };
    spyService.subscribeConnectionState(this.connStateListener);

    await ev.action.setImage(svgB64(knobSvg()));
    spyService.connect().catch((e) => streamDeck.logger.error(`[spyDialTune] ${e}`));
    // Periodically refresh footer (stereo-lock indicator updates from pilot power)
    this.footerTimer = setInterval(() => { this.updateDisplay(this.lastAction).catch(() => {}); }, 1000);
    await this.updateDisplay(ev.action);
  }

  override onWillDisappear(_ev: WillDisappearEvent<DialTuneSettings>): void {
    if (this.syncListener) { spyService.unsubscribe(this.syncListener); this.syncListener = null; }
    if (this.connectListener) { spyService.offConnect(this.connectListener); this.connectListener = null; }
    if (this.enabledListener) { spyService.unsubscribeEnabled(this.enabledListener); this.enabledListener = null; }
    if (this.connStateListener) { spyService.unsubscribeConnectionState(this.connStateListener); this.connStateListener = null; }
    if (this.tuneModeListener) { spyService.unsubscribeTuneMode(this.tuneModeListener); this.tuneModeListener = null; }
    if (this.tuneStepListener) { spyService.unsubscribeTuneStep(this.tuneStepListener); this.tuneStepListener = null; }
    if (this.tuneTimer) { clearTimeout(this.tuneTimer); this.tuneTimer = null; }
    if (this.footerTimer) { clearInterval(this.footerTimer); this.footerTimer = null; }
    this.lastAction = null;
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<DialTuneSettings>): Promise<void> {
    // Tune mode / step are global (set via Options panel) — ignore the
    // per-dial Settings fields for these. slotIndex stays per-dial.
    this.dialMode   = spyService.getTuneMode();
    this.stepHz     = spyService.getTuneStepHz();
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

  override onDialDown(_ev: DialDownEvent<DialTuneSettings>): void {
    this.longPressFired = false;
    if (this.longPressTimer) clearTimeout(this.longPressTimer);
    this.longPressTimer = setTimeout(() => {
      this.longPressTimer = null;
      this.longPressFired = true;
      // Master ON/OFF: tear down or bring up the SpyServer connection.
      spyService.toggleEnabled().catch(() => {});
    }, 2000);
  }
  override onDialUp(_ev: DialUpEvent<DialTuneSettings>): void {
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
    // If longPressFired, the toggle has already been issued from the timer.
    // Short press (< 2 s) is intentionally a no-op to avoid accidental
    // master ON/OFF.
  }

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
        audioEnabled:    audioCfg.audioEnabled,
        outputMode:      audioCfg.outputMode,
        icecastUrl:      audioCfg.icecastUrl,
        icecastPassword: audioCfg.icecastPassword,
        bitrate:         audioCfg.bitrate,
      });
    }
    if (ev.payload['action'] === 'setAudioConfig') {
      const p = ev.payload as {
        audioEnabled?: boolean;
        deviceName?: string;
        outputMode?: 'local' | 'icecast';
        icecastUrl?: string;
        icecastPassword?: string;
        bitrate?: string;
      };
      const ffmpeg: Record<string, unknown> = {};
      if (p.deviceName !== undefined)      ffmpeg.deviceName = p.deviceName;
      if (p.outputMode !== undefined)      ffmpeg.mode = p.outputMode;
      if (p.icecastUrl !== undefined)      ffmpeg.icecastUrl = p.icecastUrl;
      if (p.icecastPassword !== undefined) ffmpeg.icecastPassword = p.icecastPassword;
      if (p.bitrate !== undefined)         ffmpeg.bitrate = p.bitrate;
      await spyService.updateAudioConfig({
        audioEnabled: p.audioEnabled,
        ffmpeg: Object.keys(ffmpeg).length > 0 ? ffmpeg : undefined,
      }).catch((e) => streamDeck.logger.error(`[spyDialTune] updateAudioConfig: ${e}`));
    }
    if (ev.payload['action'] === 'getServerConfig') {
      const cfg = await spyService.getServerConfigPersisted();
      await streamDeck.ui.sendToPropertyInspector({
        action: 'serverConfig',
        host: cfg.host,
        port: cfg.port,
      });
    }
    if (ev.payload['action'] === 'setServerConfig') {
      const { host, port } = ev.payload as { host?: string; port?: number };
      await spyService.updateServerConfig({ host, port })
        .catch((e) => streamDeck.logger.error(`[spyDialTune] updateServerConfig: ${e}`));
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
    // When master OFF, blank the meters and ignore stereo lock — the radio
    // is fully torn down so any cached values are stale.
    // Dim the whole dial when either the master switch is OFF or the SpyServer
    // TCP link is down (so a brief network blip greys the panel until reconnect).
    const dim = !this.enabled || !this.connected;
    const offline = this.enabled && !this.connected;
    const D = (s: string) => dimSvg(s, dim);
    // Layout-side text items (s-label, n-label, snr-num, rssi-num) aren't part
    // of any SVG so dimSvg can't reach them — override their colour explicitly
    // via setFeedback so the meter labels and numerics dim alongside the bars.
    const T = (txt: string) => ({ value: txt, color: dim ? '#4d4d4d' : '#ffffff' });
    // Live values are only meaningful when the radio is actually receiving —
    // master OFF or TCP-down show zero bars + "-" numerics. dim wraps both
    // bars (SVG) and numerics (text) consistently.
    const live = this.enabled && this.connected;
    const meters: Record<string, unknown> = {
      'n-label':  T('N'),
      's-label':  T('S'),
      'snr-bar':  D(snrBarSvg(live ? snrPct : 0)),
      'snr-num':  T(live ? snrNum : '-'),
      'rssi-bar': D(rssiBandSvg(live ? rssiPct : 0)),
      'rssi-num': T(live ? rssiNum : '-'),
    };
    // Only show the STEREO badge when the user actually has stereo decoding
    // enabled — otherwise we're outputting mono and the badge is misleading
    // (pilot lock detection still runs regardless of the option).
    const showStereo = this.enabled && stereoLock && spyService.getFMOptions().stereo;
    // While offline (TCP link down with master ON), show "-----" instead of
    // the freq digits — the dial otherwise shows a frequency that isn't really
    // being received. Master OFF keeps the freq visible (it's where we'll
    // resume when re-enabled).
    const offlineSvg = svgB64(seg7svg('-----', '', 200, 55));
    if (this.dialMode === 'preset') {
      const p = this.presets[this.slotIndex];
      const freq = p?.freq ?? 0;
      const { num, unit } = freqParts(freq);
      const modeStr = p ? (MODES[p.mode] ?? '') : '';
      const baseHeader = p ? `${modeStr}  ${p.name}` : 'No presets';
      const header = !this.enabled ? `OFF  ${baseHeader}`
                   : offline        ? `LINK  ${baseHeader}`
                   : baseHeader;
      const isFM = p?.mode === 1;
      const freqSvg = offline ? offlineSvg : svgB64(seg7svg(num, unit, 200, 55));
      const headerImg = D(makeHeaderSvg(header, isFM && showStereo));
      const freqImg   = D(freqSvg);
      const borderImg = makeBorderSvg(this.borderSide);
      await a.setFeedback({
        ...meters,
        header:        headerImg,
        'freq-display': freqImg,
        border:         borderImg,
      });
      dumpTuneLcd({
        border: borderImg, header: headerImg, freqDisplay: freqImg,
        snrBar: meters['snr-bar'] as string,
        rssiBar: meters['rssi-bar'] as string,
        snrNum: (meters['snr-num'] as { value: string }).value,
        rssiNum: (meters['rssi-num'] as { value: string }).value,
        textColor: dim ? '#4d4d4d' : '#ffffff',
      });
    } else {
      const freq = this.currentFreq > 0 ? this.currentFreq : spyService.currentFreq;
      const { num, unit } = freqParts(freq);
      const baseHeader = `VFO  step:${formatStep(this.stepHz)}`;
      const header = !this.enabled ? `OFF  ${baseHeader}`
                   : offline        ? `LINK  ${baseHeader}`
                   : baseHeader;
      const freqSvg = offline ? offlineSvg : svgB64(seg7svg(num, unit, 200, 55));
      const headerImg = D(makeHeaderSvg(header, showStereo));
      const freqImg   = D(freqSvg);
      const borderImg = makeBorderSvg(this.borderSide);
      await a.setFeedback({
        ...meters,
        header:        headerImg,
        'freq-display': freqImg,
        border:         borderImg,
      });
      dumpTuneLcd({
        border: borderImg, header: headerImg, freqDisplay: freqImg,
        snrBar: meters['snr-bar'] as string,
        rssiBar: meters['rssi-bar'] as string,
        snrNum: (meters['snr-num'] as { value: string }).value,
        rssiNum: (meters['rssi-num'] as { value: string }).value,
        textColor: dim ? '#4d4d4d' : '#ffffff',
      });
    }
  }
}
