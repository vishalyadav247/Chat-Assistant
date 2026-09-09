import { Prisma } from "@prisma/client";
import db from "../../db.server";
import { requireShopId } from "../tenancy.server";
import { getEmbedDetail, type EmbedStatus } from "../embed-status.server";
import { clampRange } from "../analytics/reports.server";
import { ANALYTICS_RANGES, ANALYTICS_RANGE_DAYS, type AnalyticsRange } from "../analytics/shared";

// Dashboard aggregates (spec 13). Every query is shop-scoped and excludes
// isTest conversations (Test AI console traffic must never skew merchant KPIs).
//
// DELTA (spec 13, noted in the spec's Out of scope): the "Assisted revenue" /
// "Total sales share" KPIs need order attribution (read_orders — a Protected
// Customer Data decision, spec 17). v1 ships the chat add-to-cart count
// ("added_to_cart" analytics events, recorded only by the real storefront
// widget, never by Test AI) as the assisted-revenue proxy.

// ONE range vocabulary across the app: the dashboard used to offer its own
// narrower set (no "3m"), so Pro — whose analytics_range_days is exactly 90 —
// had no option that matched its own allowance, and the two pages disagreed
// about what a merchant could pick.
export type DashboardRange = AnalyticsRange;

export const DASHBOARD_RANGES: DashboardRange[] = ANALYTICS_RANGES;

const RANGE_DAYS = ANALYTICS_RANGE_DAYS;
const DAY_MS = 24 * 60 * 60 * 1000;
export const LIVE_WINDOW_MS = 5 * 60 * 1000; // "live" = activity within 5 minutes

export interface DashboardMetrics {
  range: DashboardRange;
  totalConversations: number;
  /** Percent vs the previous equal period; null when the previous period is 0. */
  totalDelta: number | null;
  liveCount: number;
  /** Chat add-to-carts (assisted-revenue proxy, see DELTA above). */
  atcCount: number;
  atcDelta: number | null;
  resolutionRate: { resolved: number; total: number; pct: number };
  period: { from: string; to: string };
  compare: { from: string; to: string };
  /** Bucketed counts over the period (day buckets; month for 12m) — sparklines. */
  series: { conversations: number[]; atc: number[] };
}

// ── Sparkline series (bucketed counts) ──────────────────────────────────────

type BucketUnit = "day" | "month";

function bucketKey(date: Date, unit: BucketUnit): string {
  return unit === "day"
    ? `${date.getUTCFullYear()}-${date.getUTCMonth()}-${date.getUTCDate()}`
    : `${date.getUTCFullYear()}-${date.getUTCMonth()}`;
}

