import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { z } from "zod";
import { HtmlClient } from "../src/http.ts";
import { TokubaiClient } from "../src/tokubai.ts";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), "utf8");
const html = (name: string) =>
  new Response(fixture(name), { headers: { "content-type": "text/html" } });
const region = { category: "area", content: "新宿(東京都)", relation_id: 177, prefecture_id: 13 };

test("region + store name uses the resolved target and free_word_query", async () => {
  const requests: URL[] = [];
  const client = new TokubaiClient(
    new HtmlClient({
      fetcher: async (input) => {
        const url = new URL(String(input));
        requests.push(url);
        return url.pathname === "/shop_search_completion_keywords"
          ? Response.json([region])
          : html("keyword");
      },
    }),
  );
  const result = await client.search({ region: "新宿", store_name: "ライフ" });
  assert.equal(result.total_count, 5);
  assert.equal(requests[0]?.searchParams.get("query_type"), "region");
  assert.equal(requests[1]?.searchParams.get("shop_fetcher[target_type]"), "area");
  assert.equal(requests[1]?.searchParams.get("shop_fetcher[target_id]"), "177");
  assert.equal(requests[1]?.searchParams.get("shop_fetcher[free_word_query]"), "ライフ");
  assert.equal(requests[1]?.searchParams.has("shop_fetcher[query]"), false);
});

test("returns ambiguous regions without silently searching elsewhere", async () => {
  let calls = 0;
  const client = new TokubaiClient(
    new HtmlClient({
      fetcher: async () => {
        calls++;
        return Response.json([
          region,
          { ...region, relation_id: 178, content: "新宿御苑(東京都)" },
        ]);
      },
    }),
  );
  const result = await client.search({ region: "新", store_name: "ライフ" });
  assert.equal(result.status, "ambiguous_region");
  assert.equal(result.region_candidates.length, 2);
  assert.equal(calls, 1);
});

test("handles absent region candidates", async () => {
  const client = new TokubaiClient(new HtmlClient({ fetcher: async () => Response.json([]) }));
  assert.equal((await client.search({ region: "存在しない地域" })).status, "region_not_found");
});

test("supports explicit candidate selection, store-only search and pagination", async () => {
  const requests: URL[] = [];
  const client = new TokubaiClient(
    new HtmlClient({
      fetcher: async (input) => {
        requests.push(new URL(String(input)));
        return html("empty");
      },
    }),
  );
  await client.search({
    region_target: { type: "city", id: "13:新宿区" },
    store_name: "存在しない店舗",
    page: 2,
  });
  assert.equal(requests[0]?.searchParams.get("shop_fetcher[target_id]"), "13:新宿区");
  assert.equal(requests[0]?.searchParams.get("page"), "2");
  await client.search({ store_name: "存在しない店舗" });
  assert.equal(requests[1]?.searchParams.get("shop_fetcher[target_type]"), "all_region");
});

test("accepts hyphenated postal codes and prefecture names", async () => {
  const requests: URL[] = [];
  const client = new TokubaiClient(
    new HtmlClient({
      fetcher: async (input) => {
        const url = new URL(String(input));
        requests.push(url);
        return html(url.pathname === "/recommend" ? "postal" : "prefecture");
      },
    }),
  );
  await client.searchByPostalCode({ postal_code: "160-0022" });
  await client.searchByPrefecture({ prefecture: "東京" });
  assert.equal(requests[0]?.searchParams.get("zip_code"), "1600022");
  assert.equal(requests[1]?.pathname, "/prefectures/13");
});

test("rejects invalid and empty input before making upstream requests", async () => {
  const client = new TokubaiClient(
    new HtmlClient({
      fetcher: async () => {
        throw new Error("must not fetch");
      },
    }),
  );
  await assert.rejects(client.search({}), z.ZodError);
  await assert.rejects(client.searchByPostalCode({ postal_code: "123" }), z.ZodError);
  await assert.rejects(client.searchByPrefecture({ prefecture: "架空県" }), {
    code: "INVALID_INPUT",
  });
  await assert.rejects(client.getFlyers({ store_url: "https://evil.example/ライフ/2357" }), {
    code: "INVALID_INPUT",
  });
  await assert.rejects(
    client.getFlyers({ store_url: "https://tokubai.co.jp/ライフ/2357/leaflets/123" }),
    { code: "INVALID_INPUT" },
  );
});

test("fetches a store and one viewer for all its flyers", async () => {
  const paths: string[] = [];
  const client = new TokubaiClient(
    new HtmlClient({
      fetcher: async (input) => {
        const url = new URL(String(input));
        paths.push(url.pathname);
        return html(url.pathname.includes("/leaflets/") ? "viewer" : "shop");
      },
    }),
  );
  const result = await client.getFlyers({ store_url: "https://tokubai.co.jp/ライフ/2357" });
  assert.equal(result.flyers.length, 11);
  assert.equal(paths.length, 2);
  assert.equal(result.store.name, "ライフ 太平寺店");
});

test("a store without flyers does not trigger viewer fetches", async () => {
  let calls = 0;
  const client = new TokubaiClient(
    new HtmlClient({
      fetcher: async () => {
        calls++;
        return html("no-flyers");
      },
    }),
  );
  const result = await client.getFlyers({ store_url: "https://tokubai.co.jp/Ash/269564" });
  assert.deepEqual(result.flyers, []);
  assert.equal(calls, 1);
});
