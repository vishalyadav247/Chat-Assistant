import db from "../../db.server";
import { requireShopId } from "../tenancy.server";
import { requirePlan } from "../billing/plans.server";
import {
  emptyCounters,
  rollupDay,
  utcDay,
  type DayCounters,
} from "./rollup.server";
import type {
  AnalyticsRange,
  CsatSummary,
  RecommendationFunnel,
  ResolutionBreakdown,
  ResponsePerformance,
  SeriesPoint,
  TopQuestion,
} from "./shared";

// Read-side analytics queries (spec 14). Ranged widgets read MetricsDaily
// rollups (fast); today is always recomputed live via rollupDay-on-read so the
// page stays fresh. Days missing a rollup row inside the requested window are
// lazily backfilled once (idempotent — rollupDay of an empty day writes zeros,
// so subsequent reads hit the table).

export * from "./shared";

const RANGE_DAYS: Record<AnalyticsRange, number> = { "7d": 7, "30d": 30, "3m": 90, "12m": 365 };
const DAY_MS = 24 * 60 * 60 * 1000;

function isoDate(day: Date): string {
  return day.toISOString().slice(0, 10);
}

/** The window's UTC days, oldest → newest, ending today. */
function windowDays(range: AnalyticsRange, periodsBack = 0): Date[] {
  const days = RANGE_DAYS[range];
  const today = utcDay(new Date());
  const end = new Date(today.getTime() - periodsBack * days * DAY_MS);
  const out: Date[] = [];
  for (let i = days - 1; i >= 0; i--) {
    out.push(new Date(end.getTime() - i * DAY_MS));
  }
  return out;
}

/**
 * Counters per day for a window: reads MetricsDaily, backfills missing days,
 * always recomputes today live. Keyed by ISO date (yyyy-mm-dd).
 */
async function countersForDays(shopId: string, days: Date[]): Promise<Map<string, DayCounters>> {
  requireShopId(shopId);
  if (days.length === 0) return new Map();
  const rows = await db.metricsDaily.findMany({
    where: { shopId, date: { gte: days[0], lte: days[days.length - 1] } },
    select: { date: true, counters: true },
  });
  const map = new Map<string, DayCounters>();
  for (const row of rows) {
    map.set(isoDate(row.date), { ...emptyCounters(), ...(row.counters as object) });
  }
  const todayKey = isoDate(utcDay(new Date()));
  for (const day of days) {
    const key = isoDate(day);
    if (key === todayKey || !map.has(key)) {
      map.set(key, await rollupDay(shopId, day));
    }
  }
  return map;
}

function sumCounters(map: Map<string, DayCounters>, days: Date[]): DayCounters {
  const total = emptyCounters();
  let firstResponseWeighted = 0;
  let resolutionWeighted = 0;
  for (const day of days) {
    const c = map.get(isoDate(day));
    if (!c) continue;
    total.conversations += c.conversations;
    total.aiConversations += c.aiConversations;
    total.humanConversations += c.humanConversations;
    total.resolvedByAi += c.resolvedByAi;
    total.resolvedByHuman += c.resolvedByHuman;
    total.unresolved += c.unresolved;
    total.turns += c.turns;
    total.curatedServed += c.curatedServed;
    total.recommendationsShown += c.recommendationsShown;
    total.atc += c.atc;
    total.fellBack += c.fellBack;
    total.handovers += c.handovers;
    total.answeredFirstTry += c.answeredFirstTry;
    if (c.avgFirstResponseMs !== null) {
      firstResponseWeighted += c.avgFirstResponseMs * c.firstResponseCount;
      total.firstResponseCount += c.firstResponseCount;
    }
    if (c.avgResolutionMs !== null) {
      resolutionWeighted += c.avgResolutionMs * c.resolutionCount;
      total.resolutionCount += c.resolutionCount;
    }
  }
  total.avgFirstResponseMs =
    total.firstResponseCount > 0
      ? Math.round(firstResponseWeighted / total.firstResponseCount)
      : null;
  total.avgResolutionMs =
    total.resolutionCount > 0 ? Math.round(resolutionWeighted / total.resolutionCount) : null;
  return total;
}

// ── Conversations over time ─────────────────────────────────────────────────

