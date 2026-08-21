import db from "../../db.server";
import { embedTexts } from "../embeddings/embedding.server";
import { requireShopId } from "../tenancy.server";

// App-recommendation matcher (spec 08 runtime): merchant-configured intents
// ("Best sellers", "New arrivals") matched curated-style, ranked BELOW merchant
// curated answers (pipeline checks curated first).
//
// Each trigger question gets its OWN embedding (a joined-string embedding
// dilutes individual triggers — verified in evals). Rows per shop are few, so
// vectors live in an in-memory cache keyed by shop + trigger fingerprint,
// invalidated implicitly when triggers change (same pattern as banned topics).

export interface RecommendationMatch {
  id: string;
  title: string;
  productIds: string[];
  score: number;
}

interface CachedRec {
  id: string;
  title: string;
  productIds: string[];
  vectors: number[][];
}

declare global {
  // eslint-disable-next-line no-var
  var recVectorCache: Map<string, CachedRec[]> | undefined;
}

export async function recommendationMatch(
  shopId: string,
  queryEmbedding: number[],
): Promise<RecommendationMatch | null> {
  requireShopId(shopId);
  const rows = await db.recommendation.findMany({
    where: { shopId, status: "active" },
    select: { id: true, title: true, triggerQuestions: true, productIds: true },
  });
  const candidates = rows.filter((r) => r.productIds.length > 0 && r.triggerQuestions.length > 0);
  if (candidates.length === 0) return null;

  if (!global.recVectorCache) global.recVectorCache = new Map();
  const fingerprint = candidates
    .map((r) => `${r.id}:${r.triggerQuestions.join("|")}`)
    .join("||");
  const cacheKey = `${shopId}:${fingerprint}`;
  let cached = global.recVectorCache.get(cacheKey);
  if (!cached) {
    const texts = candidates.flatMap((rec) => rec.triggerQuestions);
    const vectors = await embedTexts(texts, { shopId });
    let cursor = 0;
    cached = candidates.map((rec) => {
      const take = rec.triggerQuestions.length;
      const slice = vectors.slice(cursor, cursor + take);
      cursor += take;
      return { id: rec.id, title: rec.title, productIds: rec.productIds, vectors: slice };
    });
    global.recVectorCache.set(cacheKey, cached);
    if (global.recVectorCache.size > 500) global.recVectorCache.clear();
  }

  let best: RecommendationMatch | null = null;
  for (const rec of cached) {
    for (const vector of rec.vectors) {
      const score = dot(queryEmbedding, vector);
      if (!best || score > best.score) {
        best = { id: rec.id, title: rec.title, productIds: rec.productIds, score };
      }
    }
  }
  return best;
}

function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}
