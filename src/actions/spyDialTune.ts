import { action, DialDownEvent, DialRotateEvent, DialUpEvent, SingletonAction, WillAppearEvent, WillDisappearEvent, DidReceiveSettingsEvent, SendToPluginEvent } from '@elgato/streamdeck';
import streamDeck from '@elgato/streamdeck';
import type { JsonObject } from '@elgato/streamdeck';
import { getAudioOutputDevices, getCurrentAudioOutput } from '../audioDevices.js';
import { spyService } from '../spyService.js';
import { SyncInfo } from '../SpyClient.js';
import { svgB64, knobSvg, dimSvg } from '../icons.js';
import { dumpTuneLcd } from '../dialDisplay.js';
import { makeHeaderSvg, makeBorderSvg, seg7svg, freqParts, rssiBandSvg, snrBarSvg } from '../dialDisplay.js';
import { loadPresets, clearPresetsCache, Preset } from './spyTune.js';
import { importFromSdrpp } from '../presets.js';
import { lookupEibi } from '../eibi.js';
import { lookupJpStation, isJpRegion, type JpRegion } from '../japanStations.js';
import { autoDemodForFreq } from '../bandPolicy.js';
import { bandsForDevice, snapToCoveredFreq } from '../deviceBands.js';

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

// autoDemodForFreq lives in src/bandPolicy.ts so the unit-test harness can
// exercise the band-policy decisions without importing the Stream Deck SDK
// or the spyService singleton.

