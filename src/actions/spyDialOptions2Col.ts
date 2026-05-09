// Options 2-Column dial (案 B) — AM column on the left, FM column on the
// right. The active column auto-tracks the current demod mode. SSB / CW
// fall back to the same single-column SSB shape because there's no
// natural second column for them.
import { action, DialDownEvent, DialRotateEvent, DialUpEvent, SingletonAction, WillAppearEvent, WillDisappearEvent, DidReceiveSettingsEvent } from '@elgato/streamdeck';
import streamDeck from '@elgato/streamdeck';
import { spyService, AMOptions, FMOptions, SSBOptions, DeemphasisOpt } from '../spyService.js';
import { svgB64, dumpAndB64 } from '../dialDisplay.js';
import { knobSvg, optionsPanelDualSvg, optionsPanelSvg, OptionsPanelRow, dimSvg } from '../icons.js';

type Settings = { borderSide?: 'left' | 'right' | 'center' | 'none' };

const DEEMPH_CYCLE: DeemphasisOpt[] = ['off', '50us', '75us'];
const BW_CYCLE_AM = [4000, 6000, 9000, 12000];
const BW_CYCLE_SSB = [250, 500, 1000, 1800, 2400, 2800];
const BFO_CYCLE = [400, 500, 600, 700, 800, 900];
const ATK_MIN = 1, ATK_MAX = 200, DEC_MIN = 1, DEC_MAX = 20;
const TICK_FACTOR = 1.1;
const adjustLog = (c: number, t: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, c * Math.pow(TICK_FACTOR, t)));
const nextInArray = <T,>(arr: readonly T[], cur: T, t: number): T => arr[(arr.indexOf(cur) + (t > 0 ? 1 : -1) + arr.length) % arr.length];
const fmtBw = (hz: number) => hz >= 1000 ? (Number.isInteger(hz/1000) ? (hz/1000).toFixed(0)+'k' : (hz/1000).toFixed(1)+'k') : String(hz);

function buildAm(am: AMOptions, gain: number, max: number): OptionsPanelRow[] {
  return [
    { label: 'BW', value: fmtBw(am.bandwidth) },
    { label: 'CAGC', value: am.carrierAgc ? 'On' : 'Off' },
    { label: 'Sync', value: am.sync ? 'On' : 'Off' },
    { label: 'Atk', value: am.agcAttack.toFixed(2) },
    { label: 'Dec', value: am.agcDecay.toFixed(2) },
    { label: 'Gain', value: max > 0 ? `${gain}/${max}` : '-' },
  ];
}
function buildFm(fm: FMOptions, gain: number, max: number): OptionsPanelRow[] {
  return [
    { label: 'Deemph', value: fm.deemphasis === 'off' ? 'Off' : fm.deemphasis },
    { label: 'IFNR', value: fm.ifnr ? 'On' : 'Off' },
    { label: 'HPF', value: fm.highPass ? 'On' : 'Off' },
    { label: 'LPF', value: fm.lowPass ? 'On' : 'Off' },
    { label: 'Ste', value: fm.stereo ? 'On' : 'Off' },
    { label: 'Gain', value: max > 0 ? `${gain}/${max}` : '-' },
  ];
}
function buildSsb(s: SSBOptions, gain: number, max: number): OptionsPanelRow[] {
  return [
    { label: 'BW', value: fmtBw(s.bandwidthHz) },
    { label: 'BFO', value: `${s.bfoPitchHz}` },
    { label: 'Gain', value: max > 0 ? `${gain}/${max}` : '-' },
  ];
}

@action({ UUID: 'com.hogehoge.deck-rx.dial-options-2col' })
export class SpyDialOptions2Col extends SingletonAction<Settings> {
  private selectedIdx = 0;
  private editMode = false;
  private focused = false;
  private borderSide: 'left' | 'right' | 'center' | 'none' = 'none';
  private act: { setImage: (s: string) => Promise<void>; setFeedback: (f: Record<string, unknown>) => Promise<void> } | null = null;
  private listeners: Array<() => void> = [];
  private enabled = true;
  private connected = false;
  private currentMode = 1;

