import { Prisma } from "@prisma/client";
import db from "../../db.server";
import { toSqlVector } from "../embeddings/embedding.server";
import { requireShopId } from "../tenancy.server";

// Hybrid product search — the accuracy core (spec 03 / PRODUCTION-BUILD-SPEC §8).
// Keyword (tsvector) + vector (pgvector cosine) run in parallel, merged + deduped,
// hard filters (shop, learn, stock, price) always in SQL WHERE.

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
  score: number | null; // vector similarity (null for keyword-only hits)
}

export interface ProductSearchArgs {
  shopId: string;
  queryEmbedding: number[];
  keywords: string[];
  priceMax?: number | null;
  minMeaningScore: number; // guardrails.minMeaningScore
  limit?: number;
}

export async function hybridProductSearch(args: ProductSearchArgs): Promise<ProductCandidate[]> {
  const shopId = requireShopId(args.shopId);
  const limit = args.limit ?? 8;
  const priceMax = args.priceMax ?? null;

  const [keywordRows, vectorRows] = await Promise.all([
    keywordSearch(shopId, args.keywords, priceMax, limit),
    vectorSearch(shopId, args.queryEmbedding, priceMax, limit),
  ]);

  const merged = new Map<string, ProductCandidate>();
  for (const row of keywordRows) {
    merged.set(row.id, row);
  }
  for (const row of vectorRows) {
    if ((row.score ?? 0) < args.minMeaningScore) continue;
    const existing = merged.get(row.id);
    if (existing) {
      existing.score = row.score;
    } else {
      merged.set(row.id, row);
    }
  }
  return [...merged.values()].slice(0, limit);
}

/** Fallback when nothing matched but a budget exists: cheapest in-stock, in-budget items. */
export async function browseCheapestInBudget(
  shopId: string,
  priceMax: number,
  limit = 4,
): Promise<ProductCandidate[]> {
  requireShopId(shopId);
  const rows = await db.$queryRaw<RawRow[]>(Prisma.sql`
    SELECT "id", "shopifyProductId", "title", "price"::float8 AS price, "stock",
           "imageUrl", "handle", "variants", NULL::float8 AS score
    FROM "products"
    WHERE "shopId" = ${shopId}
      AND "learnEnabled" = true AND "status" = 'active'
      AND "stock" > 0 AND "price" <= ${priceMax}
    ORDER BY "price" ASC
    LIMIT ${limit}
  `);
  return rows.map(toCandidate);
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
  score: number | null;
}

async function keywordSearch(
  shopId: string,
  keywords: string[],
  priceMax: number | null,
  limit: number,
): Promise<ProductCandidate[]> {
  const terms = keywords.filter((k) => k.trim().length > 0);
  if (terms.length === 0) return [];
  const query = terms.join(" ");
  const rows = await db.$queryRaw<RawRow[]>(Prisma.sql`
    SELECT "id", "shopifyProductId", "title", "price"::float8 AS price, "stock",
           "imageUrl", "handle", "variants", NULL::float8 AS score
    FROM "products"
    WHERE "shopId" = ${shopId}
      AND "learnEnabled" = true AND "status" = 'active'
      AND "stock" > 0
      AND (${priceMax}::float8 IS NULL OR "price" <= ${priceMax}::float8)
      AND "searchText" @@ plainto_tsquery('english', ${query})
    LIMIT ${limit}
  `);
  return rows.map(toCandidate);
}

async function vectorSearch(
  shopId: string,
  queryEmbedding: number[],
  priceMax: number | null,
  limit: number,
): Promise<ProductCandidate[]> {
  const vec = toSqlVector(queryEmbedding);
  const rows = await db.$queryRaw<RawRow[]>(Prisma.sql`
    SELECT "id", "shopifyProductId", "title", "price"::float8 AS price, "stock",
           "imageUrl", "handle", "variants",
           (1 - ("embedding" <=> ${vec}::vector))::float8 AS score
    FROM "products"
    WHERE "shopId" = ${shopId}
      AND "learnEnabled" = true AND "status" = 'active'
      AND "stock" > 0
      AND (${priceMax}::float8 IS NULL OR "price" <= ${priceMax}::float8)
      AND "embedding" IS NOT NULL
    ORDER BY "embedding" <=> ${vec}::vector
    LIMIT ${limit}
  `);
  return rows.map(toCandidate);
}

function toCandidate(row: RawRow): ProductCandidate {
  return { ...row, price: Number(row.price), score: row.score === null ? null : Number(row.score) };
}
