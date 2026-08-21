/**
 * Spectrum feed: FFT frames over a Unix-domain socket, for a native front-end.
 *
 * The status feed (src/statusFeed.ts) publishes ~320 B four times a second as
 * JSON on a file — right for a station name and two meters, hopeless for a
 * spectrum. A waterfall wants a few hundred floats tens of times a second, so
 * this is a binary stream instead, and the FFT stays on this side: sending raw
 * IQ (hundreds of kHz, complex) would cost orders of magnitude more.
 *
 * Same restraint as the status feed: **nothing is computed unless somebody is
 * connected.** The IQ subscription is taken on the first client and dropped
 * with the last, so a receiver nobody is watching pays nothing.
 *
 * Frame layout, little-endian, header then payload:
 *
 *   off  size  field
 *     0     4  magic 'DRXS'
 *     4     1  version (1)
 *     5     1  flags (0)
 *     6     2  reserved
 *     8     4  binCount
 *    12     4  iqRate, Hz          — span of the frame
 *    16     4  centerFreq, Hz      — bin[binCount/2] sits here (fftshift'd)
 *    20     4  seq                 — wraps at 2^32, gap = dropped frame
 *    24  4*n  bins, float32 dBFS   — low freq first
 *
 * A reader syncs on the magic and computes the frame length from binCount, so
 * it never needs a length prefix or a delimiter.
 */

import net from 'net';
import fs from 'fs';
import { spyService } from './spyService.js';
import { FftPipeline } from './fft.js';
import { log } from './log.js';

const SOCKET_PATH = process.env.DECK_RX_SPECTRUM_SOCKET ?? '/tmp/deck-rx-spectrum.sock';

// Live settings. The env vars seed them; a front-end changes them at runtime
// through the control server's /spectrum endpoint, the way SDR++ exposes FFT
// size / framerate / smoothing in its display panel.
const settings = {
  fftSize: clampPow2(Number(process.env.DECK_RX_SPECTRUM_FFT ?? 1024)),
  fps: clampFps(Number(process.env.DECK_RX_SPECTRUM_FPS ?? 30)),
  // Smoothing SPEED, in SDR++'s units (core/src/gui/menus/display.cpp): the
  // per-frame EMA coefficient is speed / (fps * 10), so the time constant is
  // 10 / speed SECONDS and does not move when the framerate changes. Lower =
  // smoother. A fixed coefficient instead — what this used to be — ties the
  // window to the frame period, which is why a "0.4" that looked reasonable at
  // 30 fps was about a tenth of the smoothing SDR++ gives at its defaults.
  smoothSpeed: 30,
};

export interface SpectrumSettings { fftSize: number; fps: number; smoothSpeed: number; }

/** Current settings, for a front-end to render its controls from. */
export function spectrumSettings(): SpectrumSettings { return { ...settings }; }

/**
 * Apply new settings, clamped to what the pipeline can actually do. Returns the
 * values in force afterwards, so a caller never has to guess how its request
 * was adjusted. A size change rebuilds the FFT (and drops the smoothing
 * history, which belonged to the old bin count); an fps change re-arms the
 * timer. Both are no-ops while nobody is connected — the pipeline is not
 * running then, and it reads these on the way up.
 */
export function setSpectrumSettings(next: Partial<SpectrumSettings>): SpectrumSettings {
  const sizeChanged = next.fftSize !== undefined && clampPow2(next.fftSize) !== settings.fftSize;
  const fpsChanged = next.fps !== undefined && clampFps(next.fps) !== settings.fps;
  if (next.fftSize !== undefined) settings.fftSize = clampPow2(next.fftSize);
  if (next.fps !== undefined) settings.fps = clampFps(next.fps);
  if (next.smoothSpeed !== undefined) {
    // 1 = ~10 s of averaging, 200 = essentially none. Above fps*10 the
    // coefficient saturates at 1 (no smoothing at all), so that is the ceiling.
    settings.smoothSpeed = Math.max(1, Math.min(1000, next.smoothSpeed));
  }
  if (sizeChanged && fft) fft = new FftPipeline(settings.fftSize);
  // fpsChanged needs no action: the IQ listener reads settings.fps on every
  // packet, so a new rate takes effect on the next one.
  void fpsChanged;
  log.info(`[spectrumFeed] settings fft=${settings.fftSize} fps=${settings.fps} smoothSpeed=${settings.smoothSpeed}`);
  return spectrumSettings();
}

