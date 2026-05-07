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
import { lookupEibi } from '../eibi.js';
import { lookupJpStation, isJpRegion, type JpRegion } from '../japanStations.js';

// Station-name auto-lookup priority:
//   1. jp-stations.json — auto-scraped 総務省 region tables (filtered by the
//      user's active region) + region-independent manualStations. Wins for FM
//      (EIBI has no entries above 30 MHz) and for MW (covers domestic
//      Japanese stations EIBI doesn't list, e.g. NHK R1 594 kHz).
//   2. EIBI — international SW + some MW DX entries with day/time-aware match.
//   3. (caller falls back to the user's preset name when both return null.)
function autoStationLabel(freqHz: number, activeRegion: JpRegion): string | null {
  const jp = lookupJpStation(freqHz, activeRegion);
  if (jp) return jp.name;
  if (freqHz >= 16_000 && freqHz <= 30_000_000) {
    const e = lookupEibi(freqHz);
    if (e) return e.name;
  }
  return null;
}

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

// Pick the demod mode for a given freq when VFO-tuning across band boundaries.
// USB/LSB/CW are intentionally not produced — they are listed in the PI MODES
// array but the demodulator currently falls through to processFM for any
// non-AM/non-WFM mode, so AM is the safer pick across MF/HF.
//   522 kHz – 1.71 MHz   →  AM   (Japanese MW)
//   1.8 MHz – 30 MHz    →  AM   (SW broadcast — narrow-AM is the workable fallback)
//   30 MHz – 76 MHz     →  NFM  (VHF low)
//   76 MHz – 108 MHz    →  WFM  (FM broadcast band)
//   > 108 MHz           →  NFM  (air / VHF / UHF)
//   anything else       →  null (don't change current mode)
function autoDemodForFreq(hz: number): number | null {
  if (hz >=     522_000 && hz <=   1_710_000) return 2;
  if (hz >=   1_800_000 && hz <=  30_000_000) return 2;
  if (hz >=  30_000_000 && hz <   76_000_000) return 0;
  if (hz >=  76_000_000 && hz <= 108_000_000) return 1;
  if (hz >  108_000_000)                      return 0;
  return null;
}