function fillBuckets(
  rows: { bucket: Date; n: bigint }[],
  from: Date,
  unit: BucketUnit,
  count: number,
): number[] {
  const byKey = new Map(rows.map((r) => [bucketKey(new Date(r.bucket), unit), Number(r.n)]));
  const out: number[] = [];
  const cursor = new Date(from);
  cursor.setUTCHours(0, 0, 0, 0);
  if (unit === "month") cursor.setUTCDate(1);
  for (let i = 0; i < count; i++) {
    out.push(byKey.get(bucketKey(cursor, unit)) ?? 0);
    if (unit === "day") cursor.setUTCDate(cursor.getUTCDate() + 1);
    else cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return out;
}

async function conversationSeries(
  shopId: string,
  from: Date,
  unit: BucketUnit,
  count: number,
): Promise<number[]> {
  const rows = await db.$queryRaw<{ bucket: Date; n: bigint }[]>(Prisma.sql`
    SELECT date_trunc(${unit}, "startedAt") AS bucket, count(*)::bigint AS n
    FROM "conversations"
    WHERE "shopId" = ${shopId} AND "isTest" = false AND "startedAt" >= ${from}
    GROUP BY 1 ORDER BY 1
  `);
  return fillBuckets(rows, from, unit, count);
}

async function atcSeries(
  shopId: string,
  from: Date,
  unit: BucketUnit,
  count: number,
): Promise<number[]> {
  const rows = await db.$queryRaw<{ bucket: Date; n: bigint }[]>(Prisma.sql`
    SELECT date_trunc(${unit}, "occurredAt") AS bucket, count(*)::bigint AS n
    FROM "analytics_events"
    WHERE "shopId" = ${shopId} AND "type" = 'added_to_cart' AND "occurredAt" >= ${from}
    GROUP BY 1 ORDER BY 1
  `);
  return fillBuckets(rows, from, unit, count);
}

function pctDelta(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

export async function dashboardMetrics(
  shopId: string,
  range: DashboardRange,
): Promise<DashboardMetrics> {
  requireShopId(shopId);
  // Plan gate: the dashboard reads the SAME conversation history the analytics
  // reports do, but it never clamped — so a Free shop (7 days) asking for "12m"
  // got a full year of KPIs, deltas and series here while /app/analytics
  // correctly refused it. Enforced at the data source for the same reason
  // clampRange itself is: a hand-crafted ?range=12m must not outrun the loader.
  range = await clampRange(shopId, range);
  const now = new Date();
  const days = RANGE_DAYS[range];
  const from = new Date(now.getTime() - days * DAY_MS);
  const prevFrom = new Date(from.getTime() - days * DAY_MS);
  const liveSince = new Date(now.getTime() - LIVE_WINDOW_MS);

  const unit: BucketUnit = range === "12m" ? "month" : "day";
  // The window is rolling (from = now − N days), so it touches N+1 calendar
  // days: the partial first day through today. Buckets start at midnight of
  // `from` and the SQL still filters `>= from`, so the series sums to the KPI
  // total and today's activity lands in the last bucket. 12m: 13 month buckets.
  const bucketCount = unit === "day" ? days + 1 : 13;

  const [current, previous, live, resolved, atcCurrent, atcPrevious, convSeries, cartSeries] =
    await Promise.all([
      db.conversation.count({ where: { shopId, isTest: false, startedAt: { gte: from } } }),
      db.conversation.count({
        where: { shopId, isTest: false, startedAt: { gte: prevFrom, lt: from } },
      }),
      db.conversation.count({
        where: { shopId, isTest: false, status: "open", lastMessageAt: { gte: liveSince } },
      }),
      db.conversation.count({
        where: { shopId, isTest: false, status: "resolved", startedAt: { gte: from } },
      }),
      db.analyticsEvent.count({
        where: { shopId, type: "added_to_cart", occurredAt: { gte: from } },
      }),
      db.analyticsEvent.count({
        where: { shopId, type: "added_to_cart", occurredAt: { gte: prevFrom, lt: from } },
      }),
      conversationSeries(shopId, from, unit, bucketCount),
      atcSeries(shopId, from, unit, bucketCount),
    ]);

  return {
    range,
    totalConversations: current,
    totalDelta: pctDelta(current, previous),
    liveCount: live,
    atcCount: atcCurrent,
    atcDelta: pctDelta(atcCurrent, atcPrevious),
    resolutionRate: {
      resolved,
      total: current,
      pct: current === 0 ? 0 : Math.round((resolved / current) * 100),
    },
    period: { from: from.toISOString(), to: now.toISOString() },
    compare: { from: prevFrom.toISOString(), to: from.toISOString() },
    series: { conversations: convSeries, atc: cartSeries },
  };
}

// ── Setup checklist ─────────────────────────────────────────────────────────

export interface ChecklistStep {
  id: string;
  label: string;
  state: "done" | "todo" | "unknown";
  /** Internal admin route for the deep link. */
  href: string;
  linkLabel: string;
  /** External URL (theme editor). The embed step always uses it: the action a
   *  merchant needs is the theme customiser, not another admin page. */
  externalUrl?: string;
  /** Live status shown on the row, mirroring Settings -> General. */
  status?: { tone: "success" | "warning" | "critical" | "neutral"; label: string };
  /** One line of explanation under the label (draft-theme case). */
  note?: string;
}

export interface SetupChecklist {
  steps: ChecklistStep[];
  completed: number;
  total: number;
  embedStatus: EmbedStatus;
}

/** The same four states Settings → General shows, so the two never disagree. */
function embedStatusBadge(status: EmbedStatus): ChecklistStep["status"] {
  if (status === "on") return { tone: "success", label: "On" };
  if (status === "draft") return { tone: "warning", label: "Draft theme only" };
  if (status === "off") return { tone: "critical", label: "Off" };
  return { tone: "neutral", label: "Unknown" };
}

export async function setupChecklist(
  shopId: string,
  shopDomain: string,
): Promise<SetupChecklist> {
  requireShopId(shopId);

  const [embedDetail, widgetRow, syncState, persona, curatedPublished, activeCampaigns] =
    await Promise.all([
      getEmbedDetail(shopDomain),
      db.widgetSettings.findUnique({ where: { shopId }, select: { id: true } }),
      db.syncState.findUnique({ where: { shopId }, select: { productSyncAt: true } }),
      db.persona.findUnique({ where: { shopId }, select: { role: true, behaviours: true } }),
      db.curatedAnswer.count({ where: { shopId, status: "published" } }),
      db.campaign.count({ where: { shopId, status: "active" } }),
    ]);

  const embedStatus = embedDetail.status;
  // Same deep link as Settings → General "Turn on": activateAppId pre-selects
  // the chat-widget app embed in the theme editor. Dropped once the embed is
  // already ON — Shopify has no deactivate parameter, so re-sending activate
  // would be a no-op dressed as an action; that merchant just wants the editor.
  const apiKey = process.env.SHOPIFY_API_KEY || "";
  const themeEditorUrl = `https://${shopDomain}/admin/themes/current/editor?context=apps${
    apiKey && embedStatus !== "on" ? `&activateAppId=${apiKey}/chat-widget` : ""
  }`;

  const steps: ChecklistStep[] = [
    {
      id: "sync",
      label: "Sync your product & store data",
      state: syncState?.productSyncAt ? "done" : "todo",
      href: "/app/ai-agent/training",
      linkLabel: "Data Sources",
    },
    {
      id: "instructions",
      label: "Set up your AI agent instructions",
      state: persona && persona.role.trim() !== "" && persona.behaviours.trim() !== "" ? "done" : "todo",
      href: "/app/ai-agent/instructions",
      linkLabel: "Instructions",
    },
    {
      id: "curated",
      label: "Publish first five curated answers",
      state: curatedPublished >= 5 ? "done" : "todo",
      href: "/app/curated-answers",
      linkLabel: "Curated Answers",
    },
    {
      id: "campaign",
      label: "Launch a proactive chat campaign",
      state: activeCampaigns >= 1 ? "done" : "todo",
      href: "/app/proactive-chat",
      linkLabel: "Proactive Chat",
    },
    {
      id: "widget",
      label: "Customize your chatbox widget",
      state: widgetRow ? "done" : "todo",
      href: "/app/chatbox",
      linkLabel: "Chatbox",
    },
    {
      id: "embed",
      // Reworked 2026-09-09 (user): the step used to read "Embed app to your
      // theme" and send the merchant to Settings — a second admin page that
      // only offers the same theme-editor link. It also said nothing about the
      // current state, so a merchant who had already switched it on saw an
      // apparently unfinished step. Now: plain language about what it does,
      // the theme editor directly, and the live status Settings shows.
      label: "Enable the AI agent on your storefront",
      state: embedStatus === "on" ? "done" : embedStatus === "unknown" ? "unknown" : "todo",
      // Kept so the row still has an in-admin destination if the editor link is
      // ever unavailable; externalUrl is what the button actually uses.
      href: "/app/settings?tab=general",
      linkLabel:
        embedStatus === "on"
          ? "Open Theme editor"
          : embedStatus === "unknown"
            ? "Check in Theme editor"
            : "Turn on in Theme editor",
      externalUrl: themeEditorUrl,
      status: embedStatusBadge(embedStatus),
      // "draft" is a real state, not a near-miss of "off": the merchant HAS
      // turned the embed on, just on a theme that is not live. Saying only
      // "To do" there reads as "your setup didn't register" and sends them to
      // redo work they already did. Same wording as Settings → General.
      ...(embedStatus === "draft"
        ? {
            note: `Enabled on ${embedDetail.themeName ?? "an unpublished theme"} — shoppers won't see the chat until that theme is published, or you turn it on for your live theme.`,
          }
        : {}),
    }
  ];

  // An "unknown" embed status (no read_themes) can't be completed from here,
  // so it is excluded from the progress total (N of 5) and rendered as an
  // informational row instead of an incomplete step.
  const countable = steps.filter((step) => step.state !== "unknown");
  return {
    steps,
    completed: countable.filter((step) => step.state === "done").length,
    total: countable.length,
    embedStatus,
  };
}

// ── Live conversations feed ─────────────────────────────────────────────────

export interface LiveFeedItem {
  id: string;
  initials: string;
  preview: string;
  tag: "live" | "waiting" | "idle";
  lastMessageAt: string; // ISO — relative time rendered client-side
}

function initialsFor(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "SH"; // anonymous shopper
  const first = parts[0][0] ?? "";
  const second = parts.length > 1 ? (parts[parts.length - 1][0] ?? "") : (parts[0][1] ?? "");
  return (first + second).toUpperCase() || "SH";
}

export async function liveFeed(shopId: string): Promise<LiveFeedItem[]> {
  requireShopId(shopId);

  const convos = await db.conversation.findMany({
    where: { shopId, isTest: false, status: "open" },
    orderBy: { lastMessageAt: "desc" },
    take: 4,
    select: { id: true, contactId: true, mode: true, handover: true, lastMessageAt: true },
  });
  if (convos.length === 0) return [];

  const contactIds = [...new Set(convos.flatMap((c) => (c.contactId ? [c.contactId] : [])))];
  const convoIds = convos.map((c) => c.id);
  const [contacts, lastShopperMessages] = await Promise.all([
    contactIds.length > 0
      ? db.contact.findMany({
          where: { shopId, id: { in: contactIds } },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
    // One DISTINCT ON pass rather than a findFirst per conversation — the feed
    // re-renders on every dashboard poll, so N+1 here is N+1 per poll.
    db.$queryRaw<{ conversationId: string; content: string }[]>`
      SELECT DISTINCT ON ("conversationId") "conversationId", "content"
      FROM "messages"
      WHERE "shopId" = ${shopId}
        AND "conversationId" IN (${Prisma.join(convoIds)})
        AND "role" = 'in'
      ORDER BY "conversationId", "createdAt" DESC`,
  ]);

  const nameById = new Map(contacts.map((c) => [c.id, c.name]));
  const previewByConvo = new Map(lastShopperMessages.map((m) => [m.conversationId, m.content]));
  const liveSince = Date.now() - LIVE_WINDOW_MS;

  return convos.map((convo) => {
    const raw = previewByConvo.get(convo.id) ?? "";
    const trimmed = raw.length > 90 ? `${raw.slice(0, 90)}…` : raw;
    return {
      id: convo.id,
      initials: initialsFor(convo.contactId ? nameById.get(convo.contactId) : null),
      preview: trimmed ? `“${trimmed}”` : "New conversation",
      tag:
        convo.handover && convo.mode === "human"
          ? "waiting"
          : convo.lastMessageAt.getTime() >= liveSince
            ? "live"
            : "idle",
      lastMessageAt: convo.lastMessageAt.toISOString(),
    };
  });
}