function clampFps(n: number): number {
  if (!Number.isFinite(n)) return 30;
  return Math.max(1, Math.min(60, Math.round(n)));
}

export const HEADER_BYTES = 24;
const MAGIC = 0x53585244; // 'DRXS' little-endian

function clampPow2(n: number): number {
  if (!Number.isFinite(n)) return 1024;
  const c = Math.max(64, Math.min(4096, Math.floor(n)));
  return 2 ** Math.round(Math.log2(c));
}

/** Serialise one frame. Pure — the wire format is pinned by unit tests. */
export function encodeSpectrumFrame(
  bins: Float32Array,
  iqRate: number,
  centerFreq: number,
  seq: number,
): Buffer {
  const buf = Buffer.allocUnsafe(HEADER_BYTES + bins.length * 4);
  buf.writeUInt32LE(MAGIC, 0);
  buf.writeUInt8(1, 4);
  buf.writeUInt8(0, 5);
  buf.writeUInt16LE(0, 6);
  buf.writeUInt32LE(bins.length, 8);
  buf.writeUInt32LE(Math.max(0, Math.round(iqRate)), 12);
  buf.writeUInt32LE(Math.max(0, Math.round(centerFreq)), 16);
  buf.writeUInt32LE(seq >>> 0, 20);
  for (let i = 0; i < bins.length; i++) buf.writeFloatLE(bins[i], HEADER_BYTES + i * 4);
  return buf;
}

let server: net.Server | null = null;
const clients = new Set<net.Socket>();
let fft: FftPipeline | null = null;
let iqListener: ((iq: Buffer, iqRate: number, freq: number) => void) | null = null;
let latest: { bins: Float32Array; iqRate: number; freq: number } | null = null;
let seq = 0;

function startPipeline(): void {
  if (iqListener) return;
  fft = new FftPipeline(settings.fftSize);
  // Two different rates, and conflating them is what makes a spectrum look
  // wrong when the user turns the framerate down:
  //
  //   - COMPUTE: the FFT runs at up to COMPUTE_HZ, independent of the display.
  //     Every result between two displayed frames is averaged into the one
  //     that goes out, so a LOWER framerate yields a SMOOTHER trace (more
  //     inputs per frame), which is what averaging is for. Emitting a single
  //     decimated FFT instead makes a slow display noisier, not calmer.
  //   - DISPLAY: settings.fps decides how often a frame leaves. The block
  //     average resets with each one.
  //
  // settings.smoothing is then an exponential average ACROSS displayed frames,
  // so its time constant is measured in frames the user can see rather than in
  // IQ packets they cannot.
  const COMPUTE_HZ = 60;
  let sum: Float32Array | null = null;
  let count = 0;
  let smoothed: Float32Array | null = null;
  let lastComputeAt = 0;
  let lastEmitAt = 0;

  iqListener = (iq, iqRate, freq) => {
    if (clients.size === 0) return;
    const now = Date.now();
    if (now - lastComputeAt < 1000 / COMPUTE_HZ - 1) return;
    lastComputeAt = now;
    // Raw bins: the averaging below is ours, so the pipeline's own smoother
    // stays out of the way (its time constant is tied to how often we call it).
    const bins = fft?.process(iq, 0);
    if (!bins) return;
    if (!sum || sum.length !== bins.length) { sum = new Float32Array(bins.length); count = 0; }
    for (let i = 0; i < bins.length; i++) sum[i] += bins[i];
    count++;

    if (now - lastEmitAt < 1000 / settings.fps - 1) return;
    lastEmitAt = now;
    const avg = new Float32Array(bins.length);
    for (let i = 0; i < bins.length; i++) avg[i] = sum[i] / count;
    sum.fill(0); count = 0;

    // SDR++'s exact form: alpha = speed / (fps * 10), clamped to 1, applied per
    // displayed frame. Normalising by fps is the part that matters — it keeps
    // the averaging window fixed in seconds, so changing the framerate changes
    // how often you see the trace, not how smooth it is.
    const alpha = Math.min(1, settings.smoothSpeed / (settings.fps * 10));
    if (!smoothed || smoothed.length !== avg.length || alpha >= 1) {
      smoothed = avg;
    } else {
      for (let i = 0; i < avg.length; i++) smoothed[i] = avg[i] * alpha + smoothed[i] * (1 - alpha);
    }

    latest = { bins: smoothed, iqRate, freq };
    const frame = encodeSpectrumFrame(smoothed, iqRate, freq, seq++);
    for (const c of clients) {
      // Drop the frame for a client that can't keep up rather than queueing:
      // a stale spectrum is worthless, and an unbounded queue is a leak.
      if (c.writableLength > frame.length * 4) continue;
      c.write(frame);
    }
  };
  spyService.subscribeIqStream(iqListener);
  log.info(`[spectrumFeed] pipeline up — fft=${settings.fftSize} fps=${settings.fps} smoothSpeed=${settings.smoothSpeed}`);
}

