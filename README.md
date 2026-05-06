# Deck RX

Stream Deck + plugin to control a remote [SpyServer](https://airspy.com/) and listen to AM/SW/FM radio directly from the Stream Deck encoder dials.

The plugin connects over TCP to a SpyServer (e.g., an Airspy HF+ Discovery on a NanoPi), pulls down INT16 IQ samples, demodulates them in TypeScript, and pipes the resulting PCM through `ffmpeg` to a chosen macOS CoreAudio device.

## Features

| Item | Status |
|---|---|
| Volume | ✅ (0–150 %, bar shows overdrive zone past 100 % unity mark) |
| Master ON/OFF (Dial PUSH) | ✅ (full UI dim while OFF, persisted) |
| Connection resilience | ✅ (TCP-connect timeout, app-level watchdog for cable-pull detection, full-dial dim + `LINK` indicator + `-----` freq while offline, auto-reconnect with state restore) |
| Server host / port via PI | ✅ (debounced live-apply: changing host/port tears down + reconnects without restart) |
| AM/SW Bandwidth | ✅ (16th-order complex IF LPF on I/Q + 8th-order post-envelope LPF) |
| Carrier AGC | ✅ |
| AGC Attack | ✅ (1–200, SDR++ slider convention = rate in 1/τ_seconds) |
| AGC Decay | ✅ (1–20) |
| FM Stereo PLL (true phase lock) | ✅ |
| Per-mode RF Gain (AM / FM separate) | ✅ (live-applied, debounced, pop-suppressed) |
| Frequency / mode persistence | ✅ (restored at startup) |
| IFNR (IF Noise Reduction) | ✅ FM/NFM only (SDR++ FMIF tracking-filter port) |
| Auto station-name lookup | ✅ JP FM/MW (1都7県 親局+中継局+CFM via 関東総通局 scrape) + manual overrides + EIBI SW DB (day/time/spur-aware); in-PI `Update Now` for both |

### Encoder dial layout (4 LCDs on Stream Deck +)

![Deck RX — all four LCD panels](docs/lcd-combined.png)

- **Deck RX Dial** — VFO / preset scrolling, 7-segment frequency LCD, FM stereo lock badge (only shown when stereo decode is enabled AND pilot is locked), ATS-Mini-style 30-segment N (SNR) / S (RSSI) signal-strength bars (150 px wide, ~12 px insets each side to keep clear of the rounded frame); **Long-press (≥ 2 s) to toggle master ON/OFF** — short press is intentionally a no-op so accidental encoder bumps don't power-cycle the radio (the OFF state dims every dial and the header shows `OFF <preset>`). When the SpyServer link is down the dial dims, the header shows `LINK <preset>` and the frequency switches to `-----` until the connection recovers. A small **`HH:MM TZ` clock** is rendered in the top-right corner of the LCD, above the frequency unit (refreshes once per second via the existing footerTimer; system timezone abbreviation, e.g. `JST`, `PDT`). The Property Inspector exposes Mode / preset / step / audio enable / audio device AND the SpyServer host + port (changing host/port debounce-applies live without a plugin restart).
- **Deck RX Volume + Status** — rotate adjusts 0–150 %, push toggles mute; the same panel shows `Conn` (`ONLINE` in red while streaming, `OFFLINE` while offline), `Host`, `Dev` (device + IQ rate), `AOut` (audio output device name) and `Vol` with an inline gauge bar (volume bar covers the full 0–150 % range with a faint tick at the 100 % unity mark and an orange fill colour beyond it for the overdrive zone). When `AOut == icecast` an extra `Pub` row reports publish health: green `OK` once the icecast source pipeline has stayed up ≥ 5 s, red `ERR <Auth|Network|Codec|Other>` after 3 fast-fail spawns within 3 s of launch (source-password mismatch, icecast host unreachable, codec rejected, etc.). The bar's bottom edge is pinned to y = 91 so it lines up exactly with the Tune dial's RSSI bar across the bezel gap.
- **Deck RX Options** (FM/NFM) — De-emphasis (off / 50 µs / 75 µs), IFNR (SDR++ FMIF tracking filter, FM/NFM only), HiPass, LoPass, Stereo, **Gain** (RF gain index, only shown while a non-AM mode is the active demod)
- **Deck RX AM Options** — Bandwidth (4 / 6 / 9 / 12 kHz), Carrier AGC, Attack, Decay (continuous 10 % per tick log adjustment), **Gain** (only shown while AM is active)
- All panel-style dials use a unified compact font (rowH = 14, font 11 / 12) and a rounded grey frame (R = 4) drawn over every other element so AM Options, FM Options, Volume + Status and the Tune dial all share the same outer styling. Rows are vertically centred in the 100 px LCD area; columns inset from each LCD edge so adjacent panels don't visually run into each other across the bezel.
- Focus highlight (selected row in AM/FM Options): soft mid-blue background `#3a5a85`, deep yellow label `#d4b800` + bright yellow value `#ffee00` in navigate mode; orange label + yellow value in edit mode.

### Signal-path implementation

- WFM stereo decoder with **2nd-order Costas-style PLL** locked to 19 kHz pilot, hysteretic lock detection, mono fallback when unlocked
- AM envelope detector with two cascaded sharp filters: **16th-order Butterworth complex IF LPF on I/Q (8 cascaded biquads, ~−96 dB/oct stopband)** for adjacent-channel and aliased-station rejection, then **8th-order Butterworth post-envelope audio LPF** (4 cascaded biquads) and asymmetric attack/decay carrier AGC
- 50 µs / 75 µs FM de-emphasis (single-pole IIR)
- **IF Noise Reduction (FMIF tracking filter)** — port of SDR++ `dsp::noise_reduction::FMIF`. Per-sample sliding Nuttall-windowed FFT (32 bins for WFM, 15 for NFM) over the complex IQ stream; for each output sample we keep only the bin with the largest magnitude and discard the rest, tracking the FM signal's instantaneous frequency and rejecting broadband IF noise. The inverse FFT's centre tap is computed analytically (`X[idx] · (-1)^idx / N`) so we run only one FFT per sample. Disabled for AM/SSB/CW (mirrors SDR++'s `getFMIFNRAllowed()` policy — those modes have continuous-amplitude carriers that this algorithm would mangle)
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
- **Connection resilience** (TCP-side): `client.connect()` has a 5 s timeout (so an unreachable host doesn't block the reconnect loop on the OS's ~75 s SYN retry), and once connected an application-level watchdog declares the link dead if no bytes arrive for 5 s. This catches LAN-cable-pull within the watchdog window — the TCP stack alone wouldn't notice for hours since macOS keepalive defaults to 2 h idle. On declared-dead, the demod is reset, audio stops, every dial dims with the Tune dial flipping to `LINK` header + `-----` freq, and a 5 s reconnect cycle starts. Recovery restores the same station / mode / per-mode gain via persisted state and resumes audio automatically.
- **Server host/port live-edit**: the Tune dial Property Inspector exposes editable Host (text) and Port (number) fields. On change, an 800 ms debounce fires `setServerConfig`, which persists the value AND tears the current TCP/audio chain down + reconnects the SpyClient at the new endpoint. No plugin restart needed.

## Repository layout

```
~/dev/deck-rx/
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
├── scripts/                        # Tooling helpers
│   └── dump-lcd.sh                 # capture all 4 LCD panels as PNGs in ~/ICON/
└── com.hogehoge.deck-rx.sdPlugin/
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
ln -s "$(pwd)/com.hogehoge.deck-rx.sdPlugin" \
      "$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins/com.hogehoge.deck-rx.sdPlugin"
```

The `postbuild` script aborts if the plugin entry is not a symlink.

Copy `com.hogehoge.deck-rx.sdPlugin/config.example.json` to `config.json` and adjust:

- `host` / `port` — your SpyServer address
- `ffmpeg.deviceName` — output device name from `SwitchAudioSource -t output -a`, or `"default"`
- `ffmpeg.mode` — `"local"` for AudioToolbox, `"icecast"` for streaming

Audio output mode is also switchable from the **Tune dial Property Inspector**
without editing `config.json`:

- `Output: Local Device` — pick a CoreAudio device from the dropdown
- `Output: Icecast Stream` — fill in the source URL (e.g.
  `icecast://source@host:port/mount`) and the icecast `source-password` (the
  PI uses `<input type="password">` so the value is masked). The plugin
  stores the URL and the password as separate fields in `config.json`
  (`ffmpeg.icecastUrl` / `ffmpeg.icecastPassword`) and only re-combines them
  on the ffmpeg command line at spawn. icecast 2 stock requires a non-empty
  source-password — there is no truly anonymous source mode.

Switching Output between Local and Icecast tears the previous ffmpeg child
down and **awaits its exit** (Promise-based `stop()`) before spawning the
new one, so AudioToolbox isn't claimed by two processes at once and the
sample-rate negotiation doesn't get stuck at the device default (which
would otherwise make the audio play back at the wrong speed).

## Server-side setup (SpyServer on Linux ARM/aarch64)

The plugin talks to a running SpyServer. The reference deployment is an
Airspy HF+ Discovery on a NanoPi Zero2 (aarch64) running Ubuntu 24.04, with
SpyServer published on the LAN at port 8888.

### Hardware

- Airspy HF+ Discovery (USB ID `03eb:800c`) — covers DC..31 MHz + 60..260 MHz
- Linux SBC reachable from the Mac (NanoPi Zero2 / Raspberry Pi / etc.)
- Antenna appropriate for the bands you care about (MW loop, SW long-wire, FM stub, …)

### Dependencies

```sh
sudo apt update
sudo apt install -y libusb-1.0-0 libairspyhf1
# Optional userspace tool used to verify the device is detected
sudo apt install -y airspyhf-tools  # provides airspyhf_info
```

The HF+ ships an upstream `libairspyhf1` (1.6.8 in Ubuntu 24.04) which is
the runtime SpyServer dlopens for Airspy HF+ devices.

### udev rule

Without a udev rule the device is owned by root and SpyServer can't open
it as a non-root service user.

`/etc/udev/rules.d/52-airspyhf.rules`:

```
ATTR{idVendor}=="03eb", ATTR{idProduct}=="800c", SYMLINK+="airspyhf-%k", MODE="660", GROUP="plugdev", TAG+="uaccess"
```

```sh
sudo udevadm control --reload && sudo udevadm trigger
```

### Service user

```sh
sudo useradd --system --shell /sbin/nologin --home-dir /home/spyserver --create-home spyserver
sudo usermod -aG plugdev spyserver   # so udev's GROUP=plugdev grants USB access
```

### Install the SpyServer binary

SpyServer is a closed-source binary distribution from Airspy. Download the
ARM64 build from <https://airspy.com/download/> ("airspyserver-arm64-…tar.gz")
and place the binary plus default config:

```sh
sudo install -m 755 spyserver /usr/local/bin/spyserver
sudo install -m 644 spyserver.config /usr/local/etc/spyserver.config
```

### Config

`/usr/local/etc/spyserver.config` (key fields, comments stripped):

```ini
bind_host        = 0.0.0.0
bind_port        = 8888-9000           # picks first free port in range
list_in_directory = 1
maximum_clients  = 3
allow_control    = 1
device_type      = AirspyHF+
device_serial    = 0xXXXXXXXXXXXXXXXX  # adjust to your device
fft_fps          = 20
fft_bin_bits     = 16
input_buffer_size_ms = 10
input_buffer_count   = 4
output_buffer_size_ms = 30
```

`device_serial` is shown by `airspyhf_info`.

### systemd service

`/etc/systemd/system/spyserver.service`:

```ini
[Unit]
Description=Spy Server
After=network-online.target

[Service]
Type=simple
Restart=always
RestartSec=2
ExecStart=/usr/local/bin/spyserver /usr/local/etc/spyserver.config
User=spyserver

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now spyserver
systemctl status spyserver --no-pager
```

### Verify

```sh
ss -tlnp | grep 8888              # SpyServer listening
journalctl -u spyserver -n 30     # recent log
airspyhf_info                      # confirms device + serial
```

From the Mac running Deck RX:

```sh
nc -zv <server-ip> 8888           # TCP connect smoke-test
```

### Notes / gotchas

- If the system runs `apt-daily-upgrade`, the package manager's
  `systemd daemon-reexec` can occasionally tear down USB binfmt state on
  boards using Rosetta or other binfmt translators; SpyServer survives
  this on a pure aarch64 host but fails on x64 binaries running under
  Rosetta. The reference deployment is native aarch64 to avoid this.
- The HF+ has on-chip AGC / preamp; the Stream Deck "Gain" dial controls
  SpyServer's `SETTING_GAIN` index (0..maxGainIndex) which the HF+ maps
  to LNA bypass + attenuator stages rather than continuous LNA gain.

## Architecture notes

- **SpyServer protocol** (Airspy spec, version 2.0.1700) is implemented from scratch following SDR++'s `spyserver_client.cpp`. Order of `SET_SETTING` commands matters: `IQ_FORMAT → IQ_DECIMATION → IQ_FREQUENCY → STREAMING_MODE → GAIN → IQ_DIGITAL_GAIN → STREAMING_ENABLED`.
- **Master ON/OFF**: `enabled` config field, toggled by a **2-second long press** on the Deck RX Dial. Short presses are intentionally ignored to avoid accidental power-cycling on encoder bumps. Going OFF cancels any pending reconnect timer, calls `client.disconnect()` and tears down audio. Going ON replaces the SpyClient with a fresh instance and starts a new connect cycle. While OFF, all four dial panels render with a 30 % opacity overlay (`<g opacity="0.30">` wrapper) and Stream Deck text-layout items (S/N labels, RSSI/SNR numerics) get an explicit dim colour override since those aren't covered by the SVG overlay.
- **Audio device by name**: `ffmpeg -f audiotoolbox <N>` indices change whenever a device is plugged in or removed. We persist the device **name** and resolve the current index every time `ffmpeg` is spawned, falling back to `default` if the named device is not found.
- **Pop suppression**: ffmpeg stdin gets a 40 ms silence prefill at startup; the iq listener writes silent PCM whenever `Date.now() < muteUntil`. Three independent paths set `muteUntil`: startup (500 ms), retune (200 ms initial + 250 ms re-mute on apply), gain change (200 ms initial + 150 ms re-mute on apply). Both retune and gain change use an 80–120 ms debounce so rapid dial rotation groups into a single SpyServer command + one mute window. The demodulator skips `atan2(0,0)` when both vectors are near zero.
- **Volume**: in-memory state updates instantly; disk persistence is debounced 300 ms. Encoder rotation uses progressive acceleration (2 % / 3 % / 5 % per tick depending on spin speed).
- **Stereo decode**: 2nd-order Costas-style PLL locks VCO phase to the 19 kHz pilot extracted from the demodulated FM signal. Loop bandwidth ≈ 50 Hz, damping = 1/√2, integrator clamped to ±0.05 rad/sample to prevent runaway when no real pilot is present. The doubled VCO phase generates a phase-locked 38 kHz reference for L−R demodulation. Lock detection uses a smoothed phase-detector magnitude with hysteresis (3:1 ratio) so weak/intermittent pilots don't flap. When unlocked, L−R is forced to zero and output collapses cleanly to mono. The dial's STEREO badge is shown only when both `pilotLock && fmOptions.stereo` — turning the stereo option off in the FM Options panel hides the badge to match the actual mono audio output.
- **AM IF LPF (16th-order Butterworth)**: 8 cascaded Biquads with per-stage Q values `[0.5024, 0.5226, 0.5669, 0.6471, 0.7882, 1.0607, 1.7224, 5.1011]` give a true 16th-order Butterworth response (~−96 dB/oct stopband) at cutoff = bandwidth / 2. This rejects off-centre carriers within the wide IQ passband AND any signals that would otherwise alias into baseband from beyond the SpyServer-side anti-alias's transition band. Without this, tuning to (e.g.) 1314 kHz would let the cross-modulation product of two strong stations fall on the desired frequency.
- **AM post-envelope LPF (8th-order Butterworth)**: 4 cascaded Biquads at the audio rate, cutoff = bandwidth / 2 — limits the post-detection bandwidth and also serves as anti-imaging for any future low-IF reconstruction.
- **AM AGC** (port of SDR++ `dsp::loop::AGC` + `dsp::demod::AM` CARRIER mode): tracks `|IQ|` with asymmetric attack/decay EWMA, applies `gain = setPoint / amp` to the **complex IQ stream BEFORE envelope detection**. Attack/Decay storage = SDR++ slider value (rate in 1/τ_seconds, 1..200 / 1..20); spyService converts to per-sample α = rate / fs at apply time. Look-ahead clipping prevention scans the rest of the IQ buffer when the tracker is far behind a peak (initial state, sudden amplitude jump) and snaps `amp` to the upcoming max so the first big sample never overshoots. setPoint = 16000, max gain = 1e6, max output amp (look-ahead trigger) = 24000 in Int16 scale. AGC OFF path uses a fixed ×32 post-envelope multiplier, sized so typical broadcast envelope amplitudes give an output level comparable to WFM stereo; this lets a single Volume setting work across modes. Strong stations may clip on peaks in the AGC OFF path — intentional trade-off.
- **Output-level matching across modes**: gain constants chosen so a single Volume setting yields similar loudness regardless of demod mode. WFM ×8000, WFM Stereo ×6000, NFM ×12000 (FM atan2 output is naturally peak-limited at ±π), AM AGC OFF ×32, AM AGC ON normalises `|IQ|` to setPoint = 16000 (envelope peak ≈ 16000 at 100 % modulation, AC after DC removal up to ±16000).
- **Per-mode RF gain**: SpyServer's `SETTING_GAIN` is the dominant variable for adjacent-channel IMD on the AM band (strong local stations overload the LNA and produce intermod products that fall on the desired frequency). Storing AM and FM gain separately means a quiet-AM-station setup (e.g. gain = 4 to dodge IMD on Tokyo MW) doesn't penalise FM reception (gain = 8). The active mode's gain is re-sent when the user crosses the AM ↔ non-AM boundary via `setDemodMode`.
- **Audio device routing**: lookup map is built from `ffmpeg -f audiotoolbox -list_devices true`. Devices that report a "(null)" display name (some USB DACs like Topping DX7s) are recovered by parsing the device UID (e.g. `AppleUSBAudioEngine:Topping:DX7s:8311000:1` → `DX7s`).
- **Persistence**: `lastFrequency`, `demodMode`, `enabled`, `amGain`, `fmGain` are debounced-saved (500 ms) on every change. `connect()` restores them so the radio comes up on the same station / mode / gain as before. Multiple SpyDialTune actions in the same plugin instance no longer fight over the initial tune — only the dial whose preset matches the restored frequency pushes a `setDemodMode`, others just refresh their display. Legacy single-`gain` config field is auto-migrated into `amGain`.
- **Signal-strength bars** (Dial LCD bottom): direct port of the ATS-Mini plugin's segmented bar (30 segments, 4 px wide × 1 px gap, green `#00ff00` / red `#ff0000`). RSSI maps `−100..−20 dBFS → 0..100 %` so a moderate FM station shows red on a few top segments at the 10/17 split, mirroring the ATS-Mini S9 boundary. SNR is all-green like ATS-Mini's. Note: an Airspy HF+ via SpyServer is a direct-conversion receiver — there is no chip-level RSSI/SNR register; both meters are computed from the IQ stream and will not perfectly match a SI4732-class superhet receiver.
- **Diagnostic spectrum probes**: when AM mode is active, every 2 seconds the plugin logs three lines per IQ packet — `spec/raw` (single-bin DFT of the raw IQ stream at fixed offsets ±9k / ±18k / ±27k / ±36k / ±45k / ±54k / ±72k / ±96k / ±108k Hz from baseband 0), `spec/filt` (the same offsets after the IQ goes through an *independent state-isolated* copy of the IF LPF, used to verify theoretical attenuation without disturbing the production filter) and `spec/prod` (the actual production-side IF LPF output captured per packet). Comparing `spec/raw` vs `spec/prod` confirms the IF chain is delivering its design attenuation in steady state, and bin-level numbers help distinguish DSP issues from front-end IMD when crosstalk appears.
- **Connection resilience**: two layers of dead-link detection, since neither alone is sufficient on macOS:
   1. `client.connect()` (Node `net.Socket.connect`) wraps the OS call with an explicit 5 s timeout. Without this, an unreachable host (firewall drop / no route) blocks on the OS SYN-retry timeout (~75 s on Darwin), stalling the whole reconnect loop.
   2. After connect, an application-level watchdog timer (1 s tick) tracks the timestamp of the last received byte. If 5 s elapse with no data, the watchdog destroys the socket and emits `disconnect`. This handles LAN-cable-pull / Wi-Fi disconnect / VPN drop where TCP itself wouldn't notice for 2 hours (default macOS keepalive idle).
   Both paths funnel into the same listener chain: `setConnectedState(false)` notifies all `subscribeConnectionState` subscribers, every dial dims, the Tune dial swaps freq → `-----` and header → `LINK <preset>`, audio stops cleanly, and `scheduleReconnect()` runs the 5 s reconnect cadence (which respects the master ON/OFF switch). On recovery, the client re-establishes, hydrates state from the persisted config, and resumes audio at the same station / mode / gain.
- **Editable host/port (PI)**: the Tune dial Property Inspector hosts a `<input type="text">` for host and `<input type="number">` for port (default values populated from current config via `getServerConfig` round-trip on PI open). Edits debounce 800 ms before sending `setServerConfig`, which calls `spyService.updateServerConfig({ host, port })` — that persists the new endpoint, tears down the current SpyClient, and (if the master switch is ON) reconnects to the new endpoint. No plugin restart needed.

## Station-name auto-lookup

The Tune dial header replaces the user's preset name with the broadcaster's actual identity when the tuned frequency is recognised. Two databases are consulted in priority order, with the preset name as a final fallback:

1. **`com.hogehoge.deck-rx.sdPlugin/data/jp-stations.json`** — split into two arrays:
   - **`stations`** — auto-overwritten by the **Tune dial PI `JP DB: Update Now` button**, which scrapes 関東総合通信局 ラジオ放送事業者一覧 (`https://www.soumu.go.jp/soutsu/kanto/bc/radio/list/index.html`) and produces ~150-200 entries covering AM 親局 + 中継局 (incl. FM補完中継局), 超短波(FM) 親局 + 中継局, and コミュニティ放送 (CFM) across **1都7県** (東京・神奈川・千葉・埼玉・茨城・栃木・群馬・山梨). The page is served as Shift_JIS — Node's built-in `TextDecoder('shift-jis')` handles the transcode. Parsing uses `node-html-parser` for DOM-level extraction (immune to the WebFetch-style "78.9 MHz misread as 89.2" hallucination class). Operator names are auto-cleaned: 法人形態 prefix (`株式会社`, `（株）`, etc.) stripped, parenthesised brand at end preferred (`葛飾エフエム放送株式会社（かつしかFM）` → `かつしかFM`), with a small alias table for `日本放送協会 → NHK`, `アール・エフ・ラジオ日本 → ラジオ日本`, `LuckyFM茨城放送 → LuckyFM`. The previous file is preserved as `jp-stations.json.YYYY-MM-DD-HHMMSS`. Sanity validation aborts non-destructively if the parse yields < 50 entries.
   - **`manualStations`** — hand-curated, **never touched by the scraper**. Use it for stations the 関東 page cannot see: NHK R2 (no separate row in the AM table), AFN (US military, outside 総務省 jurisdiction), and MW DX targets licensed by other 総通局 regions (近畿・東北・北海道・東海・中国・九州 etc.). On `freqHz` collision with `stations`, `manualStations` wins so a hand-curated name always overrides a scraper entry.

     **Add / remove / edit a manualStations entry:**

     ```sh
     # 1. Edit the JSON
     $EDITOR com.hogehoge.deck-rx.sdPlugin/data/jp-stations.json

     # 2. Append/remove an entry inside the manualStations array, e.g.
     #    { "freqHz": 1008000, "band": "MW", "name": "ABCラジオ" }

     # 3. Restart the plugin so the cache reloads
     kill $(cat /tmp/deck-rx.pid)
     ```

     The `JP DB: Update Now` PI button only rewrites `stations`; `manualStations` is preserved verbatim across updates.
   
   Station names use each broadcaster's own branding — Latin for stations that promote a Latin brand (`NACK5`, `J-WAVE`, `TOKYO FM`, …) and Kanji/Kana for the rest (`TBSラジオ`, `文化放送`, `NHKラジオ第1`, …). On-device the Stream Deck app renders Kanji through Core Text's Hiragino fallback; the dump pipeline (rsvg-convert + fontconfig) needs Hiragino or Noto Sans CJK installed for `scripts/dump-lcd.sh` to render Kanji rather than tofu (`fc-list :lang=ja` confirms availability). Match tolerance: ±50 kHz on FM (adjacent stations are 100 kHz apart), ±4 kHz on MW (9 kHz grid).
2. **`com.hogehoge.deck-rx.sdPlugin/data/eibi.txt`** — the EIBI shortwave broadcaster schedule (`http://eibispace.de/dx/eibi.txt`, ISO-8859-1 source converted to UTF-8 in-place). ATS-Mini ships the same database; the parser here mirrors `EIBI.cpp`'s fixed-width columns (`%14c%9c%11c%24c` for freq / time / days+ITU / station). Only consulted for 16 kHz – 30 MHz (LF/MF/HF range covered by EIBI). Refresh seasonally (March / October — EIBI's "A" / "B" seasons) from the **Tune dial Property Inspector**: an `EIBI: [Update Now]` button fetches the upstream file, decodes ISO-8859-1 → UTF-8, parses-validates (≥ 1000 entries) and atomically replaces `data/eibi.txt`. The previous file is preserved as `eibi.txt.YYYY-MM-DD-HHMMSS`. The PI status line shows `Last update: YYYY-MM-DD  /  N entries` (sourced from file mtime + parsed-entry count) on open and after each update. Equivalent manual flow if the button is unusable: `curl -fsSL http://eibispace.de/dx/eibi.txt | iconv -f ISO-8859-1 -t UTF-8 > com.hogehoge.deck-rx.sdPlugin/data/eibi.txt`.

