import assert from "node:assert/strict";
import { test } from "node:test";
import { HtmlClient, TokubaiError, tokubaiUrl } from "../src/http.ts";

test("only permits Tokubai HTTPS URLs", () => {
  for (const url of [
    "http://tokubai.co.jp/",
    "https://evil.example/",
    "https://user:pass@tokubai.co.jp/",
    "//evil.example/",
  ]) {
    assert.throws(() => tokubaiUrl(url), TokubaiError);
  }
  assert.equal(tokubaiUrl("/ライフ/2357").origin, "https://tokubai.co.jp");
});

test("does not fetch an external redirect", async () => {
  let calls = 0;
  const client = new HtmlClient({
    fetcher: async () => {
      calls++;
      return new Response(null, { status: 302, headers: { location: "https://evil.example/" } });
    },
  });
  await assert.rejects(client.get("/"), { code: "INVALID_INPUT" });
  assert.equal(calls, 1);
});

test("follows same-origin redirects and returns the final URL", async () => {
  const client = new HtmlClient({
    fetcher: async (input) => {
      return String(input).endsWith("/before")
        ? new Response(null, { status: 302, headers: { location: "/after" } })
        : new Response("店舗", { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  assert.deepEqual(await client.get("/before"), {
    html: "店舗",
    url: "https://tokubai.co.jp/after",
  });
});

test("rejects oversized chunked HTML", async () => {
  const client = new HtmlClient({
    maxBytes: 3,
    fetcher: async () => new Response("1234", { headers: { "content-type": "text/html" } }),
  });
  await assert.rejects(client.get("/"), { code: "RESPONSE_TOO_LARGE" });
});

test("bounds requests and reports timeout", async () => {
  const client = new HtmlClient({
    timeoutMs: 5,
    fetcher: async (_input, init) => {
      return new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
      );
    },
  });
  await assert.rejects(client.get("/"), { code: "TIMEOUT" });
});

test("distinguishes upstream errors from non-HTML responses", async () => {
  await assert.rejects(
    new HtmlClient({ fetcher: async () => new Response(null, { status: 429 }) }).get("/"),
    { code: "UPSTREAM_ERROR" },
  );
  await assert.rejects(new HtmlClient({ fetcher: async () => Response.json({}) }).get("/"), {
    code: "INVALID_RESPONSE",
  });
});
