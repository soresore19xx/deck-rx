# Data sources & attribution

The auto station-name lookup combines several public broadcast databases.
All upstream data is used under its own terms; deck-rx redistributes the
station list and callsign DB under the attributions below.

| Source | Coverage | License / Terms |
|---|---|---|
| EIBI SW DB (http://eibispace.de/) | International shortwave broadcasts (day / time / spur-aware) | EIBI license (publicly accessible, attribution requested) |
| 関東総合通信局 ラジオ放送事業者一覧 | 1都7県 (東京・神奈川・千葉・埼玉・茨城・栃木・群馬・山梨) AM 親局 + 中継局 + FM 補完 + 超短波 + コミュニティ放送 | 公共データ利用規約 第1.0版 |
| 沖縄総合通信局 ラジオ周波数一覧 | 沖縄県 AM/FM/CFM | 公共データ利用規約 第1.0版 |
| 総務省 全国民放FM局・ワイドFM局一覧 | 北海道・東北・東海・近畿・中国・九州 民放 FM | 公共データ利用規約 第1.0版 |
| **総務省 無線局等情報検索** (https://www.tele.soumu.go.jp/musen/) | **callsign (識別信号) DB across all licensed broadcast transmitters** | **公共データ利用規約 第1.0版** |

The 公共データ利用規約 第1.0版 (Public Data License 1.0,
https://www.soumu.go.jp/menu_kyotsuu/policy/tyosaku.html) allows
redistribution, commercial use included, provided the source is credited and
any editing is stated. `com.hogehoge.deck-rx.sdPlugin/data/jp-stations.json`
and `callsigns.json` in this repository are edited as follows, under that
licence:

- corporate names shortened to the brand in common use (the legal "株式会社…"
  form → the short form or kana spelling)
- frequencies normalised to integer Hz
- the transmitter-site / municipality cell split out into a `siteName` field
- masks (`*****`) and `<BR>` around the callsign removed, leaving the callsign
  alone

## Refresh / re-fetch scripts

To refresh the dataset, run one of the following scripts (rate-limited to 1 req/sec):

```sh
npx tsx scripts/fetch-callsigns.ts             # AM + FM full sweep (~50 min)
npx tsx scripts/fetch-callsigns.ts --validate  # AM 1 page (smoke test, ~2 min)
npx tsx scripts/fetch-callsigns-supplement.ts  # NA= keyword fill for major operators (~20 min)
npx tsx scripts/fetch-callsigns-50on.ts        # 50-on brute sweep (~70 min)
```

**Typical operation: `fetch-callsigns.ts` (full sweep) + `fetch-callsigns-supplement.ts`
(supplemental fill) is enough.** The default `SelectHSK=04` query at the MIC search
endpoint omits the central broadcast stations (TOKYO FM JOAU-FM, J-WAVE JOAV-FM,
etc.), so the supplement script back-fills them via `NA=<corporate name>` keyword
searches. Append additional corporate names to the supplement's `FM_KEYWORDS` /
`AM_KEYWORDS` arrays to cover any station you want included (entries are Japanese
broadcaster legal names — Japan-only context):

```ts
// scripts/fetch-callsigns-supplement.ts
const FM_KEYWORDS = [
  '株式会社エフエム東京',         // TOKYO FM JOAU-FM
  '株式会社Ｊ－ＷＡＶＥ',         // J-WAVE JOAV-FM
  '日本放送協会',                 // NHK FM (nationwide)
  // ↓ Add additional entries if needed, e.g. to pull in regional Yokohama FM relays:
  // '横浜エフエム放送株式会社',
];
```

`fetch-callsigns-50on.ts` is a 78-keyword × 2-band brute-force sweep. It takes
~70 min but exhaustively catches regional flagship stations the supplement may
miss (FM大阪 / FM群馬 / FM京都, etc.). Normally not needed; reserve for the
"absolutely don't miss anything" case.

`scripts/diff-callsigns.ts` shows what changed since the previous fetch (new
licences, closures, changes of site or operator name):

```sh
cp com.hogehoge.deck-rx.sdPlugin/data/callsigns.json{,.old}
npx tsx scripts/fetch-callsigns.ts
npx tsx scripts/diff-callsigns.ts \
    com.hogehoge.deck-rx.sdPlugin/data/callsigns.json.old \
    com.hogehoge.deck-rx.sdPlugin/data/callsigns.json
# if the changes look right, delete .old and commit; to roll back part of it, edit by hand
```
