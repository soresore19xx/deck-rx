import { EventEmitter } from 'events';
import net from 'net';
import { ComplexFirLpf } from './dspFilters.js';
import {
  DEVICE_RTLSDR,
  SETTING_GAIN,
  SETTING_IQ_DECIMATION,
  SETTING_IQ_DIGITAL_GAIN,
  SETTING_IQ_FREQUENCY,
  SETTING_STREAMING_ENABLED,
  type DeviceInfo,
  type IQPacket,
  type SyncInfo,
} from './SpyClient.js';
import type { IQClient } from './iqClient.js';

/**
 * rtl_tcp client, presented to spyService as an IQClient.
 *
 * Why this exists next to SpyClient: SpyServer's RTL-SDR support is thin. It
 * never calls rtlsdr_set_tuner_gain_mode or rtlsdr_set_agc_mode (neither
 * symbol is in the binary), and it needs a minimum_frequency line in its
 * config before it will tune an RTL below 24 MHz at all. rtl_tcp is what the
 * RTL-SDR world actually uses and it exposes the device's own controls,
 * including gain *by index* — which is what this plugin has always stored.
 *
 * Two things rtl_tcp does not have, and how they are covered here:
 *
 *   - **No device/sync messages.** The whole handshake is 12 bytes: "RTL0",
 *     the tuner type, and the number of gain steps. DeviceInfo and SyncInfo
 *     are synthesised from that plus what we know about the hardware.
 *
 *   - **No server-side decimation.** SpyServer hands out an already-decimated
 *     stream; rtl_tcp hands out whatever the RTL2832U is clocked at. The
 *     requested IQ rate is met by asking the device for the lowest *native*
 *     rate that is a power-of-two multiple of it, then halving the rest here.
 *     In practice the plugin's stored decimation for this receiver lands on
 *     300 kS/s, which is native, so nothing is filtered at all.
 *
 * Levels are kept interchangeable with the SpyServer path: 8-bit samples are
 * scaled to int16 and the same decimation digital gain SpyServer would have
 * applied is applied here, so a stored gain index sounds the same through
 * either client.
 */

// --- rtl_tcp wire protocol -------------------------------------------------

const RTL_HEADER_SIZE = 12;
const RTL_MAGIC = 'RTL0';

const RTL_SET_FREQ            = 0x01;
const RTL_SET_SAMPLE_RATE     = 0x02;
const RTL_SET_GAIN_MODE       = 0x03;
const RTL_SET_AGC_MODE        = 0x08;
const RTL_SET_TUNER_GAIN_INDEX = 0x0d;

/** Tuner type ids reported in the rtl_tcp header. */
export const RTL_TUNER_NAMES: Record<number, string> = {
  0: 'unknown', 1: 'E4000', 2: 'FC0012', 3: 'FC0013',
  4: 'FC2580', 5: 'R820T', 6: 'R828D',
};

/**
 * The RTL2832U's two usable sample-rate windows. Anything between them or
 * outside them is rejected by librtlsdr (or produces dropped samples).
 */
export function isValidRtlRate(hz: number): boolean {
  return (hz >= 225001 && hz <= 300000) || (hz >= 900001 && hz <= 3200000);
}

/**
 * Pick a native device rate for a requested IQ rate, plus the power-of-two
 * decimation left to do here.
 *
 * The lowest rate in the *upper* window (900 kS/s and up), not the lowest rate
 * overall. This first chose the lowest rate that worked, to keep the LAN light
 * (300 kS/s is 600 kB/s), and that was the wrong economy: rtl_tcp forwards
 * librtlsdr's 256 KB buffers whole, so at 300 kS/s the stream arrives as one
 * 0.44 s lurch every 0.44 s. Downstream that meant a spectrum updating twice a
 * second, audio running dry between lurches, and — once the client smoothed
 * them — a retune that took half a second to be heard (2026-09-24). At
 * 1.2 MS/s the same buffer is 0.11 s. SDR++'s rtl_tcp source defaults to
 * 2.4 MS/s for the same reason; 2.4 MB/s is nothing on a wired LAN.
 */
