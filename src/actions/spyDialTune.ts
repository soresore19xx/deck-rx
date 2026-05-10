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
import { lookupJpStation, lookupCallsign, formatJpStationLabel, isJpRegion, type JpRegion } from '../japanStations.js';
import { autoDemodForFreq } from '../bandPolicy.js';
import { bandsForDevice, snapToCoveredFreq, isFreqReceivable } from '../deviceBands.js';

// Station-name auto-lookup priority:
//   1. jp-stations.json — auto-scraped 総務省 region tables (filtered by the
//      user's active region) + region-independent manualStations. Wins for FM
//      (EIBI has no entries above 30 MHz) and for MW (covers domestic
//      Japanese stations EIBI doesn't list, e.g. NHK R1 594 kHz).
//   2. EIBI — international SW + some MW DX entries with day/time-aware match.
//   3. (caller falls back to the user's preset name when both return null.)
function autoStationLabel(freqHz: number, activeRegion: JpRegion): string | null {
  const jp = lookupJpStation(freqHz, activeRegion);
  if (jp) return formatJpStationLabel(jp);
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

// Sensible default freq per demod mode. Used when the demodListener fires
// and the preset list has NO matching-mode entry — typical for SSB/CW since
// JP DB and most SDR++ imports include only AM + FM stations. Without this
// fallback the freq would stick on the previous mode's value, leaving the
// user staring at e.g. "USB live, dial reads 80.0 MHz" which is non-sensical
// (FM band freq under SSB demod = noise) and confusing.
//
// Picks (active 国内 ham conventions):
//   NFM 0  : 145.000 MHz  (2 m amateur)
//   WFM 1  :  80.000 MHz  (TOKYO FM, 関東 representative broadcast freq)
//   AM  2  :     594 kHz  (NHK第1 東京)
//   USB 4  :  14.200 MHz  (20 m phone)
//   CW  5  :   7.025 MHz  (40 m CW band, 国内 amateurs cluster here)
//   LSB 6  :   7.100 MHz  (40 m phone)
const MODE_DEFAULT_FREQ: Record<number, number> = {
  0: 145_000_000,
  1:  80_000_000,
  2:     594_000,
  4:  14_200_000,
  5:   7_025_000,
  6:   7_100_000,
};

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
  // True when the demodListener fallback fired because the new mode had
  // no matching preset (USB/LSB/CW typical). Render switches to currentFreq
  // for the freq display + skips the preset-name fallback for the header so
  // we don't mis-attribute "TBS Radio" to a 14.200 MHz USB ham QSO. Cleared
  // automatically when a later mode change finds a matching preset.
  private fallbackActive = false;
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
        const dev = spyService.getDeviceInfo();
        const receivable = !p?.freq || !dev || isFreqReceivable(p.freq, dev.deviceType, dev.minFrequency, dev.maxFrequency);
        if (p?.freq && receivable) {
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
        // If the persisted preset is unreceivable on the connected device
        // (e.g. user persisted a 50 MHz NFM slot then plugged in an Airspy
        // HF+ which has a 31–60 MHz hardware gap) we silently skip the
        // seed; the user can rotate to a covered preset manually. The dial
        // is left in dim state, mirroring "no signal" rather than pretending
        // the freq is tuned.
      } else if (this.dialMode === 'vfo' && this.currentFreq > 0 && spyService.currentFreq === 0) {
        // Snap the persisted VFO freq into a covered band before seeding —
        // same reasoning as above, applied to free-form VFO state.
        const dev = spyService.getDeviceInfo();
        const bands = dev ? bandsForDevice(dev.deviceType, dev.minFrequency, dev.maxFrequency) : [];
        const seedFreq = snapToCoveredFreq(this.currentFreq, bands, 0);
        if (seedFreq > 0) spyService.setFrequency(seedFreq);
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
      // Auto-jump runs regardless of dialMode (preset / vfo) — Combo Band
      // PUSH is an explicit "go to this band" action by the user, so the
      // freq should follow even when they're in VFO. Conversely, the VFO
      // dial-rotate handler wraps its autoDemodForFreq-driven setDemodMode
      // with suppressDemodJump so this listener doesn't yank the freq the
      // user is actively dialing through.
      if (!this.suppressDemodJump) {
        // Pick the first preset that BOTH matches the new demod mode AND
        // is receivable on the connected hardware. Without the receivability
        // filter, PUSH-ing NFM on an Airspy HF+ would happily land us on a
        // 50 MHz preset (6 m amateur, in the HF+ 31–60 MHz hardware gap)
        // and the user would hear noise. If no covered preset matches we
        // fall back to MODE_DEFAULT_FREQ so the user at least lands on a
        // sensible band-representative freq instead of the previous mode's
        // value (the SSB/CW PUSH case — JP DB / SDR++ import don't include
        // amateur SSB stations, so findIndex would be -1 forever).
        const dev = spyService.getDeviceInfo();
        const idx = this.presets.length > 0
          ? this.presets.findIndex(p => p.mode === mode && (!dev || isFreqReceivable(p.freq, dev.deviceType, dev.minFrequency, dev.maxFrequency)))
          : -1;
        if (idx >= 0) {
          this.slotIndex = idx;
          this.fallbackActive = false;
          const p = this.presets[idx];
          if (p?.freq) {
            this.currentFreq = p.freq;
            spyService.setFrequency(p.freq);
            // We do NOT call setSettings here. Stream Deck SDK's setSettings
            // is a *full replace* of the action's settings object, so a
            // partial { slotIndex: idx } would null-out mode / stepHz /
            // borderSide and trigger onDidReceiveSettings, which then
            // overwrites this.slotIndex back to its persisted (stale) value.
            // The next user-driven setSettings via onDialRotate carries
            // a spread of the full settings and naturally persists the
            // new slot.
          }
        } else {
          // No matching preset — fall back to a band-representative default
          // so band PUSH (USB / LSB / CW typically) actually moves the dial.
          // slotIndex is intentionally NOT touched: when the user later
          // PUSHes back to AM/FM, the matching-preset path above restores
          // the original slot.
          const def = MODE_DEFAULT_FREQ[mode];
          if (def && (!dev || isFreqReceivable(def, dev.deviceType, dev.minFrequency, dev.maxFrequency))) {
            this.currentFreq = def;
            this.fallbackActive = true;
            spyService.setFrequency(def);
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
      // Advance one slot per tick, but skip presets the connected hardware
      // can't actually receive (Airspy HF+ has a 31–60 MHz hardware gap, so
      // 50 MHz NFM presets exist on disk but aren't tunable). When *no*
      // covered preset exists in the list at all, bail without changing
      // state — there's nothing meaningful to land on.
      const dev = spyService.getDeviceInfo();
      const isCovered = (idx: number): boolean => {
        const p = this.presets[idx];
        return !!p && (!dev || isFreqReceivable(p.freq, dev.deviceType, dev.minFrequency, dev.maxFrequency));
      };
      const len = this.presets.length;
      const dir = ev.payload.ticks >= 0 ? 1 : -1;
      const steps = Math.max(1, Math.abs(ev.payload.ticks));
      let next = this.slotIndex;
      let landed = false;
      for (let s = 0; s < steps; s++) {
        let attempts = len;
        do {
          next = ((next + dir) % len + len) % len;
          attempts--;
        } while (!isCovered(next) && attempts > 0);
        if (!isCovered(next)) { landed = false; break; }
        landed = true;
      }
      if (!landed) return;
      this.slotIndex = next;
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
        // Wrap with suppressDemodJump so demodListener does NOT fallback
        // here — the user is actively dialing the freq, we do not want
        // their freq yanked to a band-default just because the boundary
        // was crossed.
        const desired = autoDemodForFreq(next);
        if (desired !== null) {
          this.suppressDemodJump = true;
          spyService.setDemodMode(desired);
          this.suppressDemodJump = false;
        }
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
    // Stereo badge uses the demodulator's STRICTER hysteretic lock
    // (0.005 lock / 0.002 unlock) — the L−R audio gate's pllLocked
    // (0.0008 / 0.0003) is intentionally lenient to capture weak
    // stereo, but on a quiet channel the noise floor at 19 kHz alone
    // sustains pilotPower above 0.0008 and would falsely light the
    // badge. The stricter thresholds sit below the bottom of the
    // "actually receiving stereo" range (~0.001-0.05 per architecture
    // notes) but above realistic noise floor.
    const stereoLock = spyService.getStereoBadgeLock();
    const rssiDbfs = spyService.getRssiDbfs();
    const snrDb    = spyService.getSnrDb();
    // RSSI: -100..-10 dBFS → 0..100 %. Earlier scale capped at -20 dBFS but
    // strong urban FM stations (NHK-FM / J-WAVE / TOKYO FM via Airspy HF+
    // in 関東) routinely sit at -15 dBFS or higher, pegging the bar. Wider
    // headroom keeps "strong" and "very strong" visually distinct without
    // dramatically shifting the moderate-signal mid-range (S9 ≈ -50 dBFS
    // shifts from 62 % → 55 %).
    const rssiPct = Math.max(0, Math.min(100, (rssiDbfs + 100) * 100 / 90));
    // SNR: 0..60 dB → 0..100 %. spyService clamps snrDbRaw to [-10, 60],
    // so /50 left the 50-60 dB band invisible (all read 100 %); /60 uses
    // the full clamped range.
    const snrPct  = Math.max(0, Math.min(100, snrDb * 100 / 60));
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
    // enabled AND the active demod is WFM (mode 1) — otherwise we're
    // outputting mono and the badge is misleading (pilot lock detection
    // still runs regardless of the option, and stale pllLocked from a
    // previous WFM tune could leak into the next non-FM mode's render
    // window).
    const liveModeIsWfm = spyService.getDemodMode() === 1;
    const showStereo = this.enabled && stereoLock && liveModeIsWfm && spyService.getFMOptions().stereo;
    // While offline (TCP link down with master ON), show "-----" instead of
    // the freq digits — the dial otherwise shows a frequency that isn't really
    // being received. Master OFF keeps the freq visible (it's where we'll
    // resume when re-enabled).
    const offlineSvg = svgB64(seg7svg('-----', '', 200, 55, 0, 1.0, '', '', false));
    if (this.dialMode === 'preset') {
      const p = this.presets[this.slotIndex];
      // Fallback path (USB/LSB/CW band PUSH with no matching preset): the
      // demodListener wrote currentFreq to a band-default that doesn't
      // correspond to ANY preset, so the freq display + station-name
      // lookup must use currentFreq rather than presets[slotIndex].freq —
      // otherwise we'd render the previous mode's preset freq (e.g. 80 MHz
      // FM) under the new SSB demod, which is exactly the bug this fix
      // addresses. Mode label switches to the live demod, station name
      // falls back to whatever JP DB / callsign DB resolves for the new
      // freq (typically nothing for amateur SSB) — preset.name is
      // intentionally NOT used here since "TBS Radio" on 14.200 MHz USB
      // would mis-attribute.
      const freq = this.fallbackActive ? this.currentFreq : (p?.freq ?? 0);
      const { num, unit } = freqParts(freq);
      const liveDemod = spyService.getDemodMode();
      const modeStr = this.fallbackActive
        ? (MODES[liveDemod] ?? '')
        : (p ? (MODES[p.mode] ?? '') : '');
      const auto = (this.fallbackActive || p) ? autoStationLabel(freq, spyService.getJpActiveRegion()) : null;
      // Preset-name fallback: when JP DB lookup misses (typically because the
      // preset's freq belongs to a station tagged for a region OTHER than the
      // one currently active — e.g. user on 関東 tuned 1179 kHz MBSラジオ
      // which is region: kinki), still try to attach the 識別信号 from the
      // 総務省 callsign DB. callsign lookup is region-independent (one freq
      // → one callsign, by license).
      const callsignSuffix = !auto && p && !this.fallbackActive ? lookupCallsign(freq, spyService.getJpActiveRegion()) : undefined;
      // Header now carries the broadcaster name only — Mode and STEREO have
      // moved into the freq display (Mode = left of digits, STEREO = top-
      // right corner where the clock used to live; the clock relocated to
      // the Volume + Status panel's title bar).
      const baseHeader = this.fallbackActive
        ? (auto ?? '')                                                              // SSB/CW fallback: no preset name attribution
        : (p ? (auto ?? (callsignSuffix ? `${p.name} ${callsignSuffix}` : p.name)) : 'No presets');
      const header = !this.enabled ? (baseHeader ? `OFF  ${baseHeader}` : 'OFF')
                   : offline        ? (baseHeader ? `LINK  ${baseHeader}` : 'LINK')
                   : baseHeader;
      const isFM = !this.fallbackActive && p?.mode === 1;
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
