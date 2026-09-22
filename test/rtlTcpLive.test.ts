import { describe, it, expect } from 'vitest';
import { RtlTcpClient } from '../src/RtlTcpClient.js';
import {
  SETTING_GAIN, SETTING_IQ_DECIMATION, SETTING_IQ_DIGITAL_GAIN,
  SETTING_IQ_FREQUENCY, SETTING_STREAMING_ENABLED,
  computeDigitalGain, DEVICE_RTLSDR,
  type DeviceInfo, type IQPacket,
} from '../src/SpyClient.js';

/**
 * Opt-in live check against a real rtl_tcp server. Skipped unless
 * DECK_RX_RTLTCP_HOST is set, so the normal `npm test` run stays offline:
 *
 *   DECK_RX_RTLTCP_HOST=192.168.0.143 DECK_RX_RTLTCP_PORT=1234 \
 *     npx vitest run test/rtlTcpLive.test.ts
 *
 * It only receives — no gain or frequency is left changed that the next client
 * to connect would not set for itself anyway.
 */
const HOST = process.env.DECK_RX_RTLTCP_HOST;
const PORT = Number(process.env.DECK_RX_RTLTCP_PORT ?? 1234);
const FREQ = Number(process.env.DECK_RX_RTLTCP_FREQ ?? 810_000);

describe.skipIf(!HOST)('rtl_tcp, against the real server', () => {
  it('handshakes, streams, and produces IQ at the requested rate', async () => {
    const c = new RtlTcpClient();
    const info = await new Promise<DeviceInfo>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no deviceInfo in 5 s')), 5000);
      c.once('deviceInfo', (i: DeviceInfo) => { clearTimeout(t); resolve(i); });
      c.connect(HOST as string, PORT).catch(reject);
    });

    expect(info.deviceType).toBe(DEVICE_RTLSDR);
    expect(info.maxGainIndex).toBeGreaterThan(0);

    const decStage = 3;   // 2.4 MS/s >> 3 = 300 kS/s, a native RTL rate
    const gain = 0;
    c.setSetting(SETTING_IQ_DECIMATION, decStage);
    c.setSetting(SETTING_IQ_FREQUENCY, FREQ);
    c.setSetting(SETTING_GAIN, gain);
    c.setSetting(SETTING_IQ_DIGITAL_GAIN,
      computeDigitalGain(info.deviceType, gain, decStage, info.maxGainIndex));
    c.setSetting(SETTING_STREAMING_ENABLED, 1);

    // Let the client's rate-settle window pass before timing anything: the
    // first samples after a rate change were taken at the old rate, and the
    // client drops them rather than passing them on.
    await new Promise<void>((r) => setTimeout(r, 1000));
    // Timed from the first packet's arrival to the last, not over a fixed wall
    // window: rtl_tcp delivers in bursts, and a fixed window clips a partial
    // burst at each end. That alone read 87 % of the true rate over 2 s and
    // 95 % over 6 s against a server independently measured at 99.2 %.
    const SECONDS = 6;
    const packets: IQPacket[] = [];
    let tFirst = 0;
    let tLast = 0;
    await new Promise<void>((resolve) => {
      c.on('iqData', (p: IQPacket) => {
        const now = performance.now();
        if (!tFirst) tFirst = now;
        tLast = now;
        packets.push(p);
      });
      setTimeout(resolve, SECONDS * 1000);
    });
    c.disconnect();

    expect(packets.length).toBeGreaterThan(1);
    expect(packets[0].format).toBe('int16');

    const body = Buffer.concat(packets.map((p) => p.body));
    // The first packet's samples were taken before tFirst, so they are not
    // part of the interval being timed.
    const pairs = (body.length - packets[0].body.length) / 4;
    const rate = pairs / ((tLast - tFirst) / 1000);
    // Within 15 %. This estimator cannot do better: rtl_tcp's bursts arrive as
    // several socket reads a few microseconds apart, so the arrival times
    // bracket a slightly different span than the samples do, and the answer
    // wobbles by about 6 % either way between runs. The rate itself was pinned
    // separately at 99.2 % of the request, by counting bytes over 8 s against
    // a clock. What this assertion is for is the gross failure — the device
    // ignoring the rate command and staying at 2.4 MS/s, which is 8× out.
    expect(rate).toBeGreaterThan(300_000 * 0.85);
    expect(rate).toBeLessThan(300_000 * 1.15);

    // The carrier has to be somewhere: a stream of zeros or of rails would
    // both pass a length check. Report the levels so the run is readable.
    let peak = 0;
    let sumsq = 0;
    for (let i = 0; i < body.length; i += 2) {
      const v = body.readInt16LE(i);
      peak = Math.max(peak, Math.abs(v));
      sumsq += v * v;
    }
    const n = body.length / 2;
    const rms = Math.sqrt(sumsq / n);
    const dbfs = (x: number) => 20 * Math.log10(Math.max(x, 1) / 32767);
    // eslint-disable-next-line no-console
    console.log(`  rtl_tcp live: ${(rate / 1000).toFixed(1)} kS/s  `
      + `peak ${dbfs(peak).toFixed(1)} dBFS  rms ${dbfs(rms).toFixed(1)} dBFS  `
      + `gain index ${gain}  tuner gains ${info.gainStages}`);
    expect(peak).toBeGreaterThan(0);        // not a dead stream
    expect(peak).toBeLessThan(32767);       // not pinned at the rail
  }, 20_000);
});
