# Standalone app port — plan of record

> **Shipped as two bundles (2026-08-23).** `Deck RX.app` stays what it was:
> a front-end onto the plugin's receiver, and the Stream Deck profile's
> `AppIdentifier` still points at it. `Deck RX Solo.app` is the same window
> with its own receiver inside. One source tree, one `STANDALONE` compile
> flag; the receiver sources are not compiled into the front-end at all, so
> a display fix lands in both and cannot drift. Nothing stops both running
> at once — that is the user's call, not the build's.

**Decision (2026-08-23):** the native app becomes a complete receiver in
Swift. Not a front-end that needs the plugin running, and not a remote
front-end talking to studio over the network — a `.app` that can be copied to
any Mac and used.

**Why:** the current split buys nothing. The app already owns no receiver
state, so it is useless without the plugin on the same machine, and in
exchange the whole thing inherits Node plus two ABI-locked native modules
(`naudiodon`, `deck-rx-asrc`) that must be rebuilt against whatever Node the
Stream Deck app ships. Portability is the point; a receiver that only runs on
studio is what the user does not want.

## What actually has to move

Measured 2026-08-23. Line counts are the TypeScript being replaced, not an
estimate of the Swift.

### Ports (the real work)

| Source | Lines | Notes |
| --- | --- | --- |
| `SpyClient.ts` | 249 | SpyServer wire protocol. Compact and fully specified — binary framing, a handful of commands, three IQ formats. Lowest-risk piece, and everything else waits on it. |
| `demodulator.ts` | 1096 | WFM/NFM/AM/SSB/CW, AGC, FM stereo PLL. The largest single body of tuned behaviour. |
| `dspFilters.ts` | 165 | Filter design/state used by the above. |
| `iqnr.ts` / `ifnr.ts` | 434 | Noise reduction, pre- and post-demod. |
| `audioLeveling.ts` | 154 | Per-band makeup, opt-in AGC, tanh limiter. Already unit-tested — port the tests too. |
| `spyService.ts` | 1814 | **Only the receiver half.** Much of this file is Stream Deck listener plumbing (`subscribeX`/`unsubscribeX` pairs, settings persistence for dials) that the app does not need in that shape. The connect / retune / gain / demod-option state machine is what ports. |
| `bandPolicy.ts`, `deviceBands.ts` | 176 | Receivable-range rules, incl. the Airspy HF+ 31-60 MHz gap. |

### Replaced by system frameworks (deleted, not ported)

| Source | Lines | Replacement |
| --- | --- | --- |
| `fft.ts` | 144 | Accelerate / vDSP |
| `AudioOutput.ts` | 619 | AVAudioEngine |
| `asrc.ts` + `native/samplerate` | 77 + native | AVAudioConverter |
| `audioDevices.ts` | 71 | AVAudioEngine device enumeration |

**This is the payoff.** Both native modules disappear, and with them
`npm run rebuild-native` and the Stream Deck Node ABI coupling.

### Stays in Node, unchanged

The station-database scrapers (`japanStationsScraper.ts` 521,
`musenScraper.ts` 314, `eibi.ts` 211) are offline tools that produce JSON. The
app reads their output. Porting them would be work with no user-visible
return.

### Not needed in the app

`icons.ts`, `dialDisplay.ts`, `actions/` — Stream Deck rendering.

## Phases

Ordered so the riskiest unknown is settled first and each phase ends in
something that can be run.

1. **Swift `SpyClient`** — connect, device info, set frequency / gain /
   decimation, receive IQ. Ends when the app draws a live spectrum from its
   own connection with the plugin stopped.
2. **Audio out** — AVAudioEngine sink + AVAudioConverter resampling, driven by
   a single demod (AM first: it is the one with the longest history of
   trouble, so it is the honest test). Ends when the app is audible on its own.
3. **Remaining demods + options** — WFM/NFM/SSB/CW, the per-mode option sets,
   noise reduction, levelling. Ends when the app matches the plugin by ear and
   by meter on every band.
4. **Deck becomes a client** — the plugin drops its own signal path and drives
   the app through the control endpoint. **Dropped; see below.** The server
   half was built and is useful on its own.

Phases 1-3 leave the plugin untouched and working, and nothing user-visible
was ever removed.

## Risks worth naming up front

