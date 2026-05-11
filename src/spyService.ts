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
import { AudioOutput, FfmpegOutput, NaudiodonOutput, OutputErrorTag } from './AudioOutput.js';
import { readFile, writeFile, rename, stat } from 'fs/promises';
import { join } from 'path';
import { clearEibiCache, eibiEntryCount, getEibiPath, parseEibiText } from './eibi.js';
import {
  clearJpStationsCache, getJpStationsPath,
  jpStationCountAuto, jpStationCountForRegion, jpStationCountManual,
  isJpRegion,
  type JpRegion, type JpStation,
} from './japanStations.js';
import { scrapeJpStations } from './japanStationsScraper.js';

declare const __dirname: string;
// CONFIG_PATH defaults to the bundled config.json (sibling of bin/) for the
// production plugin instance. Overridable via DECK_RX_CONFIG_PATH so the
// integration-test harness can point at a sandboxed config without touching
// the user-edited production config.
const CONFIG_PATH = process.env.DECK_RX_CONFIG_PATH ?? join(__dirname, '..', 'config.json');

export type DeemphasisOpt = 'off' | '50us' | '75us';

export interface FMOptions {
  deemphasis: DeemphasisOpt;
  ifnr: boolean;
  highPass: boolean;
  lowPass: boolean;
  stereo: boolean;
  // IF passband total channel width (Hz). JP FM broadcast spacing is 100
  // kHz (76.0 / 76.1 / 76.2 …), so the cycle (BW_CYCLE_FM in the dial
  // actions) includes 100 kHz and 90 kHz — narrow enough to suppress
  // the immediate-adjacent station ~−50 dB with 8th-order Butterworth.
  //   200000 = SDR++ default WFM IF, full Carson, all stereo intact
  //   150000 = light tightening, still keeps stereo subcarrier (53 kHz)
  //   110000 = stereo-just-fits, decent adjacent rejection
  //   100000 = matches one JP channel, mono only past this point
  //    90000 = aggressive adjacent rejection (~-50 dB at 100 kHz neighbour)
  bandwidth: number;
}

const DEFAULT_FM_OPTIONS: FMOptions = {
  deemphasis: '50us',
  ifnr: false,
  highPass: true,
  lowPass: true,
  stereo: false,
  bandwidth: 200000,  // SDR++ default for WFM is also 200 kHz
};

export interface AMOptions {
  bandwidth: number;   // Hz, 0 = no limit
  carrierAgc: boolean;
  agcAttack: number;   // 0..1 (per-sample IIR factor) — larger = faster
  agcDecay: number;    // 0..1
  sync: boolean;       // PLL-based synchronous AM detection (DSB)
}

const DEFAULT_AM_OPTIONS: AMOptions = {
  bandwidth: 9000,
  carrierAgc: true,
  // SDR++ slider convention (matches dsp::demod::AM init args). Value =
  // attack rate in 1/τ_seconds, range 1..200 for attack and 1..20 for decay.
  // The applyAMOptions() bridge converts rate → per-sample α via α = rate / fs
  // (where fs is the AGC sample rate, our audio rate after decimation).
  agcAttack: 50,
  agcDecay: 5,
  sync: false,
};

export interface SSBOptions {
  // Audio passband width after Weaver up-mix. With f_off = bandwidthHz/2 the
  // demod produces a 0..bandwidthHz audio band — typical SSB voice 2.4 kHz,
  // CW narrow 500 Hz. Range 250..3000.
  bandwidthHz: number;
  // CW BFO pitch — the audible frequency the unmodulated carrier is shifted
  // to. Range 400..900 Hz. Ignored for USB/LSB (those use bandwidthHz/2 as
  // their Weaver f_off instead).
  bfoPitchHz: number;
}

const DEFAULT_SSB_OPTIONS: SSBOptions = {
  bandwidthHz: 2400,
  bfoPitchHz: 700,
};

interface Config {
  host: string;
  port: number;
  enabled?: boolean;      // master ON/OFF (user-toggled via 2-second long press on the Tune dial)
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
    icecastPassword?: string;
    bitrate?: string;
  };
  fm?: Partial<FMOptions>;
  am?: Partial<AMOptions>;
  ssb?: Partial<SSBOptions>;
  volume?: number;
  muted?: boolean;
  tuneMode?: 'preset' | 'vfo';
  tuneStepHz?: number;
  // Per-demod-mode last-used step. Keyed on the numeric mode index
  // (0=NFM, 1=WFM, 2=AM, 4=USB, 5=CW, 6=LSB). Restored on setDemodMode
  // so each band sticks to its own step preference.
  tuneStepByMode?: Record<number, number>;
  jpRegion?: JpRegion;    // Active region for JP DB lookup + Update Now scrape target
  // When true, plugin runs importFromSdrpp() once at startup to merge any
  // new bookmarks the user added to SDR++ since the last sync. Off by
  // default — user opts in via the PI checkbox so we don't silently mutate
  // deck-rx's presets.json on boot.
  autoSyncSdrpp?: boolean;
}

type SyncListener     = (s: SyncInfo) => void;
type ConnectListener  = () => void;
type OptionsListener  = (o: FMOptions) => void;
type AMOptionsListener = (o: AMOptions) => void;
type SSBOptionsListener = (o: SSBOptions) => void;
type DeviceListener   = (d: DeviceInfo) => void;
type EnabledListener  = (enabled: boolean) => void;
type GainListener     = (gain: number, maxGain: number) => void;
type DemodModeListener = (mode: number) => void;
type AudioStateListener = (running: boolean, deviceName: string) => void;
type ConnectionStateListener = (connected: boolean) => void;
export type TuneMode = 'preset' | 'vfo';
type TuneModeListener = (mode: TuneMode) => void;
type TuneStepListener = (stepHz: number) => void;
// Step values exposed in the dial cycler (mirrors PI dial-tune Step menu).
// Kept as the union of every mode's candidate steps so the PI dropdown can
// stay static; the dial cycler picks the mode-specific subset instead.
export const TUNE_STEP_VALUES: number[] = [
  10, 50, 100, 500, 1000, 5000, 9000, 10000, 12500,
  25000, 50000, 100000, 200000, 500000, 1000000,
];

