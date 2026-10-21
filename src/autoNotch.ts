// Automatic notch for steady tones in the audio of AM and SSB: heterodyne
// whistles between stations on the same channel, a neighbour's carrier, and
// the 100 Hz ladder of mains hum that rides on medium wave here.
//
// Measured on the balcony loop (2026-10-21 21:20, one 912 kHz IQ recording
// across 544-1456 kHz, every 9 kHz channel AM-detected): almost every station
// carried tones 15-28 dB above their surroundings at 100, 200, 300, 400 Hz,
// and several at 491 / 690 / 790 Hz.
//
// How: a spectrum of the input every hop; a bin that stands well above its
// neighbourhood and stays put (same frequency, similar level) for a quarter
// of a second is a tone, not speech or music, whose partials move. Each tone
// gets a notch built as the input minus a band-pass of itself, faded in and
// out over 20 ms so nothing clicks, following the tone if it drifts. The
// detector reads the input before the notches, so a tone that has been cut
// is still seen and the notch stays until the tone actually stops.
//
// Our own design from the textbook pieces (RBJ band-pass, peak picking with
// parabolic interpolation); OnAir's audio cleanup has a stage with the same
// job, and its documented thresholds (18 dB, about 0.25 s) are the starting
// point here.
import FFT from 'fft.js';

// On air (684 / 702 kHz) a channel carried eight tones and more at once: the
// hum ladder and a second ladder 10 Hz below it (290, 390, 490, 690 ...).
const MAX_NOTCHES = 10;
const RISE_DB = 18;             // over the median of the bins around it
const HOLD_S = 0.4;             // steady this long before it is cut
const RELEASE_S = 1.0;          // unseen this long and the notch lets go
// A tone being cut is followed loosely (a lower rise, a wider level range),
// a candidate is held to a tight test:
// medium wave fades, and at 0.4 s and ±6 dB the notches on 684 kHz kept
// letting go and grabbing again.
const STEADY_DB = 6, FOLLOW_DB = 12, FOLLOW_RISE_DB = 10;
const FADE_S = 0.02;
const NOTCH_BW_HZ = 20;         // -3 dB width of each notch
const F_MIN = 60, F_MAX = 5000;

interface Track {
  hz: number;
  anchor: number;     // where it was first seen: a tone stays near it, a voice's partial wanders off
  db: number;
  dbMin: number;      // level range since the anchor
  dbMax: number;
  age: number;        // seconds seen steady
  unseen: number;     // seconds since last seen
  notch: number;      // slot index, -1 = none
}

