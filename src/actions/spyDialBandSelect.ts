// Band Select dial — 200 px wide, 6 demod bands + Mode/Step row. Used as
// the Band-only half of layouts A/B/C in the dial-redesign exercise.
import { action, DialDownEvent, DialRotateEvent, DialUpEvent, SingletonAction, WillAppearEvent, WillDisappearEvent } from '@elgato/streamdeck';
import streamDeck from '@elgato/streamdeck';
import { spyService, TuneMode, TUNE_STEP_VALUES } from '../spyService.js';
import { svgB64, dumpAndB64 } from '../dialDisplay.js';
import { knobSvg, bandSelectPanelSvg, OptionsPanelRow, dimSvg } from '../icons.js';
import { DialRow, DialRowState, clampIdx, dialDispose, dialDown, dialRotate, dialUp } from './dialRowHelper.js';

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

function buildAllRows(): DialRow[] {
  const rows: DialRow[] = [];
  for (let i = 0; i < BAND_COUNT; i++) {
    rows.push({
      label: BAND_LABELS[i],
      value: '',
      skipEditToggle: true,
      onShortPush: () => spyService.setDemodMode(BAND_MODES[i]),
    });
  }
  // Mode/Step row — short PUSH toggles edit-mode (rotate cycles step),
  // long PUSH toggles preset ↔ vfo.
  const tuneMode = spyService.getTuneMode();
  const stepHz = spyService.getTuneStepHz();
  rows.push({
    label: 'Preset/Step',
    value: tuneMode === 'preset' ? 'Preset' : fmtStep(stepHz),
    onEdit: (t) => applyModeStepEdit(t),
    onLongPush: () => spyService.setTuneMode(tuneMode === 'preset' ? 'vfo' : 'preset'),
  });
  return rows;
}

@action({ UUID: 'com.hogehoge.deck-rx.dial-band-select' })
export class SpyDialBandSelect extends SingletonAction<Settings> {
  private rowState = new DialRowState();
  private act: { setImage: (s: string) => Promise<void>; setFeedback: (f: Record<string, unknown>) => Promise<void> } | null = null;
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
    this.enabledListener = (on) => { this.enabled = on; this.render(); };
    spyService.subscribeEnabled(this.enabledListener);
    this.demodListener = (mode) => {
      this.currentMode = mode;
      clampIdx(this.rowState, buildAllRows().length);
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
    spyService.connect().catch((e) => streamDeck.logger.error(`[bandSel] ${e}`));
    await ev.action.setImage(svgB64(knobSvg()));
    this.render();
  }
  override onWillDisappear(_: WillDisappearEvent<Settings>): void {
    this.teardown();
  }

  // Idempotent teardown — also called at the top of onWillAppear so a
  // re-fired willAppear (willDisappear never arrived) can't orphan the
  // previous listeners + timer in spyService's reference-keyed Sets.
  private teardown(): void {
    if (this.enabledListener) { spyService.unsubscribeEnabled(this.enabledListener); this.enabledListener = null; }
    if (this.demodListener) { spyService.unsubscribeDemodMode(this.demodListener); this.demodListener = null; }
    if (this.connStateListener) { spyService.unsubscribeConnectionState(this.connStateListener); this.connStateListener = null; }
    if (this.tuneModeListener) { spyService.unsubscribeTuneMode(this.tuneModeListener); this.tuneModeListener = null; }
    if (this.tuneStepListener) { spyService.unsubscribeTuneStep(this.tuneStepListener); this.tuneStepListener = null; }
    if (this.forceRenderListener) { spyService.unsubscribeForceRender(this.forceRenderListener); this.forceRenderListener = null; }
    dialDispose(this.rowState);
    this.act = null;
  }
  override async onDialRotate(ev: DialRotateEvent<Settings>): Promise<void> {
    await dialRotate(this.rowState, buildAllRows(), ev.payload.ticks, () => this.render());
  }
  override onDialDown(_: DialDownEvent<Settings>): void {
    dialDown(this.rowState, buildAllRows());
  }
  override async onDialUp(_: DialUpEvent<Settings>): Promise<void> {
    await dialUp(this.rowState, buildAllRows(), () => this.render());
  }
  private render(): void {
    if (!this.act) return;
    const rows = buildAllRows();
    const ms: OptionsPanelRow = {
      label: rows[MODE_STEP_IDX]?.label ?? 'Preset/Step',
      value: rows[MODE_STEP_IDX]?.value ?? '',
    };
    const activeBandIdx = (BAND_MODES as readonly number[]).indexOf(this.currentMode);
    const sel = this.rowState.focused ? this.rowState.selectedIdx : -1;
    const dim = !this.enabled || !this.connected;
    this.act.setFeedback({
      'options-display': dumpAndB64('band-select', dimSvg(bandSelectPanelSvg(BAND_LABELS, activeBandIdx, ms, sel, this.rowState.editMode), dim)),
    }).catch(() => {});
  }
}