// Per-mode subsets — Combo Band-column Mode/Step row + Tune dial cycler use
// these so the user only spins through values that make sense for the
// current band:
//   WFM   broadcast FM (76–108 MHz, 100 kHz spacing in Japan)
//   NFM   VHF/UHF business + amateur (12.5/25 kHz typical)
//   AM    MW (9k JP/EU, 10k Americas) + SW (5k or 1k) + 100 Hz fine
//   USB/LSB  HF SSB voice (100–500 Hz fine, 1k coarse)
//   CW    HF CW QSO (10–100 Hz fine for zero-beat, 500/1k for sweeping)
const TUNE_STEP_WFM = [10000, 25000, 50000, 100000, 200000, 500000, 1000000];
const TUNE_STEP_NFM = [1000, 5000, 9000, 10000, 12500, 25000, 50000, 100000];
const TUNE_STEP_AM  = [100, 1000, 5000, 9000, 10000, 25000];
const TUNE_STEP_SSB = [50, 100, 500, 1000, 5000, 10000];
const TUNE_STEP_CW  = [10, 50, 100, 500, 1000];

export function tuneStepValuesForMode(mode: number): number[] {
  switch (mode) {
    case 1:                return TUNE_STEP_WFM;
    case 0:                return TUNE_STEP_NFM;
    case 2:                return TUNE_STEP_AM;
    case 4: case 6:        return TUNE_STEP_SSB;     // USB / LSB
    case 5:                return TUNE_STEP_CW;
    default:               return TUNE_STEP_VALUES;  // unknown → full list
  }
}

// Snap an arbitrary step value into the closest entry of the given list.
// Used at mode-change time so the persisted step from a previous mode (e.g.
// 1 MHz from WFM) snaps into the new mode's neighbourhood (e.g. 25 kHz on
// AM) instead of leaving the user with a step the band can't use.
export function snapTuneStepToList(stepHz: number, list: number[]): number {
  if (list.length === 0) return stepHz;
  if (list.includes(stepHz)) return stepHz;
  let best = list[0], bestDelta = Math.abs(stepHz - list[0]);
  for (const v of list) {
    const d = Math.abs(stepHz - v);
    if (d < bestDelta) { best = v; bestDelta = d; }
  }
  return best;
}

class SpyService {
  private client = new SpyClient();
  private connected = false;
  private connecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private syncListeners    = new Set<SyncListener>();
  private connectListeners = new Set<ConnectListener>();
  private optionsListeners = new Set<OptionsListener>();
  private amOptionsListeners = new Set<AMOptionsListener>();
  private ssbOptionsListeners = new Set<SSBOptionsListener>();
  private deviceListeners  = new Set<DeviceListener>();
  private volumeListeners  = new Set<(v: number, muted: boolean) => void>();
  private enabledListeners = new Set<EnabledListener>();
  // Force-render watch: dump-lcd.sh touches /tmp/deck-rx-lcd-force to ask
  // every currently-attached dial to re-render once (so panels without an
  // auto-render timer — AM Options, FM Options, Combo, etc — produce SVG
  // dumps without the user having to physically rotate each dial). The
  // watcher polls every 250 ms, fires all listeners once, then removes
  // the flag so it's edge-triggered.
  private forceRenderListeners = new Set<() => void>();
  private forceRenderTimer: ReturnType<typeof setInterval> | null = null;
  // Master ON/OFF: when false, connect()/scheduleReconnect() are no-ops and
  // any active connection is torn down. Default true (existing users keep
  // current behavior); persisted to config so toggle survives restarts.
  private enabled = true;
  // Active JP region for station-name lookup. Default 関東 keeps the pre-region
  // behaviour for users upgrading; persisted to config so a switch in PI
  // survives restart. Listeners (Tune dial) re-render their header when this
  // changes so the new region's lookup result shows up immediately.
  private jpActiveRegion: JpRegion = 'kanto';
  private autoSyncSdrpp = false;
  // Audio recording tap state.
  private audioTapFd: number | null = null;       // open file descriptor while recording
  private audioTapPath = '';                       // current WAV path
  private audioTapBytes = 0;                       // bytes of PCM data written (for header finalisation)
  private audioTapRate = 0;
  private audioTapChannels = 0;
  // Throttle the flag-existence check — fs.existsSync per IQ packet would
  // make 50+ syscalls/s. Sample at most every 500 ms.
  private audioTapLastCheck = 0;
  private jpRegionListeners = new Set<(r: JpRegion) => void>();
  private fmOptions: FMOptions = { ...DEFAULT_FM_OPTIONS };
  private amOptions: AMOptions = { ...DEFAULT_AM_OPTIONS };
  private ssbOptions: SSBOptions = { ...DEFAULT_SSB_OPTIONS };
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
  // Output health: true when the icecast publish ffmpeg has failed 3× in
  // quick succession (auth error / network unreachable). Cleared once a
  // spawn survives long enough or the user toggles back to local output.
  private audioOutputBroken = false;
  private audioOutputErrorTag: OutputErrorTag | null = null;
  private audioOutputBrokenListeners = new Set<(broken: boolean, tag: OutputErrorTag | null) => void>();
  // Tune dial mode + VFO step: global so the FM/AM Options panels can adjust
  // them without per-dial PI configuration. Replaces the previously per-dial
  // settings.mode / settings.stepHz.
  private tuneMode: TuneMode = 'preset';
  private tuneStepHz: number = 9000;
  // Per-mode last-used step value. setDemodMode saves the active step
  // to this.tuneStepByMode[outgoingMode] and restores from
  // this.tuneStepByMode[incomingMode] (when remembered). So switching
  // WFM → AM goes back to e.g. 9 kHz instead of clamping the 100 kHz
  // WFM step into AM's nearest valid value.
  private tuneStepByMode: Record<number, number> = {};
  private tuneModeListeners = new Set<TuneModeListener>();
  private tuneStepListeners = new Set<TuneStepListener>();
  // Debounced SpyServer apply for rapid dial rotations.
  private gainApplyTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingGainScope: 'am' | 'fm' | null = null;

