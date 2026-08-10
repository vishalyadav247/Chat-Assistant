import type { Guardrails } from "@prisma/client";
import { recordEvent } from "../analytics/events.server";
import { embedTexts } from "../embeddings/embedding.server";
import { getLlmProvider } from "../llm/index.server";

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
    const flagged = await getLlmProvider().moderate(message);
    if (flagged.length > 0) {
      return { topic: flagged[0], layer: "moderation", score: 1 };
    }
    return null;
  } catch (error) {
    // Fail open — but never silently.
    console.error("moderation_error", error);
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

export async function meaningScan(
  shopId: string,
  queryEmbedding: number[],
  guardrails: Guardrails,
): Promise<GuardrailHit | null> {
  const topics = guardrails.bannedTopics.filter((t) => t.trim().length > 0);
  if (topics.length === 0) return null;

  if (!global.bannedVectorCache) global.bannedVectorCache = new Map();
  const cacheKey = `${shopId}:${topics.join("|")}`;
  let vectors = global.bannedVectorCache.get(cacheKey);
  if (!vectors) {
    vectors = await embedTexts(topics.map((t) => `a message about ${t}`));
    global.bannedVectorCache.set(cacheKey, vectors);
    // Bound the cache (topics change → old keys accumulate).
    if (global.bannedVectorCache.size > 500) global.bannedVectorCache.clear();
  }

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