/** Daily Human-vs-AI buckets for the line chart (gaps filled with 0). */
export async function conversationSeries(
  shopId: string,
  range: AnalyticsRange,
): Promise<SeriesPoint[]> {
  const days = windowDays(range);
  const map = await countersForDays(shopId, days);
  return days.map((day) => {
    const c = map.get(isoDate(day)) ?? emptyCounters();
    return { date: isoDate(day), ai: c.aiConversations, human: c.humanConversations };
  });
}

// ── Resolution donut ────────────────────────────────────────────────────────

/** Largest-remainder rounding so the donut always sums to exactly 100. */
function pctParts(values: number[], total: number): number[] {
  if (total === 0) return values.map(() => 0);
  const exact = values.map((v) => (v / total) * 100);
  const floors = exact.map(Math.floor);
  let remainder = 100 - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  for (const { i } of order) {
    if (remainder <= 0) break;
    floors[i] += 1;
    remainder -= 1;
  }
  return floors;
}

export async function resolutionBreakdown(
  shopId: string,
  range: AnalyticsRange,
): Promise<ResolutionBreakdown> {
  const days = windowDays(range);
  const total = sumCounters(await countersForDays(shopId, days), days);
  const [ai, human, un] = pctParts(
    [total.resolvedByAi, total.resolvedByHuman, total.unresolved],
    total.conversations,
  );
  return {
    total: total.conversations,
    resolvedByAiPct: ai,
    resolvedByHumanPct: human,
    unresolvedPct: un,
    resolvedPct: ai + human,
  };
}

// ── CSAT ────────────────────────────────────────────────────────────────────

/** All-time survey results (spec 16 survey; test conversations excluded). */
export async function csatSummary(shopId: string): Promise<CsatSummary> {
  requireShopId(shopId);
  const groups = await db.conversation.groupBy({
    by: ["rating"],
    where: { shopId, isTest: false, rating: { not: null } },
    _count: { _all: true },
  });
  const histogram = [0, 0, 0, 0, 0];
  let responses = 0;
  let sum = 0;
  for (const g of groups) {
    const rating = g.rating as number;
    if (rating < 1 || rating > 5) continue;
    histogram[5 - rating] = g._count._all;
    responses += g._count._all;
    sum += rating * g._count._all;
  }
  return {
    avg: responses > 0 ? Math.round((sum / responses) * 10) / 10 : null,
    responses,
    histogram,
  };
}

// ── Recommendation funnel ───────────────────────────────────────────────────

export async function recommendationFunnel(
  shopId: string,
  range: AnalyticsRange,
): Promise<RecommendationFunnel> {
  const days = windowDays(range);
  const total = sumCounters(await countersForDays(shopId, days), days);
  return { shown: total.recommendationsShown, atc: total.atc, purchased: null };
}

// ── Response performance ────────────────────────────────────────────────────

