import {
  action, SingletonAction,
  WillAppearEvent, WillDisappearEvent, DidReceiveSettingsEvent,
  KeyDownEvent, KeyUpEvent,
} from '@elgato/streamdeck';
import { spyService } from '../spyService.js';

// Companion Key (button) action for the existing Volume dial. Useful on
// devices without dials (Stream Deck XL) or when the dial space is taken
// by FFT / other LCDX2 panels — wire a button to bump volume up / down
// (auto-repeat while held) or toggle mute.
//
// Hold-to-repeat: recursive setTimeout loop guarded by `isPressed`, so a
// slow setVolume() never overlaps with the next tick and a key-up stops
// the loop on the next iteration. Pattern ported from the user's
// stream-deck-volume project (src/actions/volumeUp.ts).

type Operation = 'vol-up' | 'vol-down' | 'mute-toggle';

type Settings = {
  op?: Operation;
};

type KeyActLike = {
  id: string;
  setTitle: (t: string) => Promise<void>;
};

const VOL_MAX = 1.5;                  // matches spyService clamp (0–150%)
const VOL_MIN = 0;
const REPEAT_INTERVAL_MS = 80;        // ~12 steps/sec while held

// C-curve step (ratio in PERCENT POINTS, then divided by 100 for the
// 0..1.5 spyService scale). At low volume the step is large (MAX_STEP),
// at high volume it's small (MIN_STEP) — gives a hardware-knob feel
// where you ramp up fast from zero, then fine-tune at the top. Constants
// match the stream-deck-volume project.
const STEP_MIN_PCT = 1;
const STEP_MAX_PCT = 8;
const STEP_GAMMA = 1.5;

function calcStepPct(volPct: number): number {
  const v = Math.max(0, Math.min(150, volPct)) / 150;        // normalise 0..1
  const ratio = Math.pow(1 - v, STEP_GAMMA);                  // clog: low→1, high→0
  return Math.max(STEP_MIN_PCT, Math.round(STEP_MIN_PCT + (STEP_MAX_PCT - STEP_MIN_PCT) * ratio));
}

type CtxState = {
  act: KeyActLike;
  op: Operation;
  isPressed: boolean;
};

@action({ UUID: 'com.hogehoge.deck-rx.key-volume' })
export class KeyVolume extends SingletonAction<Settings> {
  private contexts = new Map<string, CtxState>();
  private volListener: ((v: number, muted: boolean) => void) | null = null;

  override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
    const act = ev.action as unknown as KeyActLike;
    const op = normaliseOp(ev.payload.settings.op);
    this.contexts.set(act.id, { act, op, isPressed: false });
    if (!this.volListener) {
      this.volListener = (v, muted) => this.refreshAll(v, muted);
      spyService.subscribeVolume(this.volListener);
    }
    spyService.connect().catch(() => {});
    await this.refreshTitle(act, op, spyService.getVolume(), spyService.isMuted());
  }

  override onWillDisappear(ev: WillDisappearEvent<Settings>): void {
    const id = (ev.action as unknown as KeyActLike).id;
    const ctx = this.contexts.get(id);
    if (ctx) ctx.isPressed = false;       // halt any in-flight repeat loop
    this.contexts.delete(id);
    if (this.contexts.size === 0 && this.volListener) {
      spyService.unsubscribeVolume(this.volListener);
      this.volListener = null;
    }
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): Promise<void> {
    const act = ev.action as unknown as KeyActLike;
    const ctx = this.contexts.get(act.id);
    if (!ctx) return;
    ctx.op = normaliseOp(ev.payload.settings.op);
    await this.refreshTitle(act, ctx.op, spyService.getVolume(), spyService.isMuted());
  }

  override onKeyDown(ev: KeyDownEvent<Settings>): void {
    const id = (ev.action as unknown as KeyActLike).id;
    const ctx = this.contexts.get(id);
    if (!ctx) return;
    // Re-read op from event payload — onDidReceiveSettings may not have
    // fired yet if the user just changed PI and pressed immediately.
    ctx.op = normaliseOp(ev.payload.settings.op);
    if (ctx.op === 'mute-toggle') {
      spyService.setMuted(!spyService.isMuted());
      return;
    }
    if (ctx.isPressed) return;            // already looping (shouldn't happen)
    ctx.isPressed = true;
    this.loop(ctx);
  }

  override onKeyUp(ev: KeyUpEvent<Settings>): void {
    const id = (ev.action as unknown as KeyActLike).id;
    const ctx = this.contexts.get(id);
    if (!ctx) return;
    ctx.isPressed = false;                // loop self-terminates on next check
  }

  // Recursive setTimeout instead of setInterval so a slow setVolume()
  // never overlaps with the next tick. isPressed is rechecked twice
  // (entry + after the apply) so a key-up arriving mid-step stops the
  // chain immediately on the next iteration.
  private loop(ctx: CtxState): void {
    if (!ctx.isPressed) return;
    this.applyStep(ctx);
    if (!ctx.isPressed) return;
    setTimeout(() => this.loop(ctx), REPEAT_INTERVAL_MS);
  }

  private applyStep(ctx: CtxState): void {
    if (ctx.op === 'mute-toggle') return;
    const cur = spyService.getVolume();
    const curPct = cur * 100;
    const stepPct = calcStepPct(curPct);
    const delta = (ctx.op === 'vol-up' ? +stepPct : -stepPct) / 100;
    const next = Math.max(VOL_MIN, Math.min(VOL_MAX, cur + delta));
    if (Math.abs(next - cur) < 1e-6) {
      ctx.isPressed = false;              // hit min/max → stop repeat
      return;
    }
    spyService.setVolume(next);
  }

  private refreshAll(v: number, muted: boolean): void {
    for (const ctx of this.contexts.values()) {
      this.refreshTitle(ctx.act, ctx.op, v, muted).catch(() => {});
    }
  }

  private async refreshTitle(act: KeyActLike, op: Operation, v: number, muted: boolean): Promise<void> {
    await act.setTitle(formatTitle(op, v, muted));
  }
}

function normaliseOp(raw: Operation | undefined): Operation {
  return raw === 'vol-down' || raw === 'mute-toggle' ? raw : 'vol-up';
}

function formatTitle(op: Operation, v: number, muted: boolean): string {
  const pct = Math.round(v * 100);
  switch (op) {
    case 'vol-up':      return `Vol +\n${pct}%${muted ? ' (M)' : ''}`;
    case 'vol-down':    return `Vol −\n${pct}%${muted ? ' (M)' : ''}`;
    case 'mute-toggle': return muted ? `Mute\nON` : `Mute\nOFF`;
  }
}
