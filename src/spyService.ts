import streamDeck from '@elgato/streamdeck';
import {
  SpyClient, DeviceInfo, SyncInfo, IQPacket,
  SETTING_IQ_FORMAT, SETTING_IQ_FREQUENCY, SETTING_IQ_DECIMATION,
  SETTING_STREAMING_MODE, SETTING_GAIN, SETTING_IQ_DIGITAL_GAIN, SETTING_STREAMING_ENABLED,
  STREAM_MODE_IQ_ONLY, STREAM_FORMAT_INT16,
  computeDigitalGain,
} from './SpyClient.js';
import { Demodulator } from './demodulator.js';
import { Ifnr } from './ifnr.js';
import { IqNr, DemodMode } from './iqnr.js';
import { AudioOutput, FfmpegOutput, NaudiodonOutput } from './AudioOutput.js';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

declare const __dirname: string;
const CONFIG_PATH = join(__dirname, '..', 'config.json');

export type DeemphasisOpt = 'off' | '50us' | '75us';

export interface FMOptions {
  deemphasis: DeemphasisOpt;
  ifnr: boolean;
  highPass: boolean;
  lowPass: boolean;
  stereo: boolean;
}

const DEFAULT_FM_OPTIONS: FMOptions = {
  deemphasis: '50us',
  ifnr: false,
  highPass: true,
  lowPass: true,
  stereo: false,
};

export interface AMOptions {
  bandwidth: number;   // Hz, 0 = no limit
  carrierAgc: boolean;
  agcAttack: number;   // 0..1 (per-sample IIR factor) — larger = faster
  agcDecay: number;    // 0..1
}

const DEFAULT_AM_OPTIONS: AMOptions = {
  bandwidth: 9000,
  carrierAgc: true,
  // Per-sample IIR factors at 57 kHz audio rate.
  // 0.005 ≈ 3.5 ms attack, 0.00005 ≈ 350 ms decay — typical broadcast AGC.
  agcAttack: 0.005,
  agcDecay: 0.00005,
};

interface Config {
  host: string;
  port: number;
  enabled?: boolean;      // master ON/OFF (user-toggled via dial push)
  audioEnabled?: boolean;
  demodMode?: number;     // 0=NFM 1=WFM 2=AM (last-used)
  lastFrequency?: number; // Hz; restored at startup
  iqDecimation?: number;  // SpyServer SETTING_IQ_DECIMATION stage offset
  audioDecimate?: number; // software decimation: audioRate = iqRate / audioDecimate
  gain?: number;          // legacy single-gain field (migrated to amGain on first load)
  amGain?: number;        // RF gain index used while in AM mode
  fmGain?: number;        // RF gain index used while in NFM/WFM (and other non-AM)
  audioOutput?: 'naudiodon' | 'ffmpeg';
  naudiodon?: { deviceId?: number };
  ffmpeg?: {
    mode?: 'local' | 'icecast';
    deviceName?: string;
    icecastUrl?: string;
    bitrate?: string;
  };
  fm?: Partial<FMOptions>;
  am?: Partial<AMOptions>;
  volume?: number;
  muted?: boolean;
}

type SyncListener     = (s: SyncInfo) => void;
type ConnectListener  = () => void;
type OptionsListener  = (o: FMOptions) => void;
type AMOptionsListener = (o: AMOptions) => void;
type DeviceListener   = (d: DeviceInfo) => void;
type EnabledListener  = (enabled: boolean) => void;
type GainListener     = (gain: number, maxGain: number) => void;
type DemodModeListener = (mode: number) => void;
type AudioStateListener = (running: boolean, deviceName: string) => void;
type ConnectionStateListener = (connected: boolean) => void;

class SpyService {
  private client = new SpyClient();
  private connected = false;
  private connecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private syncListeners    = new Set<SyncListener>();
  private connectListeners = new Set<ConnectListener>();
  private optionsListeners = new Set<OptionsListener>();
  private amOptionsListeners = new Set<AMOptionsListener>();
  private deviceListeners  = new Set<DeviceListener>();
  private volumeListeners  = new Set<(v: number, muted: boolean) => void>();
  private enabledListeners = new Set<EnabledListener>();
  // Master ON/OFF: when false, connect()/scheduleReconnect() are no-ops and
  // any active connection is torn down. Default true (existing users keep
  // current behavior); persisted to config so toggle survives restarts.
  private enabled = true;
  private fmOptions: FMOptions = { ...DEFAULT_FM_OPTIONS };
  private amOptions: AMOptions = { ...DEFAULT_AM_OPTIONS };
  private host = '';
  private port = 0;
  private volume = 1.0;   // 0..1.5 (1.0 = unity)
  private muted = false;
  private _currentFreq = 0;

  private deviceInfo: DeviceInfo | null = null;
  private deviceInfoWaiters: Array<(info: DeviceInfo) => void> = [];
  private lastSync: SyncInfo | null = null;

