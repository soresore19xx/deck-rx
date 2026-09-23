import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import {
  RtlTcpClient, isValidRtlRate, planRtlRate, RTL_TUNER_NAMES,
} from '../src/RtlTcpClient.js';
import { asIQSource, defaultPort } from '../src/iqClient.js';
import {
  DEVICE_RTLSDR, SETTING_GAIN, SETTING_IQ_DECIMATION, SETTING_IQ_DIGITAL_GAIN,
  SETTING_IQ_FREQUENCY, SETTING_STREAMING_ENABLED,
  type DeviceInfo, type IQPacket, type SyncInfo,
} from '../src/SpyClient.js';
import { deviceKey } from '../src/deviceSettings.js';

/**
 * A stand-in for the TCP socket, so the protocol can be exercised without a
 * receiver. `written` accumulates the 5-byte commands the client sends.
 */
class FakeSocket extends EventEmitter {
  written: Buffer[] = [];
  writable = true;
  write(b: Buffer): boolean { this.written.push(Buffer.from(b)); return true; }
  destroy(): void { this.writable = false; }
  /** The commands sent so far, decoded. */
  cmds(): Array<{ cmd: number; param: number }> {
    return this.written
      .filter((b) => b.length === 5)
      .map((b) => ({ cmd: b.readUInt8(0), param: b.readUInt32BE(1) }));
  }
  last(cmd: number): number | undefined {
    const hits = this.cmds().filter((c) => c.cmd === cmd);
    return hits.length ? hits[hits.length - 1].param : undefined;
  }
}

/** Attach a client to a fake socket, skipping connect()'s real networking. */
function attach(client: RtlTcpClient): FakeSocket {
  const sock = new FakeSocket();
  // The private fields are what connect() would have set on a live socket.
  (client as unknown as { socket: FakeSocket }).socket = sock;
  return sock;
}

function header(tunerType: number, gainCount: number): Buffer {
  const b = Buffer.alloc(12);
  b.write('RTL0', 0, 'ascii');
  b.writeUInt32BE(tunerType, 4);
  b.writeUInt32BE(gainCount, 8);
  return b;
}

function feed(client: RtlTcpClient, chunk: Buffer): void {
  (client as unknown as { onData(c: Buffer): void }).onData(chunk);
}

const RTL_SET_FREQ = 0x01;
const RTL_SET_SAMPLE_RATE = 0x02;
const RTL_SET_GAIN_MODE = 0x03;
const RTL_SET_AGC_MODE = 0x08;
const RTL_SET_TUNER_GAIN_INDEX = 0x0d;

describe('RTL sample-rate windows', () => {
  it('accepts only the two windows librtlsdr supports', () => {
    expect(isValidRtlRate(225000)).toBe(false);   // just below the low window
    expect(isValidRtlRate(250000)).toBe(true);
    expect(isValidRtlRate(300000)).toBe(true);
    expect(isValidRtlRate(600000)).toBe(false);   // the gap between windows
    expect(isValidRtlRate(900000)).toBe(false);
    expect(isValidRtlRate(1200000)).toBe(true);
    expect(isValidRtlRate(2400000)).toBe(true);
    expect(isValidRtlRate(3300000)).toBe(false);
  });
});

describe('planRtlRate', () => {
  // Not natively any more: at 300 kS/s rtl_tcp's 256 KB buffers arrive as one
  // 0.44 s lurch every 0.44 s (2026-09-24). The device runs in the upper
  // window and the rest is halved here.
  it('meets 300 kS/s from 1.2 MS/s, not natively', () => {
    expect(planRtlRate(300000)).toEqual({ deviceRate: 1200000, decimation: 4 });
  });
  it('never runs the device below the upper window', () => {
    for (let stage = 0; stage <= 7; stage++) {
      const target = Math.round(RtlTcpClient.MAX_SAMPLE_RATE / Math.pow(2, stage));
      expect(planRtlRate(target).deviceRate).toBeGreaterThanOrEqual(900001);
    }
  });

  it('covers every decimation stage the client advertises', () => {
    const seen = new Map<number, { deviceRate: number; decimation: number }>();
    for (let stage = 0; stage <= 7; stage++) {
      const target = Math.round(RtlTcpClient.MAX_SAMPLE_RATE / Math.pow(2, stage));
      const plan = planRtlRate(target);
      seen.set(stage, plan);
      expect(isValidRtlRate(plan.deviceRate)).toBe(true);
      // The plan must actually produce the requested rate.
      expect(plan.deviceRate / plan.decimation).toBe(target);
      // Decimation is done by halving stages, so it has to be a power of two.
      expect(Math.log2(plan.decimation) % 1).toBe(0);
    }
    // Rates in the gap between the two windows are reached from above.
    expect(seen.get(2)).toEqual({ deviceRate: 1200000, decimation: 2 });
    expect(seen.get(4)).toEqual({ deviceRate: 1200000, decimation: 8 });
  });

  it('takes the lowest rate in the upper window', () => {
    // 150 kS/s is reachable from 1.2 M (×8) or 2.4 M (×16). The lighter wins.
    expect(planRtlRate(150000).deviceRate).toBe(1200000);
  });

  it('clamps above the device maximum', () => {
    expect(planRtlRate(4000000)).toEqual({ deviceRate: 3200000, decimation: 1 });
  });
});

