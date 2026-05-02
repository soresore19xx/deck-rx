import { action, DialDownEvent, DialRotateEvent, DialUpEvent, SingletonAction, WillAppearEvent, WillDisappearEvent, DidReceiveSettingsEvent } from '@elgato/streamdeck';
import streamDeck from '@elgato/streamdeck';
import { spyService } from '../spyService.js';
import { svgB64, makeHeaderSvg, makeBorderSvg, seg7svg, volBarSvg } from '../dialDisplay.js';
import { knobSvg } from '../icons.js';

type Settings = {
  borderSide?: 'left' | 'right' | 'center' | 'none';
  step?: number;  // % per tick (default 2)
};

@action({ UUID: 'com.hogehoge.spyserver-ex.dial-volume' })
export class SpyDialVolume extends SingletonAction<Settings> {
  private borderSide: 'left' | 'right' | 'center' | 'none' = 'none';
  private step = 2;
  private act: { setImage: (s: string) => Promise<void>; setFeedback: (f: Record<string, unknown>) => Promise<void> } | null = null;
  private volListener: ((v: number, muted: boolean) => void) | null = null;

  override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
    this.act = ev.action as unknown as typeof this.act;
    this.borderSide = ev.payload.settings.borderSide ?? 'none';
    this.step = ev.payload.settings.step ?? 2;
    this.volListener = () => this.render();
    spyService.subscribeVolume(this.volListener);
    spyService.connect().catch((e) => streamDeck.logger.error(`[spyDialVolume] ${e}`));
    await ev.action.setImage(svgB64(knobSvg()));
    this.render();
  }

  override onWillDisappear(_ev: WillDisappearEvent<Settings>): void {
    if (this.volListener) { spyService.unsubscribeVolume(this.volListener); this.volListener = null; }
    this.act = null;
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): void {
    this.borderSide = ev.payload.settings.borderSide ?? 'none';
    this.step = ev.payload.settings.step ?? 2;
    this.render();
  }

  override onDialRotate(ev: DialRotateEvent<Settings>): void {
    const ticks = ev.payload.ticks;
    // Acceleration: faster spin → larger step
    const absTicks = Math.abs(ticks);
    const accel = absTicks > 5 ? 5 : absTicks > 2 ? 3 : this.step;
    const cur = spyService.getVolume() * 100;
    const next = Math.max(0, Math.min(150, cur + ticks * accel));
    spyService.setVolume(next / 100);
  }

  override onDialDown(_ev: DialDownEvent<Settings>): void {}
  override onDialUp(_ev: DialUpEvent<Settings>): void {
    spyService.setMuted(!spyService.isMuted());
  }

  private render(): void {
    if (!this.act) return;
    const v = spyService.getVolume();
    const m = spyService.isMuted();
    const pct = Math.round(v * 100);
    const headerLabel = m ? '─── MUTE ───' : '─── VOLUME ───';
    this.act.setFeedback({
      header:        makeHeaderSvg(headerLabel, false),
      'freq-display': svgB64(seg7svg(m ? '---' : String(pct), '%', 200, 68)),
      'vol-bar':     volBarSvg(Math.min(100, pct), m),
      'vol-num':     m ? '---' : String(pct),
      border:        makeBorderSvg(this.borderSide),
    }).catch(() => {});
  }
}
