# Deck RX for iPadOS

A receiver on the tablet, not a remote view of the Mac one.

Part of [deck-rx](../README.md).

## iPadOS receiver

The iPad build is a receiver, not a remote view of the Mac one: it opens its
own connection to the SpyServer, demodulates on the tablet and plays through
`AVAudioSession`.

```sh
native-app/build-ios.sh sim install    # simulator, no signing needed
native-app/build-ios.sh device         # signed, installed over the network
```

**DRM** is here too, behind the key beside Options: the same four lamps, the
station name, the coding and the running text, with the audio going to the
tablet's own output. It appears only when `native-app/drm/fetch.sh` has been
run, exactly as on the Mac. The panel is a sheet and the decode carries on when
it is dismissed — a signal takes a while to lock and the receiver stays usable
while it does.

The weather fax decoder is compiled in but has no screen yet.

It compiles from the same `Sources/` tree as the Mac app. `main.swift` and
`AppServer.swift` are the only files left out — the first is the AppKit window,
the second is the control endpoint the plugin owns, which an iPad has nothing
to answer on. `iOSApp.swift` is the UIKit host: scene delegate, layout, preset
table and options sheet. The drawing views are shared rather than reimplemented,
so a fix to the spectrum lands on both platforms and cannot drift between them.

What the window carries:

- spectrum and waterfall with station labels, the split between them dragged
  with a pan gesture (`spectrumSplit`, same key the Mac app persists)
- the seven-segment readout, tuned by tapping a digit, with the station name
  above it, the S and N meters beside it, and a line under it carrying the demod
  mode, the STEREO badge when a WFM pilot is locked, and the bandwidth. Under
  rather than beside: the readout's width follows its own digits, so anything
  placed after it lands wherever the frequency happens to end, while the line
  below starts where the digits start every time
- the tune keys are multiples of the step, and the step is in the box with
  them: `-100` is 900 kHz on medium wave and 10 MHz on FM, which is not
  something a key marked `-100` can say on its own. It is a pull-down, carrying
  the plugin's own per-mode ladder (`RadioConfig.stepValues`), so a WFM
  receiver is not offered 100 Hz and a CW one is not offered 1 MHz
- the preset list grouped by band, with the row the receiver is actually on
  marked by frequency rather than by what was last picked. **Add** files the
  tuned frequency under the name the station database gives it, falling back to
  the frequency itself; **Edit** turns on swipe-to-delete; a long press on a row
  opens name, frequency and mode. Edits go to the app's own `presets.json` — the
  iPad has its own copy, not the plugin's
