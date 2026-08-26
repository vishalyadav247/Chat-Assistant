import { Prisma } from "@prisma/client";
import db from "../../db.server";
import { recordEvent } from "../analytics/events.server";
import { getShopConfig } from "../config/shop-config.server";
import { hasFeature } from "../billing/plans.server";
import { notifyMerchantHandover } from "../notify.server";
import { touchAgentPresence } from "../settings/availability.server";
import { shopSettingsSchema } from "../settings/schemas";
import { requireShopId } from "../tenancy.server";

// Inbox domain logic (spec 10). Everything here is shop-scoped; the route
// files (app.inbox / proxy.messages / proxy.handover-form) stay thin so the
// acceptance scripts can drive these functions directly.

export const RESOLVED_SYS_MESSAGE = "Conversation resolved.";
export const BLOCKED_SYS_MESSAGE = "Visitor blocked.";

// ── Conversation list (filters rail + list column) ──────────────────────────

export interface InboxListRow {
  id: string;
  name: string | null;
  status: string;
  mode: string;
  starred: boolean;
  blocked: boolean;
  unread: boolean;
  handover: boolean;
  assigneeId: string | null;
  lastMessageAt: string; // ISO
  preview: string;
}

export const INBOX_FILTER_KEYS = [
  "all",
  "open",
  "resolved",
  "unassigned",
  "handover",
  "starred",
  "blocked",
] as const;
export type InboxFilterKey = (typeof INBOX_FILTER_KEYS)[number];

// The ONE definition of what each filter means. The client mirrors these as
// predicates in InboxShared.FILTERS for labels/optimistic UI, and
// scripts/qa/features.test.ts asserts the two agree row-for-row — if they ever
// drift, the list and the badge would disagree with each other.
const FILTER_WHERE: Record<InboxFilterKey, Prisma.ConversationWhereInput> = {
  all: { blocked: false },
  open: { blocked: false, status: "open" },
  resolved: { blocked: false, status: "resolved" },
  unassigned: { blocked: false, status: "open", assigneeId: null },
  handover: { blocked: false, handover: true },
  starred: { blocked: false, starred: true },
  blocked: { blocked: true },
};

export interface InboxCounts extends Record<InboxFilterKey, number> {
  /** Red badge on "All" — unread AND open AND not blocked. */
  unreadOpen: number;
}

/**
 * Exact per-filter counts across ALL of the shop's conversations.
 *
 * These must NOT be derived from the paged list: the list is capped, so counting
 * within it undercounts every tab as soon as a shop passes the cap (a Plus shop
 * is entitled to 1000 conversations a month, so that is weeks, not years). One
 * aggregate pass over the [shopId, isTest, lastMessageAt] index instead.
 */
export async function getInboxCounts(shopId: string): Promise<InboxCounts> {
  requireShopId(shopId);
  const [row] = await db.$queryRaw<
    Array<Record<InboxFilterKey | "unreadOpen", bigint>>
  >`
    SELECT
      COUNT(*) FILTER (WHERE NOT blocked)                                          AS "all",
      COUNT(*) FILTER (WHERE NOT blocked AND status = 'open')                      AS "open",
      COUNT(*) FILTER (WHERE NOT blocked AND status = 'resolved')                  AS "resolved",
      COUNT(*) FILTER (WHERE NOT blocked AND status = 'open'
                             AND "assigneeId" IS NULL)                             AS "unassigned",
      COUNT(*) FILTER (WHERE NOT blocked AND handover)                             AS "handover",
      COUNT(*) FILTER (WHERE NOT blocked AND starred)                              AS "starred",
      COUNT(*) FILTER (WHERE blocked)                                              AS "blocked",
      COUNT(*) FILTER (WHERE NOT blocked AND unread AND status = 'open')           AS "unreadOpen"
    FROM conversations
    WHERE "shopId" = ${shopId} AND "isTest" = false`;
  const n = (v: bigint | undefined) => Number(v ?? 0n);
  return {
    all: n(row?.all),
    open: n(row?.open),
    resolved: n(row?.resolved),
    unassigned: n(row?.unassigned),
    handover: n(row?.handover),
    starred: n(row?.starred),
    blocked: n(row?.blocked),
    unreadOpen: n(row?.unreadOpen),
  };
}

