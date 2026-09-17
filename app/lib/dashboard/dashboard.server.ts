import { Prisma } from "@prisma/client";
import db from "../../db.server";
import { requireShopId } from "../tenancy.server";
import { getEmbedDetail, type EmbedStatus } from "../embed-status.server";
import { loadShopSettings } from "../settings/save.server";
import { BRIDGE_TYPES } from "../ingestion/content-sync.server";
import { SHOWABLE_PRODUCT } from "../search/showable";
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

// ── Setup checklist: "Get your AI ready" (spec 13, revised 2026-09-14) ──────

export type ChecklistAction =
  | { kind: "navigate"; href: string }
  /** Theme editor — the action a merchant needs is the customiser itself. */
  | { kind: "external"; url: string }
  /** Runs every catalogue/content sync from the dashboard (step 1). */
  | { kind: "sync" }
  /** Like navigate, but the button stays after the step is done (store info:
   *  the step links back to a page the merchant may want to revisit. A DONE
   *  step shows only "Completed" — no Review button (owner 2026-09-16). */
  | { kind: "revisit"; href: string };

export interface ChecklistStep {
  id: "training" | "faqs" | "knowledge" | "instructions" | "chatbox" | "proactive" | "curated" | "embed";
  title: string;
  description: string;
  state: "done" | "todo" | "unknown";
  action: ChecklistAction;
  actionLabel: string;
  /** Live status badge (the storefront embed), mirroring Settings → General. */
  status?: { tone: "success" | "warning" | "critical" | "neutral"; label: string };
  /** One extra line under the description (draft-theme case). */
  note?: string;
}

export type TrainingSourceKey = "products" | "collections" | "pages" | "blogs" | "discounts";

export interface TrainingSource {
  key: TrainingSourceKey;
  label: string;
  /** Rows the AI reads: learn switch on AND the type's master Learn switch on. */
  learned: number;
  total: number;
  /** When this source's own sync last finished (ISO) — drives "Syncing…". */
  syncedAt: string | null;
  /** The type's master Learn switch (Training tab). Off ⇒ learned is 0 and the
   *  row must say "Learning off", not "Learned". */
  masterOn: boolean;
}

export interface TrainingSummary {
  sources: TrainingSource[];
  learnedTotal: number;
  /** Latest of the per-source sync times. */
  lastSyncedAt: string | null;
  /** Product sync is the only one that records running / error. */
  productStatus: "idle" | "running" | "error";
}

export interface SetupChecklist {
  steps: ChecklistStep[];
  completed: number;
  total: number;
  embedStatus: EmbedStatus;
  training: TrainingSummary;
}

/** The same four states Settings → General shows, so the two never disagree. */
function embedStatusBadge(status: EmbedStatus): ChecklistStep["status"] {
  if (status === "on") return { tone: "success", label: "On" };
  if (status === "draft") return { tone: "warning", label: "Draft theme only" };
  if (status === "off") return { tone: "critical", label: "Off" };
  return { tone: "neutral", label: "Unknown" };
}

type LearnGroup = { learnEnabled: boolean; _count: { _all: number } }[];

function learnCounts(
  groups: LearnGroup,
  masterOn: boolean,
): { learned: number; total: number; masterOn: boolean } {
  const total = groups.reduce((sum, g) => sum + g._count._all, 0);
  const on = groups.find((g) => g.learnEnabled)?._count._all ?? 0;
  return { learned: masterOn ? on : 0, total, masterOn };
}

const iso = (date: Date | null | undefined) => (date ? date.toISOString() : null);

