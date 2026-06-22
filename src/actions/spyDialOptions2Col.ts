// Options 2-Column dial (案 B) — AM column on the left, FM column on the
// right. The active column auto-tracks the current demod mode. SSB / CW
// fall back to the same single-column SSB shape because there's no
// natural second column for them.
import { action, DialDownEvent, DialRotateEvent, DialUpEvent, SingletonAction, WillAppearEvent, WillDisappearEvent, DidReceiveSettingsEvent } from '@elgato/streamdeck';
import streamDeck from '@elgato/streamdeck';
import { spyService, AMOptions, FMOptions, SSBOptions, DeemphasisOpt } from '../spyService.js';
import { svgB64, dumpAndB64 } from '../dialDisplay.js';
import { knobSvg, optionsPanelDualSvg, optionsPanelSvg, OptionsPanelRow, dimSvg } from '../icons.js';
import { DialRow, DialRowState, clampIdx, dialDispose, dialDown, dialRotate, dialUp } from './dialRowHelper.js';

type Settings = { borderSide?: 'left' | 'right' | 'center' | 'none' };

const DEEMPH_CYCLE: DeemphasisOpt[] = ['off', '50us', '75us'];
const BW_CYCLE_AM = [4000, 6000, 9000, 12000];
const BW_CYCLE_FM = [200_000, 150_000, 110_000, 100_000, 90_000];
const BW_CYCLE_SSB = [250, 500, 1000, 1800, 2400, 2800];
const BFO_CYCLE = [400, 500, 600, 700, 800, 900];
const ATK_MIN = 1, ATK_MAX = 200, DEC_MIN = 1, DEC_MAX = 20;
const TICK_FACTOR = 1.1;
const adjustLog = (c: number, t: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, c * Math.pow(TICK_FACTOR, t)));
const nextInArray = <T,>(arr: readonly T[], cur: T, t: number): T => arr[(arr.indexOf(cur) + (t > 0 ? 1 : -1) + arr.length) % arr.length];
const fmtBw = (hz: number) => hz >= 1000 ? (Number.isInteger(hz/1000) ? (hz/1000).toFixed(0)+'k' : (hz/1000).toFixed(1)+'k') : String(hz);

