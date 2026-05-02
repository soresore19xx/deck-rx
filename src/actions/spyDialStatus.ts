import { action, SingletonAction, WillAppearEvent, WillDisappearEvent, DialRotateEvent, DialDownEvent, DialUpEvent, DidReceiveSettingsEvent } from '@elgato/streamdeck';
import streamDeck from '@elgato/streamdeck';
import { spyService } from '../spyService.js';
import { DeviceInfo, SyncInfo, DEVICE_AIRSPY_ONE, DEVICE_AIRSPY_HF, DEVICE_RTLSDR } from '../SpyClient.js';
import { svgB64, knobSvg, optionsPanelSvg, OptionsPanelRow } from '../icons.js';

type Settings = { borderSide?: 'left' | 'right' | 'center' | 'none' };

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

@action({ UUID: 'com.hogehoge.spyserver-ex.dial-status' })
export class SpyDialStatus extends SingletonAction<Settings> {
  private borderSide: 'left' | 'right' | 'center' | 'none' = 'none';
  private act: { setImage: (s: string) => Promise<void>; setFeedback: (f: Record<string, unknown>) => Promise<void> } | null = null;
  private device: DeviceInfo | null = null;
  private lastSync: SyncInfo | null = null;
  private connected = false;
  private syncListener: ((s: SyncInfo) => void) | null = null;
  private connectListener: (() => void) | null = null;
  private deviceListener: ((d: DeviceInfo) => void) | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
    this.act = ev.action as unknown as typeof this.act;
    this.borderSide = ev.payload.settings.borderSide ?? 'none';
    this.device = spyService.getDeviceInfo();
    this.connected = spyService.isConnected();

    this.deviceListener = (d) => { this.device = d; this.render(); };
    spyService.subscribeDevice(this.deviceListener);

    this.syncListener = (s) => { this.lastSync = s; this.render(); };
    spyService.subscribe(this.syncListener);

    this.connectListener = () => { this.connected = true; this.render(); };
    spyService.onConnect(this.connectListener);

    await ev.action.setImage(svgB64(knobSvg()));
    spyService.connect().catch((e) => streamDeck.logger.error(`[spyDialStatus] ${e}`));
    // Periodically refresh to update pilot/stereo lock indicator
    this.refreshTimer = setInterval(() => this.render(), 1000);
    this.render();
  }

  override onWillDisappear(_ev: WillDisappearEvent<Settings>): void {
    if (this.deviceListener)  { spyService.unsubscribeDevice(this.deviceListener);   this.deviceListener  = null; }
    if (this.syncListener)    { spyService.unsubscribe(this.syncListener);           this.syncListener    = null; }
    if (this.connectListener) { spyService.offConnect(this.connectListener);         this.connectListener = null; }
    if (this.refreshTimer)    { clearInterval(this.refreshTimer); this.refreshTimer = null; }
    this.act = null;
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): void {
    this.borderSide = ev.payload.settings.borderSide ?? 'none';
    this.render();
  }

  override onDialRotate(_ev: DialRotateEvent<Settings>): void {}
  override onDialDown(_ev: DialDownEvent<Settings>): void {}
  override onDialUp(_ev: DialUpEvent<Settings>): void {}

  private render(): void {
    if (!this.act) return;
    const d = this.device;
    const s = this.lastSync;
    const srv = spyService.getServerAddress();
    const iqRate = spyService.getCurrentIQRate();
    const conn = this.connected ? 'OK' : '...';
    const rows: OptionsPanelRow[] = [
      { label: 'Conn', value: conn },
      { label: 'Host', value: srv.host || '-' },
      { label: 'Dev',  value: d ? deviceName(d.deviceType) : '-' },
      { label: 'Freq', value: s ? fmtFreq(s.iqCenterFreq) : '-' },
      { label: 'SR',   value: iqRate > 0 ? fmtFreq(iqRate) : '-' },
    ];
    this.act.setFeedback({
      'status-display': svgB64(optionsPanelSvg(rows, -1, false, this.borderSide)),
    }).catch(() => {});
  }
}