- **Two implementations exist during phases 1-3.** A demod fix made in one and
  not the other is the obvious failure. Mitigation: no phase is "done" until
  the app is compared against the plugin on the same signal, and phase 4 ends
  the duplication rather than leaving it standing.
- **`demodulator.ts` carries tuning that is not obvious from the code.** The AM
  path in particular has a documented history (see the noise investigation in
  memory: the root cause was a CoreAudio reader stall, and the fix is a
  two-stage response in `write()`). Porting it as if it were plain DSP will
  reintroduce settled bugs. Read the git history of each function before
  porting it, per CLAUDE.md.
- **AVAudioEngine is not a drop-in for the PortAudio path.** The current sink
  has drift compensation and queue policy that exist because of measured
  failures, not theory.

## Status

Phases 1-3 are done. DIRECT connects the app to SpyServer itself, AUDIO
demodulates and plays, and with both on the plugin can be stopped.

Ported and verified against the TypeScript on synthetic signals:

| Piece | Result |
| --- | --- |
| FFT (vDSP) | median difference 0.000015 dB, worst 0.089 dB at -120 dB |
| AM | 100.7 dB agreement |
| WFM mono / stereo | 58.8 / 63.2 dB |
| NFM | 76.4 dB |
| USB / LSB | 92.5 / 79.0 dB |
| CW | 102.5 dB |
| Station names | 1360 lookups across 4 regions, 0 mismatches |
| Output levelling | softLimit exact, AGC within 5e-10 |
| IF noise reduction | 91200 samples, 10 differ, all by 1 LSB |

Every demod's worst-case sample difference is 3.05e-05 = 1/32768: the
TypeScript rounds to int16 and the Swift keeps doubles, so that is
quantisation in the reference, not error here. WFM scores lowest only
because its output RMS is 0.015 and the same one-LSB gap is a larger
fraction of it.

`naudiodon` and `deck-rx-asrc` are absent from this path — AVAudioEngine
owns the device and AVAudioConverter does the rate conversion.

### Nothing is left on the plugin

Settings, presets, the station databases and the SDR++ import all moved
across, and the data files moved with them.

Everything the receiver reads now lives in
`~/Library/Application Support/deck-rx/data`. It was still pointing into
the plugin's bundle until this was checked properly — presets and all
three station databases — which meant a Mac without the plugin had no
directory to read and would have come up with no presets and no station
names. The station databases ship inside the `.app` and seed that
directory on first launch; `presets.json` deliberately does not, because
one host's station list is not a sensible default for another machine.
A plugin install is still used as a seed source when one is present.

Verified with the app's data directory seeded **only** from the bundle:
41 MW and 97 FM names from the JP DB, 895 shortwave entries active at
that moment from EIBI, and a config fallback of 127.0.0.1:5555 when
neither config file exists.

`RadioConfig` is the app's own file, in
`~/Library/Application Support/deck-rx/receiver.json`. The plugin's
`config.json` seeds it on a first run — so a machine with both comes up
where the deck left off — and is never written back to. Two processes
writing one JSON file is how a setting silently reverts.

`PresetStore` does the SDR++ import the plugin's PI button did, from the
IMPORT control. SDR++'s `frequency_manager_config.json` stays read-only,
which is not a preference: its parser is strict about indentation, float
bandwidths and ASCII names, and a plain JSON round-trip breaks SDR++ on
its next launch.

One deliberate difference from the plugin. The plugin iterates the
source in file order, which decides something it should not: a simulcast
broadcaster is one name at two frequencies (NHK at 594 kHz and
82.5 MHz), the store is name-keyed, so whichever is seen first wins and
the other is dropped — making the result depend on the order SDR++
happened to write its file. This iterates by ascending frequency, so the
MW entry wins, which is the one whose name came from the MW table. On a
37-bookmark import the counts are identical (31 added, 6 skipped) and 26
of 31 entries match exactly; the 5 that differ are precisely the
MW/FM simulcast pairs.

### Phase 4 — the app serves what the plugin serves

The app now produces all three interfaces it used to only consume: the
loopback control endpoint on 8771, the status feed file, and the
spectrum socket. Wire formats are the plugin's, unchanged, so anything
that already speaks them — the deck, and `knobctl`, which has spoken
this protocol since it was written — can drive the app instead.

Ownership is exclusive and checked, not assumed. Binding is attempted
and allowed to fail: with the plugin running it owns the port, and the
app says so ("plugin owns :8771") rather than fighting for it. Two
receivers answering the same requests at random is the failure this
avoids.

