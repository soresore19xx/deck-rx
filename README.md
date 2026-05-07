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

- **Deck RX Dial** — VFO / preset scrolling, 7-seg frequency, FM stereo lock badge, ATS-Mini-style N (SNR) / S (RSSI) bars, `HH:MM TZ` clock; long-press (≥ 2 s) for master ON/OFF
- **Deck RX Volume + Status** — 0–150 % volume / mute, conn state, host, device, audio output, icecast publish health
- **Deck RX Options** (FM/NFM) — Deemphasis / IFNR / HPF / LPF / Stereo / Gain
- **Deck RX AM Options** — BW / Carrier AGC / Attack / Decay / Gain
- **Deck RX Combo Options** — both AM and FM in side-by-side dual columns; active column auto-tracks the demod mode

See [docs/architecture.md](docs/architecture.md) for layout details, focus highlight colours, and signal-path notes.

## Documentation

- [Repository layout](docs/repository-layout.md)
- [Build & install](docs/build-install.md)
- [Server-side setup (SpyServer on Linux ARM/aarch64)](docs/server-setup.md)
- [Architecture notes](docs/architecture.md) — dial details, signal-path implementation, internal mechanisms
- [Station-name auto-lookup](docs/station-db.md) — JP DB scraper + EIBI integration, alias rules
- [Debug helpers](docs/debug-helpers.md) — LCD dump / lint / compare-baseline scripts

## License

Personal project. No license granted.
