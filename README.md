# tokubai-mcp

トクバイの店舗検索とチラシ情報を提供する、Cloudflare Workers 向けの MCP サーバーです。Hono、`@hono/mcp`、MCP SDK を使い、SSR HTML を `cheerio/slim` で解析します。

## 起動

Node.js 24 以降と pnpm を使用します。

```sh
pnpm install
pnpm dev
```

MCP クライアントの Streamable HTTP 接続先に `http://localhost:8787/mcp` を指定してください。JSON レスポンスを返すステートレス構成です。セッション ID は不要で、GET による常時 SSE 接続は使いません。

## ツール

| ツール                         | 入力例                                              | 内容                                                  |
| ------------------------------ | --------------------------------------------------- | ----------------------------------------------------- |
| `search_stores_by_postal_code` | `{"postal_code":"160-0022"}`                        | 郵便番号から業種別のおすすめ店舗を取得                |
| `search_stores_by_prefecture`  | `{"prefecture":"東京都","page":1}`                  | 都道府県内の店舗を検索。名前・省略名・ID 1〜47 に対応 |
| `search_stores`                | `{"region":"新宿","store_name":"ライフ","page":1}`  | 地域とチェーン名・店名で検索。片方だけでも利用可能    |
| `get_store_flyers`             | `{"store_url":"https://tokubai.co.jp/ライフ/2357"}` | 店舗のチラシタイトル、画像 URL、対象期間を取得        |

`get_store_flyers` は `{"store_id":"2357"}` でも呼び出せます。`store_url` と `store_id` は一方だけを指定してください。

検索結果には `stores`、サイト表示の `total_count`、取得件数 `returned_count`、`page`、`next_page`、`next_page_url`、取得元 `source_url`、取得日時 `fetched_at` を含みます。次ページがある場合は `next_page` を同じツールの `page` に指定します。郵便番号検索はページングのないおすすめ一覧のため、`total_count` は null です。

店舗の `location` はサイト表示の住所または最寄駅です。郵便番号検索で返す `/shops/{id}` はトクバイが店舗の正規 URL に転送し、そのままチラシ取得にも使用できます。

地域が曖昧な場合は `status: "ambiguous_region"` と `region_candidates` を返します。選択した候補の `type` と `id` を使って再検索してください。

```json
{
  "region_target": { "type": "area", "id": "177" },
  "store_name": "ライフ"
}
```

地域候補がない場合は `region_not_found`、該当する郵便番号を確認できない場合は `postal_code_not_found`。店舗の検索結果が0件なら `status: "ok"` かつ空の `stores` を返します。

チラシの返却例（抜粋）:

```json
{
  "id": "108392682",
  "title": "11月ぶっとおし！超特価で家計応援",
  "url": "https://tokubai.co.jp/ライフ/2357/leaflets/108392682",
  "image_url": "https://image.tokubai.co.jp/images/bargain_office_leaflets/o=true/9840753.jpg?1794014222",
  "period": {
    "text": "2026年11月7日〜30日まで",
    "starts_on": "2026-11-07",
    "ends_on": "2026-11-30"
  }
}
```

期間は日本のカレンダー日付です。元の期間表記も保持し、日付を解釈できない場合は null を返します。店舗トップの更新日を対象期間として扱いません。同じタイトルのチラシは ID ごとに返し、未掲載なら `flyers: []` です。画像は URL を返し、画像ファイルはダウンロードしません。

## 検証とビルド

```sh
pnpm check
pnpm build
```

通常のテストは保存した実 HTML と HTTP モックを使い、外部通信を行いません。公式 MCP クライアントによる初期化・ツール呼び出し・複数クライアントの同時利用も検証します。

起動中のサーバー経由で実サイトを確認する場合:

```sh
pnpm test:live
# 接続先を変更する場合
pnpm test:live https://your-worker.example/mcp
```

`test:live` は掲載内容が変わる実サイトへの通信を伴います。`pnpm deploy` で Workers にデプロイできます。

## 取得仕様

外部リクエストは15秒、応答は5 MiB、転送は5回を上限とし、転送先も `https://tokubai.co.jp` に限定します。取得失敗は MCP の `isError: true` とエラーコードを返します。認識できない DOM は `PARSE_ERROR` とし、検索結果0件と区別します。

2026-11-07 に確認した URL・フォームパラメータ・DOM セレクタ・調査結果は [取得仕様](docs/research/spec.md) に記載しています。サイト構造が変わった場合は [パーサー](src/parsers.ts) と検証用 HTML を更新してください。
