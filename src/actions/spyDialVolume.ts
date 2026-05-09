import { action, DialDownEvent, DialRotateEvent, DialUpEvent, SingletonAction, WillAppearEvent, WillDisappearEvent, DidReceiveSettingsEvent } from '@elgato/streamdeck';
import streamDeck from '@elgato/streamdeck';
import { spyService } from '../spyService.js';
import type { OutputErrorTag } from '../AudioOutput.js';
import { DeviceInfo, DEVICE_AIRSPY_ONE, DEVICE_AIRSPY_HF, DEVICE_RTLSDR } from '../SpyClient.js';
import { svgB64, dumpAndB64 } from '../dialDisplay.js';
import { knobSvg, optionsPanelSvg, OptionsPanelRow, dimSvg } from '../icons.js';
import { currentTimeHHMM } from './spyDialTune.js';

type Settings = {
  borderSide?: 'left' | 'right' | 'center' | 'none';
  step?: number;  // % per tick (default 2)
};

function deviceName(t: number): string {
  if (t === DEVICE_AIRSPY_ONE) return 'Airspy R2';
  if (t === DEVICE_AIRSPY_HF)  return 'Airspy HF+';
  if (t === DEVICE_RTLSDR)     return 'RTL-SDR';
  return `type${t}`;
}

function fmtFreq(hz: number): string {
  if (hz >= 1_000_000) return (hz / 1_000_000).toFixed(3) + 'M';
  if (hz >= 1_000)     return (hz / 1_000).toFixed(1)   + 'k';
  return String(hz);
}

@action({ UUID: 'com.hogehoge.deck-rx.dial-volume' })
export class SpyDialVolume extends SingletonAction<Settings> {
  private borderSide: 'left' | 'right' | 'center' | 'none' = 'none';
  private step = 2;
  private act: { setImage: (s: string) => Promise<void>; setFeedback: (f: Record<string, unknown>) => Promise<void> } | null = null;
  private volListener: ((v: number, muted: boolean) => void) | null = null;
  private connectListener: (() => void) | null = null;
  private deviceListener: ((d: DeviceInfo) => void) | null = null;
  private enabledListener: ((on: boolean) => void) | null = null;
  private audioStateListener: ((running: boolean, deviceName: string) => void) | null = null;
  private connStateListener: ((c: boolean) => void) | null = null;
  private audioOutputStateListener: ((broken: boolean, tag: OutputErrorTag | null) => void) | null = null;
  private audioOutputBroken = false;
  private audioOutputErrorTag: OutputErrorTag | null = null;
  private device: DeviceInfo | null = null;
  private connected = false;
  private enabled = true;
  // Tick the title-bar clock every second. Same cadence as the Tune dial's
  // footerTimer; impact on the SDK WebSocket is negligible.
  private clockTimer: ReturnType<typeof setInterval> | null = null;

  override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
    this.act = ev.action as unknown as typeof this.act;
    this.borderSide = ev.payload.settings.borderSide ?? 'none';
    this.step = ev.payload.settings.step ?? 2;
    this.device = spyService.getDeviceInfo();
    this.connected = spyService.isConnected();

    this.volListener = () => this.render();
    spyService.subscribeVolume(this.volListener);
    this.deviceListener = (d) => { this.device = d; this.render(); };
    spyService.subscribeDevice(this.deviceListener);
    this.connectListener = () => { this.connected = true; this.render(); };
    spyService.onConnect(this.connectListener);
    this.enabledListener = (on) => {
      this.enabled = on;
      // Going OFF tears down the connection; reflect immediately in display.
      if (!on) this.connected = false;
      this.render();
    };
    spyService.subscribeEnabled(this.enabledListener);
    // AOut needs to update the moment audio actually starts/stops — without
    // this, the device name only refreshes on unrelated events like volume
    // changes, leading to "-" sticking around for a while after connect.
    this.audioStateListener = () => this.render();
    spyService.subscribeAudioState(this.audioStateListener);
    this.connStateListener = (c) => { this.connected = c; this.render(); };
    spyService.subscribeConnectionState(this.connStateListener);
    this.audioOutputStateListener = (broken, tag) => {
      this.audioOutputBroken = broken;
      this.audioOutputErrorTag = tag;
      this.render();
    };
    spyService.subscribeAudioOutputState(this.audioOutputStateListener);