function pctChange(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

export async function responsePerformance(
  shopId: string,
  range: AnalyticsRange,
): Promise<ResponsePerformance> {
  const days = windowDays(range);
  const prevDays = windowDays(range, 1);
  // One backfill covering both windows (prevDays[0] … today).
  const map = await countersForDays(shopId, [...prevDays, ...days]);
  const current = sumCounters(map, days);
  const previous = sumCounters(map, prevDays);

  const firstTryPct =
    current.conversations > 0
      ? Math.round((current.answeredFirstTry / current.conversations) * 100)
      : null;
  const prevFirstTryPct =
    previous.conversations > 0
      ? Math.round((previous.answeredFirstTry / previous.conversations) * 100)
      : null;

  return {
    avgFirstResponseMs: current.avgFirstResponseMs,
    avgResolutionMs: current.avgResolutionMs,
    answeredFirstTryPct: firstTryPct,
    handedToHuman: current.handovers,
    deltas: {
      firstResponsePct: pctChange(current.avgFirstResponseMs, previous.avgFirstResponseMs),
      resolutionPct: pctChange(current.avgResolutionMs, previous.avgResolutionMs),
      answeredFirstTryPts:
        firstTryPct !== null && prevFirstTryPct !== null ? firstTryPct - prevFirstTryPct : null,
      handedToHuman:
        previous.conversations > 0 ? current.handovers - previous.handovers : null,
    },
  };
}

// ── Top questions ───────────────────────────────────────────────────────────

function normalizeQuestion(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Top 5 shopper questions by normalized text over the most recent 500 shopper
 * messages (cheapest correct v1 — embedding clustering is a spec 14 follow-up).
 * Test conversations excluded via a second lookup (Message has no isTest).
 */
export async function topQuestions(shopId: string): Promise<TopQuestion[]> {
  requireShopId(shopId);
  const recent = await db.message.findMany({
    where: { shopId, role: "in" },
    orderBy: { createdAt: "desc" },
    take: 500,
    select: { conversationId: true, content: true },
  });
  if (recent.length === 0) return [];
  const convoIds = [...new Set(recent.map((m) => m.conversationId))];
  const testRows = await db.conversation.findMany({
    where: { shopId, id: { in: convoIds }, isTest: true },
    select: { id: true },
  });
  const testIds = new Set(testRows.map((r) => r.id));

  const groups = new Map<string, { question: string; count: number }>();
  for (const message of recent) {
    if (testIds.has(message.conversationId)) continue;
    const key = normalizeQuestion(message.content);
    if (key.length < 3) continue;
    const existing = groups.get(key);
    if (existing) existing.count += 1;
    else groups.set(key, { question: message.content.trim(), count: 1 });
  }
  const top = [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 5);
  const max = top[0]?.count ?? 0;
  return top.map((q) => ({
    question: q.question,
    count: q.count,
    pct: max > 0 ? Math.round((q.count / max) * 100) : 0,
  }));
}

// ── CSV exports (Plus gate — "exports"; open enforcement passes) ────────────

function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

async function requireExports(shopId: string): Promise<void> {
  const shop = await db.shop.findUnique({
    where: { id: requireShopId(shopId) },
    select: { plan: true },
  });
  requirePlan(shop?.plan ?? "free", "exports"); // throws PlanGateError when enforced
}

const EXPORT_CONVERSATION_CAP = 5000;

/** Conversations CSV: id, startedAt, status, mode, outcome, rating, messages. */
export async function exportConversationsCsv(shopId: string): Promise<string> {
  await requireExports(shopId);
  const conversations = await db.conversation.findMany({
    where: { shopId, isTest: false },
    orderBy: { startedAt: "desc" },
    take: EXPORT_CONVERSATION_CAP,
    select: {
      id: true,
      startedAt: true,
      status: true,
      mode: true,
      outcome: true,
      rating: true,
    },
  });
  const counts =
    conversations.length > 0
      ? await db.message.groupBy({
          by: ["conversationId"],
          where: { shopId, conversationId: { in: conversations.map((c) => c.id) } },
          _count: { _all: true },
        })
      : [];
  const countById = new Map(counts.map((c) => [c.conversationId, c._count._all]));

  const header = ["id", "startedAt", "status", "mode", "outcome", "rating", "messages"].join(",");
  const lines = conversations.map((c) =>
    [
      c.id,
      c.startedAt.toISOString(),
      c.status,
      c.mode,
      csvField(c.outcome ?? ""),
      c.rating === null ? "" : String(c.rating),
      String(countById.get(c.id) ?? 0),
    ].join(","),
  );
  return [header, ...lines].join("\n") + "\n";
}

/** Analytics CSV: one row per day of the range, one column per counter. */
export async function exportAnalyticsCsv(
  shopId: string,
  range: AnalyticsRange,
): Promise<string> {
  await requireExports(shopId);
  const days = windowDays(range);
  const map = await countersForDays(shopId, days);
  const columns: (keyof DayCounters)[] = [
    "conversations",
    "aiConversations",
    "humanConversations",
    "resolvedByAi",
    "resolvedByHuman",
    "unresolved",
    "turns",
    "curatedServed",
    "recommendationsShown",
    "atc",
    "fellBack",
    "handovers",
    "avgFirstResponseMs",
    "avgResolutionMs",
    "answeredFirstTry",
  ];
  const header = ["date", ...columns].join(",");
  const lines = days.map((day) => {
    const c = map.get(isoDate(day)) ?? emptyCounters();
    return [isoDate(day), ...columns.map((k) => String(c[k] ?? ""))].join(",");
  });
  return [header, ...lines].join("\n") + "\n";
}