EIBI lookup adds two filters that ATS-Mini's reference parser omits:

- **Day-of-week filter**. The Days column (`Mo-Fr`, `SaSu`, `Su-Th`, `4May`, `1.Sa`, digit-strings like `157`) is parsed and only entries valid for the current UTC weekday / date apply. Without this, e.g. 6115 kHz on a Wednesday would surface `Radio SE-TA2` (whose entries are `4May` and `SaSu`) instead of `Radio Nikkei 2` (`Mo-Fr`).
- **Spurious-emission drop**. EIBI tracks parasitic transmissions (intermod products / harmonics) with the `spur` flag — those are reference data, not actual broadcasts, and would show up as misleading "station names" if kept. They're filtered at parse time.

When multiple EIBI entries are simultaneously active at the same kHz, the **shortest time window** wins on the assumption that a narrowly programmed slot is more specific than a day-long allocation. When no real broadcaster matches (Mo-Fr-only window past its end, only-spur entries on the freq, etc.), the lookup returns null and the dial header falls back to the user's preset name.

The Tune dial header has a fixed 200 px width and reserves 49 px on the right when the FM stereo lock badge is shown, leaving only 151 px for the label. To accommodate longer station names (e.g. `WFM ニッポン放送` with the STEREO badge, or `VFO CNR 2 China Business R.` from EIBI), `makeHeaderSvg` adapts in three steps: (1) keep the original 14 px monospace size if the natural width fits; (2) drop to 12 px when 14 px overflows but 12 px would fit; (3) at 12 px combined with SVG `textLength` + `lengthAdjust="spacingAndGlyphs"` for horizontal squeeze when even 12 px still overflows. The natural-width estimate uses a CJK-aware char count (`effectiveCharCount`) that weights full-width characters (CJK ideographs, hiragana, full-width katakana, fullwidth ASCII) at 1.7× a Menlo half-width column to match how Hiragino fallback renders them; without this, a label like `WFM ニッポン放送` was under-measured and the STEREO badge slot collided with the trailing 「送」. The mechanism lives entirely in the rendering function so it applies uniformly to JP-DB, EIBI, and preset-name labels.

