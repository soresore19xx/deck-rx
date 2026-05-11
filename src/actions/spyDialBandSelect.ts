// Band Select dial — 200 px wide, 6 demod bands + Mode/Step row. Used as
// the Band-only half of layouts A/B/C in the dial-redesign exercise.
import { action, DialDownEvent, DialRotateEvent, DialUpEvent, SingletonAction, WillAppearEvent, WillDisappearEvent } from '@elgato/streamdeck';
import streamDeck from '@elgato/streamdeck';
import { spyService, TuneMode, TUNE_STEP_VALUES } from '../spyService.js';
import { svgB64, dumpAndB64 } from '../dialDisplay.js';
import { knobSvg, bandSelectPanelSvg, OptionsPanelRow, dimSvg } from '../icons.js';

type Settings = { borderSide?: 'left' | 'right' | 'center' | 'none' };

const BAND_LABELS = ['WFM', 'NFM', 'AM', 'USB', 'LSB', 'CW'] as const;
const BAND_MODES  = [   1,    0,   2,    4,    6,   5] as const;
const BAND_COUNT = BAND_LABELS.length;
const MODE_STEP_IDX = BAND_COUNT;

function fmtStep(hz: number): string {
  if (hz >= 1_000_000) return `${(hz / 1_000_000).toFixed(0)}M`;
  if (hz >= 1_000)     return `${(hz / 1_000).toFixed(0)}k`;
  return `${hz}Hz`;
}
function modeStepRow(tuneMode: TuneMode, stepHz: number): OptionsPanelRow {
  // Single row, two controls: short PUSH toggles edit-mode (rotate cycles
  // step), LONG PUSH (≥ 1 s) toggles preset ↔ vfo. Label is constant
  // 'Preset/Step' so the user knows both are accessible; value reflects
  // the current mode + step.
  const v = tuneMode === 'preset' ? 'Preset' : fmtStep(stepHz);
  return { label: 'Preset/Step', value: v };
}
function applyModeStepEdit(ticks: number): void {
  // Rotate ALWAYS cycles step within the current list with wrap-around.
  // Mode toggle moved to long-press; rotation no longer escapes off the
  // list edges into the wrong control.
  const list = TUNE_STEP_VALUES;
  const ci = list.indexOf(spyService.getTuneStepHz());
  const dir = ticks > 0 ? 1 : -1;
  const next = (((ci < 0 ? 0 : ci) + dir) + list.length) % list.length;
  spyService.setTuneStepHz(list[next]);
}

@action({ UUID: 'com.hogehoge.deck-rx.dial-band-select' })
export class SpyDialBandSelect extends SingletonAction<Settings> {
  private selectedIdx = 0;
  private editMode = false;
  private focused = false;
  private act: { setImage: (s: string) => Promise<void>; setFeedback: (f: Record<string, unknown>) => Promise<void> } | null = null;
  private enabledListener: ((on: boolean) => void) | null = null;
  private demodListener: ((mode: number) => void) | null = null;
  private connStateListener: ((c: boolean) => void) | null = null;
  private tuneModeListener: ((m: TuneMode) => void) | null = null;
  private tuneStepListener: ((s: number) => void) | null = null;
  private forceRenderListener: (() => void) | null = null;
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private longPressFired = false;
  private enabled = true;
  private connected = false;
  private currentMode = 0;

  override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
    this.act = ev.action as unknown as typeof this.act;
    this.enabledListener = (on) => { this.enabled = on; this.render(); };
    spyService.subscribeEnabled(this.enabledListener);
    this.demodListener = (mode) => { this.currentMode = mode; this.render(); };
    spyService.subscribeDemodMode(this.demodListener);
    this.connStateListener = (c) => { this.connected = c; this.render(); };
    spyService.subscribeConnectionState(this.connStateListener);
    this.tuneModeListener = () => this.render();
    spyService.subscribeTuneMode(this.tuneModeListener);
    this.tuneStepListener = () => this.render();
    spyService.subscribeTuneStep(this.tuneStepListener);
    this.forceRenderListener = () => this.render();
    spyService.subscribeForceRender(this.forceRenderListener);
    spyService.connect().catch((e) => streamDeck.logger.error(`[bandSel] ${e}`));
    await ev.action.setImage(svgB64(knobSvg()));
    this.render();
  }
  override onWillDisappear(_: WillDisappearEvent<Settings>): void {
    if (this.enabledListener) { spyService.unsubscribeEnabled(this.enabledListener); this.enabledListener = null; }
    if (this.demodListener) { spyService.unsubscribeDemodMode(this.demodListener); this.demodListener = null; }
    if (this.connStateListener) { spyService.unsubscribeConnectionState(this.connStateListener); this.connStateListener = null; }
    if (this.tuneModeListener) { spyService.unsubscribeTuneMode(this.tuneModeListener); this.tuneModeListener = null; }
    if (this.tuneStepListener) { spyService.unsubscribeTuneStep(this.tuneStepListener); this.tuneStepListener = null; }
    if (this.forceRenderListener) { spyService.unsubscribeForceRender(this.forceRenderListener); this.forceRenderListener = null; }
    this.act = null;
  }
  override async onDialRotate(ev: DialRotateEvent<Settings>): Promise<void> {
    if (this.editMode && this.selectedIdx === MODE_STEP_IDX) { applyModeStepEdit(ev.payload.ticks); return; }
    this.focused = true;
    const total = BAND_COUNT + 1;
    this.selectedIdx = ((this.selectedIdx + (ev.payload.ticks > 0 ? 1 : -1)) + total) % total;
    this.render();
  }
  override onDialDown(_: DialDownEvent<Settings>): void {
    // Start a 1-second long-press timer for the Mode/Step row: holding
    // PUSH for ≥ 1 s toggles preset ↔ vfo. Short PUSH (< 1 s) falls
    // through to the existing onDialUp toggle-edit behaviour.
    if (this.selectedIdx !== MODE_STEP_IDX) return;
    this.longPressFired = false;
    if (this.longPressTimer) clearTimeout(this.longPressTimer);
    this.longPressTimer = setTimeout(() => {
      this.longPressTimer = null;
      this.longPressFired = true;
      spyService.setTuneMode(spyService.getTuneMode() === 'preset' ? 'vfo' : 'preset');
    }, 1000);
  }
  override onDialUp(_: DialUpEvent<Settings>): void {
    if (this.longPressTimer) { clearTimeout(this.longPressTimer); this.longPressTimer = null; }
    if (this.longPressFired) { this.longPressFired = false; return; }
    const idx = this.selectedIdx;
    if (idx < BAND_COUNT) {
      spyService.setDemodMode(BAND_MODES[idx]);
      this.focused = true; this.render(); return;
    }
    this.editMode = !this.editMode;
    this.focused = this.editMode;
    this.render();
  }
  private render(): void {
    if (!this.act) return;
    const ms = modeStepRow(spyService.getTuneMode(), spyService.getTuneStepHz());
    const activeBandIdx = (BAND_MODES as readonly number[]).indexOf(this.currentMode);
    const sel = this.focused ? this.selectedIdx : -1;
    const dim = !this.enabled || !this.connected;
    this.act.setFeedback({
      'options-display': dumpAndB64('band-select', dimSvg(bandSelectPanelSvg(BAND_LABELS, activeBandIdx, ms, sel, this.editMode), dim)),
    }).catch(() => {});
  }
}
