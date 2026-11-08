import { z } from "zod";
import { HtmlClient, TOKUBAI_ORIGIN, TokubaiError, tokubaiUrl } from "./http.ts";
import { parseSearchPage, parseStorePage, parseViewerPage, storeId } from "./parsers.ts";
import {
  flyersInputSchema,
  postalInputSchema,
  prefectureInputSchema,
  regionSchema,
  searchInputSchema,
} from "./schemas.ts";
import type { Region, SearchResult } from "./schemas.ts";

const prefectures = [
  "北海道",
  "青森県",
  "岩手県",
  "宮城県",
  "秋田県",
  "山形県",
  "福島県",
  "茨城県",
  "栃木県",
  "群馬県",
  "埼玉県",
  "千葉県",
  "東京都",
  "神奈川県",
  "新潟県",
  "富山県",
  "石川県",
  "福井県",
  "山梨県",
  "長野県",
  "岐阜県",
  "静岡県",
  "愛知県",
  "三重県",
  "滋賀県",
  "京都府",
  "大阪府",
  "兵庫県",
  "奈良県",
  "和歌山県",
  "鳥取県",
  "島根県",
  "岡山県",
  "広島県",
  "山口県",
  "徳島県",
  "香川県",
  "愛媛県",
  "高知県",
  "福岡県",
  "佐賀県",
  "長崎県",
  "熊本県",
  "大分県",
  "宮崎県",
  "鹿児島県",
  "沖縄県",
] as const;

const completionSchema = z.array(
  z.object({
    category: regionSchema.shape.type,
    content: z.string().min(1),
    relation_id: z.union([z.string().min(1), z.number().int().positive()]),
    prefecture_id: regionSchema.shape.prefecture_id,
  }),
);

export class TokubaiClient {
  private readonly http: HtmlClient;

  constructor(http = new HtmlClient()) {
    this.http = http;
  }

  async searchByPostalCode(
    input: z.input<typeof postalInputSchema>,
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    const { postal_code } = postalInputSchema.parse(input);
    const url = new URL("/recommend", TOKUBAI_ORIGIN);
    url.searchParams.set("zip_code", postal_code.replace("-", ""));
    const response = await this.http.get(url, signal);
    return parseSearchPage(response.html, response.url, 1, true);
  }

  async searchByPrefecture(
    input: z.input<typeof prefectureInputSchema>,
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    const { prefecture, page } = prefectureInputSchema.parse(input);
    const id =
      typeof prefecture === "number"
        ? prefecture
        : /^\d{1,2}$/.test(prefecture)
          ? Number(prefecture)
          : prefectures.findIndex(
              (p) => p === prefecture || p.replace(/[都道府県]$/, "") === prefecture,
            ) + 1;
    if (id < 1 || id > 47)
      throw new TokubaiError(
        "INVALID_INPUT",
        "有効な都道府県名または 1〜47 の ID を指定してください。",
      );
    const url = new URL(`/prefectures/${id}`, TOKUBAI_ORIGIN);
    if (page > 1) url.searchParams.set("page", String(page));
    const response = await this.http.get(url, signal);
    return parseSearchPage(response.html, response.url, page);
  }

  private async resolveRegion(
    query: string,
    signal?: AbortSignal,
  ): Promise<{ regions: Region[]; url: string }> {
    const url = new URL("/shop_search_completion_keywords", TOKUBAI_ORIGIN);
    url.searchParams.set("query", query);
    url.searchParams.set("query_type", "region");
    const response = await this.http.getJson(url, signal);
    const parsed = completionSchema.safeParse(response.data);
    if (!parsed.success)
      throw new TokubaiError("PARSE_ERROR", "地域候補のデータ構造が変更されています。");
    const regions = parsed.data.map((r) => ({
      type: r.category,
      id: String(r.relation_id),
      name: r.content,
      prefecture_id: r.prefecture_id,
    }));
    const unique = [...new Map(regions.map((r) => [`${r.type}:${r.id}`, r])).values()];
    return { regions: unique, url: response.url };
  }

  async search(
    input: z.input<typeof searchInputSchema>,
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    const { region, region_target, store_name, page } = searchInputSchema.parse(input);
    let target = region_target;
    if (region) {
      const { regions, url } = await this.resolveRegion(region, signal);
      const normalize = (s: string) => s.normalize("NFKC").replace(/\s+/g, "");
      const exact = regions.filter((r) => normalize(r.name) === normalize(region));
      const bare = regions.filter(
        (r) => normalize(r.name.replace(/[（(][^()（）]*[）)]$/, "")) === normalize(region),
      );
      const matches = exact.length ? exact : bare.length ? bare : regions;
      if (matches.length !== 1) {
        return {
          status: regions.length ? "ambiguous_region" : "region_not_found",
          source_url: url,
          fetched_at: new Date().toISOString(),
          stores: [],
          returned_count: 0,
          total_count: null,
          page,
          next_page: null,
          next_page_url: null,
          region_candidates: regions,
        };
      }
      target = { type: matches[0]!.type, id: matches[0]!.id };
    }
    const url = new URL("/shop_search_results", TOKUBAI_ORIGIN);
    url.searchParams.set("shop_fetcher[target_type]", target?.type ?? "all_region");
    if (target) url.searchParams.set("shop_fetcher[target_id]", target.id);
    if (store_name) url.searchParams.set("shop_fetcher[free_word_query]", store_name);
    url.searchParams.set("shop_fetcher[content]", "shop");
    url.searchParams.set("shop_fetcher[order]", "recommended");
    if (page > 1) url.searchParams.set("page", String(page));
    const response = await this.http.get(url, signal);
    return parseSearchPage(response.html, response.url, page);
  }

  async getFlyers(input: z.input<typeof flyersInputSchema>, signal?: AbortSignal) {
    const { store_url, store_id } = flyersInputSchema.parse(input);
    const url = tokubaiUrl(store_url ?? `/shops/${store_id}`);
    const requestedId = storeId(url);
    // A store URL always refers to today's top page; discard tracking or date parameters.
    url.search = "";
    url.pathname = url.pathname.replace(/\/$/, "");
    const response = await this.http.get(url, signal);
    const { store, viewer_url } = parseStorePage(response.html, response.url);
    if (store.id !== requestedId)
      throw new TokubaiError("PARSE_ERROR", "取得した店舗 ID が指定と一致しません。");
    let flyers: ReturnType<typeof parseViewerPage> = [];
    if (viewer_url) {
      const viewer = await this.http.get(viewer_url, signal);
      if (new URL(viewer.url).pathname !== new URL(viewer_url).pathname) {
        throw new TokubaiError("PARSE_ERROR", "チラシ viewer が別ページに転送されました。");
      }
      flyers = parseViewerPage(viewer.html, viewer.url);
    }
    return { store, flyers, source_url: store.url, fetched_at: new Date().toISOString() };
  }
}
