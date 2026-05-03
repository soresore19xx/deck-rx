# spyserver-ex

Stream Deck + plugin to control a remote [SpyServer](https://airspy.com/) and listen to AM/FM radio directly from the Stream Deck encoder dials.

The plugin connects over TCP to a SpyServer (e.g., an Airspy HF+ Discovery on a NanoPi), pulls down INT16 IQ samples, demodulates them in TypeScript, and pipes the resulting PCM through `ffmpeg` to a chosen macOS CoreAudio device.

## Features

| Item | Status |
|---|---|
| Volume | ✅ |
| Master ON/OFF (Dial PUSH) | ✅ (full UI dim while OFF, persisted) |
| AM/SW Bandwidth | ✅ (16th-order complex IF LPF on I/Q + 8th-order post-envelope LPF) |
| Carrier AGC | ✅ |
| AGC Attack | ✅ (1–200 ms, SDR++ display convention) |
| AGC Decay | ✅ (1–20 ms) |
| FM Stereo PLL (true phase lock) | ✅ |
| Per-mode RF Gain (AM / FM separate) | ✅ (live-applied, debounced, pop-suppressed) |
| Frequency / mode persistence | ✅ (restored at startup) |
| IFNR (IF Noise Reduction) | ❌ Not implemented (UI toggle only) |

### Encoder dial layout (4 LCDs on Stream Deck +)

- **SpyServer Dial** — VFO / preset scrolling, 7-segment frequency LCD, FM stereo lock badge (only shown when stereo decode is enabled AND pilot is locked), ATS-Mini-style 30-segment N (SNR) / S (RSSI) signal-strength bars; **Push to toggle master ON/OFF** (the OFF state dims every dial and the header shows `OFF  <preset>`)
- **SpyServer Volume + Status** — rotate adjusts 0–150 %, push toggles mute; the same panel shows `Conn` (`ONLINE` in red while streaming, `OFFLINE` otherwise), `Host`, `Dev` (device + IQ rate), `AOut` (audio output device name)
- **SpyServer Options** (FM/NFM) — De-emphasis (off / 50 µs / 75 µs), IFNR placeholder, HiPass, LoPass, Stereo, **Gain** (RF gain index, only shown while a non-AM mode is the active demod)
- **SpyServer AM Options** — Bandwidth (4 / 6 / 9 / 12 kHz), Carrier AGC, Attack, Decay (continuous 10 % per tick log adjustment), **Gain** (only shown while AM is active)
- All panel-style dials use a unified compact font (rowH = 14, font 11 / 12) so AM Options, FM Options and Volume look identical

### Signal-path implementation

- WFM stereo decoder with **2nd-order Costas-style PLL** locked to 19 kHz pilot, hysteretic lock detection, mono fallback when unlocked
- AM envelope detector with two cascaded sharp filters: **16th-order Butterworth complex IF LPF on I/Q (8 cascaded biquads, ~−96 dB/oct stopband)** for adjacent-channel and aliased-station rejection, then **8th-order Butterworth post-envelope audio LPF** (4 cascaded biquads) and asymmetric attack/decay carrier AGC
- 50 µs / 75 µs FM de-emphasis (single-pole IIR)
- Per-channel L/R audio LPF/HPF (independent Biquad instances — sharing one across channels would mix internal state and destroy stereo separation)
- IQ-derived RSSI (RMS power, gain-compensated dBFS) and SNR (instantaneous-power variance ratio) — computed locally since SpyServer does not expose chip-level meters
- **Per-mode RF gain** persisted as `amGain` / `fmGain` (legacy `gain` field auto-migrated into `amGain`); the active mode's value is sent to SpyServer at startup AND when crossing the AM ↔ non-AM mode boundary
- **Pop suppression around live SpyServer settings**: gain change and frequency change both use a "mute → debounce → re-mute around apply" pattern (200 ms initial mute, 80–120 ms debounce, 150–250 ms post-apply re-mute) so rotating the dial through preset stations or sliding the gain index doesn't punch loud transients through
- Output-level normalisation across modes — WFM ×8000, WFM Stereo ×6000, NFM ×12000, AM AGC OFF ×32 — chosen so a single Volume setting gives comparable loudness on AM vs FM
- Dynamic mute on retune / startup to suppress pop noise
- Audio device selection by **name** (resilient against ffmpeg re-numbering, parses USB UID for "(null)" display names like Topping DX7s)
- ffmpeg output fixed at 48 kHz with async resampler (avoids dropouts on virtual / Loopback devices that mishandle non-standard rates)
- ffmpeg auto-respawn on unexpected exit (with 30-second device-list cache to keep restart fast)
- Frequency / demod-mode persisted to config and restored at startup (no more "LCD shows X but radio is silent until you click")
- Serialised config writes (chained promises) — prevents JSON corruption from concurrent persist calls
- ATS-Mini-style metallic dial knob graphic (toothed rim, radial gradient, position dot)
- **Diagnostic spectrum probes** in the plugin log: `spec/raw` (raw IQ at fixed offsets), `spec/filt` (a state-isolated copy of the IF LPF applied to current IQ, so theoretical attenuation can be confirmed without disturbing the production filter) and `spec/prod` (the actual production-side IF LPF output, captured per packet) — used to distinguish DSP issues from upstream hardware IMD when adjacent-channel bleed appears

## Repository layout

```
~/dev/spyserver-ex/
├── src/                            # TypeScript source
│   ├── SpyClient.ts                # SpyServer protocol (HELLO / SET_SETTING / IQ)
│   ├── spyService.ts               # Singleton service, state, persistence
│   ├── demodulator.ts              # FM/WFM/Stereo/AM DSP
│   ├── dspFilters.ts               # Biquad IIR (LP/HP/BP)
│   ├── AudioOutput.ts              # ffmpeg pipe + device-name resolution
│   ├── audioDevices.ts             # SwitchAudioSource + ffmpeg device map
│   ├── dialDisplay.ts              # 7-segment, header, footer, volume bar SVGs
│   ├── icons.ts                    # Knob, options panel SVGs
│   └── actions/                    # Stream Deck action classes
└── com.hogehoge.spyserver-ex.sdPlugin/
    ├── manifest.json
    ├── layouts/                    # Encoder LCD layouts
    ├── ui/                         # Property Inspector HTML
    ├── imgs/                       # Action icons
    └── config.example.json         # Copy to config.json and edit
```

## Build & install

```sh
# Prerequisites (MacPorts):
sudo port install ffmpeg switchaudio-osx

npm install
npm run build
```

After the first build, symlink the plugin into Stream Deck's plugin directory **before**
restarting Stream Deck (otherwise builds will not be reflected):

```sh
ln -s "$(pwd)/com.hogehoge.spyserver-ex.sdPlugin" \
      "$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins/com.hogehoge.spyserver-ex.sdPlugin"
```

The `postbuild` script aborts if the plugin entry is not a symlink.

Copy `com.hogehoge.spyserver-ex.sdPlugin/config.example.json` to `config.json` and adjust:

- `host` / `port` — your SpyServer address
- `ffmpeg.deviceName` — output device name from `SwitchAudioSource -t output -a`, or `"default"`
- `ffmpeg.mode` — `"local"` for AudioToolbox, `"icecast"` for streaming

## Architecture notes

- **SpyServer protocol** (Airspy spec, version 2.0.1700) is implemented from scratch following SDR++'s `spyserver_client.cpp`. Order of `SET_SETTING` commands matters: `IQ_FORMAT → IQ_DECIMATION → IQ_FREQUENCY → STREAMING_MODE → GAIN → IQ_DIGITAL_GAIN → STREAMING_ENABLED`.
- **Master ON/OFF**: `enabled` config field, toggled by the SpyServer Dial's PUSH (release). Going OFF cancels any pending reconnect timer, calls `client.disconnect()` and tears down audio. Going ON replaces the SpyClient with a fresh instance and starts a new connect cycle. While OFF, all four dial panels render with a 30 % opacity overlay (`<g opacity="0.30">` wrapper) and Stream Deck text-layout items (S/N labels, RSSI/SNR numerics) get an explicit dim colour override since those aren't covered by the SVG overlay.
- **Audio device by name**: `ffmpeg -f audiotoolbox <N>` indices change whenever a device is plugged in or removed. We persist the device **name** and resolve the current index every time `ffmpeg` is spawned, falling back to `default` if the named device is not found.
- **Pop suppression**: ffmpeg stdin gets a 40 ms silence prefill at startup; the iq listener writes silent PCM whenever `Date.now() < muteUntil`. Three independent paths set `muteUntil`: startup (500 ms), retune (200 ms initial + 250 ms re-mute on apply), gain change (200 ms initial + 150 ms re-mute on apply). Both retune and gain change use an 80–120 ms debounce so rapid dial rotation groups into a single SpyServer command + one mute window. The demodulator skips `atan2(0,0)` when both vectors are near zero.
- **Volume**: in-memory state updates instantly; disk persistence is debounced 300 ms. Encoder rotation uses progressive acceleration (2 % / 3 % / 5 % per tick depending on spin speed).
- **Stereo decode**: 2nd-order Costas-style PLL locks VCO phase to the 19 kHz pilot extracted from the demodulated FM signal. Loop bandwidth ≈ 50 Hz, damping = 1/√2, integrator clamped to ±0.05 rad/sample to prevent runaway when no real pilot is present. The doubled VCO phase generates a phase-locked 38 kHz reference for L−R demodulation. Lock detection uses a smoothed phase-detector magnitude with hysteresis (3:1 ratio) so weak/intermittent pilots don't flap. When unlocked, L−R is forced to zero and output collapses cleanly to mono. The dial's STEREO badge is shown only when both `pilotLock && fmOptions.stereo` — turning the stereo option off in the FM Options panel hides the badge to match the actual mono audio output.
- **AM IF LPF (16th-order Butterworth)**: 8 cascaded Biquads with per-stage Q values `[0.5024, 0.5226, 0.5669, 0.6471, 0.7882, 1.0607, 1.7224, 5.1011]` give a true 16th-order Butterworth response (~−96 dB/oct stopband) at cutoff = bandwidth / 2. This rejects off-centre carriers within the wide IQ passband AND any signals that would otherwise alias into baseband from beyond the SpyServer-side anti-alias's transition band. Without this, tuning to (e.g.) 1314 kHz would let the cross-modulation product of two strong stations fall on the desired frequency.
- **AM post-envelope LPF (8th-order Butterworth)**: 4 cascaded Biquads at the audio rate, cutoff = bandwidth / 2 — limits the post-detection bandwidth and also serves as anti-imaging for any future low-IF reconstruction.
- **AM AGC**: asymmetric IIR tracks `|envelope|` with adjustable attack/decay (SDR++ convention: 1–200 ms attack, 1–20 ms decay), dividing the signal by the tracker to normalise toward `targetLevel = 10000`. AGC OFF path uses a fixed ×32 multiplier, sized so typical broadcast envelope amplitudes give an output level comparable to WFM stereo; this lets a single Volume setting work across modes. Strong stations may clip on peaks in the AGC OFF path — that's the trade-off for "no AGC".
- **Output-level matching across modes**: gain constants chosen so a single Volume setting yields similar loudness regardless of demod mode. WFM ×8000, WFM Stereo ×6000, NFM ×12000 (FM atan2 output is naturally peak-limited at ±π), AM AGC OFF ×32, AM AGC ON normalises to amplitude 10000.
- **Per-mode RF gain**: SpyServer's `SETTING_GAIN` is the dominant variable for adjacent-channel IMD on the AM band (strong local stations overload the LNA and produce intermod products that fall on the desired frequency). Storing AM and FM gain separately means a quiet-AM-station setup (e.g. gain = 4 to dodge IMD on Tokyo MW) doesn't penalise FM reception (gain = 8). The active mode's gain is re-sent when the user crosses the AM ↔ non-AM boundary via `setDemodMode`.
- **Audio device routing**: lookup map is built from `ffmpeg -f audiotoolbox -list_devices true`. Devices that report a "(null)" display name (some USB DACs like Topping DX7s) are recovered by parsing the device UID (e.g. `AppleUSBAudioEngine:Topping:DX7s:8311000:1` → `DX7s`).
- **Persistence**: `lastFrequency`, `demodMode`, `enabled`, `amGain`, `fmGain` are debounced-saved (500 ms) on every change. `connect()` restores them so the radio comes up on the same station / mode / gain as before. Multiple SpyDialTune actions in the same plugin instance no longer fight over the initial tune — only the dial whose preset matches the restored frequency pushes a `setDemodMode`, others just refresh their display. Legacy single-`gain` config field is auto-migrated into `amGain`.
- **Signal-strength bars** (Dial LCD bottom): direct port of the ATS-Mini plugin's segmented bar (30 segments, 4 px wide × 1 px gap, green `#00ff00` / red `#ff0000`). RSSI maps `−100..−20 dBFS → 0..100 %` so a moderate FM station shows red on a few top segments at the 10/17 split, mirroring the ATS-Mini S9 boundary. SNR is all-green like ATS-Mini's. Note: an Airspy HF+ via SpyServer is a direct-conversion receiver — there is no chip-level RSSI/SNR register; both meters are computed from the IQ stream and will not perfectly match a SI4732-class superhet receiver.
- **Diagnostic spectrum probes**: when AM mode is active, every 2 seconds the plugin logs three lines per IQ packet — `spec/raw` (single-bin DFT of the raw IQ stream at fixed offsets ±9k / ±18k / ±27k / ±36k / ±45k / ±54k / ±72k / ±96k / ±108k Hz from baseband 0), `spec/filt` (the same offsets after the IQ goes through an *independent state-isolated* copy of the IF LPF, used to verify theoretical attenuation without disturbing the production filter) and `spec/prod` (the actual production-side IF LPF output captured per packet). Comparing `spec/raw` vs `spec/prod` confirms the IF chain is delivering its design attenuation in steady state, and bin-level numbers help distinguish DSP issues from front-end IMD when crosstalk appears.

## License

Personal project. No license granted.
