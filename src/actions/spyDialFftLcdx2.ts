import {
  action, SingletonAction,
  WillAppearEvent, WillDisappearEvent, DidReceiveSettingsEvent,
  DialRotateEvent, DialDownEvent, DialUpEvent, TouchTapEvent,
} from '@elgato/streamdeck';
import streamDeck from '@elgato/streamdeck';
import { EventEmitter } from 'events';
import { spyService } from '../spyService.js';
import { dumpAndB64 } from '../dialDisplay.js';
import { FftPipeline } from '../fft.js';

// Snapshot of the per-pair display state — emitted on the controller bus
// whenever any LCDX2 dial state mutates, so companion Key actions can
// refresh their titles without polling.
export type FftLcdx2BusState = {
  lcdMode: 'single' | 'wide' | 'detail';
  fftSize: number;
  axisMode: 'h' | 'v';
  zoomIndex: number;
  vZoomIndex: number;
};

class FftLcdx2Bus extends EventEmitter {
  lastState: FftLcdx2BusState | null = null;
  publish(s: FftLcdx2BusState): void { this.lastState = s; this.emit('change', s); }
}

// Module-level singleton bus shared between the dial action and any Key
// actions that want to drive it or display its state.
export const fftLcdx2Bus = new FftLcdx2Bus();

// Captured reference to the live dial-action instance so Key actions can
// invoke its public command methods. There is at most one instance per
// plugin process (SingletonAction contract).
let activeDialInstance: SpyDialFftLcdx2 | null = null;

export function getFftLcdx2Controller(): SpyDialFftLcdx2 | null {
  return activeDialInstance;
}

// Companion to SpyDialFft (LCDX1). LCDX2 pairs two adjacent placements on
// the same row, splitting one continuous spectrum view across both LCDs.
//   wide   → effective span × 2 (clamped by IQ rate), per-Hz density preserved
//   detail → span unchanged, per-Hz density × 2 (split across 2 LCDs)
// Pair must be MUTUAL — both dials must see each other as their sole
// adjacent same-mode candidate. A 3-in-a-row arrangement makes none pair;
// remove one to recover.
//
// When unpaired (only one placed, or sandwiched, or sibling has different
// mode), this action falls back to single-LCD rendering so the dial still
// shows the spectrum — it just doesn't form the LCDX2 view.

type AxisMode = 'h' | 'v';
type LcdMode = 'single' | 'wide' | 'detail';
type PanelRole = 'single' | 'left' | 'right';

type Settings = {
  frameRate?: number;
  smoothing?: number;
  fftSize?: number;
  dbFloor?: number;
  dbCeil?: number;
  zoomIndex?: number;
  vZoomIndex?: number;
  axisMode?: AxisMode;
  lcdMode?: LcdMode;
};

const ZOOM_STEPS = [
  1, 1.25, 1.5, 1.75,
  2, 2.25, 2.5, 2.75,
  3, 3.5,
  4, 4.5, 5, 5.5,
  6, 7, 8, 9, 10,
  12, 14, 16,
  20, 24, 28, 32,
] as const;

const V_ZOOM_FACTORS = [
  0.4, 0.5, 0.6, 0.7, 0.8, 0.9,
  1.0,
  1.15, 1.3, 1.5, 1.7, 2.0,
] as const;
const V_ZOOM_DEFAULT_INDEX = V_ZOOM_FACTORS.indexOf(1.0);

// FFT sizes exposed via the long-touch dial-side cycle. Must match the
// values listed in the PI dropdown. Order = cycle order.
const FFT_SIZES = [256, 512, 1024, 2048, 4096, 8192, 16384] as const;

const LONG_PRESS_MS = 600;

const LCD_W = 200;
const LCD_H = 100;
const HEADER_H = 14;
const PLOT_TOP = HEADER_H;
const PLOT_BOTTOM = LCD_H;
const PLOT_H = PLOT_BOTTOM - PLOT_TOP;

function fmtFreq(hz: number): string {
  if (hz >= 1_000_000) return (hz / 1_000_000).toFixed(3) + ' MHz';
  if (hz >= 1_000)     return (hz / 1_000).toFixed(1)   + ' kHz';
  return `${hz} Hz`;
}

type ActionLike = {
  id: string;
  setFeedback: (f: Record<string, unknown>) => Promise<void>;
  setSettings: (s: Settings) => Promise<void>;
};

