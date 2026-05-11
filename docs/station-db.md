# Station-name auto-lookup

[← Back to README](../README.md)

The Tune dial header replaces the user's preset name with the broadcaster's actual identity when the tuned frequency is recognised. Two databases are consulted in priority order, with the preset name as a final fallback:

## Region selection (Tune dial PI dropdown)

The JP DB is **region-aware**. The PI exposes a `JP region` dropdown (関東 / 北海道 / 東北 / 東海 / 近畿 / 中国 / 九州 / 沖縄) that controls two things:

1. **Lookup filter** — `lookupJpStation` only considers `stations[]` and `manualStations[]` entries tagged with the selected region (or untagged entries — see below). So a 90.5 MHz tune in 関東 mode resolves to the 関東 broadcaster (TBSラジオ FM 補完), not a same-frequency 中継局 from another region; a 1008 kHz tune in 近畿 surfaces ABCラジオ but the same freq tuned under 関東 returns nothing (preset name fallback).
2. **Update Now target** — clicking `JP DB: Update Now` scrapes only the selected region. Existing entries from other regions are preserved in `stations[]` so a user who switches to 近畿, scrapes, then switches back to 関東 doesn't lose their 関東 entries.

The selection is persisted to `config.json` as `jpRegion` (default `kanto` for backward compat). `manualStations` entries also carry an optional `region` tag — when present, they only hit when that region is active; **untagged manual entries remain truly global** (any region can match them, useful for nationwide identifiers if any).

**Per-region coverage**: all 8 regions are scraped; depth varies by source:

| Region | Source | Coverage |
|---|---|---|
| 関東 | 関東総通局 ラジオ放送事業者一覧 | AM 親+中継 + FM 親+中継 + CFM (1都7県) |
| 沖縄 | 沖縄総合通信事務所 ラジオ放送局チャンネル一覧 | AM (中波) + FM補完 (※ MHz inline) + FM + CFM |
| 北海道 / 東北 / 東海 / 近畿 / 中国 / 九州 | 総務省 全国民放FM局・ワイドFM局一覧 (`fm-list.html`) | **民放 FM only** — NHK FM や AM や CFM は含まれない (region-tagged manualStations で補完) |

関東 / 沖縄 は 総通局ページから AM + FM + CFM を直接取得できるため auto coverage が広い。 その他 6 region は **全国民放 FM 一括ページ** (`fm-list.html`) を主ソースに民放 FM を取得する構成。 DOM selector / parser 実装の詳細は `src/japanStationsScraper.ts` のコメントを参照してください。

