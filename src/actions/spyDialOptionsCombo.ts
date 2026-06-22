import { action, DialDownEvent, DialRotateEvent, DialUpEvent, SingletonAction, WillAppearEvent, WillDisappearEvent, DidReceiveSettingsEvent } from '@elgato/streamdeck';
import streamDeck from '@elgato/streamdeck';
import { spyService, AMOptions, FMOptions, SSBOptions, DeemphasisOpt, TuneMode, tuneStepValuesForMode } from '../spyService.js';
import { svgB64, dumpAndB64 } from '../dialDisplay.js';
import { knobSvg, optionsPanelBandSvg, OptionsPanelRow, dimSvg } from '../icons.js';
import { DialRow, DialRowState, clampIdx, dialDispose, dialDown, dialRotate, dialUp } from './dialRowHelper.js';

// F-2 unified Combo dial: left column lists 6 demod bands (WFM/NFM/AM/USB/LSB/
// CW) plus a Mode/Step bottom row, right column shows the option rows for the
// currently-active demod mode (AM/FM/SSB shapes differ). The cursor is a
// single continuous index spanning both columns:
//   0..5  → Band rows (cycle the band)
//   6     → Band-column Mode/Step row (preset ↔ vfo + step cycle)
//   7..N  → Opts column rows (mode-dependent values)
// PUSH on a Band row immediately calls setDemodMode (no edit-mode roundtrip).
// PUSH on row ≥ 6 toggles edit mode (rotation then tweaks the field value).

type Settings = { borderSide?: 'left' | 'right' | 'center' | 'none' };

// Display order of the band column. The MODES array in bandPolicy is
//   ['NFM','WFM','AM','DSB','USB','CW','LSB','RAW']
// → spyService mode numbers: 0=NFM, 1=WFM, 2=AM, 3=DSB, 4=USB, 5=CW, 6=LSB,
// 7=RAW. The Band column shows the 6 useful values; DSB and RAW are
// intentionally not exposed.
const BAND_LABELS = ['WFM', 'NFM', 'AM', 'USB', 'LSB', 'CW'] as const;
const BAND_MODES  = [   1,    0,   2,    4,    6,   5] as const;
const BAND_COUNT  = BAND_LABELS.length;        // 6
const MODE_STEP_IDX = BAND_COUNT;              // 6
const OPTS_START_IDX = BAND_COUNT + 1;         // 7

const DEEMPH_CYCLE: DeemphasisOpt[] = ['off', '50us', '75us'];
const BW_CYCLE_AM = [4000, 6000, 9000, 12000];
const BW_CYCLE_FM = [200_000, 150_000, 110_000, 100_000, 90_000];
const BW_CYCLE_SSB = [250, 500, 1000, 1800, 2400, 2800];
const BFO_CYCLE = [400, 500, 600, 700, 800, 900];
const ATK_MIN = 1, ATK_MAX = 200;
const DEC_MIN = 1, DEC_MAX = 20;
const TICK_FACTOR = 1.1;

function adjustLog(cur: number, ticks: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, cur * Math.pow(TICK_FACTOR, ticks)));
}
function nextInArray<T>(arr: readonly T[], cur: T, ticks: number): T {
  const i = arr.indexOf(cur);
  const safeI = i < 0 ? 0 : i;
  const dir = ticks > 0 ? 1 : -1;
  return arr[(safeI + dir + arr.length) % arr.length];
}
function fmtBw(hz: number): string {
  if (hz >= 1000) {
    const k = hz / 1000;
    return Number.isInteger(k) ? k.toFixed(0) + 'k' : k.toFixed(1) + 'k';
  }
  return String(hz);
}
function formatTuneStep(hz: number): string {
  if (hz >= 1_000_000) return `${(hz / 1_000_000).toFixed(0)}M`;
  if (hz >= 1_000)     return `${(hz / 1_000).toFixed(0)}k`;
  return `${hz}Hz`;
}

function classifyMode(mode: number): 'am' | 'ssb' | 'fm' {
  if (mode === 2) return 'am';
  if (mode === 4 || mode === 5 || mode === 6) return 'ssb';
  return 'fm'; // 0 (WFM) / 1 (NFM) / fallback
}

function applyModeStepEdit(ticks: number): void {
  const list = tuneStepValuesForMode(spyService.getDemodMode());
  const ci = list.indexOf(spyService.getTuneStepHz());
  const safeI = ci < 0 ? 0 : ci;
  const dir = ticks > 0 ? 1 : -1;
  const next = ((safeI + dir) + list.length) % list.length;
  spyService.setTuneStepHz(list[next]);
}

