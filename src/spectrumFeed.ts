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
const FFT_SIZE = clampPow2(Number(process.env.DECK_RX_SPECTRUM_FFT ?? 1024));
const FPS = Math.max(1, Math.min(60, Number(process.env.DECK_RX_SPECTRUM_FPS ?? 30)));
// Matches the FFT dial's default: enough averaging to calm the noise floor
// without smearing a signal that moves.
const SMOOTHING = 0.4;

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
let timer: ReturnType<typeof setInterval> | null = null;
let latest: { bins: Float32Array; iqRate: number; freq: number } | null = null;
let seq = 0;

function startPipeline(): void {
  if (iqListener) return;
  fft = new FftPipeline(FFT_SIZE);
  // The IQ callback only keeps the newest result; the timer decides how often
  // a frame actually goes out. IQ arrives far faster than any display needs.
  iqListener = (iq, iqRate, freq) => {
    const bins = fft?.process(iq, SMOOTHING);
    if (bins) latest = { bins, iqRate, freq };
  };
  spyService.subscribeIqStream(iqListener);
  timer = setInterval(() => {
    if (!latest || clients.size === 0) return;
    const frame = encodeSpectrumFrame(latest.bins, latest.iqRate, latest.freq, seq++);
    for (const c of clients) {
      // Drop the frame for a client that can't keep up rather than queueing:
      // a stale spectrum is worthless, and an unbounded queue is a leak.
      if (c.writableLength > frame.length * 4) continue;
      c.write(frame);
    }
  }, Math.round(1000 / FPS));
  timer.unref?.();
  log.info(`[spectrumFeed] pipeline up — fft=${FFT_SIZE} fps=${FPS}`);
}

function stopPipeline(): void {
  if (iqListener) { spyService.unsubscribeIqStream(iqListener); iqListener = null; }
  if (timer) { clearInterval(timer); timer = null; }
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
