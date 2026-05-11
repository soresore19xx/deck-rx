import { action, DialDownEvent, DialRotateEvent, DialUpEvent, SingletonAction, WillAppearEvent, WillDisappearEvent, DidReceiveSettingsEvent } from '@elgato/streamdeck';
import streamDeck from '@elgato/streamdeck';
import { spyService, AMOptions, FMOptions, SSBOptions, DeemphasisOpt, TuneMode, tuneStepValuesForMode } from '../spyService.js';
import { svgB64, dumpAndB64 } from '../dialDisplay.js';
import { knobSvg, optionsPanelBandSvg, OptionsPanelRow, dimSvg } from '../icons.js';

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

// Mode/Step row content: shows "Mode: Preset" while in preset mode, otherwise
// "Step: 9k" while in VFO mode.
function modeStepRow(tuneMode: TuneMode, stepHz: number): OptionsPanelRow {
  // Combined preset/step row — short PUSH toggles edit (rotate cycles
  // step), LONG PUSH (≥ 1 s) toggles preset ↔ vfo. Label abbreviated
  // to 'Pre/Stp' because the Combo dial's band column is only
  // 100 px wide and 'Preset/Step' overflowed into the value column.
  const v = tuneMode === 'preset' ? 'Preset' : formatTuneStep(stepHz);
  return { label: 'Pre/Stp', value: v };
}

function buildAmOptsRows(o: AMOptions, gain: number, maxGain: number): OptionsPanelRow[] {
  return [
    { label: 'BW',   value: fmtBw(o.bandwidth) },
    { label: 'CAGC', value: o.carrierAgc ? 'On' : 'Off' },
    { label: 'Sync', value: o.sync ? 'On' : 'Off' },
    { label: 'Atk',  value: o.agcAttack.toFixed(2) },
    { label: 'Dec',  value: o.agcDecay.toFixed(2) },
    { label: 'Gain', value: maxGain > 0 ? `${gain}/${maxGain}` : '-' },
  ];
}
function buildFmOptsRows(o: FMOptions, gain: number, maxGain: number): OptionsPanelRow[] {
  return [
    { label: 'BW',     value: fmtBw(o.bandwidth) },
    { label: 'Deemph', value: o.deemphasis === 'off' ? 'Off' : o.deemphasis },
    { label: 'IFNR',   value: o.ifnr     ? 'On' : 'Off' },
    { label: 'HPF',    value: o.highPass ? 'On' : 'Off' },
    { label: 'LPF',    value: o.lowPass  ? 'On' : 'Off' },
    { label: 'Ste',    value: o.stereo   ? 'On' : 'Off' },
    { label: 'Gain',   value: maxGain > 0 ? `${gain}/${maxGain}` : '-' },
  ];
}
function buildSsbOptsRows(o: SSBOptions, gain: number, maxGain: number): OptionsPanelRow[] {
  return [
    { label: 'BW',   value: fmtBw(o.bandwidthHz) },
    { label: 'BFO',  value: `${o.bfoPitchHz}` },
    { label: 'Gain', value: maxGain > 0 ? `${gain}/${maxGain}` : '-' },
  ];
}

function classifyMode(mode: number): 'am' | 'ssb' | 'fm' {
  if (mode === 2) return 'am';
  if (mode === 4 || mode === 5 || mode === 6) return 'ssb';
  return 'fm'; // 0 (WFM) / 1 (NFM) / fallback
}

