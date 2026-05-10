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
| USB / LSB / CW | ✅ Weaver-method SSB demod (4th-order Butterworth audio LPF, ±f_off Q-flip for sideband select); CW = direct frequency-shift by BFO (default 700 Hz). VFO band-cross auto-selects mode for the major amateur segments (160m/80m/40m → LSB, 20m/15m/10m → USB, lower edge of each → CW) |
| Carrier AGC | ✅ (port of SDR++ `dsp::loop::AGC` + `dsp::demod::AM` CARRIER mode; tracks `\|IQ\|` with asymmetric attack/decay EWMA, applies gain to the complex IQ stream BEFORE envelope detection) |
| AGC Attack | ✅ (1–200, SDR++ slider convention = rate in 1/τ_seconds) |
| AGC Decay | ✅ (1–20) |
| FM Stereo PLL (true phase lock) | ✅ (2nd-order Costas-style PLL locks VCO to 19 kHz pilot, loop bandwidth ≈ 50 Hz, damping = 1/√2, hysteretic lock detection so weak/intermittent pilots don't flap; STEREO badge shown only while pilot-locked AND user has stereo option enabled) |
| Per-mode RF Gain (AM / FM separate) | ✅ (live-applied, debounced, pop-suppressed) |
| Frequency / mode persistence | ✅ (debounced 500 ms write to `config.json`; on startup the stored freq + demod mode + tune step are restored before the first IQ packet) |
| IFNR (IF Noise Reduction) | ✅ FM/NFM only (SDR++ FMIF tracking-filter port) |
| Auto station-name lookup | ✅ **Japan-area only** for the JP DB — region-switchable from the Tune dial PI (関東 / 北海道 / 東北 / 東海 / 近畿 / 中国 / 九州 / 沖縄 ※全 8 region 対応; 関東+沖縄は AM/FM/CFM 一括、他 6 region は民放 FM のみ via 全国 FM 一覧) + region-tagged manual overrides; the EIBI SW DB covers international shortwave (day/time/spur-aware); in-PI `Update Now` for both |
| Preset list | ✅ deck-rx-owned `data/presets.json` (UTF-8 clean、CJK 局名 OK) + JP DB の active region 局を周波数昇順でマージ; 同 freq は JP DB の局名で上書き; region 切替で list 自動再構築; PI の `Import bookmarks` で SDR++ `frequency_manager_config.json` から取り込み (read-only、merge、name dedup) |

![Deck RX — all four LCD panels](docs/lcd-combined.png)

Per-dial layouts and screenshots (Tune / Volume / Combo / FM / AM / SSB / Band Select / Options Auto / Options 2-Col): see [docs/dial-layouts.md](docs/dial-layouts.md).

## Documentation

- [Repository layout](docs/repository-layout.md)
- [Build & install](docs/build-install.md)
- [Server-side setup (SpyServer on Linux ARM/aarch64)](docs/server-setup.md)
- [Dial layouts](docs/dial-layouts.md) — per-plugin LCD screenshots + per-row UI explanations
- [Architecture notes](docs/architecture.md) — dial details, signal-path implementation, internal mechanisms
- [Station-name auto-lookup](docs/station-db.md) — JP DB scraper + EIBI integration, alias rules, NHK channel inference + 送信地 + callsign annotation
- [Data sources & attribution](docs/data-sources.md) — 総務省 / 関東総通局 / 沖縄総通局 / EIBI license terms + refresh scripts
- [Debug helpers](docs/debug-helpers.md) — LCD dump / lint / compare-baseline scripts

## License

Personal project. No license granted.
