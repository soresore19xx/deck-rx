# DRM — the shortwave digital-radio decoder

Deck RX Solo (and, once it has a screen, the iPad build) can decode **Digital
Radio Mondiale**. The decoder is not written here: it is
[JvanKatwijk/drm-receiver][up] with Qt taken out of it, which this directory
fetches and patches on demand.

```
./fetch.sh          fetch, patch and build everything (a few minutes, once)
./fetch.sh clean    throw build/ away
../build-app.sh solo
```

`build-app.sh` and `build-ios.sh` look for `drm/build/drm-core/out/<slice>/libdrmcore.a`
and compile the DRM sources only when they find it. **Without it the app builds
exactly as it did before** — no DRM window, no menu item, no link-time
dependency. So a checkout that never runs `fetch.sh` is not broken, only
smaller.

## What is checked in, and what is not

Checked in: `qt-strip.patch` (our changes to the decoder), `src/` (files that
are ours outright), and the build scripts. **Nothing of upstream's is checked
in**, and neither is fdk-aac or Eigen. `fetch.sh` downloads them:

| | from | pinned at |
|---|---|---|
| decoder | github.com/JvanKatwijk/drm-receiver | `ca8e7e0` (2025-10-17) |
| Eigen | gitlab.com/libeigen/eigen | 3.4.0 |
| fdk-aac | github.com/mstorsjo/fdk-aac | v2.0.3 |

The decoder commit is pinned rather than tracked: `qt-strip.patch` is written
against that tree, and a decoder that moved underneath it would fail somewhere
in the DSP instead of failing to build. If upstream has moved and the patch no
longer applies, `fetch.sh` says so and stops.

## Licence

The decoder is **GPL-2.0-or-later** and deck-rx is **GPL-3.0-or-later**. The
"or later" makes them the same licence for this purpose, so there is nothing to
reconcile — the patch and everything in `src/` are GPL too.

**fdk-aac is the one real constraint.** Fraunhofer's licence grants no patent
rights, which does not combine with the GPL in a *distributed binary* — the
same reason ffmpeg calls a `--enable-gpl --enable-nonfree` build
unredistributable. Two things follow, and only two:

- Publishing source is fine, and is all this repository does.
- **A binary built here must not be handed on.** Build it, run it, keep it.

Building and running it on your own machine triggers no obligation at all; the
GPL does not reach private use. Note separately that the GPL and the App Store
terms do not agree, so an App Store build is out — the iPad app is sideloaded,
so this changes nothing today.

## How the pieces fit

```
IQ from the SpyServer  ──▶ DrmResampler ──▶ drm_feed()  ──▶ drmDecoder
   (228 kHz, int16)          (Swift)         (C bridge)      (C++ core)
                                                                 │
                        DrmWindow ◀── drm_state_cb ──────────────┤
                        AudioSink ◀── drm_audio_cb  (48 kHz stereo)
```

- `src/drm_bridge.h` is plain C, so `swiftc -import-objc-header` is all Swift
  needs. State arrives as key/value strings (`facSync` = `"yes"`, `service` =
  `"DW DRM"`), deduplicated in the bridge because the decoder reports the same
  MER many times a second.
- **Both callbacks run on the decoder's worker thread.** Qt used to queue them
  onto the GUI thread; nothing does that now. `DrmSession` hops to the main
  queue before it hands anything to the window.
- `../Sources/DrmDecode.swift` holds the resampler. The SpyServer delivers
  `maxSampleRate / 2^n`, which against 12 kHz is 76/2^n — whole for 228 k, 456 k
  and 912 k, and 9.5 or 4.75 for the rest. A plain decimator would have covered
  two thirds of the cases and quietly mistuned the others, so it is a rational
  polyphase resampler (12000/inRate in lowest terms). The filter is only
  evaluated at output instants, so 456 kHz in is 1672 taps at 12 kHz out, about
  20 M multiplies a second.

Cost of a decode, measured: **8-9 % of one core, 51 MB**. The Qt application it
came from was 13-21 % and 170 MB for the same work — the difference is the
scope drawing.

## Testing it without a receiver

Two harnesses, because there are two halves and each can be right while the
other is wrong.

```
build/drm-core/build/drm-cli <file.wav> [offsetHz]   # the C++ core
../tools/run-drm-selftest.sh                         # the Swift front end
```

The reference recording is a DW broadcast whose decode is known: `service =
DW DRM`, QAM64, AAC 24000 mono, and about 30 s of audio out of a 44 s file. The
Swift harness runs it at 48000, 114000 and 228000 Hz — the awkward ratios are
the point.

## What the patch does

Every Qt signal in the decoder reported state to a window: sync lamps, MER
readouts, the station name, the running text. **Not one carried DSP data.** So
15 classes lost `QObject` / `Q_OBJECT` / `signals:` / `connect()`; since each
had connected its own signal to an identically named slot on `drmDecoder`, the
call sites became `m_form -> same_name (...)` and nothing was renamed.
`drmDecoder`'s slots kept their names and now forward to the `drmUI` callbacks.
`QString` became `std::string` (about 75 uses, all labels). The generated form,
`QSettings` and the two Qwt displays are gone; the scope feeds still drain their
ring buffers, because leaving them full stalls the writers. The worker was
already `std::thread`, not `QThread`.

`rate-converter.cpp` also went. Only the xHE-AAC path used it, and all it did
was call libsamplerate in `SRC_LINEAR` mode; `drmConverter` — which the AAC path
already used, with its own filters — covers exactly the rate list xHE-AAC can
produce, so it replaced it one for one. **fdk-aac is now the core's only
external library**, which is what makes the iOS build possible.

Two bugs surfaced that Qt had been hiding:

1. `wordCollector` wrote `this -> m_form = m_form;` — the parameter is `mr`, so
   the member stayed uninitialised. Harmless while the parent was only ever a
   `connect()` target named directly; once the member became the route to it,
   the first coarse-offset report segfaulted. Every other class shadows the
   member name in its parameter list, so only this one was wrong. It reads as
   "time sync but never FAC", which is also what bad propagation looks like —
   check the exit status before believing the airwaves.
2. Decimating with a 31-tap low-pass reaches time sync and reads the mode but
   never a valid FAC: at 48 kHz its transition is about 1.5 kHz wide and eats
   the outer carriers of a 10 kHz block. 255 taps at 5300 Hz is the floor.

## Status

The decode is proven on recordings, end to end, including audio. **No DRM
transmission has yet been received off the air here** — fifteen or more sweeps
across fourteen frequencies since 2026-09-01 have all come back empty. The
scheduled sweeps continue; the Saturday 12105 kHz TWR slot is the nearest
transmitter. xHE-AAC is unproven: the one sample available does not sync, and
the cause has not been separated from the quality of that recording.

[up]: https://github.com/JvanKatwijk/drm-receiver
