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

/** Default port per source, used when the config carries no port. */
export function defaultPort(source: IQSource): number {
  return source === 'rtltcp' ? 1234 : 5555;
}

/** Narrow an arbitrary config value to a source, defaulting to SpyServer. */
export function asIQSource(v: unknown): IQSource {
  return v === 'rtltcp' ? 'rtltcp' : 'spyserver';
}

export type { DeviceInfo, IQPacket, SyncInfo };
