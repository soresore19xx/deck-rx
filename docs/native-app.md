# Deck RX — the front-end app

A window onto the plugin's receiver. It has no receiver of its own: the plugin
does the work and this draws it.

Part of [deck-rx](../README.md).

```sh
native-app/build-app.sh          # both bundles
native-app/build-app.sh front    # /Applications/Deck RX.app only
native-app/build-app.sh solo     # /Applications/Deck RX Solo.app only
native-app/run-tests.sh          # 80 assertions over the receiver
```

## Two bundles, one source tree

Separated by a `STANDALONE` compile flag:

| | `Deck RX.app` | `Deck RX Solo.app` |
| --- | --- | --- |
| receiver | the plugin's | [its own](solo.md) |
| needs the plugin running | yes | no |
| Stream Deck profile target | yes | no |
| bundle id | `com.hogehoge.deckrx.receiver` | `com.hogehoge.deckrx.solo` |
| icon | grey disc, the plugin's own | square pale-blue plate |

The icons differ in shape as well as colour, which is what keeps them apart at
16 px in a Dock. The receiver sources are not compiled into the front-end at all
rather than switched off inside it. The display is shared, so a fix to the
spectrum lands in both.

## It is the deck's focus target

Stream Deck switches profiles when the application a profile is bound to comes
to the front — but a plugin is not an application, so a deck-rx profile has
nothing to bind to and has to be picked by hand. This app is that application:
set the profile's target to `/Applications/Deck RX.app` and the deck follows the
window.

## What it reads and writes

The status feed, the spectrum socket, and the control endpoint — the same three
any front-end would use. Nothing about the receiver lives here.

`src/statusFeed.ts` publishes **only while the app is open**, to
`/Volumes/RAMDisk` when that is mounted and `/tmp` otherwise: 320 B a write,
3.9 writes a second. A closed app costs the plugin one `stat()` per tick.

Presets come from `data/presets.json`, read-only, and the row the receiver is
actually on is highlighted by frequency — so a retune from a dial or the knob
shows up here too.

## The spectrum

dB rules down the left, a frequency scale between trace and waterfall, the
demodulated passband shaded over the tuned frequency, and every preset in the
visible span labelled on the trace. The waterfall runs the classic blue → cyan →
green → yellow → red ramp: a single-hue ramp is tidier and costs the one thing a
waterfall is for, telling a moderate signal from a strong one at a glance.

**The rail between trace and waterfall is a handle** — drag it to give either
one more room, 15 % to 85 %. The split is kept in `receiver.json`.

Before the first frame the panel already draws the scale and the presets, from
the status feed or from `receiver.json`; what is missing while waiting is the
trace, not the axis. The dB window, zoom, waterfall depth and last IQ width are
kept too, written a beat after the last slider move so a drag is one file write.

**The readout tunes digit by digit.** Click above a digit to step that decade
up, below to step down, or scroll over it. Every decade from 100 MHz down to
1 Hz has a digit, so 954 kHz to 1134 kHz is two nudges rather than twenty
presses. Digits above the first significant one are not drawn, and pushing the
leftmost one carries the number into the next decade.

Zoom and the dB window are vertical sliders down the right edge (ZOOM / MAX /
MIN) — the three you ride while watching a waterfall. Zoom is done in the app:
every frame already carries all the bins.

The options panel down the right carries what the deck's Property Inspector
carries, minus rows the endpoint does not offer — so the standalone app, which
has neither an icecast publisher nor the plugin's databases behind it, shows
only what it can do. **The icecast password is deliberately not among them**: it
stays in the config and the Property Inspector's masked field rather than
passing through a loopback endpoint with no authentication.


## Spectrum feed (native front-end)

The status feed publishes ~320 B of JSON four times a second — right for a
station name and two meters, hopeless for a waterfall. Spectrum data goes over a
Unix socket instead, as binary frames, with the FFT computed on the plugin side
(raw IQ would cost orders of magnitude more).

| offset | size | field |
|---|---|---|
| 0 | 4 | magic `DRXS` |
| 4 | 1 | version (1) |
| 5 | 1 | flags (0) |
| 6 | 2 | reserved |
| 8 | 4 | binCount |
| 12 | 4 | iqRate, Hz — the span the frame covers |
| 16 | 4 | centerFreq, Hz — at `bins[binCount/2]` |
| 20 | 4 | seq — wraps at 2^32; a gap means a dropped frame |
| 24 | 4·n | bins, float32 dBFS, low frequency first |

Little-endian throughout. A reader syncs on the magic and derives the frame
length from `binCount`, so a mid-stream connect recovers on the next frame.
Defaults: 1024 bins at 30 fps, seeded from `DECK_RX_SPECTRUM_FFT` /
`DECK_RX_SPECTRUM_FPS` and changeable at runtime through `/spectrum` (FFT size
256–4096, framerate 1–60, smoothing speed 1–1000). A size change rebuilds the
FFT and drops the smoothing history, which belonged to the old bin count.

**Smoothing is a speed, not an amount** — SDR++'s wording and SDR++'s formula:
`alpha = min(1, speed / (fps * 10))`, so a **larger** number follows the trace
faster and averages less, and the normalisation by framerate keeps the
averaging window fixed in seconds. The native app had this inverted, taking the
FFT pipeline's own divisor (`alpha = 1 / factor`, larger = smoother) where the
plugin bypasses that smoother and applies SDR++'s form itself. Both now speak
the same language, and a config written under the old meaning is converted at
the framerate it was stored with.

Two rates matter here and conflating them is what makes a spectrum look wrong
when the framerate is turned down. The FFT runs continuously (up to 60 Hz),
independent of the display; every result between two displayed frames is
averaged into the one that goes out, so a **lower** framerate produces a
**smoother** trace rather than a noisier one. `avg` is then an exponential
average across displayed frames, so its time constant is measured in frames the
user can see rather than in IQ packets they cannot.
`native-app/Sources/SpectrumFeed.swift` is the reference reader.

Two things to know before building on it. The IQ stream is started by
`startAudio()`, so **no audio pipeline means no spectrum** — a receiver muted at
volume 0 still feeds it, but one with `audioEnabled: false` does not. And macOS
caps a Unix socket path at 104 bytes, reporting a longer one as `EADDRINUSE`;
the feed checks the length and says so rather than letting you hunt for a
process that does not exist.

## Under it

The reasoning behind the readout, the meters, the options panel and the
preset grouping is in
[standalone-app-port.md](standalone-app-port.md#the-front-end-window-design-notes).
