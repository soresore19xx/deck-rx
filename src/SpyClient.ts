import { EventEmitter } from 'events';
import net from 'net';

// Protocol version: 2.0.1700
const PROTOCOL_VERSION = (((2 << 24) | (0 << 16) | 1700) >>> 0);

// Header sizes
const CMD_HDR_SIZE = 8;
const MSG_HDR_SIZE = 20;

// Commands (client → server)
const CMD_HELLO       = 0;
const CMD_SET_SETTING = 2;

// Settings
export const SETTING_STREAMING_MODE     = 0;
export const SETTING_STREAMING_ENABLED  = 1;
export const SETTING_GAIN               = 2;
export const SETTING_IQ_FORMAT          = 100;
export const SETTING_IQ_FREQUENCY       = 101;
export const SETTING_IQ_DECIMATION      = 102;
export const SETTING_IQ_DIGITAL_GAIN    = 103;

// Streaming modes (matches STREAM_TYPE_* bitmask)
export const STREAM_MODE_IQ_ONLY = 1;

// IQ formats
export const STREAM_FORMAT_UINT8 = 1;
export const STREAM_FORMAT_INT16 = 2;
export const STREAM_FORMAT_FLOAT = 4;

// Message types (server → client)
const MSG_DEVICE_INFO = 0;
const MSG_CLIENT_SYNC = 1;
const MSG_UINT8_IQ    = 100;
const MSG_INT16_IQ    = 101;
const MSG_FLOAT_IQ    = 103;

// Device types
export const DEVICE_AIRSPY_ONE = 1;
export const DEVICE_AIRSPY_HF  = 2;
export const DEVICE_RTLSDR     = 3;

export interface DeviceInfo {
  deviceType: number;
  deviceSerial: number;
  maxSampleRate: number;
  maxBandwidth: number;
  decimationStages: number;
  gainStages: number;
  maxGainIndex: number;
  minFrequency: number;
  maxFrequency: number;
  resolution: number;
  minIQDecimation: number;
  forcedIQFormat: number;
}

export interface SyncInfo {
  canControl: boolean;
  gain: number;
  deviceCenterFreq: number;
  iqCenterFreq: number;
  fftCenterFreq: number;
  minIQCenterFreq: number;
  maxIQCenterFreq: number;
}

export interface IQPacket {
  format: 'uint8' | 'int16' | 'float';
  body: Buffer;
  gainDb: number;       // upper 16 bits of MessageType
}

export class SpyClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private buf = Buffer.alloc(0);
  private intentionalClose = false;

  connect(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.intentionalClose = false;
      const sock = new net.Socket();
      const onErr = (e: Error) => reject(e);
      sock.once('error', onErr);
      sock.connect(port, host, () => {
        sock.off('error', onErr);
        this.socket = sock;
        sock.on('data', (c: Buffer) => this.onData(c));
        sock.on('error', (e: Error) => this.emit('error', e));
        sock.on('close', () => { if (!this.intentionalClose) this.emit('disconnect'); });
        this.sendHello();
        resolve();
      });
    });
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.socket?.destroy();
    this.socket = null;
    this.buf = Buffer.alloc(0);
  }

  setSetting(setting: number, value: number): void {
    const body = Buffer.alloc(8);
    body.writeUInt32LE(setting >>> 0, 0);
    body.writeUInt32LE(value >>> 0, 4);
    this.sendCmd(CMD_SET_SETTING, body);
  }

  setFrequency(hz: number): void {
    this.setSetting(SETTING_IQ_FREQUENCY, hz >>> 0);
  }

  stopStreaming(): void {
    this.setSetting(SETTING_STREAMING_ENABLED, 0);
  }

  private sendHello(): void {
    const name = Buffer.from('SDR++');  // Match SDR++ exactly for compatibility
    const body = Buffer.alloc(4 + name.length);
    body.writeUInt32LE(PROTOCOL_VERSION, 0);
    name.copy(body, 4);
    this.sendCmd(CMD_HELLO, body);
  }

  private sendCmd(cmd: number, body: Buffer): void {
    if (!this.socket?.writable) return;
    const hdr = Buffer.alloc(CMD_HDR_SIZE);
    hdr.writeUInt32LE(cmd >>> 0, 0);
    hdr.writeUInt32LE(body.length >>> 0, 4);
    this.socket.write(Buffer.concat([hdr, body]));
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= MSG_HDR_SIZE) {
      // Header: ProtocolID(0) | MessageType(4) | StreamType(8) | SequenceNumber(12) | BodySize(16)
      const messageTypeRaw = this.buf.readUInt32LE(4);
      const bodySize       = this.buf.readUInt32LE(16);
      if (this.buf.length < MSG_HDR_SIZE + bodySize) break;
      const body = this.buf.subarray(MSG_HDR_SIZE, MSG_HDR_SIZE + bodySize);
      this.buf  = this.buf.subarray(MSG_HDR_SIZE + bodySize);

      const msgType = messageTypeRaw & 0xFFFF;
      const gainDb  = (messageTypeRaw >>> 16) & 0xFFFF;
      this.handleMsg(msgType, gainDb, body);
    }
  }

  private handleMsg(type: number, gainDb: number, body: Buffer): void {
    if (type === MSG_DEVICE_INFO && body.length >= 48) {
      const info: DeviceInfo = {
        deviceType:       body.readUInt32LE(0),
        deviceSerial:     body.readUInt32LE(4),
        maxSampleRate:    body.readUInt32LE(8),
        maxBandwidth:     body.readUInt32LE(12),
        decimationStages: body.readUInt32LE(16),
        gainStages:       body.readUInt32LE(20),
        maxGainIndex:     body.readUInt32LE(24),
        minFrequency:     body.readUInt32LE(28),
        maxFrequency:     body.readUInt32LE(32),
        resolution:       body.readUInt32LE(36),
        minIQDecimation:  body.readUInt32LE(40),
        forcedIQFormat:   body.readUInt32LE(44),
      };
      this.emit('deviceInfo', info);
    } else if (type === MSG_CLIENT_SYNC && body.length >= 36) {
      const sync: SyncInfo = {
        canControl:       body.readUInt32LE(0) !== 0,
        gain:             body.readUInt32LE(4),
        deviceCenterFreq: body.readUInt32LE(8),
        iqCenterFreq:     body.readUInt32LE(12),
        fftCenterFreq:    body.readUInt32LE(16),
        minIQCenterFreq:  body.readUInt32LE(20),
        maxIQCenterFreq:  body.readUInt32LE(24),
      };
      this.emit('sync', sync);
    } else if (type === MSG_UINT8_IQ) {
      this.emit('iqData', { format: 'uint8', body, gainDb } as IQPacket);
    } else if (type === MSG_INT16_IQ) {
      this.emit('iqData', { format: 'int16', body, gainDb } as IQPacket);
    } else if (type === MSG_FLOAT_IQ) {
      this.emit('iqData', { format: 'float', body, gainDb } as IQPacket);
    }
  }
}

/**
 * Compute IQ_DIGITAL_GAIN value per device type.
 * Mirrors SDR++ computeDigitalGain (spyserver_client.cpp).
 */
export function computeDigitalGain(deviceType: number, deviceGain: number, decimationStage: number, maxGainIndex: number): number {
  if (deviceType === DEVICE_AIRSPY_ONE) {
    return Math.round((maxGainIndex - deviceGain) + decimationStage * 3.01);
  }
  if (deviceType === DEVICE_AIRSPY_HF || deviceType === DEVICE_RTLSDR) {
    return Math.round(decimationStage * 3.01);
  }
  return 0;
}