**北海道 / 東北 / 東海 / 近畿 / 中国 / 九州 で NHK FM や AM 局を欲しい場合**: `manualStations[]` に手書きで追加する（[後述](#add--remove--edit-a-manualstations-entry)）。各 entry には `region` フィールドを付けると、その region がアクティブなときだけ lookup される — 例えば現状のプリセットでは ABCラジオ (1008, kinki), MBSラジオ (1179, kinki), TBCラジオ (1260, tohoku), RKB毎日放送 (1278, kyushu), HBCラジオ (1287, hokkaido), ラジオ大阪 (1314, kinki), 東海ラジオ (1332, tokai), RCCラジオ (1350, chugoku), STVラジオ (1440, hokkaido), AFN Eagle 810 (kanto), NHKラジオ第2 (693, kanto) を region tag 付きで登録している。region 無しで登録すれば全 region で hit する truly global override になる。

## Preset list — deck-rx presets / JP DB マージ + SDR++ Import

Tune dial の preset list は **deck-rx 専用 `data/presets.json` + JP DB の active region 局** を周波数昇順でマージしたもの。`loadPresets(activeRegion)` (`src/actions/spyTune.ts`) が組み立てる:

1. **`com.hogehoge.deck-rx.sdPlugin/data/presets.json`** を読む (UTF-8 clean、CJK broadcaster 名そのまま round-trip)。loaders は `src/presets.ts` の `loadDeckRxPresets / saveDeckRxPresets`。
2. `getJpStationsForRegion(activeRegion)` で active region の auto + region-tagged manual entries を取得し、`{ FM → mode 1 / 200 kHz, MW → mode 2 / 9 kHz }` で `Preset` 化
3. 周波数完全一致なら **JP DB が勝ち** (name は最新 scrape の broadcaster ブランド、deck-rx 側の手書き名は捨てる)。dedup 後 freq 昇順で sort

**Region 切替の挙動**: PI で `JP region` を切り替えると `spyService.subscribeJpRegion` listener が走り、preset cache を invalidate (`clearPresetsCache()`) → `loadPresets(newRegion)` で再構築 → PI へ `presets` event を再送信して dropdown を更新。

**Import from SDR++ (PI button)**: SDR++ の `frequency_manager_config.json` を読み、deck-rx presets.json に **マージ** する (既存 deck-rx entries は上書きしない、同名の bookmark は skip)。SDR++ config 自体は touch しない (read-only)。なぜ Import 経路が必要か：

- SDR++ の bookmark serialiser は **ASCII / Latin-1 のみで安定**動作する。漢字を入れると壊れるケースを user 環境で確認済み (2026-05 frequency_manager_config.json corruption incident — Python `json.dump` で indent / numeric type が変わって SDR++ が起動しなくなった)。
- ので deck-rx は **SDR++ config を直接書き換えない**設計。deck-rx 側で UTF-8 clean な `presets.json` を持ち、SDR++ から *read-only* に取り込む。
- 取り込み後、user は deck-rx の `presets.json` を自由に edit (CJK 局名追加 / フリーフォーマット) して良い。SDR++ は完全に分離。

**Import button の挙動**: PI の `SDR++` 行の Import bookmarks をクリック → `importSdrppPresets` action が `spyService` 経由で発火 → `presets.ts::importFromSdrpp` が走る → 完了後 PI に `sdrImported {ok, added, skipped}` で結果通知 + preset list を refresh。同名 bookmark は skip（user 編集を温存）。

**Test fixture path override**: `DECK_RX_PRESETS_PATH` / `DECK_RX_SDR_CONFIG_PATH` env var で deck-rx presets path / SDR++ config path をそれぞれ別 path に向けられる (test 用)。`src/presets.ts` の `presetsPath()` / `sdrConfigPath()` は call ごと evaluate なので、test で env 切替するだけで isolated に動く。

## Data sources

1. **`com.hogehoge.deck-rx.sdPlugin/data/jp-stations.json`** — split into two arrays:
   - **`stations`** — auto-overwritten **per region** by the **Tune dial PI `JP DB: Update Now` button**. For 関東 (current implementation), this scrapes 関東総合通信局 ラジオ放送事業者一覧 (`https://www.soumu.go.jp/soutsu/kanto/bc/radio/list/index.html`) and produces ~150-200 entries covering AM 親局 + 中継局 (incl. FM補完中継局), 超短波(FM) 親局 + 中継局, and コミュニティ放送 (CFM) across **1都7県** (東京・神奈川・千葉・埼玉・茨城・栃木・群馬・山梨). Each entry is tagged with `region: "kanto"` (or the region currently being scraped). The page is served as Shift_JIS — Node's built-in `TextDecoder('shift-jis')` handles the transcode. Parsing uses `node-html-parser` for DOM-level extraction (immune to the WebFetch-style "78.9 MHz misread as 89.2" hallucination class). Operator names are auto-cleaned: 法人形態 prefix (`株式会社`, `（株）`, etc.) stripped, parenthesised brand at end preferred (`葛飾エフエム放送株式会社（かつしかFM）` → `かつしかFM`), with a small alias table for `日本放送協会 → NHK`, `アール・エフ・ラジオ日本 → ラジオ日本`, `LuckyFM茨城放送 → LuckyFM`. **Alias post-condition** — the cleaned, post-alias form is what gets persisted to `stations[].name` and what the Tune dial header renders, so e.g. 94.6 MHz appears as `LuckyFM` (not `LuckyFM茨城放送`), 594 kHz as `NHK` (not `日本放送協会`). To opt out, edit `NAME_ALIASES` in `src/japanStationsScraper.ts` and click `JP DB: Update Now` again — `manualStations` bypasses the scraper entirely and is unaffected. The previous file is preserved as `jp-stations.json.YYYY-MM-DD-HHMMSS`. Sanity validation aborts non-destructively if the parse yields < 50 entries. **Cross-region preservation** — `Update Now` only replaces entries whose `region` matches the active dropdown selection; other regions' entries stay untouched.
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
   
   Station names use each broadcaster's own branding — Latin for stations that promote a Latin brand (`NACK5`, `J-WAVE`, `TOKYO FM`, …) and Kanji/Kana for the rest (`TBSラジオ`, `文化放送`, `NHKラジオ第1`, …). On-device the Stream Deck app renders Kanji through Core Text's Hiragino fallback; the dump pipeline (rsvg-convert + fontconfig) needs Hiragino or Noto Sans CJK installed for `scripts/dump-lcd.sh` to render Kanji rather than tofu (`fc-list :lang=ja` confirms availability). Match tolerance: **±5 kHz on FM** (well inside the 100 kHz channel grid), **±500 Hz on MW** (absorbs float drift only — wider would falsely match adjacent 9 kHz channels; e.g. tuning 590 kHz must NOT surface NHK 594).

### NHK channel inference + 送信地 + callsign annotation

`formatJpStationLabel(station)` (`src/japanStations.ts`) renders the dial header label by combining three pieces on top of the raw `station.name`:

1. **NHK channel inference** — post-2025-03 NHKラジオ第2 closure, every surviving NHK MW transmitter is 第1 and every NHK FM is NHK-FM. The scraped 法人名 is `"NHK"` (alias of 日本放送協会), which would otherwise leave 33+ entries indistinguishable. Bare `"NHK"` is auto-channelled to `"NHK第1"` (MW) or `"NHK-FM"` (FM); manualStations entries that explicitly say `"NHKラジオ第2"` etc. pass through unchanged.
2. **送信地** — scraped from the parenthesised suffix in 関東総通局 / 沖縄総通局 freq cells (`594kHz(東京)` → `siteName: "東京"`). Multiple physical relay sites (e.g. `"父島、母島"` / `"東京・墨田"`) are kept verbatim. CFM tables propagate the row's 市町村名 column. 沖縄 transposed table forwards each row's leading `<th>` location.
3. **識別信号 (callsign)** — sidecar lookup against `data/callsigns.json` (sourced from 総務省「無線局等情報検索」 under 公共データ利用規約 第1.0版). Region-independent (one freq + band → one callsign per license) so a 関東 user dialling 1179 kHz still surfaces `JOOR` even though the JP DB station entry is region-tagged kinki and would normally be region-filtered out. Display order: `<name|channel> <callsign> (<siteName>)` — e.g. `NHK第1 JOAK (東京)`, `TBSラジオ JOKR (東京)`.

callsigns.json is a separate file so a re-fetch (~50 min) doesn't disturb the curated stations / manualStations data. Build / refresh via `scripts/fetch-callsigns.ts` (full sweep) + `scripts/fetch-callsigns-supplement.ts` (operator-name keyword 補完 for 中央放送局 like TOKYO FM JOAU-FM that the default broadcast list filter excludes); `scripts/diff-callsigns.ts` reports added / removed / changed entries between two snapshots.
2. **`com.hogehoge.deck-rx.sdPlugin/data/eibi.txt`** — the EIBI shortwave broadcaster schedule (`http://eibispace.de/dx/eibi.txt`, ISO-8859-1 source converted to UTF-8 in-place). ATS-Mini ships the same database; the parser here mirrors `EIBI.cpp`'s fixed-width columns (`%14c%9c%11c%24c` for freq / time / days+ITU / station). Only consulted for 16 kHz – 30 MHz (LF/MF/HF range covered by EIBI). Refresh seasonally (March / October — EIBI's "A" / "B" seasons) from the **Tune dial Property Inspector**: an `EIBI: [Update Now]` button fetches the upstream file, decodes ISO-8859-1 → UTF-8, parses-validates (≥ 1000 entries) and atomically replaces `data/eibi.txt`. The previous file is preserved as `eibi.txt.YYYY-MM-DD-HHMMSS`. The PI status line shows `Last update: YYYY-MM-DD  /  N entries` (sourced from file mtime + parsed-entry count) on open and after each update. Equivalent manual flow if the button is unusable: `curl -fsSL http://eibispace.de/dx/eibi.txt | iconv -f ISO-8859-1 -t UTF-8 > com.hogehoge.deck-rx.sdPlugin/data/eibi.txt`.

