# Deck RX

Stream Deck + plugin to control a remote [SpyServer](https://airspy.com/) and listen to AM/SW/FM radio directly from the Stream Deck encoder dials.

The plugin connects over TCP to a SpyServer (e.g., an Airspy HF+ Discovery on a NanoPi), pulls down INT16 IQ samples, demodulates them in TypeScript, and feeds the resulting PCM to a chosen macOS CoreAudio device via the in-process `naudiodon` (PortAudio) sink. An optional icecast publish path (PCM → MP3 → icecast SOURCE) is also available for streaming to a remote server.

![Deck RX — all four LCD panels](docs/lcd-combined.png)

Per-dial layouts and screenshots (Tune / Volume / Combo / FM / AM / SSB / Band Select / Options Auto / Options 2-Col / FFT Display): see [docs/dial-layouts.md](docs/dial-layouts.md).

## Requirements

| | |
|---|---|
| OS | **macOS** (Apple Silicon or Intel) — CoreAudio output via `naudiodon` (PortAudio binding) |
| Host app | **Elgato Stream Deck** app v6+, with a Stream Deck **+** (the encoder + LCD model). Other Stream Deck models load the plugin but the dial / LCD actions only render usefully on the `+` |
| Runtime tooling (MacPorts) | `sudo port install portaudio` — `portaudio` (arm64) backs the `naudiodon` local-audio sink. naudiodon doubles as the PI's output-device dropdown source (its `getDevices()` / `getHostAPIs()` query CoreAudio's HAL directly, so no separate `switchaudio-osx` install is needed). Add `sudo port install ffmpeg` only if you plan to use the icecast publish path (ffmpeg hosts the MP3 encoder + icecast SOURCE client). The Stream Deck app ships its own bundled Node for running installed plugins; run `npm run rebuild-native` once after `npm install` to rebuild the naudiodon native binding against that bundled Node ABI. |
| Remote SDR | Any SpyServer-compatible receiver. Tested with **Airspy HF+ Discovery** (HF 0.5–31 MHz + VHF 60–260 MHz, 31–60 MHz hardware gap) running SpyServer on a Linux ARM/aarch64 (NanoPi etc.); see [docs/server-setup.md](docs/server-setup.md) for the server side. Airspy R2 / Mini and RTL-SDR also expected to work but are less exercised. |

Developer / contributor tooling (Node 20+, MacPorts `librsvg` / `ImageMagick` / `sox` for the dump + analysis scripts) is documented in [docs/build-install.md](docs/build-install.md). The native receiver app additionally needs `swiftc` (Xcode Command Line Tools); `rsvg-convert` renders its icon from the plugin's own `imgs/icon-source.svg` when present, and without it the app falls back to the generic bundle icon.

## Features