type CtxState = {
  act: ActionLike;
  col: number;
  row: number;
  fft: FftPipeline | null;
  fftSize: number;
  frameRate: number;
  smoothing: number;
  dbFloor: number;
  dbCeil: number;
  zoomIndex: number;
  vZoomIndex: number;
  axisMode: AxisMode;
  lcdMode: LcdMode;
  longPressTimer: ReturnType<typeof setTimeout> | null;
  longPressFired: boolean;
  latestBins: Float32Array | null;
  latestIqRate: number;
  latestFreq: number;
  // Sliding IQ accumulator: SpyServer sends ~4 k-sample chunks, but the
  // user can request fftSize up to 16 k. We concat incoming chunks and
  // keep the most recent 2N samples (= 8N bytes); FftPipeline.process()
  // then uses the last N. Reset on fftSize change.
  accumBuf: Buffer;
  iqListener: ((iq: Buffer, iqRate: number, freq: number) => void) | null;
  connStateListener: ((c: boolean) => void) | null;
  connected: boolean;
  renderTimer: ReturnType<typeof setInterval> | null;
};

@action({ UUID: 'com.hogehoge.deck-rx.dial-fft-lcdx2' })
export class SpyDialFftLcdx2 extends SingletonAction<Settings> {
  private states = new Map<string, CtxState>();

  constructor() {
    super();
    activeDialInstance = this;
  }

  // Snapshot the first instance's state for the controller bus. Paired
  // panels are auto-synced, so any instance's values are representative.
  private publishState(): void {
    const first = this.states.values().next().value as CtxState | undefined;
    if (!first) return;
    fftLcdx2Bus.publish({
      lcdMode: first.lcdMode,
      fftSize: first.fftSize,
      axisMode: first.axisMode,
      zoomIndex: first.zoomIndex,
      vZoomIndex: first.vZoomIndex,
    });
  }

  // ─── Public command methods, called by companion Key actions ─────────
  // All operate across ALL placed instances; per-pair sibling sync inside
  // applyToSibling keeps each pair's two halves consistent.

  cycleAllLcdMode(): void {
    const states = Array.from(this.states.values());
    if (states.length === 0) return;
    const cur = states[0].lcdMode;
    const next: LcdMode = cur === 'single' ? 'wide' : cur === 'wide' ? 'detail' : 'single';
    for (const st of states) {
      st.lcdMode = next;
      st.act.setSettings(buildSettings(st)).catch(() => {});
      this.render(st);
    }
    this.renderAllOthers(states[0]);   // pair (re)formation refresh
    this.publishState();
  }

  cycleAllFftSize(): void {
    const states = Array.from(this.states.values());
    if (states.length === 0) return;
    const idx = FFT_SIZES.indexOf(states[0].fftSize);
    const next = FFT_SIZES[(idx + 1) % FFT_SIZES.length] ?? 512;
    for (const st of states) {
      if (st.fftSize === next) continue;
      st.fftSize = next;
      st.fft = new FftPipeline(next);
      st.latestBins = null;
      st.accumBuf = Buffer.alloc(0);
      st.act.setSettings(buildSettings(st)).catch(() => {});
      this.render(st);
    }
    this.publishState();
  }

  resetAllZoom(axis: AxisMode): void {
    for (const st of this.states.values()) {
      if (axis === 'v') {
        if (st.vZoomIndex === V_ZOOM_DEFAULT_INDEX) continue;
        st.vZoomIndex = V_ZOOM_DEFAULT_INDEX;
      } else {
        if (st.zoomIndex === 0) continue;
        st.zoomIndex = 0;
      }
      st.act.setSettings(buildSettings(st)).catch(() => {});
      this.render(st);
    }
    this.publishState();
  }

  toggleAllAxis(): void {
    const states = Array.from(this.states.values());
    if (states.length === 0) return;
    const next: AxisMode = states[0].axisMode === 'h' ? 'v' : 'h';
    for (const st of states) {
      st.axisMode = next;
      st.act.setSettings(buildSettings(st)).catch(() => {});
      this.render(st);
    }
    this.publishState();
  }

