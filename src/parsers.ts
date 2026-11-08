import { load } from "cheerio/slim";
import { z } from "zod";
import { TOKUBAI_ORIGIN, TokubaiError, tokubaiUrl } from "./http.ts";
import type { Flyer, SearchResult, Store } from "./schemas.ts";

export const cleanText = (text: string): string => text.replace(/\s+/g, " ").trim();
const nullableText = (text: string): string | null => cleanText(text) || null;
const parseError = (message: string): never => {
  throw new TokubaiError("PARSE_ERROR", message);
};

export function storeId(url: URL): string {
  const match = url.pathname.match(/^\/(?:[^/]+\/)?(\d+)\/?$/);
  if (!match)
    throw new TokubaiError("INVALID_INPUT", "店舗トップページの URL を指定してください。");
  return match[1]!;
}

export function parseSearchPage(
  html: string,
  sourceUrl: string,
  page: number,
  postalCodeSearch = false,
): SearchResult {
  const $ = load(html);
  const stores = new Map<string, Store>();
  const cards = $("a.shop_index_card");
  cards.each((_, node) => {
    const card = $(node);
    const href = card.attr("href");
    const name = cleanText(card.find(".name_text").text());
    if (!href || !name) parseError("店舗カードの店舗名または URL を読み取れませんでした。");
    const url = tokubaiUrl(href!, sourceUrl);
    const id = storeId(url);
    stores.set(id, {
      id,
      name,
      url: url.href,
      location: nullableText(card.find(".location_text").text()),
      opening_hours: nullableText(
        card
          .find(".opening_hour_text")
          .text()
          .replace(/^\s*営業時間\s*[:：]?\s*/, ""),
      ),
      category: null,
    });
  });
  $(".shops_with_business_category .shop").each((_, node) => {
    const card = $(node);
    const id = card.attr("id")?.match(/^shop_(\d+)$/)?.[1];
    const name = cleanText(card.find(".shop_name").text());
    if (!id || !name) parseError("郵便番号の検索結果を読み取れませんでした。");
    stores.set(id!, {
      id: id!,
      name,
      url: `${TOKUBAI_ORIGIN}/shops/${id}`,
      location: nullableText(card.find(".address").text()),
      opening_hours: null,
      category: nullableText(
        card
          .closest(".shops_with_business_category")
          .find(".business_category_name")
          .first()
          .text(),
      ),
    });
  });
  const countText = cleanText($(".shop_count .num").first().text()).replaceAll(",", "");
  const total = /^\d+$/.test(countText) ? Number(countText) : null;
  const postalMissing = postalCodeSearch && new URL(sourceUrl).pathname === "/search_index";
  if (!stores.size && !$(".no_shops").length && total !== 0 && !postalMissing) {
    parseError("検索結果の DOM を認識できませんでした。サイト構造が変更された可能性があります。");
  }
  const nextHref = $(".pagination a[rel~=next]").first().attr("href");
  const nextUrl = nextHref ? tokubaiUrl(nextHref, sourceUrl) : null;
  const nextPage = nextUrl ? Number(nextUrl.searchParams.get("page")) : null;
  if (nextUrl && (!nextPage || !Number.isInteger(nextPage) || nextPage <= page)) {
    parseError("次ページの情報を読み取れませんでした。");
  }
  return {
    status: postalMissing ? "postal_code_not_found" : "ok",
    source_url: sourceUrl,
    fetched_at: new Date().toISOString(),
    stores: [...stores.values()],
    returned_count: stores.size,
    total_count: total,
    page,
    next_page: nextPage,
    next_page_url: nextUrl?.href ?? null,
    region_candidates: [],
  };
}

