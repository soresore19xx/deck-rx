import {
  action, SingletonAction,
  WillAppearEvent, WillDisappearEvent, DidReceiveSettingsEvent,
  DialRotateEvent, DialDownEvent, DialUpEvent,
} from '@elgato/streamdeck';
import streamDeck from '@elgato/streamdeck';
import { spyService } from '../spyService.js';
import { dumpAndB64 } from '../dialDisplay.js';
import { FftPipeline } from '../fft.js';

type AxisMode = 'h' | 'v';

type Settings = {
  frameRate?: number;  // fps, default 16
  smoothing?: number;  // SDR++-style smoothing factor, default 16 (α = 1/16 per frame)
  fftSize?: number;    // power of 2, default 512
  dbFloor?: number;    // bottom of vertical scale (default -110)
  dbCeil?: number;     // top of vertical scale (default -20)
  zoomIndex?: number;  // index into ZOOM_STEPS, default 0 (1× = full IQ rate span)
  vZoomIndex?: number; // index into V_ZOOM_FACTORS, default V_ZOOM_DEFAULT_INDEX (= 1.0× of base range)
  axisMode?: AxisMode; // which axis the dial rotation drives — toggled by long press
};

// Display zoom — fraction of the IQ rate shown across the LCD width. 1× =
// full IQ rate (e.g. Airspy HF+ = 228 kHz). 32× = 1/32 of the rate (~7
// kHz on HF+, narrow enough to read individual SSB / CW carriers). Step
// density is finer near 1× (where the user is comparing adjacent stations)
// and coarser past 8× (where the FFT-size limit dominates anyway).
const ZOOM_STEPS = [
  1, 1.25, 1.5, 1.75,
  2, 2.25, 2.5, 2.75,
  3, 3.5,
  4, 4.5, 5, 5.5,
  6, 7, 8, 9, 10,
  12, 14, 16,
  20, 24, 28, 32,
] as const;

// Vertical zoom — multiplicative factor applied to the PI base dB range
// (dbCeil - dbFloor) around its midpoint. 1.0 = use PI settings unchanged.
// < 1.0 = narrower window (peaks fill more screen vertically). > 1.0 =
// wider window (more dynamic range visible, weaker signals readable).
const V_ZOOM_FACTORS = [
  0.4, 0.5, 0.6, 0.7, 0.8, 0.9,
  1.0,
  1.15, 1.3, 1.5, 1.7, 2.0,
] as const;
const V_ZOOM_DEFAULT_INDEX = V_ZOOM_FACTORS.indexOf(1.0);

const LONG_PRESS_MS = 600;

const LCD_W = 200;
const LCD_H = 100;
const HEADER_H = 12;
const PLOT_TOP = HEADER_H;
const PLOT_BOTTOM = LCD_H;
const PLOT_H = PLOT_BOTTOM - PLOT_TOP;

function fmtFreq(hz: number): string {
  if (hz >= 1_000_000) return (hz / 1_000_000).toFixed(3) + ' MHz';
  if (hz >= 1_000)     return (hz / 1_000).toFixed(1)   + ' kHz';
  return `${hz} Hz`;
}

@action({ UUID: 'com.hogehoge.deck-rx.dial-fft' })
export class SpyDialFft extends SingletonAction<Settings> {
  private act: { setFeedback: (f: Record<string, unknown>) => Promise<void> } | null = null;
  private fft: FftPipeline | null = null;
  private fftSize = 512;
  private frameRate = 16;
  private smoothing = 16;
  private dbFloor = -110;
  private dbCeil = -20;
  private zoomIndex = 0;
  private vZoomIndex = V_ZOOM_DEFAULT_INDEX;
  private axisMode: AxisMode = 'h';
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private longPressFired = false;
  // Latest power-spectrum (dBFS, fftshift'd). Filled by the IQ listener,
  // drained by the renderTimer at frame-rate cadence so we don't burn the
  // Stream Deck WebSocket at ~14 Hz packet rate.
  private latestBins: Float32Array | null = null;
  private latestIqRate = 0;
  private latestFreq = 0;
  private iqListener: ((iq: Buffer, iqRate: number, freq: number) => void) | null = null;
  private connStateListener: ((c: boolean) => void) | null = null;
  private connected = false;
  private renderTimer: ReturnType<typeof setInterval> | null = null;

