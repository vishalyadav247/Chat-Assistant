import { Prisma } from "@prisma/client";
import db from "../../db.server";
import { toSqlVector } from "../embeddings/embedding.server";
import { requireShopId } from "../tenancy.server";

// Hybrid product search — the accuracy core (spec 03 / PRODUCTION-BUILD-SPEC §8).
// Keyword (weighted tsvector: title A, type/vendor/tags B, description C) and
// vector (pgvector cosine) run in parallel and are fused by reciprocal rank;
// hard filters (shop, learn, stock, price) always in SQL WHERE.
//
// Keyword semantics match the validated demo: ANY router keyword qualifies a
// product (OR, stemmed) — the earlier AND query silently dropped most
// description-level matches. The shopper's own words form a second, lower
// tier so attributes the router paraphrased away ("rfid", "touchscreen") still
// reach the candidate list. `ts_headline` returns the matching fragment of a
// long description so the LLM sees WHY a product matched (index.server.ts).

export interface ProductVariantInfo {
  id: string; // gid://shopify/ProductVariant/...
  title: string;
  price: number;
  available: boolean;
}

export interface ProductCandidate {
  id: string;
  shopifyProductId: string;
  title: string;
  price: number;
  stock: number;
  imageUrl: string | null;
  handle: string;
  variants: ProductVariantInfo[] | null;
  productType: string;
  tags: string[];
  description: string;
  score: number | null; // vector similarity (null for keyword-only hits)
  /** Matching description fragment(s) from the keyword lane; null for vector-only rows. */
  headline: string | null;
  /** Reciprocal-rank-fusion score — candidates are returned sorted by it. */
  fused: number;
}

export interface ProductSearchArgs {
  shopId: string;
  queryEmbedding: number[];
  keywords: string[];
  /** Raw shopper message — its significant words form the lower keyword tier. */
  message?: string;
  priceMax?: number | null;
  minMeaningScore: number; // guardrails.minMeaningScore
  limit?: number;
  /** Rules card (spec 08): when false, unavailable products may be recommended. */
  excludeOutOfStock?: boolean;
}

// Purchasable = tracked stock on hand OR any variant availableForSale (covers
// untracked inventory and "continue selling when out of stock").
const PURCHASABLE = Prisma.sql`("stock" > 0 OR EXISTS (
  SELECT 1 FROM jsonb_array_elements(COALESCE("variants", '[]'::jsonb)) AS v
  WHERE (v->>'available')::boolean
))`;

function stockCondition(excludeOutOfStock: boolean): Prisma.Sql {
  return excludeOutOfStock ? PURCHASABLE : Prisma.sql`TRUE`;
}

const BASE_COLUMNS = Prisma.sql`"id", "shopifyProductId", "title", "price"::float8 AS price, "stock",
           "imageUrl", "handle", "variants", "productType", "tags", "description"`;

const RRF_K = 60;
/** Message-word-only keyword hits count half as much as router-keyword hits. */
const MESSAGE_TIER_WEIGHT = 0.5;

export async function hybridProductSearch(args: ProductSearchArgs): Promise<ProductCandidate[]> {
  const shopId = requireShopId(args.shopId);
  const limit = args.limit ?? 8;
  const priceMax = args.priceMax ?? null;
  const excludeOutOfStock = args.excludeOutOfStock ?? true;

  const [keywordRows, vectorRows] = await Promise.all([
    keywordSearch(shopId, args.keywords, args.message ?? "", priceMax, limit, excludeOutOfStock),
    vectorSearch(shopId, args.queryEmbedding, priceMax, limit, excludeOutOfStock),
  ]);

  // Reciprocal rank fusion: products found by both lanes rise to the top;
  // vector-only rows still need the meaning gate.
  const merged = new Map<string, ProductCandidate>();
  keywordRows.forEach((row, rank) => {
    const weight = row.kwHit ? 1 : MESSAGE_TIER_WEIGHT;
    merged.set(row.id, { ...toCandidate(row), fused: weight / (RRF_K + rank) });
  });
  vectorRows.forEach((row, rank) => {
    const contribution = 1 / (RRF_K + rank);
    const existing = merged.get(row.id);
    if (existing) {
      existing.score = row.score;
      existing.fused += contribution;
      return;
    }
    if ((row.score ?? 0) < args.minMeaningScore) return;
    merged.set(row.id, { ...toCandidate(row), fused: contribution });
  });
  return [...merged.values()].sort((a, b) => b.fused - a.fused).slice(0, limit);
}