/**
 * Resolve a free-text search to the contact ids it matches, reproducing the
 * client's `displayName(name)` fallback chain exactly: contact.name, else
 * contact.email, else the literal "Visitor".
 *
 * Returns `null` when the term matches "Visitor", meaning "also include
 * conversations that have no contact at all".
 */
async function contactIdsMatching(
  shopId: string,
  term: string,
): Promise<{ ids: string[]; includeAnonymous: boolean }> {
  const contacts = await db.contact.findMany({
    where: {
      shopId,
      OR: [
        { name: { contains: term, mode: "insensitive" } },
        { email: { contains: term, mode: "insensitive" } },
      ],
    },
    select: { id: true, name: true, email: true },
  });
  // A contact whose name is set but does not match must NOT be pulled in by an
  // email match, because the list never shows that email — displayName stops at
  // the name. Filtering here keeps the server result identical to what the
  // merchant can actually see on screen.
  const lower = term.toLowerCase();
  const ids = contacts
    .filter((c) => {
      const shown = (c.name?.trim() || c.email?.trim() || "Visitor").toLowerCase();
      return shown.includes(lower);
    })
    .map((c) => c.id);
  return { ids, includeAnonymous: "visitor".includes(lower) };
}

export interface ListConversationsOptions {
  /** Rail selection. Omitted = no filter at all (every row, blocked included). */
  filter?: InboxFilterKey;
  /** List-column search box. Matches the displayed name. */
  search?: string;
  /** "Unread" toggle in the list header. */
  unreadOnly?: boolean;
  /** Page size. */
  take?: number;
}

/**
 * Non-test conversations for the shop, newest first, with contact name +
 * last-message preview.
 *
 * `opts.filter` / `opts.search` / `opts.unreadOnly` are applied IN THE DATABASE.
 * They used to be applied in the browser over whatever the capped query happened
 * to return, which meant every tab silently showed only the subset of its
 * category that fell inside the newest `take` rows.
 */
export async function listConversations(
  shopId: string,
  opts: ListConversationsOptions = {},
): Promise<InboxListRow[]> {
  requireShopId(shopId);
  // "Agent online" (spec 16) = an admin session active in the inbox. The list
  // loader runs on every inbox render and on the SSE/30s revalidation, so it is
  // the heartbeat; the widget status line and executeHandover read it back
  // through isAgentOnline(). Shopper-facing functions below never stamp it.
  touchAgentPresence(shopId);

  const term = (opts.search ?? "").trim();
  let searchWhere: Prisma.ConversationWhereInput | null = null;
  if (term) {
    const { ids, includeAnonymous } = await contactIdsMatching(shopId, term);
    const clauses: Prisma.ConversationWhereInput[] = [];
    if (ids.length) clauses.push({ contactId: { in: ids } });
    if (includeAnonymous) clauses.push({ contactId: null });
    // No contact matched and the term is not "visitor" — nothing can match, and
    // an empty OR in Prisma would wrongly return everything.
    if (clauses.length === 0) return [];
    searchWhere = { OR: clauses };
  }

  const rows = await db.conversation.findMany({
    where: {
      shopId,
      isTest: false,
      ...(opts.filter ? FILTER_WHERE[opts.filter] : {}),
      ...(opts.unreadOnly ? { unread: true } : {}),
      ...(searchWhere ?? {}),
    },
    orderBy: { lastMessageAt: "desc" },
    take: opts.take ?? 300,
    select: {
      id: true,
      contactId: true,
      status: true,
      mode: true,
      starred: true,
      blocked: true,
      unread: true,
      handover: true,
      assigneeId: true,
      lastMessageAt: true,
    },
  });
  if (rows.length === 0) return [];

  const contactIds = [...new Set(rows.map((r) => r.contactId).filter((id): id is string => !!id))];
  const contacts = contactIds.length
    ? await db.contact.findMany({
        where: { shopId, id: { in: contactIds } },
        select: { id: true, name: true, email: true },
      })
    : [];
  const contactById = new Map(contacts.map((c) => [c.id, c]));

  // Latest message per conversation in one pass (DISTINCT ON — shopId first).
  // Columns are camelCase (no @map in the schema) and MUST be quoted.
  const ids = rows.map((r) => r.id);
  const previews = ids.length
    ? await db.$queryRaw<{ conversationId: string; content: string }[]>`
        SELECT DISTINCT ON ("conversationId") "conversationId", content
        FROM messages
        WHERE "shopId" = ${shopId} AND "conversationId" IN (${Prisma.join(ids)})
        ORDER BY "conversationId", "createdAt" DESC`
    : [];
  const previewById = new Map(previews.map((p) => [p.conversationId, p.content]));

  return rows.map((r) => {
    const contact = r.contactId ? contactById.get(r.contactId) : undefined;
    return {
      id: r.id,
      name: contact?.name || contact?.email || null,
      status: r.status,
      mode: r.mode,
      starred: r.starred,
      blocked: r.blocked,
      unread: r.unread,
      handover: r.handover,
      assigneeId: r.assigneeId,
      lastMessageAt: r.lastMessageAt.toISOString(),
      preview: (previewById.get(r.id) ?? "").slice(0, 120),
    };
  });
}