describe('handshake', () => {
  it('synthesises a DeviceInfo whose profile key matches the SpyServer one', () => {
    const c = new RtlTcpClient({ rateSettleMs: 0 });
    let info: DeviceInfo | null = null;
    c.on('deviceInfo', (i: DeviceInfo) => { info = i; });
    attach(c);
    feed(c, header(6, 29));   // R828D, 29 gain steps — the Blog V4
    expect(info).not.toBeNull();
    const got = info as unknown as DeviceInfo;
    expect(got.deviceType).toBe(DEVICE_RTLSDR);
    // The key the per-receiver profile is stored under. rtl_tcp carries no
    // serial and SpyServer reported zero for this hardware, so settings saved
    // through one client are found by the other.
    expect(deviceKey(got.deviceType, got.deviceSerial)).toBe('3:00000000');
    expect(got.maxGainIndex).toBe(28);
    expect(got.minIQDecimation).toBe(0);
    expect(got.maxSampleRate).toBe(RtlTcpClient.MAX_SAMPLE_RATE);
    expect(RTL_TUNER_NAMES[6]).toBe('R828D');
  });

  it('emits a sync that grants control — rtl_tcp has no exclusive owner', () => {
    const c = new RtlTcpClient({ rateSettleMs: 0 });
    let sync: SyncInfo | null = null;
    c.on('sync', (s: SyncInfo) => { sync = s; });
    attach(c);
    feed(c, header(6, 29));
    expect((sync as unknown as SyncInfo).canControl).toBe(true);
  });

  it('reports an error rather than decoding garbage when the magic is wrong', () => {
    const c = new RtlTcpClient({ rateSettleMs: 0 });
    const errs: Error[] = [];
    c.on('error', (e: Error) => errs.push(e));
    attach(c);
    const bad = Buffer.alloc(12);
    bad.write('HTTP', 0, 'ascii');
    feed(c, bad);
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toMatch(/not an rtl_tcp server/);
  });
});

describe('settings translation', () => {
  it('leaves the tuner AGC before setting a gain index', () => {
    // This is the whole reason the V4 moved off SpyServer: librtlsdr ignores
    // rtlsdr_set_tuner_gain() unless gain mode is manual first, and rtl_tcp's
    // own `-g 0` startup flag means *automatic*. A client that sends only the
    // index is running on AGC and the dial appears to do nothing.
    const c = new RtlTcpClient({ rateSettleMs: 0 });
    const sock = attach(c);
    feed(c, header(6, 29));
    sock.written = [];
    c.setSetting(SETTING_GAIN, 12);
    const cmds = sock.cmds();
    const modeAt = cmds.findIndex((x) => x.cmd === RTL_SET_GAIN_MODE);
    const gainAt = cmds.findIndex((x) => x.cmd === RTL_SET_TUNER_GAIN_INDEX);
    expect(modeAt).toBeGreaterThanOrEqual(0);
    expect(gainAt).toBeGreaterThan(modeAt);
    expect(cmds[modeAt].param).toBe(1);                 // manual
    expect(sock.last(RTL_SET_AGC_MODE)).toBe(0);        // RTL2832 AGC off
    expect(sock.last(RTL_SET_TUNER_GAIN_INDEX)).toBe(12);
  });

  it('clamps a gain index to what the device reported', () => {
    const c = new RtlTcpClient({ rateSettleMs: 0 });
    const sock = attach(c);
    feed(c, header(6, 29));
    c.setSetting(SETTING_GAIN, 99);
    expect(sock.last(RTL_SET_TUNER_GAIN_INDEX)).toBe(28);
    c.setSetting(SETTING_GAIN, -5);
    expect(sock.last(RTL_SET_TUNER_GAIN_INDEX)).toBe(0);
  });

  it('turns a decimation stage into a device sample rate on stream start', () => {
    const c = new RtlTcpClient({ rateSettleMs: 0 });
    const sock = attach(c);
    feed(c, header(6, 29));
    c.setSetting(SETTING_IQ_DECIMATION, 3);     // 2.4 MS/s >> 3 = 300 kS/s
    c.setSetting(SETTING_IQ_FREQUENCY, 810000);
    c.setSetting(SETTING_STREAMING_ENABLED, 1);
    expect(sock.last(RTL_SET_SAMPLE_RATE)).toBe(1200000);   // then ÷4 here
    expect(sock.last(RTL_SET_FREQ)).toBe(810000);
  });

  it('re-asserts frequency and gain on stream start, for reconnects', () => {
    // A reconnect gets a fresh rtl_tcp session that remembers nothing, and the
    // service sets frequency and gain once per start — before this, a retune
    // that happened while disconnected was silently lost.
    const c = new RtlTcpClient({ rateSettleMs: 0 });
    const sock = attach(c);
    feed(c, header(6, 29));
    c.setSetting(SETTING_IQ_FREQUENCY, 954000);
    c.setSetting(SETTING_GAIN, 7);
    sock.written = [];
    c.setSetting(SETTING_STREAMING_ENABLED, 1);
    expect(sock.last(RTL_SET_FREQ)).toBe(954000);
    expect(sock.last(RTL_SET_TUNER_GAIN_INDEX)).toBe(7);
  });
});

