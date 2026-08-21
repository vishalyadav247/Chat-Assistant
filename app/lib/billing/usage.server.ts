import db from "../../db.server";
import { requireShopId } from "../tenancy.server";
import { displayQuota, getQuota, overageRate } from "./plans.server";
import { reportOverageUsage } from "./usage-records.server";
import { logError } from "../log.server";

// Conversation metering (spec 15 rules — the billing FAQ is the contract):
// 1 AI conversation = one shopper session regardless of message count; a new
// session begins after 30 minutes of inactivity. Meter ticks on the FIRST
// AI-handled message of a session (curated/blocked count too; human-only
// conversations don't tick). Test AI conversations (isTest) never tick.
// No rollover; resets on the 1st (period key = first day of month).

export const SESSION_INACTIVITY_MS = 30 * 60 * 1000;

export interface UsageResult {
  ticked: boolean;
  withinQuota: boolean;
  nearCap: boolean; // ≥80% of the plan allowance
  overageRecorded: boolean;
  conversationCount: number;
  quota: number; // display quota (matrix value, even in open mode)
}

/** First day of the current month (UTC date-only) — the PlanUsage period key. */
export function currentPeriodStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Whether conversations beyond the allowance can be BILLED for this shop.
 * Requires a plan overage rate AND a monthly subscription with a usage line
 * item: yearly subscriptions cannot carry usage lines (Shopify rejects them,
 * QA D1), so they hard-cap at quota exactly like Free.
 */
export function overageBillable(shop: {
  plan: string;
  billingInterval: string | null;
  usageLineItemId: string | null;
}): boolean {
  if (overageRate(shop.plan) === null) return false;
  if (shop.billingInterval === "yearly") return false;
  return Boolean(shop.usageLineItemId);
}

/**
 * Tick the conversation meter for an AI-handled message. Callers pass the
 * conversation row's lastMessageAt BEFORE this message, plus whether the
 * conversation has already been counted this session (metering is stored on
 * the conversation via meteredAt to stay idempotent).
 */
export async function tickConversation(args: {
  shopId: string;
  conversationId: string;
  isTest?: boolean;
  /** The conversation's `lastMessageAt` BEFORE the current turn stamped it.
   *  The caller (pipeline) always updates that column first, so reading it
   *  here would compare now-vs-now and never expire a session (QA D13). */
  previousLastMessageAt?: Date | null;
}): Promise<UsageResult> {
  const shopId = requireShopId(args.shopId);

  const shop = await db.shop.findUnique({
    where: { id: shopId },
    select: { plan: true, billingInterval: true, usageLineItemId: true },
  });
  const plan = shop?.plan ?? "free";
  const quota = displayQuota(plan, "conversations");
  const enforcedQuota = getQuota(plan, "conversations");
  const billable = shop ? overageBillable(shop) : false;

  const noTick = async (): Promise<UsageResult> => {
    const usage = await currentUsage(shopId);
    return {
      ticked: false,
      withinQuota: usage < enforcedQuota,
      nearCap: quota > 0 && usage / quota >= 0.8,
      overageRecorded: false,
      conversationCount: usage,
      quota,
    };
  };

  if (args.isTest) return noTick();

  const convo = await db.conversation.findFirst({
    where: { id: args.conversationId, shopId },
    select: { id: true, isTest: true, meteredAt: true, lastMessageAt: true },
  });
  if (!convo || convo.isTest) return noTick();

  // Already metered within this session window → no new tick. A conversation
  // row IS a session (widget rotates sessionId after 30-min inactivity), but
  // guard the rule here too in case a stale conversation is resumed.
  const now = new Date();
  // Prefer the caller's pre-update timestamp; fall back to the stored column
  // for callers that don't have it (the row is then usually already stamped).
  const lastActivity = args.previousLastMessageAt ?? convo.lastMessageAt;
  if (convo.meteredAt && now.getTime() - lastActivity.getTime() < SESSION_INACTIVITY_MS) {
    return noTick();
  }
  // Otherwise: either never metered, or the session expired and this same
  // conversation row was resumed → counts as a new billable conversation.

  const periodStart = currentPeriodStart(now);
  const usage = await db.planUsage.upsert({
    where: { shopId_periodStart: { shopId, periodStart } },
    update: { conversationCount: { increment: 1 } },
    create: { shopId, periodStart, conversationCount: 1 },
  });
  await db.conversation.update({
    where: { id: convo.id },
    data: { meteredAt: now },
  });

  const withinQuota = usage.conversationCount <= enforcedQuota;
  let overageRecorded = false;
  if (!withinQuota && billable) {
    await db.planUsage.update({
      where: { shopId_periodStart: { shopId, periodStart } },
      data: { overageCount: { increment: 1 } },
    });
    overageRecorded = true;
    // Report to Shopify billing fire-and-forget (15b) — never blocks the chat path.
    reportOverageUsage(
      shopId,
      `Extra AI conversation beyond the ${quota.toLocaleString("en-US")}/month plan allowance`,
    ).catch((error) => logError("overage_usage_record_error", error));
  }

  return {
    ticked: true,
    withinQuota,
    nearCap: quota > 0 && usage.conversationCount / quota >= 0.8,
    overageRecorded,
    conversationCount: usage.conversationCount,
    quota,
  };
}

/** Whether the AI should still reply for this shop (Free at cap → stop). Open mode: always true. */
export async function aiAllowed(shopId: string): Promise<boolean> {
  requireShopId(shopId);
  const shop = await db.shop.findUnique({
    where: { id: shopId },
    select: { plan: true, billingInterval: true, usageLineItemId: true },
  });
  const plan = shop?.plan ?? "free";
  const enforcedQuota = getQuota(plan, "conversations");
  if (enforcedQuota === Number.MAX_SAFE_INTEGER) return true;
  const usage = await currentUsage(shopId);
  if (usage < enforcedQuota) return true;
  // Monthly paid plans keep replying on (billable) overage; Free and yearly
  // subscriptions (no usage line, QA D1) stop at the cap.
  return shop ? overageBillable(shop) : false;
}

export async function currentUsage(shopId: string): Promise<number> {
  const row = await db.planUsage.findUnique({
    where: { shopId_periodStart: { shopId: requireShopId(shopId), periodStart: currentPeriodStart() } },
    select: { conversationCount: true },
  });
  return row?.conversationCount ?? 0;
}