// Rotate handler for the Preset/Step row: always cycles step with
// wrap-around. Mode toggle is on a 1 s long-press (see onDialDown).
function applyModeStepEdit(ticks: number): void {
  const list = tuneStepValuesForMode(spyService.getDemodMode());
  const ci = list.indexOf(spyService.getTuneStepHz());
  const safeI = ci < 0 ? 0 : ci;
  const dir = ticks > 0 ? 1 : -1;
  const next = ((safeI + dir) + list.length) % list.length;
  spyService.setTuneStepHz(list[next]);
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
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private longPressFired = false;

  override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
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
    this.demodListener = (mode) => { this.currentMode = mode; this.clampCursor(); this.render(); };
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
    this.act = null;
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): void {
    this.borderSide = ev.payload.settings.borderSide ?? 'none';
    this.render();
  }

  // Total continuous-cursor row count (mode-dependent because Opts column
  // length depends on the current demod mode).
  private totalRows(): number {
    return OPTS_START_IDX + this.optsRowCount();
  }
  private optsRowCount(): number {
    switch (classifyMode(this.currentMode)) {
      case 'am':  return 6;
      case 'fm':  return 6;
      case 'ssb': return 3;
    }
  }
  // Keep selectedIdx valid when the Opts-column length shrinks (e.g., mode
  // change from FM=6 rows to SSB=3 rows). If the cursor was past the last
  // valid row, snap back to the last opts row.
  private clampCursor(): void {
    const max = this.totalRows() - 1;
    if (this.selectedIdx > max) this.selectedIdx = max;
  }

  override async onDialRotate(ev: DialRotateEvent<Settings>): Promise<void> {
    const ticks = ev.payload.ticks;
    if (this.editMode) {
      await this.applyEdit(ticks);
    } else {
      this.focused = true;
      const total = this.totalRows();
      this.selectedIdx = ((this.selectedIdx + (ticks > 0 ? 1 : -1)) + total) % total;
      this.render();
    }
  }

  override onDialDown(_ev: DialDownEvent<Settings>): void {
    // 1-second long-press on the Preset/Step row toggles preset ↔ vfo.
    // Short PUSH falls through to onDialUp's existing toggle-edit
    // behaviour. Only armed on MODE_STEP_IDX so other rows still get
    // their normal PUSH semantics.
    if (this.selectedIdx !== MODE_STEP_IDX) return;
    this.longPressFired = false;
    if (this.longPressTimer) clearTimeout(this.longPressTimer);
    this.longPressTimer = setTimeout(() => {
      this.longPressTimer = null;
      this.longPressFired = true;
      spyService.setTuneMode(spyService.getTuneMode() === 'preset' ? 'vfo' : 'preset');
    }, 1000);
  }

  override onDialUp(_ev: DialUpEvent<Settings>): void {
    if (this.longPressTimer) { clearTimeout(this.longPressTimer); this.longPressTimer = null; }
    if (this.longPressFired) { this.longPressFired = false; return; }
    const idx = this.selectedIdx;
    if (idx < BAND_COUNT) {
      // Band row → immediate setDemodMode (no edit-mode roundtrip). The
      // service is idempotent on same-mode, so a deliberate confirm-press is
      // cheap when the cursor was already on the active band.
      spyService.setDemodMode(BAND_MODES[idx]);
      this.focused = true;
      this.render();
      return;
    }
    // Mode/Step row or Opts row → toggle edit mode.
    if (this.editMode) {
      this.editMode = false;
      this.focused = false;
    } else {
      this.editMode = true;
      this.focused = true;
    }
    this.render();
  }

  // Apply edit-mode rotation deltas. Only meaningful when selectedIdx ≥
  // MODE_STEP_IDX; band-column rows (idx < BAND_COUNT) never enter edit mode.
  private async applyEdit(ticks: number): Promise<void> {
    const idx = this.selectedIdx;
    if (idx === MODE_STEP_IDX) {
      applyModeStepEdit(ticks);
      return;
    }
    const optsIdx = idx - OPTS_START_IDX;
    const cls = classifyMode(this.currentMode);
    if (cls === 'am') {
      const cur = spyService.getAMOptions();
      switch (optsIdx) {
        case 0: await spyService.setAMOption('bandwidth',   nextInArray(BW_CYCLE_AM, cur.bandwidth, ticks)); break;
        case 1: await spyService.setAMOption('carrierAgc',  !cur.carrierAgc); break;
        case 2: await spyService.setAMOption('sync',        !cur.sync); break;
        case 3: await spyService.setAMOption('agcAttack',   adjustLog(cur.agcAttack, ticks, ATK_MIN, ATK_MAX)); break;
        case 4: await spyService.setAMOption('agcDecay',    adjustLog(cur.agcDecay,  ticks, DEC_MIN, DEC_MAX)); break;
        case 5: await spyService.setAmGain(spyService.getAmGain() + ticks); break;
      }
    } else if (cls === 'ssb') {
      const cur = spyService.getSSBOptions();
      switch (optsIdx) {
        case 0: await spyService.setSSBOption('bandwidthHz', nextInArray(BW_CYCLE_SSB, cur.bandwidthHz, ticks)); break;
        case 1: await spyService.setSSBOption('bfoPitchHz',  nextInArray(BFO_CYCLE,    cur.bfoPitchHz,  ticks)); break;
        case 2: await spyService.setFmGain(spyService.getFmGain() + ticks); break;
      }
    } else {
      const cur = spyService.getFMOptions();
      switch (optsIdx) {
        case 0: await spyService.setFMOption('bandwidth', nextInArray(BW_CYCLE_FM, cur.bandwidth, ticks)); break;
        case 1: {
          const i = DEEMPH_CYCLE.indexOf(cur.deemphasis);
          const n = (i + (ticks > 0 ? 1 : -1) + DEEMPH_CYCLE.length) % DEEMPH_CYCLE.length;
          await spyService.setFMOption('deemphasis', DEEMPH_CYCLE[n]);
          break;
        }
        case 2: await spyService.setFMOption('ifnr',     !cur.ifnr); break;
        case 3: await spyService.setFMOption('highPass', !cur.highPass); break;
        case 4: await spyService.setFMOption('lowPass',  !cur.lowPass); break;
        case 5: await spyService.setFMOption('stereo',   !cur.stereo); break;
        case 6: await spyService.setFmGain(spyService.getFmGain() + ticks); break;
      }
    }
  }

  private buildOptsRows(): OptionsPanelRow[] {
    const fmGain  = spyService.getFmGain();
    const amGain  = spyService.getAmGain();
    const maxGain = spyService.getMaxGain();
    switch (classifyMode(this.currentMode)) {
      case 'am':  return buildAmOptsRows(spyService.getAMOptions(),  amGain, maxGain);
      case 'ssb': return buildSsbOptsRows(spyService.getSSBOptions(), fmGain, maxGain);
      case 'fm':  return buildFmOptsRows(spyService.getFMOptions(),  fmGain, maxGain);
    }
  }

  private render(): void {
    if (!this.act) return;
    const tuneMode = spyService.getTuneMode();
    const stepHz = spyService.getTuneStepHz();
    const ms = modeStepRow(tuneMode, stepHz);
    const opts = this.buildOptsRows();
    const activeBandIdx = (BAND_MODES as readonly number[]).indexOf(this.currentMode);
    const sel = this.focused ? this.selectedIdx : -1;
    const dim = !this.enabled || !this.connected;
    void this.borderSide;
    this.act.setFeedback({
      'options-display': dumpAndB64('options-combo', dimSvg(optionsPanelBandSvg(BAND_LABELS, activeBandIdx, ms, opts, sel, this.editMode), dim)),
    }).catch(() => {});
  }
}
