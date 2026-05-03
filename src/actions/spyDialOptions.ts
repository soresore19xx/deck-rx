import { action, DialDownEvent, DialRotateEvent, DialUpEvent, SingletonAction, WillAppearEvent, WillDisappearEvent, DidReceiveSettingsEvent } from '@elgato/streamdeck';
import streamDeck from '@elgato/streamdeck';
import { spyService, FMOptions, DeemphasisOpt } from '../spyService.js';
import { svgB64, knobSvg, optionsPanelSvg, OptionsPanelRow, dimSvg } from '../icons.js';

type Settings = { borderSide?: 'left' | 'right' | 'center' | 'none' };

const DEEMPH_CYCLE: DeemphasisOpt[] = ['off', '50us', '75us'];

interface OptionDef {
  label: string;
  format: (o: FMOptions) => string;
  cycle: (o: FMOptions, ticks: number) => Partial<FMOptions>;
}

const OPTIONS: OptionDef[] = [
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

// "Gain" is a synthetic row appended after the FM-specific options. Only
// shown while a non-AM mode is active (FM/NFM/etc) — see SpyDialAmOptions.
const GAIN_ROW_INDEX = OPTIONS.length;

@action({ UUID: 'com.hogehoge.spyserver-ex.dial-options' })
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
    this.act = null;
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): void {
    this.borderSide = ev.payload.settings.borderSide ?? 'none';
    this.render();
  }

  override async onDialRotate(ev: DialRotateEvent<Settings>): Promise<void> {
    const ticks = ev.payload.ticks;
    const totalRows = OPTIONS.length + (this.isFmMode ? 1 : 0);
    if (this.editMode) {
      if (this.isFmMode && this.selectedIdx === GAIN_ROW_INDEX) {
        await spyService.setFmGain(spyService.getFmGain() + ticks);
      } else {
        const cur = spyService.getFMOptions();
        const updates = OPTIONS[this.selectedIdx].cycle(cur, ticks);
        for (const [k, v] of Object.entries(updates)) {
          await spyService.setFMOption(k as keyof FMOptions, v as never);
        }
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
    const rows: OptionsPanelRow[] = [
      ...OPTIONS.map((d) => ({ label: d.label, value: d.format(o) })),
    ];
    if (this.isFmMode) {
      rows.push({ label: 'Gain', value: maxGain > 0 ? `${gain}/${maxGain}` : '-' });
    }
    const sel = this.focused ? this.selectedIdx : -1;
    const dim = !this.enabled || !this.connected;
    this.act.setFeedback({
      'options-display': svgB64(dimSvg(optionsPanelSvg(rows, sel, this.editMode, this.borderSide), dim)),
    }).catch(() => {});
  }
}
