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
  collectionIds: string[];
  score: number;
}

interface CachedRec {
  id: string;
  title: string;
  productIds: string[];
  collectionIds: string[];
  vectors: number[][];
}

declare global {
  // eslint-disable-next-line no-var
  var recVectorCache: Map<string, Map<string, number[][]>> | undefined;
}

/** Trigger vectors for this shop's active recommendations, embedding on a miss.
 *  Null when the shop has none to match against.
 *
 *  Only the VECTORS are cached (keyed by trigger text) — title and
 *  product/collection ids always come from the rows just fetched. The cache
 *  used to return them too, so a merchant editing a recommendation's product
 *  set without touching its triggers served the old products until the process
 *  restarted (hardening spec 23 §1.4). */
async function triggerVectors(shopId: string): Promise<CachedRec[] | null> {
  const rows = await db.recommendation.findMany({
    where: { shopId, status: "active" },
    select: { id: true, title: true, triggerQuestions: true, productIds: true, collectionIds: true },
  });
  // Collection-only rules are as valid as product rules.
  const candidates = rows.filter(
    (r) => (r.productIds.length > 0 || r.collectionIds.length > 0) && r.triggerQuestions.length > 0,
  );
  if (candidates.length === 0) return null;

  if (!global.recVectorCache) global.recVectorCache = new Map();
  const cache = global.recVectorCache;
  const fingerprint = candidates
    .map((r) => `${r.id}:${r.triggerQuestions.join("|")}`)
    .join("||");
  const cacheKey = `${shopId}:${fingerprint}`;
  let vectorsByRecId = cache.get(cacheKey);

  if (!vectorsByRecId) {
    const texts = candidates.flatMap((rec) => rec.triggerQuestions);
    const vectors = await embedTexts(texts, { shopId });
    let cursor = 0;
    vectorsByRecId = new Map();
    for (const rec of candidates) {
      const take = rec.triggerQuestions.length;
      vectorsByRecId.set(rec.id, vectors.slice(cursor, cursor + take));
      cursor += take;
    }
    // Drop this shop's superseded fingerprints (trigger edits would otherwise
    // pile up dead entries), then evict oldest-first — a whole-cache clear()
    // here would cold-start every tenant at once.
    for (const key of cache.keys()) {
      if (key.startsWith(`${shopId}:`)) cache.delete(key);
    }
    cache.set(cacheKey, vectorsByRecId);
    while (cache.size > 500) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  const byRecId = vectorsByRecId;
  return candidates.map((rec) => ({
    id: rec.id,
    title: rec.title,
    productIds: rec.productIds,
    collectionIds: rec.collectionIds,
    vectors: byRecId.get(rec.id) ?? [],
  }));
}

/** Fill the trigger-vector cache off the hot path (widget boot). Never throws.
 *  Lazily, this cost the first shopper of every process ~600 ms. */
export async function primeRecommendationVectors(shopId: string): Promise<void> {
  try {
    await triggerVectors(requireShopId(shopId));
  } catch {
    // A cold cache is a slow turn, never a broken one — the caller is a warmup.
  }
}

export async function recommendationMatch(
  shopId: string,
  queryEmbedding: number[],
): Promise<RecommendationMatch | null> {
  requireShopId(shopId);
  const cached = await triggerVectors(shopId);
  if (!cached) return null;

  let best: RecommendationMatch | null = null;
  for (const rec of cached) {
    for (const vector of rec.vectors) {
      const score = dot(queryEmbedding, vector);
      if (!best || score > best.score) {
        best = {
          id: rec.id,
          title: rec.title,
          productIds: rec.productIds,
          collectionIds: rec.collectionIds,
          score,
        };
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
