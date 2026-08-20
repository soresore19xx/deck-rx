// Unit tests for the spectrum frame format (src/spectrumFeed.ts).
//
// A native front-end decodes these bytes by hand, so the layout is a contract:
// once something is reading it, a silent change here shows up as a garbled
// waterfall rather than as an error. These tests pin every field.

import { describe, it, expect } from 'vitest';
import { encodeSpectrumFrame, HEADER_BYTES } from '../src/spectrumFeed.js';

const MAGIC = 0x53585244; // 'DRXS'

function bins(...v: number[]): Float32Array { return Float32Array.from(v); }

describe('encodeSpectrumFrame', () => {
  it('writes the documented header', () => {
    const f = encodeSpectrumFrame(bins(-90, -70, -50, -30), 384_000, 90_500_000, 7);
    expect(f.readUInt32LE(0)).toBe(MAGIC);
    expect(f.readUInt8(4)).toBe(1);              // version
    expect(f.readUInt8(5)).toBe(0);              // flags
    expect(f.readUInt16LE(6)).toBe(0);           // reserved
    expect(f.readUInt32LE(8)).toBe(4);           // binCount
    expect(f.readUInt32LE(12)).toBe(384_000);    // iqRate
    expect(f.readUInt32LE(16)).toBe(90_500_000); // centerFreq
    expect(f.readUInt32LE(20)).toBe(7);          // seq
  });

  it('length is header + 4 bytes per bin, so a reader can frame the stream', () => {
    for (const n of [64, 256, 1024, 4096]) {
      const f = encodeSpectrumFrame(new Float32Array(n), 384_000, 90_500_000, 0);
      expect(f.length).toBe(HEADER_BYTES + n * 4);
    }
  });

  it('bins round-trip as float32 dBFS in order, low frequency first', () => {
    const src = bins(-120.5, -95.25, -42.75, 0, -3.5);
    const f = encodeSpectrumFrame(src, 384_000, 90_500_000, 1);
    const out = Array.from({ length: src.length }, (_, i) => f.readFloatLE(HEADER_BYTES + i * 4));
    expect(out).toEqual(Array.from(src));
  });

  it('a wrapped sequence number stays a uint32 instead of throwing', () => {
    const f = encodeSpectrumFrame(bins(-80), 384_000, 90_500_000, 0xffffffff + 3);
    expect(f.readUInt32LE(20)).toBe(2);
  });

  it('rounds fractional rates rather than writing NaN', () => {
    const f = encodeSpectrumFrame(bins(-80), 384_000.6, 90_500_000.4, 0);
    expect(f.readUInt32LE(12)).toBe(384_001);
    expect(f.readUInt32LE(16)).toBe(90_500_000);
  });
});
