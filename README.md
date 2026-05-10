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
| Carrier AGC | ✅ |
| AGC Attack | ✅ (1–200, SDR++ slider convention = rate in 1/τ_seconds) |
| AGC Decay | ✅ (1–20) |
| FM Stereo PLL (true phase lock) | ✅ |
| Per-mode RF Gain (AM / FM separate) | ✅ (live-applied, debounced, pop-suppressed) |
| Frequency / mode persistence | ✅ (restored at startup) |
| IFNR (IF Noise Reduction) | ✅ FM/NFM only (SDR++ FMIF tracking-filter port) |
| Auto station-name lookup | ✅ **Japan-area only** for the JP DB — region-switchable from the Tune dial PI (関東 / 北海道 / 東北 / 東海 / 近畿 / 中国 / 九州 / 沖縄 ※全 8 region 対応; 関東+沖縄は AM/FM/CFM 一括、他 6 region は民放 FM のみ via 全国 FM 一覧) + region-tagged manual overrides; the EIBI SW DB covers international shortwave (day/time/spur-aware); in-PI `Update Now` for both |
| Preset list | ✅ deck-rx-owned `data/presets.json` (UTF-8 clean、CJK 局名 OK) + JP DB の active region 局を周波数昇順でマージ; 同 freq は JP DB の局名で上書き; region 切替で list 自動再構築; PI の `Import bookmarks` で SDR++ `frequency_manager_config.json` から取り込み (read-only、merge、name dedup) |

### Encoder dial layout (4 LCDs on Stream Deck +)

![Deck RX — all four LCD panels](docs/lcd-combined.png)

- **Deck RX Dial** — VFO / preset scrolling, 7-seg frequency, FM stereo lock badge, ATS-Mini-style N (SNR) / S (RSSI) bars, `HH:MM TZ` clock; long-press (≥ 2 s) for master ON/OFF
- **Deck RX Volume + Status** — 0–150 % volume / mute, conn state, host, device, audio output, icecast publish health
- **Deck RX Options** (FM/NFM) — Deemphasis / IFNR / HPF / LPF / Stereo / Gain
- **Deck RX AM Options** — BW / Carrier AGC / Attack / Decay / Gain
- **Deck RX Combo Options** — unified Band selector (WFM / NFM / AM / USB / LSB / CW) on the left column + mode-dependent Options on the right column. PUSH on a Band row immediately switches the demod mode (no edit-mode roundtrip); the Opts column auto-shapes to AM (BW / CAGC / Sync / Atk / Dec / Gain), FM (Deemph / IFNR / HPF / LPF / Ste / Gain), or SSB (BW / BFO / Gain) depending on the active demod. Mode/Step (preset ⇄ vfo + step cycle) lives at the bottom of the Band column. The legacy single-mode `Deck RX Options` and `Deck RX AM Options` panels are still registered for users who prefer one panel per mode

![Combo dial — all 6 demod modes](docs/lcd-combo-modes.png)

See [docs/architecture.md](docs/architecture.md) for layout details, focus highlight colours, and signal-path notes.

## Documentation

- [Repository layout](docs/repository-layout.md)
- [Build & install](docs/build-install.md)
- [Server-side setup (SpyServer on Linux ARM/aarch64)](docs/server-setup.md)
- [Architecture notes](docs/architecture.md) — dial details, signal-path implementation, internal mechanisms
- [Station-name auto-lookup](docs/station-db.md) — JP DB scraper + EIBI integration, alias rules
- [Debug helpers](docs/debug-helpers.md) — LCD dump / lint / compare-baseline scripts

## Data sources & attribution

The auto station-name lookup combines several public broadcast databases.
All upstream data is used under its own terms; deck-rx redistributes the
station list and callsign DB under the attributions below.

| Source | Coverage | License / Terms |
|---|---|---|
| 関東総合通信局 ラジオ放送事業者一覧 | 1都7県 (東京・神奈川・千葉・埼玉・茨城・栃木・群馬・山梨) AM 親局 + 中継局 + FM 補完 + 超短波 + コミュニティ放送 | 公共データ利用規約 第1.0版 |
| 沖縄総合通信局 ラジオ周波数一覧 | 沖縄県 AM/FM/CFM | 公共データ利用規約 第1.0版 |
| 総務省 全国民放FM局・ワイドFM局一覧 | 北海道・東北・東海・近畿・中国・九州 民放 FM | 公共データ利用規約 第1.0版 |
| **総務省 無線局等情報検索** (https://www.tele.soumu.go.jp/musen/) | **callsign (識別信号) DB across all licensed broadcast transmitters** | **公共データ利用規約 第1.0版** |
| EIBI SW DB | 国際短波放送 (day/time/spur-aware) | EIBI license (publicly accessible, attribution requested) |

公共データ利用規約 第1.0版 (https://www.soumu.go.jp/menu_kyotsuu/policy/tyosaku.html)
は商用利用も含む再配布を認める一方で、 出典明記と編集・加工した場合
その旨の記載を求めています。 本リポジトリ内の `com.hogehoge.deck-rx.sdPlugin/data/jp-stations.json`
および `callsigns.json` は当該規約に準拠して以下の編集を施しています:

- 法人名の brand 化 (法令上の "株式会社..." → 一般に流通する短縮形 / カナ表記)
- 周波数を Hz 整数に正規化
- 送信地・市町村名 cell を `siteName` フィールドに分離
- 識別信号値の前後にあるマスク (`*****`) や `<BR>` を除去し callsign 単独に切り出し

データ更新時は以下のスクリプトで再取得できます (rate-limit 1 req/sec、 全体で
約 50 分):

```sh
npx tsx scripts/fetch-callsigns.ts        # AM + FM 全件
npx tsx scripts/fetch-callsigns.ts --validate  # AM 1 page (smoke test, ~2 分)
```

総務省側に差分取得 API は無いため再取得は常に全量。 1 年後等に何が変わったか
だけ知りたい場合は `scripts/diff-callsigns.ts` で前回 fetch との差分を表示
できます (新規 license / 廃止 / 設置場所・法人名変更を分類):

```sh
cp com.hogehoge.deck-rx.sdPlugin/data/callsigns.json{,.old}
npx tsx scripts/fetch-callsigns.ts
npx tsx scripts/diff-callsigns.ts \
    com.hogehoge.deck-rx.sdPlugin/data/callsigns.json.old \
    com.hogehoge.deck-rx.sdPlugin/data/callsigns.json
# 確認 OK なら .old を削除して commit、 一部だけ rollback したい場合は手動編集
```

## License

Personal project. No license granted.
