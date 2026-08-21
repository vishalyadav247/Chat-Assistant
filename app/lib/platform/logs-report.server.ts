import db from "../../db.server";
import type { Prisma } from "@prisma/client";
import { LOG_RANGE_HOURS, ROW_LIMIT, type LogRangeHours } from "./logs-shared";

// Platform log reporting (spec 21). CROSS-TENANT BY DESIGN — the operator
// console reads every shop's failures in one window. Strictly read-only: no
// route here ever writes, and the shop filter is validated against the shop
// table before it reaches a query.

/** Ceiling on rows scanned for the aggregate. See `truncatedAggregate` below. */
const AGGREGATE_SCAN_LIMIT = 5000;

export function normalizeHours(value: string | null): LogRangeHours {
  const n = Number(value);
  return (LOG_RANGE_HOURS as readonly number[]).includes(n) ? (n as LogRangeHours) : 24;
}

export function normalizeLevel(value: string | null): "error" | "warn" | null {
  return value === "error" || value === "warn" ? value : null;
}

export interface LogFilters {
  hours: LogRangeHours;
  level: "error" | "warn" | null;
  event: string | null;
  shopId: string | null;
  /**
   * A `?shop=` value that no longer resolves to a shop (purged store, stale
   * support-thread link). The filter is dropped — but the page must SAY so,
   * otherwise the operator reads an unfiltered fleet-wide view as if it were
   * that one merchant's.
   */
  unknownShop?: string | null;
}

export interface LogRow {
  id: string;
  level: string;
  event: string;
  message: string;
  occurredAt: string;
  shopId: string | null;
  shopLabel: string | null;
  context: string | null;
}

export interface EventSummary {
  event: string;
  level: string;
  count: number;
  shops: number;
  lastSeen: string;
}

export interface LogsOverview {
  filters: LogFilters;
  errors: number;
  warnings: number;
  shopsAffected: number;
  /** True when the window held more than AGGREGATE_SCAN_LIMIT rows. */
  truncatedAggregate: boolean;
  topEvents: EventSummary[];
  rows: LogRow[];
  /** True when more than ROW_LIMIT rows matched — the table shows the newest. */
  truncatedRows: boolean;
  eventOptions: string[];
  shopOptions: Array<{ id: string; label: string }>;
}

function windowStart(hours: number): Date {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

/** Validate a shop filter against the shop table — never trust the query string. */
export async function resolveShopFilter(value: string | null): Promise<string | null> {
  if (!value) return null;
  const shop = await db.shop.findUnique({ where: { id: value }, select: { id: true } });
  return shop?.id ?? null;
}

/**
 * Same validation, but also reports an id that did not resolve so the page can
 * warn instead of silently widening to every store.
 */
export async function resolveShopFilterStrict(
  value: string | null,
): Promise<{ shopId: string | null; unknownShop: string | null }> {
  const raw = value?.trim() || null;
  if (!raw) return { shopId: null, unknownShop: null };
  const shopId = await resolveShopFilter(raw);
  return { shopId, unknownShop: shopId ? null : raw };
}

export async function logsOverview(filters: LogFilters): Promise<LogsOverview> {
  const since = windowStart(filters.hours);

  // The whole window, minimal columns — powers the tiles, the top-events table
  // and both filter dropdowns from one scan. Bounded by the volume ceiling in
  // spec 21 (errors/warnings only, 14-day retention); the cap is a backstop.
  const scan = await db.appLog.findMany({
    where: { occurredAt: { gte: since } },
    select: { level: true, event: true, shopId: true, occurredAt: true },
    orderBy: { occurredAt: "desc" },
    take: AGGREGATE_SCAN_LIMIT + 1,
  });
  const truncatedAggregate = scan.length > AGGREGATE_SCAN_LIMIT;
  const window = truncatedAggregate ? scan.slice(0, AGGREGATE_SCAN_LIMIT) : scan;

  let errors = 0;
  let warnings = 0;
  const shopsSeen = new Set<string>();
  const events = new Map<string, { level: string; count: number; shops: Set<string>; lastSeen: Date }>();

  for (const row of window) {
    if (row.level === "error") errors += 1;
    else warnings += 1;
    if (row.shopId) shopsSeen.add(row.shopId);

    const existing = events.get(row.event);
    if (existing) {
      existing.count += 1;
      if (row.shopId) existing.shops.add(row.shopId);
      if (row.occurredAt > existing.lastSeen) existing.lastSeen = row.occurredAt;
      // An event code that fires at both levels reads as the worse one.
      if (row.level === "error") existing.level = "error";
    } else {
      events.set(row.event, {
        level: row.level,
        count: 1,
        shops: new Set(row.shopId ? [row.shopId] : []),
        lastSeen: row.occurredAt,
      });
    }
  }

  const topEvents: EventSummary[] = [...events.entries()]
    .map(([event, agg]) => ({
      event,
      level: agg.level,
      count: agg.count,
      shops: agg.shops.size,
      lastSeen: agg.lastSeen.toISOString(),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);

  // Filtered detail rows.
  const where: Prisma.AppLogWhereInput = { occurredAt: { gte: since } };
  if (filters.level) where.level = filters.level;
  if (filters.event) where.event = filters.event;
  if (filters.shopId) where.shopId = filters.shopId;

  const detail = await db.appLog.findMany({
    where,
    orderBy: { occurredAt: "desc" },
    take: ROW_LIMIT + 1,
  });
  const truncatedRows = detail.length > ROW_LIMIT;
  const page = truncatedRows ? detail.slice(0, ROW_LIMIT) : detail;

  // Label every shop referenced by the window OR the current page, so the
  // dropdown and the table agree even when a filter narrows the page.
  const shopIds = [...new Set([...shopsSeen, ...page.map((r) => r.shopId).filter(Boolean)])] as string[];
  const shops = shopIds.length
    ? await db.shop.findMany({
        where: { id: { in: shopIds } },
        select: { id: true, domain: true, name: true },
      })
    : [];
  const labelOf = new Map(shops.map((s) => [s.id, s.name || s.domain]));

  const rows: LogRow[] = page.map((row) => ({
    id: row.id,
    level: row.level,
    event: row.event,
    message: row.message,
    occurredAt: row.occurredAt.toISOString(),
    shopId: row.shopId,
    // A purged shop can still be named by a row that outlived it by seconds.
    shopLabel: row.shopId ? (labelOf.get(row.shopId) ?? "(removed store)") : null,
    context: row.context === null ? null : JSON.stringify(row.context, null, 2),
  }));

  return {
    filters,
    errors,
    warnings,
    shopsAffected: shopsSeen.size,
    truncatedAggregate,
    topEvents,
    rows,
    truncatedRows,
    eventOptions: [...events.keys()].sort(),
    shopOptions: shops
      .map((s) => ({ id: s.id, label: s.name || s.domain }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  };
}