## Debug helpers

### LCD panel screenshots

Touching `/tmp/deck-rx-lcd-dump` arms a render-time hook that writes the raw
source SVG of each encoder LCD to `/tmp/deck-rx-lcd-<tag>.svg`
(`tag` ∈ `tune` / `volume` / `options` / `am-options`). Without the flag the
hook is a single `existsSync` check per render and adds no overhead, so it
can be left in production builds.

`scripts/dump-lcd.sh` runs the full capture loop: wipe stale dumps, set the
flag, bounce the plugin (kills the PID in `/tmp/deck-rx.pid` rather than
`pkill -f "<pattern>"` — see the script comment for why), wait up to 120 s
while you cycle through each panel on the device (Stream Deck only
re-renders the *visible* action), then `rsvg-convert -z 2` into
`~/ICON/deck-rx-lcd-<tag>.png` and clear the flag. Use this for README /
store screenshots without having to crop a Stream Deck app window capture.

Forgotten flags from a previous session (`mtime > 10 min`) are GC'd at
plugin startup, so the dump path can't stay armed across restarts. The
script's touch-then-bounce flow keeps the flag fresh, so legitimate
capture sessions are unaffected.

`scripts/lint-lcd.py` parses the dump SVGs and reports overlapping
`<text>` / `<polygon>` boxes (e.g. clock vs 7-seg digits in dial-tune).
`scripts/compare-lcd.sh save` snapshots `~/ICON/` to `~/ICON-baseline/`,
and `compare-lcd.sh` (no args) diffs current PNGs against that baseline
via ImageMagick `compare -metric AE`, dumping diff overlays into
`~/ICON-diff/` — handy when verifying that a render-side tweak only
affected what you intended.

### Dump vs on-device render — render-engine differences

The dump path (rsvg-convert + Pango + fontconfig) and the on-device
path (Stream Deck SDK + Core Text on macOS) draw the same SVG with
**different glyph metrics**. Pango's monospace fallback (Liberation
Mono on most fontconfig setups) tracks wider than Core Text's Menlo,
so a `<text>` element that fits cleanly on-device may overlap an
adjacent shape in the dump. `dumpTuneLcd` accepts this asymmetry as
a fact of life and applies a **dump-only fixup** to the Tune dial's
clock — when inlining freqDisplay's body for the dump SVG, it regex-
swaps the clock `<text>`'s attributes (single-family `Menlo` to bypass
Liberation Mono and avoid Illustrator "missing font" warnings,
`letter-spacing="-2"` to compensate Pango's wider tracking,
`x="189"` for visual centring against the digits). The on-device
output (via `setFeedback`) keeps `seg7svg`'s unmodified `<text>` and
is unaffected. If you ever add another tight-layout text element,
extend the same regex pattern in `dumpTuneLcd` rather than touching
`seg7svg` (which would shift the on-device render too).

## License

Personal project. No license granted.
