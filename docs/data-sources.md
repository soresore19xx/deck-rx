# Data sources & attribution

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

## Refresh / re-fetch scripts

データ更新時は以下のスクリプトで再取得できます (rate-limit 1 req/sec):

```sh
npx tsx scripts/fetch-callsigns.ts             # AM + FM 全件 sweep (~50 分)
npx tsx scripts/fetch-callsigns.ts --validate  # AM 1 page (smoke test, ~2 分)
npx tsx scripts/fetch-callsigns-supplement.ts  # 主要法人 NA= 補完 fetch (~20 分)
npx tsx scripts/fetch-callsigns-50on.ts        # 50 音 brute sweep (~70 分)
```

**通常運用は `fetch-callsigns.ts` (全件) + `fetch-callsigns-supplement.ts` (補完)
の組合せで OK**。 default の SelectHSK=04 検索は 中央放送局 (TOKYO FM JOAU-FM
/ J-WAVE JOAV-FM 等) を暗黙除外するため、 supplement の `NA=法人名` keyword
検索で補完が必要。 supplement の `FM_KEYWORDS` / `AM_KEYWORDS` 配列に法人名
を追記すれば任意の局を補足できる:

```ts
// scripts/fetch-callsigns-supplement.ts
const FM_KEYWORDS = [
  '株式会社エフエム東京',         // TOKYO FM JOAU-FM
  '株式会社Ｊ－ＷＡＶＥ',         // J-WAVE JOAV-FM
  '日本放送協会',                 // NHK FM 全国
  // ↓ 追加例: 「FM横浜の中継局を取りたい」 等
  // '横浜エフエム放送株式会社',
];
```

`fetch-callsigns-50on.ts` は 78 keyword × 2 band の brute force 経路。 70 分
かかる代わりに supplement で漏れた regional 親局 (FM大阪 / FM群馬 / FM京都
等) を網羅的に拾える。 通常は不要だが、 「絶対漏らしたくない」 用途のとき。

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