    spyService.connect().catch((e) => streamDeck.logger.error(`[spyDialVolume] ${e}`));
    await ev.action.setImage(svgB64(knobSvg()));
    this.clockTimer = setInterval(() => this.render(), 1000);
    this.render();
  }

  override onWillDisappear(_ev: WillDisappearEvent<Settings>): void {
    if (this.volListener)     { spyService.unsubscribeVolume(this.volListener);    this.volListener     = null; }
    if (this.deviceListener)  { spyService.unsubscribeDevice(this.deviceListener); this.deviceListener  = null; }
    if (this.connectListener) { spyService.offConnect(this.connectListener);       this.connectListener = null; }
    if (this.enabledListener) { spyService.unsubscribeEnabled(this.enabledListener); this.enabledListener = null; }
    if (this.audioStateListener) { spyService.unsubscribeAudioState(this.audioStateListener); this.audioStateListener = null; }
    if (this.connStateListener)  { spyService.unsubscribeConnectionState(this.connStateListener); this.connStateListener = null; }
    if (this.audioOutputStateListener) { spyService.unsubscribeAudioOutputState(this.audioOutputStateListener); this.audioOutputStateListener = null; }
    if (this.clockTimer) { clearInterval(this.clockTimer); this.clockTimer = null; }
    this.act = null;
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): void {
    this.borderSide = ev.payload.settings.borderSide ?? 'none';
    this.step = ev.payload.settings.step ?? 2;
    this.render();
  }

  override onDialRotate(ev: DialRotateEvent<Settings>): void {
    const ticks = ev.payload.ticks;
    // Acceleration: faster spin → larger step
    const absTicks = Math.abs(ticks);
    const accel = absTicks > 5 ? 5 : absTicks > 2 ? 3 : this.step;
    const cur = spyService.getVolume() * 100;
    const next = Math.max(0, Math.min(150, cur + ticks * accel));
    spyService.setVolume(next / 100);
  }

  override onDialDown(_ev: DialDownEvent<Settings>): void {}
  override onDialUp(_ev: DialUpEvent<Settings>): void {
    spyService.setMuted(!spyService.isMuted());
  }

  private render(): void {
    if (!this.act) return;
    const v = spyService.getVolume();
    const m = spyService.isMuted();
    const pct = Math.round(v * 100);
    const srv = spyService.getServerAddress();
    const iqRate = spyService.getCurrentIQRate();
    const d = this.device;
    // Connection status — broadcasting-style "ONLINE" tally in red while
    // streaming, plain "OFFLINE" once the master switch / TCP is down.
    const isOnline = this.enabled && this.connected;
    const conn = isOnline ? 'ONLINE' : 'OFFLINE';
    const connColor = isOnline ? '#ff3333' : undefined;

    const aout = spyService.getAudioDeviceName() || '-';
    // "Pub" row: only meaningful in icecast mode. Reflects whether the
    // ffmpeg → icecast publish has stabilised (OK) or is failing in a tight
    // respawn loop (ERR — typical when source-password mismatches or the
    // icecast host is unreachable).
    const isIcecast = aout === 'icecast';
    const rows: OptionsPanelRow[] = [
      { label: 'Conn', value: conn, valueColor: connColor },
      { label: 'Host', value: srv.host || '-' },
      { label: 'Dev',  value: d ? `${deviceName(d.deviceType)} ${iqRate > 0 ? fmtFreq(iqRate) : ''}` : '-' },
      { label: 'AOut', value: aout },
      ...(isIcecast ? [{
        label: 'Pub',
        value: this.audioOutputBroken
          ? `ERR ${this.audioOutputErrorTag ?? 'Other'}`
          : 'OK',
        valueColor: this.audioOutputBroken ? '#ff3333' : '#33dd66',
      }] : []),
      {
        label: 'Vol',
        value: m ? 'Muted' : `${pct}%`,
        // Pass the unclamped percentage (up to 150) so the bar can grow into
        // the >100 % overdrive zone — the panel's bar renderer scales fill to
        // BAR_MAX_PCT and switches colour past 100.
        bar: m ? 0 : pct,
        barMuted: m,
      },
    ];
    const dim = !this.enabled || !this.connected;
    // Title bar shows the live HH:MM (TZ) clock that the Tune dial used to
    // carry. Updates every second via clockTimer.
    const title = currentTimeHHMM();
    this.act.setFeedback({
      'vol-display': dumpAndB64('volume', dimSvg(optionsPanelSvg(rows, -1, false, this.borderSide, title), dim)),
    }).catch(() => {});
  }
}
