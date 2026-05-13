import { spawn, ChildProcess } from 'child_process';
import streamDeck from '@elgato/streamdeck';
import { getFfmpegDeviceIndexMap } from './audioDevices.js';

// Resolve ffmpeg absolute path (Stream Deck plugin runs with limited PATH).
// Overridable via DECK_RX_FFMPEG_PATH so the user can try ffmpeg7
// (`DECK_RX_FFMPEG_PATH=/opt/local/bin/ffmpeg7`) without recompiling, in
// case the 4.x audiotoolbox sink turns out to be the root cause of the
// long-uptime "ffmpeg keeps writing but audio is silent" symptom.
const FFMPEG = (() => {
  const override = process.env.DECK_RX_FFMPEG_PATH;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs');
  if (override) {
    try { fs.accessSync(override); return override; }
    catch { streamDeck.logger.warn(`[FfmpegOutput] DECK_RX_FFMPEG_PATH="${override}" not accessible, falling through to defaults`); }
  }
  const candidates = ['/opt/local/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg'];
  for (const p of candidates) { try { fs.accessSync(p); return p; } catch {} }
  return 'ffmpeg';
})();

export interface AudioOutput {
  start(sampleRate: number, channels: number): Promise<void>;
  write(pcm: Int16Array): void;
  /** Stop and wait for the underlying audio sink to fully release its
   *  device. Required so a subsequent start() can grab AudioToolbox at
   *  the right sample rate without racing the previous ffmpeg. */
  stop(): Promise<void>;
}

// ──── ffmpeg ─────────────────────────────────────────────────────────────────

export interface FfmpegConfig {
  mode: 'local' | 'icecast';
  deviceName?: string;     // macOS device name (resolved to index at start time)
  icecastUrl?: string;     // icecast://user@host:port/mount  (no password; combined at spawn)
  icecastPassword?: string;// kept separate so the PI can mask it (type="password")
  bitrate?: string;        // e.g. "128k"
  binary?: string;         // absolute path to ffmpeg binary; overrides auto-detect (e.g. "/opt/local/bin/ffmpeg7")
}

/** Build the final icecast URL passed to ffmpeg by injecting `password` into
 *  `urlBase`. Accepts both bare-user URLs (icecast://user@host/...) and
 *  legacy URLs that already embed a password (icecast://user:old@host/...);
 *  the embedded one is replaced when `password` is non-empty. */
export function buildIcecastUrl(urlBase: string, password?: string): string {
  if (!password) return urlBase;
  return urlBase.replace(/^(\w+:\/\/[^:@/]+)(?::[^@]*)?@/, `$1:${password}@`);
}

/** Tag carried with the "output broken" state change to let UIs render a
 *  human-readable cause (`ERR Auth` / `ERR Network` / etc.). */
export type OutputErrorTag = 'Auth' | 'Network' | 'Codec' | 'Other';

/** Classify an ffmpeg stderr line into one of the known publish-failure
 *  buckets. Anything that doesn't match a specific pattern collapses to
 *  'Other'. */
export function classifyFfmpegStderr(msg: string): OutputErrorTag {
  const m = (msg || '').toLowerCase();
  if (/(401|403|unauthorized|authoriz)/.test(m)) return 'Auth';
  if (/(connection refused|connection reset|unreachable|timeout|network is|name or service|404 not found|getaddrinfo)/.test(m)) return 'Network';
  if (/(422|invalid (data|format|argument)|codec|content[- ]type)/.test(m)) return 'Codec';
  return 'Other';
}

export class FfmpegOutput implements AudioOutput {
  private proc: ChildProcess | null = null;
  private intentionalStop = false;
  private lastSampleRate = 0;
  private lastChannels = 0;
  private respawnTimer: ReturnType<typeof setTimeout> | null = null;
  // Failure tracking for the upstream "output broken" indicator.
  // We treat 3 consecutive ffmpeg exits within 3 seconds of spawn as a
  // persistent error (typical for icecast 401 / network unreachable). One
  // long stable run (≥ 5 s) clears the streak.
  private spawnAt = 0;
  private failStreak = 0;
  private outputErrored = false;
  private onStateChange?: (broken: boolean, info?: { tag: OutputErrorTag; raw: string }) => void;

  constructor(private cfg: FfmpegConfig) {}

  /** Subscribe to output health transitions. Called with broken=true when
   *  ffmpeg has failed 3× in a row within 3 s of spawn (info carries the
   *  classified failure tag and the raw stderr line), broken=false once a
   *  spawn survives ≥ 5 s. */
  setStateChangeHandler(fn: (broken: boolean, info?: { tag: OutputErrorTag; raw: string }) => void): void {
    this.onStateChange = fn;
  }

  async start(sampleRate: number, channels: number): Promise<void> {
    this.lastSampleRate = sampleRate;
    this.lastChannels = channels;
    this.intentionalStop = false;
    return this.spawnFfmpeg(sampleRate, channels);
  }

