import { spawn, ChildProcess } from 'child_process';
import streamDeck from '@elgato/streamdeck';
import { Biquad } from './dspFilters.js';
import { SampleRateConverter, AsrcQuality } from './asrc.js';

// Resolve ffmpeg absolute path (Stream Deck plugin runs with limited PATH).
const FFMPEG = (() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs');
  const candidates = ['/opt/local/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg'];
  for (const p of candidates) { try { fs.accessSync(p); return p; } catch {} }
  return 'ffmpeg';
})();

export interface AudioOutput {
  start(sampleRate: number, channels: number): Promise<void>;
  /** Write PCM to the sink. `muted` tells the sink that this buffer is
   *  zero-filled (or near-zero — fade ramps qualify) so it can suspend
   *  any audio-rate observers that would otherwise read garbage out of
   *  the silence (e.g. the ASRC drift-compensation control loop, which
   *  only makes sense over an actively-playing buffer). */
  write(pcm: Int16Array, muted?: boolean): void;
  /** Stop and wait for the underlying audio sink to fully release its
   *  device. Required so a subsequent start() can grab the device at the
   *  right sample rate without racing the previous sink. */
  stop(): Promise<void>;
}

// ──── ffmpeg (icecast publish only) ──────────────────────────────────────────
//
// Local audio output is handled by NaudiodonOutput (PortAudio → CoreAudio).
// FfmpegOutput is kept solely to host the icecast SOURCE protocol — ffmpeg
// doubles as the MP3 encoder (libmp3lame) and the HTTP PUT client to the
// icecast mount, both of which would need separate JS implementations to
// remove this dependency.

export interface FfmpegConfig {
  icecastUrl?: string;     // icecast://user@host:port/mount  (no password; combined at spawn)
  icecastPassword?: string;// kept separate so the PI can mask it (type="password")
  bitrate?: string;        // e.g. "128k"
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
    // Resample to 48 kHz before the icecast MP3 encoder so all listeners get
    // a uniform stream regardless of the demod-mode audio rate.
    const OUT_RATE = 48000;
    // ICECAST via MP3. Password is held separately and injected here so
    // it never appears in the persisted icecastUrl (PI masks it via
    // type="password").
    const url = buildIcecastUrl(this.cfg.icecastUrl!, this.cfg.icecastPassword);
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-fflags', 'nobuffer', '-flags', 'low_delay',
      '-flush_packets', '1',
      '-f', 's16le', '-ar', String(sampleRate), '-ac', String(channels),
      '-i', 'pipe:0',
      // Synchronous resample, no `async` mode. Avoids the multi-second
      // queue growth the async resampler accumulates over long uptimes.
      '-af', `aresample=${OUT_RATE}`,
      '-acodec', 'libmp3lame',
      '-b:a', this.cfg.bitrate ?? '128k',
      '-f', 'mp3',
      url,
    ];
    streamDeck.logger.info(`[FfmpegOutput] spawn ${FFMPEG} ${args.join(' ')}`);
    this.proc = spawn(FFMPEG, args, { stdio: ['pipe', 'ignore', 'pipe'] });
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
    // Minimal silence prefill (40ms) — gives the icecast encoder a clean
    // priming buffer before live PCM starts arriving, without adding any
    // noticeable end-to-end latency.
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
      // 800 ms.
      const escalate = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 800);
      const timeout  = setTimeout(() => { clearTimeout(escalate); finish(); }, 1500);
      proc.once('exit', () => { clearTimeout(escalate); clearTimeout(timeout); finish(); });
      try { proc.stdin?.end(); } catch {}
      try { proc.kill('SIGTERM'); } catch { clearTimeout(escalate); clearTimeout(timeout); finish(); }
    });
  }
}

