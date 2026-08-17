import { getLlmProvider } from "../llm/index.server";

// Central embedding utilities. All vector writes/reads use toSqlVector() + raw SQL —
// the Prisma client cannot touch Unsupported("vector") columns.

export const EMBEDDING_DIMENSIONS = 1536;

/** Serialize a vector for a `::vector` cast in raw SQL: '[0.1,0.2,...]' */
export function toSqlVector(vector: number[]): string {
  if (vector.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`embedding: expected ${EMBEDDING_DIMENSIONS} dims, got ${vector.length}`);
  }
  return `[${vector.join(",")}]`;
}

export async function embedText(text: string): Promise<number[]> {
  return getLlmProvider().embed(truncateForEmbedding(text));
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  return getLlmProvider().embedBatch(texts.map(truncateForEmbedding));
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

/**
 * Canonical product embedding text — used by catalog sync AND the seed so
 * both index the same thing. Title first, then the merchant's classification
 * (type / vendor / tags), then the FULL description: long descriptions carry
 * the details shoppers ask about, so they are never trimmed here (only the
 * model-safety cap in truncateForEmbedding applies). Changing this formula
 * changes the contentHash → every product re-embeds on the next sync.
 */
export function productEmbeddingText(product: {
  title: string;
  description?: string | null;
  productType?: string | null;
  vendor?: string | null;
  tags?: string[] | null;
}): string {
  const parts = [
    product.title,
    product.productType,
    product.vendor,
    (product.tags ?? []).filter((t) => t.trim().length > 0).join(", "),
    product.description,
  ]
    .map((p) => (p ?? "").replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0);
  return parts.join(". ");
}
