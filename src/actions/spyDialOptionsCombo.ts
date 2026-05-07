import { action, DialDownEvent, DialRotateEvent, DialUpEvent, SingletonAction, WillAppearEvent, WillDisappearEvent, DidReceiveSettingsEvent } from '@elgato/streamdeck';
import streamDeck from '@elgato/streamdeck';
import { spyService, AMOptions, FMOptions, DeemphasisOpt, TuneMode, TUNE_STEP_VALUES } from '../spyService.js';
import { svgB64, dumpAndB64 } from '../dialDisplay.js';
import { knobSvg, optionsPanelDualSvg, OptionsPanelRow, dimSvg } from '../icons.js';

// Combined AM+FM options dial. Both columns are always rendered; rotation
// adjusts the column matching the current demod mode (auto-active). The
// inactive column shows live values for awareness but isn't navigable from
// here — switch demod mode via Tune dial preset to make the other column
// live. Dropping into edit mode operates on the active column's selected row.

type Settings = { borderSide?: 'left' | 'right' | 'center' | 'none' };

const DEEMPH_CYCLE: DeemphasisOpt[] = ['off', '50us', '75us'];
const BW_CYCLE = [4000, 6000, 9000, 12000];
const ATK_MIN = 1, ATK_MAX = 200;
const DEC_MIN = 1, DEC_MAX = 20;
const TICK_FACTOR = 1.1;

function adjustLog(cur: number, ticks: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, cur * Math.pow(TICK_FACTOR, ticks)));
}
function nextInArray<T>(arr: T[], cur: T, ticks: number): T {
  const i = arr.indexOf(cur);
  const safeI = i < 0 ? 0 : i;
  const dir = ticks > 0 ? 1 : -1;
  return arr[(safeI + dir + arr.length) % arr.length];
}
function fmtBw(hz: number): string {
  return hz >= 1000 ? `${(hz / 1000).toFixed(0)}k` : String(hz);
}
function formatTuneStep(hz: number): string {
  if (hz >= 1000000) return `${(hz / 1000000).toFixed(0)}M`;
  if (hz >= 1000) return `${(hz / 1000).toFixed(0)}k`;
  return `${hz}Hz`;
}

// Row index → semantic name. Each column has 7 rows in the same order so
// `selectedIdx` is meaningful regardless of which column is active. The two
// columns map to different fields, but the row position always means the
// same "kind of slot" within its column (last two rows are the synthetic
// Mode/Step controls).
const AM_ROWS = ['BW', 'CAGC', 'Sync', 'Atk', 'Dec', 'Gain', 'Mode'] as const;
const FM_ROWS = ['Deemph', 'IFNR', 'HPF', 'LPF', 'Ste', 'Gain', 'Step'] as const;
const ROWS_PER_COL = 7;

// Both columns' last row is dual-purpose: shows "Mode: Preset" while in preset
// mode and "Step: 9k" while in VFO mode. Editing it (rotation in edit mode)
// CW = preset → vfo, then cycle step values up; CCW = step values down,
// once past the smallest step → wraps back to preset. This way Mode toggle
// and Step adjustment live on the same row in BOTH columns regardless of
// which one is active, so FM-mode users can flip back to preset without
// having to switch demod modes to access the AM column.
function modeStepRow(tuneMode: TuneMode, stepHz: number): OptionsPanelRow {
  return tuneMode === 'preset'
    ? { label: 'Mode', value: 'Preset' }
    : { label: 'Step', value: formatTuneStep(stepHz) };
}

function buildAmRows(o: AMOptions, gain: number, maxGain: number, tuneMode: TuneMode, stepHz: number): OptionsPanelRow[] {
  return [
    { label: 'BW',   value: fmtBw(o.bandwidth) },
    { label: 'CAGC', value: o.carrierAgc ? 'On' : 'Off' },
    { label: 'Sync', value: o.sync ? 'On' : 'Off' },
    { label: 'Atk',  value: o.agcAttack.toFixed(2) },
    { label: 'Dec',  value: o.agcDecay.toFixed(2) },
    { label: 'Gain', value: maxGain > 0 ? `${gain}/${maxGain}` : '-' },
    modeStepRow(tuneMode, stepHz),
  ];
}

function buildFmRows(o: FMOptions, gain: number, maxGain: number, tuneMode: TuneMode, stepHz: number): OptionsPanelRow[] {
  return [
    { label: 'Deemph', value: o.deemphasis === 'off' ? 'Off' : o.deemphasis },
    { label: 'IFNR',   value: o.ifnr     ? 'On' : 'Off' },
    { label: 'HPF',    value: o.highPass ? 'On' : 'Off' },
    { label: 'LPF',    value: o.lowPass  ? 'On' : 'Off' },
    { label: 'Ste',    value: o.stereo   ? 'On' : 'Off' },
    { label: 'Gain',   value: maxGain > 0 ? `${gain}/${maxGain}` : '-' },
    modeStepRow(tuneMode, stepHz),
  ];
}

