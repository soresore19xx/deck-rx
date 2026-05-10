// Options Auto dial (案 A) — 1 column full-width Options panel that auto-
// shapes its rows to the active demod mode. Used together with the Band
// Select dial to give "1 dial 1 role" layout.
import { action, DialDownEvent, DialRotateEvent, DialUpEvent, SingletonAction, WillAppearEvent, WillDisappearEvent } from '@elgato/streamdeck';
import streamDeck from '@elgato/streamdeck';
import { spyService, AMOptions, FMOptions, SSBOptions, DeemphasisOpt } from '../spyService.js';
import { svgB64, dumpAndB64 } from '../dialDisplay.js';
import { knobSvg, optionsPanelSvg, OptionsPanelRow, dimSvg } from '../icons.js';

type Settings = { borderSide?: 'left' | 'right' | 'center' | 'none' };

const DEEMPH_CYCLE: DeemphasisOpt[] = ['off', '50us', '75us'];
const BW_CYCLE_AM = [4000, 6000, 9000, 12000];
const BW_CYCLE_FM = [200_000, 150_000, 110_000, 100_000, 90_000];
const BW_CYCLE_SSB = [250, 500, 1000, 1800, 2400, 2800];
const BFO_CYCLE = [400, 500, 600, 700, 800, 900];
const ATK_MIN = 1, ATK_MAX = 200, DEC_MIN = 1, DEC_MAX = 20;
const TICK_FACTOR = 1.1;
const adjustLog = (cur: number, t: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, cur * Math.pow(TICK_FACTOR, t)));
const nextInArray = <T,>(arr: readonly T[], cur: T, t: number): T => arr[(arr.indexOf(cur) + (t > 0 ? 1 : -1) + arr.length) % arr.length];
const fmtBw = (hz: number) => hz >= 1000 ? (Number.isInteger(hz/1000) ? (hz/1000).toFixed(0)+'k' : (hz/1000).toFixed(1)+'k') : String(hz);

function classify(mode: number): 'am' | 'ssb' | 'fm' {
  if (mode === 2) return 'am';
  if (mode === 4 || mode === 5 || mode === 6) return 'ssb';
  return 'fm';
}
function buildRows(mode: number): OptionsPanelRow[] {
  const fm = spyService.getFMOptions(), am = spyService.getAMOptions(), ssb = spyService.getSSBOptions();
  const fmGain = spyService.getFmGain(), amGain = spyService.getAmGain(), maxGain = spyService.getMaxGain();
  switch (classify(mode)) {
    case 'am': return [
      { label: 'BW',   value: fmtBw(am.bandwidth) },
      { label: 'CAGC', value: am.carrierAgc ? 'On' : 'Off' },
      { label: 'Sync', value: am.sync ? 'On' : 'Off' },
      { label: 'Atk',  value: am.agcAttack.toFixed(2) },
      { label: 'Dec',  value: am.agcDecay.toFixed(2) },
      { label: 'Gain', value: maxGain > 0 ? `${amGain}/${maxGain}` : '-' },
    ];
    case 'ssb': return [
      { label: 'BW',   value: fmtBw(ssb.bandwidthHz) },
      { label: 'BFO',  value: `${ssb.bfoPitchHz}` },
      { label: 'Gain', value: maxGain > 0 ? `${fmGain}/${maxGain}` : '-' },
    ];
    case 'fm': return [
      { label: 'BW',     value: fmtBw(fm.bandwidth) },
      { label: 'Deemph', value: fm.deemphasis === 'off' ? 'Off' : fm.deemphasis },
      { label: 'IFNR',   value: fm.ifnr ? 'On' : 'Off' },
      { label: 'HPF',    value: fm.highPass ? 'On' : 'Off' },
      { label: 'LPF',    value: fm.lowPass ? 'On' : 'Off' },
      { label: 'Ste',    value: fm.stereo ? 'On' : 'Off' },
      { label: 'Gain',   value: maxGain > 0 ? `${fmGain}/${maxGain}` : '-' },
    ];
  }
}
function modeName(mode: number): string {
  return ({ 0: 'NFM', 1: 'WFM', 2: 'AM', 4: 'USB', 5: 'CW', 6: 'LSB' } as Record<number, string>)[mode] ?? `mode${mode}`;
}

