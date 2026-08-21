import type { PgBoss } from "pg-boss";
import db from "../../db.server";
import type { Prisma } from "@prisma/client";
import { requireShopId } from "../tenancy.server";
import { logError } from "../log.server";

// Nightly analytics rollup (spec 14). Aggregates one UTC day of conversation /
// message / analytics-event activity into MetricsDaily.counters so range reads
// never scan raw events. Idempotent: re-running a day recomputes from source
// rows and upserts the same numbers.
//
// isTest exclusion: AnalyticsEvent rows carry no isTest flag (pipeline events
// are also recorded for Test-AI turns), so every counter that CAN be derived
// from Message rows joined to non-test conversations is — this both excludes
// test traffic exactly and keeps numbers deterministic:
//   curatedServed        ← out-messages sourceLayer "curated"
//   recommendationsShown ← out-messages sourceLayer recommendation|buy|buy_browse
//                          (mirrors exactly where recommendation_shown fires)
//   fellBack             ← out-messages sourceLayer clarify|rag_fallback
//                          (mirrors exactly where turn_fell_back fires)
//   handovers            ← distinct conversations with a "handover" message
// Only "atc" reads AnalyticsEvent ("added_to_cart" — recorded solely by the
// real storefront widget, never Test AI; same source dashboard.server.ts uses).

export const ANALYTICS_ROLLUP_JOB = "analytics-rollup";
export const ANALYTICS_ROLLUP_CRON = "37 2 * * *";

/** Layers that mean "the AI showed product recommendations" (pipeline spec 03/08). */
const RECOMMENDATION_LAYERS = ["recommendation", "buy", "buy_browse"];
/** Layers that mean "the AI fell back / could not answer". */
const FALLBACK_LAYERS = ["clarify", "rag_fallback"];

export interface DayCounters {
  conversations: number;
  aiConversations: number;
  /** Approximate v1 (spec delta): "mode ever human" ≈ handover=true. */
  humanConversations: number;
  resolvedByAi: number;
  resolvedByHuman: number;
  unresolved: number;
  /** Shopper turns (role "in" messages) that day. */
  turns: number;
  curatedServed: number;
  recommendationsShown: number;
  atc: number;
  fellBack: number;
  handovers: number;
  /** Avg ms from first shopper message to first reply, conversations started that day. */
  avgFirstResponseMs: number | null;
  /** How many conversations the first-response average covers (for weighted merges). */
  firstResponseCount: number;
  /** Avg ms from startedAt to endedAt for conversations resolved with a timestamp. */
  avgResolutionMs: number | null;
  resolutionCount: number;
  /** Conversations started that day with zero fallback turns. */
  answeredFirstTry: number;
}

export function emptyCounters(): DayCounters {
  return {
    conversations: 0,
    aiConversations: 0,
    humanConversations: 0,
    resolvedByAi: 0,
    resolvedByHuman: 0,
    unresolved: 0,
    turns: 0,
    curatedServed: 0,
    recommendationsShown: 0,
    atc: 0,
    fellBack: 0,
    handovers: 0,
    avgFirstResponseMs: null,
    firstResponseCount: 0,
    avgResolutionMs: null,
    resolutionCount: 0,
    answeredFirstTry: 0,
  };
}

/** Truncate to the UTC day (MetricsDaily.date is a @db.Date). */
export function utcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Compute the counters for one UTC day and upsert them into MetricsDaily.
 * Deterministic + idempotent (re-run → same row). Returns the counters.
 */
