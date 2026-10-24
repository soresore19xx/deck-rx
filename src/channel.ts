/**
 * The channel stage: each mode's channel is filtered out of the IQ and
 * decimated before it is demodulated. Ported from native-app (Demods.swift
 * `ChannelPlan` / `Channelizer`, where the reasons are measured): run at the
 * full IQ rate the detectors cost the square of the rate, and NFM, SSB and CW,
 * with no filter in front of their final sample drop, folded the whole IQ
 * width's noise into the audio (SSB 10 dB at a 150 kHz audio rate).
 *
 * One difference from the app: this plugin fixes its audio rate when a stream
 * starts (the output engine and its ASRC are built for it), so the channel's
 * divisor has to divide the stream's audio divisor. WFM keeps the largest such
 * divisor that still holds its channel; AM, SSB and CW go straight to the
 * audio rate, filtered; NFM and DSB keep the narrow channel the same way.
 */
import { ifCutoff, ifTransition } from './demodulator.js';

/** Below this nothing is demodulated (a 9.5 kHz audio rate once put a 6 kHz
 *  tone out at 3.5 kHz). */
export const MIN_AUDIO_RATE = 24_000;
/** Stereo needs the discriminator output up to 53 kHz below Nyquist. */
export const MPX_TOP_HZ = 53_000;
/** Where a broadcast FM signal has next to nothing left: 75 kHz deviation
 *  plus twice the 53 kHz multiplex. The equaliser, ahead of the IF filter,
 *  works on the envelope and needs the whole signal. */
export const FM_EQUALISER_PASS_HZ = 75_000 + 2 * MPX_TOP_HZ;
/** 70 dB down an eighth-order Butterworth (the AM IF filter): 2^(70/48). */
const IIR_SKIRT = 2.75;
/** The AM passband when the bandwidth is "no limit": ITU-R's 10 kHz. */
const AM_WIDEST_AUDIO_HZ = 10_000;

export interface ChannelPlan {
  decimation: number;      // IQ samples per channel sample
  channelRate: number;     // what the detectors run at
  passHz: number;          // passed untouched
  protectHz: number;       // nothing aliases back below this
  audioDecimation: number; // channel samples per audio sample
}

/** The rate each mode needs and the band it must keep. */
function needs(mode: number, fmBandwidthHz: number, amBandwidthHz: number, ssbBandwidthHz: number):
    { pass: number; protect: number; need: number } | null {
  if (mode === 0 || mode === 1 || mode === 3) {
    const fc = ifCutoff(fmBandwidthHz / 2, mode === 1);
    const trans = ifTransition(fc);
    const edge = fc + trans / 2;
    const pass = mode === 1 ? Math.max(edge, FM_EQUALISER_PASS_HZ) : edge;
    let need = pass + edge + trans;
    need = mode === 1 ? Math.max(need, 2 * MPX_TOP_HZ * 1.1) : Math.max(need, MIN_AUDIO_RATE);
    return { pass, protect: edge, need };
  }
  if (mode === 2) {
    const pass = amBandwidthHz > 0 ? amBandwidthHz / 2 : AM_WIDEST_AUDIO_HZ;
    return { pass, protect: pass * IIR_SKIRT, need: Math.max(MIN_AUDIO_RATE, pass + pass * IIR_SKIRT + pass) };
  }
  if (mode === 4 || mode === 5 || mode === 6) {
    const pass = Math.max(ssbBandwidthHz, 3_000);
    return { pass, protect: pass * IIR_SKIRT, need: Math.max(MIN_AUDIO_RATE, pass + pass * IIR_SKIRT + pass) };
  }
  return null;   // RAW: there is no channel to cut
}

/** The plan for a stream fixed at `iqRate` / `audioDecimate`. */
export function channelPlan(iqRate: number, audioDecimate: number, mode: number,
                            fmBandwidthHz: number, amBandwidthHz: number, ssbBandwidthHz: number): ChannelPlan {
  const a = Math.max(1, Math.floor(audioDecimate));
  const n = needs(mode, fmBandwidthHz, amBandwidthHz, ssbBandwidthHz);
  if (!n || iqRate <= 0) {
    return { decimation: 1, channelRate: iqRate, passHz: iqRate / 2, protectHz: iqRate / 2, audioDecimation: a };
  }
  // The largest divisor of the audio divisor that still holds the channel.
  // Every detector but WFM has nothing in front of its own sample drop, so
  // those go all the way to the audio rate when it holds them.
  let dec = 1;
  for (let d = a; d >= 1; d--) {
    if (a % d !== 0) continue;
    if (iqRate / d >= n.need) { dec = d; break; }
  }
  return { decimation: dec, channelRate: iqRate / dec, passHz: n.pass, protectHz: n.protect, audioDecimation: a / dec };
}

