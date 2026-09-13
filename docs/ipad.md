# Deck RX for iPadOS

A receiver on the tablet, not a remote view of the Mac one: it opens its own
connection to the SpyServer, demodulates on the iPad and plays through
`AVAudioSession`.

Part of [deck-rx](../README.md).

```sh
native-app/build-ios.sh sim install    # simulator, no signing needed
native-app/build-ios.sh device         # signed, installed over the network
```

Landscape, and the width goes to the spectrum.

## On screen

- **spectrum and waterfall** with station labels. **Tap tunes, drag pans** — the
  same division SDR++ makes. Touching down marks where a tap would land and the
  readout follows it, so the frequency is legible before it is taken. The
  landing point snaps to the band's raster; without that, 954 kHz was not
  reachable by touch at all, a pixel of an unzoomed 456 kHz window being half a
  kilohertz.
- **the readout**, tuned by tapping a digit, with the station name above and the
  S and N meters beside it. Under it: the mode, the STEREO badge when a WFM
  pilot is locked, and the bandwidth.
- **tune keys** that are multiples of the mode's own step, with the step in the
  box beside them — `-100` is 900 kHz on medium wave and 10 MHz on FM, which a
  key marked `-100` cannot say on its own.
- **presets** grouped by band, with the row marked by the frequency the receiver
  is actually on rather than by what was last picked. Add / Edit / long-press to
  rename. The iPad keeps its own `presets.json`, not the plugin's.
- **an options sheet** carrying the live mode's settings only, so an AM receiver
  is never offered de-emphasis. Anything with more than two values is a
  pull-down showing the whole list.
- **a display rail**: zoom and waterfall depth as sliders, the dB ceiling and
  floor as rails beside the trace.

Controls sit in named, framed groups — DISPLAY, BAND, TUNE, MODE, AUDIO, SERVER
— the way a panel is silkscreened.

It connects to the server in the SERVER group the moment it opens — there is
no plugin on an iPad to borrow a receiver from, so there was never anything to
wait for. CONNECT drops the link and brings it back. (The **Connect at start**
row in the options sheet no longer decides anything; the setting it writes is
kept for the file's sake.)

The demodulators are the same files the Mac builds from, so the AM brick-wall
channel filter and the FM stereo reference both arrive here on a rebuild rather
than needing a port — see [The AM channel filter](solo.md#the-am-channel-filter).
The FM bandwidth list carries 250 kHz for the same reason it does on the Mac:
at 150 kHz a full-deviation stereo broadcast only separates by 30 dB.

There is no volume control: the iPad's own buttons are the volume, and a second
attenuator in series only costs headroom.

## DRM

Behind the key beside Options, and only in a build where
[`native-app/drm/fetch.sh`](../native-app/drm/) has been run. Four sync lamps,
the station name, the coding and the running text, with the audio going to the
tablet's own output. The panel is a sheet and the decode carries on when it is
dismissed — a signal takes a while to lock.

The weather fax decoder is compiled in but has no screen yet.

## First run

Connects to `127.0.0.1:5555`, the default the shared `RadioConfig` carries;
there is no plugin config on an iPad to seed a real address from. Address and
port are two boxes because they are two things, and `host:port` pasted into the
address box is still split correctly. Both are saved before the connect is
attempted, so a refused address survives to the next launch.

## When the SpyServer is on the other segment

A tablet on a wired adapter is usually on a different subnet from its Wi-Fi,
and a SpyServer that only has an address on the Wi-Fi side is reached over the
air whatever the cable is doing. At 456 kHz of int16 IQ that is 14.6 Mbit/s
without a pause, and the audio ring holds 0.12 s: every Wi-Fi hiccup longer
than that is heard as a dropout.

The fix is not in the app. A Mac with a foot on both segments can carry the
stream over the cable:

```
native-app/tools/spyserver-relay.sh install <the-Mac's-wired-address> <spyserver-host:port>
```

installs a launchd-kept socat relay on port 5555 (SpyServer's own default),
bound to that address and accepting only its own /24, so it is not a door in
from the Wi-Fi side. Point the iPad at the Mac's wired address, port 5555; it
picks the cable on its own, because the address is on the cable's subnet.
One install per wired address if the tablet may turn up on more than one.
`status` and `remove` do what they say; the log is
`/tmp/com.hogehoge.spyserver-relay.<address>.log`, one line per connection.

## Signing

Built by plain `swiftc`, so Xcode's automatic signing never runs: make the
provisioning profile by hand in the developer portal (device UDID → App ID → an
iOS App Development profile), download it, and the build picks it up by bundle
id. The device needs Developer Mode on (iPadOS 16+) and a pairing `devicectl`
agrees with.

If `security find-identity -v -p codesigning` reports no identities while a
valid certificate is installed, the WWDR intermediate is the usual reason — the
G1 that shipped with older keychains expired in 2023, and the current G3 has to
be added alongside it.

## What is still Mac-only

The JST/UTC clock, SDR++ import and sync, icecast publishing, output device
selection, and the RAW and DSB modes — six mode keys are what fits.

## Under it

Same `Sources/` tree as the Mac app; only `main.swift` (the AppKit window) and
`AppServer.swift` (the plugin's control endpoint, which an iPad has nothing to
answer on) are left out. The drawing views are shared rather than
reimplemented, so a fix to the spectrum lands on both platforms.

The audio path and the porting mistakes that had to be found parameter by
parameter — the drift tracking, the buffer depth, and the six settings the
Swift port had quietly invented for itself — are in
[standalone-app-port.md](standalone-app-port.md#ipad-the-audio-path).