  private audioOutput: AudioOutput | null = null;
  private currentAudioDeviceName: string = '';
  private demod = new Demodulator();
  // IF-domain NR — operates on the complex IQ stream before demodulation.
  // The audio-domain Ifnr instances are kept around for potential A/B
  // comparison but currently disabled in the iqListener path.
  private iqnr = new IqNr();
  private ifnrL = new Ifnr();
  private ifnrR = new Ifnr();
  private audioRunning = false;
  private iqListener: ((p: IQPacket) => void) | null = null;
  private currentIQRate = 0;
  private currentAudioRate = 0;
  private currentDemodMode = 1; // 0=NFM 1=WFM 2=AM
  private currentAudioDecimate = 1;
  // RSSI tracking: smoothed RMS power (dBFS, gain-compensated)
  private rssiSmoothed = -120; // dBFS, very low default
  // SNR tracking: derived from instantaneous power variance
  // (mean²/variance is high for stable carriers, low for noise-dominated signals)
  private snrSmoothed = 0;     // dB
  private muteUntil = 0;  // ms epoch — output silence until this time
  // Live RF gain control — held separately for AM and non-AM (FM/NFM/etc)
  // because the strong-signal IMD problem on the AM band requires lower gain
  // than is comfortable on FM. undefined means "not yet hydrated" — set to
  // maxGainIndex when deviceInfo arrives. currentDecStage is captured from
  // the most recent startAudio so set*Gain() can recompute digital gain.
  private amGain: number | undefined = undefined;
  private fmGain: number | undefined = undefined;
  private maxGain = 0;
  private currentDecStage = 0;
  private amGainListeners = new Set<GainListener>();
  private fmGainListeners = new Set<GainListener>();
  private demodModeListeners = new Set<DemodModeListener>();
  private audioStateListeners = new Set<AudioStateListener>();
  private connectionStateListeners = new Set<ConnectionStateListener>();
  // Debounced SpyServer apply for rapid dial rotations.
  private gainApplyTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingGainScope: 'am' | 'fm' | null = null;

  get currentFreq(): number { return this._currentFreq; }

  constructor() { this.hookClient(); }

  private hookClient(): void {
    this.client.on('deviceInfo', (info: DeviceInfo) => {
      this.deviceInfo = info;
      streamDeck.logger.info(`[spyService] deviceInfo type=${info.deviceType} maxRate=${info.maxSampleRate} stages=${info.decimationStages} minDec=${info.minIQDecimation} maxGain=${info.maxGainIndex} forcedFmt=${info.forcedIQFormat}`);
      this.maxGain = info.maxGainIndex;
      // First-time hydration: if no persisted gain, default to max. Then clamp.
      if (this.amGain === undefined) this.amGain = info.maxGainIndex;
      if (this.fmGain === undefined) this.fmGain = info.maxGainIndex;
      this.amGain = Math.max(0, Math.min(this.maxGain, this.amGain));
      this.fmGain = Math.max(0, Math.min(this.maxGain, this.fmGain));
      for (const fn of this.amGainListeners) fn(this.amGain, this.maxGain);
      for (const fn of this.fmGainListeners) fn(this.fmGain, this.maxGain);
      const waiters = this.deviceInfoWaiters.splice(0);
      for (const w of waiters) w(info);
      for (const fn of this.deviceListeners) fn(info);
    });
    this.client.on('sync', (s: SyncInfo) => {
      // Don't overwrite _currentFreq from server-reported iqCenterFreq:
      // the server's "current" freq is just an echo of our last setting.
      // After our setFrequency, the server-side initial sync still echoes
      // an older value, racing our config-restored _currentFreq.
      this.lastSync = s;
      streamDeck.logger.info(`[spyService] sync canControl=${s.canControl} gain=${s.gain} iqFreq=${s.iqCenterFreq} min=${s.minIQCenterFreq} max=${s.maxIQCenterFreq}`);
      for (const fn of this.syncListeners) fn(s);
    });
    this.client.on('error', (e: unknown) => {
      streamDeck.logger.error(`[spyService] error: ${e}`);
      this.stopAudio();
      this.scheduleReconnect();
    });
    this.client.on('disconnect', () => {
      streamDeck.logger.warn('[spyService] disconnected');
      this.stopAudio();
      this.scheduleReconnect();
    });
  }

