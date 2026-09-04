# Deck RX Solo — the standalone receiver

The whole receiver in one bundle. No Stream Deck, no plugin, no Node.

Part of [deck-rx](../README.md).

![Deck RX Solo](solo-window.png)

## Using it

1. Type the SpyServer's address and port, and press **DIRECT**.
2. Press **AUDIO**.
3. Pick a station from the list on the left — or type a frequency into the
   readout, or walk with **TUNE −/+**.

That is all of it. The rest, briefly:

| | |
| --- | --- |
| **PRESET ◀ ▶** | step through the list on the left |
| **TUNE − +** | one step, and the step follows the mode: 9 kHz on AM, 100 kHz on FM |
| **WFM … CW** | the mode. Bandwidth and the options panel follow it |
| **BAND JUMP** | MW, the shortwave metre bands, FM |
| **STEP / FFT / RATE / SMOOTH** | the spectrum: resolution, frame rate, how much it is averaged |
| **HOLD** | freezes the trace; the waterfall keeps running |
| **NR / LVL** | noise reduction, and the output leveller |
| **IMPORT** | pulls SDR++'s bookmarks into the preset list |
| **ZOOM / MAX / MIN / TIME** (right edge) | span, the dB window top and bottom, and how much history the waterfall holds |
| **POWER** | disconnects and stops the audio |

Drag on the spectrum to tune; the station name of whatever the marker is over
appears above it. The picture is drawn where the ear is rather than where the
samples are, so what is seen and what is heard line up.

Settings live in `~/Library/Application Support/deck-rx/receiver.json` and are
written as they change — there is no Save.

### Weather fax and DRM

Both are in the **ツール** menu and take a copy of the same IQ the receiver is
already pulling, so neither interrupts listening.

**気象ファクス** (Cmd-F) records the current frequency for two, five or twelve
minutes and draws the chart — twelve is one JMH chart at 120 LPM.

**DRM** (Cmd-D) decodes the shortwave digital mode. It appears only in a build
that has the decoder; see [the DRM directory](../native-app/drm/).

![DRM](solo-drm.png)

The four lamps are the diagnosis, in order: TIME means the OFDM timing was
found — that happens on noise too — FAC means a frame was decoded, which cannot
happen by accident, SDC brings the station name with it, and AUDIO is the AAC
decoder accepting frames.

## Copying it to another Mac

Nothing has to be installed with it — no plugin, no Node, no native modules.

```sh
cp -R "/Applications/Deck RX Solo.app" /Volumes/somewhere/
# on the other machine, after copying:
xattr -dr com.apple.quarantine "/Applications/Deck RX Solo.app"
```

