// Picking the source from a list, each source with its own address — the SDR++
// arrangement, and the same rules as RadioConfig.selectSource / setAddress in
// the Swift app (Tests/RtlTcpTests.swift checks the same cases there).
//
// Why: with one address for both, going from the HF+ (SpyServer, 8888) to the
// V4 (rtl_tcp, 8890) meant retyping the port each way, and a SpyServer
// handshake sent at rtl_tcp is not refused but read as commands — one of them
// retunes the device to 0 Hz.

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { switchSource, fileAddress, type ServerAddress } from '../src/iqClient.js';
import { startPlugin, type MockHarness } from './harness/streamDeckMock.js';

const HF: ServerAddress = { host: '192.168.0.143', port: 8888, source: 'spyserver', sourceAddrs: {} };

describe('switchSource / fileAddress', () => {
  it('a source never used keeps the host and takes rtl_tcp\'s port', () => {
    const a = switchSource(HF, 'rtltcp');
    expect(a).toMatchObject({ host: '192.168.0.143', port: 8890, source: 'rtltcp' });
    expect(a.sourceAddrs.spyserver).toEqual({ host: '192.168.0.143', port: 8888 });
  });
  it('going back brings SpyServer\'s own address back', () => {
    const b = switchSource(switchSource(HF, 'rtltcp'), 'spyserver');
    expect(b).toMatchObject({ host: '192.168.0.143', port: 8888, source: 'spyserver' });
  });
  it('an address typed while on a source is that source\'s', () => {
    let a = fileAddress(HF, undefined, 5555);
    a = switchSource(switchSource(a, 'rtltcp'), 'spyserver');
    expect(a.port).toBe(5555);
    expect(a.sourceAddrs.rtltcp).toEqual({ host: '192.168.0.143', port: 8890 });
  });
  it('choosing the source in force changes nothing', () => {
    expect(switchSource(HF, 'spyserver')).toMatchObject({ host: HF.host, port: 8888 });
  });
  it('does not touch the value it is given', () => {
    const before = JSON.stringify(HF);
    switchSource(HF, 'rtltcp');
    fileAddress(HF, 'x', 1);
    expect(JSON.stringify(HF)).toBe(before);
  });
});

let harness: MockHarness | null = null;
afterEach(async () => { if (harness) { await harness.shutdown(); harness = null; } });

describe('the Property Inspector Source list, through the running plugin', () => {
  it('swaps the address with the source, answers the PI, and files typed ports', async () => {
    const UUID = 'com.hogehoge.deck-rx.dial-tune';
    const CTX = 'ctx-source-select';
    harness = await startPlugin({
      config: { enabled: false, audioEnabled: false, host: '192.168.0.143', port: 8888, source: 'spyserver' },
    });
    await harness.willAppearDial(UUID, CTX, { mode: 'vfo', stepHz: 9000, borderSide: 'none' });
    harness.showPropertyInspector(UUID, CTX);
    const disk = () => JSON.parse(readFileSync(harness!.configPath, 'utf8'));

    const reply = harness.awaitMessage<{ payload: { action: string; host: string; port: number; source: string } }>(
      (m) => (m as { payload?: { action?: string } }).payload?.action === 'serverConfig', 5000);
    harness.sendToPlugin(UUID, CTX, { action: 'setServerConfig', source: 'rtltcp' });
    const r = await reply;
    expect(r.payload).toMatchObject({ host: '192.168.0.143', port: 8890, source: 'rtltcp' });
    await harness.settle(300);
    expect(disk()).toMatchObject({ host: '192.168.0.143', port: 8890, source: 'rtltcp' });
    expect(disk().sourceAddrs.spyserver).toEqual({ host: '192.168.0.143', port: 8888 });

    // A typed port lands on the source in force.
    harness.sendToPlugin(UUID, CTX, { action: 'setServerConfig', port: 8891 });
    await harness.settle(300);
    expect(disk().sourceAddrs.rtltcp).toEqual({ host: '192.168.0.143', port: 8891 });

    harness.sendToPlugin(UUID, CTX, { action: 'setServerConfig', source: 'spyserver' });
    await harness.settle(300);
    expect(disk()).toMatchObject({ port: 8888, source: 'spyserver' });
    harness.sendToPlugin(UUID, CTX, { action: 'setServerConfig', source: 'rtltcp' });
    await harness.settle(300);
    expect(disk()).toMatchObject({ port: 8891, source: 'rtltcp' });
  }, 30_000);
});
