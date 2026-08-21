import db from "../../db.server";
import { costOf, type TokenCounts } from "./llm-pricing";
import { RANGE_DAYS, type RangeDays } from "./usage-shared";

// Platform usage reporting (spec 19). CROSS-TENANT BY DESIGN — the operator
// console aggregates over every shop. Read-only; no shopId is ever taken from
// user input to WRITE, and the per-shop view validates its id against the shop
// table before querying.

export function normalizeRange(value: string | null): RangeDays {
  const n = Number(value);
  return (RANGE_DAYS as readonly number[]).includes(n) ? (n as RangeDays) : 30;
}

/** Inclusive UTC-day window start, N days back (today counts as day 1). */
function since(days: number): Date {
  const now = new Date();
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(start - (days - 1) * 24 * 60 * 60 * 1000);
}

interface Totals {
  calls: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  tokens: number;
  costUsd: number;
  unpricedModels: string[];
}

function emptyTotals(): Totals {
  return {
    calls: 0,
    promptTokens: 0,
    cachedTokens: 0,
    completionTokens: 0,
    tokens: 0,
    costUsd: 0,
    unpricedModels: [],
  };
}

function addRow(
  totals: Totals,
  row: { model: string; calls: number; promptTokens: number; cachedTokens: number; completionTokens: number },
): void {
  totals.calls += row.calls;
  totals.promptTokens += row.promptTokens;
  totals.cachedTokens += row.cachedTokens;
  totals.completionTokens += row.completionTokens;
  totals.tokens += row.promptTokens + row.completionTokens;
  const counts: TokenCounts = {
    model: row.model,
    promptTokens: row.promptTokens,
    cachedTokens: row.cachedTokens,
    completionTokens: row.completionTokens,
  };
  const cost = costOf(counts);
  if (cost === null) {
    if (!totals.unpricedModels.includes(row.model)) totals.unpricedModels.push(row.model);
  } else {
    totals.costUsd += cost;
  }
}

type SumRow = {
  model: string;
  calls: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
};

function flatten(sum: {
  _sum: {
    calls: number | null;
    promptTokens: number | null;
    cachedTokens: number | null;
    completionTokens: number | null;
  };
}): Omit<SumRow, "model"> {
  return {
    calls: sum._sum.calls ?? 0,
    promptTokens: sum._sum.promptTokens ?? 0,
    cachedTokens: sum._sum.cachedTokens ?? 0,
    completionTokens: sum._sum.completionTokens ?? 0,
  };
}

export interface ShopUsageRow {
  shopId: string;
  domain: string;
  name: string | null;
  plan: string;
  uninstalled: boolean;
  conversations: number;
  totals: Totals;
  costPerConversation: number | null;
  tokensPerConversation: number | null;
}

export interface UsageOverview {
  days: RangeDays;
  fromDate: string;
  grand: Totals;
  shops: ShopUsageRow[];
  shopsWithUsage: number;
  byPurpose: { purpose: string; tokens: number; costUsd: number; calls: number }[];
}

/** Per-merchant usage for the range, heaviest spender first. */
export async function usageOverview(days: RangeDays): Promise<UsageOverview> {
  const from = since(days);

  const [usage, purposeUsage, conversations, shops] = await Promise.all([
    db.llmUsageDaily.groupBy({
      by: ["shopId", "model"],
      where: { date: { gte: from } },
      _sum: { calls: true, promptTokens: true, cachedTokens: true, completionTokens: true },
    }),
    db.llmUsageDaily.groupBy({
      by: ["purpose", "model"],
      where: { date: { gte: from } },
      _sum: { calls: true, promptTokens: true, cachedTokens: true, completionTokens: true },
    }),
    db.conversation.groupBy({
      by: ["shopId"],
      where: { startedAt: { gte: from }, isTest: false },
      _count: { _all: true },
    }),
    db.shop.findMany({
      select: { id: true, domain: true, name: true, plan: true, uninstalledAt: true },
    }),
  ]);

  const convByShop = new Map(conversations.map((c) => [c.shopId, c._count._all]));
  const totalsByShop = new Map<string, Totals>();
  const grand = emptyTotals();

  for (const row of usage) {
    const totals = totalsByShop.get(row.shopId) ?? emptyTotals();
    const flat = { model: row.model, ...flatten(row) };
    addRow(totals, flat);
    addRow(grand, flat);
    totalsByShop.set(row.shopId, totals);
  }

  const rows: ShopUsageRow[] = shops
    .map((shop) => {
      const totals = totalsByShop.get(shop.id) ?? emptyTotals();
      const conversationCount = convByShop.get(shop.id) ?? 0;
      return {
        shopId: shop.id,
        domain: shop.domain,
        name: shop.name,
        plan: shop.plan,
        uninstalled: Boolean(shop.uninstalledAt),
        conversations: conversationCount,
        totals,
        costPerConversation: conversationCount > 0 ? totals.costUsd / conversationCount : null,
        tokensPerConversation: conversationCount > 0 ? totals.tokens / conversationCount : null,
      };
    })
    .sort((a, b) => b.totals.costUsd - a.totals.costUsd || b.totals.tokens - a.totals.tokens);

  const purposeMap = new Map<string, Totals>();
  for (const row of purposeUsage) {
    const totals = purposeMap.get(row.purpose) ?? emptyTotals();
    addRow(totals, { model: row.model, ...flatten(row) });
    purposeMap.set(row.purpose, totals);
  }

  return {
    days,
    fromDate: from.toISOString().slice(0, 10),
    grand,
    shops: rows,
    shopsWithUsage: rows.filter((r) => r.totals.calls > 0).length,
    byPurpose: [...purposeMap.entries()]
      .map(([purpose, t]) => ({ purpose, tokens: t.tokens, costUsd: t.costUsd, calls: t.calls }))
      .sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens),
  };
}

