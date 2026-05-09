import { action, DialDownEvent, DialRotateEvent, DialUpEvent, SingletonAction, WillAppearEvent, WillDisappearEvent, DidReceiveSettingsEvent } from '@elgato/streamdeck';
import streamDeck from '@elgato/streamdeck';
import { spyService, AMOptions, TuneMode, tuneStepValuesForMode } from '../spyService.js';
import { svgB64, dumpAndB64 } from '../dialDisplay.js';
import { knobSvg, optionsPanelSvg, OptionsPanelRow, dimSvg } from '../icons.js';

type Settings = { borderSide?: 'left' | 'right' | 'center' | 'none' };

function formatTuneStep(hz: number): string {
  if (hz >= 1000000) return `${(hz / 1000000).toFixed(0)}M`;
  if (hz >= 1000) return `${(hz / 1000).toFixed(0)}k`;
  return `${hz}Hz`;
}

// Bandwidth: still discrete (4/6/9/12 kHz are standard AM channel widths).
const BW_CYCLE = [4000, 6000, 9000, 12000];

// SDR++ slider ranges (radio_module / dsp::demod::AM): Attack 1..200,
// Decay 1..20. Stored value = attack/decay rate in 1/τ_seconds. SpyService
// converts to the per-sample α = rate / fs before passing to the demod.
const ATK_MIN = 1;
const ATK_MAX = 200;
const DEC_MIN = 1;
const DEC_MAX = 20;
const TICK_FACTOR = 1.1;    // 10% per tick (continuous log adjust)

function adjustLog(cur: number, ticks: number, min: number, max: number): number {
  const factor = Math.pow(TICK_FACTOR, ticks);
  return Math.max(min, Math.min(max, cur * factor));
}

function fmtBw(hz: number): string {
  if (hz >= 1000) return (hz / 1000).toFixed(0) + 'k';
  return String(hz);
}

interface OptionDef {
  label: string;
  format: (o: AMOptions) => string;
  cycle: (o: AMOptions, ticks: number) => Partial<AMOptions>;
}

function nextInArray<T>(arr: T[], cur: T, ticks: number): T {
  const i = arr.indexOf(cur);
  const safeI = i < 0 ? 0 : i;
  const dir = ticks > 0 ? 1 : -1;
  const n = (safeI + dir + arr.length) % arr.length;
  return arr[n];
}

const OPTIONS: OptionDef[] = [
  {
    label: 'BW',
    format: (o) => fmtBw(o.bandwidth),
    cycle: (o, t) => ({ bandwidth: nextInArray(BW_CYCLE, o.bandwidth, t) }),
  },
  {
    label: 'CAGC',
    format: (o) => o.carrierAgc ? 'On' : 'Off',
    cycle: (o) => ({ carrierAgc: !o.carrierAgc }),
  },
  {
    label: 'Sync',
    format: (o) => o.sync ? 'On' : 'Off',
    cycle: (o) => ({ sync: !o.sync }),
  },
  {
    label: 'Atk',
    // SDR++ slider value, max "200.000": 3 integer digits + 3 decimals.
    format: (o) => o.agcAttack.toFixed(3).padStart(7, ' '),
    cycle: (o, t) => ({ agcAttack: adjustLog(o.agcAttack, t, ATK_MIN, ATK_MAX) }),
  },
  {
    label: 'Dec',
    // Max "20.000": 2 integer digits + 3 decimals.
    format: (o) => o.agcDecay.toFixed(3).padStart(6, ' '),
    cycle: (o, t) => ({ agcDecay: adjustLog(o.agcDecay, t, DEC_MIN, DEC_MAX) }),
  },
];

// "Gain" is a synthetic row appended after the AM-specific options. It only
// appears while AM is the currently active demod mode — adjusting it on the
// FM Options dial when in AM (or vice versa) wouldn't take effect anyway,
// and showing both at once led to "two Gain rows visible" confusion.
// Synthetic rows after OPTIONS:
//   [OPTIONS.length]:        Mode (Preset / VFO) — always shown
//   [OPTIONS.length+1]:      Step — VFO only
//   [last]:                  Gain — only while in AM mode
const MODE_ROW_INDEX = OPTIONS.length;

@action({ UUID: 'com.hogehoge.deck-rx.dial-am-options' })
export class SpyDialAmOptions extends SingletonAction<Settings> {
  private selectedIdx = 0;
  private editMode = false;
  private focused = false;
  private borderSide: 'left' | 'right' | 'center' | 'none' = 'none';
  private act: { setImage: (s: string) => Promise<void>; setFeedback: (f: Record<string, unknown>) => Promise<void> } | null = null;
  private listener: ((o: AMOptions) => void) | null = null;
  private gainListener: ((g: number, max: number) => void) | null = null;
  private enabledListener: ((on: boolean) => void) | null = null;
  private demodListener: ((mode: number) => void) | null = null;
  private connStateListener: ((c: boolean) => void) | null = null;
  private tuneModeListener: ((m: TuneMode) => void) | null = null;
  private tuneStepListener: ((s: number) => void) | null = null;
  private enabled = true;
  private connected = false;
  private isAmMode = true;