export const RTL_MIN_DEVICE_RATE = 900001;

export function planRtlRate(targetRate: number): { deviceRate: number; decimation: number } {
  if (targetRate >= 3200000) return { deviceRate: 3200000, decimation: 1 };
  for (let m = 1; m <= 64; m *= 2) {
    const rate = targetRate * m;
    if (rate > 3200000) break;
    if (rate >= RTL_MIN_DEVICE_RATE && isValidRtlRate(rate)) return { deviceRate: rate, decimation: m };
  }
  // Nothing lands on a native rate (a target that is not a clean divisor of
  // one). Take the lowest window and decimate to the nearest whole factor —
  // the IQ rate is then approximate, which the caller sees in the SyncInfo.
  const m = Math.max(1, Math.pow(2, Math.round(Math.log2(960000 / targetRate))));
  return { deviceRate: 960000, decimation: m };
}

/** dB → linear amplitude. */
function dbToLin(db: number): number {
  return Math.pow(10, db / 20);
}

/**
 * Cascade of halving low-pass stages. Each stage runs at half the rate of the
 * one before it, so the total cost is under twice the first stage rather than
 * the single-shot FIR's cost at the full input rate.
 */
class HalvingDecimator {
  private stages: ComplexFirLpf[] = [];
  private counters: number[] = [];

  configure(deviceRate: number, factor: number): void {
    this.stages = [];
    this.counters = [];
    const n = Math.max(0, Math.round(Math.log2(Math.max(1, factor))));
    // The band the last stage keeps. Earlier stages only have to stop what
    // would fold INTO it, which leaves them a wide transition and a short
    // filter — the difference between 31 taps and 70-odd at 1.2 MS/s.
    const pass = (deviceRate / Math.pow(2, n)) * 0.40;
    let rate = deviceRate;
    for (let s = 0; s < n; s++) {
      const out = rate / 2;
      const f = new ComplexFirLpf();
      if (s === n - 1) {
        // Passband to 0.40 of the output rate, stopband from 0.475 — aliasing
        // folds at 0.5, and the demodulator only ever uses the middle of the
        // band, so there is no reason to pay for a sharper skirt.
        f.setLowPass(rate, out * 0.40, out * 0.15);
      } else {
        // Flat to `pass`, stopped from `out - pass` (what folds onto ±pass).
        f.setLowPass(rate, out / 2, Math.max(out * 0.15, out - 2 * pass));
      }
      this.stages.push(f);
      this.counters.push(0);
      rate = out;
    }
  }

  /** Feed one input sample; `out` is called only when a sample survives. */
  process(i: number, q: number, out: (i: number, q: number) => void): void {
    let si = i;
    let sq = q;
    for (let s = 0; s < this.stages.length; s++) {
      const f = this.stages[s];
      f.step(si, sq);
      this.counters[s] = (this.counters[s] + 1) & 1;
      if (this.counters[s] !== 0) return;   // drop the odd samples
      si = f.lastI;
      sq = f.lastQ;
    }
    out(si, sq);
  }
}

export class RtlTcpClient extends EventEmitter implements IQClient {
  private socket: net.Socket | null = null;
  private buf = Buffer.alloc(0);
  private intentionalClose = false;
  private gotHeader = false;

  // Same dead-connection watchdog as SpyClient: rtl_tcp streams continuously
  // once connected, so silence is unambiguous.
  private lastRxMs = 0;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly WATCHDOG_TIMEOUT_MS = 5000;
  private static readonly WATCHDOG_INTERVAL_MS = 1000;

  // rtl_tcp has no "stop" command — it streams from the moment it accepts the
  // socket until the socket closes. Streaming off means we stop forwarding.
  private streaming = false;
  private streamedOnce = false;