/**
 * Band-limits complex int16 IQ to a channel and decimates it in one windowed-
 * sinc FIR (Blackman, about -74 dB), evaluated only at the samples it keeps.
 * Flat to `passHz`; the stop band starts where anything in it would alias
 * below `protectHz`, or at Nyquist when nothing is decimated (a neighbour 200
 * kHz off still has to be kept from WFM's equaliser). The history starts as
 * the first sample: a ramp out of zeros looked like an echo to the equaliser.
 */
export class Channelizer {
  private taps = new Float64Array(0);
  private histI = new Float64Array(0);
  private histQ = new Float64Array(0);
  private len = 0;            // samples held in the history
  private start = 0;          // where the next kept output's window starts
  private decimation = 1;
  private primed = false;

  get isIdentity(): boolean { return this.taps.length === 0; }
  get tapCount(): number { return this.taps.length; }

  configure(inRate: number, plan: ChannelPlan): void {
    this.decimation = plan.decimation;
    this.start = 0;
    this.len = 0;
    this.primed = false;
    const outRate = inRate / this.decimation;
    const stop = this.decimation > 1 ? outRate - plan.protectHz : inRate / 2;
    if (!(stop > plan.passHz * 1.05)) { this.taps = new Float64Array(0); return; }
    const trans = Math.max(1, stop - plan.passHz);
    const fc = (plan.passHz + stop) / 2;
    let n = Math.max(31, Math.round(5.5 * inRate / trans));
    if (n % 2 === 0) n += 1;
    const wc = 2 * Math.PI * fc / inRate;
    const m = (n - 1) / 2;
    const t = new Float64Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const k = i - m;
      const sinc = k === 0 ? wc / Math.PI : Math.sin(wc * k) / (Math.PI * k);
      const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (n - 1));
      t[i] = sinc * w; sum += t[i];
    }
    for (let i = 0; i < n; i++) t[i] /= sum;
    this.taps = t;
    this.histI = new Float64Array(n - 1);
    this.histQ = new Float64Array(n - 1);
    this.len = n - 1;
  }

  process(iq: Buffer): Buffer {
    if (this.taps.length === 0) return iq;
    const n = iq.length >> 2;
    if (n === 0) return Buffer.alloc(0);
    const N = this.taps.length;
    if (!this.primed) {
      this.primed = true;
      const i0 = iq.readInt16LE(0), q0 = iq.readInt16LE(2);
      this.histI.fill(i0, 0, this.len); this.histQ.fill(q0, 0, this.len);
    }
    // Grow the history to hold the new samples.
    if (this.histI.length < this.len + n) {
      const cap = this.len + n;
      const ni = new Float64Array(cap), nq = new Float64Array(cap);
      ni.set(this.histI.subarray(0, this.len)); nq.set(this.histQ.subarray(0, this.len));
      this.histI = ni; this.histQ = nq;
    }
    for (let i = 0; i < n; i++) {
      this.histI[this.len + i] = iq.readInt16LE(i * 4);
      this.histQ[this.len + i] = iq.readInt16LE(i * 4 + 2);
    }
    const total = this.len + n;
    const d = this.decimation;
    const count = total >= this.start + N ? Math.floor((total - this.start - N) / d) + 1 : 0;
    const out = Buffer.alloc(count * 4);
    const taps = this.taps, hi = this.histI, hq = this.histQ;
    let pos = this.start;
    for (let k = 0; k < count; k++) {
      let vi = 0, vq = 0;
      for (let j = 0; j < N; j++) { const w = taps[j]; vi += w * hi[pos + j]; vq += w * hq[pos + j]; }
      out.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(vi))), k * 4);
      out.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(vq))), k * 4 + 2);
      pos += d;
    }
    this.start += count * d;
    const drop = Math.min(this.start, total);
    this.histI.copyWithin(0, drop, total);
    this.histQ.copyWithin(0, drop, total);
    this.len = total - drop;
    this.start -= drop;
    return out;
  }
}