/** Fallback when nothing matched but a budget exists: cheapest in-stock, in-budget items. */
export async function browseCheapestInBudget(
  shopId: string,
  priceMax: number,
  limit = 4,
  excludeOutOfStock = true,
): Promise<ProductCandidate[]> {
  requireShopId(shopId);
  const rows = await db.$queryRaw<RawRow[]>(Prisma.sql`
    SELECT ${BASE_COLUMNS}, NULL::float8 AS score, NULL::text AS headline, FALSE AS "kwHit"
    FROM "products"
    WHERE "shopId" = ${shopId}
      AND "learnEnabled" = true AND "status" = 'active'
      AND ${stockCondition(excludeOutOfStock)} AND "price" <= ${priceMax}
    ORDER BY "price" ASC
    LIMIT ${limit}
  `);
  return rows.map((row, i) => ({ ...toCandidate(row), fused: 1 / (RRF_K + i) }));
}

interface RawRow {
  id: string;
  shopifyProductId: string;
  title: string;
  price: number;
  stock: number;
  imageUrl: string | null;
  handle: string;
  variants: ProductVariantInfo[] | null;
  productType: string | null;
  tags: string[] | null;
  description: string | null;
  score: number | null;
  headline: string | null;
  kwHit: boolean | null;
}

// Chat filler that carries no product meaning (Postgres' english config already
// drops classic stop-words; these are the extras a shopper types).
const FILLER = new Set([
  "something", "anything", "someone", "looking", "look", "show", "need", "want", "like",
  "please", "recommend", "recommendation", "suggest", "suggestion", "have", "there", "what",
  "which", "would", "could", "should", "thanks", "thank", "hello", "some", "that", "this",
  "with", "from", "under", "over", "about", "around", "cheap", "cheapest", "budget", "dollar",
  "dollars", "price", "priced", "buy", "get", "find", "give", "best", "good", "great", "nice",
  "help", "any", "kind", "sort", "thing", "things", "item", "items", "product", "products",
  "store", "shop", "sell", "selling", "available", "can", "use", "for", "and", "the",
]);

function messageTerms(message: string, exclude: Set<string>): string[] {
  const out: string[] = [];
  for (const word of message.toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length <= 2 || /^\d+$/.test(word) || FILLER.has(word) || exclude.has(word)) continue;
    if (!out.includes(word)) out.push(word);
  }
  return out.slice(0, 10);
}

/** OR of one plainto_tsquery per term (stemmed). Empty terms → null. */
function orQuery(terms: string[]): Prisma.Sql | null {
  const clean = terms.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0);
  if (clean.length === 0) return null;
  return Prisma.sql`(${Prisma.join(
    clean.map((t) => Prisma.sql`plainto_tsquery('english', ${t})`),
    " || ",
  )})`;
}

