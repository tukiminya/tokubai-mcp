import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/index.ts";
import { HtmlClient } from "../src/http.ts";
import { TokubaiClient } from "../src/tokubai.ts";
import { flyersResultSchema, searchResultSchema } from "../src/schemas.ts";

const app = createApp(
  new TokubaiClient(
    new HtmlClient({
      fetcher: async (input) => {
        const url = new URL(String(input));
        if (url.searchParams.get("zip_code") === "9999999")
          return new Response(null, { status: 503 });
        const name =
          url.pathname === "/recommend"
            ? "postal"
            : url.pathname.includes("/leaflets/")
              ? "viewer"
              : "shop";
        return new Response(
          readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), "utf8"),
          { headers: { "content-type": "text/html" } },
        );
      },
    }),
  ),
);

async function connect() {
  const client = new Client({ name: "tokubai-mcp-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    fetch: async (input, init) =>
      app.request(input instanceof Request ? input : String(input), init),
  });
  await client.connect(transport);
  return client;
}

test("official MCP client initializes, discovers four tools, and receives validated structured results", async () => {
  const client = await connect();
  try {
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((t) => t.name).sort(), [
      "get_store_flyers",
      "search_stores",
      "search_stores_by_postal_code",
      "search_stores_by_prefecture",
    ]);
    assert.ok(tools.tools.every((t) => t.outputSchema && t.annotations?.readOnlyHint));
    const result = await client.callTool({
      name: "get_store_flyers",
      arguments: { store_url: "https://tokubai.co.jp/ライフ/2357" },
    });
    assert.equal(result.isError, undefined);
    assert.equal(flyersResultSchema.parse(result.structuredContent).flyers.length, 11);
    assert.deepEqual(
      JSON.parse((result.content as { text: string }[])[0]!.text),
      result.structuredContent,
    );
  } finally {
    await client.close();
  }
});

test("independent concurrent clients may reuse JSON-RPC IDs without sharing results", async () => {
  const clients = await Promise.all([connect(), connect()]);
  try {
    const results = await Promise.all(
      clients.map((client) =>
        client.callTool({
          name: "search_stores_by_postal_code",
          arguments: { postal_code: "160-0022" },
        }),
      ),
    );
    assert.ok(
      results.every((r) => searchResultSchema.parse(r.structuredContent).returned_count === 2),
    );
  } finally {
    await Promise.all(clients.map((c) => c.close()));
  }
});

test("returns MCP tool errors for invalid inputs and upstream failures", async () => {
  const client = await connect();
  try {
    const badInput = await client.callTool({
      name: "search_stores_by_postal_code",
      arguments: { postal_code: "abc" },
    });
    assert.equal(badInput.isError, true);
    const upstream = await client.callTool({
      name: "search_stores_by_postal_code",
      arguments: { postal_code: "9999999" },
    });
    assert.equal(upstream.isError, true);
    assert.match((upstream.content as { text: string }[])[0]!.text, /UPSTREAM_ERROR/);
  } finally {
    await client.close();
  }
});

test("stateless endpoint rejects GET and DELETE and exposes a health response", async () => {
  assert.equal((await app.request("/mcp")).status, 405);
  assert.equal((await app.request("/mcp", { method: "DELETE" })).status, 405);
  assert.equal((await app.request("/")).status, 200);
});