  zoomAll(direction: 1 | -1): void {
    for (const st of this.states.values()) {
      if (st.axisMode === 'v') {
        // Higher vZoom index = wider window = zoomed OUT, so +direction
        // means "zoom in" via index DECREMENT (matches dial rotate feel).
        const next = Math.max(0, Math.min(V_ZOOM_FACTORS.length - 1, st.vZoomIndex - direction));
        if (next === st.vZoomIndex) continue;
        st.vZoomIndex = next;
      } else {
        const next = Math.max(0, Math.min(ZOOM_STEPS.length - 1, st.zoomIndex + direction));
        if (next === st.zoomIndex) continue;
        st.zoomIndex = next;
      }
      st.act.setSettings(buildSettings(st)).catch(() => {});
      this.render(st);
    }
    this.publishState();
  }

  override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
    const act = ev.action as unknown as ActionLike;
    const coords = (ev.action as unknown as { coordinates?: { column: number; row: number } }).coordinates
      ?? (ev.payload as unknown as { coordinates?: { column: number; row: number } }).coordinates;
    const st: CtxState = {
      act,
      col: coords?.column ?? -1,
      row: coords?.row ?? -1,
      fft: null,
      fftSize: 512,
      frameRate: 16,
      smoothing: 16,
      dbFloor: -110,
      dbCeil: -20,
      zoomIndex: 0,
      vZoomIndex: V_ZOOM_DEFAULT_INDEX,
      axisMode: 'h',
      lcdMode: 'single',
      longPressTimer: null,
      longPressFired: false,
      latestBins: null,
      latestIqRate: 0,
      latestFreq: 0,
      accumBuf: Buffer.alloc(0),
      iqListener: null,
      connStateListener: null,
      connected: spyService.isConnected(),
      renderTimer: null,
    };
    this.states.set(act.id, st);
    this.applySettings(st, ev.payload.settings);
    st.iqListener = (iq, iqRate, freq) => {
      if (!st.fft) return;
      // Accumulate so FFT sizes that exceed a single SpyServer chunk still
      // collect enough samples. Cap at 2N to bound memory; process() uses
      // only the most recent N samples regardless of buffer length.
      const maxBytes = st.fftSize * 4 * 2;
      const combined = st.accumBuf.length === 0 ? iq : Buffer.concat([st.accumBuf, iq]);
      st.accumBuf = combined.length > maxBytes ? combined.subarray(combined.length - maxBytes) : combined;
      const bins = st.fft.process(st.accumBuf, st.smoothing);
      if (!bins) return;
      st.latestBins = bins;
      st.latestIqRate = iqRate;
      st.latestFreq = freq;
    };
    spyService.subscribeIqStream(st.iqListener);
    st.connStateListener = (c) => {
      st.connected = c;
      st.fft?.resetSmoothing();
      st.latestBins = null;
      this.render(st);
    };
    spyService.subscribeConnectionState(st.connStateListener);
    spyService.connect().catch((e) => streamDeck.logger.error(`[spyDialFftLcdx2] ${e}`));
    this.startRenderTimer(st);
    this.render(st);
    // Pair formation may have changed — re-render sibling immediately so the
    // VFO crosshair / header layout switches over without a frame delay.
    this.renderAllOthers(st);
    this.publishState();
  }

  override onWillDisappear(ev: WillDisappearEvent<Settings>): void {
    const id = (ev.action as unknown as ActionLike).id;
    const st = this.states.get(id);
    if (!st) return;
    if (st.iqListener) spyService.unsubscribeIqStream(st.iqListener);
    if (st.connStateListener) spyService.unsubscribeConnectionState(st.connStateListener);
    if (st.renderTimer) clearInterval(st.renderTimer);
    if (st.longPressTimer) clearTimeout(st.longPressTimer);
    this.states.delete(id);
    this.renderAllOthers(st);
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): void {
    const st = this.states.get((ev.action as unknown as ActionLike).id);
    if (!st) return;
    // Capture sibling BEFORE applying — an lcdMode change in the new settings
    // may break pairing, but we still want to propagate the change to the
    // peer that WAS paired so both panels move together.
    const sibBefore = this.findSibling(st);
    const prevSnapshot = buildSettings(st);
    const prevLcdMode = st.lcdMode;
    this.applySettings(st, ev.payload.settings);
    this.startRenderTimer(st);
    this.render(st);
    if (st.lcdMode !== prevLcdMode) this.renderAllOthers(st);
    // Diff PI changes against the pre-mutation snapshot, push the delta to
    // the previously-paired sibling. The sibling's own onDidReceiveSettings
    // will then no-op (its state already matches what we wrote) so this does
    // not create a feedback loop.
    const currSnapshot = buildSettings(st);
    const diff: Partial<Settings> = {};
    for (const key of Object.keys(currSnapshot) as Array<keyof Settings>) {
      if (currSnapshot[key] !== prevSnapshot[key]) (diff as Record<string, unknown>)[key] = currSnapshot[key];
    }
    if (Object.keys(diff).length > 0) this.applyToSibling(sibBefore, diff);
    this.publishState();
  }

  override async onTouchTap(ev: TouchTapEvent<Settings>): Promise<void> {
    const st = this.states.get((ev.action as unknown as ActionLike).id);
    if (!st) return;
    if (ev.payload.hold) {
      // Long touch — cycle FFT size forward (resolution switch from the
      // dial, no PI round-trip). Wraps after the largest size. Synced to
      // sibling so paired panels stay in lockstep.
      const idx = FFT_SIZES.indexOf(st.fftSize);
      const next = FFT_SIZES[(idx + 1) % FFT_SIZES.length] ?? 512;
      const sibBefore = this.findSibling(st);
      st.fftSize = next;
      st.fft = new FftPipeline(next);
      st.latestBins = null;
      st.accumBuf = Buffer.alloc(0);
      const patch: Partial<Settings> = { fftSize: next };
      await ev.action.setSettings({ ...ev.payload.settings, ...patch });
      this.applyToSibling(sibBefore, patch);
      this.render(st);
      this.publishState();
      return;
    }
    // Short tap — cycle LCDX1 (single) → LCDX2 Wide → LCDX2 Detail → LCDX1 …
    // Faster than opening the PI when the user wants to A/B-compare modes.
    const sibBefore = this.findSibling(st);
    const next: LcdMode = st.lcdMode === 'single' ? 'wide'
                        : st.lcdMode === 'wide'   ? 'detail'
                                                  : 'single';
    st.lcdMode = next;
    const patch: Partial<Settings> = { lcdMode: next };
    await ev.action.setSettings({ ...ev.payload.settings, ...patch });
    this.applyToSibling(sibBefore, patch);
    this.render(st);
    // Pair may have formed (single→wide on both) or broken (→single) — refresh
    // everyone so the VFO crosshair / header layout switch over immediately.
    this.renderAllOthers(st);
    this.publishState();
  }

  private applySettings(st: CtxState, s: Settings): void {
    const fr = clampInt(s.frameRate ?? 16, 1, 120);
    const sm = clampInt(s.smoothing ?? 16, 1, 64);
    const fz = nearestPow2(clampInt(s.fftSize ?? 512, 64, 16384));
    const floor = clampInt(s.dbFloor ?? -110, -160, -20);
    const ceil  = clampInt(s.dbCeil  ?? -20,  -60,  0);
    st.frameRate = fr;
    st.smoothing = sm;
    st.dbFloor = floor;
    st.dbCeil = Math.max(ceil, floor + 10);
    st.zoomIndex = clampInt(s.zoomIndex ?? 0, 0, ZOOM_STEPS.length - 1);
    st.vZoomIndex = clampInt(s.vZoomIndex ?? V_ZOOM_DEFAULT_INDEX, 0, V_ZOOM_FACTORS.length - 1);
    st.axisMode = s.axisMode === 'v' ? 'v' : 'h';
    st.lcdMode = (s.lcdMode === 'wide' || s.lcdMode === 'detail') ? s.lcdMode : 'single';
    if (fz !== st.fftSize || !st.fft) {
      st.fftSize = fz;
      st.fft = new FftPipeline(fz);
      st.latestBins = null;
      st.accumBuf = Buffer.alloc(0);     // restart accumulation for new N
    }
  }

  override async onDialRotate(ev: DialRotateEvent<Settings>): Promise<void> {
    const st = this.states.get((ev.action as unknown as ActionLike).id);
    if (!st) return;
    const ticks = ev.payload.ticks;
    let changed: Partial<Settings> | null = null;
    if (st.axisMode === 'v') {
      const next = Math.max(0, Math.min(V_ZOOM_FACTORS.length - 1, st.vZoomIndex - ticks));
      if (next !== st.vZoomIndex) {
        st.vZoomIndex = next;
        changed = { vZoomIndex: next };
      }
    } else {
      const next = Math.max(0, Math.min(ZOOM_STEPS.length - 1, st.zoomIndex + ticks));
      if (next !== st.zoomIndex) {
        st.zoomIndex = next;
        changed = { zoomIndex: next };
      }
    }
    if (!changed) return;
    await ev.action.setSettings({ ...ev.payload.settings, ...changed });
    this.syncToSibling(st, changed);
    this.render(st);
    this.publishState();
  }

  override onDialDown(ev: DialDownEvent<Settings>): void {
    const st = this.states.get((ev.action as unknown as ActionLike).id);
    if (!st) return;
    st.longPressFired = false;
    if (st.longPressTimer) clearTimeout(st.longPressTimer);
    st.longPressTimer = setTimeout(() => {
      st.longPressTimer = null;
      st.longPressFired = true;
      st.axisMode = st.axisMode === 'h' ? 'v' : 'h';
      const patch: Partial<Settings> = { axisMode: st.axisMode };
      ev.action.setSettings({ ...ev.payload.settings, ...patch }).catch(() => {});
      this.syncToSibling(st, patch);
      this.render(st);
      this.publishState();
    }, LONG_PRESS_MS);
  }

  override async onDialUp(ev: DialUpEvent<Settings>): Promise<void> {
    const st = this.states.get((ev.action as unknown as ActionLike).id);
    if (!st) return;
    if (st.longPressTimer) {
      clearTimeout(st.longPressTimer);
      st.longPressTimer = null;
    }
    if (st.longPressFired) return;
    let patch: Partial<Settings> | null = null;
    if (st.axisMode === 'v') {
      if (st.vZoomIndex !== V_ZOOM_DEFAULT_INDEX) {
        st.vZoomIndex = V_ZOOM_DEFAULT_INDEX;
        patch = { vZoomIndex: V_ZOOM_DEFAULT_INDEX };
      }
    } else {
      if (st.zoomIndex !== 0) {
        st.zoomIndex = 0;
        patch = { zoomIndex: 0 };
      }
    }
    if (!patch) return;
    await ev.action.setSettings({ ...ev.payload.settings, ...patch });
    this.syncToSibling(st, patch);
    this.render(st);
    this.publishState();
  }

  private startRenderTimer(st: CtxState): void {
    if (st.renderTimer) { clearInterval(st.renderTimer); st.renderTimer = null; }
    const intervalMs = Math.max(8, Math.round(1000 / st.frameRate));
    st.renderTimer = setInterval(() => this.render(st), intervalMs);
  }

  private findSibling(st: CtxState): CtxState | null {
    if (st.lcdMode === 'single') return null;
    if (st.col < 0 || st.row < 0) return null;
    const candidates: CtxState[] = [];
    for (const other of this.states.values()) {
      if (other === st) continue;
      if (other.row !== st.row || other.lcdMode !== st.lcdMode) continue;
      if (other.col === st.col - 1 || other.col === st.col + 1) candidates.push(other);
    }
    if (candidates.length !== 1) return null;
    const sib = candidates[0];
    let sibCandidates = 0;
    for (const other of this.states.values()) {
      if (other === sib) continue;
      if (other.row !== sib.row || other.lcdMode !== sib.lcdMode) continue;
      if (other.col === sib.col - 1 || other.col === sib.col + 1) sibCandidates++;
    }
    return sibCandidates === 1 ? sib : null;
  }

  private resolveRole(st: CtxState): PanelRole {
    const sib = this.findSibling(st);
    if (!sib) return 'single';
    return sib.col < st.col ? 'right' : 'left';
  }

  // Wrapper used by dial handlers whose changes never affect pairing — find
  // sibling at call time. For lcdMode-mutating handlers, capture the sibling
  // BEFORE the mutation and call applyToSibling directly.
  private syncToSibling(st: CtxState, patch: Partial<Settings>): void {
    this.applyToSibling(this.findSibling(st), patch);
  }

  // Apply a settings patch to a (possibly previously-captured) paired sibling
  // so the two panels share scale, smoothing, mode, etc. The loop prevention
  // is structural: applyToSibling only writes to fields whose value differs,
  // and the resulting setSettings echo back through Stream Deck App fires
  // onDidReceiveSettings on the sibling — which then computes an empty diff
  // (state already matches) and propagates nothing.
  private applyToSibling(sib: CtxState | null, patch: Partial<Settings>): void {
    if (!sib) return;
    let changed = false;
    let timerReset = false;
    if (patch.zoomIndex  !== undefined && sib.zoomIndex  !== patch.zoomIndex)  { sib.zoomIndex  = patch.zoomIndex;  changed = true; }
    if (patch.vZoomIndex !== undefined && sib.vZoomIndex !== patch.vZoomIndex) { sib.vZoomIndex = patch.vZoomIndex; changed = true; }
    if (patch.axisMode   !== undefined && sib.axisMode   !== patch.axisMode)   { sib.axisMode   = patch.axisMode;   changed = true; }
    if (patch.frameRate  !== undefined && sib.frameRate  !== patch.frameRate)  { sib.frameRate  = patch.frameRate;  timerReset = true; changed = true; }
    if (patch.smoothing  !== undefined && sib.smoothing  !== patch.smoothing)  { sib.smoothing  = patch.smoothing;  changed = true; }
    if (patch.dbFloor    !== undefined && sib.dbFloor    !== patch.dbFloor)    { sib.dbFloor    = patch.dbFloor;    changed = true; }
    if (patch.dbCeil     !== undefined && sib.dbCeil     !== patch.dbCeil)     { sib.dbCeil     = patch.dbCeil;     changed = true; }
    if (patch.fftSize    !== undefined && sib.fftSize    !== patch.fftSize) {
      sib.fftSize = patch.fftSize;
      sib.fft = new FftPipeline(patch.fftSize);
      sib.latestBins = null;
      sib.accumBuf = Buffer.alloc(0);
      changed = true;
    }
    if (patch.lcdMode    !== undefined && sib.lcdMode    !== patch.lcdMode)    { sib.lcdMode    = patch.lcdMode;    changed = true; }
    if (!changed) return;
    if (timerReset) this.startRenderTimer(sib);
    sib.act.setSettings(buildSettings(sib)).catch(() => {});
    this.render(sib);
  }

  private renderAllOthers(skip: CtxState): void {
    for (const other of this.states.values()) {
      if (other === skip) continue;
      this.render(other);
    }
  }

  private render(st: CtxState): void {
    if (!st.act) return;
    const svg = this.renderSvg(st);
    // Role-specific dump tag so paired panels (left + right) write to
    // separate /tmp/deck-rx-lcd-<tag>.svg files. Single (unpaired) mode
    // uses its own tag so it doesn't clobber paired captures either.
    const role = this.resolveRole(st);
    st.act.setFeedback({
      'fft-display': dumpAndB64(`fft-lcdx2-${role}`, svg),
    }).catch(() => {});
  }

  private renderSvg(st: CtxState): string {
    const role = this.resolveRole(st);
    const bins = st.latestBins;
    const iqRate = st.latestIqRate || spyService.getCurrentIQRate();
    const freq = st.latestFreq || spyService.currentFreq;
    const baseFloor = st.dbFloor;
    const baseCeil = st.dbCeil;
    const mid = (baseFloor + baseCeil) / 2;
    const halfBase = (baseCeil - baseFloor) / 2;
    const vFactor = V_ZOOM_FACTORS[st.vZoomIndex] ?? 1;
    const half = halfBase * vFactor;
    const floor = mid - half;
    const ceil = mid + half;
    const range = ceil - floor;

    const zoom = ZOOM_STEPS[st.zoomIndex] ?? 1;

    // Total span / bin count across the (possibly paired) display.
    //   wide   → span = min(iqRate / zoom × 2, iqRate)
    //   detail → span = iqRate / zoom
    //   unpaired (role='single') → span = iqRate / zoom (LCDX1-like fallback)
    let totalSpan = 0;
    let totalVisibleBins = 0;
    if (bins && iqRate > 0) {
      const N = bins.length;
      if (st.lcdMode === 'wide' && role !== 'single') {
        totalSpan = Math.min(iqRate, iqRate / zoom * 2);
        totalVisibleBins = Math.min(N, Math.max(2, Math.round((N / zoom) * 2)));
      } else {
        totalSpan = iqRate / zoom;
        totalVisibleBins = Math.max(2, Math.round(N / zoom));
      }
    }

    let out = `<rect width="${LCD_W}" height="${LCD_H}" fill="#000000"/>`;

    for (let db = Math.ceil(floor / 20) * 20; db <= ceil; db += 20) {
      const y = mapDbToY(db, floor, range);
      out += `<line x1="0" y1="${y.toFixed(1)}" x2="${LCD_W}" y2="${y.toFixed(1)}" stroke="#5e5e5e" stroke-width="1" stroke-dasharray="2 3"/>`;
    }
    // VFO crosshair: at panel boundary when paired (continuous across seam),
    // at centre when unpaired (single fallback).
    const vfoX = role === 'left' ? LCD_W - 0.5 : role === 'right' ? 0.5 : LCD_W / 2;
    out += `<line x1="${vfoX}" y1="${PLOT_TOP}" x2="${vfoX}" y2="${PLOT_BOTTOM}" stroke="#ff3333" stroke-width="1" opacity="0.4"/>`;

    if (bins && totalVisibleBins > 0 && st.connected) {
      const N = bins.length;
      const totalStart = Math.max(0, Math.floor((N - totalVisibleBins) / 2));
      const totalEnd = Math.min(N, totalStart + totalVisibleBins);
      let sliceStart: number, sliceEnd: number;
      if (role === 'left') {
        sliceStart = totalStart;
        sliceEnd = totalStart + Math.floor(totalVisibleBins / 2);
      } else if (role === 'right') {
        sliceStart = totalStart + Math.floor(totalVisibleBins / 2);
        sliceEnd = totalEnd;
      } else {
        sliceStart = totalStart;
        sliceEnd = totalEnd;
      }
      const visN = Math.max(2, sliceEnd - sliceStart);
      const pixHeights: number[] = new Array(LCD_W);
      const binsPerPixel = visN / LCD_W;
      if (binsPerPixel >= 1) {
        let lastEnd = sliceStart;
        for (let x = 0; x < LCD_W; x++) {
          const start = lastEnd;
          const end = Math.min(sliceEnd, sliceStart + Math.floor(((x + 1) * visN) / LCD_W));
          let maxDb = -Infinity;
          for (let k = start; k < end; k++) {
            if (bins[k] > maxDb) maxDb = bins[k];
          }
          if (!Number.isFinite(maxDb)) maxDb = bins[start] ?? floor;
          pixHeights[x] = maxDb;
          lastEnd = end;
        }
      } else {
        for (let x = 0; x < LCD_W; x++) {
          const f = sliceStart + (x + 0.5) * binsPerPixel;
          const k0 = Math.max(sliceStart, Math.min(sliceEnd - 1, Math.floor(f)));
          const k1 = Math.min(sliceEnd - 1, k0 + 1);
          const t = f - k0;
          pixHeights[x] = bins[k0] * (1 - t) + bins[k1] * t;
        }
      }
      const pts: string[] = [];
      pts.push(`0,${PLOT_BOTTOM}`);
      for (let x = 0; x < LCD_W; x++) {
        const y = mapDbToY(pixHeights[x], floor, range);
        pts.push(`${x},${y.toFixed(1)}`);
      }
      pts.push(`${LCD_W - 1},${PLOT_BOTTOM}`);
      out += `<polygon points="${pts.join(' ')}" fill="#14384a" fill-opacity="0.7" stroke="none"/>`;
      const lineSegs: string[] = [];
      for (let x = 0; x < LCD_W; x++) {
        const y = mapDbToY(pixHeights[x], floor, range);
        lineSegs.push(`${x === 0 ? 'M' : 'L'}${x},${y.toFixed(1)}`);
      }
      out += `<path d="${lineSegs.join(' ')}" stroke="#66c8e8" stroke-width="1" fill="none"/>`;
    } else {
      out += `<text x="${LCD_W / 2}" y="${LCD_H / 2 + 4}" fill="#666" font-family="monospace" font-size="11" text-anchor="middle">${st.connected ? 'waiting…' : 'OFFLINE'}</text>`;
    }

    // Header layout:
    //   left   → centre freq + mode tag (W/D)
    //   right  → [axis] + span/zoom
    //   single (unpaired) → all on one panel, plus a "[?]" marker so the
    //                       user can see the pair isn't formed
    const spanText = totalSpan > 0 ? `±${fmtFreq(totalSpan / 2)}` : '';
    const zoomTag = zoom > 1 ? ` ${formatZoom(zoom)}` : '';
    const vZoomTag = vFactor !== 1 ? ` v${formatZoom(vFactor)}` : '';
    const axisGlyph = st.axisMode === 'v' ? 'V' : 'H';
    const axisColor = st.axisMode === 'v' ? '#ff9933' : '#66ccff';
    const centerLabel = freq > 0 ? fmtFreq(freq) : '-';
    // mode tag in header:
    //   paired   → 'W' or 'D' depending on LCDX2 sub-mode
    //   unpaired but trying to pair (LCDX2 mode, no sibling) → '[?]'
    //   explicit LCDX1 (single mode)                          → no tag
    const modeTag = role !== 'single'
      ? (st.lcdMode === 'wide' ? ' W' : ' D')
      : (st.lcdMode !== 'single' ? ' [?]' : '');
    out += `<rect x="0" y="0" width="${LCD_W}" height="${HEADER_H}" fill="#000"/>`;
    if (role === 'single' || role === 'left') {
      out += `<text x="4" y="11" fill="#fff" font-family="monospace" font-size="11">${centerLabel}${modeTag}</text>`;
    }
    if (role === 'single' || role === 'right') {
      const axisX = role === 'single' ? LCD_W / 2 - 14 : 4;
      const axisAnchor = role === 'single' ? 'end' : 'start';
      out += `<text x="${axisX}" y="11" fill="${axisColor}" font-family="monospace" font-size="11" text-anchor="${axisAnchor}">[${axisGlyph}]</text>`;
      out += `<text x="${LCD_W - 4}" y="11" fill="#fff" font-family="monospace" font-size="11" text-anchor="end">${spanText}${zoomTag}${vZoomTag}</text>`;
    }
    out += `<text x="2" y="${LCD_H - 2}" fill="#444" font-family="monospace" font-size="8">${floor}</text>`;
    out += `<text x="2" y="${PLOT_TOP + 8}" fill="#444" font-family="monospace" font-size="8">${ceil}</text>`;
    // Current FFT size — bottom-right corner. Confirms the dial-side
    // long-touch cycle actually took effect without opening the PI.
    out += `<text x="${LCD_W - 2}" y="${LCD_H - 2}" fill="#666" font-family="monospace" font-size="8" text-anchor="end">N${st.fftSize}</text>`;

    // Outer frame. When paired, omit the seam-side edge so the two LCDs
    // read as one continuous panel — only the OUTER edges keep the rounded
    // corners; the inner (seam) edge is left fully open.
    if (role === 'left') {
      out += `<path d="M ${LCD_W} 0.5 H 4.5 A 4 4 0 0 0 0.5 4.5 V ${LCD_H - 4.5} A 4 4 0 0 0 4.5 ${LCD_H - 0.5} H ${LCD_W}" fill="none" stroke="#555" stroke-width="1"/>`;
    } else if (role === 'right') {
      out += `<path d="M 0 0.5 H ${LCD_W - 4.5} A 4 4 0 0 1 ${LCD_W - 0.5} 4.5 V ${LCD_H - 4.5} A 4 4 0 0 1 ${LCD_W - 4.5} ${LCD_H - 0.5} H 0" fill="none" stroke="#555" stroke-width="1"/>`;
    } else {
      out += `<rect x="0.5" y="0.5" width="${LCD_W - 1}" height="${LCD_H - 1}" rx="4" ry="4" fill="none" stroke="#555" stroke-width="1"/>`;
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${LCD_W}" height="${LCD_H}">${out}</svg>`;
  }
}

function buildSettings(st: CtxState): Settings {
  return {
    frameRate: st.frameRate,
    smoothing: st.smoothing,
    fftSize: st.fftSize,
    dbFloor: st.dbFloor,
    dbCeil: st.dbCeil,
    zoomIndex: st.zoomIndex,
    vZoomIndex: st.vZoomIndex,
    axisMode: st.axisMode,
    lcdMode: st.lcdMode,
  };
}

function mapDbToY(db: number, floor: number, range: number): number {
  if (range <= 0) return PLOT_BOTTOM;
  const norm = (db - floor) / range;
  const clamped = norm < 0 ? 0 : norm > 1 ? 1 : norm;
  return PLOT_BOTTOM - clamped * PLOT_H;
}

function clampInt(v: unknown, lo: number, hi: number): number {
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function nearestPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  if (p === n) return p;
  return (p - n) < (n - (p >> 1)) ? p : (p >> 1);
}

function formatZoom(z: number): string {
  if (Number.isInteger(z)) return z.toString() + 'x';
  return z.toFixed(2).replace(/\.?0+$/, '') + 'x';
}