// Active mode → DialRow[] with embedded handlers. Drives navigation and
// edit dispatch. Returns only the active mode's rows; the side-by-side
// AM/FM render path below uses display-only OptionsPanelRow[] arrays.
function buildActiveRows(mode: number): DialRow[] {
  const isSsb = mode === 4 || mode === 5 || mode === 6;
  const isAm = mode === 2;
  if (isSsb) {
    const s = spyService.getSSBOptions();
    const fmGain = spyService.getFmGain(), maxGain = spyService.getMaxGain();
    return [
      { label: 'BW',   value: fmtBw(s.bandwidthHz),
        onEdit: (t) => spyService.setSSBOption('bandwidthHz', nextInArray(BW_CYCLE_SSB, s.bandwidthHz, t)) },
      { label: 'BFO',  value: `${s.bfoPitchHz}`,
        onEdit: (t) => spyService.setSSBOption('bfoPitchHz', nextInArray(BFO_CYCLE, s.bfoPitchHz, t)) },
      { label: 'Gain', value: maxGain > 0 ? `${fmGain}/${maxGain}` : '-',
        onEdit: (t) => spyService.setFmGain(spyService.getFmGain() + t) },
    ];
  }
  if (isAm) {
    const am = spyService.getAMOptions();
    const amGain = spyService.getAmGain(), maxGain = spyService.getMaxGain();
    return [
      { label: 'BW',   value: fmtBw(am.bandwidth),
        onEdit: (t) => spyService.setAMOption('bandwidth', nextInArray(BW_CYCLE_AM, am.bandwidth, t)) },
      { label: 'CAGC', value: am.carrierAgc ? 'On' : 'Off',
        onEdit: () => spyService.setAMOption('carrierAgc', !am.carrierAgc) },
      { label: 'Sync', value: am.sync ? 'On' : 'Off',
        onEdit: () => spyService.setAMOption('sync', !am.sync) },
      { label: 'Atk',  value: am.agcAttack.toFixed(2),
        onEdit: (t) => spyService.setAMOption('agcAttack', adjustLog(am.agcAttack, t, ATK_MIN, ATK_MAX)) },
      { label: 'Dec',  value: am.agcDecay.toFixed(2),
        onEdit: (t) => spyService.setAMOption('agcDecay', adjustLog(am.agcDecay, t, DEC_MIN, DEC_MAX)) },
      { label: 'Gain', value: maxGain > 0 ? `${amGain}/${maxGain}` : '-',
        onEdit: (t) => spyService.setAmGain(spyService.getAmGain() + t) },
    ];
  }
  // FM-family default
  const fm = spyService.getFMOptions();
  const fmGain = spyService.getFmGain(), maxGain = spyService.getMaxGain();
  return [
    { label: 'BW',     value: fmtBw(fm.bandwidth),
      onEdit: (t) => spyService.setFMOption('bandwidth', nextInArray(BW_CYCLE_FM, fm.bandwidth, t)) },
    { label: 'Deemph', value: fm.deemphasis === 'off' ? 'Off' : fm.deemphasis,
      onEdit: (t) => spyService.setFMOption('deemphasis', nextInArray(DEEMPH_CYCLE, fm.deemphasis, t)) },
    { label: 'IFNR',   value: fm.ifnr ? 'On' : 'Off',
      onEdit: () => spyService.setFMOption('ifnr', !fm.ifnr) },
    { label: 'HPF',    value: fm.highPass ? 'On' : 'Off',
      onEdit: () => spyService.setFMOption('highPass', !fm.highPass) },
    { label: 'LPF',    value: fm.lowPass ? 'On' : 'Off',
      onEdit: () => spyService.setFMOption('lowPass', !fm.lowPass) },
    { label: 'Ste',    value: fm.stereo ? 'On' : 'Off',
      onEdit: () => spyService.setFMOption('stereo', !fm.stereo) },
    { label: 'Gain',   value: maxGain > 0 ? `${fmGain}/${maxGain}` : '-',
      onEdit: (t) => spyService.setFmGain(spyService.getFmGain() + t) },
  ];
}

// Display-only row arrays used by the side-by-side render path. No
// handlers — the active mode's navigation lives in buildActiveRows
// above; these just provide labels/values for the inactive column.
function buildAmDisplay(am: AMOptions, gain: number, max: number): OptionsPanelRow[] {
  return [
    { label: 'BW', value: fmtBw(am.bandwidth) },
    { label: 'CAGC', value: am.carrierAgc ? 'On' : 'Off' },
    { label: 'Sync', value: am.sync ? 'On' : 'Off' },
    { label: 'Atk', value: am.agcAttack.toFixed(2) },
    { label: 'Dec', value: am.agcDecay.toFixed(2) },
    { label: 'Gain', value: max > 0 ? `${gain}/${max}` : '-' },
  ];
}
function buildFmDisplay(fm: FMOptions, gain: number, max: number): OptionsPanelRow[] {
  return [
    { label: 'BW', value: fmtBw(fm.bandwidth) },
    { label: 'Deemph', value: fm.deemphasis === 'off' ? 'Off' : fm.deemphasis },
    { label: 'IFNR', value: fm.ifnr ? 'On' : 'Off' },
    { label: 'HPF', value: fm.highPass ? 'On' : 'Off' },
    { label: 'LPF', value: fm.lowPass ? 'On' : 'Off' },
    { label: 'Ste', value: fm.stereo ? 'On' : 'Off' },
    { label: 'Gain', value: max > 0 ? `${gain}/${max}` : '-' },
  ];
}
function buildSsbDisplay(s: SSBOptions, gain: number, max: number): OptionsPanelRow[] {
  return [
    { label: 'BW', value: fmtBw(s.bandwidthHz) },
    { label: 'BFO', value: `${s.bfoPitchHz}` },
    { label: 'Gain', value: max > 0 ? `${gain}/${max}` : '-' },
  ];
}

