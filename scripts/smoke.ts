import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { flyersResultSchema, searchResultSchema } from "../src/schemas.ts";

const client = new Client({ name: "tokubai-live-smoke", version: "1.0.0" });
const endpoint = new URL(process.argv[2] ?? "http://localhost:8787/mcp");
await client.connect(new StreamableHTTPClientTransport(endpoint));
try {
  assert.equal((await client.listTools()).tools.length, 4);
  for (const [name, args] of [
    ["search_stores_by_postal_code", { postal_code: "160-0022" }],
    ["search_stores_by_prefecture", { prefecture: "東京", page: 2 }],
    ["search_stores", { region: "新宿", store_name: "ライフ" }],
  ] as const) {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    const data = searchResultSchema.parse(result.structuredContent);
    assert.equal(data.status, "ok");
    assert.ok(data.stores.length > 0);
    console.log(
      JSON.stringify({
        tool: name,
        stores: data.returned_count,
        total: data.total_count,
        page: data.page,
        next_page: data.next_page,
        first: data.stores[0]?.name,
      }),
    );
  }
  const result = await client.callTool({
    name: "get_store_flyers",
    arguments: { store_id: "2357" },
  });
  assert.ok(!result.isError, JSON.stringify(result));
  const data = flyersResultSchema.parse(result.structuredContent);
  assert.ok(data.flyers.length > 0);
  assert.ok(data.flyers.every((f) => f.period.starts_on && f.period.ends_on));
  console.log(
    JSON.stringify({
      tool: "get_store_flyers",
      store: data.store.name,
      flyers: data.flyers.length,
      first: data.flyers[0],
    }),
  );
  const missing = await client.callTool({
    name: "search_stores_by_postal_code",
    arguments: { postal_code: "000-0000" },
  });
  assert.equal(searchResultSchema.parse(missing.structuredContent).status, "postal_code_not_found");
  const empty = await client.callTool({
    name: "search_stores",
    arguments: { store_name: "zzzznosuchstore13489" },
  });
  assert.deepEqual(searchResultSchema.parse(empty.structuredContent).stores, []);
  console.log("Live MCP smoke passed (4 tools, pagination, invalid postal code and no results).");
} finally {
  await client.close();
}