| Item | Status |
|---|---|
| Volume | ✅ (0–100 % attenuator on the leveled output; full bar = full level) |
| Master ON/OFF (Dial PUSH) | ✅ (full UI dim while OFF, persisted) |
| Connection resilience | ✅ (TCP-connect timeout, app-level watchdog for cable-pull detection, full-dial dim + `LINK` indicator + `-----` freq while offline, auto-reconnect with state restore) |
| Server host / port via PI | ✅ (debounced live-apply: changing host/port tears down + reconnects without restart) |
| FM Bandwidth | ✅ user-cycle 200 / 150 / 110 / 100 / 90 kHz (JP 100 kHz channel-spacing-aware); complex IF LPF on I/Q is a Blackman-windowed sinc FIR (linear phase, ~−74 dB stopband past cutoff). Replaced the earlier 8th-order Butterworth IIR, which only reached ~−24 dB at the narrowest cycle setting and let neighbour stations leak through the discriminator |
| AM/SW Bandwidth | ✅ (16th-order complex IF LPF on I/Q + 8th-order post-envelope LPF) |
| USB / LSB / CW | ✅ Weaver-method SSB demod (4th-order Butterworth audio LPF, ±f_off Q-flip for sideband select); CW = BFO direct-shift (default 700 Hz) + 4th-order Butterworth audio LPF at iqRate (anti-alias for the audio-rate decimation + audio band limit in one cascade). Sub-kHz display: when SSB/CW is the live demod, the 7-seg shows the floor kHz and the Hz remainder appears as a small `.XXX` next to the digit cluster |
| CW AGC | ✅ peak-follower normalisation of the BFO tone envelope. Setpoint 12000 (~37 % of Int16), max gain 5000, ~30 Hz attack / ~2 Hz decay so weak signals rise to a comfortable level without pumping during CW keying gaps. Mirrors AM Carrier AGC but with CW-specific time constants |
| Carrier AGC | ✅ (port of SDR++ `dsp::loop::AGC` + `dsp::demod::AM` CARRIER mode; tracks `\|IQ\|` with asymmetric attack/decay EWMA, applies gain to the complex IQ stream BEFORE envelope detection) |
| AGC Attack | ✅ (1–200, SDR++ slider convention = rate in 1/τ_seconds) |
| AGC Decay | ✅ (1–20) |
| AM Synchronous detection | ✅ 2nd-order PLL locks to the AM carrier (loop wn = 150 Hz, fast pull-in / minimal audio-band tracking); replaces envelope detection when AM Sync is ON; suppresses selective fading distortion. Lock gate mutes audio when the PLL loses lock; retune adds a 200 ms output mute (both VFO smooth and preset-jump) plus an 8 ms fade ramp at every mute boundary, so the PLL pull-in transient and the naudiodon-queue boundary amplitude step both stay inaudible |
| FM Stereo PLL (true phase lock) | ✅ (2nd-order Costas-style PLL locks VCO to 19 kHz pilot, loop bandwidth ≈ 50 Hz, damping = 1/√2, hysteretic lock detection so weak/intermittent pilots don't flap; STEREO badge shown only while pilot-locked AND user has stereo option enabled). 8th-order Butterworth audio LPF (4 cascaded biquads) at 15 kHz on both L+R and L−R recovery paths kills the 19 kHz pilot residue and 23-53 kHz DSB-SC subcarrier so they never reach the DAC. |
| Per-mode RF Gain (AM / FM separate) | ✅ (live-applied, debounced, pop-suppressed; on FM the dial doubles as a post-demod audio attenuator since FM is amplitude-invariant) |
| Frequency / mode persistence | ✅ debounced 500 ms write to `config.json`; on startup the stored freq + demod mode + tune step + per-mode tune step are restored before the first IQ packet. The restored freq wins over the Tune dial's connect-time preset seed (the seed runs only on a true first start, or when the stored freq isn't receivable on the connected device); the dial reconciles its preset slot onto the matching preset so the display shows the station actually playing |
| VFO step is per-mode | ✅ each demod mode (WFM / NFM / AM / USB / LSB / CW) remembers its last-used step value, so WFM 100 kHz / AM 9 kHz / SSB 100 Hz round-trip without manual re-selection |
| Preset / Step dial row | ✅ shared `Preset/Step` row: short PUSH enters edit (rotate wraps the step list), 1 s long PUSH toggles Preset ↔ VFO. Single row, two distinct controls |
| IFNR (IF Noise Reduction) | ✅ FM/NFM only (SDR++ FMIF tracking-filter port) |
| Auto station-name lookup | ✅ **Japan-area only** for the JP DB — region-switchable from the Tune dial PI across all 8 regions (関東 / 北海道 / 東北 / 東海 / 近畿 / 中国 / 九州 / 沖縄): 関東 + 沖縄 cover AM / FM / CFM together, the other 6 regions cover commercial FM via the 全国 FM 一覧 source; region-tagged manual overrides supported; the EIBI SW DB covers international shortwave (day / time / spur-aware); in-PI `Update Now` for both |
| Preset list | ✅ records come solely from the deck-rx-owned `data/presets.json` (the SDR++ `frequency_manager_config.json` mirror); the dial render-time station name is enriched from the JP DB / callsign DB for the active region but the preset *count* stays bound to the SDR++ file. PI button `Import bookmarks` re-syncs on demand (frequency-keyed dedup — re-importing collapses any pre-existing duplicate-frequency entries, preferring the JP DB CJK name); optional `Auto-sync on startup` checkbox runs the import once at every plugin launch |
| FFT Display dial | ✅ full-width 200×100 LCD encoder action showing the live IQ spectrum centered on the VFO. SDR++-style colour palette, configurable frame rate (1–120 fps) / smoothing factor / FFT size (256–2048) / dB floor & ceiling via the PI. Dial rotate = zoom on the active axis (H = horizontal span, 26 step ladder 1×–32×; V = vertical dB range, 12 step ladder 0.4×–2.0×), long-press toggles between H and V mode, short-press resets the active axis. Pixel→bin map switches between max-hold (≥1 bin/pixel, peak preserving) and linear-interp (<1 bin/pixel, smooths the comb that high zoom would otherwise produce) |
| FFT Display dial (LCDX2) | ✅ companion action that adds an LCDX1 ↔ LCDX2 mode switch — place 2 of these on adjacent dials in the same row to span one continuous spectrum across both LCDs (no inner border drawn on the seam). LCDX2 Wide doubles the visible bandwidth (clamped to the IQ rate); LCDX2 Detail keeps the bandwidth but doubles per-Hz pixel density. PI dropdown selects single / wide / detail. Mutual-pairing check — 3-in-a-row makes all three fall back to single. Short LCD tap cycles LCDX1 / Wide / Detail; long LCD tap cycles fftSize forward (256/512/1024/2048/4096/8192/16384) — IQ samples are accumulated across SpyServer chunks so the larger sizes still drive an FFT each frame. All PI settings (dB floor/ceil, fps, smoothing, fftSize, lcdMode) auto-sync between paired panels. Bottom-right corner shows current `N<size>` for confirmation |
| FFT (LCDX2) control Button | ✅ companion key action for the LCDX2 dial — drives mode / fftSize / zoom / axis from a button when the paired LCDs are full of spectrum and on-LCD operation hints are obscured. Single PI dropdown picks the operation (cycle LCD mode, cycle FFT size, zoom in / out, reset H or V zoom, toggle H↔V axis); button title reflects the current dial state via an internal event bus (`Mode\nWide`, `FFT\nN2048`, `Axis\nH`, …). Place the same action multiple times to wire several buttons, each on a different op. |
| Volume Button | ✅ companion key action for the Volume dial — Vol Up / Vol Down / Mute toggle as buttons, useful on dial-less devices (Stream Deck XL) or when dial space is taken by FFT / LCDX2. **Hold-to-repeat**: recursive `setTimeout` loop guarded by an `isPressed` flag fires the first step immediately, then continues at ~12 steps/sec until released; auto-stops on min / max. **C-curve step** (low volume = big step, high = fine, GAMMA=1.5) ports the feel of a hardware volume knob — same pattern used in the standalone `stream-deck-volume` plugin. Mute toggles once per press (no repeat). Title shows live volume `%` and an `(M)` tag while muted. |
| Audio sink | ✅ Local output via `naudiodon` (PortAudio → CoreAudio HAL); optional icecast publish path (ffmpeg + MP3 + icecast SOURCE) auto-selected from `cfg.ffmpeg.mode`. Native bindings (`naudiodon`, `deck-rx-asrc`, `segfault-handler`) need an ABI-matched rebuild against the Stream Deck app's bundled Node — run `npm run rebuild-native` once after `npm install`. See [Audio path (long-running stability)](#audio-path-long-running-stability) for the libsamplerate ASRC + drift-compensation details. |
| Output loudness leveling | ✅ Single output stage (`src/audioLeveling.ts`) applied to the final PCM before the sink, so it covers **both** the naudiodon and icecast paths. **(1)** Static per-band makeup gains (`MODE_MAKEUP`, overridable per host via `cfg.audioMakeup`, e.g. `{"1": 8}` to bring WFM down) lift each demod mode to a common loudness — WFM/NFM/SSB are raw fixed-gain, AM/CW are demod-AGC'd to different setpoints, so without this the bands jump in level and deck-rx is much quieter than other apps. This is the **default** leveller: fixed per-band gain, **no dynamic motion / no pumping**. **(2)** An adaptive output AGC is **opt-in** (`cfg.audioLeveling: true`, default off) for also tracking within-band signal-strength changes — off by default because its dynamic level-riding is audible. **(3)** A soft-knee tanh limiter is an instantaneous peak ceiling so the static gain can run hot near full-scale without hard-clip distortion (peak-only, no breathing). `cfg.audioGain` (default `1.0`, clamped `0.1..4`) is a master trim on top of the makeup; the Volume dial (0–100%) attenuates further. Independent of RF / demod gain. Unit-tested in `test/audioLeveling.test.ts`. |
| External knob control | ✅ loopback HTTP endpoint on `127.0.0.1:8771` (`src/controlServer.ts`) so a hardware knob can tune, ride volume, mute, power and step presets on the receiver alongside the Stream Deck+ dials. Frequency stepping goes through the same `nextFreqForTicks()` the Tune dial uses and preset stepping through the same `nextPresetSlot()`, so the knob honours the active tune step, the device's receivable bands and the dial's preset-skipping rules. Driven today by `knobctl` (BRIMFORD two-tier knob). See [External knob control](#external-knob-control-http). |
| Native receiver app | ✅ `native-app/` builds two bundles from one source tree. `Deck RX.app` is a front-end over the plugin's receiver — preset table, live spectrum + waterfall, station / frequency / mode readout, S/N meters and a transport row — and the focus target a Stream Deck profile binds to, so the deck switches profile when the app comes to the front. `Deck RX Solo.app` is the same window with a receiver of its own. |
| iPadOS receiver | ✅ `native-app/build-ios.sh` builds the same sources for iPad, and the tablet receives on its own: SpyServer client, demodulators and audio all run there. The display is not a UIKit rewrite: `SpectrumView`, `FreqView` and `SignalMeter` are one file each, with the platform seams — view and font types, how a redraw is asked for, the drawing context, pointer versus touch — in `Platform.swift`. Spectrum and waterfall with station labels and a draggable split, seven-segment readout tuned by tapping a digit, preset list grouped by band, band jump, tune steps, mode, mute, S/N meters, a display rail (zoom, waterfall depth, dB ceiling and floor) and an options sheet holding the live demod's own settings. Installing on a device needs a development certificate and a provisioning profile; the script says what is missing and how. See [iPadOS receiver](#ipados-receiver). |
| Standalone receiver | ✅ `Deck RX Solo.app` connects to SpyServer itself and needs no plugin, no Node and no native modules: SpyServer client, all six demods with FM stereo, audio, station names, presets, SDR++ import and the control endpoint are all in the app. Universal binary, macOS 12+ — verified on a 2015 Intel MacBook Air. Copy the `.app` and clear its quarantine attribute. See [Standalone receiver](#standalone-receiver-deck-rx-solo). |
| Headless receiver | ✅ `bin/headless.js` runs the whole signal path — SpyServer client, demodulator, audio chain, control endpoint, status feed — with no Stream Deck involved. The core logs through `src/log.ts` instead of the SDK, so the plugin and the headless process share every module. Run it with the Node the native modules were built against. |
| Spectrum feed | ✅ binary FFT frames over a Unix socket (`/tmp/deck-rx-spectrum.sock`, `src/spectrumFeed.ts`) for a native front-end. Computes nothing while nobody is connected, and drops frames for a reader that falls behind rather than queueing them. See [Spectrum feed](#spectrum-feed-native-front-end). |

## Audio path (long-running stability)

The local-output side of deck-rx took several iterations to make rock-solid over 12 h+ sessions. The short story: two free-running crystals (the SDR host's ADC clock vs. the local CoreAudio output device's DAC clock) drift ±10 to ±100 ppm apart, and any naive fixed-rate path either lets the PortAudio queue creep into multi-second delay or starves it into click/buzz. v3 ASRC (commit `0034b51`) closed the loop.

### The drift problem

- **Writer**: SpyServer streams INT16 IQ paced by the receiver's crystal (Airspy HF+ Discovery ⇒ 768 ksps), demodulated to PCM at e.g. 114 kHz (FM) / 24 kHz (AM) by the deck-rx demod chain.
- **Reader**: macOS pulls PCM from the PortAudio buffer paced by the output device's own crystal (e.g. RME DX7s at 96 kHz native).
- Over hours these crystals walk apart. Even 10 ppm = 1 sample per 100 000 frames = ~1 s of accumulated queue drift every ~3 h at 96 kHz. Audible delay creep was already noticeable inside a single soak.

### v3 architecture (current)

```
SpyServer IQ ─ demod ─ pre-ASRC LPF ─ libsamplerate ASRC ─ naudiodon (96 kHz native) ─ CoreAudio HAL
                       (4-stage biquad,                    ratio = deviceRate/srcRate ± 1 ppm
                        kills > 22 kHz)                    closed-loop on writableLength
```

- **Device-native rate open**: `naudiodon.AudioIO` is opened at the output device's `defaultSampleRate` (e.g. 96 kHz), not at the demod's source rate. This bypasses CoreAudio's internal resampler entirely — the resampling now happens in our ASRC with a knob we control.
- **libsamplerate ASRC** (`native/samplerate`, `deck-rx-asrc` native addon): `SincFastest` quality, channels=2, ratio = `deviceRate / srcRate` baseline (e.g. 96000 / 114000 ≈ 0.8421). Implemented as a small N-API wrapper over libsamplerate so the resampler runs in-process with zero JS bridging cost per sample.
- **Closed-loop ratio control** (`src/AudioOutput.ts::updateAsrcRatio`): every N tunes, sample PortAudio's `writableLength` (bytes still in the JS Writable backlog), EMA-smooth, and nudge the ratio ±5 ppm to keep the water level inside a 6000 ± 1500 byte band. A 1 ppm "restore" pull biases the ratio back toward `baseRatio` whenever the EMA is in-band, so the loop doesn't park itself off-axis.
- **Reader-stall absorb + clean resync** (`NaudiodonOutput.write`): a CoreAudio overload — a sibling realtime client on the same output device (RME DigiCheck NG, Rogue Amoeba ARK / Audio Hijack, …) blowing its IO deadline, logged as `HALS_OverloadMessage: Overload possibly due to client timeout` — stalls our device reader for a few hundred ms. The writer keeps producing, so the JS Writable backlog spikes. Two-stage response: (1) **absorb** the backlog up to `RESYNC_HIGH` (16384×16 ≈ 680 ms) with zero drops — long enough to ride out the measured ~250–630 ms stalls, after which the queue refills and the slow ASRC loop trims it back; (2) past `RESYNC_HIGH` (stacked stalls / a pathologically long one) do **one clean resync** — skip writes until the backlog drains to `RESYNC_LOW` (16384 ≈ 43 ms), then reset the resampler + control loop and resume, so the worst case is a single short gap instead of hundreds of per-packet drops scattered over tens of seconds with the ratio railed to its floor. The icecast publish path (`FfmpegOutput.write`) keeps the simpler `OVERFLOW_DROP` guard — it drops the current PCM buffer once the ffmpeg-stdin pipe backlog exceeds 1 MiB, so a stalled icecast sink (network blip / server down) can't grow the heap without bound while ffmpeg auto-respawns.
- **Pre-ASRC LPF**: a 4-stage cascaded biquad LPF runs on the L/R PCM *before* the resampler so any residual energy above 22 kHz can't alias when the ratio < 1 produces a slightly lower output rate.

### Pop / click suppression at retune

- **200 ms output mute** around every preset jump / VFO smooth-retune (was 100 ms — extended because the AM-Sync PLL needs the longer window to pull in cleanly).
- **8 ms fade ramp** at every mute boundary so neither the PLL transient nor the naudiodon queue boundary amplitude step is audible.
- **maxQueue = 8**: 8 PortAudio buffers of cushion at the device rate. An earlier build tried 4 to shave the user-visible retune latency (leaning on the ASRC for drift), but 8 is kept — the extra device-side slack lets a brief CoreAudio reader stall ride through before the JS-side reader-stall absorb (above) has to engage. The ASRC keeps the backlog centred either way.
- **Mute relay**: the demod-side mute flag is forwarded to `AudioOutput.write(pcm, muted)` so the ratio loop knows to skip its water-level observation during the deliberately-empty period — otherwise the loop would mistake the silence for an underrun and chase it.

### What we tried first (and what broke)

| Attempt | Setting | Result over 12 h |
|---|---|---|
| v0 (fixed-rate, single rate) | naudiodon opened at srcRate, no ASRC | Multi-second delay creep, eventually audible echo |
| v1 | `maxQueue 8→4`, fade ramp, AM mute 100→200 ms | Pops fixed at retune. But ~5 s delay still crept in over 6 h |
| v2 (aggressive ratio control without device-native) | STEP `5e-5`/tune, narrow band, no LPF | Delay eliminated, then underrun after ~12 h (ratio parked at 0.992400 in the dead-zone, started starving) |
| **v3 (current)** | Device-native rate + libsamplerate ASRC + 5e-6 STEP + 1e-6 restore pull | 24 h continuous AM preset cycle (594/693/810/954/1134 kHz) + FM with no pop / no buzz / no delay creep |

### Operational traps surfaced during development

These weren't audio-path bugs per se, but they masqueraded as one for several sessions:

- **Phantom SpyServer client from a second host's Stream Deck App**: any machine with the deck-rx plugin symlink will auto-connect to the configured SpyServer the moment the Stream Deck App is foreground-launched (or stays running headlessly). That second client contends for device control. Symptom: preset rotation arrives at the dial's 7-seg display but the audio stays on the previous frequency. Fix: `ssh other-host pkill -KILL "Stream Deck"`. Any laptop / Mac mini in the household that ever had deck-rx installed is suspect.
- **Airspy HF+ has two SMA inputs**: HF 0.5–31 MHz and VHF 60–260 MHz. A misplaced antenna will make AM (or FM) completely silent with all the right diagnostics still passing on the other band. Quickest disambiguation: `airspyhf_rx -f 0.594 -m off -r /tmp/x.iq` from the SpyServer host bypasses the entire deck-rx stack in 30 s.
- **`writableLength` is bytes, not frames**: easy to misread when porting from PortAudio C examples that talk in frames. 16384 bytes at 16-bit stereo = 4096 frames = ~43 ms at 96 kHz. The thresholds in `updateAsrcRatio`, the `RESYNC_HIGH` / `RESYNC_LOW` reader-stall constants, and the icecast path's `OVERFLOW_DROP` are byte-counts on purpose, matching what `naudiodon` exposes.

### Reproducing the soak test

```sh
touch /tmp/deck-rx-audio-record         # enable the writer that drops 30 s of PCM
                                        # to /tmp/deck-rx-AM-<freq>.wav per preset
# In the Stream Deck +, cycle AM presets (594 / 693 / 810 / 954 / 1134) and let
# the receiver run continuously overnight.
ps -p $(cat /tmp/deck-rx.pid) -o etime,%cpu,rss   # process should still be < 200 MB after 24 h
sox /tmp/deck-rx-AM-594000.wav -n stat 2>&1       # rough spectral sanity check
```

## External knob control (HTTP)

The plugin listens on `127.0.0.1:8771` so an external hardware knob can drive the
receiver without a Stream Deck+ dial. It is bound to loopback with no auth —
the same trust level as any other local-only helper endpoint on this machine.
Sandboxed test instances (`DECK_RX_CONFIG_PATH`) keep it disabled unless
`DECK_RX_CONTROL_PORT` opts them in on a port of their own, so a test plugin can
never answer the knob in the running receiver's place.

| Endpoint | Effect |
|---|---|
| `GET /health` | `{"ok":true,"freq":<hz>,"volume":<0-1>,"muted":<bool>,"enabled":<bool>}` |
| `GET /tune?ticks=<±n>` | Relative tune, `n` × the receiver's current tune step, snapped to a receivable band |
| `GET /tune?hz=<n>` | Absolute tune (also band-snapped) |
| `GET /volume?d=<±n>` | Relative volume, 2 % per tick, clamped to 0–100 % |
| `GET /mute?toggle=1` | Flip mute |
| `GET /power?toggle=1` | Master ON/OFF — same as the Tune dial's long press |
| `GET /preset?d=<±1>` | Step the preset list one slot, skipping presets the connected device can't receive. `409` when there is nothing to land on (empty list / none receivable), so a dead control path isn't silently reported as success |
| `GET /mode[?m=<0-7>]` | Read or set the demod mode. A preset carries a mode with it, so a front-end that can only set a frequency lands on an FM channel while still demodulating AM — silence, not a station |
| `GET /receiver[?set=<name>&value=<v>][&action=importSdrpp]` | Receiver-wide settings: tune mode, JP region, audio device, output mode, SDR++ auto-sync, and the bookmark import as an action. Reports the region list and the machine's real audio devices, so a front-end never carries its own copy of either |
| `GET /options[?set=<name>&value=<v>]` | Read the demod's own settings (FM / AM / SSB groups plus RF gain), or change one by name — `fm.stereo`, `am.sync`, `ssb.bandwidth`, `gain`. Always answers with everything in force |
| `GET /stations[?from=&to=]` | Broadcaster names for the frequencies a front-end labels on its spectrum, resolved through the same JP DB lookup that names the station in the header |
| `GET /volume?v=<0-1>` | Absolute volume — what a click on a volume bar means; `d=` stays for stepping |
| `GET /step[?hz=&d=±1]` | Read, set or cycle the VFO step. Answers with the step in force plus the ladder it cycles, so a front-end builds its menu from the receiver rather than hard-coding one |
| `GET /spectrum[?fft=&fps=&avg=]` | Read or change the spectrum feed's FFT size, framerate and averaging. Always answers with the values in force, clamped, so a caller never has to guess how its request was adjusted |

`/preset` and `/step` cover the knob's press-and-turn slots; `/step` is also what
lets a front-end fix a step too coarse for the band in use. Every applied request also triggers a dial re-render, so the
Stream Deck+ LCD follows a knob-driven retune instead of showing a stale
frequency — in preset mode too, where the dial switches to drawing the live
frequency once the knob walks the receiver off the selected preset, and adopts
another preset's slot when a retune lands exactly on it.

The current client is `knobctl`, the daemon for the BRIMFORD two-tier knob
(upper ring = frequency, lower ring = volume, short press = mute, long press =
switch which application the knob drives). The daemon lives outside this repo;
deck-rx only publishes the endpoint.

## Headless receiver

The plugin is one front-end over the core, not the core itself. `bin/headless.js`
starts the same modules from a plain Node process:

```sh
"$HOME/Library/Application Support/com.elgato.StreamDeck/NodeJS/20.20.0/node" \
  com.hogehoge.deck-rx.sdPlugin/bin/headless.js
```

Use that Node (or whichever one `npm run rebuild-native` targeted) — `naudiodon`
and `deck-rx-asrc` are ABI-bound to it. The headless bundle sits next to the
plugin bundle so `config.json`, the preset store and the station DBs resolve to
the same files.

Only ONE of {plugin, headless} should own the receiver at a time: they would
otherwise both open the audio device and both try to answer on the control port.
The second one to start logs the clash and runs without a control endpoint.
`DECK_RX_HEADLESS_PID_FILE`, `DECK_RX_CONTROL_PORT`, `DECK_RX_STATUS_PATH` and
`DECK_RX_SPECTRUM_SOCKET` move it out of the way when both must run.

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
256–4096, framerate 1–60, averaging 0–0.95). A size change rebuilds the FFT and
drops the smoothing history, which belonged to the old bin count.

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
them get RF gain. Clicking a row advances it. Values are never cached here —
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

## Standalone receiver (Deck RX Solo)

`Deck RX Solo.app` is the whole receiver in one bundle. No plugin, no Node, no
native modules — copy the `.app` to any Mac and it works.

```sh
cp -R "/Applications/Deck RX Solo.app" /Volumes/somewhere/
# on the other machine, after copying:
xattr -dr com.apple.quarantine "/Applications/Deck RX Solo.app"
```

Press **DIRECT** to connect, then **AUDIO** to demodulate and play. `autoDirect`
and `autoAudio` in the config do both at launch, which is the only way to drive
it on a machine nobody sits at.

The menu bar is built by hand — there is no nib — so About and Quit exist at
all. About reports which of the two builds is running and what it is pointed
at, which is a real question with both installed.

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
in [docs/standalone-app-port.md](docs/standalone-app-port.md).

### Settings

`~/Library/Application Support/deck-rx/receiver.json`, seeded from the plugin's
`config.json` on a first run when there is one and never written back to it.
Host and port are editable from the options panel, so a copied app needs no
hand-edited file. The station databases ship inside the bundle and seed
`~/Library/Application Support/deck-rx/data` on first launch.

`spectrumSplit` is the fraction of the spectrum panel given to the trace,
dragged on the rail rather than typed.

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

### Sharing the receiver

SpyServer takes several clients at once and gives control to the first only. A
later client's retune is discarded silently, so the app reports it: `canControl`
in `/health`, **LISTEN ONLY** in the window, 409 from `/tune`, and the readout
follows the device rather than claiming a frequency nothing is receiving. There
is no arbitration — which client owns the radio is the user's call.

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

## iPadOS receiver

The iPad build is a receiver, not a remote view of the Mac one: it opens its
own connection to the SpyServer, demodulates on the tablet and plays through
`AVAudioSession`.

```sh
native-app/build-ios.sh sim install    # simulator, no signing needed
native-app/build-ios.sh device         # signed, installed over the network
```

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
  above it and the S and N meters beside it
- the preset list grouped by band, with the row the receiver is actually on
  marked by frequency rather than by what was last picked
- band jump, and coarse/fine tune buttons that ride on the mode's own tune step.
  The step follows the raster the band is channelised on, filed under the
  plugin's own key (`"2:mw"`, `"2:sw"`, `"2:vhf"` for AM, the mode number for
  everything else): FM 100 kHz, NFM 12.5 kHz, AM 9 kHz on medium wave and 5 kHz
  on short wave, SSB 1 kHz, CW 100 Hz
- a display rail: zoom and waterfall depth as sliders, the dB ceiling and floor
  as vertical rails beside the trace, MAX above MIN to match the axis
- an options sheet with the live demod's own settings, RF gain, IQ NR,
  levelling, tune mode, JP region and connect-at-start — the sheet rebuilds on
  a mode change, so an AM receiver is never offered de-emphasis
- the app is landscape: the layout spends its width on the spectrum

The output buffer is sized for the rate this actually runs at — 114 kHz stereo
is 228 000 samples a second — and holds about 1.1 s, which is the room the
plugin's own reader-stall absorb has. It also primes: playback waits for a fifth
of a second to bank before it starts reading, and re-primes after a dry run
rather than scraping the bottom of the ring buffer by buffer. Starting to read
from a ring that is still filling means the first jitter empties it and every
refill after that starts from empty, which is heard as audio that breaks up
every few seconds while every other number says the stream is healthy.

The status line carries two numbers worth reading when the audio breaks up:
`drops` counts samples the output asked for and the ring did not have, and
`gap` is the longest pause between two IQ packets in the last ten seconds.
Together they separate the two causes — a large gap means the samples were late
(network or server), a small gap with drops climbing means they arrived on time
and the tablet could not keep up.

**The signal path is the plugin's, parameter for parameter.** The Swift port had
acquired settings of its own, and each one cost audio quality: an audio
decimation of `audioDecimate * 12` where the plugin uses the configured value
(9.5 kHz instead of 114 kHz, whose Nyquist sat below the 15 kHz anti-alias
filter — a 6 kHz tone came back at 3.5 kHz, which is what wrecked sibilants);
audio filters hard-coded off instead of following `fmLowPass` / `fmHighPass`;
de-emphasis with no "off" branch; and no output mute window at all, where the
plugin opens one around every gain change, retune and mode change so the
amplitude step is not heard. Those are gone. When something sounds different
between the two, the difference is a bug in this one.

There is no volume control in the app: the iPad's own buttons are the volume,
and a second attenuator in series only costs headroom.

Still Mac-only, and deliberately so unless asked for: the JST/UTC clock, the
display scale, SDR++ import and sync, icecast publishing, output device
selection, and the RAW and DSB modes (six segments are what fits).

**First run** connects to `127.0.0.1:5555`, the same default the shared
`RadioConfig` carries — there is no plugin config on an iPad to seed a real
address from. Type `host:port` into the field and it is persisted before the
connect is attempted, so a refused address survives to the next launch.

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

## Documentation

- [Repository layout](docs/repository-layout.md)
- [Build & install](docs/build-install.md)
- [Server-side setup (SpyServer on Linux ARM/aarch64)](docs/server-setup.md)
- [Dial layouts](docs/dial-layouts.md) — per-plugin LCD screenshots + per-row UI explanations
- [Architecture notes](docs/architecture.md) — dial details, signal-path implementation, internal mechanisms
- [Station-name auto-lookup](docs/station-db.md) — JP DB scraper + EIBI integration, alias rules, NHK channel inference + transmitter-site + callsign annotation
- [Data sources & attribution](docs/data-sources.md) — Japan-only sources (総務省 MIC / 関東総通局 / 沖縄総通局) plus the international EIBI shortwave DB; license terms + refresh scripts
- [Standalone app port](docs/standalone-app-port.md) — what moved to Swift, what the system frameworks replaced, and why the plugin keeps its own signal path
- [Debug helpers](docs/debug-helpers.md) — LCD dump / lint / compare-baseline scripts

## Credits / References

The DSP algorithms and the LCD UI are inspired by / ported from two open-source projects:

- **[SDR++](https://github.com/AlexandreRouma/SDRPlusPlus)** by Alexandre Rouma — Carrier AGC (`dsp::loop::AGC` + `dsp::demod::AM` CARRIER mode), FMIF noise reduction, SpyServer protocol layout, runtime tune sequence.
- **[ATS-Mini](https://github.com/esp32-si4732/ats-mini)** by the esp32-si4732 project — segmented N (SNR) / S (RSSI) bar styling, metallic dial-knob graphic, EIBI shortwave schedule consumer.
- **Stream Deck SDK** — [@elgato/streamdeck](https://www.npmjs.com/package/@elgato/streamdeck) by Elgato.

If the upstream ATS-Mini URL has moved, please file an issue.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).

deck-rx contains ports / re-implementations of algorithms from [SDR++](https://github.com/AlexandreRouma/SDRPlusPlus) (GPL-3.0-or-later), so the project is licensed under the same terms — fork / modify / redistribute freely under GPL-3.0+.
