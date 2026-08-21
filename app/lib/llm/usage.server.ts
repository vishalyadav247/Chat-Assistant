import db from "../../db.server";
import { logError } from "../log.server";

// Token-usage recording (spec 19 · platform usage analytics). Called from the
// LLM seam on every completed API call and rolled up into llm_usage_daily.
//
// Two hard rules, because this sits in the shopper chat hot path:
//   1. NEVER throws — a recording failure must not break a reply.
//   2. NEVER awaited by the caller — writes are fire-and-forget.
// Rows are shop-scoped (a blank shopId is dropped, not written globally).

export type LlmPurpose = "router" | "reply" | "summary" | "moderation" | "embedding";

export interface UsageRecord {
  shopId: string;
  model: string;
  purpose: LlmPurpose;
  promptTokens?: number;
  cachedTokens?: number;
  completionTokens?: number;
}

/** UTC day key — matches the analytics convention (spec 14). */
function utcDay(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Record one LLM call. Fire-and-forget: returns immediately, the upsert runs in
 * the background and swallows its own errors.
 */
export function recordLlmUsage(record: UsageRecord): void {
  void writeUsage(record).catch((error) => {
    // Analytics must never surface as a chat failure.
    logError("llm_usage_record_error", error);
  });
}

/** Awaitable variant for scripts/tests that need the row to exist. */
export async function recordLlmUsageSync(record: UsageRecord): Promise<void> {
  await writeUsage(record);
}

async function writeUsage(record: UsageRecord): Promise<void> {
  // No shop context (scripts, health checks) → nothing to attribute; skip.
  if (!record.shopId || !record.model) return;

  const promptTokens = Math.max(0, Math.round(record.promptTokens ?? 0));
  const cachedTokens = Math.max(0, Math.round(record.cachedTokens ?? 0));
  const completionTokens = Math.max(0, Math.round(record.completionTokens ?? 0));
  const date = utcDay();

  await db.llmUsageDaily.upsert({
    where: {
      shopId_date_model_purpose: {
        shopId: record.shopId,
        date,
        model: record.model,
        purpose: record.purpose,
      },
    },
    create: {
      shopId: record.shopId,
      date,
      model: record.model,
      purpose: record.purpose,
      calls: 1,
      promptTokens,
      cachedTokens,
      completionTokens,
    },
    update: {
      calls: { increment: 1 },
      promptTokens: { increment: promptTokens },
      cachedTokens: { increment: cachedTokens },
      completionTokens: { increment: completionTokens },
    },
  });
}
