import type { EventEmitter } from 'events';
import type { DeviceInfo, IQPacket, SyncInfo } from './SpyClient.js';

/**
 * The surface spyService drives a receiver through. Two implementations:
 * `SpyClient` (SpyServer protocol) and `RtlTcpClient` (rtl_tcp).
 *
 * The settings vocabulary is SpyServer's, because that came first and the
 * service speaks it everywhere. RtlTcpClient translates each setting into the
 * rtl_tcp command that means the same thing, and synthesises the DeviceInfo
 * and SyncInfo messages rtl_tcp has no equivalent for. Keeping the vocabulary
 * fixed is what lets the dials, the demodulator and the control server stay
 * unaware of which receiver is connected.
 *
 * Events, in the order a healthy session emits them:
 *   'deviceInfo' (DeviceInfo)  once, right after the handshake
 *   'sync'       (SyncInfo)    once after deviceInfo, then on any change
 *   'iqData'     (IQPacket)    continuously while streaming is enabled
 *   'error'      (Error)       socket errors
 *   'disconnect' ()            unintentional close, or watchdog timeout
 */
export interface IQClient extends EventEmitter {
  connect(host: string, port: number, timeoutMs?: number): Promise<void>;
  disconnect(): void;
  setSetting(setting: number, value: number): void;
  setFrequency(hz: number): void;
  stopStreaming(): void;
}

export type IQSource = 'spyserver' | 'rtltcp';

/**
 * Default port per source, used when the config carries no port.
 *
 * rtl_tcp's own default is 1234, but this receiver is not served on it: the V4
 * was moved to 8890 on 2026-09-23 so both receivers sit in one block next to
 * the SpyServer (8888 HF+, 8890 V4) rather than in unrelated parts of the port
 * range. A default that points at a port nothing listens on is worse than no
 * default — the connection is refused with nothing to explain why.
 */
export function defaultPort(source: IQSource): number {
  return source === 'rtltcp' ? 8890 : 5555;
}

/** Narrow an arbitrary config value to a source, defaulting to SpyServer. */
export function asIQSource(v: unknown): IQSource {
  return v === 'rtltcp' ? 'rtltcp' : 'spyserver';
}

/**
 * The address each source was last used with, the way SDR++ keeps one per
 * source module (RadioConfig.sourceAddrs on the Swift side, same shape in the
 * same file key). `host` / `port` at the top of the config are the one in
 * force. With one address for both, going from the HF+ (SpyServer, 8888) to
 * the V4 (rtl_tcp, 8890) meant retyping the port each way, and a SpyServer
 * handshake sent at rtl_tcp is not refused but read as commands — one of them
 * retunes the device to 0 Hz.
 */
export type SourceAddrs = Partial<Record<IQSource, { host: string; port: number }>>;

export interface ServerAddress {
  host: string;
  port: number;
  source: IQSource;
  sourceAddrs: SourceAddrs;
}

/**
 * Switch source, carrying each one's address with it: the one in force is
 * filed under the old source and the new source's comes back. A source never
 * used keeps the host (both receivers usually sit on one machine) and takes
 * rtl_tcp's port if it is rtl_tcp; SpyServer keeps the port in force.
 * Returns a new value; the input is not touched.
 */
export function switchSource(cur: ServerAddress, next: IQSource): ServerAddress {
  if (next === cur.source) return { ...cur, sourceAddrs: { ...cur.sourceAddrs } };
  const sourceAddrs: SourceAddrs = { ...cur.sourceAddrs, [cur.source]: { host: cur.host, port: cur.port } };
  const back = sourceAddrs[next];
  if (back) return { host: back.host, port: back.port, source: next, sourceAddrs };
  return {
    host: cur.host,
    port: next === 'rtltcp' ? defaultPort('rtltcp') : cur.port,
    source: next,
    sourceAddrs,
  };
}

/** Set the address of the source in force, and file it as that source's. */
export function fileAddress(cur: ServerAddress, host?: string, port?: number): ServerAddress {
  const h = host ?? cur.host;
  const p = port ?? cur.port;
  return { host: h, port: p, source: cur.source,
           sourceAddrs: { ...cur.sourceAddrs, [cur.source]: { host: h, port: p } } };
}

export type { DeviceInfo, IQPacket, SyncInfo };