async function keywordSearch(
  shopId: string,
  keywords: string[],
  message: string,
  priceMax: number | null,
  limit: number,
  excludeOutOfStock: boolean,
): Promise<RawRow[]> {
  const routerTerms = keywords.map((k) => k.trim().toLowerCase()).filter((k) => k.length > 0);
  const kwQuery = orQuery(routerTerms);
  const msgQuery = orQuery(messageTerms(message, new Set(routerTerms)));
  if (!kwQuery && !msgQuery) return [];

  const anyQuery =
    kwQuery && msgQuery ? Prisma.sql`(${kwQuery} || ${msgQuery})` : (kwQuery ?? msgQuery!);
  const kwHit = kwQuery ? Prisma.sql`("searchText" @@ ${kwQuery})` : Prisma.sql`FALSE`;
  const kwRank = kwQuery ? Prisma.sql`ts_rank_cd("searchText", ${kwQuery})` : Prisma.sql`0::float4`;
  const msgRank = msgQuery ? Prisma.sql`ts_rank_cd("searchText", ${msgQuery})` : Prisma.sql`0::float4`;

  // Router-keyword matches always outrank message-word-only matches; within a
  // tier, weighted ts_rank_cd (title > type/tags > description). Headline is
  // computed only for the LIMITed rows (subquery), never the whole catalog.
  const rows = await db.$queryRaw<RawRow[]>(Prisma.sql`
    SELECT p.*,
           ts_headline('english', coalesce(p."description", ''), ${anyQuery},
             'MaxFragments=2, MaxWords=35, MinWords=12, FragmentDelimiter=" … "') AS headline
    FROM (
      SELECT ${BASE_COLUMNS}, NULL::float8 AS score, ${kwHit} AS "kwHit",
             ${kwRank} AS kw_rank, ${msgRank} AS msg_rank
      FROM "products"
      WHERE "shopId" = ${shopId}
        AND "learnEnabled" = true AND "status" = 'active'
        AND ${stockCondition(excludeOutOfStock)}
        AND (${priceMax}::float8 IS NULL OR "price" <= ${priceMax}::float8)
        AND "searchText" @@ ${anyQuery}
      ORDER BY "kwHit" DESC, kw_rank DESC, msg_rank DESC, "title" ASC
      LIMIT ${limit}
    ) p
    ORDER BY p."kwHit" DESC, p.kw_rank DESC, p.msg_rank DESC, p."title" ASC
  `);
  return rows;
}

async function vectorSearch(
  shopId: string,
  queryEmbedding: number[],
  priceMax: number | null,
  limit: number,
  excludeOutOfStock: boolean,
): Promise<RawRow[]> {
  const vec = toSqlVector(queryEmbedding);
  return db.$queryRaw<RawRow[]>(Prisma.sql`
    SELECT ${BASE_COLUMNS},
           (1 - ("embedding" <=> ${vec}::vector))::float8 AS score,
           NULL::text AS headline, FALSE AS "kwHit"
    FROM "products"
    WHERE "shopId" = ${shopId}
      AND "learnEnabled" = true AND "status" = 'active'
      AND ${stockCondition(excludeOutOfStock)}
      AND (${priceMax}::float8 IS NULL OR "price" <= ${priceMax}::float8)
      AND "embedding" IS NOT NULL
    ORDER BY "embedding" <=> ${vec}::vector
    LIMIT ${limit}
  `);
}

function toCandidate(row: RawRow): ProductCandidate {
  return {
    id: row.id,
    shopifyProductId: row.shopifyProductId,
    title: row.title,
    price: Number(row.price),
    stock: row.stock,
    imageUrl: row.imageUrl,
    handle: row.handle,
    variants: row.variants,
    productType: row.productType ?? "",
    tags: row.tags ?? [],
    description: row.description ?? "",
    score: row.score === null || row.score === undefined ? null : Number(row.score),
    headline: cleanHeadline(row.headline),
    fused: 0,
  };
}

/** ts_headline marks matches with <b>…</b>; the model gets plain text. */
function cleanHeadline(headline: string | null | undefined): string | null {
  if (!headline) return null;
  const text = headline.replace(/<\/?b>/g, "").replace(/\s+/g, " ").trim();
  return text.length > 0 ? text : null;
}

/**
 * Short, relevant excerpt handed to the LLM per candidate: type · tags · the
 * matching description fragment (or the description's start for vector-only
 * rows). Long descriptions stay full-length in the index; only the payload
 * is bounded.
 */
export function candidateSnippet(candidate: ProductCandidate): string {
  const parts: string[] = [];
  if (candidate.productType) parts.push(candidate.productType);
  if (candidate.tags.length > 0) parts.push(candidate.tags.slice(0, 5).join(", "));
  const body = candidate.headline ?? candidate.description.replace(/\s+/g, " ").trim().slice(0, 220);
  if (body) parts.push(body);
  return parts.join(" · ");
}