describe('IQ conversion', () => {
  /** Drive a whole session up to streaming and return the packets emitted. */
  function stream(decStage: number, digitalGainDb: number, body: Buffer): IQPacket[] {
    const c = new RtlTcpClient({ rateSettleMs: 0 });
    const out: IQPacket[] = [];
    c.on('iqData', (p: IQPacket) => out.push(p));
    attach(c);
    feed(c, header(6, 29));
    c.setSetting(SETTING_IQ_DECIMATION, decStage);
    c.setSetting(SETTING_IQ_DIGITAL_GAIN, digitalGainDb);
    c.setSetting(SETTING_STREAMING_ENABLED, 1);
    feed(c, body);
    return out;
  }

  it('maps 8-bit unsigned to int16, centred and scaled', () => {
    // 0 dB digital gain so the mapping is the bare 8-to-16 bit scaling.
    const p = stream(1,0, Buffer.from([255, 0, 128, 127]));
    expect(p).toHaveLength(1);
    const v = p[0].body;
    expect(p[0].format).toBe('int16');
    expect(v.readInt16LE(0)).toBe(Math.round(127.5 * 256));   // 255 -> +full
    expect(v.readInt16LE(2)).toBe(Math.round(-127.5 * 256));  // 0   -> -full
    expect(v.readInt16LE(4)).toBe(128);                       // 128 -> +0.5 LSB
    expect(v.readInt16LE(6)).toBe(-128);                      // 127 -> -0.5 LSB
  });

  it('applies the same decimation digital gain SpyServer would have', () => {
    // 9 dB is what computeDigitalGain() returns for an RTL at stage 3, and it
    // is what makes a stored gain index sound the same through either client.
    // A small sample, well clear of the rail: at 9 dB a near-full-scale one
    // clamps, which is correct behaviour but measures nothing here.
    const plain = stream(1,0, Buffer.from([140, 128]))[0].body.readInt16LE(0);
    const lifted = stream(1,9, Buffer.from([140, 128]))[0].body.readInt16LE(0);
    expect(lifted / plain).toBeCloseTo(Math.pow(10, 9 / 20), 2);
  });

  it('clamps rather than wrapping when the digital gain overdrives int16', () => {
    const v = stream(1,20, Buffer.from([255, 0]))[0].body;
    expect(v.readInt16LE(0)).toBe(32767);
    expect(v.readInt16LE(2)).toBe(-32768);
  });

  it('carries a split IQ pair across chunk boundaries', () => {
    // A TCP read can end between the I and the Q byte. Losing that byte would
    // swap I and Q for the rest of the stream.
    const c = new RtlTcpClient({ rateSettleMs: 0 });
    const out: IQPacket[] = [];
    c.on('iqData', (p: IQPacket) => out.push(p));
    attach(c);
    feed(c, header(6, 29));
    c.setSetting(SETTING_IQ_DECIMATION, 1);     // 1.2 MS/s, native: no filter
    c.setSetting(SETTING_IQ_DIGITAL_GAIN, 0);
    c.setSetting(SETTING_STREAMING_ENABLED, 1);
    feed(c, Buffer.from([255]));          // I only
    feed(c, Buffer.from([0, 128, 128]));  // its Q, then a whole pair
    const all = Buffer.concat(out.map((p) => p.body));
    expect(all.readInt16LE(0)).toBe(Math.round(127.5 * 256));
    expect(all.readInt16LE(2)).toBe(Math.round(-127.5 * 256));
    expect(all.length).toBe(8);           // two pairs, nothing dropped
  });

  it('emits nothing while streaming is off', () => {
    const c = new RtlTcpClient({ rateSettleMs: 0 });
    const out: IQPacket[] = [];
    c.on('iqData', (p: IQPacket) => out.push(p));
    attach(c);
    feed(c, header(6, 29));
    feed(c, Buffer.from([255, 0, 128, 128]));
    expect(out).toHaveLength(0);
  });

  it('decimates by the planned factor', () => {
    // Stage 4 is 150 kS/s, reached from a 1.2 MS/s device rate by halving
    // three times, so an eighth as many pairs come out as go in.
    const body = Buffer.alloc(4096, 128);
    const p = stream(4, 0, body);
    const pairsOut = p.reduce((n, x) => n + x.body.length / 4, 0);
    expect(pairsOut).toBe(body.length / 2 / 8);
  });

  it('passes the wanted band and stops what would fold into it', () => {
    // A tone well inside the final band survives the three halvings at full
    // level; one that would alias onto it is gone. Measured through the whole
    // client, 1.2 MS/s in, 150 kS/s out.
    const tone = (hz: number): number => {
      const n = 1_200_000 / 4;            // a quarter second of device samples
      const b = Buffer.alloc(n * 2);
      for (let i = 0; i < n; i++) {
        const ph = 2 * Math.PI * hz * i / 1_200_000;
        b[i * 2] = Math.round(127.5 + 60 * Math.cos(ph));
        b[i * 2 + 1] = Math.round(127.5 + 60 * Math.sin(ph));
      }
      const out = Buffer.concat(stream(4, 0, b).map((x) => x.body));
      let sq = 0, k = 0;
      for (let o = out.length / 2; o + 4 <= out.length; o += 4) {   // skip the fill
        const i = out.readInt16LE(o), q = out.readInt16LE(o + 2);
        sq += i * i + q * q; k++;
      }
      return Math.sqrt(sq / k);
    };
    const inBand = tone(30_000);
    const folds = tone(120_000);          // 150 k - 30 k: would land on -30 kHz
    expect(inBand).toBeGreaterThan(60 * 256 * 0.9);
    // 50 dB, not the filters' ~74: the input is 8-bit, and a tone of amplitude
    // 60 carries its own quantisation noise about 52 dB down once decimated
    // to 150 kS/s (43 dB over 1.2 MHz, plus 9 dB for ÷8). Measured 53.8 dB —
    // the folded tone is below that floor, which is as far as this can see.
    expect(20 * Math.log10(inBand / Math.max(folds, 1e-9))).toBeGreaterThan(50);
  });
});