export function parseStorePage(
  html: string,
  sourceUrl: string,
): { store: Store; viewer_url: string | null } {
  const $ = load(html);
  const header = $("#shop_header");
  const name = cleanText(header.find("a.shop_name").first().text());
  if (!name) parseError("店舗ページの DOM を認識できませんでした。");
  const url = tokubaiUrl(sourceUrl);
  url.search = "";
  url.pathname = url.pathname.replace(/\/$/, "");
  const id = storeId(url);
  const viewerHref = $("#leaflet a.image_element[href*='/leaflets/']").first().attr("href");
  const viewer = viewerHref ? tokubaiUrl(viewerHref, url.href) : null;
  if (viewer && !viewer.pathname.startsWith(`${url.pathname}/leaflets/`)) {
    parseError("対象店舗とチラシの URL が一致しません。");
  }
  return {
    store: {
      id,
      name,
      url: url.href,
      location: nullableText(header.find(".address").first().text()),
      opening_hours: nullableText(
        header
          .find(".opening_hour")
          .first()
          .text()
          .replace(/^\s*営業時間\s*/, ""),
      ),
      category: null,
    },
    viewer_url: viewer?.href ?? null,
  };
}

function isoDate(year: number, month: number, day: number): string | null {
  const value = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

export function parsePeriod(text: string): Flyer["period"] {
  text = cleanText(text);
  const match = text.match(
    /(\d{4})年(\d{1,2})月(\d{1,2})日\s*[〜～~－-]\s*(?:(\d{4})年)?(?:(\d{1,2})月)?(\d{1,2})日/,
  );
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const endMonth = Number(match[5] ?? month);
    const endYear = Number(match[4] ?? year + (endMonth < month ? 1 : 0));
    const start = isoDate(year, month, Number(match[3]));
    const end = isoDate(endYear, endMonth, Number(match[6]));
    return { text, starts_on: start, ends_on: start && end && end >= start ? end : null };
  }
  const single = text.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日(?:限り|のみ|まで)?$/);
  const day = single ? isoDate(Number(single[1]), Number(single[2]), Number(single[3])) : null;
  return { text, starts_on: day, ends_on: day };
}

const viewerStateSchema = z.object({
  leaflets: z
    .array(
      z.object({
        id: z.number().int().positive(),
        high_resolution_image_url: z.url(),
        url: z.string(),
      }),
    )
    .min(1),
});

function imageUrl(value: string): string {
  const url = new URL(value, TOKUBAI_ORIGIN);
  if (url.protocol !== "https:" || url.username || url.password) {
    return parseError("チラシの画像 URL が不正です。");
  }
  return url.href;
}

export function parseViewerPage(html: string, sourceUrl: string): Flyer[] {
  const $ = load(html);
  let raw: unknown;
  try {
    raw = JSON.parse($("[data-view-state]").first().attr("data-view-state") ?? "");
  } catch {
    return parseError("チラシ viewer の埋め込みデータを読み取れませんでした。");
  }
  const result = viewerStateSchema.safeParse(raw);
  if (!result.success) return parseError("チラシ viewer のデータ構造が変更されています。");
  const seen = new Set<string>();
  return result.data.leaflets.map((leaflet) => {
    const id = String(leaflet.id);
    if (seen.has(id)) return parseError("チラシ ID が重複しています。");
    seen.add(id);
    const card = $(".other_leaflet_link")
      .filter((_, e) => $(e).attr("data-leaflet-id") === id)
      .first();
    const title = cleanText(card.find(".container_title").text());
    const period = cleanText(card.find(".container_description").text());
    if (!title || !period)
      return parseError(`チラシ ${id} のタイトルまたは対象期間を読み取れませんでした。`);
    const url = tokubaiUrl(leaflet.url, sourceUrl);
    const sourcePath = new URL(sourceUrl).pathname.replace(/\/leaflets\/\d+\/?$/, "");
    if (url.pathname !== `${sourcePath}/leaflets/${id}`)
      return parseError("チラシの店舗 ID が一致しません。");
    url.search = "";
    const thumbnail = card.find("img").attr("data-src") || card.find("img").attr("src");
    return {
      id,
      title,
      url: url.href,
      image_url: imageUrl(leaflet.high_resolution_image_url),
      thumbnail_url: thumbnail ? imageUrl(thumbnail) : null,
      period: parsePeriod(period),
    };
  });
}
