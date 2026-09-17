import { getLlmProvider } from "../llm/index.server";
import type { ShopContext } from "../llm/types";

// Central embedding utilities. All vector writes/reads use toSqlVector() + raw SQL —
// the Prisma client cannot touch Unsupported("vector") columns.
// `ctx` carries the owning shop so embedding tokens land in that merchant's
// usage row (spec 19). It is REQUIRED so the compiler catches any call site
// that would otherwise consume tokens anonymously.

export const EMBEDDING_DIMENSIONS = 1536;

/** Serialize a vector for a `::vector` cast in raw SQL: '[0.1,0.2,...]' */
export function toSqlVector(vector: number[]): string {
  if (vector.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`embedding: expected ${EMBEDDING_DIMENSIONS} dims, got ${vector.length}`);
  }
  return `[${vector.join(",")}]`;
}

export async function embedText(text: string, ctx: ShopContext): Promise<number[]> {
  return getLlmProvider().embed(truncateForEmbedding(text), ctx);
}

export async function embedTexts(texts: string[], ctx: ShopContext): Promise<number[][]> {
  return getLlmProvider().embedBatch(texts.map(truncateForEmbedding), ctx);
}

// text-embedding-3-small caps at 8191 tokens; stay far under with a char bound.
function truncateForEmbedding(text: string): string {
  return text.slice(0, 8000);
}

/**
 * Deterministic pseudo-embedding for offline seeding/tests (no API key).
 * Hash-seeded, unit-normalized — NOT semantically meaningful.
 */
export function pseudoEmbedding(text: string): number[] {
  let seed = 2166136261;
  for (let i = 0; i < text.length; i++) {
    seed ^= text.charCodeAt(i);
    seed = Math.imul(seed, 16777619);
  }
  const vector: number[] = new Array(EMBEDDING_DIMENSIONS);
  let state = seed >>> 0;
  for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
    // xorshift32
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    vector[i] = (state / 0xffffffff) * 2 - 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0)) || 1;
  return vector.map((x) => x / norm);
}

/** Description's share of the EMBEDDING text (hardening spec 23 §3.1). The
 *  keyword index keeps the full description (searchText + DESC_WEIGHT handle
 *  it there); the vector is what long SEO prose was diluting. */
const EMBED_DESCRIPTION_CAP = 2000;
/** Distinct variant titles folded into the embedding text (spec 23 §2.7). */
const EMBED_VARIANT_TITLES_CAP = 40;

/**
 * Canonical product embedding text — used by catalog sync, the metafield
 * selection job, the re-embed script AND the seed so all index the same thing.
 * Order (tuning event 2026-09-14, spec 23 §2.7+§3.1): title, then the
 * merchant's classification (type / vendor / tags), then variant options
 * ("6mm / Gold" — the only place sizes/colors exist, so "do you have it in
 * 8mm?" can vector-match), then the enabled metafields (Product.metafieldText,
 * spec 07 — "Name: value" lines, the real specs), then the description CAPPED
 * at 2,000 chars. The description used to come before metafields untrimmed: a
 * 7k+ char SEO description diluted the vector and could push the metafields
 * past the 8,000-char model cap entirely. Changing this formula changes the
 * contentHash → every product re-embeds once on the next sync (documented
 * safe). All hash-computing callers must pass the SAME fields — a caller that
 * omits `variants` while another passes them would flip the hash between jobs.
 */
export function productEmbeddingText(product: {
  title: string;
  description?: string | null;
  productType?: string | null;
  vendor?: string | null;
  tags?: string[] | null;
  metafieldText?: string | null;
  variants?: Array<{ title?: unknown }> | unknown | null;
}): string {
  const variantTitles: string[] = [];
  if (Array.isArray(product.variants)) {
    for (const v of product.variants as Array<{ title?: unknown }>) {
      const t = typeof v?.title === "string" ? v.title.trim() : "";
      if (t && t.toLowerCase() !== "default title" && !variantTitles.includes(t)) {
        variantTitles.push(t);
      }
      if (variantTitles.length >= EMBED_VARIANT_TITLES_CAP) break;
    }
  }
  const parts = [
    product.title,
    product.productType,
    product.vendor,
    (product.tags ?? []).filter((t) => t.trim().length > 0).join(", "),
    variantTitles.length > 0 ? `Options: ${variantTitles.join(", ")}` : "",
    product.metafieldText,
    (product.description ?? "").slice(0, EMBED_DESCRIPTION_CAP),
  ]
    .map((p) => (p ?? "").replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0);
  return parts.join(". ");
}