That last line is needed for a build signed here rather than one from a
[release](https://github.com/soresore19xx/deck-rx/releases/latest); see
[Handing it to someone else](#handing-it-to-someone-else) below.

`autoDirect` and `autoAudio` in the config do the two opening presses at
launch, which is the only way to drive it on a machine nobody sits at.

The menu bar is built by hand — there is no nib — so About and Quit exist at
all. About reports which of the two builds is running and what it is pointed
at, which is a real question with both installed.

### Handing it to someone else

The `xattr` line above is not a formality: `build-app.sh` signs with whatever
identity is in the keychain, and on a development machine that is an **Apple
Development** certificate. Gatekeeper rejects those on any Mac that did not
build them (`spctl -a -vv` says `rejected`), so a recipient meets "the developer
cannot be verified" and has to strip the quarantine flag by hand. That is fine
between one's own machines and poor manners towards anyone else.

`notarize.sh` is the other half, for a build that is actually going somewhere:

```sh
./notarize.sh                       # defaults to /Applications/Deck RX Solo.app
./notarize.sh "/path/to/Some.app" my-profile
```

It works on a copy — `/Applications` is never touched — re-signs with
**Developer ID** plus the hardened runtime and a secure timestamp, submits to
Apple, staples the ticket, and shows what Gatekeeper makes of the result. It
submits a zip and never a .dmg: notarytool mounts a disk image to look inside
it, and a mount that sticks leaves the tool waiting forever with nothing in
Apple's history to show for it.

Two things have to exist first, and it says so plainly if they do not:

- a **Developer ID Application** certificate (Account Holder, paid membership).
  Apple Development cannot be notarised. Look on the other machines before
  making one: a team may hold five and **a Developer ID certificate cannot be
  revoked**, so a wasted slot stays wasted. Make it through developer.apple.com
  rather than Xcode's Manage Certificates, which issues off the old G1
  intermediate and produces a leaf that expires when G1 does (2027-02-01)
  however new the certificate is — upload a CSR and pick the "G2 Sub-CA
  (Xcode 11.4.1 or later)" sub-CA explicitly.
- notarytool credentials, either stored in the keychain
  (`xcrun notarytool store-credentials <profile> --key AuthKey_X.p8 --key-id X --issuer <uuid>`)
  or passed in as `NOTARY_KEY` / `NOTARY_KEY_ID` / `NOTARY_ISSUER`, which is
  what works over ssh where a keychain profile cannot be read. An App Store
  Connect team API key rather than an app-specific password: it does not expire
  and no password lands in a script or a shell history.

**Signing has to happen in the desktop session.** Over ssh `codesign` cannot
reach the login keychain and fails with `errSecInternalComponent`, whichever
machine holds the certificate; the script says so when it happens. An ssh caller
can still start it there without a password — `open -a Terminal <wrapper>.command`
runs in the logged-in session.

It also does two things on its own initiative, both deliberate:

- **It refuses a bundle with the DRM decoder in it.** fdk-aac's licence does not
  combine with the GPL in a binary that is passed on, and this is the one place
  that rule can be enforced rather than remembered. Keep the DRM build for
  yourself — that was always allowed.
- **It drops the bundled `presets.json`.** Shipping one machine's station list
  is right for a second Mac of the same owner and wrong for a stranger, who
  should start empty rather than with someone else's listening.

One thing it cannot soften: a Developer ID signature carries the certificate
holder's name, which for an individual membership is a real one. `codesign -dvv`
on the result shows it, and so does the recipient's Gatekeeper dialogue. That is
how the mechanism works — worth deciding on before publishing a build rather
than after.

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

### Settings

`~/Library/Application Support/deck-rx/receiver.json`, seeded from the plugin's
`config.json` on a first run when there is one and never written back to it.
Host and port are editable from the options panel, so a copied app needs no
hand-edited file. The station databases ship inside the bundle and seed
`~/Library/Application Support/deck-rx/data` on first launch.

`spectrumSplit` is the fraction of the spectrum panel given to the trace,
dragged on the rail rather than typed.

`spectrumFftSize`, `spectrumFps` and `spectrumSmooth` are the transform itself
— how big, how often, and how much frame-to-frame averaging (a divisor: 1 is
off, larger is slower). The Mac's toolbar has written all three since it had
one; they simply had nowhere to live, so every launch started at the defaults
again. The framerate now also restarts the frame timer when it changes: the
period is read when the timer is scheduled, so the RATE dropdown did nothing
until the next connection. The iPad's options sheet carries the two that get
ridden, framerate and smoothing.

`uiScale` picks `min`, `middle` or `max` — fonts and every fixed dimension
scale together, since scaling only the text leaves the panels their full width.
The frequency readout and the station line above it take a further reduction on
top of that: they are the largest things on screen by a wide margin. Applied
immediately; the window is rebuilt in place and the receiver keeps running,
though the waterfall's history restarts because its bitmap is sized to the old
panel.

Both bundles read and write it, and neither sends it over the control endpoint:
the scale is the window's own size, and the endpoint on `:8771` may well belong
to the plugin, which has no opinion about it. It used to be asked for over that
link, so the row read `—` and its click came back 400 — in the front-end always,
and in the standalone app whenever the plugin held the port.

| scale | minimum window |
| --- | --- |
| max | 1435 × 784 |
| middle | 1278 × 681 |
| min | 1139 × 620 |

An 11-inch MacBook Air is 1366 × 768, so `compact` is what fits it.

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

### Sharing the receiver

SpyServer takes several clients at once and gives control to the first only. A
later client's retune is discarded silently, so the app reports it: `canControl`
in `/health`, **LISTEN ONLY** in the window, 409 from `/tune`, and the readout
follows the device rather than claiming a frequency nothing is receiving. There
is no arbitration — which client owns the radio is the user's call.

### Decoders: weather fax and DRM

Both live under **ツール** in Solo's menu bar and take a copy of the same IQ the
receiver is already pulling, so neither interrupts listening.

**Weather fax (Cmd-F)** records the VFO for a chosen length and draws the chart.
Recording first, drawing after, because the line period is found by measuring
the whole page — see below. Presets are the three JMH frequencies; twelve
minutes is one chart at 120 LPM. The decoder is `Sources/WefaxDecode.swift`,
verified against the same recordings the offline tools read.

The line period matters more than it sounds: the nominal 3000 samples is never
exactly right, and an error of one part in three thousand shears the chart
across a third of its width. Correlating each line against the next is too weak
to find it — on a real 7795 kHz capture it scored 0.013 and chose a period that
sheared the page. What works is the variance of the column-averaged row over the
whole picture: at the right period every line's graticule falls in the same
column and the contrast survives; at a wrong one the columns smear together.
Black and white levels come from the two peaks of the frequency histogram, not
from percentiles (which measure the noise between the strokes) and not from the
median (which lands on whichever level covers more of the page).

**DRM (Cmd-D)** decodes Digital Radio Mondiale on shortwave: sync lamps, station
name, coding, bit rate and the running text, with the audio going to the same
output the receiver uses. The decoder is not in this repository —
[`native-app/drm/`](../native-app/drm/) fetches and patches it, and the app links
it only if it is there. **Run `native-app/drm/fetch.sh` once** to enable it; a
checkout that never does still builds, without the menu item.

That directory's README covers the licence position, which is short: the
decoder is GPL and so is this, so there is nothing to reconcile; fdk-aac's
licence means **a binary built with DRM must not be redistributed**, though
publishing source and running it yourself are unaffected.

Cost of a decode: 8-9 % of one core, 51 MB. Verified end to end on recordings —
FAC and SDC sync, station name, QAM64, AAC 24 kbps, audio out. No DRM
transmission has been received off the air here yet.

### CPU

Measured on a 2015 MacBook Air 11 (two Broadwell cores):

| setting | CPU |
| --- | --- |
| FFT 4096, 30 fps, IQ 456 kHz | 79% |
| FFT 1024, 10 fps, IQ 456 kHz | 84% |
| FFT 1024, 10 fps, IQ 228 kHz | 44% |

FFT size and frame rate do essentially nothing: demodulation runs per IQ sample
and a transform thirty times a second is noise beside it. Only the IQ rate
matters, and halving it costs FM quality — the plugin raised its own default
from 228 to 456 kHz because far-adjacent stations aliased into the audible
baseband. AM does not care, so `iqDecimation: 2` is a real option on a slow
machine used for medium wave and not on one used for FM.