// Build the unified row list for navigation/edit dispatch. Layout matches
// the index map in the file-top comment: 0-5 band rows (skip edit on PUSH,
// fire setDemodMode), 6 Mode/Step row (edit cycles step, long-press
// toggles preset/vfo), 7+ opts rows (mode-dependent).
function buildAllRows(currentMode: number): DialRow[] {
  const rows: DialRow[] = [];
  // Band column
  for (let i = 0; i < BAND_COUNT; i++) {
    rows.push({
      label: BAND_LABELS[i],
      value: '',
      skipEditToggle: true,
      onShortPush: () => spyService.setDemodMode(BAND_MODES[i]),
    });
  }
  // Mode/Step row
  const tuneMode = spyService.getTuneMode();
  const stepHz = spyService.getTuneStepHz();
  rows.push({
    label: 'Pre/Stp',
    value: tuneMode === 'preset' ? 'Preset' : formatTuneStep(stepHz),
    onEdit: (t) => applyModeStepEdit(t),
    onLongPush: () => spyService.setTuneMode(tuneMode === 'preset' ? 'vfo' : 'preset'),
  });
  // Opts column — mode-dependent
  const cls = classifyMode(currentMode);
  if (cls === 'am') {
    const am = spyService.getAMOptions();
    const amGain = spyService.getAmGain(), maxGain = spyService.getMaxGain();
    rows.push(
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
    );
  } else if (cls === 'ssb') {
    const s = spyService.getSSBOptions();
    const fmGain = spyService.getFmGain(), maxGain = spyService.getMaxGain();
    rows.push(
      { label: 'BW',   value: fmtBw(s.bandwidthHz),
        onEdit: (t) => spyService.setSSBOption('bandwidthHz', nextInArray(BW_CYCLE_SSB, s.bandwidthHz, t)) },
      { label: 'BFO',  value: `${s.bfoPitchHz}`,
        onEdit: (t) => spyService.setSSBOption('bfoPitchHz', nextInArray(BFO_CYCLE, s.bfoPitchHz, t)) },
      { label: 'Gain', value: maxGain > 0 ? `${fmGain}/${maxGain}` : '-',
        onEdit: (t) => spyService.setFmGain(spyService.getFmGain() + t) },
    );
  } else {
    const fm = spyService.getFMOptions();
    const fmGain = spyService.getFmGain(), maxGain = spyService.getMaxGain();
    rows.push(
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
    );
  }
  return rows;
}

@action({ UUID: 'com.hogehoge.deck-rx.dial-options-combo' })
export class SpyDialOptionsCombo extends SingletonAction<Settings> {
  private rowState = new DialRowState();
  private borderSide: 'left' | 'right' | 'center' | 'none' = 'none';
  private act: { setImage: (s: string) => Promise<void>; setFeedback: (f: Record<string, unknown>) => Promise<void> } | null = null;
  private fmListener: ((o: FMOptions) => void) | null = null;
  private amListener: ((o: AMOptions) => void) | null = null;
  private ssbListener: ((o: SSBOptions) => void) | null = null;
  private fmGainListener: ((g: number, max: number) => void) | null = null;
  private amGainListener: ((g: number, max: number) => void) | null = null;
  private enabledListener: ((on: boolean) => void) | null = null;
  private demodListener: ((mode: number) => void) | null = null;
  private connStateListener: ((c: boolean) => void) | null = null;
  private tuneModeListener: ((m: TuneMode) => void) | null = null;
  private tuneStepListener: ((s: number) => void) | null = null;
  private forceRenderListener: (() => void) | null = null;
  private enabled = true;
  private connected = false;
  private currentMode = 0;