Verified by standing the server up on an isolated port and calling it:

    /health           200  {"ok":true,"receiver":"native-app",...}
    /tune?hz=1242000  200  freqHz 1242000
    /mode?m=2         200
    /volume?v=0.55    200
    /mute             200
    /step?hz=9000     200
    /preset?d=1       200  freqHz 1260000
    /tune?ticks=2     200  freqHz 1278000
    /nope             404

with the status feed written and parseable, and the spectrum socket
present. `/preset` answers **409** with an empty store, which is the
behaviour worth keeping: a control path with nothing to land on must not
look identical to a working one from the far side.

### The client half is not going to be built

The plugin keeps its own signal path.

The only argument for converting it was not having to make a demod fix
twice. That cost is only paid if the plugin keeps changing — freeze it
and there is nothing to pay. Against that: 12 actions read `spyService`
at 380 sites (84 in `spyDialTune.ts` alone), synchronous reads would
become asynchronous, and push subscriptions would become polling. The
Tune dial's auto-jump timing is exactly where this repo has been bitten
twice before, and it is documented in CLAUDE.md for that reason.

The deck's dials and screens are not redundant with the app either.
Physical controls are their own thing, so this was never a question of
consolidating onto one front-end.

Running both at once is fine and needs no guard. SpyServer takes multiple
clients by design — running SDR++ alongside deck-rx is how every
comparison in this port was made.

## CPU, measured

An 11-inch MacBook Air from 2015 (two cores, Broadwell) runs the receiver
at 79% of a core. What moves that number is not what I assumed:

| setting | CPU |
| --- | --- |
| FFT 4096, 30 fps, IQ 456 kHz | 79% |
| FFT 1024, 10 fps, IQ 456 kHz | 84% |
| FFT 1024, 10 fps, IQ 228 kHz | 44% |

FFT size and frame rate do essentially nothing. Demodulation runs per IQ
sample — a 16th-order IF filter on I and Q for AM, an atan2 per sample
for FM — which at 456 kHz is millions of operations a second, and a
transform 30 times a second is noise beside it. Only the IQ rate matters.

Halving it to 228 kHz costs FM quality, and that is documented rather
than theoretical: the plugin raised its own default from 228 to 456 kHz
because far-adjacent FM stations aliased back into the audible baseband.
AM is unaffected — a 9 kHz channel does not care. So on a slow machine
used mostly for medium wave, `iqDecimation: 2` is a real option; on one
used for FM it is not.

Stereo still locks at 228 kHz (pilot 0.10 on J-WAVE), so the lock is not
the thing that degrades.

## iPad: the audio path

Moved here from `ipad.md`, which is a page about using the app rather than
about how it was got right.

The output buffer is sized for the rate this actually runs at — 114 kHz stereo
is 228 000 samples a second — and holds about 1.1 s, the room the plugin's own
reader-stall absorb has. It primes too: playback banks 0.12 s before it starts
reading, and re-primes after a dry run rather than scraping the bottom of the
ring buffer by buffer. That depth is what the listener feels as the delay
between turning the dial and the audio following, and it only has to cover
jitter — the drift is cancelled separately.

**The reader tracks the ring's depth.** The sender's clock (the receiver's
crystal, by way of the server) and the device's audio clock are independent and
drift apart by tens of ppm; with a fixed conversion ratio that difference has
nowhere to go, so the ring fills until it overflows or empties until it
underruns. The plugin answers this with libsamplerate, trimming the resampling
ratio to hold its queue at a set depth. `AudioSink` runs the same loop one level
down: it walks the ring at a fractional rate with linear interpolation, reading
a hair faster when the ring is deeper than the target and a hair slower when it
is shallower (`AudioSink.trackedRate`). The correction is capped at 0.4 % — two
orders of magnitude more than the drift it cancels, and under three cents of
pitch, approached slowly so there is no waver to hear. Latency therefore stays
at the prime depth instead of wandering between it and the size of the ring.

The status line carries two numbers worth reading when the audio breaks up:
`drops` counts samples the output asked for and the ring did not have, and
`gap` is the longest pause between two IQ packets in the last ten seconds.
`drops` also carries the gap as it stood when the count last moved, which is the
one that matters: a live gap says what the network is doing now, that one says
what it was doing when the audio actually broke. Together they separate the two
causes — a large gap means the samples were late (network or server), a small
one means they arrived on time and this end could not keep up.

