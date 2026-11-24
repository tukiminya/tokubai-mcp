import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { StreamableHTTPTransport } from "@hono/mcp";
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
        if (url.searchParams.get("zip_code") === "9999999") {
          const body = new ReadableStream({
            cancel() {
              throw new Error("response cleanup failure");
            },
          });
          return new Response(body, { status: 503 });
        }
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

async function connect(server = app) {
  const client = new Client({ name: "tokubai-mcp-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    fetch: async (input, init) =>
      server.request(input instanceof Request ? input : String(input), init),
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

test("returns MCP tool errors for invalid inputs and upstream failures", async (t) => {
  const logger = t.mock.method(console, "error", () => {});
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
    assert.equal(logger.mock.callCount(), 1);
    const log = logger.mock.calls[0]!.arguments[0];
    assert.equal(log.annotations.tool, "search_stores_by_postal_code");
    assert.equal(log.annotations.code, "UPSTREAM_ERROR");
    assert.match(log.cause, /HTTP 503/);
    assert.match(log.cause, /response cleanup failure/);
  } finally {
    await client.close();
  }
});

test("logs original fetch and JSON exceptions without returning their details", async (t) => {
  const logger = t.mock.method(console, "error", () => {});
  const client = await connect(
    createApp(
      new TokubaiClient(
        new HtmlClient({
          fetcher: async (input) => {
            if (new URL(String(input)).pathname === "/shop_search_completion_keywords") {
              return new Response("{", { headers: { "content-type": "application/json" } });
            }
            throw new TypeError("socket failure");
          },
        }),
      ),
    ),
  );
  try {
    const network = await client.callTool({
      name: "search_stores_by_postal_code",
      arguments: { postal_code: "160-0022" },
    });
    const response = (network.content as { text: string }[])[0]!.text;
    assert.equal(network.isError, true);
    assert.match(response, /NETWORK_ERROR/);
    assert.doesNotMatch(response, /socket failure/);

    const invalidJson = await client.callTool({
      name: "search_stores",
      arguments: { region: "新宿" },
    });
    assert.equal(invalidJson.isError, true);
    assert.match((invalidJson.content as { text: string }[])[0]!.text, /INVALID_RESPONSE/);

    assert.equal(logger.mock.callCount(), 2);
    const [networkLog, jsonLog] = logger.mock.calls.map((call) => call.arguments[0]);
    assert.equal(networkLog.annotations.code, "NETWORK_ERROR");
    assert.match(networkLog.cause, /TypeError: socket failure\n\s+at /);
    assert.equal(jsonLog.annotations.code, "INVALID_RESPONSE");
    assert.match(jsonLog.cause, /SyntaxError/);
  } finally {
    await client.close();
  }
});

test("logs an unexpected defect and returns a generic MCP tool error", async (t) => {
  const logger = t.mock.method(console, "error", () => {});
  class BrokenClient extends TokubaiClient {
    override searchByPostalCodeEffect(): never {
      throw new Error("unexpected tool failure");
    }
  }
  const client = await connect(createApp(new BrokenClient()));
  try {
    const result = await client.callTool({
      name: "search_stores_by_postal_code",
      arguments: { postal_code: "160-0022" },
    });
    assert.equal(result.isError, true);
    const response = (result.content as { text: string }[])[0]!.text;
    assert.match(response, /INTERNAL_ERROR/);
    assert.doesNotMatch(response, /unexpected tool failure/);
    assert.equal(logger.mock.callCount(), 1);
    const log = logger.mock.calls[0]!.arguments[0];
    assert.equal(log.annotations.code, "INTERNAL_ERROR");
    assert.match(log.cause, /Error: unexpected tool failure\n\s+at /);
  } finally {
    await client.close();
  }
});

test("logs both transport setup and cleanup exceptions", async (t) => {
  const logger = t.mock.method(console, "error", () => {});
  t.mock.method(StreamableHTTPTransport.prototype, "start", async () => {
    throw new Error("transport start failure");
  });
  t.mock.method(StreamableHTTPTransport.prototype, "close", async () => {
    throw new Error("transport close failure");
  });
  const response = await app.request("/mcp", { method: "POST" });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    jsonrpc: "2.0",
    id: null,
    error: { code: -32603, message: "Internal error" },
  });
  assert.equal(logger.mock.callCount(), 2);
  const [cleanup, request] = logger.mock.calls.map((call) => call.arguments[0]);
  assert.match(cleanup.cause, /transport close failure/);
  assert.match(request.cause, /transport start failure/);
});

test("stateless endpoint rejects GET and DELETE and exposes a health response", async () => {
  assert.equal((await app.request("/mcp")).status, 405);
  assert.equal((await app.request("/mcp", { method: "DELETE" })).status, 405);
  assert.equal((await app.request("/")).status, 200);
});
