# tokubai-mcp

トクバイの店舗検索とチラシ情報を提供する、Cloudflare Workers 向けの MCP サーバーです。

> [!WARNING]
> 認証は実装していません。このまま公開すると、誰でも MCP エンドポイントを自由に呼び出せます。
> 公開する場合は、必ず認証を追加して利用者を制限してください。

## 起動

Node.js 24 以降と pnpm を使用します。

```sh
pnpm install
pnpm dev
```

MCP クライアントの Streamable HTTP 接続先に `http://localhost:8787/mcp` を指定してください。

## 検証とビルド

```sh
pnpm check
pnpm build
```

通常のテストは外部通信を行いません。

起動中のサーバー経由で実サイトを確認する場合:

```sh
pnpm test:live
# 接続先を変更する場合
pnpm test:live https://your-worker.example/mcp
```

`test:live` は実サイトへの通信を伴います。

## デプロイ

Cloudflare アカウントを用意し、認証を追加したうえで実行してください。

```sh
pnpm deploy
```
