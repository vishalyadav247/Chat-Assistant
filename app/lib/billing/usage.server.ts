import db from "../../db.server";
import { requireShopId } from "../tenancy.server";
import { displayQuota, getQuota, overageRate } from "./plans.server";
import { reportOverageUsage } from "./usage-records.server";

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
 * Tick the conversation meter for an AI-handled message. Callers pass the
 * conversation row's lastMessageAt BEFORE this message, plus whether the
 * conversation has already been counted this session (metering is stored on
 * the conversation via meteredAt to stay idempotent).
 */
export async function tickConversation(args: {
  shopId: string;
  conversationId: string;
  isTest?: boolean;
}): Promise<UsageResult> {
  const shopId = requireShopId(args.shopId);

  const shop = await db.shop.findUnique({ where: { id: shopId }, select: { plan: true } });
  const plan = shop?.plan ?? "free";
  const quota = displayQuota(plan, "conversations");
  const enforcedQuota = getQuota(plan, "conversations");

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
  if (
    convo.meteredAt &&
    now.getTime() - convo.lastMessageAt.getTime() < SESSION_INACTIVITY_MS
  ) {
    return noTick();
  }
  if (convo.meteredAt && now.getTime() - convo.lastMessageAt.getTime() >= SESSION_INACTIVITY_MS) {
    // Session expired but same conversation row resumed → counts as a new conversation.
  }

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
  if (!withinQuota && overageRate(plan) !== null) {
    await db.planUsage.update({
      where: { shopId_periodStart: { shopId, periodStart } },
      data: { overageCount: { increment: 1 } },
    });
    overageRecorded = true;
    // Report to Shopify billing fire-and-forget (15b) — never blocks the chat path.
    reportOverageUsage(
      shopId,
      `Extra AI conversation beyond the ${quota.toLocaleString("en-US")}/month plan allowance`,
    ).catch((error) => console.error("overage_usage_record_error", error));
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
  const shop = await db.shop.findUnique({ where: { id: shopId }, select: { plan: true } });
  const plan = shop?.plan ?? "free";
  const enforcedQuota = getQuota(plan, "conversations");
  if (enforcedQuota === Number.MAX_SAFE_INTEGER) return true;
  const usage = await currentUsage(shopId);
  if (usage < enforcedQuota) return true;
  return overageRate(plan) !== null; // paid plans keep replying on overage
}

export async function currentUsage(shopId: string): Promise<number> {
  const row = await db.planUsage.findUnique({
    where: { shopId_periodStart: { shopId: requireShopId(shopId), periodStart: currentPeriodStart() } },
    select: { conversationCount: true },
  });
  return row?.conversationCount ?? 0;
}