  override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
    this.act = ev.action as unknown as typeof this.act;
    this.borderSide = ev.payload.settings.borderSide ?? 'none';
    this.listener = () => this.render();
    spyService.subscribeAMOptions(this.listener);
    this.gainListener = () => this.render();
    spyService.subscribeAmGain(this.gainListener);
    this.enabledListener = (on) => { this.enabled = on; this.render(); };
    spyService.subscribeEnabled(this.enabledListener);
    this.demodListener = (mode) => {
      const wasAm = this.isAmMode;
      this.isAmMode = mode === 2;
      // If we lost the Gain row by switching out of AM, snap selection back.
      if (wasAm && !this.isAmMode && this.selectedIdx >= OPTIONS.length) {
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
    spyService.connect().catch((e) => streamDeck.logger.error(`[spyDialAmOptions] ${e}`));
    await ev.action.setImage(svgB64(knobSvg()));
    this.render();
  }

  override onWillDisappear(_ev: WillDisappearEvent<Settings>): void {
    if (this.listener) { spyService.unsubscribeAMOptions(this.listener); this.listener = null; }
    if (this.gainListener) { spyService.unsubscribeAmGain(this.gainListener); this.gainListener = null; }
    if (this.enabledListener) { spyService.unsubscribeEnabled(this.enabledListener); this.enabledListener = null; }
    if (this.demodListener)   { spyService.unsubscribeDemodMode(this.demodListener); this.demodListener = null; }
    if (this.connStateListener) { spyService.unsubscribeConnectionState(this.connStateListener); this.connStateListener = null; }
    if (this.tuneModeListener) { spyService.unsubscribeTuneMode(this.tuneModeListener); this.tuneModeListener = null; }
    if (this.tuneStepListener) { spyService.unsubscribeTuneStep(this.tuneStepListener); this.tuneStepListener = null; }
    this.act = null;
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): void {
    this.borderSide = ev.payload.settings.borderSide ?? 'none';
    this.render();
  }

  override async onDialRotate(ev: DialRotateEvent<Settings>): Promise<void> {
    const ticks = ev.payload.ticks;
    const tuneMode = spyService.getTuneMode();
    const showStep = tuneMode === 'vfo';
    const stepRowIdx = MODE_ROW_INDEX + 1;
    const gainRowIdx = MODE_ROW_INDEX + 1 + (showStep ? 1 : 0);
    const totalRows = MODE_ROW_INDEX + 1 + (showStep ? 1 : 0) + (this.isAmMode ? 1 : 0);
    if (this.editMode) {
      const idx = this.selectedIdx;
      if (idx < OPTIONS.length) {
        const cur = spyService.getAMOptions();
        const updates = OPTIONS[idx].cycle(cur, ticks);
        for (const [k, v] of Object.entries(updates)) {
          await spyService.setAMOption(k as keyof AMOptions, v as never);
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
      } else if (this.isAmMode && idx === gainRowIdx) {
        await spyService.setAmGain(spyService.getAmGain() + ticks);
      }
    } else {
      this.focused = true;
      this.selectedIdx = ((this.selectedIdx + (ticks > 0 ? 1 : -1)) + totalRows) % totalRows;
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

  private render(): void {
    if (!this.act) return;
    const o = spyService.getAMOptions();
    const gain = spyService.getAmGain();
    const maxGain = spyService.getMaxGain();
    const tuneMode = spyService.getTuneMode();
    const tuneStepHz = spyService.getTuneStepHz();
    const showStep = tuneMode === 'vfo';
    const rows: OptionsPanelRow[] = [
      ...OPTIONS.map((d) => ({ label: d.label, value: d.format(o) })),
    ];
    rows.push({ label: 'Mode', value: tuneMode === 'preset' ? 'Preset' : 'VFO' });
    if (showStep) rows.push({ label: 'Step', value: formatTuneStep(tuneStepHz) });
    if (this.isAmMode) rows.push({ label: 'Gain', value: maxGain > 0 ? `${gain}/${maxGain}` : '-' });
    const sel = this.focused ? this.selectedIdx : -1;
    const dim = !this.enabled || !this.connected;
    // Title shows the dial's purpose; if the live demod is something other
    // than AM, append a hint so the user isn't fooled into thinking edits
    // here will affect what they're hearing right now.
    const title = this.isAmMode ? 'AM Options' : 'AM Options  (FM live)';
    this.act.setFeedback({
      'options-display': dumpAndB64('am-options', dimSvg(optionsPanelSvg(rows, sel, this.editMode, this.borderSide, title), dim)),
    }).catch(() => {});
  }
}
