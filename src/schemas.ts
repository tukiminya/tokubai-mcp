import { z } from "zod";

export const storeSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.url(),
  location: z.string().nullable().describe("住所または最寄駅など、サイトに表示された所在地情報"),
  opening_hours: z.string().nullable(),
  category: z.string().nullable(),
});
export type Store = z.infer<typeof storeSchema>;

export const regionSchema = z.object({
  type: z.enum(["prefecture", "city", "area", "station_group", "loconavi_spot"]),
  id: z.string(),
  name: z.string(),
  prefecture_id: z.number().int().min(1).max(47),
});
export type Region = z.infer<typeof regionSchema>;

export const searchResultSchema = z.object({
  status: z.enum(["ok", "region_not_found", "ambiguous_region", "postal_code_not_found"]),
  source_url: z.url(),
  fetched_at: z.iso.datetime(),
  stores: z.array(storeSchema),
  returned_count: z.number().int().nonnegative(),
  total_count: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .describe("サイト表示の総件数。郵便番号のおすすめ一覧では不明のため null"),
  page: z.number().int().positive(),
  next_page: z.number().int().positive().nullable(),
  next_page_url: z.url().nullable(),
  region_candidates: z
    .array(regionSchema)
    .describe("ambiguous_region の場合は type と id を選択して再検索"),
});
export type SearchResult = z.infer<typeof searchResultSchema>;

export const flyerSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.url(),
  image_url: z.url().describe("viewer の埋め込みデータにある高解像度画像 URL"),
  thumbnail_url: z.url().nullable(),
  period: z.object({
    text: z.string().describe("サイト上の対象期間の原文"),
    starts_on: z.iso.date().nullable(),
    ends_on: z.iso.date().nullable(),
  }),
});
export type Flyer = z.infer<typeof flyerSchema>;

export const flyersResultSchema = z.object({
  store: storeSchema,
  flyers: z.array(flyerSchema),
  source_url: z.url(),
  fetched_at: z.iso.datetime(),
});

export const pageSchema = z.number().int().min(1).max(10000).default(1);
export const textSchema = z.string().trim().min(1).max(100);
export const searchInputSchema = z
  .object({
    region: textSchema
      .optional()
      .describe("地域名。例: 新宿、東京都新宿区。候補を検索して地域 ID に解決します"),
    region_target: regionSchema
      .pick({ type: true, id: true })
      .extend({ id: z.string().trim().min(1).max(100) })
      .optional()
      .describe("地域が曖昧な場合に region_candidates の type と id を指定"),
    store_name: textSchema.optional().describe("チェーン名または店名"),
    page: pageSchema,
  })
  .refine((v) => v.region || v.region_target || v.store_name, "地域または店名を指定してください。")
  .refine(
    (v) => !(v.region && v.region_target),
    "region と region_target はどちらか一方を指定してください。",
  );

export const postalInputSchema = z.object({
  postal_code: z
    .string()
    .trim()
    .regex(/^\d{3}-?\d{4}$/, "7桁の郵便番号を指定してください。例: 160-0022"),
});

export const prefectureInputSchema = z.object({
  prefecture: z
    .union([z.number().int().min(1).max(47), textSchema])
    .describe("都道府県名（東京都、東京など）、または 1〜47 の都道府県 ID"),
  page: pageSchema,
});

export const flyersInputSchema = z
  .object({
    store_url: z.url().optional().describe("店舗の URL。例: https://tokubai.co.jp/ライフ/2357"),
    store_id: z
      .string()
      .regex(/^\d{1,12}$/)
      .optional()
      .describe("店舗 ID。郵便番号検索の戻り値 id も利用できます"),
  })
  .refine(
    (v) => Boolean(v.store_url) !== Boolean(v.store_id),
    "store_url または store_id のいずれか一方を指定してください。",
  );
