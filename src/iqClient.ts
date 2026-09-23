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

export type { DeviceInfo, IQPacket, SyncInfo };
