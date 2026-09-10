# Deck RX Solo — the standalone receiver

The whole receiver in one bundle. No Stream Deck, no plugin, no Node.

Part of [deck-rx](../README.md).

![Deck RX Solo](solo-window.png)

## Using it

1. Check **Host** and **Port** in the options panel — it connects to them the
   moment it opens. Or set **Source** to `usb` and it opens an Airspy HF+ on
   this machine's own USB instead — see [Straight off USB](#straight-off-usb).
2. Pick a station from the list on the left — or type a frequency into the
   readout, or walk with **TUNE −/+**.

It connects and starts playing on its own, at the volume and mute state it was
left on. **AUDIO** stops the sound without dropping the link.

It is its own receiver and only its own. It does not read the plugin's status
file or its spectrum socket, and none of its controls reach over the loopback:
POWER, the preset pads and the volume all act on the receiver in this window.
The pad marked **DIRECT** is that receiver's link, up or down — it used to be a
source switch, where "off" turned the window into a front-end onto the plugin,
which is what made closing the window not stop the sound. The sound was never
this app's to stop. `Deck RX.app` is the bundle for looking at the plugin.

That is all of it. The rest, briefly:

| | |
| --- | --- |
| **PRESET ◀ ▶** | step through the list on the left |
| **TUNE − +** | one step, and the step follows the mode: 9 kHz on AM, 100 kHz on FM |
| **WFM … CW** | the mode. Bandwidth and the options panel follow it |
| **BAND JUMP** | MW, the shortwave metre bands, FM |
| **IQ** | the width the receiver runs at — the device's maximum halved by each decimation stage (912k / 456k / 228k / 114k on an Airspy HF+). Changing it reconnects |
| **STEP / FFT / RATE / SMOOTH** | the spectrum: resolution, frame rate, how much it is averaged |
| **HOLD** | freezes the trace; the waterfall keeps running |
| **NR / LVL** | noise reduction, and the output leveller |
| **IMPORT** | pulls SDR++'s bookmarks into the preset list |
| **ZOOM / MAX / MIN / TIME** (right edge) | span, the dB window top and bottom, and how much history the waterfall holds |
| **POWER** | disconnects and stops the audio |

Click anywhere on the spectrum or the waterfall to tune there, SDR++'s
mapping; hold the button down and the receiver follows the pointer. What is
clicked is snapped to the step in force, so a click next to 954 kHz lands on
954 and not on 953.7. A press that never travels more than five points is a
click, not a drag — without that, the tremor in a click slid the frequency out
from under it. The station name of whatever the marker is over appears above
it, and the picture is drawn where the ear is rather than where the samples
are, so what is seen and what is heard line up.

The meters, the drop count and every row in the options panel describe **this**
receiver. They used to be read off the loopback control
endpoint, which belongs to the Stream Deck plugin whenever the plugin is
running: the window then showed the plugin's gain, AGC and signal while driving
its own receiver, and the two disagreed silently.

A preset or a **BAND JUMP** brings the window with it: the spectrum re-centres
on where you asked to go. Everything that aims — the digits, a click on the
trace, **TUNE −/+** — leaves the window where it is, because a window that
moves under the pointer cannot be aimed with. Both presets either side of the
current centre used to be answered inside the IQ window, so the display
followed some presets and not others.

Closing the window quits, and quitting hands back what the process was holding:
the audio device, the SpyServer's single control slot, and on `usb` the Airspy
itself. **A tool window keeps the app alive** — with 気象ファクス or DRM open,
the main window's close button is not the last window closed, so the app stays
running and so does the audio. Close the tool window too, or use ⌘Q.

Settings live in `~/Library/Application Support/deck-rx/receiver.json` and are
written as they change — there is no Save.

## Straight off USB

`Source` in the options panel is `spyserver` (the address below it) or `usb`,
an Airspy HF+ on this machine's own bus. The device path is a translation
rather than a second receiver: it fills in the same `DeviceInfo` the SpyServer
client does, takes the same setting ids in the same order, and hands up the
same interleaved int16 IQ at the same scaling, so the levels a station reads at
are comparable between the two.

Two things follow from a device being a device. **One process owns it**: with
`usb` selected the plugin, SDR++ and anything else are locked out until Solo
lets go — a server shares a stream, a USB device does not. And the rate ladder
is the hardware's: 912 / 456 / 228 kHz come straight off the device, and
anything below that is decimated here, filtered before the drop rather than
after it.

It is built only where the library is. `build-app.sh` looks for libairspyhf and
libusb under `/opt/local` (`AIRSPYHF_PREFIX` moves that), links them statically
into the arm64 slice — MacPorts ships them arm64-only, so the Intel slice stays
what it was — and says which it did. Without them the app is exactly what it
was and the Source row offers the server alone.

## Weather fax and DRM

Both are in the **ツール** menu and take a copy of the same IQ the receiver is
already pulling, so neither interrupts listening.

**気象ファクス** (Cmd-F) records the current frequency for two, five or twelve
minutes and draws the chart — twelve is one JMH chart at 120 LPM. Recording
first and drawing after, because the line period is found by measuring the whole
page: the nominal 3000 samples is never exactly right, and an error of one part
in three thousand shears the chart across a third of its width.

**DRM** (Cmd-D) decodes Digital Radio Mondiale on shortwave: sync lamps, station
name, coding, bit rate and the running text, with the audio going to the same
output the receiver uses. Costs 8-9 % of one core.

![DRM](solo-drm.png)