@action({ UUID: 'com.hogehoge.deck-rx.dial-options-auto' })
export class SpyDialOptionsAuto extends SingletonAction<Settings> {
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
    const sub = (subFn: (cb: () => void) => void, unsub: (cb: () => void) => void) => {
      const cb = () => this.render();
      subFn(cb);
      this.listeners.push(() => unsub(cb));
    };
    sub((cb) => spyService.subscribeOptions(cb), (cb) => spyService.unsubscribeOptions(cb));
    sub((cb) => spyService.subscribeAMOptions(cb), (cb) => spyService.unsubscribeAMOptions(cb));
    sub((cb) => spyService.subscribeSSBOptions(cb), (cb) => spyService.unsubscribeSSBOptions(cb));
    sub((cb) => spyService.subscribeFmGain(cb), (cb) => spyService.unsubscribeFmGain(cb));
    sub((cb) => spyService.subscribeAmGain(cb), (cb) => spyService.unsubscribeAmGain(cb));
    const enCb = (on: boolean) => { this.enabled = on; this.render(); };
    spyService.subscribeEnabled(enCb);
    this.listeners.push(() => spyService.unsubscribeEnabled(enCb));
    const dmCb = (mode: number) => { this.currentMode = mode; this.selectedIdx = 0; this.render(); };
    spyService.subscribeDemodMode(dmCb);
    this.listeners.push(() => spyService.unsubscribeDemodMode(dmCb));
    const csCb = (c: boolean) => { this.connected = c; this.render(); };
    spyService.subscribeConnectionState(csCb);
    this.listeners.push(() => spyService.unsubscribeConnectionState(csCb));
    const frCb = () => this.render();
    spyService.subscribeForceRender(frCb);
    this.listeners.push(() => spyService.unsubscribeForceRender(frCb));
    spyService.connect().catch((e) => streamDeck.logger.error(`[optsAuto] ${e}`));
    await ev.action.setImage(svgB64(knobSvg()));
    this.render();
  }
  override onWillDisappear(_: WillDisappearEvent<Settings>): void {
    for (const off of this.listeners) off();
    this.listeners = [];
    this.act = null;
  }
  override async onDialRotate(ev: DialRotateEvent<Settings>): Promise<void> {
    const ticks = ev.payload.ticks;
    if (this.editMode) {
      await this.applyEdit(ticks);
    } else {
      this.focused = true;
      const total = buildRows(this.currentMode).length;
      this.selectedIdx = ((this.selectedIdx + (ticks > 0 ? 1 : -1)) + total) % total;
      this.render();
    }
  }
  override onDialDown(_: DialDownEvent<Settings>): void {}
  override onDialUp(_: DialUpEvent<Settings>): void {
    this.editMode = !this.editMode;
    this.focused = this.editMode;
    this.render();
  }
  private async applyEdit(ticks: number): Promise<void> {
    const cls = classify(this.currentMode);
    const idx = this.selectedIdx;
    if (cls === 'am') {
      const cur = spyService.getAMOptions();
      switch (idx) {
        case 0: await spyService.setAMOption('bandwidth', nextInArray(BW_CYCLE_AM, cur.bandwidth, ticks)); break;
        case 1: await spyService.setAMOption('carrierAgc', !cur.carrierAgc); break;
        case 2: await spyService.setAMOption('sync', !cur.sync); break;
        case 3: await spyService.setAMOption('agcAttack', adjustLog(cur.agcAttack, ticks, ATK_MIN, ATK_MAX)); break;
        case 4: await spyService.setAMOption('agcDecay', adjustLog(cur.agcDecay, ticks, DEC_MIN, DEC_MAX)); break;
        case 5: await spyService.setAmGain(spyService.getAmGain() + ticks); break;
      }
    } else if (cls === 'ssb') {
      const cur = spyService.getSSBOptions();
      switch (idx) {
        case 0: await spyService.setSSBOption('bandwidthHz', nextInArray(BW_CYCLE_SSB, cur.bandwidthHz, ticks)); break;
        case 1: await spyService.setSSBOption('bfoPitchHz', nextInArray(BFO_CYCLE, cur.bfoPitchHz, ticks)); break;
        case 2: await spyService.setFmGain(spyService.getFmGain() + ticks); break;
      }
    } else {
      const cur = spyService.getFMOptions();
      switch (idx) {
        case 0: await spyService.setFMOption('bandwidth', nextInArray(BW_CYCLE_FM, cur.bandwidth, ticks)); break;
        case 1: await spyService.setFMOption('deemphasis', nextInArray(DEEMPH_CYCLE, cur.deemphasis, ticks)); break;
        case 2: await spyService.setFMOption('ifnr', !cur.ifnr); break;
        case 3: await spyService.setFMOption('highPass', !cur.highPass); break;
        case 4: await spyService.setFMOption('lowPass', !cur.lowPass); break;
        case 5: await spyService.setFMOption('stereo', !cur.stereo); break;
        case 6: await spyService.setFmGain(spyService.getFmGain() + ticks); break;
      }
    }
  }
  private render(): void {
    if (!this.act) return;
    const rows = buildRows(this.currentMode);
    const sel = this.focused ? this.selectedIdx : -1;
    const dim = !this.enabled || !this.connected;
    const title = `${modeName(this.currentMode)} Options`;
    this.act.setFeedback({
      'options-display': dumpAndB64('options-auto', dimSvg(optionsPanelSvg(rows, sel, this.editMode, this.borderSide, title), dim)),
    }).catch(() => {});
  }
}