// ──── naudiodon (lazy require — avoids ABI crash at startup) ─────────────────
//
// naudiodon is a PortAudio binding. Native bindings must be rebuilt for the
// Stream Deck app's bundled Node (currently 20.20.0). See scripts/postinstall.sh
// for the rebuild + libportaudio.dylib (arm64) replacement.
//
// Why naudiodon over the ffmpeg → audiotoolbox sink: ffmpeg's audiotoolbox
// output wedges after ~5 h of continuous playback (the sink stops draining
// internally; ffmpeg keeps accepting writes but no audio reaches the device).
// Switching to naudiodon (PortAudio → CoreAudio directly, no intermediate
// process) is the structural fix.

export interface NaudiodonConfig {
  deviceId?: number;     // -1 = default; negative or undefined → use deviceName
  deviceName?: string;   // CoreAudio device name (with or without trailing space).
                         // Resolved to id at start time via naudiodon.getDevices().
}

export class NaudiodonOutput implements AudioOutput {
  private ai: unknown = null;
  // Output-stage anti-alias safety net. 8th-order Butterworth (4 cascaded
  // biquads) per channel at 22 kHz cutoff. Equivalent to what ffmpeg's
  // `aresample=48000` did implicitly via its built-in anti-alias FIR; we
  // lose that when we bypass ffmpeg and feed CoreAudio HAL directly, so
  // any demod that leaves > 22 kHz residue (FM stereo pilot @ 19 kHz,
  // L−R DSB-SC subcarrier @ 23-53 kHz, CW pre-LPF noise, etc.) plays
  // back as audible whine or distortion at the DAC. With this safety net
  // in place each demod still does its own band-shaping for mode-
  // specific clarity, but a future demod that forgets won't tank the
  // listening experience.
  private lpfL: Biquad[] = Array.from({ length: 4 }, () => new Biquad());
  private lpfR: Biquad[] = Array.from({ length: 4 }, () => new Biquad());
  private lpfConfiguredAt = 0;

  // Drift-compensation ASRC. The writer (SpyServer demod) and the reader
  // (DX7s/CoreAudio) run on independent crystals that drift by a few ppm.
  // Over hours that accumulates to tens of ms, exhausts the PortAudio
  // queue cushion, and plays back as audible underrun ("ビリビリ"). We
  // pass every PCM buffer through libsamplerate before naudiodon.write
  // and tune the resampling ratio in a slow control loop from the
  // Writable stream's writableLength backlog. This is the same mechanism
  // SDR++ uses internally for its audio sinks. See src/asrc.ts.
  private asrc: SampleRateConverter | null = null;
  // PI controller state — see updateAsrcRatio() for the tuning rationale.
  private writesSinceTune = 0;
  private writableLenEma = 0;       // bytes, exponential moving average
  private currentRatio = 1.0;
  // Static base ratio for input→device rate conversion (CoreAudio
  // sidestep). The ASRC ratio at steady state == baseRatio; dynamic
  // adjustments add a small ±ppm drift correction on top.
  private baseRatio = 1.0;
  private deviceSampleRate = 0;

  constructor(private cfg: NaudiodonConfig = {}) {}

  private configureLpfIfNeeded(sampleRate: number): void {
    if (this.lpfConfiguredAt === sampleRate) return;
    // 8th-order Butterworth Q values for the 4-stage cascade
    const Q8 = [0.5097955791, 0.6012682811, 0.8999762110, 2.5629154802];
    // Cutoff 22 kHz: above the full WFM stereo audio band (15 kHz) with
    // margin, below the 24 kHz that would clip any 23 kHz residual L-R
    // subcarrier component.
    const cutoff = Math.min(22000, sampleRate * 0.45);
    for (let k = 0; k < 4; k++) {
      this.lpfL[k].setLowPass(sampleRate, cutoff, Q8[k]);
      this.lpfR[k].setLowPass(sampleRate, cutoff, Q8[k]);
    }
    this.lpfConfiguredAt = sampleRate;
  }