class Notch {
  hz = 0;
  gain = 0;           // 0..1, how much of the band-pass is taken away
  target = 0;
  private b0 = 0; private b2 = 0; private a1 = 0; private a2 = 0;
  private z1 = 0; private z2 = 0;
  set(fs: number, hz: number): void {
    this.hz = hz;
    const w = 2 * Math.PI * hz / fs;
    const alpha = Math.sin(w) / (2 * (hz / NOTCH_BW_HZ));
    const a0 = 1 + alpha;
    this.b0 = alpha / a0; this.b2 = -alpha / a0;
    this.a1 = -2 * Math.cos(w) / a0; this.a2 = (1 - alpha) / a0;
  }
  reset(): void { this.z1 = this.z2 = 0; this.gain = this.target = 0; }
  /** Band-pass output (peak gain 1 at hz). */
  bp(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = -this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

export class AutoNotch {
  enabled = false;
  private fs = 0;
  private n = 0;
  private hop = 0;
  private fft: FFT | null = null;
  private win = new Float64Array(0);
  private buf = new Float64Array(0);
  private pos = 0;
  private sinceHop = 0;
  private frame = new Float64Array(0);
  private spec: number[] = [];
  private mag = new Float64Array(0);
  private prev = new Float64Array(0);   // last frame's spectrum, for the phase step
  private havePrev = false;
  private tracks: Track[] = [];
  private notches: Notch[] = Array.from({ length: MAX_NOTCHES }, () => new Notch());
  private fadeStep = 0;

  /** Frequencies currently cut (Hz), for logs and the display. */
  activeHz(): number[] {
    return this.notches.filter(n => n.target > 0).map(n => Math.round(n.hz));
  }

  configure(fs: number): void {
    if (fs === this.fs) return;
    this.fs = fs;
    // About 0.3 s: 3-4 Hz bins. Coarser (85 ms, 12 Hz) parted the hum ladder
    // but let a voice's partial a few bins away pull the tone's estimate off
    // by a hertz or two — 400 Hz hum came out only 12 dB down. The detector
    // waits HOLD_S anyway, so the longer window costs no time to speak of.
    let n = 1024;
    while (n < fs * 0.28) n <<= 1;
    this.n = n;
    this.hop = n >> 3;
    this.fft = new FFT(n);
    this.win = new Float64Array(n);
    for (let i = 0; i < n; i++) this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
    this.buf = new Float64Array(n);
    this.frame = new Float64Array(n);
    this.spec = this.fft.createComplexArray();
    this.mag = new Float64Array(n >> 1);
    this.prev = new Float64Array(n);
    this.fadeStep = 1 / (FADE_S * fs);
    this.reset();
  }

  reset(): void {
    this.buf.fill(0); this.pos = 0; this.sinceHop = 0; this.havePrev = false;
    this.tracks = [];
    for (const nt of this.notches) nt.reset();
  }

  /** In place on interleaved PCM; mono sources (L = R) are what it is for.
   *  Each channel's samples run through the same notches, driven by channel 0. */
  process(pcm: Int16Array, channels: number): void {
    if (!this.enabled || this.fs <= 0 || !this.fft) return;
    const frames = Math.floor(pcm.length / channels);
    const ns = this.notches;
    for (let i = 0; i < frames; i++) {
      const x = pcm[i * channels];
      this.buf[this.pos] = x;
      this.pos = (this.pos + 1) % this.n;
      if (++this.sinceHop >= this.hop) { this.sinceHop = 0; this.analyse(); }
      let y = x;
      for (let k = 0; k < MAX_NOTCHES; k++) {
        const nt = ns[k];
        if (nt.gain === 0 && nt.target === 0) continue;
        nt.gain += Math.max(-this.fadeStep, Math.min(this.fadeStep, nt.target - nt.gain));
        // In series, each notch on what the last one left. In parallel
        // (all on x) every band-pass's skirt lands on the other tones
        // uncancelled: with the 100-400 Hz ladder, 400 Hz came out only
        // 12 dB down although every notch sat within 0.1 Hz of its tone.
        y -= nt.gain * nt.bp(y);
      }
      const s = y >= 32767 ? 32767 : y <= -32767 ? -32767 : Math.round(y);
      for (let c = 0; c < channels; c++) pcm[i * channels + c] = s;
    }
  }

  private analyse(): void {
    const n = this.n, half = n >> 1, fs = this.fs, fft = this.fft!;
    for (let i = 0; i < n; i++) this.frame[i] = this.buf[(this.pos + i) % n] * this.win[i];
    fft.realTransform(this.spec, this.frame);
    for (let k = 0; k < half; k++) {
      const re = this.spec[2 * k], im = this.spec[2 * k + 1];
      this.mag[k] = 10 * Math.log10(re * re + im * im + 1e-12);
    }
    const binHz = fs / n;
    const kLo = Math.max(3, Math.ceil(F_MIN / binHz)), kHi = Math.min(half - 4, Math.floor(F_MAX / binHz));
    const span = Math.max(8, Math.round(150 / binHz));
    const found: { hz: number; db: number; rise: number }[] = [];
    const around: number[] = [];
    for (let k = kLo; k <= kHi; k++) {
      const m = this.mag[k];
      if (m < this.mag[k - 1] || m < this.mag[k + 1] || m < this.mag[k - 2] || m < this.mag[k + 2]) continue;
      around.length = 0;
      for (let j = Math.max(1, k - span); j <= Math.min(half - 1, k + span); j++) {
        if (Math.abs(j - k) > 2) around.push(this.mag[j]);
      }
      around.sort((a, b) => a - b);
      const rise = m - around[around.length >> 1];
      if (rise < FOLLOW_RISE_DB) continue;
      // Parabolic interpolation of the peak in dB: good to a tenth of a bin
      // in the clear, a hertz or more off with a voice beside it — and a
      // 20 Hz notch 1 Hz off the tone is only 20 dB deep.
      const a = this.mag[k - 1], b = m, c = this.mag[k + 1];
      const d = a - 2 * b + c;
      const off = d !== 0 ? 0.5 * (a - c) / d : 0;
      let hz = (k + off) * binHz;
      // So refine it from the phase the bin advanced since the last frame
      // (hop samples ago): a steady tone turns by exactly 2 pi f hop / fs.
      if (this.havePrev) {
        const re = this.spec[2 * k], im = this.spec[2 * k + 1];
        const pr = this.prev[2 * k], pi = this.prev[2 * k + 1];
        let dph = Math.atan2(im * pr - re * pi, re * pr + im * pi) - 2 * Math.PI * k * this.hop / n;
        dph -= 2 * Math.PI * Math.round(dph / (2 * Math.PI));
        const fine = (k + dph * n / (2 * Math.PI * this.hop)) * binHz;
        if (Math.abs(fine - hz) < binHz) hz = fine;
      }
      found.push({ hz, db: m, rise });
    }
    for (let i = 0; i < 2 * half; i++) this.prev[i] = this.spec[i];
    this.havePrev = true;
    const dt = this.hop / fs;
    // Match to tracks within 1.5 bins: a candidate at the full rise and 6 dB,
    // a tone already being cut at a lower rise and FOLLOW_DB.
    for (const t of this.tracks) t.unseen += dt;
    for (const f of found) {
      let best: Track | null = null;
      for (const t of this.tracks) {
        if (t.unseen <= 0) continue;
        const ok = Math.abs(t.hz - f.hz) <= 1.5 * binHz && (t.notch >= 0
          ? Math.abs(t.db - f.db) <= FOLLOW_DB
          : f.rise >= RISE_DB && Math.abs(t.db - f.db) <= 6);
        if (ok && (!best || Math.abs(t.hz - f.hz) < Math.abs(best.hz - f.hz))) best = t;
      }
      if (best) {
        const gap = best.unseen > 1.5 * dt;
        // Only a clear sighting moves the frequency: on 684 kHz a faded tone's
        // weaker neighbours (programme, the second ladder) dragged a notch
        // from 100 Hz down to 87.
        if (f.rise >= RISE_DB) best.hz = 0.7 * best.hz + 0.3 * f.hz;
        best.db = 0.7 * best.db + 0.3 * f.db;
        best.age += best.unseen; best.unseen = 0;
        best.dbMin = Math.min(best.dbMin, f.db); best.dbMax = Math.max(best.dbMax, f.db);
        // Not steady: start the clock again from here. A tone holds its pitch
        // to a hertz or two and its level to a few dB without a break; a
        // voice's partial glides, swells with the syllable and drops out.
        // A notch already given follows instead (a heterodyne drifts slowly).
        const wandered = Math.abs(f.hz - best.anchor) > Math.max(0.6 * binHz, 2);
        if (best.notch < 0 && (gap || wandered || best.dbMax - best.dbMin > STEADY_DB)) {
          best.anchor = f.hz; best.age = 0; best.dbMin = best.dbMax = f.db;
        }
      } else if (f.rise >= RISE_DB && this.tracks.length < 32) {
        this.tracks.push({ hz: f.hz, anchor: f.hz, db: f.db, dbMin: f.db, dbMax: f.db, age: 0, unseen: 0, notch: -1 });
      }
    }
    // Release the lost, give notches to the steady (strongest first).
    for (const t of this.tracks) {
      if (t.notch >= 0 && t.unseen > RELEASE_S) { this.notches[t.notch].target = 0; t.notch = -1; }
    }
    this.tracks = this.tracks.filter(t => t.unseen <= RELEASE_S || t.notch >= 0);
    const ready = this.tracks.filter(t => t.notch < 0 && t.age >= HOLD_S && t.unseen === 0)
      .sort((a, b) => b.db - a.db);
    for (const t of ready) {
      const slot = this.notches.findIndex(nt => nt.target === 0 && nt.gain === 0);
      if (slot < 0) break;
      t.notch = slot;
      this.notches[slot].reset();
      this.notches[slot].set(fs, t.hz);
      this.notches[slot].target = 1;
    }
    for (const t of this.tracks) {
      if (t.notch >= 0 && t.unseen === 0 && Math.abs(this.notches[t.notch].hz - t.hz) > 0.5) {
        this.notches[t.notch].set(fs, t.hz);
      }
    }
  }
}