- **the spectrum tunes, and it pans.** A tap lands on the frequency under the
  finger; a drag carries the band sideways, with the receiver following as it
  goes so the band being dragged into fills in. The split between them is what the finger does, not where it is:
  drag moves the view, tap moves the receiver, which is how SDR++ divides the
  same two jobs. The rail between the trace and the waterfall stays a drag
  handle for the split.

  Touching down marks where a tap would land with a dashed cursor, and the
  seven-segment readout and the station name follow it, so the frequency being
  chosen is legible before it is taken — a tap is over too quickly to draw
  anything for, so the mark comes from the touch rather than from the tap.
  Moving turns the gesture into a pan and the mark goes with it. The landing
  frequency is snapped to the band's own raster, the same `config.step(for:)`
  the tune buttons ride: a pixel of an unzoomed 456 kHz window is half a
  kilohertz, so without the snap 954 kHz was not reachable by touch at all.
  Within the window nothing moves but the marker (see
  [Tuning inside the window](#tuning-inside-the-window))
- the controls in named, framed groups — DISPLAY, BAND, TUNE, MODE, AUDIO,
  SERVER — the way a panel is silkscreened. The name sits inside the frame at
  the leading edge rather than on a line of its own, all the names take the same
  width so every group's controls start at the same place, and the keys are
  raised on the recess the frame encloses
- band jump, and coarse/fine tune buttons that ride on the mode's own tune step.
  The step follows the raster the band is channelised on, filed under the
  plugin's own key (`"2:mw"`, `"2:sw"`, `"2:vhf"` for AM, the mode number for
  everything else): FM 100 kHz, NFM 12.5 kHz, AM 9 kHz on medium wave and 5 kHz
  on short wave, SSB 1 kHz, CW 100 Hz
- a display rail: zoom and waterfall depth as sliders, the dB ceiling and floor
  as vertical rails beside the trace, MAX above MIN to match the axis
- an options sheet with the live demod's own settings, RF gain, IQ NR,
  levelling, the spectrum's framerate (5 / 10 / 16 / 24 / 30 / 60 fps) and
  smoothing, tune mode, JP region, connect-at-start and the UI scale — the
  sheet rebuilds on a mode change, so an AM receiver is never offered
  de-emphasis. Every row with more than two values is a pull-down carrying its
  whole list with the current one checked: the rows used to step and wrap the
  way the Mac panel's do, which is fine for three options and tedious for
  eight, and never says what the eight are. Booleans still toggle on a tap, and
  their rows are the only ones that still offer themselves to one. `uiScale` is the same `min` / `middle` / `max` the Mac window
  reads, out of the same file, and applies in place: the layout is rebuilt at
  the new scale with the receiver still running (the waterfall's history
  restarts, its bitmap being sized to the old panel)
- the app is landscape: the layout spends its width on the spectrum

The output buffer is sized for the rate this actually runs at — 114 kHz stereo
is 228 000 samples a second — and holds about 1.1 s, which is the room the
plugin's own reader-stall absorb has. It also primes: playback banks 0.12 s
before it starts reading, and re-primes after a dry run rather than scraping the
bottom of the ring buffer by buffer. That depth is what the listener feels as
the delay between turning the dial and the audio following, and it only has to
cover jitter — the drift is cancelled separately, below.

**The reader tracks the ring's depth.** The sender's clock (the receiver's
crystal, by way of the server) and the device's audio clock are independent and
drift apart by tens of ppm; with a fixed conversion ratio that difference has
nowhere to go, so the ring fills until it overflows or empties until it
underruns. The plugin answers this with libsamplerate, trimming the resampling
ratio to hold its queue at a set depth. `AudioSink` runs the same loop one level
down: it walks the ring at a fractional rate with linear interpolation, reading
a hair faster when the ring is deeper than the target and a hair slower when it
is shallower (`AudioSink.trackedRate`). The correction is capped at 0.4% — two
orders of magnitude more than the drift it cancels, and under three cents of
pitch, approached slowly so there is no waver to hear. Latency therefore stays
at the prime depth instead of wandering between it and the size of the ring.

The status line carries two numbers worth reading when the audio breaks up:
`drops` counts samples the output asked for and the ring did not have, and
`gap` is the longest pause between two IQ packets in the last ten seconds.
`drops` also carries the gap as it stood when the count last moved, which is
the one that matters: a live gap says what the network is doing now, that one
says what it was doing when the audio actually broke. Together they separate the
two causes — a large gap means the samples were late (network or server), a
small one means they arrived on time and this end could not keep up.

Audio and display run on separate queues. The RMS pass behind the meters walks
every sample of every packet and the FFT's ring is trimmed with a memmove;
both used to sit on the audio queue, so each packet paid for them before the
next could be demodulated, and the 30 Hz transform could land between a packet
and its audio. Only the audio has a deadline, and only it runs at
`.userInitiated`.

**The signal path is the plugin's, parameter for parameter.** The Swift port had
acquired settings of its own, and each one cost audio quality: an audio
decimation of `audioDecimate * 12` where the plugin uses the configured value
(9.5 kHz instead of 114 kHz, whose Nyquist sat below the 15 kHz anti-alias
filter — a 6 kHz tone came back at 3.5 kHz, which is what wrecked sibilants);
audio filters hard-coded off instead of following `fmLowPass` / `fmHighPass`;
de-emphasis with no "off" branch; and no output mute window at all, where the
plugin opens one around every gain change, retune and mode change so the
amplitude step is not heard. Those are gone.

A later sweep, comparing the two implementations parameter by parameter rather
than symptom by symptom, found six more: the AM sync PLL ran a 100 Hz loop where
the plugin runs 150 Hz (which is what lets the retune mute window be 200 ms
rather than 400); the AM carrier AGC's attack and decay were hard-coded, so the
two rows for them in the options sheet did nothing, and were pinned to 57 kHz,
so the real time constant moved with the audio rate; the attack default was 20
against the plugin's 50; RSSI was smoothed at 0.8/0.2 instead of 0.9/0.1 and did
not subtract the gain the server reports in each packet header, so it read the
receiver's amplification as signal; and SNR was not smoothed at all. Everything
else — every filter cutoff and Q, the stereo PLL and its phase-detector LPF, the
IF filter's clamps and transition width, the demodulator gains, the AM and CW
AGC set points and look-ahead, the IQ noise reduction's bins and window, the
FFT's window and its frame-to-frame EWMA, the soft limiter's knee, the per-mode
makeup — matches value for value.

A later one again: the RF gain index never reached the demodulators. FM, SSB
and CW detect an angle, not an amplitude, so the server-side gain moves the
RSSI and leaves the audio where it was — the plugin carries the index into the
demodulator's own output gain for exactly that reason (`8/8` full scale, `0/8`
silent, spyService.ts:1349), and without it the Gain row was inert in every
mode but AM. AM's own scale was `gain / 10` against the plugin's
`amGain / maxGainIndex`, so it topped out at 0.8. And the app kept **one** gain
where the plugin keeps two — AM pulled down against a strong medium-wave
neighbour, FM wanting all of it — so a `fmGain` in the config file was read and
discarded. There are two now, migrating a pre-split `gain` into the AM one, and
the row shows whichever the live mode uses.

When something sounds different between the two, the difference is a bug in
this one.

There is no volume control in the app: the iPad's own buttons are the volume,
and a second attenuator in series only costs headroom.

Still Mac-only, and deliberately so unless asked for: the JST/UTC clock, SDR++
import and sync, icecast publishing, output device selection, and the RAW and
DSB modes (six segments are what fits).

**First run** connects to `127.0.0.1:5555`, the same default the shared
`RadioConfig` carries — there is no plugin config on an iPad to seed a real
address from. Address and port are two boxes, because they are two things: an
address is typed once and a port almost never. Both are persisted before the
connect is attempted, so a refused address survives to the next launch, and
`host:port` pasted into the address box is still split correctly — the pair is
there to be typed into, not a format to be obeyed.

**The icon** is rendered from `native-app/icon-ios.svg` at build time and named
in `Info.plist`. A bare `swiftc` build has no asset catalogue, so the PNGs sit in
the bundle root in the older form iOS still resolves — no `actool` needed. The
plate runs edge to edge because iOS masks the corners itself.

**Signing.** The bundle is built by plain `swiftc`, so Xcode's automatic signing
never runs: the provisioning profile is made by hand in the developer portal
(device UDID → App ID → an iOS App Development profile), downloaded, and picked
up by bundle id. The device needs Developer Mode on (iPadOS 16+) and a pairing
`devicectl` agrees with. If `security find-identity -v -p codesigning` reports
no identities while a valid certificate is installed, the WWDR intermediate is
the usual reason — the G1 that shipped with older keychains expired in 2023 and
the current G3 has to be added alongside it.