export async function rollupDay(shopId: string, date: Date): Promise<DayCounters> {
  requireShopId(shopId);
  const dayStart = utcDay(date);
  const dayEnd = new Date(dayStart.getTime() + DAY_MS);

  const [convos, dayMessages, atc] = await Promise.all([
    db.conversation.findMany({
      where: { shopId, isTest: false, startedAt: { gte: dayStart, lt: dayEnd } },
      select: { id: true, status: true, handover: true, startedAt: true, endedAt: true },
    }),
    db.message.findMany({
      where: { shopId, createdAt: { gte: dayStart, lt: dayEnd } },
      select: { conversationId: true, role: true, sourceLayer: true },
    }),
    db.analyticsEvent.count({
      where: { shopId, type: "added_to_cart", occurredAt: { gte: dayStart, lt: dayEnd } },
    }),
  ]);

  // Filter the day's messages down to non-test conversations (see header note).
  const messageConvoIds = [...new Set(dayMessages.map((m) => m.conversationId))];
  const testRows =
    messageConvoIds.length > 0
      ? await db.conversation.findMany({
          where: { shopId, id: { in: messageConvoIds }, isTest: true },
          select: { id: true },
        })
      : [];
  const testIds = new Set(testRows.map((r) => r.id));
  const messages = dayMessages.filter((m) => !testIds.has(m.conversationId));

  const counters = emptyCounters();
  counters.conversations = convos.length;
  counters.humanConversations = convos.filter((c) => c.handover).length;
  counters.aiConversations = counters.conversations - counters.humanConversations;
  counters.resolvedByHuman = convos.filter((c) => c.status === "resolved" && c.handover).length;
  counters.resolvedByAi = convos.filter((c) => c.status === "resolved" && !c.handover).length;
  counters.unresolved =
    counters.conversations - counters.resolvedByAi - counters.resolvedByHuman;

  counters.turns = messages.filter((m) => m.role === "in").length;
  counters.curatedServed = messages.filter(
    (m) => m.role === "out" && m.sourceLayer === "curated",
  ).length;
  counters.recommendationsShown = messages.filter(
    (m) => m.role === "out" && RECOMMENDATION_LAYERS.includes(m.sourceLayer ?? ""),
  ).length;
  counters.fellBack = messages.filter(
    (m) => m.role === "out" && FALLBACK_LAYERS.includes(m.sourceLayer ?? ""),
  ).length;
  counters.handovers = new Set(
    messages.filter((m) => m.sourceLayer === "handover").map((m) => m.conversationId),
  ).size;
  counters.atc = atc;

  // Timing metrics need each day-started conversation's full message timeline
  // (a reply may land after midnight).
  if (convos.length > 0) {
    const timeline = await db.message.findMany({
      where: { shopId, conversationId: { in: convos.map((c) => c.id) } },
      orderBy: { createdAt: "asc" },
      select: { conversationId: true, role: true, sourceLayer: true, createdAt: true },
    });
    const byConvo = new Map<string, typeof timeline>();
    for (const m of timeline) {
      const list = byConvo.get(m.conversationId);
      if (list) list.push(m);
      else byConvo.set(m.conversationId, [m]);
    }

    let firstResponseSum = 0;
    let resolutionSum = 0;
    for (const convo of convos) {
      const msgs = byConvo.get(convo.id) ?? [];
      const firstIn = msgs.find((m) => m.role === "in");
      const firstOut = firstIn
        ? msgs.find(
            (m) => m.role === "out" && m.createdAt.getTime() >= firstIn.createdAt.getTime(),
          )
        : undefined;
      if (firstIn && firstOut) {
        firstResponseSum += firstOut.createdAt.getTime() - firstIn.createdAt.getTime();
        counters.firstResponseCount += 1;
      }
      if (convo.status === "resolved" && convo.endedAt) {
        resolutionSum += convo.endedAt.getTime() - convo.startedAt.getTime();
        counters.resolutionCount += 1;
      }
      // "Answered on first try": no fallback turn anywhere in the conversation
      // (v1 approximation of "no fallback before first resolution").
      const hadFallback = msgs.some(
        (m) => m.role === "out" && FALLBACK_LAYERS.includes(m.sourceLayer ?? ""),
      );
      if (!hadFallback) counters.answeredFirstTry += 1;
    }
    counters.avgFirstResponseMs =
      counters.firstResponseCount > 0
        ? Math.round(firstResponseSum / counters.firstResponseCount)
        : null;
    counters.avgResolutionMs =
      counters.resolutionCount > 0 ? Math.round(resolutionSum / counters.resolutionCount) : null;
  }

  await db.metricsDaily.upsert({
    where: { shopId_date: { shopId, date: dayStart } },
    update: { counters: counters as unknown as Prisma.InputJsonValue },
    create: { shopId, date: dayStart, counters: counters as unknown as Prisma.InputJsonValue },
  });
  return counters;
}

/** Nightly pass: re-roll yesterday (final numbers) + today (fresh partial) for every installed shop. */
export async function rollupAll(): Promise<void> {
  const shops = await db.shop.findMany({
    where: { uninstalledAt: null },
    select: { id: true },
  });
  const now = new Date();
  const yesterday = new Date(now.getTime() - DAY_MS);
  for (const shop of shops) {
    try {
      await rollupDay(shop.id, yesterday);
      await rollupDay(shop.id, now);
    } catch (error) {
      logError("analytics_rollup_error", error, { shopId: shop.id });
    }
  }
}

/**
 * Register the rollup queue + work handler. The job orchestrator
 * (app/lib/jobs/handlers.server.ts) calls this and schedules
 * ANALYTICS_ROLLUP_JOB with ANALYTICS_ROLLUP_CRON — same wiring pattern as
 * registerKnowledgeJobs.
 */
export async function registerAnalyticsJobs(boss: PgBoss): Promise<void> {
  await boss.createQueue(ANALYTICS_ROLLUP_JOB).catch(() => {
    /* queue may already exist */
  });
  await boss.work(ANALYTICS_ROLLUP_JOB, async () => {
    await rollupAll();
  });
}