// ── Active conversation (thread + details columns) ──────────────────────────

export interface InboxThreadMessage {
  id: string;
  role: string;
  author: string;
  /** Team member who sent an agent reply (null = AI / admin reply / legacy). */
  authorMemberId: string | null;
  content: string;
  createdAt: string; // ISO
  seenAt: string | null;
}

export interface InboxConversationDetail {
  id: string;
  status: string;
  mode: string;
  starred: boolean;
  blocked: boolean;
  unread: boolean;
  handover: boolean;
  assigneeId: string | null;
  rating: number | null;
  pageContext: unknown;
  startedAt: string;
  contact: {
    name: string | null;
    email: string | null;
    phone: string | null;
    type: string;
    /** Looks up this shopper's orders; the id itself is never displayed. */
    shopifyCustomerId: string | null;
  } | null;
  messages: InboxThreadMessage[];
}

export async function getConversationDetail(
  shopId: string,
  conversationId: string,
): Promise<InboxConversationDetail | null> {
  requireShopId(shopId);
  touchAgentPresence(shopId);
  const convo = await db.conversation.findFirst({
    where: { id: conversationId, shopId, isTest: false },
  });
  if (!convo) return null;

  // `inbox_cart_view` is a paid feature. The gate lives HERE, at the data
  // source, rather than in the route: hiding the cart in the component still
  // shipped it in the loader payload, where it was readable straight out of the
  // network response, and any other caller would have leaked it too.
  //
  // Only `cart` is removed. The same blob carries browsed pages and device info,
  // which every plan is entitled to — dropping the whole object would quietly
  // delete two ungated features.
  const shop = await db.shop.findUnique({ where: { id: shopId }, select: { plan: true } });
  let pageContext = convo.pageContext;
  if (!hasFeature(shop?.plan ?? "free", "inbox_cart_view") && pageContext && typeof pageContext === "object") {
    const { cart: _gated, ...rest } = pageContext as Record<string, unknown>;
    pageContext = rest as typeof pageContext;
  }

  const [contact, messages] = await Promise.all([
    convo.contactId
      ? db.contact.findFirst({
          where: { id: convo.contactId, shopId },
          select: { name: true, email: true, phone: true, type: true, shopifyCustomerId: true },
        })
      : Promise.resolve(null),
    db.message.findMany({
      where: { shopId, conversationId: convo.id },
      orderBy: { createdAt: "asc" },
      take: 500,
      select: {
        id: true,
        role: true,
        author: true,
        authorMemberId: true,
        content: true,
        createdAt: true,
        seenAt: true,
      },
    }),
  ]);

  return {
    id: convo.id,
    status: convo.status,
    mode: convo.mode,
    starred: convo.starred,
    blocked: convo.blocked,
    unread: convo.unread,
    handover: convo.handover,
    assigneeId: convo.assigneeId,
    rating: convo.rating,
    pageContext,
    startedAt: convo.startedAt.toISOString(),
    contact,
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      author: m.author,
      authorMemberId: m.authorMemberId,
      content: m.content,
      createdAt: m.createdAt.toISOString(),
      seenAt: m.seenAt ? m.seenAt.toISOString() : null,
    })),
  };
}

// ── Merchant actions ────────────────────────────────────────────────────────

