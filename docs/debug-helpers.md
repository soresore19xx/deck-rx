# Debug helpers

[← Back to README](../README.md)

## LCD panel screenshots

Touching `/tmp/deck-rx-lcd-dump` arms a render-time hook that writes the raw
source SVG of each encoder LCD to `/tmp/deck-rx-lcd-<tag>.svg`
(`tag` ∈ `tune` / `volume` / `options` / `am-options`). Without the flag the
hook is a single `existsSync` check per render and adds no overhead, so it
can be left in production builds.

`scripts/dump-lcd.sh` runs the full capture loop: wipe stale dumps, set the
flag, bounce the plugin (kills the PID in `/tmp/deck-rx.pid` rather than
`pkill -f "<pattern>"` — see the script comment for why), wait up to 120 s
while you cycle through each panel on the device (Stream Deck only
re-renders the *visible* action), then `rsvg-convert -z 2` into
`~/ICON/deck-rx-lcd-<tag>.png` and clear the flag. Use this for README /
store screenshots without having to crop a Stream Deck app window capture.

Forgotten flags from a previous session (`mtime > 10 min`) are GC'd at
plugin startup, so the dump path can't stay armed across restarts. The
script's touch-then-bounce flow keeps the flag fresh, so legitimate
capture sessions are unaffected.

`scripts/lint-lcd.py` parses the dump SVGs and reports overlapping
`<text>` / `<polygon>` boxes (e.g. clock vs 7-seg digits in dial-tune).
`scripts/compare-lcd.sh save` snapshots `~/ICON/` to `~/ICON-baseline/`,
and `compare-lcd.sh` (no args) diffs current PNGs against that baseline
via ImageMagick `compare -metric AE`, dumping diff overlays into
`~/ICON-diff/` — handy when verifying that a render-side tweak only
affected what you intended.

## Dump vs on-device render — render-engine differences

The dump path (rsvg-convert + Pango + fontconfig) and the on-device
path (Stream Deck SDK + Core Text on macOS) draw the same SVG with
**different glyph metrics**. Pango's monospace fallback (Liberation
Mono on most fontconfig setups) tracks wider than Core Text's Menlo,
so a `<text>` element that fits cleanly on-device may overlap an
adjacent shape in the dump. `dumpTuneLcd` accepts this asymmetry as
a fact of life and applies a **dump-only fixup** to the Tune dial's
clock — when inlining freqDisplay's body for the dump SVG, it regex-
swaps the clock `<text>`'s attributes (single-family `Menlo` to bypass
Liberation Mono and avoid Illustrator "missing font" warnings,
`letter-spacing="-2"` to compensate Pango's wider tracking,
`x="189"` for visual centring against the digits). The on-device
output (via `setFeedback`) keeps `seg7svg`'s unmodified `<text>` and
is unaffected. If you ever add another tight-layout text element,
extend the same regex pattern in `dumpTuneLcd` rather than touching
`seg7svg` (which would shift the on-device render too).

## Audio path: which fault is it (Solo)

"It breaks up" and "it is too quiet" are different faults with the same
description, and guessing between them costs a session. Launch the standalone
app with `DECKRX_AUDIO_DIAG=1` and it writes one line to stderr every five
seconds:

```
[diag] iq=456000 audio=114000 dec=4 underruns=0 gapMs=14 queue=0.120s pcm=0.29036 (-10.7 dBFS) rssi=-59.3 vol=0.97
```

- `underruns` climbing with `queue` near zero — the sink is starved: the demod
  is not keeping up, or the device rate changed under it.
- `gapMs` large — the IQ arrived late; that is the server or the network, not
  this end. A retune shows one large gap and nothing after it.
- `pcm` far below about −20 dBFS with a healthy `rssi` — the demodulator is
  quiet, so look at gain, AGC and mode rather than at the audio path.
- `pcm` fine but nothing audible — everything after the demodulator: volume,
  mute, output device.

A real case: AM at −85 dBFS with `rssi` at −77 turned out to be RF gain 2 with
the carrier AGC off, not the 912 kHz IQ rate it was blamed on. The same numbers
at 456 kHz settled it in one run.

## Recording what the receiver is actually putting out

File flags, two taps per receiver, so all of them can be captured at once and
the WAVs told apart:

| flag | writes | what it is |
| --- | --- | --- |
| `/tmp/deck-rx-solo-audio-record` | `/tmp/deck-rx-solo-audio-<ts>.wav` | the standalone app's audio, after levelling and the mute window, **before the volume knob** and before the sink |
| `/tmp/deck-rx-solo-postmix-record` | `/tmp/deck-rx-solo-postmix-<ts>.wav` | the standalone app again, at the engine's main mixer — after the volume ramp and after AVAudioEngine's own rate conversion |
| `/tmp/deck-rx-audio-record` | `/tmp/deck-rx-audio-<ts>.wav` | the plugin, **after** its volume ramp, before resampling |
| `/tmp/deck-rx-postasrc-record` | `/tmp/deck-rx-postasrc-<ts>.wav` | the plugin again, the exact bytes handed to the output device, after resampling |

`touch` to start, `rm` to stop; the header is patched on close. Each receiver's
pair localises a fault to the resampler or the device clock: `solo-audio` vs
`solo-postmix` on one side, `audio` vs `postasrc` on the other.

**Match the taps before comparing levels across receivers.** The two `audio`
flags are not the same point: the standalone one sits *before* the volume knob
and the plugin's *after* it. Comparing them directly is how 6.8 dB of plain
volume was mistaken for 7.6 dB of demodulator gain, and how a soft limiter's
32767 ceiling — which is upstream of the knob, so it does not budge when the
volume is lowered — was read as clipping that lowering the volume would fix.
Use `solo-postmix` against `audio`, or divide the knob back out.

The standalone tap is also what settled "why is Solo noisier than SDR++ on
594 kHz": record the same station from both, normalise each to its own
0.3-3 kHz program band, and compare by octave. Level differences cancel;
filter skirts do not.

A caution learned the hard way there: a recording of pure silence is not
evidence of a broken audio path. Check `muted` in `/health` first — the
plugin's mute is persisted in `config.json` and hydrated on connect, so a
restart can come back muted with everything else looking healthy.

## Demodulator benchmarks

`native-app/run-bench.sh` builds the receiver sources at `-O` with
`Bench/main.swift` and reports, per IQ rate, how much of realtime each
demodulator costs and what level the AM path puts out:

```
  AM 912k     0.103 s for 1.0 s of IQ  -> load  10.3%
  WFM 912k    0.134 s for 1.0 s of IQ  -> load  13.4%
```

Use it before optimising anything. It is what showed that 912 kHz audio
dropouts were not the demodulator's doing — a tenth of one core is not the
thing to speed up.