// Common edit handler for the dual-purpose Mode/Step row. Used by both AM and
// FM column case 6 — single source of truth for the "preset ↔ vfo + step
// cycling" state machine.
function applyModeStepEdit(ticks: number): void {
  if (spyService.getTuneMode() === 'preset') {
    spyService.setTuneMode('vfo');
    return;
  }
  // VFO mode: cycle step values. Stepping past EITHER end of the list wraps
  // back to preset mode — so the user can return to preset from the same
  // row in both directions (CCW past 1 Hz min, or CW past 1 MHz max).
  const list = TUNE_STEP_VALUES;
  const ci = list.indexOf(spyService.getTuneStepHz());
  const safeI = ci < 0 ? 0 : ci;
  const dir = ticks > 0 ? 1 : -1;
  const next = safeI + dir;
  if (next < 0 || next >= list.length) {
    spyService.setTuneMode('preset');
  } else {
    spyService.setTuneStepHz(list[next]);
  }
}

@action({ UUID: 'com.hogehoge.deck-rx.dial-options-combo' })
export class SpyDialOptionsCombo extends SingletonAction<Settings> {
  private selectedIdx = 0;
  private editMode = false;
  private focused = false;
  private borderSide: 'left' | 'right' | 'center' | 'none' = 'none';
  private act: { setImage: (s: string) => Promise<void>; setFeedback: (f: Record<string, unknown>) => Promise<void> } | null = null;
  private fmListener: ((o: FMOptions) => void) | null = null;
  private amListener: ((o: AMOptions) => void) | null = null;
  private fmGainListener: ((g: number, max: number) => void) | null = null;
  private amGainListener: ((g: number, max: number) => void) | null = null;
  private enabledListener: ((on: boolean) => void) | null = null;
  private demodListener: ((mode: number) => void) | null = null;
  private connStateListener: ((c: boolean) => void) | null = null;
  private tuneModeListener: ((m: TuneMode) => void) | null = null;
  private tuneStepListener: ((s: number) => void) | null = null;
  private enabled = true;
  private connected = false;
  private isAmMode = false;

