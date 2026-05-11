import { action, DialDownEvent, DialRotateEvent, DialUpEvent, SingletonAction, WillAppearEvent, WillDisappearEvent, DidReceiveSettingsEvent } from '@elgato/streamdeck';
import streamDeck from '@elgato/streamdeck';
import { spyService, SSBOptions, TuneMode, tuneStepValuesForMode } from '../spyService.js';
import { svgB64, dumpAndB64 } from '../dialDisplay.js';
import { knobSvg, optionsPanelSvg, OptionsPanelRow, dimSvg } from '../icons.js';

// Single-column dial dedicated to USB / LSB / CW. Only meaningful while the
// active demod mode is one of those three (modes 4 / 5 / 6) — for AM / FM /
// NFM the panel is dimmed and edits are ignored. Mirrors the pattern in
// spyDialAmOptions / spyDialOptions: an OPTIONS array drives the upper rows,
// then synthetic Mode (and Step in VFO) and Gain rows are appended.

type Settings = { borderSide?: 'left' | 'right' | 'center' | 'none' };

function formatTuneStep(hz: number): string {
  if (hz >= 1_000_000) return `${(hz / 1_000_000).toFixed(0)}M`;
  if (hz >= 1_000)     return `${(hz / 1_000).toFixed(0)}k`;
  return `${hz}Hz`;
}

// Audio-bandwidth cycle covers both CW-narrow and SSB-voice slots:
//   250 / 500 / 1000 — CW filters (250 = contest, 500 = standard, 1000 = wide CW)
//   1800 / 2400 / 2800 — SSB voice (compact / standard / wide)
const BW_CYCLE = [250, 500, 1000, 1800, 2400, 2800];

// CW BFO pitch: 100 Hz step covers the audible-tone range most CW operators
// use (500–800 typical).
const BFO_CYCLE = [400, 500, 600, 700, 800, 900];

function fmtBw(hz: number): string {
  if (hz >= 1000) {
    const k = hz / 1000;
    return Number.isInteger(k) ? k.toFixed(0) + 'k' : k.toFixed(1) + 'k';
  }
  return String(hz);
}

function nextInArray<T>(arr: T[], cur: T, ticks: number): T {
  const i = arr.indexOf(cur);
  const safeI = i < 0 ? 0 : i;
  const dir = ticks > 0 ? 1 : -1;
  const n = (safeI + dir + arr.length) % arr.length;
  return arr[n];
}

interface OptionDef {
  label: string;
  format: (o: SSBOptions) => string;
  cycle: (o: SSBOptions, ticks: number) => Partial<SSBOptions>;
}

const OPTIONS: OptionDef[] = [
  {
    label: 'BW',
    format: (o) => fmtBw(o.bandwidthHz),
    cycle: (o, t) => ({ bandwidthHz: nextInArray(BW_CYCLE, o.bandwidthHz, t) }),
  },
  {
    label: 'BFO',
    format: (o) => `${o.bfoPitchHz}`,
    cycle: (o, t) => ({ bfoPitchHz: nextInArray(BFO_CYCLE, o.bfoPitchHz, t) }),
  },
];

const MODE_ROW_INDEX = OPTIONS.length;

@action({ UUID: 'com.hogehoge.deck-rx.dial-ssb-options' })
export class SpyDialSsbOptions extends SingletonAction<Settings> {
  private selectedIdx = 0;
  private editMode = false;
  private focused = false;
  private borderSide: 'left' | 'right' | 'center' | 'none' = 'none';
  private act: { setImage: (s: string) => Promise<void>; setFeedback: (f: Record<string, unknown>) => Promise<void> } | null = null;
  private listener: ((o: SSBOptions) => void) | null = null;
  private fmGainListener: ((g: number, max: number) => void) | null = null;
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
  // SSB / CW = mode 4 / 5 / 6. The dial is dim and ignores edits otherwise.
  private isSsbMode = false;