export async function setupChecklist(
  shopId: string,
  shopDomain: string,
): Promise<SetupChecklist> {
  requireShopId(shopId);

  const [
    embedDetail,
    widgetRow,
    syncState,
    faqsPublished,
    customSources,
    curatedPublished,
    activeCampaigns,
    settings,
    productsTotal,
    productsShowable,
    collections,
    pages,
    articles,
    discounts,
  ] = await Promise.all([
    getEmbedDetail(shopDomain),
    db.widgetSettings.findUnique({ where: { shopId }, select: { id: true } }),
    db.syncState.findUnique({ where: { shopId } }),
    db.faq.count({ where: { shopId, status: "published" } }),
    // Custom knowledge only: the FAQ / Pages / Blogs bridges are managed on
    // their own tabs and would otherwise complete this step by themselves.
    db.dataSource.count({
      where: { shopId, status: "active", type: { notIn: ["faq", "store_info", ...BRIDGE_TYPES] } },
    }),
    db.curatedAnswer.count({ where: { shopId, status: "published" } }),
    db.campaign.count({ where: { shopId, status: "active" } }),
    loadShopSettings(shopId),
    // Products the AI can actually SHOW (QA-U2) — the same SHOWABLE_PRODUCT
    // rule the pipeline cards with, so a draft or unpublished product with its
    // learn switch on is not reported as learned.
    db.product.count({ where: { shopId } }),
    db.product.count({ where: { shopId, ...SHOWABLE_PRODUCT } }),
    db.collection.groupBy({ by: ["learnEnabled"], where: { shopId }, _count: { _all: true } }),
    db.storePage.groupBy({ by: ["learnEnabled"], where: { shopId }, _count: { _all: true } }),
    db.blogArticle.groupBy({ by: ["learnEnabled"], where: { shopId }, _count: { _all: true } }),
    db.discount.groupBy({ by: ["learnEnabled"], where: { shopId }, _count: { _all: true } }),
  ]);

  const learn = settings.learn;
  const sources: TrainingSource[] = [
    {
      key: "products",
      label: "Products",
      learned: learn.products ? productsShowable : 0,
      total: productsTotal,
      masterOn: learn.products,
      syncedAt: iso(syncState?.productSyncAt),
    },
    {
      key: "collections",
      label: "Collections",
      ...learnCounts(collections, learn.collections),
      syncedAt: iso(syncState?.collectionSyncAt),
    },
    {
      key: "pages",
      label: "Pages",
      ...learnCounts(pages, learn.pages),
      syncedAt: iso(syncState?.pageSyncAt),
    },
    {
      key: "blogs",
      label: "Blogs",
      ...learnCounts(articles, learn.blogs),
      syncedAt: iso(syncState?.articleSyncAt),
    },
    {
      key: "discounts",
      label: "Discounts",
      ...learnCounts(discounts, learn.discounts),
      syncedAt: iso(syncState?.discountSyncAt),
    },
  ];
  const learnedTotal = sources.reduce((sum, s) => sum + s.learned, 0);
  const syncTimes = sources.flatMap((s) => (s.syncedAt ? [s.syncedAt] : [])).sort();
  const productStatus: TrainingSummary["productStatus"] =
    syncState?.status === "running" || syncState?.status === "error" ? syncState.status : "idle";

  const embedStatus = embedDetail.status;
  // Same deep link as Settings → General "Turn on": activateAppId pre-selects
  // the chat-widget app embed in the theme editor. Dropped once the embed is
  // already ON — Shopify has no deactivate parameter, so re-sending activate
  // would be a no-op dressed as an action; that merchant just wants the editor.
  const apiKey = process.env.SHOPIFY_API_KEY || "";
  const themeEditorUrl = `https://${shopDomain}/admin/themes/current/editor?context=apps${
    apiKey && embedStatus !== "on" ? `&activateAppId=${apiKey}/chat-widget` : ""
  }`;

  // Step 1 is done once a sync has run AND the AI can use something from it
  // (QA-U2): a sync that left every type switched off, or nothing showable, has
  // not trained the AI on anything.
  const trained = Boolean(syncState?.productSyncAt) && learnedTotal > 0;
  const synced = Boolean(syncState?.productSyncAt);
  const aiWrittenUnreviewed = settings.aiSetup.status === "done" && !settings.aiSetup.reviewedAt;
  const steps: ChecklistStep[] = [
    {
      id: "training",
      title: "Train AI data — catalog & store",
      description: trained
        ? `Products, Collections, Pages, Blogs and Discounts — ${learnedTotal.toLocaleString("en-US")} item${learnedTotal === 1 ? "" : "s"} learned.`
        : synced
          ? "Synced — but nothing is switched on for your AI yet. Turn learning on for your products or content."
          : "Sync your products, collections, pages, blogs and discounts so your AI can learn them.",
      state: trained ? "done" : "todo",
      action: { kind: "sync" },
      actionLabel: "Sync now",
    },
    {
      id: "faqs",
      title: "Train AI data — FAQs",
      description: "Add the questions shoppers ask most, with your answers.",
      state: faqsPublished >= 1 ? "done" : "todo",
      action: { kind: "navigate", href: "/app/ai-agent/training?tab=faqs" },
      actionLabel: "Add FAQs",
    },
    {
      id: "knowledge",
      title: "Train AI data — custom knowledge",
      description: "PDFs, files, policies, or any specific website URL.",
      state: customSources >= 1 ? "done" : "todo",
      action: { kind: "navigate", href: "/app/ai-agent/training?tab=knowledge" },
      actionLabel: "Add sources",
    },
    // Done once Instructions → General → Store info has text (user decision
    // 2026-09-14) — and, when AI wrote it from the store's data (spec 26), once
    // the merchant has reviewed it (saved General).
    aiWrittenUnreviewed
      ? {
          id: "instructions",
          title: "Review your AI instructions",
          description:
            "Your assistant's store info and instructions were written from your Shopify store. Check them and press Save.",
          state: "todo",
          action: { kind: "revisit", href: "/app/ai-agent/instructions" },
          actionLabel: "Review",
        }
      : {
          id: "instructions",
          title: "Add your store info",
          description:
            "Tell your AI about your store — what you sell, where you're based and how shoppers can reach you.",
          state: settings.storeInfo.about.trim() ? "done" : "todo",
          action: { kind: "revisit", href: "/app/ai-agent/instructions#store-info" },
          actionLabel: "Add store info",
        },
    {
      id: "chatbox",
      title: "Chatbox settings & appearance",
      description: "Colours, position and greeting for your storefront widget.",
      state: widgetRow ? "done" : "todo",
      action: { kind: "navigate", href: "/app/chatbox" },
      actionLabel: "Customize",
    },
    {
      id: "proactive",
      title: "Proactive chat",
      description: "Trigger messages that reach shoppers before they ask.",
      state: activeCampaigns >= 1 ? "done" : "todo",
      action: { kind: "navigate", href: "/app/proactive-chat" },
      actionLabel: "Create campaign",
    },
    {
      id: "curated",
      title: "Curated answers",
      description: "Hand-write replies for your highest-intent questions.",
      // One published answer, not five (spec 13 revision: easier to set up).
      state: curatedPublished >= 1 ? "done" : "todo",
      action: { kind: "navigate", href: "/app/curated-answers" },
      actionLabel: "Start",
    },
    {
      id: "embed",
      title: "Enable AI agent on storefront",
      description: "Turn on the app embed so the chat goes live for shoppers.",
      state: embedStatus === "on" ? "done" : embedStatus === "unknown" ? "unknown" : "todo",
      action: { kind: "external", url: themeEditorUrl },
      actionLabel:
        embedStatus === "on"
          ? "Open theme editor"
          : embedStatus === "unknown"
            ? "Check in theme editor"
            : "Turn on",
      status: embedStatusBadge(embedStatus),
      // "draft" is a real state, not a near-miss of "off": the merchant HAS
      // turned the embed on, just on a theme that is not live. Same wording as
      // Settings → General.
      ...(embedStatus === "draft"
        ? {
            note: `Enabled on ${embedDetail.themeName ?? "an unpublished theme"} — shoppers won't see the chat until that theme is published, or you turn it on for your live theme.`,
          }
        : {}),
    },
  ];

  // An "unknown" embed status (no read_themes) can't be completed from here,
  // so it is excluded from the progress total and shown as information.
  const countable = steps.filter((step) => step.state !== "unknown");
  return {
    steps,
    completed: countable.filter((step) => step.state === "done").length,
    total: countable.length,
    embedStatus,
    training: {
      sources,
      learnedTotal,
      lastSyncedAt: syncTimes.length ? syncTimes[syncTimes.length - 1] : null,
      productStatus,
    },
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