  private waitForDeviceInfo(timeoutMs = 3000): Promise<DeviceInfo> {
    if (this.deviceInfo) return Promise.resolve(this.deviceInfo);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.deviceInfoWaiters.indexOf(resolver);
        if (i >= 0) this.deviceInfoWaiters.splice(i, 1);
        reject(new Error('deviceInfo timeout'));
      }, timeoutMs);
      const resolver = (info: DeviceInfo) => { clearTimeout(timer); resolve(info); };
      this.deviceInfoWaiters.push(resolver);
    });
  }

  async connect(): Promise<void> {
    if (this.connected || this.connecting) return;
    this.connecting = true;
    try {
      const cfg = await this.loadConfig();
      // Hydrate enabled flag from config and bail if user has it OFF.
      // Done before any side-effects so a disabled plugin stays fully idle.
      if (typeof cfg.enabled === 'boolean') this.enabled = cfg.enabled;
      for (const fn of this.enabledListeners) fn(this.enabled);
      if (!this.enabled) {
        streamDeck.logger.info('[spyService] connect: disabled, staying offline');
        return;
      }
      // First connect: hydrate fmOptions from persisted config
      if (cfg.fm) {
        this.fmOptions = { ...DEFAULT_FM_OPTIONS, ...cfg.fm };
        for (const fn of this.optionsListeners) fn(this.fmOptions);
      }
      if (cfg.am) {
        this.amOptions = { ...DEFAULT_AM_OPTIONS, ...cfg.am };
        // Clamp persisted alpha factors to the SDR++ ranges.
        // Attack 1-200 ms → α 0.01736 .. 0.0000877
        // Decay  1-20  ms → α 0.01736 .. 0.000876
        const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
        this.amOptions.agcAttack = clamp(this.amOptions.agcAttack, 0.0000877, 0.01736);
        this.amOptions.agcDecay  = clamp(this.amOptions.agcDecay,  0.000876,  0.01736);
        for (const fn of this.amOptionsListeners) fn(this.amOptions);
      }
      if (typeof cfg.volume === 'number') this.volume = Math.max(0, Math.min(1.5, cfg.volume));
      if (typeof cfg.muted  === 'boolean') this.muted  = cfg.muted;
      for (const fn of this.volumeListeners) fn(this.volume, this.muted);
      // Restore last-used freq + mode so the radio is already on the right
      // station when audio starts (without depending on any dial firing first).
      if (typeof cfg.lastFrequency === 'number' && cfg.lastFrequency > 0) {
        this._currentFreq = cfg.lastFrequency;
      }
      if (typeof cfg.demodMode === 'number') {
        this.currentDemodMode = cfg.demodMode;
      }
      // Hydrate per-mode gains. Legacy `cfg.gain` is migrated into `amGain`
      // (where IMD problems first surfaced) so the user keeps their tuned-down
      // value across the upgrade.
      if (typeof cfg.amGain === 'number') {
        this.amGain = Math.max(0, cfg.amGain);
      } else if (typeof cfg.gain === 'number') {
        this.amGain = Math.max(0, cfg.gain);
      }
      if (typeof cfg.fmGain === 'number') {
        this.fmGain = Math.max(0, cfg.fmGain);
      }
      this.host = cfg.host;
      this.port = cfg.port;
      streamDeck.logger.info(`[spyService] connecting ${cfg.host}:${cfg.port}`);
      await this.client.connect(cfg.host, cfg.port);
      streamDeck.logger.info('[spyService] tcp connected, awaiting deviceInfo');
      await this.waitForDeviceInfo(3000);
      this.setConnectedState(true);
      streamDeck.logger.info('[spyService] handshake complete');
      for (const fn of this.connectListeners) fn();
      if (cfg.audioEnabled) {
        await this.startAudio(cfg).catch((e) =>
          streamDeck.logger.error(`[spyService] startAudio failed: ${e}`)
        );
      }
    } catch (e) {
      streamDeck.logger.error(`[spyService] connect failed: ${e}`);
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.setConnectedState(false);
    this.deviceInfo = null;
    if (!this.enabled) return;  // do not reconnect when user has switched off
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      this.client.disconnect();
      this.client = new SpyClient();
      this.hookClient();
      await this.connect();
    }, 5000);
  }

  // ── Master ON/OFF ─────────────────────────────────────────────────────
  isEnabled(): boolean { return this.enabled; }
  subscribeEnabled(fn: EnabledListener): void {
    this.enabledListeners.add(fn);
    fn(this.enabled);
  }
  unsubscribeEnabled(fn: EnabledListener): void { this.enabledListeners.delete(fn); }
  /** Toggle master ON/OFF. Persists, then connects or tears down. */
  async setEnabled(b: boolean): Promise<void> {
    const next = !!b;
    if (next === this.enabled) return;
    this.enabled = next;
    streamDeck.logger.info(`[spyService] setEnabled ${next}`);
    for (const fn of this.enabledListeners) fn(this.enabled);
    // Await the persist BEFORE reconnect: connect() re-hydrates cfg.enabled
    // from disk, so a not-yet-flushed write would silently revert us to OFF.
    await this.persistField('enabled', this.enabled).catch(() => {});
    if (!next) {
      // Going OFF: cancel any pending reconnect, tear down audio + TCP.
      if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
      this.stopAudio();
      try { this.client.disconnect(); } catch {}
      this.setConnectedState(false);
      this.deviceInfo = null;
    } else {
      // Going ON: kick off a fresh connect (existing client already disconnected
      // or never opened — replace to drop any stale listeners cleanly).
      this.client = new SpyClient();
      this.hookClient();
      await this.connect();
    }
  }
  async toggleEnabled(): Promise<void> { await this.setEnabled(!this.enabled); }

  // ── RF Gain (per demod-mode) ─────────────────────────────────────────
  getAmGain(): number { return this.amGain ?? 0; }
  getFmGain(): number { return this.fmGain ?? 0; }
  getMaxGain(): number { return this.maxGain; }
  subscribeAmGain(fn: GainListener): void {
    this.amGainListeners.add(fn);
    fn(this.amGain ?? 0, this.maxGain);
  }
  unsubscribeAmGain(fn: GainListener): void { this.amGainListeners.delete(fn); }
  subscribeFmGain(fn: GainListener): void {
    this.fmGainListeners.add(fn);
    fn(this.fmGain ?? 0, this.maxGain);
  }
  unsubscribeFmGain(fn: GainListener): void { this.fmGainListeners.delete(fn); }
  /** Set the AM-mode gain. Live-applied if currently in AM and streaming. */
  async setAmGain(g: number): Promise<void> { await this.setGainInternal('am', g); }
  /** Set the FM-mode gain. Live-applied if currently in FM/NFM and streaming. */
  async setFmGain(g: number): Promise<void> { await this.setGainInternal('fm', g); }
  private async setGainInternal(scope: 'am' | 'fm', g: number): Promise<void> {
    if (this.maxGain <= 0) return;
    const clamped = Math.max(0, Math.min(this.maxGain, Math.round(g)));
    const prev = scope === 'am' ? this.amGain : this.fmGain;
    if (clamped === prev) return;
    if (scope === 'am') this.amGain = clamped; else this.fmGain = clamped;
    const listeners = scope === 'am' ? this.amGainListeners : this.fmGainListeners;
    for (const fn of listeners) fn(clamped, this.maxGain);
    // Only push to SpyServer if THIS scope matches the active demod mode.
    const isActive = scope === 'am' ? this.currentDemodMode === 2 : this.currentDemodMode !== 2;
    if (isActive && this.connected && this.audioRunning && this.deviceInfo) {
      // Changing LNA gain causes an IQ-amplitude step + SpyServer-side AGC
      // settling: without masking, a loud pop punches through. We mute for
      // long enough to cover both the debounce wait and the post-apply
      // settling. Debounce groups rapid dial ticks into one apply.
      this.muteUntil = Date.now() + 200;
      this.demod.reset(); this.iqnr.reset(); this.ifnrL.reset(); this.ifnrR.reset();
      this.pendingGainScope = scope;
      if (this.gainApplyTimer) clearTimeout(this.gainApplyTimer);
      this.gainApplyTimer = setTimeout(() => {
        this.gainApplyTimer = null;
        const sc = this.pendingGainScope;
        this.pendingGainScope = null;
        if (!sc || !this.deviceInfo) return;
        const finalGain = sc === 'am' ? this.amGain : this.fmGain;
        if (finalGain === undefined) return;
        const digitalGain = computeDigitalGain(
          this.deviceInfo.deviceType, finalGain, this.currentDecStage, this.deviceInfo.maxGainIndex,
        );
        // Re-mute + reset around the actual apply so the post-step transient
        // is masked even after the debounce window has elapsed.
        this.muteUntil = Math.max(this.muteUntil, Date.now() + 150);
        this.demod.reset(); this.iqnr.reset(); this.ifnrL.reset(); this.ifnrR.reset();
        this.client.setSetting(SETTING_GAIN, finalGain);
        this.client.setSetting(SETTING_IQ_DIGITAL_GAIN, digitalGain);
        streamDeck.logger.info(`[spyService] set${sc === 'am' ? 'Am' : 'Fm'}Gain ${finalGain} digitalGain=${digitalGain}`);
      }, 80);
    }
    await this.persistField(scope === 'am' ? 'amGain' : 'fmGain', clamped).catch(() => {});
  }

  private freqDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingFreq = 0;
  private persistFreqTimer: ReturnType<typeof setTimeout> | null = null;
  setFrequency(hz: number): void {
    this._currentFreq = hz;
    // Initial long mute covers the debounce + the start of SpyServer's
    // retune. Re-muted again from the apply timer for the rest of the
    // settling window (new station carrier amplitude, amDc convergence).
    this.muteUntil = Date.now() + 200;
    this.demod.reset();
    this.pendingFreq = hz;
    if (this.freqDebounceTimer) clearTimeout(this.freqDebounceTimer);
    this.freqDebounceTimer = setTimeout(() => {
      this.freqDebounceTimer = null;
      // Refresh mute + demod state around the actual SpyServer command —
      // server retune (~50-100 ms) + new-station IQ packet arrival pop is
      // the main loud transient we need to mask.
      this.muteUntil = Math.max(this.muteUntil, Date.now() + 250);
      this.demod.reset(); this.iqnr.reset(); this.ifnrL.reset(); this.ifnrR.reset();
      this.client.setFrequency(this.pendingFreq);
      streamDeck.logger.info(`[spyService] sentFreq ${this.pendingFreq}`);
    }, 50);
    // Persist (debounced 500 ms) so next startup restores the same freq + mode
    if (this.persistFreqTimer) clearTimeout(this.persistFreqTimer);
    this.persistFreqTimer = setTimeout(() => {
      this.persistFreqTimer = null;
      this.persistFields({
        lastFrequency: hz,
        demodMode: this.currentDemodMode,
      }).catch(() => {});
    }, 500);
  }
  // Serialise config writes to prevent races (parallel persistField calls
  // would race on read-modify-write and corrupt the JSON file).
  private configWriteChain: Promise<void> = Promise.resolve();
  private persistField(key: string, value: unknown): Promise<void> {
    const next = this.configWriteChain.then(async () => {
      const raw = await readFile(CONFIG_PATH, 'utf8').catch(() => '{}');
      const cfg = JSON.parse(raw) as Record<string, unknown>;
      cfg[key] = value;
      await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    });
    this.configWriteChain = next.catch(() => {});
    return next;
  }
  private persistFields(updates: Record<string, unknown>): Promise<void> {
    const next = this.configWriteChain.then(async () => {
      const raw = await readFile(CONFIG_PATH, 'utf8').catch(() => '{}');
      const cfg = JSON.parse(raw) as Record<string, unknown>;
      Object.assign(cfg, updates);
      await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    });
    this.configWriteChain = next.catch(() => {});
    return next;
  }

  getFMOptions(): FMOptions { return { ...this.fmOptions }; }

  async setFMOption<K extends keyof FMOptions>(key: K, value: FMOptions[K]): Promise<void> {
    this.fmOptions = { ...this.fmOptions, [key]: value };
    this.applyFMOptions();
    for (const fn of this.optionsListeners) fn(this.fmOptions);
    // Persist: read raw without applying side effects, merge fm only
    const raw = await readFile(CONFIG_PATH, 'utf8').catch(() => '{}');
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    cfg.fm = { ...this.fmOptions };
    await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  }

  private applyFMOptions(): void {
    const fm = this.fmOptions;
    // De-emphasis: 0 disables (sets alpha=1 → passthrough)
    const tau = fm.deemphasis === '50us' ? 50e-6 : fm.deemphasis === '75us' ? 75e-6 : 0;
    if (tau > 0 && this.currentAudioRate > 0) {
      this.demod.setDeemphasis(this.currentAudioRate, tau);
    } else {
      this.demod.setDeemphasis(this.currentAudioRate || 48000, 0);
    }
    // Audio HPF/LPF on/off
    if (this.currentAudioRate > 0) {
      this.demod.setAudioFilters(
        this.currentAudioRate,
        fm.lowPass  ? 15000 : this.currentAudioRate * 0.45,
        fm.highPass ? 30    : 0,
      );
    }
    streamDeck.logger.info(`[spyService] applyFMOptions ${JSON.stringify(fm)}`);
  }

  subscribeOptions(fn: OptionsListener): void   {
    this.optionsListeners.add(fn);
    fn(this.fmOptions);  // replay current to late subscribers
  }
  unsubscribeOptions(fn: OptionsListener): void { this.optionsListeners.delete(fn); }

  // ── AM options ────────────────────────────────────────────────────────
  getAMOptions(): AMOptions { return { ...this.amOptions }; }
  async setAMOption<K extends keyof AMOptions>(key: K, value: AMOptions[K]): Promise<void> {
    this.amOptions = { ...this.amOptions, [key]: value };
    this.applyAMOptions();
    for (const fn of this.amOptionsListeners) fn(this.amOptions);
    const raw = await readFile(CONFIG_PATH, 'utf8').catch(() => '{}');
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    cfg.am = { ...this.amOptions };
    await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  }
  subscribeAMOptions(fn: AMOptionsListener): void {
    this.amOptionsListeners.add(fn);
    fn(this.amOptions);
  }
  unsubscribeAMOptions(fn: AMOptionsListener): void { this.amOptionsListeners.delete(fn); }
  private applyAMOptions(): void {
    const am = this.amOptions;
    if (this.currentAudioRate > 0) {
      this.demod.setAmBandwidth(this.currentAudioRate, am.bandwidth, this.currentIQRate);
    }
    this.demod.setAmAgc(am.carrierAgc, am.agcAttack, am.agcDecay);
    streamDeck.logger.info(`[spyService] applyAMOptions ${JSON.stringify(am)}`);
  }

  subscribeDevice(fn: DeviceListener): void   {
    this.deviceListeners.add(fn);
    if (this.deviceInfo) fn(this.deviceInfo);
  }
  unsubscribeDevice(fn: DeviceListener): void { this.deviceListeners.delete(fn); }

  getDeviceInfo(): DeviceInfo | null { return this.deviceInfo; }
  getServerAddress(): { host: string; port: number } { return { host: this.host, port: this.port }; }
  getCurrentIQRate(): number { return this.currentIQRate; }
  /** Active audio output target ("DX7s", "default", "icecast", "naudiodon#N", or empty if not yet started). */
  getAudioDeviceName(): string { return this.currentAudioDeviceName; }
  /** Subscribe to audio start/stop events. The callback fires immediately
   *  with the current state (replay), then on every subsequent change. */
  subscribeAudioState(fn: AudioStateListener): void {
    this.audioStateListeners.add(fn);
    fn(this.audioRunning, this.currentAudioDeviceName);
  }
  unsubscribeAudioState(fn: AudioStateListener): void { this.audioStateListeners.delete(fn); }
  /** WFM pilot power (smoothed). Use with a threshold to detect stereo broadcasts. */
  getPilotPower(): number { return this.demod.getPilotPower(); }
  /** Smoothed signal level in dBFS, gain-compensated. Range typically -120..0. */
  getRssiDbfs(): number { return this.rssiSmoothed; }
  /** Smoothed SNR estimate in dB, derived from instantaneous power variance. */
  getSnrDb(): number { return this.snrSmoothed; }

  // ── Volume / Mute ─────────────────────────────────────────────────────
  private persistVolumeTimer: ReturnType<typeof setTimeout> | null = null;
  getVolume(): number { return this.volume; }
  isMuted(): boolean { return this.muted; }
  /** Apply immediately; persist on disk debounced (300ms). */
  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1.5, v));
    for (const fn of this.volumeListeners) fn(this.volume, this.muted);
    this.schedulePersistVolume();
  }
  setMuted(m: boolean): void {
    this.muted = !!m;
    for (const fn of this.volumeListeners) fn(this.volume, this.muted);
    this.schedulePersistVolume();
  }
  subscribeVolume(fn: (v: number, muted: boolean) => void): void {
    this.volumeListeners.add(fn);
    fn(this.volume, this.muted);
  }
  unsubscribeVolume(fn: (v: number, muted: boolean) => void): void {
    this.volumeListeners.delete(fn);
  }
  private schedulePersistVolume(): void {
    if (this.persistVolumeTimer) clearTimeout(this.persistVolumeTimer);
    this.persistVolumeTimer = setTimeout(() => {
      this.persistVolumeTimer = null;
      this.persistVolumeNow().catch(() => {});
    }, 300);
  }
  private async persistVolumeNow(): Promise<void> {
    await this.persistFields({ volume: this.volume, muted: this.muted });
  }

  getDemodMode(): number { return this.currentDemodMode; }
  subscribeDemodMode(fn: DemodModeListener): void {
    this.demodModeListeners.add(fn);
    fn(this.currentDemodMode);
  }
  unsubscribeDemodMode(fn: DemodModeListener): void { this.demodModeListeners.delete(fn); }
  setDemodMode(mode: number): void {
    if (this.currentDemodMode === mode) return;
    const prevMode = this.currentDemodMode;
    this.currentDemodMode = mode;
    this.muteUntil = Date.now() + 100;
    this.demod.reset();
    this.iqnr.setMode(mode as DemodMode, this.currentIQRate);
    streamDeck.logger.info(`[spyService] setDemodMode ${mode}`);
    this.persistField('demodMode', mode).catch(() => {});
    for (const fn of this.demodModeListeners) fn(mode);
    // If we crossed the AM ↔ non-AM boundary, the gain to send changes too.
    const wasAm = prevMode === 2;
    const isAm = mode === 2;
    if (wasAm !== isAm && this.connected && this.audioRunning && this.deviceInfo) {
      // Extend the existing mode-change mute (set to +100 above) for the
      // gain transient too — the LNA step plus SpyServer-side AGC settling
      // is the loudest pop in the system.
      this.muteUntil = Date.now() + 250;
      const newGain = (isAm ? this.amGain : this.fmGain) ?? this.deviceInfo.maxGainIndex;
      const digitalGain = computeDigitalGain(
        this.deviceInfo.deviceType, newGain, this.currentDecStage, this.deviceInfo.maxGainIndex,
      );
      this.client.setSetting(SETTING_GAIN, newGain);
      this.client.setSetting(SETTING_IQ_DIGITAL_GAIN, digitalGain);
      streamDeck.logger.info(`[spyService] mode→gain ${isAm ? 'AM' : 'FM'} ${newGain} digitalGain=${digitalGain}`);
    }
  }

  async startAudio(cfg?: Config): Promise<void> {
    if (this.audioRunning) this.stopAudio();
    if (!cfg) cfg = await this.loadConfig();
    if (!cfg.audioEnabled) return;
    if (!this.deviceInfo) {
      streamDeck.logger.warn('[spyService] startAudio: no deviceInfo yet');
      return;
    }

    const info = this.deviceInfo;
    // SDR++ formula: actualRate = MaximumSampleRate / 2^decimationStage
    // Config provides decimation OFFSET from MinimumIQDecimation (matches SDR++ srId)
    const decOffset = cfg.iqDecimation ?? 2;
    const decStage = decOffset + info.minIQDecimation;
    const iqRate = Math.round(info.maxSampleRate / (1 << decStage));
    const audioDecimate = Math.max(1, cfg.audioDecimate ?? 1);
    const audioRate = Math.round(iqRate / audioDecimate);
    // Do NOT overwrite currentDemodMode here — it has already been set by
    // connect-time hydration (cfg.demodMode) and may have been updated since
    // by setDemodMode() (e.g., from a connectListener pushing a preset's mode).
    this.currentAudioDecimate = audioDecimate;
    // Pick the gain index for the current demod mode. AM uses amGain (typically
    // lowered to dodge IMD from strong MW stations), other modes use fmGain.
    const useAm = this.currentDemodMode === 2;
    const stored = useAm ? this.amGain : this.fmGain;
    const gain = Math.max(0, Math.min(info.maxGainIndex, stored ?? info.maxGainIndex));
    if (useAm) this.amGain = gain; else this.fmGain = gain;
    this.currentDecStage = decStage;
    const channels = 2; // always stereo PCM (mono modes duplicate L=R)
    this.currentAudioRate = audioRate;
    this.currentIQRate = iqRate;
    // Configure stereo decode at IQ rate (filters need iqRate, not audioRate)
    this.demod.setStereo(iqRate);
    // Apply FM/AM options (de-emph + audio filters + AM bandwidth/AGC)
    this.applyFMOptions();
    this.applyAMOptions();

    streamDeck.logger.info(`[spyService] startAudio decStage=${decStage} iqRate=${iqRate} audioRate=${audioRate} gain=${gain}`);

    // Build audio output
    if (cfg.audioOutput === 'naudiodon') {
      this.audioOutput = new NaudiodonOutput(cfg.naudiodon ?? {});
      this.currentAudioDeviceName = `naudiodon#${cfg.naudiodon?.deviceId ?? -1}`;
    } else {
      this.audioOutput = new FfmpegOutput({
        mode:        cfg.ffmpeg?.mode        ?? 'local',
        deviceName:  cfg.ffmpeg?.deviceName,
        icecastUrl:  cfg.ffmpeg?.icecastUrl,
        bitrate:     cfg.ffmpeg?.bitrate,
      });
      this.currentAudioDeviceName = cfg.ffmpeg?.mode === 'icecast'
        ? 'icecast'
        : (cfg.ffmpeg?.deviceName || 'default');
    }
    await this.audioOutput.start(audioRate, channels);
    this.demod.reset();
    this.currentIQRate = iqRate;
    this.iqnr.setMode(this.currentDemodMode as DemodMode, iqRate);
    // Mute initial period to suppress ffmpeg/AudioToolbox startup pop and
    // demodulator transient (atan2 with near-zero prev I/Q, AM DC settling).
    this.muteUntil = Date.now() + 500;

    // Attach IQ data listener BEFORE enabling streaming
    let iqCount = 0;
    let lastDiag = 0;
    // AM-mode spectrum probe: every 2 s log per-bin dBFS at fixed offsets so
    // we can see exactly which neighbour station is leaking through.
    let lastSpec = 0;
    // Wide-range spectrum probe (within ±Nyquist of IQ rate 228 kHz = ±114 kHz).
    // Includes potential alias offsets so we can spot signals folded back from
    // far-away strong stations (e.g. 954 kHz @ tune 1314 → folds to +96 kHz if
    // SpyServer's anti-alias is weak).
    const SPEC_OFFSETS = [
      -108000, -96000, -72000, -54000,
      -45000, -36000, -27000, -18000, -9000, 0, 9000, 18000, 27000, 36000, 45000,
      54000, 72000, 96000, 108000,
    ];
    this.iqListener = (p: IQPacket) => {
      if (iqCount < 3) { streamDeck.logger.info(`[spyService] iqData fmt=${p.format} len=${p.body.length} gainDb=${p.gainDb}`); iqCount++; }
      // RSSI + SNR from IQ samples (INT16 LE: 4 bytes per I,Q pair).
      // Powers normalised to int16 full-scale to keep within JS double precision.
      if (p.format === 'int16') {
        const NORM = 32767 * 32767;
        let sumP = 0, sumP2 = 0;
        const N = p.body.length >> 2;
        for (let i = 0; i < N; i++) {
          const I = p.body.readInt16LE(i * 4);
          const Q = p.body.readInt16LE(i * 4 + 2);
          const power = (I * I + Q * Q) / NORM;  // 0..~2 typical
          sumP  += power;
          sumP2 += power * power;
        }
        const meanP  = sumP  / Math.max(1, N);
        const meanP2 = sumP2 / Math.max(1, N);
        // RSSI: RMS power → dBFS, gain-compensated
        const dbfs = meanP > 0 ? 10 * Math.log10(meanP) : -120;
        const corrected = dbfs - p.gainDb;
        this.rssiSmoothed = 0.9 * this.rssiSmoothed + 0.1 * corrected;
        // SNR: mean²/variance of instantaneous power. Pure carrier → very high,
        // pure noise → ~0 dB. Useful for FM (constant envelope); noisy for AM.
        const varP = Math.max(1e-9, meanP2 - meanP * meanP);
        const snrLin = (meanP * meanP) / varP;
        const snrDbRaw = 10 * Math.log10(snrLin);
        const snrDb = Math.max(-10, Math.min(60, snrDbRaw));
        this.snrSmoothed = 0.9 * this.snrSmoothed + 0.1 * snrDb;
      }
      if (!this.audioOutput) return;
      const dec = this.currentAudioDecimate;
      // IF-domain NR — when enabled, run the full IQ buffer through IqNr
      // BEFORE demodulation. This is the proper "IF noise reduction": we
      // operate on the broadband complex stream where there are real
      // noise-only frequency bins to estimate the floor from. Output is a
      // new Buffer of the same length / format that we feed into the
      // existing demod functions unchanged.
      const iqBody = this.fmOptions.ifnr ? this.iqnr.processBuffer(p.body) : p.body;
      let pcm: Int16Array;
      if (this.currentDemodMode === 2) {
        pcm = this.demod.processAM(iqBody, dec);
      } else if (this.currentDemodMode === 1) {
        pcm = this.fmOptions.stereo
          ? this.demod.processWFMStereo(iqBody, dec)
          : this.demod.processWFM(iqBody, dec);
      } else {
        pcm = this.demod.processFM(iqBody, dec);
      }
      // Diagnostic log every 3 s: detect silent output from DSP issues.
      const _now = Date.now();
      if (_now - lastDiag > 3000) {
        let pcmSumSq = 0;
        for (let i = 0; i < pcm.length; i++) pcmSumSq += pcm[i] * pcm[i];
        const pcmRms = Math.sqrt(pcmSumSq / Math.max(1, pcm.length));
        // IQ-side stats to distinguish "no input signal" vs "DSP killed it".
        let iqSumSq = 0;
        const N = p.body.length >> 2;
        for (let i = 0; i < N; i++) {
          const I = p.body.readInt16LE(i * 4);
          const Q = p.body.readInt16LE(i * 4 + 2);
          iqSumSq += I * I + Q * Q;
        }
        const iqRms = Math.sqrt(iqSumSq / Math.max(1, N));
        const pilotP = this.demod.getPilotPower();
        const ifd = this.demod.getAmDiag();
        const nrG = this.fmOptions.ifnr ? `nrG=${this.iqnr.getAvgGain().toFixed(3)}` : '';
        streamDeck.logger.info(`[spyService] diag mode=${this.currentDemodMode} pcmRms=${pcmRms.toFixed(0)} iqRms=${iqRms.toFixed(0)} pilotP=${pilotP.toFixed(4)} ifPre=${ifd.pre.toFixed(0)} ifPost=${ifd.post.toFixed(0)} ${nrG}`);
        lastDiag = _now;
      }
      // AM spectrum probe (only meaningful for AM mode). Emits two lines:
      //   spec/raw   — power per bin in the original IQ stream
      //   spec/filt  — same bins after passing through an independent copy of
      //                the IF LPF (16th-order Butterworth at am.bandwidth/2)
      // Bin-by-bin difference = effective LPF attenuation.
      if (this.currentDemodMode === 2 && _now - lastSpec > 2000 && this.currentIQRate > 0) {
        const raw  = this.demod.measureChannelPowers(p.body, this.currentIQRate, SPEC_OFFSETS);
        const filt = this.demod.measureFilteredChannelPowers(p.body, this.currentIQRate, this.amOptions.bandwidth, SPEC_OFFSETS);
        const prod = this.demod.measurePostIfChannelPowers(this.currentIQRate, SPEC_OFFSETS);
        const fmt = (vals: number[]) => SPEC_OFFSETS.map((f, i) => {
          const k = f === 0 ? '  0k' : `${f >= 0 ? '+' : ''}${(f / 1000).toFixed(0)}k`.padStart(4);
          return `${k}=${vals[i].toFixed(0).padStart(4)}`;
        }).join(' ');
        const tuned = this._currentFreq;
        streamDeck.logger.info(`[spyService] spec/raw  freq=${tuned} ${fmt(raw)}`);
        streamDeck.logger.info(`[spyService] spec/filt freq=${tuned} ${fmt(filt)}`);
        streamDeck.logger.info(`[spyService] spec/prod freq=${tuned} ${fmt(prod)}`);
        lastSpec = _now;
      }
      if (Date.now() < this.muteUntil || this.muted) {
        pcm.fill(0);
      } else if (this.volume !== 1) {
        const v = this.volume;
        for (let i = 0; i < pcm.length; i++) {
          const s = pcm[i] * v;
          pcm[i] = s >= 32767 ? 32767 : s <= -32768 ? -32768 : (s | 0);
        }
      }
      this.audioOutput.write(pcm);
    };
    this.client.on('iqData', this.iqListener);

    // SDR++ start sequence (main.cpp:120-141):
    //   IQ_FORMAT → IQ_DECIMATION → IQ_FREQUENCY → STREAMING_MODE → GAIN → IQ_DIGITAL_GAIN → STREAMING_ENABLED
    const freqHz = this._currentFreq > 0 ? this._currentFreq : 100_000_000;
    const digitalGain = computeDigitalGain(info.deviceType, gain, decStage, info.maxGainIndex);
    this.client.setSetting(SETTING_IQ_FORMAT,         STREAM_FORMAT_INT16);
    this.client.setSetting(SETTING_IQ_DECIMATION,     decStage);
    this.client.setSetting(SETTING_IQ_FREQUENCY,      freqHz);
    this.client.setSetting(SETTING_STREAMING_MODE,    STREAM_MODE_IQ_ONLY);
    this.client.setSetting(SETTING_GAIN,              gain);
    this.client.setSetting(SETTING_IQ_DIGITAL_GAIN,   digitalGain);
    this.client.setSetting(SETTING_STREAMING_ENABLED, 1);

    this.audioRunning = true;
    streamDeck.logger.info(`[spyService] audio started mode=${this.currentDemodMode} iqRate=${iqRate} audioRate=${audioRate} freq=${freqHz} digitalGain=${digitalGain}`);
    for (const fn of this.audioStateListeners) fn(true, this.currentAudioDeviceName);
  }

  stopAudio(): void {
    if (this.iqListener) {
      this.client.off('iqData', this.iqListener);
      this.iqListener = null;
    }
    try { this.client.stopStreaming(); } catch {}
    try { this.audioOutput?.stop(); } catch {}
    this.audioOutput = null;
    const wasRunning = this.audioRunning;
    this.audioRunning = false;
    if (wasRunning) {
      for (const fn of this.audioStateListeners) fn(false, this.currentAudioDeviceName);
    }
  }

  isAudioRunning(): boolean { return this.audioRunning; }

  private async loadConfig(): Promise<Config> {
    const raw = await readFile(CONFIG_PATH, 'utf8').catch(() => '{}');
    const cfg = JSON.parse(raw) as Partial<Config>;
    return {
      host:          cfg.host          ?? '192.168.0.142',
      port:          cfg.port          ?? 8888,
      enabled:       cfg.enabled       ?? true,
      audioEnabled:  cfg.audioEnabled  ?? false,
      demodMode:     cfg.demodMode     ?? 1,
      lastFrequency: cfg.lastFrequency,
      iqDecimation:  cfg.iqDecimation  ?? 2,
      audioDecimate: cfg.audioDecimate ?? 1,
      gain:          cfg.gain,
      amGain:        cfg.amGain,
      fmGain:        cfg.fmGain,
      audioOutput:   cfg.audioOutput   ?? 'ffmpeg',
      naudiodon:     cfg.naudiodon,
      ffmpeg:        cfg.ffmpeg,
      fm:            cfg.fm,
      am:            cfg.am,
      volume:        cfg.volume,
      muted:         cfg.muted,
    };
  }

  async getAudioPersistedConfig(): Promise<{ audioEnabled: boolean; deviceName: string }> {
    const cfg = await this.loadConfig();
    return {
      audioEnabled: !!cfg.audioEnabled,
      deviceName:   cfg.ffmpeg?.deviceName ?? 'default',
    };
  }

  /** Persisted SpyServer host + port (used by PI to populate the form fields). */
  async getServerConfigPersisted(): Promise<{ host: string; port: number }> {
    const cfg = await this.loadConfig();
    return { host: cfg.host, port: cfg.port };
  }

  /**
   * Persist a new SpyServer host/port and apply it live: tear down the current
   * client, replace it with a fresh one pointing at the new endpoint, and
   * reconnect (unless the master switch is OFF, in which case only the
   * persisted value is updated). Validates port is in 1..65535.
   */
  async updateServerConfig({ host, port }: { host?: string; port?: number }): Promise<void> {
    const updates: Record<string, unknown> = {};
    if (typeof host === 'string' && host.trim().length > 0) updates.host = host.trim();
    if (typeof port === 'number' && port >= 1 && port <= 65535) updates.port = port;
    if (Object.keys(updates).length === 0) return;
    await this.persistFields(updates);
    // Apply live: only re-establish if there was an active or pending connection.
    const wasActive = this.connected || this.connecting || !!this.reconnectTimer;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.stopAudio();
    try { this.client.disconnect(); } catch {}
    this.setConnectedState(false);
    this.connecting = false;
    this.deviceInfo = null;
    streamDeck.logger.info(`[spyService] updateServerConfig ${JSON.stringify(updates)}`);
    if (wasActive && this.enabled) {
      this.client = new SpyClient();
      this.hookClient();
      await this.connect();
    }
  }

  async updateAudioConfig(updates: Partial<Config>): Promise<void> {
    const current = await this.loadConfig();
    const merged: Config = { ...current, ...updates,
      naudiodon: { ...current.naudiodon, ...(updates.naudiodon ?? {}) },
      ffmpeg:    { ...current.ffmpeg,    ...(updates.ffmpeg    ?? {}) },
    };
    await writeFile(CONFIG_PATH, JSON.stringify(merged, null, 2));
    if (this.audioRunning || merged.audioEnabled) {
      this.stopAudio();
      if (merged.audioEnabled && this.connected) {
        await this.startAudio(merged).catch((e) =>
          streamDeck.logger.error(`[spyService] restartAudio failed: ${e}`)
        );
      }
    }
  }

  subscribe(fn: SyncListener): void    {
    this.syncListeners.add(fn);
    if (this.lastSync) fn(this.lastSync);  // replay last for late subscribers
  }
  unsubscribe(fn: SyncListener): void  { this.syncListeners.delete(fn); }
  onConnect(fn: ConnectListener): void  {
    this.connectListeners.add(fn);
    if (this.connected) fn();              // replay if already connected
  }
  offConnect(fn: ConnectListener): void { this.connectListeners.delete(fn); }
  isConnected(): boolean { return this.connected; }
  /** Subscribe to TCP connection state changes (true=connected handshake done,
   *  false=disconnected). Replays current state immediately. */
  subscribeConnectionState(fn: ConnectionStateListener): void {
    this.connectionStateListeners.add(fn);
    fn(this.connected);
  }
  unsubscribeConnectionState(fn: ConnectionStateListener): void { this.connectionStateListeners.delete(fn); }
  private setConnectedState(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    for (const fn of this.connectionStateListeners) fn(connected);
  }
}

export const spyService = new SpyService();
