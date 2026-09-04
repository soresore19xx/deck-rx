# Deck RX — the front-end app

A window onto the plugin's receiver. It has no receiver of its own: the plugin does the work and this draws it.

Part of [deck-rx](../README.md).

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

## Native receiver app

`native-app/` is a full front-end over the same core — the deck's LCDs, but
without their 200×100 px and four-panel limits.

```sh
native-app/build-app.sh          # both bundles
native-app/build-app.sh front    # /Applications/Deck RX.app only
native-app/build-app.sh solo     # /Applications/Deck RX Solo.app only
native-app/run-tests.sh          # 80 assertions over the receiver
```

Two bundles, one source tree, separated by a `STANDALONE` compile flag:

| | `Deck RX.app` | `Deck RX Solo.app` |
| --- | --- | --- |
| receiver | the plugin's | its own |
| needs the plugin running | yes | no |
| Stream Deck profile target | yes | no |
| bundle id | `com.hogehoge.deckrx.receiver` | `com.hogehoge.deckrx.solo` |
| icon | grey disc, the plugin's own | square pale-blue plate |

The icons differ in shape as well as colour, which is what keeps them apart at
16 px in a Dock or a Finder list. Solo's is rendered from `native-app/icon-solo.svg`;
the front-end wears the plugin's `imgs/icon-source.svg`, because that is what it
is a face for.

The receiver sources are not compiled into the front-end at all rather than
switched off inside it — dead code that cannot run is still code someone has to
read. The display is shared, so a fix to the spectrum lands in both and cannot
drift between them.

Stream Deck switches to a profile automatically when the application it is bound
to comes to the front — but a plugin is not an application, so a deck-rx profile
has nothing to bind to and must be picked by hand. This app is that focus
target: set the profile's application to `/Applications/Deck RX.app` in the
Stream Deck app (stored as `AppIdentifier` in the profile manifest) and the deck
follows the window.

The status feed it reads is gated on the app being open. `src/statusFeed.ts`
publishes only while the app refreshes its liveness flag, to `/Volumes/RAMDisk`
when that RAM-backed volume is mounted and `/tmp` otherwise — measured at 320 B
per write, 3.9 writes/s, with no measurable plugin CPU cost. A closed app costs
the plugin one `stat()` per tick and nothing else.

`Deck RX.app` reads the status feed and the spectrum socket and writes through
the control endpoint, exactly like any other front-end; nothing about the
receiver lives in it. The preset table comes from `data/presets.json`
(read-only), and the row the receiver is currently
on is highlighted by frequency, so a retune from a dial or the knob shows up
here too. The list is grouped by band — MW, SW, FM — with a heading in the
band's own colour, above a rule of its own that runs the full width. The
heading is set larger than the frequencies it heads: at anything smaller it
lost to every row under it, which is the wrong way round for something read
before them. The grouping is deliberately coarser than the BAND JUMP
buttons beside it: by metre band, a store holding 5750, 6055, 7325, 9975 and
17650 kHz falls into seven headings for eight entries, since half of what is
worth hearing on HF sits between the broadcast bands rather than inside one.
Only the headings are coloured; the rows are a dense column of numbers, and
tinting each of them would turn the list into confetti while re-using the
three colours the spectrum already spends on presets, the tuned marker and the
trace.

The spectrum carries the scales a receiver needs: dB rules and labels down the
left, a frequency scale between trace and waterfall (both share one x mapping),
the demodulated passband shaded over the tuned frequency, and every preset
inside the visible span labelled on the trace. The waterfall uses the classic
blue → cyan → green → yellow → red ramp — a single-hue ramp looks tidier beside
the rest of the UI but costs the thing a waterfall is for, telling a moderate
signal from a strong one at a glance.

Trace, scale rail and waterfall are drawn as three surfaces rather than one flat
field, so where each ends is visible rather than inferred. **The rail between
trace and waterfall is a handle: drag it to give either one more room**, from
15% to 85% of the panel. Grip marks in the gutter's width of the rail say so,
and the split is kept in `receiver.json` — how much history a band is worth is a
habit, not a per-session decision. The waterfall's bitmap is sized to the old
split, so its history restarts on a drag; there is no honest way to rescale it,
since stretching would put rows at times they did not happen.

Before the first frame arrives the panel draws the scale and the presets on it.
The receiver's frequency and IQ width are known without a frame — from the
status feed, and from `receiver.json` when even that is not up yet — so what is
missing while waiting is the trace, not the axis: the frequency scale, the
preset names, the passband marker and the dB scale are all there, and the
notice sits in the empty waterfall well where it does not cover a label. With
no saved width either (a first run), the panel falls back to an unlabelled
graticule rather than inventing a scale the receiver never reported.

The display's own settings are kept: the dB window, the zoom, the waterfall
depth and the last IQ width, written a beat after the last slider move so a
drag is one file write rather than one per mouse event. They used to be rebuilt
from defaults on every launch, which meant a receiver that came up on a band
you had already set the window for showed a flat line until you set it again.

**The frequency readout tunes digit by digit.** Click above a digit to step that
decade up, below it to step down, or scroll over it — the way most SDR
front-ends work, and the fastest way to move a known distance: 954 kHz to
1134 kHz is two nudges of the 100 kHz digit rather than twenty presses of a tune
button. Every decade from 100 MHz down to 1 Hz has a digit, so anything is
reachable by hand — which a unit-switching readout cannot offer: in MHz form the
smallest digit was 10 kHz, and nothing finer could be tuned at all.