  get currentFreq(): number { return this._currentFreq; }

  /** Resolves once the initial config load has populated startup-only
   *  fields (autoSyncSdrpp, jpActiveRegion). Plugin entry awaits this
   *  before deciding whether to run importFromSdrpp() at startup. */
  readonly ready: Promise<void>;

  constructor() {
    this.hookClient();
    this.startForceRenderWatcher();
    // Eagerly hydrate config so flags like autoSyncSdrpp are available
    // BEFORE the first connect().
    this.ready = this.loadConfig().then((cfg) => {
      if (typeof cfg.autoSyncSdrpp === 'boolean') this.autoSyncSdrpp = cfg.autoSyncSdrpp;
      if (isJpRegion(cfg.jpRegion)) this.jpActiveRegion = cfg.jpRegion;
    }).catch(() => { /* missing / unreadable config — fine, defaults apply */ });
  }

  private startForceRenderWatcher(): void {
    const FLAG = '/tmp/deck-rx-lcd-force';
    let fs: typeof import('fs') | null = null;
    try { fs = require('fs'); } catch { /* harness without fs — skip */ }
    if (!fs) return;
    this.forceRenderTimer = setInterval(() => {
      try {
        if (!fs!.existsSync(FLAG)) return;
        try { fs!.unlinkSync(FLAG); } catch { /* race or perms — fine */ }
        for (const fn of this.forceRenderListeners) {
          try { fn(); } catch { /* listener errors don't break others */ }
        }
      } catch { /* swallow */ }
    }, 250);
  }

