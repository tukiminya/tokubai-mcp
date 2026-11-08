import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { TokubaiError } from "./http.ts";
import { TokubaiClient } from "./tokubai.ts";
import {
  flyersInputSchema,
  flyersResultSchema,
  postalInputSchema,
  prefectureInputSchema,
  searchInputSchema,
  searchResultSchema,
} from "./schemas.ts";

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

async function toolResult(operation: () => Promise<object>): Promise<CallToolResult> {
  try {
    const data = await operation();
    return {
      content: [{ type: "text", text: JSON.stringify(data) }],
      structuredContent: { ...data },
    };
  } catch (error) {
    const code =
      error instanceof TokubaiError
        ? error.code
        : error instanceof z.ZodError
          ? "INVALID_INPUT"
          : "INTERNAL_ERROR";
    const message =
      error instanceof TokubaiError
        ? error.message
        : error instanceof z.ZodError
          ? "入力内容を確認してください。"
          : "情報の取得中にエラーが発生しました。";
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }],
    };
  }
}

export function createMcpServer(client = new TokubaiClient()): McpServer {
  const server = new McpServer({ name: "tokubai-mcp", version: "1.0.0" });
  server.registerTool(
    "search_stores_by_postal_code",
    {
      title: "郵便番号からお店を探す",
      description:
        "7桁の郵便番号から近くのおすすめ店舗を取得します。業種別の一覧でページングはありません。店舗 URL は /shops/{id} で、公式サイトが正規 URL に転送します。",
      inputSchema: postalInputSchema,
      outputSchema: searchResultSchema,
      annotations,
    },
    (input, extra) => toolResult(() => client.searchByPostalCode(input, extra.signal)),
  );
  server.registerTool(
    "search_stores_by_prefecture",
    {
      title: "都道府県からお店を探す",
      description:
        "都道府県名または ID から店舗一覧を取得します。次のページは next_page を page に指定します。",
      inputSchema: prefectureInputSchema,
      outputSchema: searchResultSchema,
      annotations,
    },
    (input, extra) => toolResult(() => client.searchByPrefecture(input, extra.signal)),
  );
  server.registerTool(
    "search_stores",
    {
      title: "地域と店名からお店を探す",
      description:
        "地域名とチェーン名・店名を使って店舗を検索します。地域だけ、店名だけでも利用可能です。地域名は公式候補で解決し、複数候補は ambiguous_region と region_candidates を返します。その場合は選んだ候補の type と id を region_target に指定し、region を省略して再検索してください。",
      inputSchema: searchInputSchema,
      outputSchema: searchResultSchema,
      annotations,
    },
    (input, extra) => toolResult(() => client.search(input, extra.signal)),
  );
  server.registerTool(
    "get_store_flyers",
    {
      title: "お店のチラシを取得する",
      description:
        "店舗 URL または店舗 ID から掲載中のチラシを取得します。チラシごとにタイトル、高解像度画像 URL、サムネイル URL、対象期間の原文と日付を返します。同名のチラシも ID ごとに返します。チラシ未掲載なら flyers は空配列です。",
      inputSchema: flyersInputSchema,
      outputSchema: flyersResultSchema,
      annotations,
    },
    (input, extra) => toolResult(() => client.getFlyers(input, extra.signal)),
  );
  return server;
}
