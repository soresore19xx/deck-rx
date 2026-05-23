import {
  action, SingletonAction,
  WillAppearEvent, WillDisappearEvent, DidReceiveSettingsEvent,
  KeyDownEvent,
} from '@elgato/streamdeck';
import { fftLcdx2Bus, getFftLcdx2Controller, type FftLcdx2BusState } from './spyDialFftLcdx2.js';

// Companion Key (button) action for the LCDX2 FFT dial. LCDX2 mode hands
// both LCDs to the spectrum, so there's no room for on-LCD operation
// indicators — this action lets the user wire a button on the same page
// to drive mode / fftSize / zoom / axis from outside the LCD.
//
// A single PI dropdown chooses what this button does, so the user can
// place the same action multiple times and configure each one's role
// independently (e.g. one for Mode, one for FFT Size, two for ±Zoom).

type Operation =
  | 'cycle-mode'
  | 'cycle-fftSize'
  | 'reset-h-zoom'
  | 'reset-v-zoom'
  | 'toggle-axis'
  | 'zoom-in'
  | 'zoom-out';

type Settings = {
  op?: Operation;
};

type KeyActLike = {
  id: string;
  setTitle: (t: string) => Promise<void>;
};

@action({ UUID: 'com.hogehoge.deck-rx.key-fft-lcdx2-ctrl' })
export class KeyFftLcdx2Ctrl extends SingletonAction<Settings> {
  private contexts = new Map<string, { act: KeyActLike; op: Operation }>();
  private busListener: ((s: FftLcdx2BusState) => void) | null = null;

  override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
    const act = ev.action as unknown as KeyActLike;
    const op = normaliseOp(ev.payload.settings.op);
    this.contexts.set(act.id, { act, op });
    // One bus subscription for the whole class; fans out to every visible
    // key on every state change.
    if (!this.busListener) {
      this.busListener = (s) => this.refreshAllTitles(s);
      fftLcdx2Bus.on('change', this.busListener);
    }
    await this.refreshTitle(act, op, fftLcdx2Bus.lastState);
  }

  override onWillDisappear(ev: WillDisappearEvent<Settings>): void {
    const id = (ev.action as unknown as KeyActLike).id;
    this.contexts.delete(id);
    if (this.contexts.size === 0 && this.busListener) {
      fftLcdx2Bus.off('change', this.busListener);
      this.busListener = null;
    }
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): Promise<void> {
    const act = ev.action as unknown as KeyActLike;
    const ctx = this.contexts.get(act.id);
    if (!ctx) return;
    ctx.op = normaliseOp(ev.payload.settings.op);
    await this.refreshTitle(act, ctx.op, fftLcdx2Bus.lastState);
  }

  override onKeyDown(ev: KeyDownEvent<Settings>): void {
    const op = normaliseOp(ev.payload.settings.op);
    const ctrl = getFftLcdx2Controller();
    if (!ctrl) return;                      // no LCDX2 dial placed → nothing to do
    switch (op) {
      case 'cycle-mode':    ctrl.cycleAllLcdMode(); break;
      case 'cycle-fftSize': ctrl.cycleAllFftSize(); break;
      case 'reset-h-zoom':  ctrl.resetAllZoom('h'); break;
      case 'reset-v-zoom':  ctrl.resetAllZoom('v'); break;
      case 'toggle-axis':   ctrl.toggleAllAxis(); break;
      case 'zoom-in':       ctrl.zoomAll(1); break;
      case 'zoom-out':      ctrl.zoomAll(-1); break;
    }
  }

  private refreshAllTitles(s: FftLcdx2BusState | null): void {
    for (const ctx of this.contexts.values()) {
      this.refreshTitle(ctx.act, ctx.op, s).catch(() => {});
    }
  }

  private async refreshTitle(act: KeyActLike, op: Operation, s: FftLcdx2BusState | null): Promise<void> {
    await act.setTitle(formatTitle(op, s));
  }
}

function normaliseOp(raw: Operation | undefined): Operation {
  const allowed: Operation[] = ['cycle-mode', 'cycle-fftSize', 'reset-h-zoom', 'reset-v-zoom', 'toggle-axis', 'zoom-in', 'zoom-out'];
  return (raw && allowed.includes(raw)) ? raw : 'cycle-mode';
}

function formatTitle(op: Operation, s: FftLcdx2BusState | null): string {
  switch (op) {
    case 'cycle-mode': {
      const m = s?.lcdMode;
      const label = m === 'single' ? 'LCDX1' : m === 'wide' ? 'Wide' : m === 'detail' ? 'Detail' : '—';
      return `Mode\n${label}`;
    }
    case 'cycle-fftSize':
      return s ? `FFT\nN${s.fftSize}` : 'FFT\nN—';
    case 'reset-h-zoom':
      return 'Reset\nH zoom';
    case 'reset-v-zoom':
      return 'Reset\nV zoom';
    case 'toggle-axis':
      return s ? `Axis\n${s.axisMode === 'h' ? 'H' : 'V'}` : 'Axis\n—';
    case 'zoom-in':
      return 'Zoom\n+';
    case 'zoom-out':
      return 'Zoom\n−';
  }
}
