# トクバイの取得仕様

確認日: 2026-11-07（日本時間）。GPT-6 Luna サブエージェントに各機能の操作と仕様確認を依頼し、親エージェントが検索の実送信、SSR HTML、viewer データを補足検証した。以下は補足検証を反映した最終仕様。

## 郵便番号

トップのフォームは GET `/recommend_with_zip_code`。ブラウザから `160-0022` を送信すると `/recommend?zip_code=1600022` に遷移する。MCP はこの結果ページを直接取得する。

店舗は `.shops_with_business_category .shop`。名前は `.shop_name`、住所は `.address`、ID は `id="shop_10755"`。業種は親の `.business_category_name`。カード自体に店舗リンクはないが、`/shops/10755` が店舗の正規 URL `/三平ストア/10755` に転送することを確認した。

この一覧は業種別のおすすめ店舗で、全店舗の検索総数ではない。ページングもない。`total_count` は null、`returned_count` は取得できた店舗数を返す。

`0000000` は `/search_index` に転送される。この場合は `postal_code_not_found` を返す。

確認 URL: <https://tokubai.co.jp/recommend?zip_code=1600022>、<https://tokubai.co.jp/recommend?zip_code=0000000>。

## 都道府県

トップの都道府県リンクは `/prefectures/{id}`。ID は北海道=1 から沖縄県=47。東京都=13。都道府県ページ自体に店舗一覧があり、地域リンクへの追加遷移なしで取得できる。

店舗カードは `a.shop_index_card`、名前は `.name_text`、所在地または最寄駅は `.location_text`、営業時間は `.opening_hour_text`。総件数は `.shop_count .num`。次ページは `.pagination a[rel~=next]` の href。例えば `/prefectures/13?page=2`。最寄駅の表示を住所と誤認しないよう、返却フィールドを `location` とした。

確認 URL: <https://tokubai.co.jp/prefectures/13>。

## 地域と店名

トップの `form#shop_filter_form` は GET `/shop_search_results`。店名は **`shop_fetcher[free_word_query]`**。`shop_fetcher[query]` はこの検索では効かず、地域全体の結果になってしまうことを確認した。

地域欄 `shop_fetcher[name]` の文字列だけでは地域が適用されない。公式の候補取得先 `/shop_search_completion_keywords?query=新宿&query_type=region` を使い、候補の `category` と `relation_id` をそれぞれ `shop_fetcher[target_type]` と `shop_fetcher[target_id]` に送る。

候補例: `{ "category": "area", "relation_id": 177, "content": "新宿(東京都)", "prefecture_id": 13 }`。市区町村の ID は `13:新宿区` のような文字列もある。

地域=新宿、店名=ライフの実送信で以下を確認した。

```text
GET /shop_search_results
  ?shop_fetcher[target_type]=area
  &shop_fetcher[target_id]=177
  &shop_fetcher[free_word_query]=ライフ
  &shop_fetcher[content]=shop
  &shop_fetcher[order]=recommended
```

当日の結果は5件。LIXILリフォームショップも含まれるため、サイトの検索結果をそのまま返し、独自の店名一致フィルターは加えない。店名だけなら target_type=all_region。地域だけなら free_word_query を省略する。ページングとカードは都道府県と同じ。該当なしは `.no_shops` と総件数0。

地域の完全一致候補（都道府県を括弧で補った表示名も考慮）が1件なら採用する。曖昧なら候補を返し、呼び出し元が `region_target` で選ぶ。候補がない地域を全国検索に置き換えない。

## チラシ

確認 URL: <https://tokubai.co.jp/ライフ/2357>、<https://tokubai.co.jp/ライフ/2357/leaflets/108392682>。

店舗情報は `#shop_header a.shop_name`、`.address`、`.opening_hour`。当該店舗のチラシリンクは `#leaflet a.image_element[href*='/leaflets/']`。近隣店舗のチラシは対象から外す。

店舗トップのカードの `.description` は「11月07日更新」という更新日で、対象期間ではない。最初のチラシ viewer を1回取得すると、掲載中の全チラシの情報を取得できる。

- `#view_state[data-view-state]` の JSON の `leaflets[]` に `id`、`url`、`high_resolution_image_url` がある。
- `.other_leaflet_link[data-leaflet-id]` の `.container_title` がタイトル、`.container_description` が対象期間、`img` がサムネイル。
- JSON と DOM を leaflet ID で対応付ける。同名の表裏2枚があるため、タイトルによる重複除去はしない。
- 原寸 URL は実データの `https://image.tokubai.co.jp/images/bargain_office_leaflets/o=true/9840753.jpg?...` を使う。サムネイル URL の文字列加工では推測しない。
- 「2026年11月7日〜30日まで」「2026年10月31日〜11月15日まで」「2026年10月31日〜2027年2月28日まで」を確認。原文と ISO 日付を返し、解釈できない日付は null にする。

当日はライフ太平寺店で11枚。チラシ未掲載の実例として <https://tokubai.co.jp/Ash/269564> を確認し、viewer の追加取得なしで空配列を返す。

## 検証用データ

`tests/fixtures/` に上記ページの必要な HTML 断片を保存した。広告・スクリプト・購読フォームなど解析に不要な要素は除去している。`postal.html`、`prefecture.html`、`keyword.html` はカードを一部に絞り、総件数とページングはサイトの表示を残した。`shop.html` と `viewer.html` は全11枚のチラシを残している。