function stopPipeline(): void {
  if (iqListener) { spyService.unsubscribeIqStream(iqListener); iqListener = null; }
  fft = null;
  latest = null;
  log.info('[spectrumFeed] pipeline down — no clients');
}

/** Start the feed. Safe to call once at startup; repeat calls are ignored. */
export function startSpectrumFeed(): void {
  if (server) return;
  // Sandboxed harness instances must not grab the shared socket; an explicit
  // DECK_RX_SPECTRUM_SOCKET opts one back in on a path of its own. Same gate
  // the status feed and the control server use.
  if (process.env.DECK_RX_CONFIG_PATH && !process.env.DECK_RX_SPECTRUM_SOCKET) {
    log.info('[spectrumFeed] sandboxed instance — feed disabled');
    return;
  }
  // macOS caps a Unix socket path at 104 bytes (sockaddr_un.sun_path) and
  // reports a longer one as EADDRINUSE, which sends you hunting for a process
  // that does not exist. Say what actually happened instead.
  if (Buffer.byteLength(SOCKET_PATH) > 100) {
    log.warn(`[spectrumFeed] disabled: socket path is ${Buffer.byteLength(SOCKET_PATH)} bytes, over the 104-byte limit — ${SOCKET_PATH}`);
    return;
  }
  // A socket file outlives the process that made it, so a crash leaves one
  // behind that would make listen() fail with EADDRINUSE forever.
  try { fs.unlinkSync(SOCKET_PATH); } catch { /* not there */ }

  const srv = net.createServer((sock) => {
    sock.on('error', () => { /* client vanished mid-write */ });
    clients.add(sock);
    if (clients.size === 1) startPipeline();
    log.info(`[spectrumFeed] client connected (${clients.size})`);
    const drop = () => {
      if (!clients.delete(sock)) return;
      log.info(`[spectrumFeed] client gone (${clients.size})`);
      if (clients.size === 0) stopPipeline();
    };
    sock.on('close', drop);
    sock.on('end', drop);
  });
  srv.on('error', (e: NodeJS.ErrnoException) => {
    log.warn(`[spectrumFeed] disabled: ${e.code ?? e.message}`);
    server = null;
    try { srv.close(); } catch { /* already down */ }
  });
  srv.listen(SOCKET_PATH, () => log.info(`[spectrumFeed] listening on ${SOCKET_PATH}`));
  srv.unref?.();
  server = srv;
  process.on('exit', () => { try { fs.unlinkSync(SOCKET_PATH); } catch { /* already gone */ } });
}

/** Stop the feed and drop every client. Used by tests and on shutdown. */
export function stopSpectrumFeed(): void {
  for (const c of clients) { try { c.destroy(); } catch { /* already down */ } }
  clients.clear();
  stopPipeline();
  if (server) { try { server.close(); } catch { /* already down */ } server = null; }
  try { fs.unlinkSync(SOCKET_PATH); } catch { /* already gone */ }
}
