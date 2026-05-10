import { action, DialDownEvent, DialRotateEvent, DialUpEvent, SingletonAction, WillAppearEvent, WillDisappearEvent, DidReceiveSettingsEvent } from '@elgato/streamdeck';
import streamDeck from '@elgato/streamdeck';
import { spyService, FMOptions, DeemphasisOpt, TuneMode, tuneStepValuesForMode } from '../spyService.js';
import { svgB64, dumpAndB64, knobSvg, optionsPanelSvg, OptionsPanelRow, dimSvg } from '../icons.js';

function formatTuneStep(hz: number): string {
  if (hz >= 1000000) return `${(hz / 1000000).toFixed(0)}M`;
  if (hz >= 1000) return `${(hz / 1000).toFixed(0)}k`;
  return `${hz}Hz`;
}

type Settings = { borderSide?: 'left' | 'right' | 'center' | 'none' };

const DEEMPH_CYCLE: DeemphasisOpt[] = ['off', '50us', '75us'];
// SDR++-style WFM IF passband options. 200 kHz preserves full Carson FM
// (regulated channel width); narrower values trade a touch of HF audio
// content for adjacent-channel rejection in dense urban allotments.
const BW_CYCLE_FM: number[] = [200_000, 150_000, 110_000, 80_000];
function fmtFmBw(hz: number): string { return `${(hz / 1000) | 0}k`; }
function nextInArray<T>(arr: T[], cur: T, ticks: number): T {
  const i = arr.indexOf(cur);
  const n = ((i < 0 ? 0 : i) + (ticks > 0 ? 1 : -1) + arr.length) % arr.length;
  return arr[n];
}

interface OptionDef {
  label: string;
  format: (o: FMOptions) => string;
  cycle: (o: FMOptions, ticks: number) => Partial<FMOptions>;
}

const OPTIONS: OptionDef[] = [
  { label: 'BW',      format: (o) => fmtFmBw(o.bandwidth),       cycle: (o, t) => ({ bandwidth: nextInArray(BW_CYCLE_FM, o.bandwidth, t) }) },
  {
    label: 'De-emph',
    format: (o) => o.deemphasis === 'off' ? 'Off' : o.deemphasis,
    cycle: (o, t) => {
      const i = DEEMPH_CYCLE.indexOf(o.deemphasis);
      const n = (i + (t > 0 ? 1 : -1) + DEEMPH_CYCLE.length) % DEEMPH_CYCLE.length;
      return { deemphasis: DEEMPH_CYCLE[n] };
    },
  },
  { label: 'IFNR',    format: (o) => o.ifnr     ? 'On' : 'Off', cycle: (o) => ({ ifnr:     !o.ifnr     }) },
  { label: 'HiPass',  format: (o) => o.highPass ? 'On' : 'Off', cycle: (o) => ({ highPass: !o.highPass }) },
  { label: 'LoPass',  format: (o) => o.lowPass  ? 'On' : 'Off', cycle: (o) => ({ lowPass:  !o.lowPass  }) },
  { label: 'Stereo',  format: (o) => o.stereo   ? 'On' : 'Off', cycle: (o) => ({ stereo:   !o.stereo   }) },
];

// Synthetic rows appended after the FM-specific options:
//   [OPTIONS.length]:        Mode (Preset / VFO) — always shown
//   [OPTIONS.length+1]:      Step (cycle thru TUNE_STEP_VALUES) — VFO only
//   [last]:                  Gain — only while in FM/NFM mode
const MODE_ROW_INDEX = OPTIONS.length;

@action({ UUID: 'com.hogehoge.deck-rx.dial-options' })
export class SpyDialOptions extends SingletonAction<Settings> {
  private selectedIdx = 0;
  private editMode = false;
  private focused = false;
  private borderSide: 'left' | 'right' | 'center' | 'none' = 'none';
  private act: { setImage: (s: string) => Promise<void>; setFeedback: (f: Record<string, unknown>) => Promise<void> } | null = null;
  private optionsListener: ((o: FMOptions) => void) | null = null;
  private gainListener: ((g: number, max: number) => void) | null = null;
  private enabledListener: ((on: boolean) => void) | null = null;
  private demodListener: ((mode: number) => void) | null = null;
  private connStateListener: ((c: boolean) => void) | null = null;
  private tuneModeListener: ((m: TuneMode) => void) | null = null;
  private tuneStepListener: ((s: number) => void) | null = null;
  private forceRenderListener: (() => void) | null = null;
  private enabled = true;
  private connected = false;
  private isFmMode = true;

  override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
    this.act = ev.action as unknown as typeof this.act;
    this.borderSide = ev.payload.settings.borderSide ?? 'none';
    this.optionsListener = () => this.render();
    spyService.subscribeOptions(this.optionsListener);
    this.gainListener = () => this.render();
    spyService.subscribeFmGain(this.gainListener);
    this.enabledListener = (on) => { this.enabled = on; this.render(); };
    spyService.subscribeEnabled(this.enabledListener);
    this.demodListener = (mode) => {
      const wasFm = this.isFmMode;
      this.isFmMode = mode !== 2;
      if (wasFm && !this.isFmMode && this.selectedIdx >= OPTIONS.length) {
        this.selectedIdx = OPTIONS.length - 1;
      }
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
    spyService.connect().catch((e) => streamDeck.logger.error(`[spyDialOptions] ${e}`));
    await ev.action.setImage(svgB64(knobSvg()));
    this.render();
  }