  private info: DeviceInfo | null = null;
  private decStage = 0;
  private digitalGainDb = 0;
  private gainIndex = 0;
  private freqHz = 0;
  private deviceRate = 0;
  private decimation = 1;
  private readonly decimator = new HalvingDecimator();

  /**
   * Samples that arrive before this are dropped. A sample-rate command takes
   * effect at the server the moment it lands, but whatever was already in
   * rtl_tcp's buffers and in flight on the socket is at the *old* rate — about
   * 150 ms of it, measured going from the service's 2.4 MS/s start rate down
   * to 300 kS/s. Handing that to the demodulator feeds it samples that mean a
   * different span of time than it thinks, which is a burst of noise at every
   * band change. There is no marker in the stream for where the new rate
   * begins, so the only defence is to wait out the transit.
   */
  private flushUntilMs = 0;
  /** Default settle window. Injectable so tests can drive the client without waiting. */
  static readonly RATE_SETTLE_MS = 400;
  private readonly rateSettleMs: number;

  constructor(opts: { rateSettleMs?: number } = {}) {
    super();
    this.rateSettleMs = opts.rateSettleMs ?? RtlTcpClient.RATE_SETTLE_MS;
  }

  /** int16 output buffer, reused across chunks to keep the GC out of the path. */
  private out = Buffer.alloc(0);

  /** Base sample rate this client claims, so decimation maths matches SpyServer's. */
  static readonly MAX_SAMPLE_RATE = 2_400_000;

