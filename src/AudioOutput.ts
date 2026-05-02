import { spawn, ChildProcess } from 'child_process';
import streamDeck from '@elgato/streamdeck';
import { getFfmpegDeviceIndexMap } from './audioDevices.js';

// Resolve ffmpeg absolute path (Stream Deck plugin runs with limited PATH)
const FFMPEG = (() => {
  const candidates = ['/opt/local/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg'];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs');
  for (const p of candidates) { try { fs.accessSync(p); return p; } catch {} }
  return 'ffmpeg';
})();

export interface AudioOutput {
  start(sampleRate: number, channels: number): Promise<void>;
  write(pcm: Int16Array): void;
  stop(): void;
}

// ──── ffmpeg ─────────────────────────────────────────────────────────────────

export interface FfmpegConfig {
  mode: 'local' | 'icecast';
  deviceName?: string;    // macOS device name (resolved to index at start time)
  icecastUrl?: string;    // icecast://source:pass@host:port/mount
  bitrate?: string;       // e.g. "128k"
}

export class FfmpegOutput implements AudioOutput {
  private proc: ChildProcess | null = null;

  constructor(private cfg: FfmpegConfig) {}

  async start(sampleRate: number, channels: number): Promise<void> {
    // Resample to 48 kHz before AudioToolbox output. Some virtual / Loopback
    // devices misbehave on non-standard rates (e.g., 57 kHz) after running for
    // a while, causing audio to drop out silently.
    const OUT_RATE = 48000;
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-fflags', 'nobuffer', '-flags', 'low_delay',
      '-f', 's16le', '-ar', String(sampleRate), '-ac', String(channels),
      '-i', 'pipe:0',
      '-af', 'aresample=async=0',
      '-ar', String(OUT_RATE),
    ];
    if (this.cfg.mode === 'local') {
      // macOS AudioToolbox: resolve device NAME to current ffmpeg index every
      // start (indices renumber when devices add/remove).
      let dev = 'default';
      if (this.cfg.deviceName && this.cfg.deviceName !== 'default') {
        try {
          const map = await getFfmpegDeviceIndexMap();
          const idx = map.get(this.cfg.deviceName);
          if (idx !== undefined) dev = String(idx);
          else streamDeck.logger.warn(`[FfmpegOutput] device "${this.cfg.deviceName}" not found, using default`);
        } catch (e) {
          streamDeck.logger.warn(`[FfmpegOutput] device lookup failed: ${e}, using default`);
        }
      }
      args.push('-f', 'audiotoolbox', dev);
    } else {
      // ICECAST via MP3
      args.push(
        '-acodec', 'libmp3lame',
        '-b:a', this.cfg.bitrate ?? '128k',
        '-f', 'mp3',
        this.cfg.icecastUrl!,
      );
    }
    streamDeck.logger.info(`[FfmpegOutput] spawn ${FFMPEG} ${args.join(' ')}`);
    this.proc = spawn(FFMPEG, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    this.proc.stderr?.on('data', (d: Buffer) => {
      streamDeck.logger.warn(`[ffmpeg] ${d.toString().trim()}`);
    });
    this.proc.on('error', (e: Error) => {
      streamDeck.logger.error(`[FfmpegOutput] spawn error: ${e.message}`);
      this.proc = null;
    });
    this.proc.on('exit', (code: number | null, signal: string | null) => {
      streamDeck.logger.warn(`[FfmpegOutput] exit code=${code} signal=${signal}`);
      this.proc = null;
    });
    // Minimal silence prefill (40ms) — enough to suppress AudioToolbox first-
    // callback pop without adding noticeable end-to-end latency.
    const silenceSamples = Math.round(sampleRate * 0.04) * channels;
    const silence = Buffer.alloc(silenceSamples * 2); // int16
    if (this.proc.stdin?.writable) this.proc.stdin.write(silence);
  }

  write(pcm: Int16Array): void {
    if (!this.proc?.stdin?.writable) return;
    this.proc.stdin.write(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  }

  stop(): void {
    try { this.proc?.stdin?.end(); } catch {}
    try { this.proc?.kill('SIGTERM'); } catch {}
    this.proc = null;
  }
}

// ──── naudiodon (lazy require — avoids ABI crash at startup) ─────────────────

export interface NaudiodonConfig {
  deviceId?: number;  // -1 = default
}

export class NaudiodonOutput implements AudioOutput {
  private ai: any = null;

  constructor(private cfg: NaudiodonConfig = {}) {}

  async start(sampleRate: number, channels: number): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const naudiodon = require('naudiodon');
    this.ai = new naudiodon.AudioIO({
      outOptions: {
        channelCount: channels,
        sampleFormat: naudiodon.SampleFormat16Bit,
        sampleRate,
        deviceId: this.cfg.deviceId ?? -1,
        closeOnError: false,
      },
    });
    this.ai.start();
  }

  write(pcm: Int16Array): void {
    if (!this.ai) return;
    this.ai.write(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  }

  stop(): void {
    try { this.ai?.quit(); } catch {}
    this.ai = null;
  }
}