  override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
    this.act = ev.action as unknown as typeof this.act;
    this.borderSide = ev.payload.settings.borderSide ?? 'none';
    const reg = (subFn: (cb: () => void) => void, unsub: (cb: () => void) => void) => {
      const cb = () => this.render();
      subFn(cb);
      this.listeners.push(() => unsub(cb));
    };
    reg((cb) => spyService.subscribeOptions(cb), (cb) => spyService.unsubscribeOptions(cb));
    reg((cb) => spyService.subscribeAMOptions(cb), (cb) => spyService.unsubscribeAMOptions(cb));
    reg((cb) => spyService.subscribeSSBOptions(cb), (cb) => spyService.unsubscribeSSBOptions(cb));
    reg((cb) => spyService.subscribeFmGain(cb), (cb) => spyService.unsubscribeFmGain(cb));
    reg((cb) => spyService.subscribeAmGain(cb), (cb) => spyService.unsubscribeAmGain(cb));
    const enCb = (on: boolean) => { this.enabled = on; this.render(); };
    spyService.subscribeEnabled(enCb);
    this.listeners.push(() => spyService.unsubscribeEnabled(enCb));
    const dmCb = (mode: number) => { this.currentMode = mode; this.selectedIdx = 0; this.render(); };
    spyService.subscribeDemodMode(dmCb);
    this.listeners.push(() => spyService.unsubscribeDemodMode(dmCb));
    const csCb = (c: boolean) => { this.connected = c; this.render(); };
    spyService.subscribeConnectionState(csCb);
    this.listeners.push(() => spyService.unsubscribeConnectionState(csCb));
    spyService.connect().catch((e) => streamDeck.logger.error(`[opts2col] ${e}`));
    await ev.action.setImage(svgB64(knobSvg()));
    this.render();
  }
  override onWillDisappear(_: WillDisappearEvent<Settings>): void {
    for (const off of this.listeners) off();
    this.listeners = [];
    this.act = null;
  }
  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): void {
    this.borderSide = ev.payload.settings.borderSide ?? 'none';
    this.render();
  }
  override async onDialRotate(ev: DialRotateEvent<Settings>): Promise<void> {
    const ticks = ev.payload.ticks;
    if (this.editMode) { await this.applyEdit(ticks); return; }
    this.focused = true;
    const isSsb = this.currentMode === 4 || this.currentMode === 5 || this.currentMode === 6;
    const total = isSsb ? 3 : 6;
    this.selectedIdx = ((this.selectedIdx + (ticks > 0 ? 1 : -1)) + total) % total;
    this.render();
  }
  override onDialDown(_: DialDownEvent<Settings>): void {}
  override onDialUp(_: DialUpEvent<Settings>): void {
    this.editMode = !this.editMode;
    this.focused = this.editMode;
    this.render();
  }
  private async applyEdit(ticks: number): Promise<void> {
    const idx = this.selectedIdx;
    const isAm = this.currentMode === 2;
    const isSsb = this.currentMode === 4 || this.currentMode === 5 || this.currentMode === 6;
    if (isSsb) {
      const cur = spyService.getSSBOptions();
      switch (idx) {
        case 0: await spyService.setSSBOption('bandwidthHz', nextInArray(BW_CYCLE_SSB, cur.bandwidthHz, ticks)); break;
        case 1: await spyService.setSSBOption('bfoPitchHz', nextInArray(BFO_CYCLE, cur.bfoPitchHz, ticks)); break;
        case 2: await spyService.setFmGain(spyService.getFmGain() + ticks); break;
      }
    } else if (isAm) {
      const cur = spyService.getAMOptions();
      switch (idx) {
        case 0: await spyService.setAMOption('bandwidth', nextInArray(BW_CYCLE_AM, cur.bandwidth, ticks)); break;
        case 1: await spyService.setAMOption('carrierAgc', !cur.carrierAgc); break;
        case 2: await spyService.setAMOption('sync', !cur.sync); break;
        case 3: await spyService.setAMOption('agcAttack', adjustLog(cur.agcAttack, ticks, ATK_MIN, ATK_MAX)); break;
        case 4: await spyService.setAMOption('agcDecay', adjustLog(cur.agcDecay, ticks, DEC_MIN, DEC_MAX)); break;
        case 5: await spyService.setAmGain(spyService.getAmGain() + ticks); break;
      }
    } else {
      const cur = spyService.getFMOptions();
      switch (idx) {
        case 0: await spyService.setFMOption('deemphasis', nextInArray(DEEMPH_CYCLE, cur.deemphasis, ticks)); break;
        case 1: await spyService.setFMOption('ifnr', !cur.ifnr); break;
        case 2: await spyService.setFMOption('highPass', !cur.highPass); break;
        case 3: await spyService.setFMOption('lowPass', !cur.lowPass); break;
        case 4: await spyService.setFMOption('stereo', !cur.stereo); break;
        case 5: await spyService.setFmGain(spyService.getFmGain() + ticks); break;
      }
    }
  }
  private render(): void {
    if (!this.act) return;
    const isSsb = this.currentMode === 4 || this.currentMode === 5 || this.currentMode === 6;
    const isAm = this.currentMode === 2;
    const fmGain = spyService.getFmGain(), amGain = spyService.getAmGain(), maxGain = spyService.getMaxGain();
    const sel = this.focused ? this.selectedIdx : -1;
    const dim = !this.enabled || !this.connected;
    let svg: string;
    if (isSsb) {
      const rows = buildSsb(spyService.getSSBOptions(), fmGain, maxGain);
      svg = optionsPanelSvg(rows, sel, this.editMode, this.borderSide, 'SSB Options');
    } else {
      const amRows = buildAm(spyService.getAMOptions(), amGain, maxGain);
      const fmRows = buildFm(spyService.getFMOptions(), fmGain, maxGain);
      svg = optionsPanelDualSvg(amRows, fmRows, isAm ? 'AM' : 'FM', sel, this.editMode);
    }
    this.act.setFeedback({
      'options-display': dumpAndB64('options-2col', dimSvg(svg, dim)),
    }).catch(() => {});
  }
}
