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
