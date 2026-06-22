// Options Auto dial (案 A) — 1 column full-width Options panel that auto-
// shapes its rows to the active demod mode. Used together with the Band
// Select dial to give "1 dial 1 role" layout.
import { action, DialDownEvent, DialRotateEvent, DialUpEvent, SingletonAction, WillAppearEvent, WillDisappearEvent } from '@elgato/streamdeck';
import streamDeck from '@elgato/streamdeck';
import { spyService, DeemphasisOpt } from '../spyService.js';
import { svgB64, dumpAndB64 } from '../dialDisplay.js';
import { knobSvg, optionsPanelSvg, OptionsPanelRow, dimSvg } from '../icons.js';
import { DialRow, DialRowState, clampIdx, dialDispose, dialDown, dialRotate, dialUp } from './dialRowHelper.js';

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
function buildRows(mode: number): DialRow[] {
  const fm = spyService.getFMOptions(), am = spyService.getAMOptions(), ssb = spyService.getSSBOptions();
  const fmGain = spyService.getFmGain(), amGain = spyService.getAmGain(), maxGain = spyService.getMaxGain();
  switch (classify(mode)) {
    case 'am': return [
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
    case 'ssb': return [
      { label: 'BW',   value: fmtBw(ssb.bandwidthHz),
        onEdit: (t) => spyService.setSSBOption('bandwidthHz', nextInArray(BW_CYCLE_SSB, ssb.bandwidthHz, t)) },
      { label: 'BFO',  value: `${ssb.bfoPitchHz}`,
        onEdit: (t) => spyService.setSSBOption('bfoPitchHz', nextInArray(BFO_CYCLE, ssb.bfoPitchHz, t)) },
      { label: 'Gain', value: maxGain > 0 ? `${fmGain}/${maxGain}` : '-',
        onEdit: (t) => spyService.setFmGain(spyService.getFmGain() + t) },
    ];
    case 'fm': return [
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
}
function modeName(mode: number): string {
  return ({ 0: 'NFM', 1: 'WFM', 2: 'AM', 4: 'USB', 5: 'CW', 6: 'LSB' } as Record<number, string>)[mode] ?? `mode${mode}`;
}

@action({ UUID: 'com.hogehoge.deck-rx.dial-options-auto' })
export class SpyDialOptionsAuto extends SingletonAction<Settings> {
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
    const dmCb = (mode: number) => {
      this.currentMode = mode;
      // Row count is mode-dependent; keep the cursor in range.
      clampIdx(this.rowState, buildRows(mode).length);
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
    spyService.connect().catch((e) => streamDeck.logger.error(`[optsAuto] ${e}`));
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
  override async onDialRotate(ev: DialRotateEvent<Settings>): Promise<void> {
    await dialRotate(this.rowState, buildRows(this.currentMode), ev.payload.ticks, () => this.render());
  }
  override onDialDown(_: DialDownEvent<Settings>): void {
    dialDown(this.rowState, buildRows(this.currentMode));
  }
  override async onDialUp(_: DialUpEvent<Settings>): Promise<void> {
    await dialUp(this.rowState, buildRows(this.currentMode), () => this.render());
  }
  private render(): void {
    if (!this.act) return;
    const rows = buildRows(this.currentMode);
    // Project DialRow[] → OptionsPanelRow[] for rendering (drop handlers).
    const panelRows: OptionsPanelRow[] = rows.map((r) => ({ label: r.label, value: r.value }));
    const sel = this.rowState.focused ? this.rowState.selectedIdx : -1;
    const dim = !this.enabled || !this.connected;
    const title = `${modeName(this.currentMode)} Options`;
    this.act.setFeedback({
      'options-display': dumpAndB64('options-auto', dimSvg(optionsPanelSvg(panelRows, sel, this.rowState.editMode, this.borderSide, title), dim)),
    }).catch(() => {});
  }
}
