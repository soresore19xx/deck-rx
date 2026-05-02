import { action, DialDownEvent, DialRotateEvent, DialUpEvent, SingletonAction, WillAppearEvent, WillDisappearEvent, DidReceiveSettingsEvent } from '@elgato/streamdeck';
import streamDeck from '@elgato/streamdeck';
import { spyService, AMOptions } from '../spyService.js';
import { svgB64 } from '../dialDisplay.js';
import { knobSvg, optionsPanelSvg, OptionsPanelRow } from '../icons.js';

type Settings = { borderSide?: 'left' | 'right' | 'center' | 'none' };

const BW_CYCLE = [4000, 6000, 9000, 12000];
// Attack/Decay are presented as discrete steps (slow/medium/fast)
const ATTACK_CYCLE = [0.01, 0.02, 0.05, 0.1, 0.2];
const DECAY_CYCLE  = [0.0001, 0.0005, 0.001, 0.005, 0.01];

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
    format: (o) => o.agcAttack.toFixed(3),
    cycle: (o, t) => ({ agcAttack: nextInArray(ATTACK_CYCLE, o.agcAttack, t) }),
  },
  {
    label: 'Dec',
    format: (o) => o.agcDecay.toFixed(4),
    cycle: (o, t) => ({ agcDecay: nextInArray(DECAY_CYCLE, o.agcDecay, t) }),
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