describe('source selection', () => {
  it('defaults to SpyServer for every config written before rtl_tcp existed', () => {
    expect(asIQSource(undefined)).toBe('spyserver');
    expect(asIQSource('')).toBe('spyserver');
    expect(asIQSource('nonsense')).toBe('spyserver');
    expect(asIQSource('rtltcp')).toBe('rtltcp');
  });

  it('knows each protocol default port', () => {
    // Not rtl_tcp's own 1234: the V4 is served on 8890, next to the HF+'s 8888.
    expect(defaultPort('rtltcp')).toBe(8890);
    expect(defaultPort('spyserver')).toBe(5555);
  });
});

describe('rate-change settling', () => {
  it('drops the samples still in flight at the previous rate', () => {
    // rtl_tcp applies a rate command when it lands, but whatever is already in
    // its buffers and on the wire was taken at the old rate — about 150 ms of
    // it going from the service's 2.4 MS/s start rate down to 300 kS/s. Those
    // samples mean a different span of time than the demodulator thinks, and
    // there is no marker in the stream saying where the new rate begins.
    const c = new RtlTcpClient({ rateSettleMs: 10_000 });
    const out: IQPacket[] = [];
    c.on('iqData', (p: IQPacket) => out.push(p));
    attach(c);
    feed(c, header(6, 29));
    c.setSetting(SETTING_IQ_DECIMATION, 1);     // 1.2 MS/s, native: no filter
    c.setSetting(SETTING_STREAMING_ENABLED, 1);
    feed(c, Buffer.from([255, 0, 128, 128]));
    expect(out).toHaveLength(0);
  });

  it('does not settle again when the rate has not changed', () => {
    // Restarting the stream on the same rate must not blank the audio for
    // another settle window.
    const c = new RtlTcpClient({ rateSettleMs: 10_000 });
    const out: IQPacket[] = [];
    attach(c);
    feed(c, header(6, 29));
    c.setSetting(SETTING_IQ_DECIMATION, 1);     // 1.2 MS/s, native: no filter
    c.setSetting(SETTING_STREAMING_ENABLED, 1);   // first start: settles
    c.stopStreaming();
    c.on('iqData', (p: IQPacket) => out.push(p));
    // Pretend the settle has passed, then restart on the same rate.
    (c as unknown as { flushUntilMs: number }).flushUntilMs = 0;
    c.setSetting(SETTING_STREAMING_ENABLED, 1);
    feed(c, Buffer.from([255, 0, 128, 128]));
    expect(out).toHaveLength(1);
  });
});