@action({ UUID: 'com.hogehoge.deck-rx.dial-options-2col' })
export class SpyDialOptions2Col extends SingletonAction<Settings> {
  private rowState = new DialRowState();
  private borderSide: 'left' | 'right' | 'center' | 'none' = 'none';
  private act: { setImage: (s: string) => Promise<void>; setFeedback: (f: Record<string, unknown>) => Promise<void> } | null = null;
  private listeners: Array<() => void> = [];
  private enabled = true;
  private connected = false;
  private currentMode = 1;

  override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
    // Idempotent re-entry — see teardown(): without it a re-fired willAppear
    // (willDisappear never arrived) keeps pushing onto this.listeners, leaving
    // the prior subscriptions live (and double-firing renders) until disappear.
    this.teardown();
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
    const dmCb = (mode: number) => {
      this.currentMode = mode;
      clampIdx(this.rowState, buildActiveRows(mode).length);
      this.render();
    };
    spyService.subscribeDemodMode(dmCb);
    this.listeners.push(() => spyService.unsubscribeDemodMode(dmCb));
    const csCb = (c: boolean) => { this.connected = c; this.render(); };
    spyService.subscribeConnectionState(csCb);
    this.listeners.push(() => spyService.unsubscribeConnectionState(csCb));
    const frCb = () => this.render();
    spyService.subscribeForceRender(frCb);
    this.listeners.push(() => spyService.unsubscribeForceRender(frCb));
    spyService.connect().catch((e) => streamDeck.logger.error(`[opts2col] ${e}`));
    await ev.action.setImage(svgB64(knobSvg()));
    this.render();
  }
  override onWillDisappear(_: WillDisappearEvent<Settings>): void {
    this.teardown();
  }

  // Idempotent teardown — also called at the top of onWillAppear so a
  // re-fired willAppear (willDisappear never arrived) can't accumulate
  // orphaned subscriptions in this.listeners / spyService's Sets.
  private teardown(): void {
    for (const off of this.listeners) off();
    this.listeners = [];
    dialDispose(this.rowState);
    this.act = null;
  }
  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): void {
    this.borderSide = ev.payload.settings.borderSide ?? 'none';
    this.render();
  }
  override async onDialRotate(ev: DialRotateEvent<Settings>): Promise<void> {
    await dialRotate(this.rowState, buildActiveRows(this.currentMode), ev.payload.ticks, () => this.render());
  }
  override onDialDown(_: DialDownEvent<Settings>): void {
    dialDown(this.rowState, buildActiveRows(this.currentMode));
  }
  override async onDialUp(_: DialUpEvent<Settings>): Promise<void> {
    await dialUp(this.rowState, buildActiveRows(this.currentMode), () => this.render());
  }
  private render(): void {
    if (!this.act) return;
    const isSsb = this.currentMode === 4 || this.currentMode === 5 || this.currentMode === 6;
    const isAm = this.currentMode === 2;
    const fmGain = spyService.getFmGain(), amGain = spyService.getAmGain(), maxGain = spyService.getMaxGain();
    const sel = this.rowState.focused ? this.rowState.selectedIdx : -1;
    const dim = !this.enabled || !this.connected;
    let svg: string;
    if (isSsb) {
      const rows = buildSsbDisplay(spyService.getSSBOptions(), fmGain, maxGain);
      svg = optionsPanelSvg(rows, sel, this.rowState.editMode, this.borderSide, 'SSB Options');
    } else {
      const amRows = buildAmDisplay(spyService.getAMOptions(), amGain, maxGain);
      const fmRows = buildFmDisplay(spyService.getFMOptions(), fmGain, maxGain);
      svg = optionsPanelDualSvg(amRows, fmRows, isAm ? 'AM' : 'FM', sel, this.rowState.editMode, 'Options 2-Col');
    }
    this.act.setFeedback({
      'options-display': dumpAndB64('options-2col', dimSvg(svg, dim)),
    }).catch(() => {});
  }
}
