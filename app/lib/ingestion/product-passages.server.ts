import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import db from "../../db.server";
import { runtimeConfig } from "../admin/runtime-config.server";
import { embedTexts, toSqlVector } from "../embeddings/embedding.server";
import { logError, logWarn } from "../log.server";
import { requireShopId } from "../tenancy.server";
import { stockCondition } from "../search/product-search.server";
import { hashText } from "./metafields.server";

// Product description passages (spec 25).
//
// WHY: a product's single vector holds only the first 2,000 characters of its
// description (embedding.server.ts), and long SEO descriptions keep real facts
// far past that — on jgw-check the Moonstone bracelet's "hormonal balance" text
// sits at ~5,500 of 8,600 chars, invisible to meaning search and cut from
// product-detail answers. Splitting the description into passages, each with
// its own vector, makes the WHOLE description searchable by meaning and lets a
// product question be answered from the passages that match it.
//
// Built at catalog sync (full sync + webhooks) for descriptions long enough to
// need it; rebuilt only when the description text changes (sourceHash).

/** Shorter descriptions already fit the product vector and product details whole. */
export const PASSAGE_MIN_DESCRIPTION = 1_200;
/** Target passage size (chars). Grouped by sentences, no overlap. */
const PASSAGE_TARGET = 800;
/** A passage this common across a shop's products is boilerplate for search. */
export const COMMON_PASSAGE_PRODUCTS = 3;

const normalise = (text: string) => text.replace(/\s+/g, " ").trim();

/** Stable hash of a passage's words, so the same paragraph matches across products. */
export function passageBodyHash(body: string): string {
  return hashText(body.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim());
}

/**
 * Sentence-grouped passages of ~PASSAGE_TARGET chars. No overlap: identical
 * boilerplate paragraphs then tend to produce identical passages (bodyHash),
 * and each passage is a clean unit to quote. A single over-long sentence is
 * cut at a word boundary.
 */
