// TypeScript wrapper around the in-tree native/samplerate addon
// (libsamplerate). Centralised here so the rest of the codebase can
// `import { SampleRateConverter } from './asrc'` without worrying about
// the require path or the addon's raw shape.
//
// See native/samplerate/src/asrc.cc for the implementation, and the
// `Mute-boundary fade ramp` / `naudiodon maxQueue sizing` sections of
// docs/architecture.md for the bigger drift-compensation story.

import { log } from './log.js';

export enum AsrcQuality {
  SincBest = 0,
  SincMedium = 1,
  SincFastest = 2,
  ZeroOrderHold = 3,
  Linear = 4,
}

export interface AsrcOptions {
  channels: number;
  quality?: AsrcQuality;
  /** Initial ratio. 1.0 = identity. Subsequent setRatio() smooths in. */
  ratio?: number;
}

interface NativeASRC {
  process(pcm: Int16Array): Int16Array;
  setRatio(ratio: number): void;
  getRatio(): number;
  reset(): void;
}
interface NativeASRCModule {
  SampleRateConverter: new (opts: AsrcOptions) => NativeASRC;
}

let nativeMod: NativeASRCModule | null = null;
function loadNative(): NativeASRCModule | null {
  if (nativeMod) return nativeMod;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    nativeMod = require('deck-rx-asrc') as NativeASRCModule;
    return nativeMod;
  } catch (e) {
    log.warn(`[asrc] native module load failed: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/** Wraps the N-API SampleRateConverter so callers don't deal with the
 *  raw addon shape. If the native module fails to load (e.g. missing
 *  ABI-rebuild), the wrapper falls back to passthrough so audio still
 *  works — drift compensation just doesn't apply. */
export class SampleRateConverter {
  private impl: NativeASRC | null;

  constructor(opts: AsrcOptions) {
    const mod = loadNative();
    this.impl = mod ? new mod.SampleRateConverter({
      channels: opts.channels,
      quality: opts.quality ?? AsrcQuality.Linear,
      ratio: opts.ratio ?? 1.0,
    }) : null;
  }

  /** Returns true if the native module is loaded and operating; false
   *  if we're in passthrough mode. */
  get active(): boolean { return this.impl !== null; }

  process(pcm: Int16Array): Int16Array {
    if (!this.impl) return pcm;
    return this.impl.process(pcm);
  }
  setRatio(ratio: number): void { this.impl?.setRatio(ratio); }
  getRatio(): number { return this.impl?.getRatio() ?? 1.0; }
  reset(): void { this.impl?.reset(); }
}