  /** Resolve a deviceName (loose match, trims trailing whitespace which the
   *  CoreAudio device names sometimes carry) to a PortAudio device id, or
   *  return -1 (= system default) if not found. */
  private resolveDeviceId(naudiodon: { getDevices: () => Array<{ id: number; name: string; maxOutputChannels: number }> }): number {
    if (typeof this.cfg.deviceId === 'number' && this.cfg.deviceId >= 0) return this.cfg.deviceId;
    if (!this.cfg.deviceName || this.cfg.deviceName === 'default') return -1;
    const wanted = this.cfg.deviceName.trim();
    const match = naudiodon.getDevices().find((d) =>
      d.maxOutputChannels > 0 && d.name.trim() === wanted,
    );
    if (!match) {
      streamDeck.logger.warn(`[NaudiodonOutput] device "${wanted}" not found, falling back to default`);
      return -1;
    }
    return match.id;
  }

  async start(sampleRate: number, channels: number): Promise<void> {
    // Lazy require — keeps a missing or ABI-mismatched .node binding from
    // crashing the plugin process at module load. Errors here surface as a
    // throw the caller can catch (spyService logs + leaves audio disabled).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const naudiodon = require('naudiodon') as {
      AudioIO: new (opts: unknown) => { start: () => void; write: (b: Buffer) => void; quit: () => void; writableLength?: number };
      SampleFormat16Bit: number;
      getDevices: () => Array<{ id: number; name: string; maxOutputChannels: number; defaultSampleRate: number }>;
    };
    const deviceId = this.resolveDeviceId(naudiodon);
    // Open the PortAudio stream at the DEVICE's preferred sample rate
    // (e.g. DX7s = 96 kHz). When we open at the demod's audio rate
    // (114 kHz) instead, PortAudio hands the stream to CoreAudio which
    // resamples internally with a static rate — that resampler has no
    // drift compensation, so a few-ppm crystal mismatch between Airspy
    // and DX7s accumulates into queue creep (latency) or underrun
    // ("ビリビリ") over hours. SDR++ avoids this by opening at the
    // device-native rate; we do the same here, and the in-tree ASRC
    // (libsamplerate) handles BOTH the static input→device rate
    // conversion AND the dynamic ppm-scale drift correction.
    const devices = naudiodon.getDevices();
    const effectiveId = deviceId >= 0 ? deviceId : devices.find(d => d.maxOutputChannels > 0)?.id ?? 0;
    const dev = devices.find(d => d.id === effectiveId);
    const deviceRate = dev?.defaultSampleRate || sampleRate;
    this.deviceSampleRate = deviceRate;
    this.baseRatio = deviceRate / sampleRate;
    // LPF runs at INPUT rate (114 kHz), before downsampling. Cutoff
    // 22 kHz is well below the device-rate Nyquist (48 kHz at 96 kHz
    // device) so no aliasing on the downsample.
    this.configureLpfIfNeeded(sampleRate);
    for (const b of this.lpfL) b.reset();
    for (const b of this.lpfR) b.reset();
    // ASRC starts at baseRatio (rate-conversion only); the dynamic
    // control loop adds ±ppm drift correction on top. SINC_FASTEST is
    // overkill for 114→96 kHz (cheap polyphase quality is fine here)
    // but the upgrade from Linear is essentially free at our sample
    // budget and removes any audible high-freq artefact.
    this.asrc = new SampleRateConverter({ channels, quality: AsrcQuality.SincFastest, ratio: this.baseRatio });
    this.writesSinceTune = 0;
    this.writableLenEma = 0;
    this.currentRatio = this.baseRatio;
    streamDeck.logger.info(`[NaudiodonOutput] start inputRate=${sampleRate} deviceRate=${deviceRate} channels=${channels} deviceId=${effectiveId} (cfg deviceName=${this.cfg.deviceName ?? '-'}) baseRatio=${this.baseRatio.toFixed(6)} asrc=${this.asrc.active ? 'on' : 'passthrough'}`);
    this.ai = new naudiodon.AudioIO({
      outOptions: {
        channelCount: channels,
        sampleFormat: naudiodon.SampleFormat16Bit,
        sampleRate: deviceRate,  // ← device native, no CoreAudio resample
        deviceId,
        closeOnError: false,
        // 8 buffers cushion at the device rate. With ASRC keeping the
        // JS-side Writable backlog centred via the control loop and
        // CoreAudio no longer fighting us with a static resampler in
        // between, the queue should track close to its set point.
        maxQueue: 8,
      },
    });
    (this.ai as { start: () => void }).start();
  }

  /** Slow integrating control loop that nudges the ASRC ratio so the
   *  writer/reader clock drift doesn't accumulate. Called from write()
   *  once every TUNE_INTERVAL writes, NOT every write (the change is
   *  ppm-scale and observation noise dominates at short timescales).
   *
   *  Signal: the naudiodon Writable stream's writableLength (bytes
   *  queued in JS waiting for the internal _write callback to drain
   *  them into PortAudio). When PortAudio's downstream queue is full,
   *  _write blocks, writableLength rises. When the reader keeps up,
   *  writableLength stays near zero. So a sustained-high writableLength
   *  means "writer is faster than reader" → lower the ratio so we
   *  output fewer samples per input, slowing the writer.
   *
   *  Sustained-zero writableLength is the opposite case but harder to
   *  distinguish from "we just happen to be between buffer arrivals" —
   *  we use a low EMA threshold and a slower upward step. */
  private updateAsrcRatio(): void {
    if (!this.asrc?.active) return;
    const ai = this.ai as { writableLength?: number } | null;
    const wl = ai?.writableLength ?? 0;
    // EMA smoothing: α = 1/8 → ~300 ms window at TUNE_INTERVAL=4 (~36 ms
    // per packet × 4 packets per tune). Tracks drift faster than the
    // earlier α = 1/16, but still ignores per-packet arrival jitter.
    this.writableLenEma = this.writableLenEma * 7 / 8 + wl / 8;
    // Target a small but non-zero backlog: TARGET. The previous v2
    // soak used a wide dead zone (LOW=2048, HIGH=16384) — the EMA
    // settled inside that band and the ratio got stuck off-axis (0.9924
    // for 12 h), eventually starving the queue into underrun. Switch
    // to a TIGHT band around TARGET + long-term pull toward baseRatio
    // so the ratio always relaxes back to the rate-conversion-only
    // operating point unless drift actively pushes it away.
    const TARGET = 6000;       // bytes (~30 ms at 96 kHz × 2 ch × 2 byte)
    const BAND   = 1500;       // ± from TARGET for active drift correction
    const STEP   = 5e-6;       // 5 ppm per tune (smaller, more stable)
    const RESTORE_STEP = 1e-6; // 1 ppm pull toward baseRatio every tune
    const MIN_RATIO = this.baseRatio * 0.999;  // ±0.1 % from base
    const MAX_RATIO = this.baseRatio * 1.001;
    let next = this.currentRatio;
    if (this.writableLenEma > TARGET + BAND) {
      next -= STEP;
    } else if (this.writableLenEma < TARGET - BAND) {
      next += STEP;
    } else {
      // In-band: nudge ratio toward baseRatio. Prevents the off-axis
      // lock-in that bit us before. If drift is real and persistent,
      // the wl will keep pushing the EMA out of band and the STEP-
      // direction correction wins over the RESTORE pull.
      if (next > this.baseRatio) next -= RESTORE_STEP;
      else if (next < this.baseRatio) next += RESTORE_STEP;
    }
    if (next < MIN_RATIO) next = MIN_RATIO;
    if (next > MAX_RATIO) next = MAX_RATIO;
    if (next !== this.currentRatio) {
      this.currentRatio = next;
      this.asrc.setRatio(next);
    }
    // TEMP debug (2026-05-20 soak v3): emit every tune. Remove once the
    // soak signs off.
    streamDeck.logger.info(`[NaudiodonOutput] asrc wl=${wl} wlEma=${this.writableLenEma.toFixed(0)} ratio=${this.currentRatio.toFixed(7)} base=${this.baseRatio.toFixed(6)}`);
  }

  write(pcm: Int16Array, muted = false): void {
    if (!this.ai) return;
    // Apply the output-stage LPF in-place BEFORE the ASRC, so the
    // resampler sees a band-limited signal (any > 22 kHz residue would
    // alias when ratio < 1 produces a slightly lower output rate).
    const lL = this.lpfL, lR = this.lpfR;
    const n = pcm.length;
    for (let i = 0; i < n; i += 2) {
      let l = pcm[i];
      let r = pcm[i + 1];
      l = lL[3].step(lL[2].step(lL[1].step(lL[0].step(l))));
      r = lR[3].step(lR[2].step(lR[1].step(lR[0].step(r))));
      pcm[i]     = l >= 32767 ? 32767 : l <= -32768 ? -32768 : (l | 0);
      pcm[i + 1] = r >= 32767 ? 32767 : r <= -32768 ? -32768 : (r | 0);
    }
    // Overflow drop: when the JS Writable's backlog blows past a sane
    // ceiling, the slow ratio-control loop can't catch up by itself —
    // it can only nudge writer rate by 50 ppm per tune. Dropping the
    // current PCM buffer is a coarse but effective brake: ~36 ms of
    // skipped audio (one packet at 114 kHz × 4096 frames) is well below
    // the lip-sync threshold and prevents minutes-long queue creep
    // that pushes audio output behind the user's dial by seconds.
    // Equivalent to SDR++'s packer-overflow drop, just at the sink edge
    // instead of inside a dedicated ring buffer.
    const ai = this.ai as { writableLength?: number; write: (b: Buffer) => void };
    const OVERFLOW_DROP = 16384 * 8;  // 8 buffers worth ≈ 290 ms backlog
    if ((ai.writableLength ?? 0) > OVERFLOW_DROP) {
      // Skip the write entirely. Bias the tune timer so the ratio loop
      // sees the overflow and reacts on the next call.
      this.writesSinceTune = 4;
      return;
    }
    // ASRC: drift compensation. Ratio is tuned in updateAsrcRatio() once
    // every TUNE_INTERVAL writes; this call just resamples at the
    // currently-active ratio. With ratio = 1.0 the output is sample-
    // identical to the input (libsamplerate has a fast-path for 1.0).
    const out = this.asrc ? this.asrc.process(pcm) : pcm;
    ai.write(Buffer.from(out.buffer, out.byteOffset, out.byteLength));
    // Skip ratio tuning during muted buffers — the writableLength signal
    // we sample for drift detection only reflects real writer/reader
    // imbalance when audio is actually flowing. Mute periods (startup,
    // preset retune, gain change) push zero PCM whose queue behaviour
    // is dominated by the mute window's own dynamics, not by the
    // crystal mismatch we're trying to track. Also reset the EMA
    // counter on the FIRST muted write of a run so that we don't keep
    // averaging in stale post-unmute samples that were collected just
    // before muteUntil flipped.
    if (muted) {
      this.writesSinceTune = 0;
      this.writableLenEma = 0;
      return;
    }
    // 4 writes ≈ 150 ms tune cadence at 4096-sample packets / 114 kHz —
    // 4× faster than the original 16-write interval so the integral
    // control can chase ppm-scale drift before the queue creeps.
    const TUNE_INTERVAL = 4;
    if (++this.writesSinceTune >= TUNE_INTERVAL) {
      this.writesSinceTune = 0;
      this.updateAsrcRatio();
    }
  }

  async stop(): Promise<void> {
    try { (this.ai as { quit?: () => void } | null)?.quit?.(); } catch {}
    this.ai = null;
    this.asrc = null;
  }
}