EIBI lookup adds two filters that ATS-Mini's reference parser omits:

- **Day-of-week filter**. The Days column (`Mo-Fr`, `SaSu`, `Su-Th`, `4May`, `1.Sa`, digit-strings like `157`) is parsed and only entries valid for the current UTC weekday / date apply. Without this, e.g. 6115 kHz on a Wednesday would surface `Radio SE-TA2` (whose entries are `4May` and `SaSu`) instead of `Radio Nikkei 2` (`Mo-Fr`).
- **Spurious-emission drop**. EIBI tracks parasitic transmissions (intermod products / harmonics) with the `spur` flag — those are reference data, not actual broadcasts, and would show up as misleading "station names" if kept. They're filtered at parse time.

When multiple EIBI entries are simultaneously active at the same kHz, the **shortest time window** wins on the assumption that a narrowly programmed slot is more specific than a day-long allocation. When no real broadcaster matches (Mo-Fr-only window past its end, only-spur entries on the freq, etc.), the lookup returns null and the dial header falls back to the user's preset name.

The Tune dial header has a fixed 200 px width and reserves 49 px on the right when the FM stereo lock badge is shown, leaving only 151 px for the label. To accommodate longer station names (e.g. `WFM ニッポン放送` with the STEREO badge, or `VFO CNR 2 China Business R.` from EIBI), `makeHeaderSvg` adapts in three steps: (1) keep the original 14 px monospace size if the natural width fits; (2) drop to 12 px when 14 px overflows but 12 px would fit; (3) at 12 px combined with SVG `textLength` + `lengthAdjust="spacingAndGlyphs"` for horizontal squeeze when even 12 px still overflows. The natural-width estimate uses a CJK-aware char count (`effectiveCharCount`) that weights full-width characters (CJK ideographs, hiragana, full-width katakana, fullwidth ASCII) at 1.7× a Menlo half-width column to match how Hiragino fallback renders them; without this, a label like `WFM ニッポン放送` was under-measured and the STEREO badge slot collided with the trailing 「送」. The mechanism lives entirely in the rendering function so it applies uniformly to JP-DB, EIBI, and preset-name labels.
