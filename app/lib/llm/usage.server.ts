import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import db from "../../db.server";
import { logError } from "../log.server";

// Token-usage recording (spec 19 · admin usage analytics). Called from the
// LLM seam on every completed API call and rolled up into llm_usage_daily.
//
// Two hard rules, because this sits in the shopper chat hot path:
//   1. NEVER throws — a recording failure must not break a reply.
//   2. NEVER awaited by the caller — writes are fire-and-forget.
// Rows are shop-scoped (a blank shopId is dropped, not written globally).

export type LlmPurpose = "router" | "reply" | "summary" | "moderation" | "embedding" | "setup";

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

  // One atomic statement that writes only while the shop is installed. The
  // write is fire-and-forget, so a call made just before an uninstall can land
  // AFTER the retention purge (cleanupShop) and leave a row behind for a shop
  // whose data must be gone — seen in install-lifecycle under load.
  await db.$executeRaw(Prisma.sql`
    INSERT INTO "llm_usage_daily"
      ("id", "shopId", "date", "model", "purpose", "calls", "promptTokens", "cachedTokens", "completionTokens", "updatedAt")
    SELECT ${randomUUID()}, s."id", ${date}::date, ${record.model}, ${record.purpose}, 1,
           ${promptTokens}, ${cachedTokens}, ${completionTokens}, now()
    FROM "shops" s
    WHERE s."id" = ${record.shopId} AND s."uninstalledAt" IS NULL
    ON CONFLICT ("shopId", "date", "model", "purpose") DO UPDATE SET
      "calls" = "llm_usage_daily"."calls" + 1,
      "promptTokens" = "llm_usage_daily"."promptTokens" + EXCLUDED."promptTokens",
      "cachedTokens" = "llm_usage_daily"."cachedTokens" + EXCLUDED."cachedTokens",
      "completionTokens" = "llm_usage_daily"."completionTokens" + EXCLUDED."completionTokens",
      "updatedAt" = now()
  `);
}