export function currentTimeHHMM(): string {
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
  private demodListener: ((mode: number) => void) | null = null;
  // Set true while the Tune dial is the *source* of a setDemodMode call
  // (preset cycle on this dial, or PI Mode dropdown reacting through this
  // dial). The demodListener checks this and skips its auto-jump path so
  // the user's preset choice isn't immediately overwritten by the first
  // matching-mode preset in the list.
  private suppressDemodJump = false;

  override async onWillAppear(ev: WillAppearEvent<DialTuneSettings>): Promise<void> {
    this.dialMode   = spyService.getTuneMode();
    this.stepHz     = spyService.getTuneStepHz();
    this.slotIndex  = ev.payload.settings.slotIndex ?? 0;
    this.borderSide = ev.payload.settings.borderSide ?? 'none';
    this.lastAction = ev.action;
    this.presets = await loadPresets(spyService.getJpActiveRegion()).catch(() => []);
    if (spyService.currentFreq > 0) this.currentFreq = spyService.currentFreq;
    this.tuneModeListener = (m) => { this.dialMode = m; this.updateDisplay(ev.action).catch(() => {}); };
    spyService.subscribeTuneMode(this.tuneModeListener);
    this.tuneStepListener = (s) => { this.stepHz = s; this.updateDisplay(ev.action).catch(() => {}); };
    spyService.subscribeTuneStep(this.tuneStepListener);
    this.jpRegionListener = async (region) => {
      // Region change → preset list now mixes a different JP DB pool, so
      // rebuild it. Push the fresh list to the PI as well so the dropdown
      // reflects the new region without the user having to reopen the PI.
      clearPresetsCache();
      this.presets = await loadPresets(region).catch(() => []);
      this.updateDisplay(this.lastAction).catch(() => {});
      streamDeck.ui.sendToPropertyInspector({
        action: 'presets',
        presets: this.presets as unknown as JsonObject[],
      }).catch(() => {});
    };
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
          // Suppress the demodListener's auto-jump while the connect-time
          // seed runs — otherwise it would re-pick the first matching-mode
          // preset and stomp the user's persisted slotIndex.
          this.suppressDemodJump = true;
          if (spyService.currentFreq === 0) {
            // First run, no persisted state — seed freq + mode.
            spyService.setDemodMode(p.mode);
            spyService.setFrequency(p.freq);
          } else if (spyService.currentFreq === p.freq) {
            // The restored freq is OUR preset — make sure mode matches it,
            // covering older configs where demodMode lagged the freq change.
            spyService.setDemodMode(p.mode);
          }
          this.suppressDemodJump = false;
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

    // React to demod-mode changes (e.g. Combo dial Band PUSH switches FM →
    // AM). In preset mode we also jump the dial onto the first preset that
    // matches the new mode so the user lands on a real station instead of
    // staring at an FM-band frequency while the demod has flipped to AM.
    // VFO mode leaves the frequency alone — the user is dialing manually.
    this.demodListener = (mode: number) => {
      // Auto-jump only when the mode change came from elsewhere (Combo dial
      // Band PUSH, autoDemodForFreq band-cross, etc.). When the Tune dial
      // is itself driving the change (preset cycle / PI dropdown), the user
      // already chose a specific preset — suppressDemodJump prevents this
      // path from yanking that choice back.
      //
      // Note: we no longer skip on `idx === this.slotIndex`. Earlier
      // versions did, on the assumption that "already on the right preset"
      // means nothing to do. But that broke the common case of "AM → WFM
      // PUSH twice in a row": the second PUSH lands on the same
      // findIndex() result (slot 0 of that mode) and would silently no-op,
      // leaving the displayed freq stuck on whatever station the OTHER
      // mode had selected. Re-issuing setFrequency to the same hz is a
      // cheap no-op inside spyService, so always perform the jump when
      // a matching-mode preset exists.
      if (!this.suppressDemodJump
          && this.dialMode === 'preset'
          && this.presets.length > 0) {
        const idx = this.presets.findIndex(p => p.mode === mode);
        if (idx >= 0) {
          this.slotIndex = idx;
          const p = this.presets[idx];
          if (p?.freq) {
            this.currentFreq = p.freq;
            spyService.setFrequency(p.freq);
            // Persist slotIndex so onDidReceiveSettings doesn't restore
            // the stale value on subsequent re-emits.
            if (this.lastAction) {
              const a = this.lastAction as { setSettings?: (s: Record<string, unknown>) => Promise<void> };
              if (a.setSettings) a.setSettings({ slotIndex: idx } as DialTuneSettings).catch(() => {});
            }
          }
        }
      }
      this.updateDisplay(this.lastAction).catch(() => {});
    };
    // Initial fire of subscribeDemodMode is synchronous (the service fires
    // the listener once with the current value at subscribe time). Wrap the
    // call in suppressDemodJump so the dial keeps the persisted slotIndex
    // instead of jumping to the first matching-mode preset on every launch.
    this.suppressDemodJump = true;
    spyService.subscribeDemodMode(this.demodListener);
    this.suppressDemodJump = false;

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
    if (this.demodListener) { spyService.unsubscribeDemodMode(this.demodListener); this.demodListener = null; }
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
    this.presets = await loadPresets(spyService.getJpActiveRegion()).catch(() => []);
    await this.updateDisplay(ev.action);
  }

  override async onDialRotate(ev: DialRotateEvent<DialTuneSettings>): Promise<void> {
    if (this.dialMode === 'preset') {
      if (!this.presets.length) return;
      this.slotIndex = ((this.slotIndex + ev.payload.ticks) % this.presets.length + this.presets.length) % this.presets.length;
      await ev.action.setSettings({ ...ev.payload.settings, slotIndex: this.slotIndex });
      const p = this.presets[this.slotIndex];
      this.currentFreq = p.freq;
      // The Tune dial is itself driving this mode/freq change — silence
      // the demodListener's auto-jump until the listener has consumed
      // this setDemodMode call. Without this, demodListener would scan
      // for the FIRST matching-mode preset and overwrite the user's
      // hand-picked slotIndex (preset cycle FM → AM would always land
      // on the lowest-freq AM entry instead of the next AM in order).
      this.suppressDemodJump = true;
      spyService.setDemodMode(p.mode);
      spyService.setFrequency(p.freq);
      this.suppressDemodJump = false;
      await this.updateDisplay(ev.action);
    } else {
      const base = this.currentFreq > 0 ? this.currentFreq : spyService.currentFreq;
      if (base <= 0) return;
      const raw = Math.max(0, base + ev.payload.ticks * this.stepHz);
      // Snap to a covered band of the connected SDR so the user can't park
      // on a hardware-gap freq (Airspy HF+ has a 31–60 MHz dead zone) or
      // tune past the device's published edges. Direction = sign of ticks
      // so dialing UP through a gap jumps to the next band's lo, dialing
      // DOWN jumps to the previous band's hi.
      const dev = spyService.getDeviceInfo();
      const bands = dev ? bandsForDevice(dev.deviceType, dev.minFrequency, dev.maxFrequency) : [];
      const dir = ev.payload.ticks > 0 ? 1 : -1;
      const next = snapToCoveredFreq(raw, bands, dir);
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
      const presets = await loadPresets(spyService.getJpActiveRegion()).catch(() => []);
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
    if (ev.payload['action'] === 'importSdrppPresets') {
      try {
        const res = await importFromSdrpp();
        clearPresetsCache();
        this.presets = await loadPresets(spyService.getJpActiveRegion()).catch(() => []);
        await streamDeck.ui.sendToPropertyInspector({
          action: 'sdrImported',
          ok: true,
          added: res.added,
          skipped: res.skipped,
          lists: res.lists,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        streamDeck.logger.error(`[spyDialTune] importSdrppPresets failed: ${msg}`);
        await streamDeck.ui.sendToPropertyInspector({
          action: 'sdrImported',
          ok: false,
          error: msg,
        });
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
    const offlineSvg = svgB64(seg7svg('-----', '', 200, 55, 0, 1.0, '', '', false));
    if (this.dialMode === 'preset') {
      const p = this.presets[this.slotIndex];
      const freq = p?.freq ?? 0;
      const { num, unit } = freqParts(freq);
      const modeStr = p ? (MODES[p.mode] ?? '') : '';
      const auto = p ? autoStationLabel(freq, spyService.getJpActiveRegion()) : null;
      // Header now carries the broadcaster name only — Mode and STEREO have
      // moved into the freq display (Mode = left of digits, STEREO = top-
      // right corner where the clock used to live; the clock relocated to
      // the Volume + Status panel's title bar).
      const baseHeader = p ? (auto ?? p.name) : 'No presets';
      const header = !this.enabled ? `OFF  ${baseHeader}`
                   : offline        ? `LINK  ${baseHeader}`
                   : baseHeader;
      const isFM = p?.mode === 1;
      const freqSvg = offline ? offlineSvg : svgB64(seg7svg(num, unit, 200, 55, 0, 1.0, '', modeStr, isFM && showStereo));
      const headerImg = D(makeHeaderSvg(header, false));
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
      // VFO header: station name when known, otherwise blank. The "VFO"
      // prefix and step value were removed — Mode is shown left of the
      // freq digits and the step value is visible in the Combo dial's
      // Mode/Step row, so duplicating it on the Tune header just added
      // visual noise.
      const baseHeader = auto ?? '';
      const header = !this.enabled ? (baseHeader ? `OFF  ${baseHeader}` : 'OFF')
                   : offline        ? (baseHeader ? `LINK  ${baseHeader}` : 'LINK')
                   : baseHeader;
      const freqSvg = offline ? offlineSvg : svgB64(seg7svg(num, unit, 200, 55, 0, 1.0, '', 'VFO', showStereo));
      const headerImg = D(makeHeaderSvg(header, false));
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
