import { Prisma } from "@prisma/client";
import db from "../../db.server";
import { recordEvent } from "../analytics/events.server";
import { getShopConfig } from "../config/shop-config.server";
import { notifyMerchantHandover } from "../notify.server";
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

/** All non-test conversations for the shop, newest first, with contact name + last-message preview. */
export async function listConversations(shopId: string): Promise<InboxListRow[]> {
  requireShopId(shopId);
  const rows = await db.conversation.findMany({
    where: { shopId, isTest: false },
    orderBy: { lastMessageAt: "desc" },
    take: 300,
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
  contact: { name: string | null; email: string | null; phone: string | null; type: string } | null;
  messages: InboxThreadMessage[];
}

export async function getConversationDetail(
  shopId: string,
  conversationId: string,
): Promise<InboxConversationDetail | null> {
  requireShopId(shopId);
  const convo = await db.conversation.findFirst({
    where: { id: conversationId, shopId, isTest: false },
  });
  if (!convo) return null;

  const [contact, messages] = await Promise.all([
    convo.contactId
      ? db.contact.findFirst({
          where: { id: convo.contactId, shopId },
          select: { name: true, email: true, phone: true, type: true },
        })
      : Promise.resolve(null),
    db.message.findMany({
      where: { shopId, conversationId: convo.id },
      orderBy: { createdAt: "asc" },
      take: 500,
      select: { id: true, role: true, author: true, content: true, createdAt: true, seenAt: true },
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
    pageContext: convo.pageContext,
    startedAt: convo.startedAt.toISOString(),
    contact,
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      author: m.author,
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
): Promise<boolean> {
  requireShopId(shopId);
  const updated = await db.conversation.updateMany({
    where: { id: conversationId, shopId },
    data: { mode: "human", status: "open", endedAt: null, lastMessageAt: new Date() },
  });
  if (updated.count === 0) return false;
  await db.message.create({
    data: { shopId, conversationId, role: "out", author: "agent", content },
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
  const updated = await db.conversation.updateMany({
    where: { id: conversationId, shopId },
    data: resolved
      ? { status: "resolved", mode: "ai", endedAt: new Date() }
      : { status: "open", endedAt: null },
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
  const updated = await db.conversation.updateMany({
    where: { id: conversationId, shopId },
    data: { starred },
  });
  return updated.count > 0;
}

export async function markRead(shopId: string, conversationId: string): Promise<boolean> {
  requireShopId(shopId);
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
        data: { status: "resolved", mode: "ai", endedAt: now },
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
    select: { mode: true, status: true },
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

  return { messages, mode: convo.mode, status: convo.status };
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
): Promise<{ messages: WidgetHistoryMessage[]; mode: string; status: string } | null> {
  requireShopId(shopId);
  const convo = await db.conversation.findFirst({
    where: { id: conversationId, shopId, sessionId },
    select: { mode: true, status: true },
  });
  if (!convo) return null;

  const messages = await db.message.findMany({
    where: { shopId, conversationId, role: { in: ["in", "out"] } },
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
  return { messages, mode: convo.mode, status: convo.status };
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
  const contact =
    existing && existing.type !== "customer"
      ? existing
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