/**
 * Merchant reply: message {role out, author agent}; taking over puts the
 * conversation in human mode (AI dormant per spec 10) and reopens if needed.
 * The widget receives it through the proxy.messages 5s poll.
 */
export async function sendAgentReply(
  shopId: string,
  conversationId: string,
  content: string,
  /** Team member who sent it (web surface). Null from the Shopify admin,
   *  where the replier is the store owner and has no member row. */
  memberId?: string | null,
): Promise<boolean> {
  requireShopId(shopId);
  touchAgentPresence(shopId);
  const updated = await db.conversation.updateMany({
    // Blocked visitors can't be replied to (the UI disables the composer; the
    // action path must agree).
    where: { id: conversationId, shopId, blocked: false },
    data: { mode: "human", status: "open", endedAt: null, lastMessageAt: new Date() },
  });
  if (updated.count === 0) return false;
  await db.message.create({
    data: { shopId, conversationId, role: "out", author: "agent", content, authorMemberId: memberId ?? null },
  });
  await recordEvent(shopId, "human_replied", { conversationId });
  return true;
}

/** Resolve (status resolved, sys message, AI resumes) or reopen. */
export async function setResolved(
  shopId: string,
  conversationId: string,
  resolved: boolean,
): Promise<boolean> {
  requireShopId(shopId);
  touchAgentPresence(shopId);
  const updated = await db.conversation.updateMany({
    where: { id: conversationId, shopId },
    data: resolved
      ? { status: "resolved", mode: "ai", endedAt: new Date(), unread: false }
      // Reopen hands the thread back to the AI. Resolve already parks mode at
      // "ai", so this is the invariant made explicit rather than assumed of
      // every row that ever reaches "resolved" (seeds, imports, older builds).
      : { status: "open", mode: "ai", endedAt: null },
  });
  if (updated.count === 0) return false;
  if (resolved) {
    await db.message.create({
      data: {
        shopId,
        conversationId,
        role: "sys",
        author: "system",
        content: RESOLVED_SYS_MESSAGE,
      },
    });
    await recordEvent(shopId, "conversation_resolved", { conversationId, auto: false });
  }
  return true;
}

export async function setStarred(
  shopId: string,
  conversationId: string,
  starred: boolean,
): Promise<boolean> {
  requireShopId(shopId);
  touchAgentPresence(shopId);
  const updated = await db.conversation.updateMany({
    where: { id: conversationId, shopId },
    data: { starred },
  });
  return updated.count > 0;
}

export async function markRead(shopId: string, conversationId: string): Promise<boolean> {
  requireShopId(shopId);
  touchAgentPresence(shopId);
  const updated = await db.conversation.updateMany({
    where: { id: conversationId, shopId },
    data: { unread: false },
  });
  return updated.count > 0;
}

/** Block the visitor's conversation (v1: conversation-level, not IP). */
export async function blockConversation(shopId: string, conversationId: string): Promise<boolean> {
  requireShopId(shopId);
  const updated = await db.conversation.updateMany({
    where: { id: conversationId, shopId },
    data: { blocked: true },
  });
  if (updated.count === 0) return false;
  await db.message.create({
    data: { shopId, conversationId, role: "sys", author: "system", content: BLOCKED_SYS_MESSAGE },
  });
  await recordEvent(shopId, "conversation_blocked", { conversationId });
  return true;
}

/** Hard delete (GDPR expectations): messages then the conversation row. */
export async function deleteConversation(shopId: string, conversationId: string): Promise<boolean> {
  requireShopId(shopId);
  const owned = await db.conversation.findFirst({
    where: { id: conversationId, shopId },
    select: { id: true },
  });
  if (!owned) return false;
  await db.message.deleteMany({ where: { shopId, conversationId } });
  await db.unresolvedQuestion.deleteMany({ where: { shopId, conversationId } });
  await db.conversation.deleteMany({ where: { id: conversationId, shopId } });
  return true;
}

// ── Auto-resolution (spec 10/16) ────────────────────────────────────────────

const UNIT_MS: Record<string, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
};

/**
 * Resolve open conversations idle longer than each shop's ShopSettings
 * inbox.autoResolve window. Pure function — the job scheduler (orchestrator)
 * wires the cron. Returns the number of conversations resolved.
 */