The digits are grouped in threes and labelled kHz, so `594.000 kHz` reads as
what it is. The unit is a label, not a conversion — the rightmost digit is
always 1 Hz — but calling the same digits Hz made the last group read as a
fraction of the wrong unit.

Digits above the first significant one are not drawn, and the readout starts at
its left edge, under the station name. Dimmed leading zeros were the first cut
and left the number floating a third of the way across the header with the
station name over nothing. The decades that disappear stay reachable: a step
adds its weight rather than wrapping inside the digit, so pushing the leftmost
digit up carries the number into the next decade and the digit for it appears.
That carry also slides the digits one cell left under a stationary pointer, so
the next click there lands on the new decade rather than the one just pushed.

The options panel down the right carries what the deck's Property Inspector
carries: the demod's own settings, the receiver-wide ones, the audio output
including the icecast URL and bitrate when that is the output, and the two
station databases with a row each to refresh them. The icecast password is
deliberately not among them — it stays in the config and the Property
Inspector's masked field rather than passing through a loopback endpoint with
no authentication. Rows that the endpoint does not offer are not drawn at all,
so the standalone app, which answers its own `/receiver` and has neither an
icecast publisher nor the plugin's databases behind it, shows only what it can
actually do.

It is a column of controls, not a table of readings: clicking a row steps its
value on. It says so now — the pointer
becomes a hand and the row lifts under it. Without that the only way to find
out the panel was live was to click it and see something change. Host and port
are typed rather than cycled, in flat wells rather than system bezels, which
had them sitting on the panel as two widgets from a different toolkit.

Zoom and the dB window sit as vertical sliders down the right edge (ZOOM / MAX /
MIN), since those are the three you ride while watching a waterfall. MAX above
MIN, because the dB scale they act on runs that way — with them the other way
round, pushing the upper handle up moved the bottom of the window, which reads
as a control wired backwards. Zoom is done in the app — every frame already
carries all the bins, and asking for a narrower FFT would cost the resolution
zooming is meant to reveal.

The window's readout beside HOLD is filled in from the sliders when the rail is
built. It used to be a fixed `-100 / -20 dB` in the layout that nothing replaced
until a slider was touched, so until then it described a window the spectrum was
not using: the receiver comes up on `-160 / -1`, matching the FFT dial's default
on the deck.

Signal and noise are a segmented meter over a labelled scale, with a peak that
hangs behind the reading — not a track with a fill, which is what the volume
control below is, and an instrument that looks like a control invites a drag
that does nothing. The meter takes whatever width the header has left over, so
the readout beside it can change width with the frequency without leaving a hole
in the middle.

The toolbar carries STEP alongside the display settings. STEP goes to the
receiver, and the TUNE buttons
snap onto the step's grid on the first press when the receiver is off it:
Japanese medium wave sits on multiples of 9 kHz, so a receiver parked on
960 kHz by a coarser step otherwise walks 969, 978 … and never lands on a
station.

**The step follows the band, not just the mode.** Medium wave and short wave
are both AM, so a step remembered per mode carried MW's 9 kHz onto the 49 m
band, where the channels are 5 kHz apart and every press landed between two
stations. Crossing 1.8 MHz now moves the step to the raster of the band being
entered — 9 kHz on MW, 5 kHz on HF broadcast, 100 kHz on FM, 12.5 kHz on
narrow FM — and each band remembers what was last chosen in it, so a step set
by hand is not overwritten by moving away and coming back. SSB and CW have no
raster; they start at 1 kHz and 100 Hz, which is a place to begin rather than
a grid to land on.

The right-hand panel carries every setting the receiver exposes, not just the
demod's: below the mode-specific block and RF gain sits a RECEIVER section with
tune mode, JP region, audio device, output mode, SDR++ auto-sync, a one-shot
import, and the server host and port (typed, applied on Enter — changing either
dials the new address). Those are the Property Inspector's settings — a window that can drive
the radio but not configure it is half a front-end.

The mode-specific block swaps with the demod: FM gets
bandwidth, de-emphasis, stereo, IFNR and the audio filters; AM gets bandwidth,
sync detection and the carrier AGC; SSB/CW get bandwidth and BFO pitch; all of
them get RF gain. One Gain row, on whichever of the two stored indices the live
mode uses — AM has its own, everything else shares the other, which is the
split the demodulators themselves make. Clicking a row advances it. Values are never cached here —
the panel redraws from what the receiver reports, so a change made on the deck
shows up in the window.

The rest of the toolbar follows SDR++'s display panel: FFT
size, framerate and averaging (pushed to the receiver through
`/spectrum`, since the FFT runs there and the deck's own FFT dial shares that
pipeline), plus peak hold and the dB window (this app's own view of the same
data, so they stay local). The controls render from what the receiver reports
rather than from what was asked for.

Not there yet, and visible as `—` rather than invented: bandwidth, tune step,
per-mode options, RF gain, IQ rate and the demod-mode selector. Those need
fields the status feed does not publish yet, plus a `/mode` endpoint on the
control server.