export interface ShopUsageDetail {
  days: RangeDays;
  fromDate: string;
  shop: { id: string; domain: string; name: string | null; plan: string; uninstalled: boolean };
  totals: Totals;
  conversations: number;
  costPerConversation: number | null;
  daily: { date: string; tokens: number; costUsd: number; calls: number }[];
  byPurpose: { purpose: string; tokens: number; costUsd: number; calls: number }[];
  byModel: { model: string; tokens: number; costUsd: number; calls: number; priced: boolean }[];
}

/** Drill-in for one merchant. Returns null when the shop id doesn't exist. */
export async function usageForShop(shopId: string, days: RangeDays): Promise<ShopUsageDetail | null> {
  const shop = await db.shop.findUnique({
    where: { id: shopId },
    select: { id: true, domain: true, name: true, plan: true, uninstalledAt: true },
  });
  if (!shop) return null;

  const from = since(days);
  const [rows, conversations] = await Promise.all([
    db.llmUsageDaily.findMany({
      where: { shopId: shop.id, date: { gte: from } },
      select: {
        date: true,
        model: true,
        purpose: true,
        calls: true,
        promptTokens: true,
        cachedTokens: true,
        completionTokens: true,
      },
      orderBy: { date: "asc" },
    }),
    db.conversation.count({ where: { shopId: shop.id, startedAt: { gte: from }, isTest: false } }),
  ]);

  const totals = emptyTotals();
  const dayMap = new Map<string, Totals>();
  const purposeMap = new Map<string, Totals>();
  const modelMap = new Map<string, Totals>();

  for (const row of rows) {
    addRow(totals, row);
    const key = row.date.toISOString().slice(0, 10);
    for (const [map, mapKey] of [
      [dayMap, key],
      [purposeMap, row.purpose],
      [modelMap, row.model],
    ] as const) {
      const bucket = map.get(mapKey) ?? emptyTotals();
      addRow(bucket, row);
      map.set(mapKey, bucket);
    }
  }

  // Dense day series (gaps render as empty bars, not missing days).
  const daily: ShopUsageDetail["daily"] = [];
  for (let i = 0; i < days; i++) {
    const day = new Date(from.getTime() + i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const bucket = dayMap.get(day);
    daily.push({
      date: day,
      tokens: bucket?.tokens ?? 0,
      costUsd: bucket?.costUsd ?? 0,
      calls: bucket?.calls ?? 0,
    });
  }

  return {
    days,
    fromDate: from.toISOString().slice(0, 10),
    shop: {
      id: shop.id,
      domain: shop.domain,
      name: shop.name,
      plan: shop.plan,
      uninstalled: Boolean(shop.uninstalledAt),
    },
    totals,
    conversations,
    costPerConversation: conversations > 0 ? totals.costUsd / conversations : null,
    daily,
    byPurpose: [...purposeMap.entries()]
      .map(([purpose, t]) => ({ purpose, tokens: t.tokens, costUsd: t.costUsd, calls: t.calls }))
      .sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens),
    byModel: [...modelMap.entries()]
      .map(([model, t]) => ({
        model,
        tokens: t.tokens,
        costUsd: t.costUsd,
        calls: t.calls,
        priced: t.unpricedModels.length === 0,
      }))
      .sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens),
  };
}