export async function autoResolveInactive(now: Date = new Date()): Promise<number> {
  const shops = await db.shop.findMany({
    where: { uninstalledAt: null },
    select: { id: true },
  });
  if (shops.length === 0) return 0;
  const settingsRows = await db.shopSettings.findMany({
    where: { shopId: { in: shops.map((s) => s.id) } },
    select: { shopId: true, settings: true },
  });
  const settingsByShop = new Map(settingsRows.map((r) => [r.shopId, r.settings]));

  let total = 0;
  for (const shop of shops) {
    const settings = shopSettingsSchema.parse(settingsByShop.get(shop.id) ?? {});
    if (!settings.inbox.autoResolve) continue;
    const windowMs = settings.inbox.after * (UNIT_MS[settings.inbox.unit] ?? UNIT_MS.minute);
    const cutoff = new Date(now.getTime() - windowMs);

    const stale = await db.conversation.findMany({
      where: { shopId: shop.id, status: "open", isTest: false, lastMessageAt: { lt: cutoff } },
      select: { id: true },
      take: 500,
    });
    for (const convo of stale) {
      const updated = await db.conversation.updateMany({
        where: { id: convo.id, shopId: shop.id, status: "open" },
        data: { status: "resolved", mode: "ai", endedAt: now, unread: false },
      });
      if (updated.count === 0) continue;
      await db.message.create({
        data: {
          shopId: shop.id,
          conversationId: convo.id,
          role: "sys",
          author: "system",
          content: RESOLVED_SYS_MESSAGE,
        },
      });
      await recordEvent(shop.id, "conversation_resolved", { conversationId: convo.id, auto: true });
      total += 1;
    }
  }
  return total;
}

// ── Widget polling channel (proxy.messages) ─────────────────────────────────

export interface WidgetThreadState {
  messages: { id: string; role: string; author: string; content: string; createdAt: Date }[];
  mode: string;
  status: string;
  blocked: boolean;
}

/**
 * Agent/system messages after `since` + current mode/status so the widget
 * knows when a human took over or the conversation was resolved. When
 * `markSeen` (widget is rendering the thread), agent replies get seenAt.
 */
export async function getWidgetThreadState(
  shopId: string,
  conversationId: string,
  since: Date,
  markSeen: boolean,
  sessionId?: string,
): Promise<WidgetThreadState | null> {
  requireShopId(shopId);
  const convo = await db.conversation.findFirst({
    // sessionId binds the lookup to the caller's own widget session (C1).
    where: { id: conversationId, shopId, ...(sessionId ? { sessionId } : {}) },
    select: { mode: true, status: true, blocked: true },
  });
  if (!convo) return null;

  const messages = await db.message.findMany({
    where: {
      shopId,
      conversationId,
      role: { in: ["out", "sys"] },
      author: { in: ["agent", "system"] },
      createdAt: { gt: since },
    },
    orderBy: { createdAt: "asc" },
    take: 50,
    select: { id: true, role: true, author: true, content: true, createdAt: true },
  });

  if (markSeen) {
    await db.message.updateMany({
      where: { shopId, conversationId, role: "out", author: "agent", seenAt: null },
      data: { seenAt: new Date() },
    });
  }

  return { messages, mode: convo.mode, status: convo.status, blocked: convo.blocked };
}

export interface WidgetHistoryMessage {
  id: string;
  role: string;
  author: string;
  content: string;
  productCards: unknown;
  createdAt: Date;
}

/**
 * Full thread history for the widget restore (spec 05 delta: the conversation
 * survives storefront page navigation). Ownership is bound to the caller's
 * widget sessionId — a conversationId alone is never enough (review C1).
 */
export async function getWidgetThreadHistory(
  shopId: string,
  conversationId: string,
  sessionId: string,
): Promise<{
  messages: WidgetHistoryMessage[];
  mode: string;
  status: string;
  blocked: boolean;
} | null> {
  requireShopId(shopId);
  const convo = await db.conversation.findFirst({
    where: { id: conversationId, shopId, sessionId },
    select: { mode: true, status: true, blocked: true },
  });
  if (!convo) return null;

  const messages = await db.message.findMany({
    // "sys" included so handover/resolve notices survive a page navigation —
    // the poll returns them, so omitting them here made them vanish on
    // restore (QA D10).
    where: { shopId, conversationId, role: { in: ["in", "out", "sys"] } },
    orderBy: { createdAt: "asc" },
    take: 100,
    select: {
      id: true,
      role: true,
      author: true,
      content: true,
      productCards: true,
      createdAt: true,
    },
  });
  return { messages, mode: convo.mode, status: convo.status, blocked: convo.blocked };
}