Audio and display run on separate queues. The RMS pass behind the meters walks
every sample of every packet and the FFT's ring is trimmed with a memmove; both
used to sit on the audio queue, so each packet paid for them before the next
could be demodulated, and the 30 Hz transform could land between a packet and
its audio. Only the audio has a deadline, and only it runs at `.userInitiated`.

### The signal path is the plugin's, parameter for parameter

The Swift port had acquired settings of its own, and each one cost audio
quality: an audio decimation of `audioDecimate * 12` where the plugin uses the
configured value (9.5 kHz instead of 114 kHz, whose Nyquist sat below the 15 kHz
anti-alias filter — a 6 kHz tone came back at 3.5 kHz, which is what wrecked
sibilants); audio filters hard-coded off instead of following `fmLowPass` /
`fmHighPass`; de-emphasis with no "off" branch; and no output mute window at
all, where the plugin opens one around every gain change, retune and mode change
so the amplitude step is not heard. Those are gone.

A later sweep, comparing the two implementations parameter by parameter rather
than symptom by symptom, found six more: the AM sync PLL ran a 100 Hz loop where
the plugin runs 150 Hz (which is what lets the retune mute window be 200 ms
rather than 400); the AM carrier AGC's attack and decay were hard-coded, so the
two rows for them in the options sheet did nothing, and were pinned to 57 kHz,
so the real time constant moved with the audio rate; the attack default was 20
against the plugin's 50; RSSI was smoothed at 0.8/0.2 instead of 0.9/0.1 and did
not subtract the gain the server reports in each packet header, so it read the
receiver's own amplification as signal; and SNR was not smoothed at all.
Everything else — every filter cutoff and Q, the stereo PLL and its
phase-detector LPF, the IF filter's clamps and transition width, the demodulator
gains, the AM and CW AGC set points and look-ahead, the IQ noise reduction's
bins and window, the FFT's window and its frame-to-frame EWMA, the soft
limiter's knee, the per-mode makeup — matches value for value.

A later one again: the RF gain index never reached the demodulators. FM, SSB and
CW detect an angle, not an amplitude, so the server-side gain moves the RSSI and
leaves the audio where it was — the plugin carries the index into the
demodulator's own output gain for exactly that reason (`8/8` full scale, `0/8`
silent, `spyService.ts:1349`), and without it the Gain row was inert in every
mode but AM. AM's own scale was `gain / 10` against the plugin's
`amGain / maxGainIndex`, so it topped out at 0.8. And the app kept **one** gain
where the plugin keeps two — AM pulled down against a strong medium-wave
neighbour, FM wanting all of it — so an `fmGain` in the config file was read and
discarded. There are two now, migrating a pre-split `gain` into the AM one, and
the row shows whichever the live mode uses.

**When something sounds different between the two, the difference is a bug in
this one.**

## Deck RX Solo: design notes

Moved here from `solo.md`, which is a page about using the app.

### Why it exists

The app owned no receiver state, so it was useless without the plugin on the
same machine — and in exchange the whole thing carried Node plus two ABI-locked
native modules (`naudiodon`, `deck-rx-asrc`) that had to be rebuilt against
whatever Node the Stream Deck app shipped. Portability was the point.

`fft.ts`, `AudioOutput.ts` and `asrc.ts` have no counterpart here: Accelerate,
AVAudioEngine and AVAudioConverter replace them, and both native modules are
absent from this path. The demodulators are ports, verified numerically against
the TypeScript — AM 100.7 dB agreement, WFM mono/stereo 58.8/63.2, NFM 76.4,
USB/LSB 92.5/79.0, CW 102.5. Worst-case sample difference is 1/32768 in every
mode, which is the reference rounding to int16 while this keeps doubles.

The plugin keeps its own signal path. Converting it into a client of this one
was considered and dropped: the only argument was not making a demod fix twice,
which costs nothing if the plugin is left alone, against 380 `spyService` call
sites and the Tune dial timing this repo has been bitten by before. Reasoning
in [docs/standalone-app-port.md](standalone-app-port.md).

### The display is drawn where the ear is

The transform was always taken over the newest IQ in hand, while the sound
being heard left the demodulator a ring's depth ago — so a signal appeared on
the waterfall about a fifth of a second before it could be heard, and rather
longer than that on Bluetooth headphones. The two are now drawn together: the
frame is transformed over samples as old as the audio latency
(`AudioSink.latencySeconds` — the ring's depth, plus the session's own output
latency on iOS), and the IQ buffer keeps enough history to reach back that far.

