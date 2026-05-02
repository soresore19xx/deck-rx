import { action, DialDownEvent, DialRotateEvent, DialUpEvent, SingletonAction, WillAppearEvent, WillDisappearEvent, DidReceiveSettingsEvent } from '@elgato/streamdeck';
import streamDeck from '@elgato/streamdeck';
import { spyService, AMOptions } from '../spyService.js';
import { svgB64 } from '../dialDisplay.js';
import { knobSvg, optionsPanelSvg, OptionsPanelRow } from '../icons.js';

type Settings = { borderSide?: 'left' | 'right' | 'center' | 'none' };

// Bandwidth: still discrete (4/6/9/12 kHz are standard AM channel widths).
const BW_CYCLE = [4000, 6000, 9000, 12000];

// SDR++ ranges: Attack 1-200 ms, Decay 1-20 ms (per-sample IIR factor at 57 kHz).
//   α = 1 − exp(−T/τ),  T = 1/57000
const ATK_MIN = 0.0000877;  // 200 ms TC
const ATK_MAX = 0.01736;    //   1 ms TC
const DEC_MIN = 0.000876;   //  20 ms TC
const DEC_MAX = 0.01736;    //   1 ms TC
const TICK_FACTOR = 1.1;    // 10% per tick

function adjustLog(cur: number, ticks: number, min: number, max: number): number {
  const factor = Math.pow(TICK_FACTOR, ticks);
  return Math.max(min, Math.min(max, cur * factor));
}

// Convert per-sample IIR factor → time constant in ms (SDR++ display convention).
//   α = 1 − exp(−T/τ)   T = 1/fs (s)
//   τ(s)  = −1 / (fs · ln(1−α))
//   τ(ms) = −1000 / (fs(Hz) · ln(1−α))  =  −1 / (fs(kHz) · ln(1−α))
// fs = 57 kHz audio rate.
function alphaToMs(alpha: number): number {
  if (alpha <= 0 || alpha >= 1) return 0;
  return -1 / (57 * Math.log(1 - alpha));
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
    label: 'Atk',
    // SDR++ display: e.g. "200.000" — 3 integer digits + 3 decimals, padded.
    format: (o) => alphaToMs(o.agcAttack).toFixed(3).padStart(7, ' '),
    cycle: (o, t) => ({ agcAttack: adjustLog(o.agcAttack, -t, ATK_MIN, ATK_MAX) }),
  },
  {
    label: 'Dec',
    // Decay max is 20.000 — 2 integer digits + 3 decimals.
    format: (o) => alphaToMs(o.agcDecay).toFixed(3).padStart(6, ' '),
    cycle: (o, t) => ({ agcDecay: adjustLog(o.agcDecay, -t, DEC_MIN, DEC_MAX) }),
  },
];

@action({ UUID: 'com.hogehoge.spyserver-ex.dial-am-options' })
export class SpyDialAmOptions extends SingletonAction<Settings> {
  private selectedIdx = 0;
  private editMode = false;
  private focused = false;
  private borderSide: 'left' | 'right' | 'center' | 'none' = 'none';
  private act: { setImage: (s: string) => Promise<void>; setFeedback: (f: Record<string, unknown>) => Promise<void> } | null = null;
  private listener: ((o: AMOptions) => void) | null = null;

  override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
    this.act = ev.action as unknown as typeof this.act;
    this.borderSide = ev.payload.settings.borderSide ?? 'none';
    this.listener = () => this.render();
    spyService.subscribeAMOptions(this.listener);
    spyService.connect().catch((e) => streamDeck.logger.error(`[spyDialAmOptions] ${e}`));
    await ev.action.setImage(svgB64(knobSvg()));
    this.render();
  }

  override onWillDisappear(_ev: WillDisappearEvent<Settings>): void {
    if (this.listener) { spyService.unsubscribeAMOptions(this.listener); this.listener = null; }
    this.act = null;
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): void {
    this.borderSide = ev.payload.settings.borderSide ?? 'none';
    this.render();
  }

  override async onDialRotate(ev: DialRotateEvent<Settings>): Promise<void> {
    const ticks = ev.payload.ticks;
    if (this.editMode) {
      const cur = spyService.getAMOptions();
      const updates = OPTIONS[this.selectedIdx].cycle(cur, ticks);
      for (const [k, v] of Object.entries(updates)) {
        await spyService.setAMOption(k as keyof AMOptions, v as never);
      }
    } else {
      this.focused = true;
      this.selectedIdx = ((this.selectedIdx + (ticks > 0 ? 1 : -1)) + OPTIONS.length) % OPTIONS.length;
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
    const rows: OptionsPanelRow[] = OPTIONS.map((d) => ({ label: d.label, value: d.format(o) }));
    const sel = this.focused ? this.selectedIdx : -1;
    this.act.setFeedback({
      'options-display': svgB64(optionsPanelSvg(rows, sel, this.editMode, this.borderSide)),
    }).catch(() => {});
  }
}