The four lamps are the diagnosis, in order: TIME means the OFDM timing was found
— that happens on noise too — FAC means a frame was decoded, which cannot happen
by accident, SDC brings the station name with it, and AUDIO is the AAC decoder
accepting frames.

The decoder is not in this repository. **Run
[`native-app/drm/fetch.sh`](../native-app/drm/) once** to enable it; a checkout
that never does still builds, without the menu item. That directory's README
covers the licence, which is short: the decoder is GPL and so is this, so there
is nothing to reconcile, but fdk-aac's licence means **a binary built with DRM
must not be passed on**. Publishing source and running it yourself are
unaffected.

No DRM transmission has been received off the air here yet; the decode is proven
on recordings.

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

Neither `autoDirect` nor `autoAudio` is read any more: connecting and playing
both happen at launch. A radio that opens silent with nothing saying why is the
same friction as the DIRECT press this bundle stopped needing.

One consequence worth knowing: with the plugin also running, the two compete
for the radio. SpyServer gives control to whichever client connected first and
silently drops the other's retunes, so opening Solo while the plugin has the
device takes it away — the plugin keeps its own idea of the frequency and
demodulates whatever the window it can no longer move is centred on — until
whichever of them is left takes control back, which each now notices and acts
on (see [Sharing the receiver](#sharing-the-receiver)). The app says which side
of that it is on (**LISTEN ONLY** in the label, `canControl` in
`/health`, 409 from `/tune`). Run one at a time, or stop the plugin's receiver
from the deck first.

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

## Settings

`~/Library/Application Support/deck-rx/receiver.json`, seeded from the plugin's
`config.json` on a first run when there is one and never written back to it.
Host and port are editable from the options panel, so a copied app needs no
hand-edited file. The station databases ship inside the bundle and seed
`~/Library/Application Support/deck-rx/data` on first launch.

`source` is `spyserver` or `usb`, and `iqDecimation` is the offset from the
device's minimum — 0 is the device's full rate, 1 halves it. Both are on the
toolbar and in the options panel; the file is where they persist.

`audioDevice` is the one row in the options panel that opens rather than
cycles: a Mac has as many outputs as it has ever had devices attached, and
walking them one click at a time moves the audio to each in turn on the way
past. The list is read when the menu opens, so a device plugged in after the
window was built is in it.

It is bound when the audio engine starts, so choosing a different one rebuilds
the graph rather than waiting for the next connect. **Host** and **Port** dial
the new address the moment they are entered, connected or not — that gate used
to require an existing connection, which is the one state an address never gets
corrected in. Names are matched exactly,
trailing spaces and all — CoreAudio reports "DX7s " and "SMSL USB AUDIO " that
way, and trimming would fail to find the very devices the picker offered. A
name that no longer resolves falls back to the system default rather than
refusing to play.

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

## The AM channel filter

AM is filtered twice: a 16th-order Butterworth on the IQ at half the channel
width, and then a linear-phase brick wall on the detected audio — a Kaiser
window sinc, 100 dB down, 300 Hz of transition, run as a FIR through vDSP
(`Sources/BrickWall.swift`).

The brick wall is there because an IIR skirt cannot turn fast enough. Japanese
medium wave sits on a 9 kHz raster, so nothing above half the channel width
belongs to the station being listened to: it is the neighbours' splatter and
the band noise. Measured against SDR++ on 594 kHz, same SpyServer, same twenty
seconds, in dB relative to the 0.3-3 kHz program band:

| band | before | after | SDR++ |
| --- | --- | --- | --- |
| 4.0-4.5k | −9.5 | −9.1 | −9.0 |
| 4.5-4.8k | −19.0 | −21.0 | −35.3 |
| 4.8-5.2k | −23.9 | −104.1 | −88.3 |
| 5.2-6.0k | −29.5 | −101.1 | −85.7 |
| 6-8k | −40.1 | −97.1 | −81.7 |

Everything above the transition is now 15-20 dB quieter than SDR++, and the
passband matches it. The one band SDR++ still wins is its own transition,
300 Hz wide, where its FFT filter turns faster than 2433 taps can.

Two things were wrong before. The audio filter's cutoff was the full channel
width where the IF filter used half it, so the 4.5-9 kHz octave rode on the IF
skirt alone; and that skirt was an 8th-order Butterworth. The first is a
one-line fix worth 15 dB on its own and applies to the plugin too, which has
the same line.

The filter costs about 5% of a core at the 114 kHz audio rate and adds 11 ms of
constant delay. It designs itself from the bandwidth in force, and falls back
to the Butterworth cascade for a rate it cannot be built for.

## Sharing the receiver

SpyServer takes several clients at once and gives control to the first only. A
later client's retune is discarded silently, so the app reports it: `canControl`
in `/health`, **LISTEN ONLY** in the window, 409 from `/tune`, and the readout
follows the device rather than claiming a frequency nothing is receiving. There
is no arbitration — which client owns the radio is the user's call.

What is not the user's call is what happens when control comes back. The server
promotes whoever is left when the controlling client goes, and that arrives as
a sync with `canControl` newly true — no reconnect, no notice. Both this app
and the plugin now act on that edge: each keeps the frequency it was *told* to
be on, through every refusal, and re-issues it the moment it may. Without it a
client sat demodulating the piece of band the departed one had left the device
on, which looks and sounds exactly like a receiver that has stopped working —
and did, for twenty minutes, with nothing anywhere saying why.

## CPU

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


## Under it

Why this exists at all, how the display is kept in step with the ear, and
what tuning inside the window has to get right are in
[standalone-app-port.md](standalone-app-port.md#deck-rx-solo-design-notes).