  override onWillDisappear(_ev: WillDisappearEvent<Settings>): void {
    if (this.optionsListener) { spyService.unsubscribeOptions(this.optionsListener); this.optionsListener = null; }
    if (this.gainListener)    { spyService.unsubscribeFmGain(this.gainListener);     this.gainListener    = null; }
    if (this.enabledListener) { spyService.unsubscribeEnabled(this.enabledListener); this.enabledListener = null; }
    if (this.demodListener)   { spyService.unsubscribeDemodMode(this.demodListener); this.demodListener = null; }
    if (this.connStateListener) { spyService.unsubscribeConnectionState(this.connStateListener); this.connStateListener = null; }
    if (this.tuneModeListener) { spyService.unsubscribeTuneMode(this.tuneModeListener); this.tuneModeListener = null; }
    if (this.tuneStepListener) { spyService.unsubscribeTuneStep(this.tuneStepListener); this.tuneStepListener = null; }
    if (this.forceRenderListener) { spyService.unsubscribeForceRender(this.forceRenderListener); this.forceRenderListener = null; }
    this.act = null;
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): void {
    this.borderSide = ev.payload.settings.borderSide ?? 'none';
    this.render();
  }

  override async onDialRotate(ev: DialRotateEvent<Settings>): Promise<void> {
    // FM Options dial only operates while a FM-family mode is the active
    // demod. When AM is live, every edit on this dial would silently target
    // FM state the user can't even hear, so we ignore rotation outright.
    if (!this.isFmMode) return;
    const ticks = ev.payload.ticks;
    const tuneMode = spyService.getTuneMode();
    const showStep = tuneMode === 'vfo';
    const stepRowIdx = MODE_ROW_INDEX + 1;
    const gainRowIdx = MODE_ROW_INDEX + 1 + (showStep ? 1 : 0);
    const totalRows = MODE_ROW_INDEX + 1 + (showStep ? 1 : 0) + (this.isFmMode ? 1 : 0);
    if (this.editMode) {
      const idx = this.selectedIdx;
      if (idx < OPTIONS.length) {
        const cur = spyService.getFMOptions();
        const updates = OPTIONS[idx].cycle(cur, ticks);
        for (const [k, v] of Object.entries(updates)) {
          await spyService.setFMOption(k as keyof FMOptions, v as never);
        }
      } else if (idx === MODE_ROW_INDEX) {
        spyService.setTuneMode(tuneMode === 'preset' ? 'vfo' : 'preset');
      } else if (showStep && idx === stepRowIdx) {
        const cur = spyService.getTuneStepHz();
        const list = tuneStepValuesForMode(spyService.getDemodMode());
        const ci = list.indexOf(cur);
        const dir = ticks > 0 ? 1 : -1;
        const ni = (((ci < 0 ? 0 : ci) + dir) + list.length) % list.length;
        spyService.setTuneStepHz(list[ni]);
      } else if (this.isFmMode && idx === gainRowIdx) {
        await spyService.setFmGain(spyService.getFmGain() + ticks);
      }
    } else {
      this.focused = true;
      this.selectedIdx = ((this.selectedIdx + (ticks > 0 ? 1 : -1)) + totalRows) % totalRows;
      this.render();
    }
  }

  override onDialDown(_ev: DialDownEvent<Settings>): void {}

  override onDialUp(_ev: DialUpEvent<Settings>): void {
    // PUSH ignored when the live demod is AM — same rationale as
    // onDialRotate: there's nothing on this dial that affects AM audio.
    if (!this.isFmMode) return;
    if (this.editMode) {
      // confirm value: leave edit mode and hide focus highlight
      this.editMode = false;
      this.focused = false;
    } else {
      this.editMode = true;
      this.focused = true;
    }
    this.render();
  }

  private render(): void {
    if (!this.act) return;
    const o = spyService.getFMOptions();
    const gain = spyService.getFmGain();
    const maxGain = spyService.getMaxGain();
    const tuneMode = spyService.getTuneMode();
    const tuneStepHz = spyService.getTuneStepHz();
    const showStep = tuneMode === 'vfo';
    const rows: OptionsPanelRow[] = [
      ...OPTIONS.map((d) => ({ label: d.label, value: d.format(o) })),
    ];
    rows.push({ label: 'Mode', value: tuneMode === 'preset' ? 'Preset' : 'VFO' });
    if (showStep) rows.push({ label: 'Step', value: formatTuneStep(tuneStepHz) });
    if (this.isFmMode) rows.push({ label: 'Gain', value: maxGain > 0 ? `${gain}/${maxGain}` : '-' });
    const sel = this.focused ? this.selectedIdx : -1;
    // Dim when the master switch / TCP link is down OR when the live demod
    // mode isn't FM-family. The dim treatment + the title's "(AM live)"
    // hint together signal that the dial is locked out, and onDialRotate /
    // onDialUp short-circuit so any spin or push is a no-op.
    const dim = !this.enabled || !this.connected || !this.isFmMode;
    const activeMode = this.isFmMode ? 'FM' : 'AM';
    const title = this.isFmMode ? 'FM Options' : `FM Options  (${activeMode} live)`;
    this.act.setFeedback({
      'options-display': dumpAndB64('options', dimSvg(optionsPanelSvg(rows, sel, this.editMode, this.borderSide, title), dim)),
    }).catch(() => {});
  }
}
