# Debug helpers

[← Back to README](../README.md)

## LCD panel screenshots

Touching `/tmp/deck-rx-lcd-dump` arms a render-time hook that writes the raw
source SVG of each encoder LCD to `/tmp/deck-rx-lcd-<tag>.svg`
(`tag` is the action: `tune`, `volume`, `options`, `am-options`,
`ssb-options`, `options-combo`, `band-select`, `options-auto`, `options-2col`,
`fft`, `fft-lcdx2-left` / `-right` / `-single`). Without the flag the hook is a
single `existsSync` check per render and adds no overhead, so it can be left in
production builds.

`scripts/dump-lcd.sh` captures the panels on the Stream Deck's current page
without restarting anything: it wipes stale dumps, sets the flag, touches
`/tmp/deck-rx-lcd-force` (the plugin re-renders every visible dial once and
removes it), waits 2.5 s, then `rsvg-convert -z 2` into
`~/ICON/deck-rx-lcd-<tag>.png` and clears the flag. Only visible actions
render, so a dial on another page is skipped. `--all` keeps polling for up to
180 s while you page through the deck; `--docs` also writes
`docs/lcd-<label>.png`.

`scripts/render-all-dials.mjs` (`npx tsx scripts/render-all-dials.mjs`) draws
the settings and Volume dials, and the six-mode Combo composite, from the test
harness with a mock SpyServer — no device, no running plugin touched — into
`docs/lcd-*.png`. The Tune and FFT dials need the real deck (`dump-lcd.sh`).