  private async spawnFfmpeg(sampleRate: number, channels: number): Promise<void> {
    // Resample to 48 kHz before AudioToolbox output. Some virtual / Loopback
    // devices misbehave on non-standard rates (e.g., 57 kHz) after running for
    // a while, causing audio to drop out silently.
    const OUT_RATE = 48000;
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-fflags', 'nobuffer', '-flags', 'low_delay',
      '-f', 's16le', '-ar', String(sampleRate), '-ac', String(channels),
      '-i', 'pipe:0',
      // Async resampling tolerates input rate drift up to 1 second of samples
      // before injecting silence/dropping samples. Avoids silent stalls when
      // SpyServer's IQ rate slightly differs from nominal.
      '-af', `aresample=${OUT_RATE}:async=${OUT_RATE}:first_pts=0`,
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
      // ICECAST via MP3. Password is held separately and injected here so
      // it never appears in the persisted icecastUrl (PI masks it via
      // type="password").
      const url = buildIcecastUrl(this.cfg.icecastUrl!, this.cfg.icecastPassword);
      args.push(
        '-acodec', 'libmp3lame',
        '-b:a', this.cfg.bitrate ?? '128k',
        '-f', 'mp3',
        url,
      );
    }
    // Per-instance binary override: PI / config can set a specific ffmpeg
    // build (e.g. /opt/local/bin/ffmpeg7) without touching the env var.
    // Falls back to auto-detected FFMPEG (which already honours
    // DECK_RX_FFMPEG_PATH if set).
    const fs = require('fs');           // eslint-disable-line @typescript-eslint/no-require-imports
    let ffmpegBin = FFMPEG;
    if (this.cfg.binary) {
      try { fs.accessSync(this.cfg.binary); ffmpegBin = this.cfg.binary; }
      catch { streamDeck.logger.warn(`[FfmpegOutput] cfg.binary="${this.cfg.binary}" not accessible, using ${FFMPEG}`); }
    }
    streamDeck.logger.info(`[FfmpegOutput] spawn ${ffmpegBin} ${args.join(' ')}`);
    this.proc = spawn(ffmpegBin, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    this.spawnAt = Date.now();
    let lastStderr = '';
    this.proc.stderr?.on('data', (d: Buffer) => {
      const msg = d.toString().trim();
      lastStderr = msg;
      streamDeck.logger.warn(`[ffmpeg] ${msg}`);
    });
    this.proc.on('error', (e: Error) => {
      streamDeck.logger.error(`[FfmpegOutput] spawn error: ${e.message}`);
      this.proc = null;
    });
    // Heartbeat: if the spawn survives 5 s, treat the output as healthy and
    // clear the failure streak. Notify listeners so a previously-shown ERROR
    // indicator can flip back to OK.
    const stableTimer = setTimeout(() => {
      if (this.proc && this.failStreak > 0) {
        this.failStreak = 0;
        if (this.outputErrored) {
          this.outputErrored = false;
          this.onStateChange?.(false);
        }
      }
    }, 5000);
    this.proc.on('exit', (code: number | null, signal: string | null) => {
      clearTimeout(stableTimer);
      streamDeck.logger.warn(`[FfmpegOutput] exit code=${code} signal=${signal}`);
      const lifetimeMs = Date.now() - this.spawnAt;
      this.proc = null;
      if (this.intentionalStop) return;
      // Quick failure (≤ 3 s) → bump streak. Long-running but exited later
      // doesn't count as a publish error (network blips, etc.).
      if (lifetimeMs < 3000 && code !== 0) {
        this.failStreak += 1;
        if (this.failStreak >= 3 && !this.outputErrored) {
          this.outputErrored = true;
          const raw = lastStderr || `exit ${code}`;
          this.onStateChange?.(true, { tag: classifyFfmpegStderr(raw), raw });
        }
      }
      if (this.respawnTimer) clearTimeout(this.respawnTimer);
      this.respawnTimer = setTimeout(() => {
        this.respawnTimer = null;
        if (!this.intentionalStop && !this.proc) {
          streamDeck.logger.info('[FfmpegOutput] auto-respawning');
          this.spawnFfmpeg(this.lastSampleRate, this.lastChannels).catch((e) =>
            streamDeck.logger.error(`[FfmpegOutput] respawn failed: ${e}`),
          );
        }
      }, 500);
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

  stop(): Promise<void> {
    this.intentionalStop = true;
    if (this.respawnTimer) { clearTimeout(this.respawnTimer); this.respawnTimer = null; }
    const proc = this.proc;
    this.proc = null;
    if (!proc) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const finish = () => { resolve(); };
      // Most ffmpeg shutdowns finish < 100 ms after SIGTERM, but a stuck
      // child shouldn't block start() forever — escalate to SIGKILL after
      // 800 ms so AudioToolbox is guaranteed released before the next spawn.
      const escalate = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 800);
      const timeout  = setTimeout(() => { clearTimeout(escalate); finish(); }, 1500);
      proc.once('exit', () => { clearTimeout(escalate); clearTimeout(timeout); finish(); });
      try { proc.stdin?.end(); } catch {}
      try { proc.kill('SIGTERM'); } catch { clearTimeout(escalate); clearTimeout(timeout); finish(); }
    });
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

  async stop(): Promise<void> {
    try { this.ai?.quit(); } catch {}
    this.ai = null;
  }
}