// ── Leave-a-message / collect-email form (proxy.handover-form) ──────────────

export interface HandoverFormValues {
  email: string;
  issue: string;
  orderNumber?: string;
  phone?: string;
}

/**
 * Handover form submission: upsert a lead Contact (prechat pattern), attach it
 * to the conversation, store the request as a shopper message so it shows in
 * the thread, and notify the merchant. Returns null when the conversation is
 * not this shop's.
 */
export async function submitHandoverForm(
  shopId: string,
  args: { sessionId: string; conversationId: string; values: HandoverFormValues },
): Promise<{ ok: true; postSubmitMessage: string } | null> {
  requireShopId(shopId);
  const convo = await db.conversation.findFirst({
    // sessionId binds to the caller's own widget session (review C1).
    where: { id: args.conversationId, shopId, sessionId: args.sessionId },
    select: { id: true },
  });
  if (!convo) return null;

  const { email, issue, orderNumber, phone } = args.values;

  // Upsert by (shopId, email) — no DB unique on the pair, so find-then-write.
  // Review M3: a proxy submission is UNVERIFIED — never let it overwrite an
  // existing contact's identity fields (sessionId/phone), and never attach a
  // known customer's record to an arbitrary conversation. Matching a customer
  // → create a fresh lead row instead; matching a lead → attach without
  // mutating identity.
  const existing = await db.contact.findFirst({ where: { shopId, email } });
  // The session may already own an anonymous contact (created at conversation
  // start, spec 11): upgrade it to a lead in place rather than adding a row.
  const anon = await db.contact.findFirst({
    where: { shopId, sessionId: args.sessionId, type: "anonymous" },
    orderBy: { createdAt: "desc" },
  });
  const contact =
    existing && existing.type !== "customer"
      ? existing
      : anon
        ? await db.contact.update({
            where: { id: anon.id },
            data: { email, phone: phone || null, type: "lead" },
          })
        : await db.contact.create({
            data: {
              shopId,
              sessionId: args.sessionId,
              email,
              phone: phone || null,
              type: "lead",
              channel: "store",
            },
          });
  if (anon && contact.id === anon.id) {
    // The session's anonymous row was upgraded in place → timeline entry.
    await recordEvent(shopId, "contact_converted", {
      contactId: contact.id,
      from: "anonymous",
      to: "lead",
      source: "handover_form",
    });
  }

  // Matched an existing lead: fold this session's anonymous row into it so the
  // person doesn't span two contact rows.
  if (contact.id !== anon?.id && anon && existing && existing.type !== "customer") {
    await db.conversation.updateMany({
      where: { shopId, contactId: anon.id },
      data: { contactId: contact.id },
    });
    await db.contact.delete({ where: { id: anon.id } });
  }

  await db.conversation.updateMany({
    where: { id: convo.id, shopId },
    data: { contactId: contact.id, unread: true, lastMessageAt: new Date() },
  });

  const lines = [`Contact request from ${email}`];
  if (orderNumber) lines.push(`Order number: ${orderNumber}`);
  if (phone) lines.push(`Phone: ${phone}`);
  lines.push(issue);
  await db.message.create({
    data: {
      shopId,
      conversationId: convo.id,
      role: "in",
      author: "shopper",
      content: lines.join("\n"),
      sourceLayer: "handover",
    },
  });

  await recordEvent(shopId, "prechat_submitted", { source: "handover_form", hasPhone: !!phone });
  await notifyMerchantHandover(shopId, convo.id);

  const config = await getShopConfig(shopId);
  const postSubmitMessage =
    config.handover.destination === "collect_email"
      ? config.handover.collectEmail.postSubmitMessage
      : config.handover.inbox.leaveMessage.postSubmitMessage;
  return { ok: true, postSubmitMessage };
}