A flag forgotten from a previous session is removed at plugin startup, so the
dump path can't stay armed across restarts.

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
adjacent shape in the dump. The Stream Deck app also ignores
`font-family` in an SVG and substitutes a proportional font, so text
that changes every second (the Volume dial's clock) is laid out one
glyph per fixed-width cell (`fixedPitchLine` in `src/icons.ts`) rather
than as one `<text>` run — otherwise it shifts on every tick. A quick
local preview (Quick Look, a browser) resolves Menlo and therefore does
not show what the device shows; judge tight layouts on the deck.

(`dumpTuneLcd` still carries a dump-only fixup for a clock on the Tune
dial's frequency display. No caller draws that clock any more — it moved
to the Volume dial — so the fixup never fires.)

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

On an RTL-SDR (rtl_tcp, or the iPad's own USB port) a second line follows:

```
[diag] rtl: in=1199300/s of 1200000  pacer underruns=0 trims=0 held=0.044s prefill=0.030s maxGap=16ms
```

- `in` well below the device rate — the dongle or the link is short of
  samples; `pacer underruns` then climbs with it.
- `trims` climbing — the device delivers faster than it is released.
- On the Airspy HF+ over the iPad's USB the second line is `hf:`: what arrived
  per second against the rate, `libDropped` (libairspyhf's own losses),
  `jumps edge/inside` (phase jumps over 2 rad in the IQ itself, at the first
  sample of a transfer and elsewhere — a broadcast FM station cannot make
  one), `zeroIF`/`lowIF`, and the driver ring's `ringDrop` and the libusb
  stand-in's `lapped` byte counts.
- `usbCmdMax` (the iPad's own USB port only) — the slowest driver command in
  the interval. A retune is about 110 ms of tuner writes on a V4.

The iPad's `drops` on the status line is the same `underruns`, a total since
launch, shown as `drops 0` when there are none (as the Mac window does).
Retunes are where drops come from, not time, so test with retunes:

- held IQ is blanked rather than dropped on a retune, and over USB driver
  commands run on their own queue; until a retune is done (and for one more
  64 KB driver transfer) the IQ is zeroed but keeps its length, and the packet
  where the new station starts is marked `landed` — LocalRadio starts its
  retune mute and detector reset there rather than at the request. A rate
  change waits for its command the same way (over a socket, a fixed 0.4 s).
- SpyServer loses about 6.5 ms of IQ per frequency or gain setting with no gap
  in the sequence numbers, and a preset jump with auto gain sends several
  settings. While the retune mute is open the sink is topped back up to its
  0.12 s depth with silence (`AudioSink.padToTarget`), measured from the ring
  itself, so this covers every source.

The iPad cannot be tuned from outside (no control server on iOS), and its UI
tests need the passcode typed on the device for every run. For the retune
case it tests itself instead: launched with `DECKRX_RETUNE_SELFTEST=1`, it
waits for a connection with control, presses the MW and 49m band buttons
12 times 0.3 s apart and 8 times 0.8 s apart, then steps +1 ten times, then
does the same between the first two FM presets (0.3 s and 2 s apart), then
taps the STEREO / MONO badge six times 3 s apart on the first FM preset
(the audio graph is rebuilt for one or two channels each time; the station's
own choice is put back), and
prints `[selftest] <run> drops=<n> gapMs=<n>` after each run to the
`--console` stderr, with a `[selftest] jump <hz> at <unix time>` line per
jump. `DECKRX_RETUNE_SELFTEST_HOLD=<s>` adds that many seconds of sitting
still, reported each minute. It puts the starting frequency and mode back at
the end. Nothing is stored, so a launch without the variable is an ordinary
launch. Expected: 0 drops in every run. (Over SpyServer an RTL-SDR's IQ still
describes the old frequency for about 50 ms after a retune is asked for, inside
the 100 ms-or-more mute window, so the old station is not heard.)

The iPad reads the same switch. Its stderr goes nowhere unless the app is
started with `xcrun devicectl device process launch --console
--environment-variables '{"DECKRX_AUDIO_DIAG":"1"}' ...`, and nothing is
written to the iPad's storage either way.

Example: AM at −85 dBFS with `rssi` at −77 is the demodulator's level (a low
RF gain with the carrier AGC off), not the audio path; the same reading at
another IQ rate tells the two apart.

## Recording what the receiver is actually putting out

File flags, two taps per receiver, so all of them can be captured at once and
the WAVs told apart:

| flag | writes | what it is |
| --- | --- | --- |
| `/tmp/deck-rx-solo-audio-record` | `/tmp/deck-rx-solo-audio-<ts>.wav` | the standalone app's audio, after levelling and the mute window, **before the volume knob** and before the sink |
| `/tmp/deck-rx-solo-iq-record` | `/tmp/deck-rx-solo-iq-<rate>-<ts>.bin` | the IQ as it arrived, packet by packet (a little-endian UInt32 byte count, then the int16 IQ), so a fault can be replayed offline through the same demodulator with the same packet boundaries. 3.6 MB a second at 912 kHz |
| `/tmp/deck-rx-solo-postmix-record` | `/tmp/deck-rx-solo-postmix-<ts>.wav` | the standalone app again, at the engine's main mixer — after the volume ramp and after AVAudioEngine's own rate conversion |
| `/tmp/deck-rx-audio-record` | `/tmp/deck-rx-audio-<ts>.wav` | the plugin, **after** its volume ramp, before resampling |
| `/tmp/deck-rx-postasrc-record` | `/tmp/deck-rx-postasrc-<ts>.wav` | the plugin again, the exact bytes handed to the output device, after resampling |

`touch` to start, `rm` to stop; the header is patched on close. Each receiver's
pair localises a fault to the resampler or the device clock: `solo-audio` vs
`solo-postmix` on one side, `audio` vs `postasrc` on the other.

**Match the taps before comparing levels across receivers.** The two `audio`
flags are not the same point: the standalone one sits *before* the volume
control and the plugin's *after* it, so comparing them directly mixes the
volume setting into the result. Use `solo-postmix` against `audio`, or divide
the volume back out.

To compare against another receiver (SDR++, say), record the same station from
both, normalise each to its own 0.3-3 kHz program band, and compare by octave:
level differences cancel, filter skirts do not.

A recording of pure silence is not evidence of a broken audio path. Check
`muted` in `/health` first — the plugin's mute is persisted in `config.json`
and restored on connect.

## Running the app's own suites without losing your settings

`native-app/run-tests.sh`, `run-bench.sh` and `run-quality.sh` build the
receiver sources into a plain binary, and several of the tests construct a
`LocalRadio`, whose config saves itself on every change. So the scripts point
it elsewhere — `export DECK_RX_RECEIVER_CONFIG="$(mktemp -d)/receiver.json"`,
which `RadioConfig.ownPath` honours, with the gain memory, the station-mono
file and the sync state beside it. Anything else that links these sources
outside an app bundle should set them too; otherwise a test run rewrites the
real `~/Library/Application Support/deck-rx/receiver.json`. To check a runner,
read `host` out of the real file before and after — it must not move.

The plugin's suite (`npm test`) has the same rule. Its harness
(`test/harness/streamDeckMock.ts`) starts the real plugin entry in a temporary
sandbox: config, PID file, gain memory, sync state and the working directory
(the Stream Deck SDK writes its logs to `<cwd>/logs`), with a copy of
`manifest.json`, removed at shutdown. To check, list
`com.hogehoge.deck-rx.sdPlugin/logs/` before and after `npm test` — nothing in
it may change.

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