  override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
    this.act = ev.action as unknown as typeof this.act;
    this.borderSide = ev.payload.settings.borderSide ?? 'none';
    this.fmListener = () => this.render();
    spyService.subscribeOptions(this.fmListener);
    this.amListener = () => this.render();
    spyService.subscribeAMOptions(this.amListener);
    this.fmGainListener = () => this.render();
    spyService.subscribeFmGain(this.fmGainListener);
    this.amGainListener = () => this.render();
    spyService.subscribeAmGain(this.amGainListener);
    this.enabledListener = (on) => { this.enabled = on; this.render(); };
    spyService.subscribeEnabled(this.enabledListener);
    this.demodListener = (mode) => { this.isAmMode = mode === 2; this.render(); };
    spyService.subscribeDemodMode(this.demodListener);
    this.connStateListener = (c) => { this.connected = c; this.render(); };
    spyService.subscribeConnectionState(this.connStateListener);
    this.tuneModeListener = () => this.render();
    spyService.subscribeTuneMode(this.tuneModeListener);
    this.tuneStepListener = () => this.render();
    spyService.subscribeTuneStep(this.tuneStepListener);
    spyService.connect().catch((e) => streamDeck.logger.error(`[spyDialOptionsCombo] ${e}`));
    await ev.action.setImage(svgB64(knobSvg()));
    this.render();
  }

  override onWillDisappear(_ev: WillDisappearEvent<Settings>): void {
    if (this.fmListener)        { spyService.unsubscribeOptions(this.fmListener);             this.fmListener = null; }
    if (this.amListener)        { spyService.unsubscribeAMOptions(this.amListener);           this.amListener = null; }
    if (this.fmGainListener)    { spyService.unsubscribeFmGain(this.fmGainListener);          this.fmGainListener = null; }
    if (this.amGainListener)    { spyService.unsubscribeAmGain(this.amGainListener);          this.amGainListener = null; }
    if (this.enabledListener)   { spyService.unsubscribeEnabled(this.enabledListener);        this.enabledListener = null; }
    if (this.demodListener)     { spyService.unsubscribeDemodMode(this.demodListener);        this.demodListener = null; }
    if (this.connStateListener) { spyService.unsubscribeConnectionState(this.connStateListener); this.connStateListener = null; }
    if (this.tuneModeListener)  { spyService.unsubscribeTuneMode(this.tuneModeListener);      this.tuneModeListener = null; }
    if (this.tuneStepListener)  { spyService.unsubscribeTuneStep(this.tuneStepListener);      this.tuneStepListener = null; }
    this.act = null;
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): void {
    this.borderSide = ev.payload.settings.borderSide ?? 'none';
    this.render();
  }

  override async onDialRotate(ev: DialRotateEvent<Settings>): Promise<void> {
    const ticks = ev.payload.ticks;
    if (this.editMode) {
      await this.applyEdit(ticks);
    } else {
      this.focused = true;
      this.selectedIdx = ((this.selectedIdx + (ticks > 0 ? 1 : -1)) + ROWS_PER_COL) % ROWS_PER_COL;
      this.render();
    }
  }

  override onDialDown(_ev: DialDownEvent<Settings>): void {}

  override onDialUp(_ev: DialUpEvent<Settings>): void {
    if (this.editMode) {
      this.editMode = false;
      this.focused = false;
    } else {
      this.editMode = true;
      this.focused = true;
    }
    this.render();
  }

  // Apply rotation deltas to the field at `selectedIdx` in the active column.
  // Mode (last-1 row of AM column) and Step (last row of FM column) are
  // anchored to specific positions — ROWS_PER_COL - 1 = 6 for both. AM col
  // uses idx 6 = Mode; FM col uses idx 6 = Step. The "active" column is
  // determined by the current demod mode: AM = mode 2, otherwise FM/NFM.
  private async applyEdit(ticks: number): Promise<void> {
    const idx = this.selectedIdx;
    if (this.isAmMode) {
      const cur = spyService.getAMOptions();
      switch (idx) {
        case 0: await spyService.setAMOption('bandwidth',   nextInArray(BW_CYCLE, cur.bandwidth, ticks)); break;
        case 1: await spyService.setAMOption('carrierAgc',  !cur.carrierAgc); break;
        case 2: await spyService.setAMOption('sync',        !cur.sync); break;
        case 3: await spyService.setAMOption('agcAttack',   adjustLog(cur.agcAttack, ticks, ATK_MIN, ATK_MAX)); break;
        case 4: await spyService.setAMOption('agcDecay',    adjustLog(cur.agcDecay,  ticks, DEC_MIN, DEC_MAX)); break;
        case 5: await spyService.setAmGain(spyService.getAmGain() + ticks); break;
        case 6: applyModeStepEdit(ticks); break;
      }
    } else {
      const cur = spyService.getFMOptions();
      switch (idx) {
        case 0: {
          const i = DEEMPH_CYCLE.indexOf(cur.deemphasis);
          const n = (i + (ticks > 0 ? 1 : -1) + DEEMPH_CYCLE.length) % DEEMPH_CYCLE.length;
          await spyService.setFMOption('deemphasis', DEEMPH_CYCLE[n]);
          break;
        }
        case 1: await spyService.setFMOption('ifnr',     !cur.ifnr); break;
        case 2: await spyService.setFMOption('highPass', !cur.highPass); break;
        case 3: await spyService.setFMOption('lowPass',  !cur.lowPass); break;
        case 4: await spyService.setFMOption('stereo',   !cur.stereo); break;
        case 5: await spyService.setFmGain(spyService.getFmGain() + ticks); break;
        case 6: applyModeStepEdit(ticks); break;
      }
    }
  }

  private render(): void {
    if (!this.act) return;
    const fm = spyService.getFMOptions();
    const am = spyService.getAMOptions();
    const fmGain = spyService.getFmGain();
    const amGain = spyService.getAmGain();
    const maxGain = spyService.getMaxGain();
    const tuneMode = spyService.getTuneMode();
    const stepHz = spyService.getTuneStepHz();
    const amRows = buildAmRows(am, amGain, maxGain, tuneMode, stepHz);
    const fmRows = buildFmRows(fm, fmGain, maxGain, tuneMode, stepHz);
    const activeCol = this.isAmMode ? 'AM' : 'FM';
    const sel = this.focused ? this.selectedIdx : -1;
    const dim = !this.enabled || !this.connected;
    void this.borderSide; // borderSide is reserved for future per-edge frame styling
    this.act.setFeedback({
      'options-display': dumpAndB64('options-combo', dimSvg(optionsPanelDualSvg(amRows, fmRows, activeCol, sel, this.editMode), dim)),
    }).catch(() => {});
  }
}

// AM_ROWS / FM_ROWS not exported but kept as documentation aids. Quiet the
// linter about unused symbols.
void AM_ROWS; void FM_ROWS;
