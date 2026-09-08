import db from "../../db.server";
import { requireShopId } from "../tenancy.server";
import { bonusQuota } from "./quota-grants.server";
import { getQuota, overageRate } from "./plans.server";
import { submitOverageRecords } from "./usage-records.server";
import { hasUsageHeadroom, usageBalance } from "./usage-cap.server";
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
 * Requires a plan overage rate AND a subscription carrying a usage line item.
 *
 * The billingInterval check is a LEGACY SAFETY NET, not live logic. Annual
 * billing was withdrawn entirely on 2026-09-07 and nothing can create a yearly
 * subscription any more, but a row written before that may still say "yearly" —
 * and Shopify rejects usage lines on ANNUAL subscriptions (QA D1), so billing
 * one would fail. Keep it: deleting it would start charging those shops for
 * conversations Shopify will never accept a usage record for.
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
  // Plan allowance PLUS any live bonus grant for this shop: a grant raises the
  // cap, so overage only ever starts past the two together.
  const quota =
    getQuota(plan, "conversations") + (await bonusQuota(shopId, "conversations"));
  const billable = shop ? overageBillable(shop) : false;

  const noTick = async (): Promise<UsageResult> => {
    const usage = await currentUsage(shopId);
    return {
      ticked: false,
      withinQuota: usage < quota,
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

  const withinQuota = usage.conversationCount <= quota;
  let overageRecorded = false;
  if (!withinQuota && billable) {
    await db.planUsage.update({
      where: { shopId_periodStart: { shopId, periodStart } },
      data: { overageCount: { increment: 1 } },
    });
    overageRecorded = true;
    // Bill it fire-and-forget — never blocks the chat path. Anything this call
    // fails to bill stays as overageCount - overageReported and is retried by
    // the hourly reconcile job, so a hiccup here costs nothing.
    submitOverageRecords(shopId, periodStart).catch((error) =>
      logError("overage_usage_record_error", error),
    );
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
  const planQuota = getQuota(plan, "conversations");
  if (planQuota === Number.MAX_SAFE_INTEGER) return true;
  // The allowance INCLUDES any live bonus grant. It must be compared against
  // usage, not merely checked for existence: nothing decrements a grant under
  // the cap-raise model, so `bonus > 0 ⇒ allowed` would let a Free shop with a
  // +3 grant answer for ever instead of for three more conversations.
  const enforcedQuota = planQuota + (await bonusQuota(shopId, "conversations"));
  const usage = await currentUsage(shopId);
  if (usage < enforcedQuota) return true;
  // Free (and any legacy annual row) has no usage line, so it stops at the cap.
  if (!shop || !overageBillable(shop)) return false;
  // Monthly paid plans keep replying on overage — but only while the merchant's
  // APPROVED spend ceiling still has room. Past it Shopify refuses the charge
  // (`Failed to create usage charge`), so serving on would be free work; the
  // merchant raises the limit from Plan & Usage. Fails safe: an unreachable
  // Shopify counts as headroom, and the reconcile job bills what we served.
  return hasUsageHeadroom(shopId, plan);
}

export interface UsageStatus {
  plan: string;
  used: number;
  quota: number;
  pct: number;
  /** ≥80% of the allowance and not yet over it. */
  nearCap: boolean;
  /** Conversations served past the allowance this month. */
  overage: number;
  /** Of those, not yet billed (retried hourly). */
  unbilled: number;
  /** Overage charged so far this month, in USD. */
  spend: number;
  rate: number | null;
  billable: boolean;
  /** The merchant's approved ceiling for the billing cycle, in USD. */
  capped: number;
  remaining: number;
  /** Ceiling reached: the AI has stopped until the limit is raised. */
  ceilingReached: boolean;
  /** Bonus conversations granted to this shop and still unspent. */
  credits: number;
}

/**
 * Everything Plan & Usage needs to tell the merchant the truth about metering:
 * how close they are, whether they are being charged, and whether the AI has
 * stopped. Before 2026-09-03 `overageCount` was written and never read, so a
 * merchant could be billed with nothing on screen to explain it.
 */
export async function usageStatus(shopId: string): Promise<UsageStatus> {
  const id = requireShopId(shopId);
  const shop = await db.shop.findUnique({
    where: { id },
    select: { plan: true, billingInterval: true, usageLineItemId: true },
  });
  const plan = shop?.plan ?? "free";
  // What the merchant is actually held to: plan allowance + any live bonus. The
  // old split (display the plan number, enforce a different one) is gone with
  // the enforcement switch — the meter now cannot disagree with reality.
  const credits = await bonusQuota(id, "conversations");
  const quota = getQuota(plan, "conversations") + credits;
  const periodStart = currentPeriodStart();
  const row = await db.planUsage.findUnique({
    where: { shopId_periodStart: { shopId: id, periodStart } },
    select: { conversationCount: true, overageCount: true, overageReported: true },
  });
  const used = row?.conversationCount ?? 0;
  const overage = row?.overageCount ?? 0;
  const billable = shop ? overageBillable(shop) : false;
  const rate = billable ? overageRate(plan) : null;
  const balance = billable ? await usageBalance(id) : { capped: 0, used: 0, remaining: 0, unknown: false };
  return {
    plan,
    used,
    quota,
    pct: quota > 0 ? Math.round((used / quota) * 100) : 0,
    nearCap: quota > 0 && used / quota >= 0.8 && used <= quota,
    overage,
    unbilled: Math.max(0, overage - (row?.overageReported ?? 0)),
    spend: Number((balance.used || 0).toFixed(2)),
    rate,
    billable,
    capped: balance.capped,
    remaining: balance.remaining,
    ceilingReached: billable && !balance.unknown && balance.capped > 0 && balance.remaining < (rate ?? 0),
    credits,
  };
}

export async function currentUsage(shopId: string): Promise<number> {
  const row = await db.planUsage.findUnique({
    where: { shopId_periodStart: { shopId: requireShopId(shopId), periodStart: currentPeriodStart() } },
    select: { conversationCount: true },
  });
  return row?.conversationCount ?? 0;
}