  subscribeForceRender(fn: () => void): void { this.forceRenderListeners.add(fn); }
  unsubscribeForceRender(fn: () => void): void { this.forceRenderListeners.delete(fn); }

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
      this.stopAudio().catch(() => {});
      this.scheduleReconnect();
    });
    this.client.on('disconnect', () => {
      streamDeck.logger.warn('[spyService] disconnected');
      this.stopAudio().catch(() => {});
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
        const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
        // Migrate pre-2026-05-04 configs that stored agcAttack/Decay as
        // per-sample α (always < 1) instead of SDR++ rate (1..200 / 1..20).
        // Convert α → rate = -fs · ln(1 − α) at our 57 kHz audio rate.
        const FS = 57000;
        if (this.amOptions.agcAttack < 1) {
          this.amOptions.agcAttack = -FS * Math.log(1 - this.amOptions.agcAttack);
        }
        if (this.amOptions.agcDecay < 1) {
          this.amOptions.agcDecay = -FS * Math.log(1 - this.amOptions.agcDecay);
        }
        this.amOptions.agcAttack = clamp(this.amOptions.agcAttack, 1, 200);
        this.amOptions.agcDecay  = clamp(this.amOptions.agcDecay,  1, 20);
        for (const fn of this.amOptionsListeners) fn(this.amOptions);
      }
      if (cfg.ssb) {
        this.ssbOptions = { ...DEFAULT_SSB_OPTIONS, ...cfg.ssb };
        this.ssbOptions.bandwidthHz = Math.max(250, Math.min(3000, this.ssbOptions.bandwidthHz));
        this.ssbOptions.bfoPitchHz  = Math.max(400, Math.min(900,  this.ssbOptions.bfoPitchHz));
        for (const fn of this.ssbOptionsListeners) fn(this.ssbOptions);
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
        // Notify subscribers so dials hydrate from the persisted mode at
        // startup. Without this, the Combo dial's local mirror of currentMode
        // stays at its default (1) until something triggers setDemodMode,
        // and the Opts column shows the wrong shape on first paint after a
        // restart.
        for (const fn of this.demodModeListeners) fn(this.currentDemodMode);
      }
      if (cfg.tuneMode === 'preset' || cfg.tuneMode === 'vfo') {
        this.tuneMode = cfg.tuneMode;
      }
      if (typeof cfg.tuneStepHz === 'number' && cfg.tuneStepHz > 0) {
        this.tuneStepHz = cfg.tuneStepHz;
      }
      if (cfg.tuneStepByMode && typeof cfg.tuneStepByMode === 'object') {
        for (const [k, v] of Object.entries(cfg.tuneStepByMode)) {
          const m = Number(k);
          if (Number.isFinite(m) && typeof v === 'number' && v > 0) {
            this.tuneStepByMode[m] = v;
          }
        }
      }
      if (isJpRegion(cfg.jpRegion)) {
        this.jpActiveRegion = cfg.jpRegion;
      }
      if (typeof cfg.autoSyncSdrpp === 'boolean') {
        this.autoSyncSdrpp = cfg.autoSyncSdrpp;
      }
      for (const fn of this.tuneModeListeners) fn(this.tuneMode);
      for (const fn of this.tuneStepListeners) fn(this.tuneStepHz);
      for (const fn of this.jpRegionListeners) fn(this.jpActiveRegion);
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
      await this.stopAudio();
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
      this.muteUntil = Math.max(this.muteUntil, Date.now() + 200);
      this.demod.reset();
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
        this.demod.reset();
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
  setFrequency(hz: number, opts: { smooth?: boolean } = {}): void {
    this._currentFreq = hz;
    // Two retune flavours:
    //   smooth=false (default) — preset PUSH, band fallback, connect
    //     seed: one big freq jump. 100 ms mute + resetForRetune() so
    //     the atan2 phase wrap / AM AGC level step / sync PLL drag is
    //     hidden under mute and the demod re-converges fresh.
    //   smooth=true non-AM — pure pass-through.
    //   smooth=true AM — 200 ms mute (no demod state reset). AM sync
    //     mode produces a long phase-error noise burst on retune as
    //     the PLL re-locks; gate snap (commit 510ed2a) alone wasn't
    //     enough. A direct mute on the audio output covers the full
    //     re-lock window. PLL phase / freq state stay intact so the
    //     PLL adapts fast — by the time mute lifts the new carrier is
    //     locked and audio is clean. Cascade retunes stack the mute
    //     window so under rapid dial the user hears silence until
    //     they stop, then audio resumes on the final freq.
    if (!opts.smooth) {
      this.muteUntil = Math.max(this.muteUntil, Date.now() + 100);
      this.demod.resetForRetune();
    } else if (this.currentDemodMode === 2) {
      // 200 ms matches the AM sync PLL's pull-in at wn=150 Hz (see
      // setAmSync). Earlier 400 ms covered a slower 80 Hz PLL;
      // bumping wn allows the mute window to halve.
      this.muteUntil = Math.max(this.muteUntil, Date.now() + 200);
    }
    this.pendingFreq = hz;
    if (this.freqDebounceTimer) clearTimeout(this.freqDebounceTimer);
    this.freqDebounceTimer = setTimeout(() => {
      this.freqDebounceTimer = null;
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
    // IF passband — half the channel bandwidth becomes the LPF cutoff on
    // the complex IQ stream before the discriminator. 200 kHz channel →
    // 100 kHz cutoff; 150 kHz → 75 kHz; etc.
    if (this.currentIQRate > 0) {
      this.demod.setWfmIfBandwidth(this.currentIQRate, fm.bandwidth / 2);
      streamDeck.logger.info(`[spyService] setWfmIfBandwidth iqRate=${this.currentIQRate} bw=${fm.bandwidth} cutoff=${fm.bandwidth / 2}`);
    } else {
      streamDeck.logger.warn(`[spyService] applyFMOptions: currentIQRate=0, skipping setWfmIfBandwidth`);
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

  getSSBOptions(): SSBOptions { return { ...this.ssbOptions }; }
  async setSSBOption<K extends keyof SSBOptions>(key: K, value: SSBOptions[K]): Promise<void> {
    this.ssbOptions = { ...this.ssbOptions, [key]: value };
    // Re-setup the demodulator with the new value if SSB / CW is the active mode.
    this.applySsbOptions();
    for (const fn of this.ssbOptionsListeners) fn(this.ssbOptions);
    const raw = await readFile(CONFIG_PATH, 'utf8').catch(() => '{}');
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    cfg.ssb = { ...this.ssbOptions };
    await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  }
  subscribeSSBOptions(fn: SSBOptionsListener): void {
    this.ssbOptionsListeners.add(fn);
    fn(this.ssbOptions);
  }
  unsubscribeSSBOptions(fn: SSBOptionsListener): void { this.ssbOptionsListeners.delete(fn); }
  private applySsbOptions(): void {
    if (this.currentIQRate <= 0 || this.currentAudioRate <= 0) return;
    const m = this.currentDemodMode;
    if (m === 4 || m === 6) {
      // USB / LSB — Weaver f_off = bandwidth / 2 (so audio band 0..bandwidth)
      this.demod.setupSsb(this.currentIQRate, this.currentAudioRate, this.ssbOptions.bandwidthHz / 2);
    } else if (m === 5) {
      // CW — BFO pitch directly
      this.demod.setupCw(this.currentIQRate, this.currentAudioRate, this.ssbOptions.bfoPitchHz);
    }
    streamDeck.logger.info(`[spyService] applySsbOptions ${JSON.stringify(this.ssbOptions)}`);
  }

  private applyAMOptions(): void {
    const am = this.amOptions;
    if (this.currentAudioRate > 0) {
      this.demod.setAmBandwidth(this.currentAudioRate, am.bandwidth, this.currentIQRate);
    }
    // Convert SDR++ rate (per-second) → per-sample α at our audio rate. The
    // demod operates the AGC at the decimated audio rate (carrierAmp is
    // sampled in pass 2 of processAM at i += decimate).
    const fs = this.currentAudioRate > 0 ? this.currentAudioRate : 57000;
    const attackAlpha = am.agcAttack / fs;
    const decayAlpha  = am.agcDecay  / fs;
    this.demod.setAmAgc(am.carrierAgc, attackAlpha, decayAlpha);
    this.demod.setAmSync(am.sync, fs);
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
  /** Whether the audio sink (icecast publish ffmpeg) is in repeated-failure
   *  state — currently only meaningful for icecast mode. */
  isAudioOutputBroken(): boolean { return this.audioOutputBroken; }
  getAudioOutputErrorTag(): OutputErrorTag | null { return this.audioOutputErrorTag; }
  subscribeAudioOutputState(fn: (broken: boolean, tag: OutputErrorTag | null) => void): void {
    this.audioOutputBrokenListeners.add(fn);
    fn(this.audioOutputBroken, this.audioOutputErrorTag);
  }
  unsubscribeAudioOutputState(fn: (broken: boolean, tag: OutputErrorTag | null) => void): void {
    this.audioOutputBrokenListeners.delete(fn);
  }
  /** WFM pilot power (smoothed). Use with a threshold to detect stereo broadcasts. */
  getPilotPower(): number { return this.demod.getPilotPower(); }
  getPllLocked(): boolean { return this.demod.getPllLocked(); }
  getStereoBadgeLock(): boolean { return this.demod.getStereoBadgeLock(); }
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

  getTuneMode(): TuneMode { return this.tuneMode; }
  getTuneStepHz(): number { return this.tuneStepHz; }
  subscribeTuneMode(fn: TuneModeListener): void {
    this.tuneModeListeners.add(fn);
    fn(this.tuneMode);
  }
  unsubscribeTuneMode(fn: TuneModeListener): void { this.tuneModeListeners.delete(fn); }
  subscribeTuneStep(fn: TuneStepListener): void {
    this.tuneStepListeners.add(fn);
    fn(this.tuneStepHz);
  }
  unsubscribeTuneStep(fn: TuneStepListener): void { this.tuneStepListeners.delete(fn); }
  setTuneMode(mode: TuneMode): void {
    if (this.tuneMode === mode) return;
    this.tuneMode = mode;
    for (const fn of this.tuneModeListeners) fn(mode);
    this.persistField('tuneMode', mode).catch(() => {});
  }
  setTuneStepHz(hz: number): void {
    if (!(hz > 0) || this.tuneStepHz === hz) return;
    this.tuneStepHz = hz;
    // Remember per-mode so a future setDemodMode round trip restores
    // the value the user explicitly picked here, not just a clamped
    // version of an unrelated other-mode step.
    this.tuneStepByMode[this.currentDemodMode] = hz;
    for (const fn of this.tuneStepListeners) fn(hz);
    this.persistField('tuneStepHz', hz).catch(() => {});
    this.persistField('tuneStepByMode', this.tuneStepByMode).catch(() => {});
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
    // Remember the step the user had for the outgoing mode so a future
    // round trip restores it. Cheap and lets WFM 100 kHz / AM 9 kHz /
    // SSB 100 Hz / etc. each stay sticky per band.
    this.tuneStepByMode[prevMode] = this.tuneStepHz;
    this.currentDemodMode = mode;
    this.muteUntil = Math.max(this.muteUntil, Date.now() + 100);
    this.demod.reset();
    this.iqnr.setMode(mode as DemodMode, this.currentIQRate);
    // Restore the step we last used in this mode, if known and still
    // valid for the mode's candidate list. Otherwise fall back to
    // snapping the previous step into the new mode's range.
    const newStepList = tuneStepValuesForMode(mode);
    const remembered = this.tuneStepByMode[mode];
    const next = (typeof remembered === 'number' && newStepList.includes(remembered))
      ? remembered
      : snapTuneStepToList(this.tuneStepHz, newStepList);
    if (next !== this.tuneStepHz) {
      this.tuneStepHz = next;
      this.persistField('tuneStepHz', next).catch(() => {});
      for (const fn of this.tuneStepListeners) fn(this.tuneStepHz);
    }
    this.persistField('tuneStepByMode', this.tuneStepByMode).catch(() => {});
    // SSB / CW need the Weaver oscillator (and BFO for CW) re-tuned whenever
    // the active mode lands on 4 / 5 / 6. applySsbOptions is a no-op for
    // other modes.
    this.applySsbOptions();
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
      this.muteUntil = Math.max(this.muteUntil, Date.now() + 250);
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
    if (this.audioRunning) await this.stopAudio();
    if (this.audioOutputBroken) {
      this.audioOutputBroken = false;
      this.audioOutputErrorTag = null;
      for (const fn of this.audioOutputBrokenListeners) fn(false, null);
    }
    if (!cfg) cfg = await this.loadConfig();
    if (!cfg.audioEnabled) return;
    if (!this.deviceInfo) {
      streamDeck.logger.warn('[spyService] startAudio: no deviceInfo yet');
      return;
    }

    const info = this.deviceInfo;
    // SDR++ formula: actualRate = MaximumSampleRate / 2^decimationStage
    // Config provides decimation OFFSET from MinimumIQDecimation (matches SDR++ srId)
    // Default lowered from 2 → 1 (iqRate doubles from ~228 kHz to ~456 kHz on
    // Airspy HF+) so the Nyquist band sits well past the FM IF passband, and
    // far-adjacent stations no longer alias back into the user-visible
    // baseband. With iqRate=228 kHz an FM station 170 kHz off-tune used to
    // wrap to −58 kHz baseband (inside our IF LPF), so even the narrow BW
    // settings (90/100 kHz) couldn't suppress it — symptom was "switching BW
    // barely changes anything; 80 MHz tuned still leaks 80.17 MHz".
    const decOffset = cfg.iqDecimation ?? 1;
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
    // Apply FM/AM/SSB options (de-emph + audio filters + AM bandwidth/AGC,
    // Weaver oscillator + BFO for SSB/CW). All three are no-ops when the
    // current demod mode does not need them.
    this.applyFMOptions();
    this.applyAMOptions();
    this.applySsbOptions();

    streamDeck.logger.info(`[spyService] startAudio decStage=${decStage} iqRate=${iqRate} audioRate=${audioRate} gain=${gain}`);

    // Build audio output
    if (cfg.audioOutput === 'naudiodon') {
      this.audioOutput = new NaudiodonOutput(cfg.naudiodon ?? {});
      this.currentAudioDeviceName = `naudiodon#${cfg.naudiodon?.deviceId ?? -1}`;
    } else {
      const ffOut = new FfmpegOutput({
        mode:            cfg.ffmpeg?.mode        ?? 'local',
        deviceName:      cfg.ffmpeg?.deviceName,
        icecastUrl:      cfg.ffmpeg?.icecastUrl,
        icecastPassword: cfg.ffmpeg?.icecastPassword,
        bitrate:         cfg.ffmpeg?.bitrate,
      });
      ffOut.setStateChangeHandler((broken, info) => {
        if (this.audioOutputBroken === broken) return;
        this.audioOutputBroken = broken;
        this.audioOutputErrorTag = broken ? (info?.tag ?? 'Other') : null;
        if (broken) streamDeck.logger.warn(`[spyService] audio output broken (${info?.tag}): ${info?.raw ?? '(no detail)'}`);
        else streamDeck.logger.info('[spyService] audio output recovered');
        for (const fn of this.audioOutputBrokenListeners) fn(broken, this.audioOutputErrorTag);
      });
      this.audioOutput = ffOut;
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
    this.muteUntil = Math.max(this.muteUntil, Date.now() + 500);

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
      //
      // For FM modes (WFM / NFM) the meanP is taken from the post-IF-LPF
      // power tracked inside the demodulator — otherwise strong neighbours
      // sitting in the SpyServer's ±228 kHz baseband (e.g. TBS 79.5 MHz
      // when the user is tuned to 79.7 MHz) contribute to the RSSI and
      // peg the S-meter on a supposedly empty channel. AM / SSB / CW
      // keep the raw-IQ measurement because their IF LPFs are narrower
      // and run inside processAM/SSB/CW; the WFM IF LPF is the relevant
      // one for FM modes here.
      if (p.format === 'int16') {
        const NORM = 32767 * 32767;
        const isFm = this.currentDemodMode === 0 || this.currentDemodMode === 1;
        let sumP = 0, sumP2 = 0;
        const N = p.body.length >> 2;
        for (let i = 0; i < N; i++) {
          const I = p.body.readInt16LE(i * 4);
          const Q = p.body.readInt16LE(i * 4 + 2);
          const power = (I * I + Q * Q) / NORM;  // 0..~2 typical
          sumP  += power;
          sumP2 += power * power;
        }
        const meanP  = isFm
          ? (this.demod.getWfmInBandMeanP() / NORM)
          : (sumP  / Math.max(1, N));
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
      // Audio-level scale derived from the per-mode RF Gain index. AM is
      // already amplitude-driven so the gain affects audio naturally; FM
      // (atan2) is amplitude-invariant so the RF gain alone does NOT
      // change audio level — repurpose fmGain as a post-demod multiplier
      // so the user-facing dial actually attenuates FM/NFM/SSB/CW audio
      // (8/8 = full level, 0/8 = silent), not just RSSI. This gives the
      // user the attenuator control they expect from the Gain row.
      const maxG = this.deviceInfo?.maxGainIndex ?? 0;
      const fmAudioScale = maxG > 0 ? (this.fmGain ?? maxG) / maxG : 1;
      let pcm: Int16Array;
      if (this.currentDemodMode === 2) {
        const amG = this.amGain ?? 0;
        const gainScale = maxG > 0 ? amG / maxG : 1;
        pcm = this.demod.processAM(iqBody, dec, gainScale);
      } else if (this.currentDemodMode === 1) {
        pcm = this.fmOptions.stereo
          ? this.demod.processWFMStereo(iqBody, dec, 2000 * fmAudioScale)
          : this.demod.processWFM(iqBody, dec, 3000 * fmAudioScale);
      } else if (this.currentDemodMode === 4 || this.currentDemodMode === 6) {
        // USB (mode 4) / LSB (mode 6) — Weaver SSB demod. f_off = bandwidth/2
        // so the audio band ends up 0..bandwidth (default 2.4 kHz).
        this.demod.setupSsb(this.currentIQRate, this.currentAudioRate, this.ssbOptions.bandwidthHz / 2);
        pcm = this.demod.processSSB(iqBody, dec, this.currentDemodMode === 4 ? 'USB' : 'LSB', 48000 * fmAudioScale);
      } else if (this.currentDemodMode === 5) {
        // CW (mode 5) — direct frequency-shift by BFO (default 700 Hz).
        this.demod.setupCw(this.currentIQRate, this.currentAudioRate, this.ssbOptions.bfoPitchHz);
        pcm = this.demod.processCW(iqBody, dec, 48000 * fmAudioScale);
      } else {
        // NFM (mode 0) — also catches DSB (3) and RAW (7) which fall through
        // to FM until proper demod is implemented.
        pcm = this.demod.processFM(iqBody, dec, 6000 * fmAudioScale);
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
      // Audio tap — file-flag-triggered, same pattern as the LCD-dump hook.
      // touch /tmp/deck-rx-audio-record to start; rm /tmp/deck-rx-audio-record
      // to stop. While the flag exists every PCM buffer is appended to a
      // single WAV file (path printed in the log) so the user can compare
      // the deck-rx output to a SDR++ recording of the same station.
      this.tapAudio(pcm, audioRate, channels);
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

  async stopAudio(): Promise<void> {
    if (this.iqListener) {
      this.client.off('iqData', this.iqListener);
      this.iqListener = null;
    }
    try { this.client.stopStreaming(); } catch {}
    const out = this.audioOutput;
    this.audioOutput = null;
    if (out) { try { await out.stop(); } catch {} }
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
      iqDecimation:  cfg.iqDecimation  ?? 1,
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
      tuneMode:      cfg.tuneMode === 'preset' || cfg.tuneMode === 'vfo' ? cfg.tuneMode : undefined,
      tuneStepHz:    typeof cfg.tuneStepHz === 'number' && cfg.tuneStepHz > 0 ? cfg.tuneStepHz : undefined,
      jpRegion:      isJpRegion(cfg.jpRegion) ? cfg.jpRegion : undefined,
      autoSyncSdrpp: !!cfg.autoSyncSdrpp,
    };
  }

  /** Audio output tap — when /tmp/deck-rx-audio-record exists, every PCM
   *  buffer is appended to a WAV file so the user can capture deck-rx's
   *  audio output for offline analysis (e.g. spectrum comparison with a
   *  SDR++ recording of the same station). The flag's existence is
   *  polled at 2 Hz; toggling the flag opens/closes the WAV cleanly with
   *  a finalised RIFF header.
   *
   *  This is intentionally not a per-listener pub/sub API — the file-flag
   *  pattern matches the existing LCD-dump hook, doesn't require any
   *  external Node script, and the user can scp the WAV elsewhere. */
  private tapAudio(pcm: Int16Array, rate: number, channels: number): void {
    const FLAG = '/tmp/deck-rx-audio-record';
    const now = Date.now();
    if (now - this.audioTapLastCheck > 500) {
      this.audioTapLastCheck = now;
      const fs = require('fs') as typeof import('fs');
      const wanted = fs.existsSync(FLAG);
      if (wanted && this.audioTapFd === null) {
        const ts = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+$/, '');
        const path = `/tmp/deck-rx-audio-${ts}.wav`;
        try {
          const fd = fs.openSync(path, 'w');
          // Reserve a 44-byte RIFF header; we patch in the data-chunk size
          // on close so the file is playable even mid-stream (some apps
          // will play it as-is and skip past the trailing silence).
          const stub = Buffer.alloc(44);
          stub.write('RIFF', 0);  stub.writeUInt32LE(36, 4);   stub.write('WAVE', 8);
          stub.write('fmt ', 12); stub.writeUInt32LE(16, 16);  stub.writeUInt16LE(1, 20);    // PCM
          stub.writeUInt16LE(channels, 22);
          stub.writeUInt32LE(rate, 24);
          stub.writeUInt32LE(rate * channels * 2, 28);
          stub.writeUInt16LE(channels * 2, 32); stub.writeUInt16LE(16, 34);
          stub.write('data', 36); stub.writeUInt32LE(0, 40);
          fs.writeSync(fd, stub);
          this.audioTapFd = fd;
          this.audioTapPath = path;
          this.audioTapBytes = 0;
          this.audioTapRate = rate;
          this.audioTapChannels = channels;
          streamDeck.logger.info(`[spyService] audio tap → ${path} (${rate} Hz × ${channels} ch)`);
        } catch (e) {
          streamDeck.logger.warn(`[spyService] audio tap open failed: ${e}`);
        }
      } else if (!wanted && this.audioTapFd !== null) {
        try {
          const fd = this.audioTapFd;
          const dataBytes = this.audioTapBytes;
          // Patch RIFF size and data-chunk size
          const sizes = Buffer.alloc(8);
          sizes.writeUInt32LE(36 + dataBytes, 0);  // file size − 8
          fs.writeSync(fd, sizes.slice(0, 4), 0, 4, 4);
          const dataSize = Buffer.alloc(4);
          dataSize.writeUInt32LE(dataBytes, 0);
          fs.writeSync(fd, dataSize, 0, 4, 40);
          fs.closeSync(fd);
          streamDeck.logger.info(`[spyService] audio tap closed: ${this.audioTapPath} (${dataBytes} bytes)`);
        } catch { /* fd may already be gone */ }
        this.audioTapFd = null;
        this.audioTapPath = '';
        this.audioTapBytes = 0;
      }
    }
    if (this.audioTapFd !== null) {
      // Write the raw PCM bytes — pcm is an Int16Array, so its underlying
      // ArrayBuffer is the little-endian byte sequence WAV expects.
      try {
        const buf = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
        const fs = require('fs') as typeof import('fs');
        fs.writeSync(this.audioTapFd, buf);
        this.audioTapBytes += buf.length;
      } catch { /* fd error — drop silently */ }
    }
  }

  isAutoSyncSdrpp(): boolean { return !!this.autoSyncSdrpp; }
  async setAutoSyncSdrpp(b: boolean): Promise<void> {
    this.autoSyncSdrpp = !!b;
    await this.persistField('autoSyncSdrpp', this.autoSyncSdrpp).catch(() => {});
  }

  async getAudioPersistedConfig(): Promise<{
    audioEnabled: boolean;
    deviceName: string;
    outputMode: 'local' | 'icecast';
    icecastUrl: string;
    icecastPassword: string;
    bitrate: string;
  }> {
    const cfg = await this.loadConfig();
    // Split any embedded password out of icecastUrl so the PI can hand the
    // URL (no creds) and password (masked field) separately. Migration: if
    // the user pasted icecast://u:pass@host/m before the split landed, we
    // pull the password out here and surface it as icecastPassword.
    const rawUrl = cfg.ffmpeg?.icecastUrl ?? '';
    const explicitPwd = cfg.ffmpeg?.icecastPassword ?? '';
    const m = rawUrl.match(/^(\w+:\/\/[^:@/]+):([^@]*)@(.*)$/);
    const urlClean = m ? `${m[1]}@${m[3]}` : rawUrl;
    const pwd = explicitPwd || (m ? m[2] : '');
    return {
      audioEnabled:    !!cfg.audioEnabled,
      deviceName:      cfg.ffmpeg?.deviceName ?? 'default',
      outputMode:      (cfg.ffmpeg?.mode === 'icecast' ? 'icecast' : 'local'),
      icecastUrl:      urlClean,
      icecastPassword: pwd,
      bitrate:         cfg.ffmpeg?.bitrate ?? '128k',
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
    await this.stopAudio();
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

  /**
   * Status of the locally cached EIBI database. PI populates the "Last update"
   * line from this on open. `when` is the file's mtime (null if no file yet).
   */
  async getEibiStatus(): Promise<{ when: string | null; count: number }> {
    try {
      const st = await stat(getEibiPath());
      return { when: st.mtime.toISOString(), count: eibiEntryCount() };
    } catch {
      return { when: null, count: 0 };
    }
  }

  /**
   * Pull the latest EIBI shortwave broadcaster schedule from upstream and
   * replace the in-bundle copy. Sequence: fetch → ISO-8859-1 → UTF-8 →
   * parse-validate (≥ 1000 entries) → backup current → atomic rename →
   * invalidate cache. Aborts non-destructively if any step fails.
   */
  async updateEibi(): Promise<{ ok: true; count: number; when: string } | { ok: false; error: string }> {
    const url = 'http://eibispace.de/dx/eibi.txt';
    const path = getEibiPath();
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 30000);
      let resp: Response;
      try {
        resp = await fetch(url, { signal: ctrl.signal });
      } finally {
        clearTimeout(t);
      }
      if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length < 100 * 1024) return { ok: false, error: `too small (${buf.length} bytes)` };
      const text = buf.toString('latin1');
      const parsed = parseEibiText(text);
      if (parsed.length < 1000) return { ok: false, error: `too few entries (${parsed.length})` };

      // Backup current file under CLAUDE.md's naming rule, then atomic-replace.
      const ts = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const stamp =
        `${ts.getFullYear()}-${pad(ts.getMonth() + 1)}-${pad(ts.getDate())}` +
        `-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
      try { await rename(path, `${path}.${stamp}`); } catch { /* no prior file */ }
      const tmp = `${path}.tmp`;
      await writeFile(tmp, text, 'utf-8');
      await rename(tmp, path);
      clearEibiCache();
      const st = await stat(path);
      streamDeck.logger.info(`[spyService] EIBI updated: ${parsed.length} entries (${buf.length} bytes)`);
      return { ok: true, count: parsed.length, when: st.mtime.toISOString() };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      streamDeck.logger.error(`[spyService] updateEibi failed: ${msg}`);
      return { ok: false, error: msg };
    }
  }

  /**
   * Status of the locally cached JP-stations DB for the currently-active
   * region. PI populates the "Last update" line from this. `count` is the
   * number of auto-scraped entries tagged with the active region;
   * `manualCount` is the region-independent hand-curated pool.
   */
  async getJpStationsStatus(): Promise<{
    when: string | null; count: number;
    region: JpRegion; manualCount: number; totalAuto: number;
  }> {
    try {
      const st = await stat(getJpStationsPath());
      return {
        when:        st.mtime.toISOString(),
        count:       jpStationCountForRegion(this.jpActiveRegion),
        region:      this.jpActiveRegion,
        manualCount: jpStationCountManual(),
        totalAuto:   jpStationCountAuto(),
      };
    } catch {
      return {
        when: null, count: 0,
        region: this.jpActiveRegion, manualCount: 0, totalAuto: 0,
      };
    }
  }

  /** Active JP DB region (PI dropdown). Used by lookups + Update Now. */
  getJpActiveRegion(): JpRegion { return this.jpActiveRegion; }

  /** Set the active JP region — persists to config and notifies listeners
   * so dials re-render their header lookup. No-op if unchanged.
   * Uses persistField (single-key chained write) instead of loadConfig
   * round-tripping; the latter would silently drop any field absent from
   * loadConfig's return shape (notably tuneMode / tuneStepHz, which were
   * being clobbered every time the user switched JP region). */
  async setJpActiveRegion(region: JpRegion): Promise<void> {
    if (this.jpActiveRegion === region) return;
    this.jpActiveRegion = region;
    await this.persistField('jpRegion', region).catch((e) =>
      streamDeck.logger.error(`[spyService] persist jpRegion failed: ${e}`));
    for (const fn of this.jpRegionListeners) fn(region);
  }

  subscribeJpRegion(fn: (r: JpRegion) => void): void {
    this.jpRegionListeners.add(fn);
    fn(this.jpActiveRegion); // replay current value
  }
  unsubscribeJpRegion(fn: (r: JpRegion) => void): void {
    this.jpRegionListeners.delete(fn);
  }

  /**
   * Pull the latest 総合通信局 ラジオ放送 list for the active region, parse
   * it, and merge the result into `stations[]` — entries from OTHER regions
   * are preserved as-is, only this region's entries are replaced. This way
   * a 関東 user who switches to 近畿 to grab that area's stations doesn't
   * lose their 関東 entries on the way back. `manualStations` is also
   * preserved verbatim (hand-curated, region-independent). The previous
   * file is backed up as `.YYYY-MM-DD-HHMMSS`. The in-memory cache is
   * invalidated so the next lookupJpStation reads fresh data.
   */
  async updateJpStations(): Promise<{ ok: true; count: number; when: string; region: JpRegion } | { ok: false; error: string; region: JpRegion }> {
    const path = getJpStationsPath();
    const region = this.jpActiveRegion;
    try {
      const scraped = await scrapeJpStations(region);

      // Read current file: keep entries from OTHER regions + manualStations + _comment.
      let existingOther: JpStation[] = [];
      let manual: unknown = [];
      let comment: unknown = undefined;
      try {
        const cur = JSON.parse(await readFile(path, 'utf-8')) as { _comment?: unknown; stations?: JpStation[]; manualStations?: unknown };
        existingOther = (cur.stations ?? []).filter(s => s.region !== region);
        manual = cur.manualStations ?? [];
        comment = cur._comment;
      } catch { /* fresh file */ }

      const merged = [...existingOther, ...scraped].sort((a, b) => a.freqHz - b.freqHz);

      const next: Record<string, unknown> = {};
      if (comment !== undefined) next._comment = comment;
      next.stations       = merged;
      next.manualStations = manual;

      // Backup current file under CLAUDE.md's naming rule, then atomic-replace.
      const ts = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const stamp =
        `${ts.getFullYear()}-${pad(ts.getMonth() + 1)}-${pad(ts.getDate())}` +
        `-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
      try { await rename(path, `${path}.${stamp}`); } catch { /* no prior file */ }
      const tmp = `${path}.tmp`;
      await writeFile(tmp, JSON.stringify(next, null, 2) + '\n', 'utf-8');
      await rename(tmp, path);
      clearJpStationsCache();
      const st = await stat(path);
      streamDeck.logger.info(`[spyService] JP stations updated: region=${region}, ${scraped.length} new entries (total ${merged.length})`);
      return { ok: true, count: scraped.length, when: st.mtime.toISOString(), region };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      streamDeck.logger.error(`[spyService] updateJpStations failed: ${msg}`);
      return { ok: false, error: msg, region };
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
      await this.stopAudio();
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
