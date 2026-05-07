# Station-name auto-lookup

[← Back to README](../README.md)

The Tune dial header replaces the user's preset name with the broadcaster's actual identity when the tuned frequency is recognised. Two databases are consulted in priority order, with the preset name as a final fallback:

## Region selection (Tune dial PI dropdown)

The JP DB is **region-aware**. The PI exposes a `JP region` dropdown (関東 / 北海道 / 近畿 / 中国 / 九州 / 沖縄) that controls two things:

1. **Lookup filter** — `lookupJpStation` only considers `stations[]` entries tagged with the selected region. So a 90.5 MHz tune in 関東 mode resolves to the 関東 broadcaster (TBSラジオ FM 補完), not a same-frequency 中継局 from another region.
2. **Update Now target** — clicking `JP DB: Update Now` scrapes only the selected region. Existing entries from other regions are preserved in `stations[]` so a user who switches to 近畿, scrapes, then switches back to 関東 doesn't lose their 関東 entries.

The selection is persisted to `config.json` as `jpRegion` (default `kanto` for backward compat). `manualStations` is **region-independent** — those hand-curated entries are always consulted regardless of the active region.

**Scraper implementation status**: 関東 only as of this writing. 北海道 / 近畿 / 中国 / 九州 / 沖縄 are surfaced in the dropdown but `Update Now` returns a "scraper not yet implemented" error for those regions — they'll be added in follow-up commits as each 総通局's HTML is parsed and lint-validated. Until then, use `manualStations` for non-関東 broadcasters.

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
   
   Station names use each broadcaster's own branding — Latin for stations that promote a Latin brand (`NACK5`, `J-WAVE`, `TOKYO FM`, …) and Kanji/Kana for the rest (`TBSラジオ`, `文化放送`, `NHKラジオ第1`, …). On-device the Stream Deck app renders Kanji through Core Text's Hiragino fallback; the dump pipeline (rsvg-convert + fontconfig) needs Hiragino or Noto Sans CJK installed for `scripts/dump-lcd.sh` to render Kanji rather than tofu (`fc-list :lang=ja` confirms availability). Match tolerance: ±50 kHz on FM (adjacent stations are 100 kHz apart), ±4 kHz on MW (9 kHz grid).
2. **`com.hogehoge.deck-rx.sdPlugin/data/eibi.txt`** — the EIBI shortwave broadcaster schedule (`http://eibispace.de/dx/eibi.txt`, ISO-8859-1 source converted to UTF-8 in-place). ATS-Mini ships the same database; the parser here mirrors `EIBI.cpp`'s fixed-width columns (`%14c%9c%11c%24c` for freq / time / days+ITU / station). Only consulted for 16 kHz – 30 MHz (LF/MF/HF range covered by EIBI). Refresh seasonally (March / October — EIBI's "A" / "B" seasons) from the **Tune dial Property Inspector**: an `EIBI: [Update Now]` button fetches the upstream file, decodes ISO-8859-1 → UTF-8, parses-validates (≥ 1000 entries) and atomically replaces `data/eibi.txt`. The previous file is preserved as `eibi.txt.YYYY-MM-DD-HHMMSS`. The PI status line shows `Last update: YYYY-MM-DD  /  N entries` (sourced from file mtime + parsed-entry count) on open and after each update. Equivalent manual flow if the button is unusable: `curl -fsSL http://eibispace.de/dx/eibi.txt | iconv -f ISO-8859-1 -t UTF-8 > com.hogehoge.deck-rx.sdPlugin/data/eibi.txt`.

EIBI lookup adds two filters that ATS-Mini's reference parser omits:

- **Day-of-week filter**. The Days column (`Mo-Fr`, `SaSu`, `Su-Th`, `4May`, `1.Sa`, digit-strings like `157`) is parsed and only entries valid for the current UTC weekday / date apply. Without this, e.g. 6115 kHz on a Wednesday would surface `Radio SE-TA2` (whose entries are `4May` and `SaSu`) instead of `Radio Nikkei 2` (`Mo-Fr`).
- **Spurious-emission drop**. EIBI tracks parasitic transmissions (intermod products / harmonics) with the `spur` flag — those are reference data, not actual broadcasts, and would show up as misleading "station names" if kept. They're filtered at parse time.

When multiple EIBI entries are simultaneously active at the same kHz, the **shortest time window** wins on the assumption that a narrowly programmed slot is more specific than a day-long allocation. When no real broadcaster matches (Mo-Fr-only window past its end, only-spur entries on the freq, etc.), the lookup returns null and the dial header falls back to the user's preset name.

The Tune dial header has a fixed 200 px width and reserves 49 px on the right when the FM stereo lock badge is shown, leaving only 151 px for the label. To accommodate longer station names (e.g. `WFM ニッポン放送` with the STEREO badge, or `VFO CNR 2 China Business R.` from EIBI), `makeHeaderSvg` adapts in three steps: (1) keep the original 14 px monospace size if the natural width fits; (2) drop to 12 px when 14 px overflows but 12 px would fit; (3) at 12 px combined with SVG `textLength` + `lengthAdjust="spacingAndGlyphs"` for horizontal squeeze when even 12 px still overflows. The natural-width estimate uses a CJK-aware char count (`effectiveCharCount`) that weights full-width characters (CJK ideographs, hiragana, full-width katakana, fullwidth ASCII) at 1.7× a Menlo half-width column to match how Hiragino fallback renders them; without this, a label like `WFM ニッポン放送` was under-measured and the STEREO badge slot collided with the trailing 「送」. The mechanism lives entirely in the rendering function so it applies uniformly to JP-DB, EIBI, and preset-name labels.