  override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
    this.act = ev.action as unknown as typeof this.act;
    this.borderSide = ev.payload.settings.borderSide ?? 'none';
    this.listener = () => this.render();
    spyService.subscribeSSBOptions(this.listener);
    // SSB / CW use the non-AM gain path (fmGain).
    this.fmGainListener = () => this.render();
    spyService.subscribeFmGain(this.fmGainListener);
    this.enabledListener = (on) => { this.enabled = on; this.render(); };
    spyService.subscribeEnabled(this.enabledListener);
    this.demodListener = (mode) => {
      this.isSsbMode = mode === 4 || mode === 5 || mode === 6;
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
    spyService.connect().catch((e) => streamDeck.logger.error(`[spyDialSsbOptions] ${e}`));
    await ev.action.setImage(svgB64(knobSvg()));
    this.render();
  }

  override onWillDisappear(_ev: WillDisappearEvent<Settings>): void {
    if (this.listener)         { spyService.unsubscribeSSBOptions(this.listener); this.listener = null; }
    if (this.fmGainListener)   { spyService.unsubscribeFmGain(this.fmGainListener); this.fmGainListener = null; }
    if (this.enabledListener)  { spyService.unsubscribeEnabled(this.enabledListener); this.enabledListener = null; }
    if (this.demodListener)    { spyService.unsubscribeDemodMode(this.demodListener); this.demodListener = null; }
    if (this.connStateListener){ spyService.unsubscribeConnectionState(this.connStateListener); this.connStateListener = null; }
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
    const ticks = ev.payload.ticks;
    const gainRowIdx = MODE_ROW_INDEX + 1;
    const totalRows = MODE_ROW_INDEX + 1 + (this.isSsbMode ? 1 : 0);
    if (this.editMode) {
      const idx = this.selectedIdx;
      if (idx < OPTIONS.length) {
        // Only act on SSB / CW mode — the dial does not pretend to control AM
        // bandwidth or FM filters from this surface.
        if (!this.isSsbMode) return;
        const cur = spyService.getSSBOptions();
        const updates = OPTIONS[idx].cycle(cur, ticks);
        for (const [k, v] of Object.entries(updates)) {
          await spyService.setSSBOption(k as keyof SSBOptions, v as never);
        }
      } else if (idx === MODE_ROW_INDEX) {
        // Preset/Step row: rotate cycles step list (wrap). Mode toggle on
        // 1 s long-press, see onDialDown.
        const cur = spyService.getTuneStepHz();
        const list = tuneStepValuesForMode(spyService.getDemodMode());
        const ci = list.indexOf(cur);
        const dir = ticks > 0 ? 1 : -1;
        const ni = (((ci < 0 ? 0 : ci) + dir) + list.length) % list.length;
        spyService.setTuneStepHz(list[ni]);
      } else if (this.isSsbMode && idx === gainRowIdx) {
        await spyService.setFmGain(spyService.getFmGain() + ticks);
      }
    } else {
      this.focused = true;
      this.selectedIdx = ((this.selectedIdx + (ticks > 0 ? 1 : -1)) + totalRows) % totalRows;
      this.render();
    }
  }

  override onDialDown(_ev: DialDownEvent<Settings>): void {
    if (this.selectedIdx !== MODE_ROW_INDEX) return;
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
    if (this.editMode) {
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
    const o = spyService.getSSBOptions();
    const gain = spyService.getFmGain();
    const maxGain = spyService.getMaxGain();
    const tuneMode = spyService.getTuneMode();
    const tuneStepHz = spyService.getTuneStepHz();
    const rows: OptionsPanelRow[] = [
      ...OPTIONS.map((d) => ({ label: d.label, value: d.format(o) })),
    ];
    rows.push({
      label: 'Preset/Step',
      value: tuneMode === 'preset' ? 'Preset' : formatTuneStep(tuneStepHz),
    });
    if (this.isSsbMode) rows.push({ label: 'Gain', value: maxGain > 0 ? `${gain}/${maxGain}` : '-' });
    const sel = this.focused ? this.selectedIdx : -1;
    // Dim when offline OR when the active mode is not SSB / CW (the dial is
    // ineffective there; the visual cue mirrors the AM-options dial behaviour
    // when AM is not the active mode).
    const dim = !this.enabled || !this.connected || !this.isSsbMode;
    this.act.setFeedback({
      'options-display': dumpAndB64('ssb-options', dimSvg(optionsPanelSvg(rows, sel, this.editMode, this.borderSide, 'SSB Options'), dim)),
    }).catch(() => {});
  }
}