export function descriptionPassages(description: string): string[] {
  const text = normalise(description);
  if (text.length < PASSAGE_MIN_DESCRIPTION) return [];
  const sentences = text.split(/(?<=[.!?])\s+(?=["“(\p{Lu}\p{N}])/u);
  const passages: string[] = [];
  let current = "";
  const push = () => {
    if (current.trim()) passages.push(current.trim());
    current = "";
  };
  for (const sentence of sentences) {
    if (sentence.length > PASSAGE_TARGET * 1.5) {
      push();
      let rest = sentence;
      while (rest.length > PASSAGE_TARGET) {
        const cut = rest.lastIndexOf(" ", PASSAGE_TARGET);
        const at = cut > PASSAGE_TARGET * 0.5 ? cut : PASSAGE_TARGET;
        passages.push(rest.slice(0, at).trim());
        rest = rest.slice(at);
      }
      current = rest;
      continue;
    }
    if (current && current.length + sentence.length + 1 > PASSAGE_TARGET) push();
    current = current ? `${current} ${sentence}` : sentence;
  }
  push();
  return passages;
}

/**
 * Build (or rebuild) passages for these products when their description changed.
 * Never throws: a passage failure must not fail the catalog sync — the product
 * row and its own vector are already written.
 */
export async function syncProductPassages(
  shopId: string,
  products: { id: string; title: string; description: string }[],
): Promise<void> {
  requireShopId(shopId);
  if (products.length === 0) return;
  try {
    const ids = products.map((p) => p.id);
    const stored = await db.productPassage.findMany({
      where: { shopId, productId: { in: ids } },
      select: { productId: true, sourceHash: true },
      distinct: ["productId"],
    });
    const storedHash = new Map(stored.map((s) => [s.productId, s.sourceHash]));

    // Descriptions that shrank below the threshold (or emptied) drop their passages.
    const tooShort = products.filter(
      (p) => normalise(p.description).length < PASSAGE_MIN_DESCRIPTION && storedHash.has(p.id),
    );
    if (tooShort.length > 0) {
      await db.productPassage.deleteMany({ where: { shopId, productId: { in: tooShort.map((p) => p.id) } } });
    }

    const work = products
      .map((p) => ({ product: p, sourceHash: hashText(normalise(p.description)) }))
      .filter(
        ({ product, sourceHash }) =>
          normalise(product.description).length >= PASSAGE_MIN_DESCRIPTION && storedHash.get(product.id) !== sourceHash,
      );
    if (work.length === 0) return;

    if (!runtimeConfig().openaiApiKey) {
      logWarn("embedding_skipped", "product passages not built — no OpenAI key", { shopId, products: work.length });
      return;
    }

    const rows = work.flatMap(({ product, sourceHash }) =>
      descriptionPassages(product.description).map((body, position) => ({
        productId: product.id,
        title: product.title,
        position,
        body,
        sourceHash,
      })),
    );
    // Each passage is embedded on its OWN text. Prefixing the product title was
    // tried and made every passage of a product look alike (0.775 / 0.770 /
    // 0.769 for "menstrual problems" — the answer lost to a care paragraph);
    // which product a passage belongs to is already known from its row.
    const vectors = await embedTexts(rows.map((r) => r.body), { shopId });

    for (const { product } of work) {
      const mine = rows.map((row, i) => ({ row, vector: vectors[i] })).filter((x) => x.row.productId === product.id);
      await db.$transaction(async (tx) => {
        await tx.productPassage.deleteMany({ where: { shopId, productId: product.id } });
        for (const { row, vector } of mine) {
          await tx.$executeRaw(Prisma.sql`
            INSERT INTO "product_passages" ("id", "shopId", "productId", "position", "body", "bodyHash", "sourceHash", "embedding")
            VALUES (${randomUUID()}, ${shopId}, ${row.productId}, ${row.position}, ${row.body},
                    ${passageBodyHash(row.body)}, ${row.sourceHash}, ${toSqlVector(vector)}::vector)
          `);
        }
      });
    }
  } catch (error) {
    logError("product_passages_sync_error", error, { shopId });
  }
}

/**
 * Description passages across the shop's showable products that match a
 * question, best first, one per product, boilerplate skipped. Lets a product
 * question asked through the store-info tool still reach the product's own
 * description ("does the moonstone bracelet help with hormonal balance?").
 */
export async function searchProductPassages(
  shopId: string,
  queryEmbedding: number[],
  opts: { limit: number; minScore: number; excludeOutOfStock: boolean },
): Promise<{ title: string; body: string; score: number }[]> {
  requireShopId(shopId);
  const vec = toSqlVector(queryEmbedding);
  const [, rows] = await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL hnsw.iterative_scan = relaxed_order`),
    db.$queryRaw<{ title: string; body: string; score: number }[]>(Prisma.sql`
      WITH hits AS (
        SELECT pp."productId", pp."body", (1 - (pp."embedding" <=> ${vec}::vector))::float8 AS score
        FROM "product_passages" pp
        WHERE pp."shopId" = ${shopId}
          AND pp."embedding" IS NOT NULL
          AND pp."bodyHash" NOT IN (
            SELECT "bodyHash" FROM "product_passages"
            WHERE "shopId" = ${shopId}
            GROUP BY "bodyHash"
            HAVING count(DISTINCT "productId") >= ${COMMON_PASSAGE_PRODUCTS}
          )
        ORDER BY pp."embedding" <=> ${vec}::vector
        LIMIT ${opts.limit * 8}
      ),
      best AS (
        SELECT DISTINCT ON ("productId") "productId", "body", score FROM hits ORDER BY "productId", score DESC
      )
      SELECT p."title", b."body", b.score
      FROM best b
      JOIN "products" p ON p."id" = b."productId" AND p."shopId" = ${shopId}
      WHERE p."learnEnabled" = true AND p."status" = 'active' AND p."publishedOnline" = true
        AND ${stockCondition(opts.excludeOutOfStock)}
        AND b.score >= ${opts.minScore}
      ORDER BY b.score DESC
      LIMIT ${opts.limit}
    `),
  ]);
  return rows.map((r) => ({ title: r.title, body: r.body, score: Number(r.score) }));
}

/**
 * The best-matching passage of each given product for one question, above a
 * score floor. One query for a whole result list.
 */
export async function bestPassagePerProduct(
  shopId: string,
  productIds: string[],
  queryEmbedding: number[],
  minScore: number,
): Promise<Map<string, { body: string; score: number }>> {
  requireShopId(shopId);
  if (productIds.length === 0) return new Map();
  const rows = await db.$queryRaw<{ productId: string; body: string; score: number }[]>(Prisma.sql`
    SELECT DISTINCT ON ("productId") "productId", "body",
           (1 - ("embedding" <=> ${toSqlVector(queryEmbedding)}::vector))::float8 AS score
    FROM "product_passages"
    WHERE "shopId" = ${shopId} AND "productId" IN (${Prisma.join(productIds)}) AND "embedding" IS NOT NULL
    ORDER BY "productId", "embedding" <=> ${toSqlVector(queryEmbedding)}::vector
  `);
  return new Map(
    rows
      .filter((r) => Number(r.score) >= minScore)
      .map((r) => [r.productId, { body: r.body, score: Number(r.score) }]),
  );
}

/** A product's passages ranked by similarity to a question, best first. */
export async function passagesForProduct(
  shopId: string,
  productId: string,
  queryEmbedding: number[],
  limit: number,
): Promise<{ position: number; body: string; score: number }[]> {
  requireShopId(shopId);
  const rows = await db.$queryRaw<{ position: number; body: string; score: number }[]>(Prisma.sql`
    SELECT "position", "body", (1 - ("embedding" <=> ${toSqlVector(queryEmbedding)}::vector))::float8 AS score
    FROM "product_passages"
    WHERE "shopId" = ${shopId} AND "productId" = ${productId} AND "embedding" IS NOT NULL
    ORDER BY score DESC
    LIMIT ${limit}
  `);
  return rows.map((r) => ({ position: Number(r.position), body: r.body, score: Number(r.score) }));
}
