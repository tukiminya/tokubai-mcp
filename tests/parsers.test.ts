import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parsePeriod, parseSearchPage, parseStorePage, parseViewerPage } from "../src/parsers.ts";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), "utf8");
const storeUrl = "https://tokubai.co.jp/%E3%83%A9%E3%82%A4%E3%83%95/2357";

test("extracts postal recommendations with IDs, addresses, categories and usable store URLs", () => {
  const result = parseSearchPage(
    fixture("postal"),
    "https://tokubai.co.jp/recommend?zip_code=1600022",
    1,
  );
  assert.equal(result.stores.length, 2);
  assert.deepEqual(result.stores[0], {
    id: "10755",
    name: "三平ストア 新宿店",
    url: "https://tokubai.co.jp/shops/10755",
    location: "東京都新宿区新宿3-22-12新宿サンパークビル地下1階(100円ショップ)、地下2階(スーパー)",
    opening_hours: null,
    category: "スーパー・食料品店",
  });
  assert.equal(result.total_count, null);
  assert.equal(result.next_page_url, null);
});

test("extracts prefecture cards, upstream total and relative pagination", () => {
  const result = parseSearchPage(fixture("prefecture"), "https://tokubai.co.jp/prefectures/13", 1);
  assert.equal(result.total_count, 33830);
  assert.equal(result.next_page, 2);
  assert.equal(result.next_page_url, "https://tokubai.co.jp/prefectures/13?page=2");
  assert.equal(result.stores[0]?.opening_hours, "8:00〜18:45");
  assert.equal(result.stores[0]?.location, "都庁前駅から約100m");
});

test("recognizes explicit no results and missing postal codes", () => {
  const empty = parseSearchPage(fixture("empty"), "https://tokubai.co.jp/shop_search_results", 1);
  assert.equal(empty.status, "ok");
  assert.equal(empty.total_count, 0);
  assert.deepEqual(empty.stores, []);
  assert.equal(
    parseSearchPage("<h1>検索</h1>", "https://tokubai.co.jp/search_index", 1, true).status,
    "postal_code_not_found",
  );
});

test("does not turn unrecognized pages or broken cards into empty results", () => {
  assert.throws(
    () =>
      parseSearchPage("<h1>Service unavailable</h1>", "https://tokubai.co.jp/prefectures/13", 1),
    { code: "PARSE_ERROR" },
  );
  assert.throws(() => parseSearchPage("<h1>検索</h1>", "https://tokubai.co.jp/search_index", 1), {
    code: "PARSE_ERROR",
  });
  assert.throws(
    () =>
      parseSearchPage(
        '<a class="shop_index_card" href="/ライフ/2357"></a>',
        "https://tokubai.co.jp/prefectures/13",
        1,
      ),
    { code: "PARSE_ERROR" },
  );
});

test("store page selects its own leaflet and ignores other nearby stores", () => {
  const result = parseStorePage(fixture("shop"), storeUrl);
  assert.equal(result.store.id, "2357");
  assert.equal(result.store.name, "ライフ 太平寺店");
  assert.equal(result.viewer_url, `${storeUrl}/leaflets/108392682`);
  const none = parseStorePage(fixture("no-flyers"), "https://tokubai.co.jp/Ash/269564");
  assert.equal(none.store.name, "Ash 中野店");
  assert.equal(none.viewer_url, null);
});

test("joins all 11 flyer titles, full-resolution images and periods by leaflet ID", () => {
  const flyers = parseViewerPage(fixture("viewer"), `${storeUrl}/leaflets/108392682`);
  assert.equal(flyers.length, 11);
  assert.deepEqual(flyers[0], {
    id: "108392682",
    title: "11月ぶっとおし！超特価で家計応援",
    url: `${storeUrl}/leaflets/108392682`,
    image_url:
      "https://image.tokubai.co.jp/images/bargain_office_leaflets/o=true/9840753.jpg?1794014222",
    thumbnail_url:
      "https://image.tokubai.co.jp/images/bargain_office_leaflets/w=180,h=135,c=true/9840753.jpg?1794014222",
    period: { text: "2026年11月7日〜30日まで", starts_on: "2026-11-07", ends_on: "2026-11-30" },
  });
  assert.equal(flyers[2]?.title, flyers[3]?.title);
  assert.notEqual(flyers[2]?.id, flyers[3]?.id);
  assert.notEqual(flyers[2]?.image_url, flyers[3]?.image_url);
  assert.equal(flyers.at(-1)?.period.ends_on, "2027-02-28");
  assert.throws(() => parseViewerPage("<html></html>", `${storeUrl}/leaflets/108392682`), {
    code: "PARSE_ERROR",
  });
});

test("normalizes same-month, cross-month and cross-year periods without using the update date", () => {
  assert.equal(parsePeriod("2026年10月31日〜11月15日まで").ends_on, "2026-11-15");
  assert.equal(parsePeriod("2026年12月31日〜1月2日まで").ends_on, "2027-01-02");
  assert.equal(parsePeriod("2026年11月7日限り").starts_on, "2026-11-07");
  assert.equal(parsePeriod("11月07日更新").starts_on, null);
  assert.equal(parsePeriod("2026年2月30日〜31日まで").starts_on, null);
  assert.deepEqual(parsePeriod("期間未定"), { text: "期間未定", starts_on: null, ends_on: null });
});