function currentTimeHHMM(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const tzRaw = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
    .formatToParts(d).find(p => p.type === 'timeZoneName')?.value ?? '';
  // ICU on Node often returns GMT-offset rather than a 3-letter abbrev.
  // Map the host's likely zones to compact abbreviations.
  const tzMap: Record<string, string> = {
    'GMT+9': 'JST', 'GMT+8': 'CST', 'GMT+0': 'GMT', 'GMT-5': 'EST',
    'GMT-4': 'EDT', 'GMT-7': 'PDT', 'GMT-8': 'PST',
  };
  const tz = tzMap[tzRaw] ?? tzRaw;
  return tz ? `${hh}:${mm} ${tz}` : `${hh}:${mm}`;
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
  private jpRegionListener: ((r: JpRegion) => void) | null = null;

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
    this.jpRegionListener = () => { this.updateDisplay(this.lastAction).catch(() => {}); };
    spyService.subscribeJpRegion(this.jpRegionListener);

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
    if (this.jpRegionListener) { spyService.unsubscribeJpRegion(this.jpRegionListener); this.jpRegionListener = null; }
    if (this.tuneTimer) { clearTimeout(this.tuneTimer); this.tuneTimer = null; }
    if (this.footerTimer) { clearInterval(this.footerTimer); this.footerTimer = null; }
    this.lastAction = null;
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<DialTuneSettings>): Promise<void> {
    // tuneMode / stepHz are global spyService state, but the PI persists them
    // through the per-dial Settings (`{ mode, stepHz, ... }`). Mirror those
    // into spyService here — without this, switching Mode in PI from Preset
    // to VFO step would do nothing (PI saved the new value but the radio
    // kept running in the previously-set tuneMode), and the Options-Combo
    // dial would never see the change either since its tuneModeListener is
    // only fired by spyService.setTuneMode().
    const settingsMode = ev.payload.settings.mode;
    if (settingsMode === 'preset' || settingsMode === 'vfo') {
      if (settingsMode !== spyService.getTuneMode()) {
        spyService.setTuneMode(settingsMode);
      }
    }
    const settingsStepHz = ev.payload.settings.stepHz;
    if (typeof settingsStepHz === 'number' && settingsStepHz > 0 && settingsStepHz !== spyService.getTuneStepHz()) {
      spyService.setTuneStepHz(settingsStepHz);
    }
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
      this.tuneTimer = setTimeout(() => {
        this.tuneTimer = null;
        // Auto-switch demod mode when VFO crosses a band boundary so the
        // user dialing from FM (90 MHz) down into MW (594 kHz) actually
        // hears AM, not noise. setDemodMode is a no-op when unchanged.
        const desired = autoDemodForFreq(next);
        if (desired !== null) spyService.setDemodMode(desired);
        spyService.setFrequency(next);
      }, 200);
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
    if (ev.payload['action'] === 'getEibiStatus') {
      const st = await spyService.getEibiStatus();
      await streamDeck.ui.sendToPropertyInspector({
        action: 'eibiStatus',
        when: st.when,
        count: st.count,
      });
    }
    if (ev.payload['action'] === 'updateEibi') {
      const res = await spyService.updateEibi();
      await streamDeck.ui.sendToPropertyInspector({
        action: 'eibiUpdated',
        ...res,
      });
    }
    if (ev.payload['action'] === 'getJpStationsStatus') {
      const st = await spyService.getJpStationsStatus();
      await streamDeck.ui.sendToPropertyInspector({
        action: 'jpStationsStatus',
        when:        st.when,
        count:       st.count,
        region:      st.region,
        manualCount: st.manualCount,
        totalAuto:   st.totalAuto,
      });
    }
    if (ev.payload['action'] === 'updateJpStations') {
      const res = await spyService.updateJpStations();
      await streamDeck.ui.sendToPropertyInspector({
        action: 'jpStationsUpdated',
        ...res,
      });
    }
    if (ev.payload['action'] === 'getJpRegion') {
      await streamDeck.ui.sendToPropertyInspector({
        action: 'jpRegion',
        region: spyService.getJpActiveRegion(),
      });
    }
    if (ev.payload['action'] === 'setTuneMode') {
      // PI dispatches this whenever Mode / Step dropdowns change. We mirror
      // into spyService here (the source of truth) so the change actually
      // takes effect — relying on the per-dial setSettings round-trip alone
      // is fragile because didReceiveSettings doesn't always echo back to
      // the same dial that triggered it. Also notifies all subscribers
      // (Options-Combo dial in particular) via setTuneMode/setTuneStepHz.
      const p = ev.payload as { mode?: unknown; stepHz?: unknown };
      if (p.mode === 'preset' || p.mode === 'vfo') {
        if (p.mode !== spyService.getTuneMode()) spyService.setTuneMode(p.mode);
      }
      if (typeof p.stepHz === 'number' && p.stepHz > 0 && p.stepHz !== spyService.getTuneStepHz()) {
        spyService.setTuneStepHz(p.stepHz);
      }
    }
    if (ev.payload['action'] === 'setJpRegion') {
      const r = (ev.payload as { region?: unknown }).region;
      if (isJpRegion(r)) {
        await spyService.setJpActiveRegion(r);
        // PI status line should refresh now that the region changed (the
        // count switches to the new region's pool).
        const st = await spyService.getJpStationsStatus();
        await streamDeck.ui.sendToPropertyInspector({
          action: 'jpStationsStatus',
          when:        st.when,
          count:       st.count,
          region:      st.region,
          manualCount: st.manualCount,
          totalAuto:   st.totalAuto,
        });
      } else {
        streamDeck.logger.warn(`[spyDialTune] setJpRegion: invalid region ${String(r)}`);
      }
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
    const offlineSvg = svgB64(seg7svg('-----', '', 200, 55, 0, 1.0, currentTimeHHMM()));
    if (this.dialMode === 'preset') {
      const p = this.presets[this.slotIndex];
      const freq = p?.freq ?? 0;
      const { num, unit } = freqParts(freq);
      const modeStr = p ? (MODES[p.mode] ?? '') : '';
      const auto = p ? autoStationLabel(freq, spyService.getJpActiveRegion()) : null;
      const baseHeader = p ? `${modeStr}  ${auto ?? p.name}` : 'No presets';
      const header = !this.enabled ? `OFF  ${baseHeader}`
                   : offline        ? `LINK  ${baseHeader}`
                   : baseHeader;
      const isFM = p?.mode === 1;
      const freqSvg = offline ? offlineSvg : svgB64(seg7svg(num, unit, 200, 55, 0, 1.0, currentTimeHHMM()));
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
      const auto = autoStationLabel(freq, spyService.getJpActiveRegion());
      const baseHeader = auto
        ? `VFO  ${auto}`
        : `VFO  step:${formatStep(this.stepHz)}`;
      const header = !this.enabled ? `OFF  ${baseHeader}`
                   : offline        ? `LINK  ${baseHeader}`
                   : baseHeader;
      const freqSvg = offline ? offlineSvg : svgB64(seg7svg(num, unit, 200, 55, 0, 1.0, currentTimeHHMM()));
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