  override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
    // Idempotent re-entry — see teardown(): a re-fired willAppear without a
    // matching willDisappear would orphan the prior listeners + DialRowState
    // long-press timer.
    this.teardown();
    this.act = ev.action as unknown as typeof this.act;
    this.borderSide = ev.payload.settings.borderSide ?? 'none';
    this.fmListener = () => this.render();
    spyService.subscribeOptions(this.fmListener);
    this.amListener = () => this.render();
    spyService.subscribeAMOptions(this.amListener);
    this.ssbListener = () => this.render();
    spyService.subscribeSSBOptions(this.ssbListener);
    this.fmGainListener = () => this.render();
    spyService.subscribeFmGain(this.fmGainListener);
    this.amGainListener = () => this.render();
    spyService.subscribeAmGain(this.amGainListener);
    this.enabledListener = (on) => { this.enabled = on; this.render(); };
    spyService.subscribeEnabled(this.enabledListener);
    this.demodListener = (mode) => {
      this.currentMode = mode;
      clampIdx(this.rowState, buildAllRows(mode).length);
      this.render();
    };
    spyService.subscribeDemodMode(this.demodListener);
    this.connStateListener = (c) => { this.connected = c; this.render(); };
    spyService.subscribeConnectionState(this.connStateListener);
    this.tuneModeListener = () => this.render();
    spyService.subscribeTuneMode(this.tuneModeListener);
    this.tuneStepListener = () => this.render();
    spyService.subscribeTuneStep(this.tuneStepListener);
    this.forceRenderListener = () => this.render();
    spyService.subscribeForceRender(this.forceRenderListener);
    spyService.connect().catch((e) => streamDeck.logger.error(`[spyDialOptionsCombo] ${e}`));
    await ev.action.setImage(svgB64(knobSvg()));
    this.render();
  }

  override onWillDisappear(_ev: WillDisappearEvent<Settings>): void {
    this.teardown();
  }

  // Idempotent teardown — also called at the top of onWillAppear so a
  // re-fired willAppear (willDisappear never arrived) can't orphan the
  // previous listeners + timer in spyService's reference-keyed Sets.
  private teardown(): void {
    if (this.fmListener)        { spyService.unsubscribeOptions(this.fmListener);             this.fmListener = null; }
    if (this.amListener)        { spyService.unsubscribeAMOptions(this.amListener);           this.amListener = null; }
    if (this.ssbListener)       { spyService.unsubscribeSSBOptions(this.ssbListener);         this.ssbListener = null; }
    if (this.fmGainListener)    { spyService.unsubscribeFmGain(this.fmGainListener);          this.fmGainListener = null; }
    if (this.amGainListener)    { spyService.unsubscribeAmGain(this.amGainListener);          this.amGainListener = null; }
    if (this.enabledListener)   { spyService.unsubscribeEnabled(this.enabledListener);        this.enabledListener = null; }
    if (this.demodListener)     { spyService.unsubscribeDemodMode(this.demodListener);        this.demodListener = null; }
    if (this.connStateListener) { spyService.unsubscribeConnectionState(this.connStateListener); this.connStateListener = null; }
    if (this.tuneModeListener)  { spyService.unsubscribeTuneMode(this.tuneModeListener);      this.tuneModeListener = null; }
    if (this.tuneStepListener)  { spyService.unsubscribeTuneStep(this.tuneStepListener);      this.tuneStepListener = null; }
    if (this.forceRenderListener) { spyService.unsubscribeForceRender(this.forceRenderListener); this.forceRenderListener = null; }
    dialDispose(this.rowState);
    this.act = null;
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): void {
    this.borderSide = ev.payload.settings.borderSide ?? 'none';
    this.render();
  }

  override async onDialRotate(ev: DialRotateEvent<Settings>): Promise<void> {
    await dialRotate(this.rowState, buildAllRows(this.currentMode), ev.payload.ticks, () => this.render());
  }

  override onDialDown(_ev: DialDownEvent<Settings>): void {
    dialDown(this.rowState, buildAllRows(this.currentMode));
  }

  override async onDialUp(_ev: DialUpEvent<Settings>): Promise<void> {
    await dialUp(this.rowState, buildAllRows(this.currentMode), () => this.render());
  }

  private render(): void {
    if (!this.act) return;
    const allRows = buildAllRows(this.currentMode);
    // Split the unified DialRow[] into the render-time inputs that
    // optionsPanelBandSvg expects.
    const ms: OptionsPanelRow = {
      label: allRows[MODE_STEP_IDX]?.label ?? 'Pre/Stp',
      value: allRows[MODE_STEP_IDX]?.value ?? '',
    };
    const opts: OptionsPanelRow[] = allRows.slice(OPTS_START_IDX).map((r) => ({ label: r.label, value: r.value }));
    const activeBandIdx = (BAND_MODES as readonly number[]).indexOf(this.currentMode);
    const sel = this.rowState.focused ? this.rowState.selectedIdx : -1;
    const dim = !this.enabled || !this.connected;
    void this.borderSide;
    this.act.setFeedback({
      'options-display': dumpAndB64('options-combo', dimSvg(optionsPanelBandSvg(BAND_LABELS, activeBandIdx, ms, opts, sel, this.rowState.editMode), dim)),
    }).catch(() => {});
  }
}