The delay is eased in rather than taken from the instantaneous depth: the ring
breathes around its target, and a display whose time axis jittered with it
would be worse than one that is honestly early. It is clamped to what is
actually in the buffer, so after a retune the display starts live and slides
back to the ear's own delay as the buffer refills, and it is zero when there is
no audio to be late for.

### Tuning inside the window

A tune used to move the device's own centre frequency, always. The IQ window is
drawn around that centre, so every tune re-centred the display — the spectrum
jumped, and the peak that was aimed at ended up in the middle of a redrawn
panel. That is fine for a dial and useless for a finger: aiming needs the
picture to hold still.

The device now stays where it is while the demodulator moves inside the window,
which is what SDR++ calls a VFO. `IQShift` (`Demods.swift`) is a
phase-continuous complex mixer that brings the wanted frequency to the centre
of the buffer before anything else sees it, so the noise reduction, the IF
filters and the detectors all receive exactly what they would have received had
the device been tuned there. It runs before the noise reduction as well as the
demodulators, and it is bypassed entirely — same buffer, same bytes — while the
offset is zero, which is every case that existed before.

How far the demodulator may sit from the centre is
`iqRate * 0.42 - bandwidth / 2`: the decimated stream is not flat to its own
edges, so the outer 8% at each end is left alone, and the passband has to fit
in what is left. On an Airspy HF+ at 456 kHz that is ±187 kHz for a 9 kHz AM
channel — about twenty medium-wave channels either way — and ±116 kHz for a
150 kHz FM one. Past that the device retunes and the window moves once, which
is what moving it is for. A mode change that widens the passband past the
current offset recentres for the same reason.

A **jump** is the exception, and it is not simply a tune with a larger number.
Choosing a preset, pressing a band button or walking the presets from the knob
is "take me to this station", and the display is expected to arrive as well.
Those callers pass `recenter: true` (`LocalRadio.setFrequency`), which skips the
offset test and moves the device even when the demodulator could have reached
the station on its own. Without it a preset a few channels away was answered
inside the window, so the spectrum stayed wherever the last pan or tap had left
it while the marker walked off towards the edge — which reads as a display that
has stopped following the receiver. Everything that aims — the digits, a tap on
the trace, the tune buttons, `/tune` — leaves it false, because a window that
moves under the finger cannot be aimed with.

Two other things follow. A tune inside the window is not a round trip, so it
does not wait on the server and does not throw away the IQ already in hand —
the trace carries on without a gap. And the red marker is no longer the middle
of the panel: `SpectrumView.vfoHz` puts it and the passband highlight where the
demodulator is, leaving the frame's own centre to the window.

**Panning** is the other half, and the one thing tuning inside the window
cannot do: it moves the window itself. Dragging the spectrum slides the trace
and the waterfall with the finger, and the receiver follows about six times a
second — not per touch event, since each step is a round trip, a demodulator
reset and a restarted transform, but often enough that the band being dragged
into fills in as it arrives rather than staying blank until the finger lifts.

Two things make that work. The view is held in absolute frequency
(`SpectrumView.viewCenterHz`) rather than as an offset in points, so the picture
moves at the speed of the finger while the receiver moves at its own, and the
difference between them closes on its own as each retune lands. That override
ends when a frame arrives from the centre the view is waiting for — or from any
other centre, since a preset chosen while the pan is still settling sends the
device to a third frequency and the one the view is holding is never coming
(`SpectrumView.overrideDone`); without the second half the window sat parked on
a piece of band nothing was receiving any more. And the
waterfall's bitmap is shifted by the same amount the centre moved, so a row
measured before the pan still sits under the frequencies it was measured at
— without that, every row drawn before a retune is a lie about where its
signals were, and a pan smears the history sideways.

What is being listened to does not change unless the pan would leave the
demodulator outside the window, in which case it is dragged along at the edge,
as SDR++ drags its VFO. The centre is clamped to what the device says it can
tune to, so a drag off the end of the band stops there rather than asking the
server for a frequency it would refuse without a word. The steps of a drag do
not rewrite the settings file; the one the gesture ends on does.

## The front-end window: design notes

Moved here from `native-app.md`, which is a page about using the app.

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