  connect(host: string, port: number, timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      this.intentionalClose = false;
      this.gotHeader = false;
      this.buf = Buffer.alloc(0);
      const sock = new net.Socket();
      let settled = false;
      const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
      const onErr = (e: Error) => settle(() => { try { sock.destroy(); } catch {} reject(e); });
      sock.once('error', onErr);
      // Explicit TCP-connect timeout, for the same reason SpyClient has one:
      // an unreachable host would otherwise block for the OS SYN-retry period.
      const timer = setTimeout(() => {
        settle(() => { try { sock.destroy(); } catch {} reject(new Error(`TCP connect timeout (${timeoutMs} ms)`)); });
      }, timeoutMs);
      sock.connect(port, host, () => {
        clearTimeout(timer);
        settle(() => {
          sock.off('error', onErr);
          this.socket = sock;
          this.lastRxMs = Date.now();
          sock.on('data', (c: Buffer) => this.onData(c));
          sock.on('error', (e: Error) => this.emit('error', e));
          sock.on('close', () => {
            this.stopWatchdog();
            if (!this.intentionalClose) this.emit('disconnect');
          });
          this.startWatchdog();
          resolve();
        });
      });
    });
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.streaming = false;
    this.stopWatchdog();
    this.socket?.destroy();
    this.socket = null;
    this.buf = Buffer.alloc(0);
  }

  /**
   * SpyServer's settings vocabulary, translated. Settings that have no rtl_tcp
   * equivalent (IQ format, streaming mode) are accepted and ignored: the
   * format is always 8-bit here and always converted to int16 on the way out.
   */
  setSetting(setting: number, value: number): void {
    switch (setting) {
      case SETTING_IQ_DECIMATION:
        this.decStage = value;
        break;
      case SETTING_IQ_DIGITAL_GAIN:
        this.digitalGainDb = value;
        break;
      case SETTING_IQ_FREQUENCY:
        this.setFrequency(value);
        break;
      case SETTING_GAIN:
        this.applyGain(value);
        break;
      case SETTING_STREAMING_ENABLED:
        if (value) this.startStream();
        else this.streaming = false;
        break;
      default:
        break;
    }
  }

  setFrequency(hz: number): void {
    this.freqHz = hz >>> 0;
    this.sendCmd(RTL_SET_FREQ, this.freqHz);
    this.emitSync();
  }

  stopStreaming(): void {
    this.streaming = false;
  }

  // --- internals -----------------------------------------------------------

  private applyGain(index: number): void {
    const max = this.info ? this.info.maxGainIndex : index;
    this.gainIndex = Math.max(0, Math.min(max, index));
    // Order matters: librtlsdr ignores a gain until the tuner is out of AGC.
    // rtl_tcp's own `-g 0` startup flag means *automatic*, not 0.0 dB, so a
    // client that never sends these two is running on AGC without knowing it.
    this.sendCmd(RTL_SET_GAIN_MODE, 1);
    this.sendCmd(RTL_SET_AGC_MODE, 0);
    this.sendCmd(RTL_SET_TUNER_GAIN_INDEX, this.gainIndex);
    this.emitSync();
  }

  private startStream(): void {
    const target = Math.round(RtlTcpClient.MAX_SAMPLE_RATE / Math.pow(2, this.decStage));
    const plan = planRtlRate(target);
    if (plan.deviceRate !== this.deviceRate || plan.decimation !== this.decimation) {
      this.deviceRate = plan.deviceRate;
      this.decimation = plan.decimation;
      this.decimator.configure(plan.deviceRate, plan.decimation);
      this.sendCmd(RTL_SET_SAMPLE_RATE, plan.deviceRate);
      this.flushUntilMs = Date.now() + this.rateSettleMs;
    }
    // Re-assert frequency and gain: a reconnect gets a fresh rtl_tcp session
    // that remembers nothing, and the service only sets them once per start.
    if (this.freqHz > 0) this.sendCmd(RTL_SET_FREQ, this.freqHz);
    this.sendCmd(RTL_SET_GAIN_MODE, 1);
    this.sendCmd(RTL_SET_AGC_MODE, 0);
    this.sendCmd(RTL_SET_TUNER_GAIN_INDEX, this.gainIndex);
    this.streaming = true;
    this.streamedOnce = true;
  }

  private sendCmd(cmd: number, param: number): void {
    if (!this.socket?.writable) return;
    const b = Buffer.alloc(5);
    b.writeUInt8(cmd & 0xff, 0);
    b.writeUInt32BE(param >>> 0, 1);
    this.socket.write(b);
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    this.watchdogTimer = setInterval(() => {
      if (!this.streamedOnce) return;          // nothing is expected yet
      if (Date.now() - this.lastRxMs > RtlTcpClient.WATCHDOG_TIMEOUT_MS) {
        this.stopWatchdog();
        try { this.socket?.destroy(); } catch {}
        this.socket = null;
        if (!this.intentionalClose) this.emit('disconnect');
      }
    }, RtlTcpClient.WATCHDOG_INTERVAL_MS);
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) { clearInterval(this.watchdogTimer); this.watchdogTimer = null; }
  }

  private onData(chunk: Buffer): void {
    this.lastRxMs = Date.now();
    if (!this.gotHeader) {
      this.buf = Buffer.concat([this.buf, chunk]);
      if (this.buf.length < RTL_HEADER_SIZE) return;
      const hdr = this.buf.subarray(0, RTL_HEADER_SIZE);
      this.buf = this.buf.subarray(RTL_HEADER_SIZE);
      this.gotHeader = true;
      this.handleHeader(hdr);
      if (this.buf.length === 0) return;
      chunk = this.buf;
      this.buf = Buffer.alloc(0);
    }
    if (!this.streaming) return;
    this.emitIq(chunk);
  }

  private handleHeader(hdr: Buffer): void {
    const magic = hdr.subarray(0, 4).toString('ascii');
    if (magic !== RTL_MAGIC) {
      this.emit('error', new Error(`not an rtl_tcp server (magic ${JSON.stringify(magic)})`));
      return;
    }
    const tunerType = hdr.readUInt32BE(4);
    const gainCount = hdr.readUInt32BE(8);
    this.info = {
      deviceType: DEVICE_RTLSDR,
      // rtl_tcp does not carry a serial. Zero is what SpyServer reported for
      // this hardware too, so the per-receiver profile key ("3:00000000")
      // is the same through either client and stored settings carry over.
      deviceSerial: 0,
      maxSampleRate: RtlTcpClient.MAX_SAMPLE_RATE,
      maxBandwidth: RtlTcpClient.MAX_SAMPLE_RATE,
      // 2.4 MS/s down to 18.75 kS/s, matching what the rate planner can reach.
      decimationStages: 7,
      gainStages: gainCount,
      maxGainIndex: Math.max(0, gainCount - 1),
      // The Blog V4 reaches the broadcast bands through its own upconverter,
      // so the floor is not the bare tuner's 24 MHz.
      minFrequency: 0,
      maxFrequency: 1_766_000_000,
      resolution: 8,
      minIQDecimation: 0,
      forcedIQFormat: 0,
    };
    this.emit('deviceInfo', this.info);
    this.emitSync();
  }

  private emitSync(): void {
    if (!this.info) return;
    const sync: SyncInfo = {
      // rtl_tcp gives every client full control of the device, and the last
      // command wins. There is no "another client owns this" state to report.
      canControl: true,
      gain: this.gainIndex,
      deviceCenterFreq: this.freqHz,
      iqCenterFreq: this.freqHz,
      fftCenterFreq: this.freqHz,
      minIQCenterFreq: this.info.minFrequency,
      maxIQCenterFreq: this.info.maxFrequency,
    };
    this.emit('sync', sync);
  }

  /**
   * 8-bit unsigned IQ in, int16 IQ out, with the decimation digital gain
   * SpyServer would have applied. Odd-length chunks are impossible from
   * rtl_tcp (it writes whole IQ pairs) but a TCP read can split one, so a
   * trailing byte is carried into the next chunk.
   */
  private emitIq(chunk: Buffer): void {
    if (Date.now() < this.flushUntilMs) {
      // Still draining samples taken at the previous rate. Drop them, and drop
      // the half-pair carry with them so the next real sample starts on I.
      this.buf = Buffer.alloc(0);
      return;
    }
    if (this.buf.length > 0) {
      chunk = Buffer.concat([this.buf, chunk]);
      this.buf = Buffer.alloc(0);
    }
    const pairs = chunk.length >> 1;
    if (pairs === 0) { this.buf = chunk; return; }
    if (chunk.length & 1) {
      this.buf = chunk.subarray(chunk.length - 1);
      chunk = chunk.subarray(0, chunk.length - 1);
    }
    // 8 bits to 16, then the same digital gain SpyServer applies for the
    // decimation in force, so a stored gain index sounds the same either way.
    const scale = 256 * dbToLin(this.digitalGainDb);
    const maxOut = (pairs / this.decimation + 2) * 4;
    if (this.out.length < maxOut) this.out = Buffer.alloc(maxOut);
    let o = 0;
    const write = (i: number, q: number) => {
      this.out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(i))), o);
      this.out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(q))), o + 2);
      o += 4;
    };
    if (this.decimation === 1) {
      for (let n = 0; n < pairs; n++) {
        write((chunk[n * 2] - 127.5) * scale, (chunk[n * 2 + 1] - 127.5) * scale);
      }
    } else {
      for (let n = 0; n < pairs; n++) {
        this.decimator.process(
          (chunk[n * 2] - 127.5) * scale,
          (chunk[n * 2 + 1] - 127.5) * scale,
          write,
        );
      }
    }
    if (o === 0) return;
    this.emit('iqData', {
      format: 'int16',
      body: Buffer.from(this.out.subarray(0, o)),
      // SpyServer reports the gain the stream was produced at in the message
      // header; rtl_tcp has no such field, so report what we asked for.
      gainDb: this.gainIndex,
    } as IQPacket);
  }
}
