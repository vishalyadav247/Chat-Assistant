import type { Guardrails } from "@prisma/client";
import { recordEvent } from "../analytics/events.server";
import { embedTexts } from "../embeddings/embedding.server";
import { getLlmProvider } from "../llm/index.server";
import { logError } from "../log.server";

// 3-layer guardrail (spec 03 step 2): keyword scan → moderation → embedding
// similarity. Layers a+c are cheap/local; moderation is started by the caller
// IN PARALLEL with the router (fails open, metered).

const BANNED_STOP_WORDS = new Set(["advice", "pricing", "content", "message", "about"]);

export interface GuardrailHit {
  topic: string;
  layer: "keyword" | "moderation" | "meaning";
  score: number;
}

/** Layer a: word-boundary keyword scan (fixes the demo's substring false positives). */
export function keywordScan(message: string, bannedTopics: string[]): GuardrailHit | null {
  const lower = message.toLowerCase();
  for (const topic of bannedTopics) {
    const words = topic
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((w) => w.length > 2 && !BANNED_STOP_WORDS.has(w));
    for (const word of words) {
      if (new RegExp(`\\b${escapeRegex(word)}\\b`).test(lower)) {
        return { topic, layer: "keyword", score: 1 };
      }
    }
  }
  return null;
}

/** Layer b: moderation API — call started by the orchestrator in parallel with the router. */
export async function moderationCheck(shopId: string, message: string): Promise<GuardrailHit | null> {
  try {
    const flagged = await getLlmProvider().moderate(message, { shopId });
    if (flagged.length > 0) {
      return { topic: flagged[0], layer: "moderation", score: 1 };
    }
    return null;
  } catch (error) {
    // Fail open — but never silently.
    logError("moderation_error", error, { shopId });
    await recordEvent(shopId, "moderation_error", { message: String(error).slice(0, 200) });
    return null;
  }
}

/**
 * Layer c: embedding similarity vs banned topics (embedded as
 * "a message about {topic}", like the validated demo). Vectors are cached
 * in-memory per shop keyed by the topic list; invalidated implicitly when the
 * topics change (cache key = topics joined).
 */
declare global {
  // eslint-disable-next-line no-var
  var bannedVectorCache: Map<string, number[][]> | undefined;
}

/**
 * The banned-topic vectors for this shop, embedding them on a cache miss.
 *
 * Filling this lazily inside the first chat turn cost that shopper ~600 ms of
 * OpenAI round trip for work that has nothing to do with their message
 * (measured 2026-09-04). `primeBannedVectors` below lets the widget's config
 * fetch — which happens when the panel OPENS, before anyone types — pay it
 * instead.
 */
async function bannedVectors(shopId: string, topics: string[]): Promise<number[][]> {
  if (!global.bannedVectorCache) global.bannedVectorCache = new Map();
  const cacheKey = `${shopId}:${topics.join("|")}`;
  const hit = global.bannedVectorCache.get(cacheKey);
  if (hit) return hit;
  const vectors = await embedTexts(topics.map((t) => `a message about ${t}`), { shopId });
  global.bannedVectorCache.set(cacheKey, vectors);
  // Bound the cache (topics change → old keys accumulate).
  if (global.bannedVectorCache.size > 500) global.bannedVectorCache.clear();
  return vectors;
}

/** Fill the banned-topic vector cache off the hot path. Never throws. */
export async function primeBannedVectors(
  shopId: string,
  guardrails: Guardrails | null,
): Promise<void> {
  const topics = guardrails?.bannedTopics.filter((t) => t.trim().length > 0) ?? [];
  if (topics.length === 0) return;
  try {
    await bannedVectors(shopId, topics);
  } catch (error) {
    logError("banned_vector_prime_error", error, { shopId });
  }
}

export async function meaningScan(
  shopId: string,
  queryEmbedding: number[],
  guardrails: Guardrails,
): Promise<GuardrailHit | null> {
  const topics = guardrails.bannedTopics.filter((t) => t.trim().length > 0);
  if (topics.length === 0) return null;

  const vectors = await bannedVectors(shopId, topics);

  let best: GuardrailHit | null = null;
  for (let i = 0; i < topics.length; i++) {
    const score = dot(queryEmbedding, vectors[i]);
    if (score >= guardrails.bannedMatchThreshold && (!best || score > best.score)) {
      best = { topic: topics[i], layer: "meaning", score };
    }
  }
  return best;
}

function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