  override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
    this.act = ev.action as unknown as typeof this.act;
    this.applySettings(ev.payload.settings);
    this.connected = spyService.isConnected();
    this.iqListener = (iq, iqRate, freq) => {
      if (!this.fft) return;
      const bins = this.fft.process(iq, this.smoothing);
      if (!bins) return;
      this.latestBins = bins;
      this.latestIqRate = iqRate;
      this.latestFreq = freq;
    };
    spyService.subscribeIqStream(this.iqListener);
    this.connStateListener = (c) => {
      this.connected = c;
      // Reset smoother so a fresh connection doesn't average across regimes.
      this.fft?.resetSmoothing();
      this.latestBins = null;
      this.render();
    };
    spyService.subscribeConnectionState(this.connStateListener);
    // Make sure the SpyServer connection is up; same pattern as the other dials.
    spyService.connect().catch((e) => streamDeck.logger.error(`[spyDialFft] ${e}`));
    this.startRenderTimer();
    this.render();
  }

  override onWillDisappear(_ev: WillDisappearEvent<Settings>): void {
    if (this.iqListener) {
      spyService.unsubscribeIqStream(this.iqListener);
      this.iqListener = null;
    }
    if (this.connStateListener) {
      spyService.unsubscribeConnectionState(this.connStateListener);
      this.connStateListener = null;
    }
    if (this.renderTimer) { clearInterval(this.renderTimer); this.renderTimer = null; }
    if (this.longPressTimer) { clearTimeout(this.longPressTimer); this.longPressTimer = null; }
    this.fft = null;
    this.latestBins = null;
    this.act = null;
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): void {
    this.applySettings(ev.payload.settings);
    this.startRenderTimer();
    this.render();
  }

  private applySettings(s: Settings): void {
    const fr = clampInt(s.frameRate ?? 16, 1, 120);
    const sm = clampInt(s.smoothing ?? 16, 1, 64);
    const fz = nearestPow2(clampInt(s.fftSize ?? 512, 64, 4096));
    const floor = clampInt(s.dbFloor ?? -110, -160, -20);
    const ceil  = clampInt(s.dbCeil  ?? -20,  -60,  0);
    this.frameRate = fr;
    this.smoothing = sm;
    this.dbFloor = floor;
    this.dbCeil = Math.max(ceil, floor + 10);
    this.zoomIndex = clampInt(s.zoomIndex ?? 0, 0, ZOOM_STEPS.length - 1);
    this.vZoomIndex = clampInt(s.vZoomIndex ?? V_ZOOM_DEFAULT_INDEX, 0, V_ZOOM_FACTORS.length - 1);
    this.axisMode = s.axisMode === 'v' ? 'v' : 'h';
    if (fz !== this.fftSize || !this.fft) {
      this.fftSize = fz;
      this.fft = new FftPipeline(fz);
      this.latestBins = null;
    }
  }

  override async onDialRotate(ev: DialRotateEvent<Settings>): Promise<void> {
    // CW (positive ticks) zooms in on the currently-active axis; CCW zooms
    // out. Tick accumulation lets a fast spin advance multiple steps.
    const ticks = ev.payload.ticks;
    if (this.axisMode === 'v') {
      // Higher index = wider range = zoomed out. CW (+ticks) = zoom in, so
      // we DECREMENT the index on positive ticks to match the H-axis feel.
      const next = Math.max(0, Math.min(V_ZOOM_FACTORS.length - 1, this.vZoomIndex - ticks));
      if (next === this.vZoomIndex) return;
      this.vZoomIndex = next;
      await ev.action.setSettings({ ...ev.payload.settings, vZoomIndex: next });
    } else {
      const next = Math.max(0, Math.min(ZOOM_STEPS.length - 1, this.zoomIndex + ticks));
      if (next === this.zoomIndex) return;
      this.zoomIndex = next;
      await ev.action.setSettings({ ...ev.payload.settings, zoomIndex: next });
    }
    this.render();
  }

  override onDialDown(ev: DialDownEvent<Settings>): void {
    // Long press (≥ LONG_PRESS_MS) toggles between H and V axis modes.
    // Short press resets the CURRENT axis's zoom to default.
    this.longPressFired = false;
    if (this.longPressTimer) clearTimeout(this.longPressTimer);
    this.longPressTimer = setTimeout(() => {
      this.longPressTimer = null;
      this.longPressFired = true;
      this.axisMode = this.axisMode === 'h' ? 'v' : 'h';
      ev.action.setSettings({ ...ev.payload.settings, axisMode: this.axisMode }).catch(() => {});
      this.render();
    }, LONG_PRESS_MS);
  }

  override async onDialUp(ev: DialUpEvent<Settings>): Promise<void> {
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
    if (this.longPressFired) return;     // mode toggle already fired
    // Short press — reset the active axis.
    if (this.axisMode === 'v') {
      if (this.vZoomIndex === V_ZOOM_DEFAULT_INDEX) return;
      this.vZoomIndex = V_ZOOM_DEFAULT_INDEX;
      await ev.action.setSettings({ ...ev.payload.settings, vZoomIndex: V_ZOOM_DEFAULT_INDEX });
    } else {
      if (this.zoomIndex === 0) return;
      this.zoomIndex = 0;
      await ev.action.setSettings({ ...ev.payload.settings, zoomIndex: 0 });
    }
    this.render();
  }

  private startRenderTimer(): void {
    if (this.renderTimer) { clearInterval(this.renderTimer); this.renderTimer = null; }
    const intervalMs = Math.max(8, Math.round(1000 / this.frameRate));
    this.renderTimer = setInterval(() => this.render(), intervalMs);
  }

  private render(): void {
    if (!this.act) return;
    const svg = this.renderSvg();
    this.act.setFeedback({
      'fft-display': dumpAndB64('fft', svg),
    }).catch(() => {});
  }

  private renderSvg(): string {
    const bins = this.latestBins;
    const iqRate = this.latestIqRate || spyService.getCurrentIQRate();
    const freq = this.latestFreq || spyService.currentFreq;
    // Apply vertical zoom — scales the PI-configured (floor, ceil) range
    // around its midpoint. vFactor < 1 narrows the view (zoom in vertically),
    // > 1 widens it (zoom out — see weaker signals).
    const baseFloor = this.dbFloor;
    const baseCeil = this.dbCeil;
    const mid = (baseFloor + baseCeil) / 2;
    const halfBase = (baseCeil - baseFloor) / 2;
    const vFactor = V_ZOOM_FACTORS[this.vZoomIndex] ?? 1;
    const half = halfBase * vFactor;
    const floor = mid - half;
    const ceil = mid + half;
    const range = ceil - floor;

    const zoom = ZOOM_STEPS[this.zoomIndex] ?? 1;
    const displayedSpan = iqRate > 0 ? iqRate / zoom : 0;

    // Background + plot area frame.
    let out = `<rect width="${LCD_W}" height="${LCD_H}" fill="#000000"/>`;

    // Horizontal gridlines every 20 dB inside the plot region (dashed grey).
    for (let db = Math.ceil(floor / 20) * 20; db <= ceil; db += 20) {
      const y = mapDbToY(db, floor, range);
      out += `<line x1="0" y1="${y.toFixed(1)}" x2="${LCD_W}" y2="${y.toFixed(1)}" stroke="#3a3a3a" stroke-width="1" stroke-dasharray="2 3"/>`;
    }
    // Center crosshair (VFO marker) — vertical red line at x = LCD_W/2.
    const cx = LCD_W / 2;
    out += `<line x1="${cx}" y1="${PLOT_TOP}" x2="${cx}" y2="${PLOT_BOTTOM}" stroke="#ff3333" stroke-width="1" opacity="0.7"/>`;

    if (bins && bins.length > 0 && this.connected) {
      // Zoom: show only the centred N/zoom bins. fftshift'd indexing means
      // DC sits at idx N/2, so the visible window is [N/2 - half, N/2 + half).
      const N = bins.length;
      const visibleBins = Math.max(2, Math.round(N / zoom));
      const startBin = Math.max(0, Math.floor((N - visibleBins) / 2));
      const endBin = Math.min(N, startBin + visibleBins);
      // Map 200 px → visible bins. Two regimes:
      //   * binsPerPixel ≥ 1 — downsample, take max so peaks stay sharp.
      //   * binsPerPixel < 1 — upsample, linearly interpolate between adjacent
      //     bins. Without this, zoom levels where one bin spans several pixels
      //     produce a "stair-step" comb pattern (縦縞) because neighbouring
      //     pixels snap to the same bin value via floor(). Linear interp in dB
      //     space gives a smooth curve at high zoom (sinc would be the
      //     principled choice but is overkill for this LCD size).
      const pixHeights: number[] = new Array(LCD_W);
      const visN = endBin - startBin;
      const binsPerPixel = visN / LCD_W;
      if (binsPerPixel >= 1) {
        let lastEnd = startBin;
        for (let x = 0; x < LCD_W; x++) {
          const start = lastEnd;
          const end = Math.min(endBin, startBin + Math.floor(((x + 1) * visN) / LCD_W));
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
          // Continuous bin position at this pixel's centre.
          const f = startBin + (x + 0.5) * binsPerPixel;
          const k0 = Math.max(startBin, Math.min(endBin - 1, Math.floor(f)));
          const k1 = Math.min(endBin - 1, k0 + 1);
          const t = f - k0;
          pixHeights[x] = bins[k0] * (1 - t) + bins[k1] * t;
        }
      }
      // Render as a filled polygon (cheap and crisp on the small LCD).
      const pts: string[] = [];
      pts.push(`0,${PLOT_BOTTOM}`);
      for (let x = 0; x < LCD_W; x++) {
        const y = mapDbToY(pixHeights[x], floor, range);
        pts.push(`${x},${y.toFixed(1)}`);
      }
      pts.push(`${LCD_W - 1},${PLOT_BOTTOM}`);
      // Cyan-blue (水色) fill, with a brighter cyan outline on top.
      out += `<polygon points="${pts.join(' ')}" fill="#14384a" fill-opacity="0.7" stroke="none"/>`;
      // Outline (top of the spectrum) drawn on top of the fill for sharper peaks.
      const lineSegs: string[] = [];
      for (let x = 0; x < LCD_W; x++) {
        const y = mapDbToY(pixHeights[x], floor, range);
        lineSegs.push(`${x === 0 ? 'M' : 'L'}${x},${y.toFixed(1)}`);
      }
      out += `<path d="${lineSegs.join(' ')}" stroke="#66c8e8" stroke-width="1" fill="none"/>`;
    } else {
      out += `<text x="${LCD_W / 2}" y="${LCD_H / 2 + 4}" fill="#666" font-family="monospace" font-size="11" text-anchor="middle">${this.connected ? 'waiting…' : 'OFFLINE'}</text>`;
    }

    // Header: center freq (left) + span / zoom info (right). Right cluster
    // also carries the active-axis indicator so the user always knows which
    // way the dial is currently driving the display.
    const spanText = displayedSpan > 0 ? `±${fmtFreq(displayedSpan / 2)}` : '';
    const zoomTag = zoom > 1 ? ` ${formatZoom(zoom)}` : '';
    const vZoomTag = vFactor !== 1 ? ` v${formatZoom(vFactor)}` : '';
    const axisGlyph = this.axisMode === 'v' ? 'V' : 'H';
    const axisColor = this.axisMode === 'v' ? '#ff9933' : '#66ccff';
    const centerLabel = freq > 0 ? fmtFreq(freq) : '-';
    out += `<rect x="0" y="0" width="${LCD_W}" height="${HEADER_H}" fill="#000"/>`;
    out += `<text x="4" y="9" fill="#fff" font-family="monospace" font-size="9">${centerLabel}</text>`;
    // Axis indicator sits at the LEFT-center of the header so it doesn't
    // crowd the freq label, and uses a per-mode colour so the eye can spot
    // the current mode without reading the glyph.
    const axisX = LCD_W / 2 - 14;
    out += `<text x="${axisX}" y="9" fill="${axisColor}" font-family="monospace" font-size="9" text-anchor="end">[${axisGlyph}]</text>`;
    out += `<text x="${LCD_W - 4}" y="9" fill="#fff" font-family="monospace" font-size="9" text-anchor="end">${spanText}${zoomTag}${vZoomTag}</text>`;
    // dB scale tick — bottom-left corner.
    out += `<text x="2" y="${LCD_H - 2}" fill="#444" font-family="monospace" font-size="8">${floor}</text>`;
    out += `<text x="2" y="${PLOT_TOP + 8}" fill="#444" font-family="monospace" font-size="8">${ceil}</text>`;

    // Outer 1-px frame so the panel reads as a complete LCD even without
    // the standard border layer.
    out += `<rect x="0.5" y="0.5" width="${LCD_W - 1}" height="${LCD_H - 1}" rx="4" ry="4" fill="none" stroke="#555" stroke-width="1"/>`;

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${LCD_W}" height="${LCD_H}">${out}</svg>`;
  }
}

function mapDbToY(db: number, floor: number, range: number): number {
  if (range <= 0) return PLOT_BOTTOM;
  const norm = (db - floor) / range;             // 0 at floor, 1 at ceil
  const clamped = norm < 0 ? 0 : norm > 1 ? 1 : norm;
  return PLOT_BOTTOM - clamped * PLOT_H;          // higher dB → smaller y
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
  // 1x, 1.25x, 1.5x, 2x, … no trailing zeros, up to 2 decimals.
  if (Number.isInteger(z)) return z.toString() + 'x';
  return z.toFixed(2).replace(/\.?0+$/, '') + 'x';
}
