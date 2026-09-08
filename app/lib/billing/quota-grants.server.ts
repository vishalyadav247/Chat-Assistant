import db from "../../db.server";
import { requireShopId } from "../tenancy.server";
import {
  GRANTABLE_DIMENSIONS,
  isGrantableDimension,
  type QuotaDimension,
} from "./plan-shared";

// Re-exported so server callers keep one import site.
export { GRANTABLE_DIMENSIONS, isGrantableDimension };

/**
 * Bonus quota granted to one shop (spec 15 delta, 2026-09-07).
 *
 * WHY THIS EXISTS. Free plans and — until annual was withdrawn — yearly ones
 * hard-cap at their quota: Shopify permits usage charges on monthly cycles
 * only, so there is nothing to bill and the AI simply stops. That left no way
 * to help a specific merchant who ran out, short of hand-editing their plan.
 *
 * A LEDGER, not a counter on Shop. Rows mean a grant can be audited (who, why,
 * when), expired in batches, and granted twice without the second clobbering
 * the first.
 *
 * ONE RULE, every dimension: a live grant RAISES that shop.s cap for as long as
 * it lasts. Nothing is consumed one at a time.
 *
 * This replaced a consumable model on 2026-09-08 because "increase the plan
 * limit" is what a grant is FOR, and the consumable version had two problems:
 * the displayed limit shrank as it was spent (used and limit converging looked
 * broken), and it needed a hand-maintained ordering rule — spend the credit
 * before recording overage — that a refactor could silently reverse into
 * billing a merchant for the very conversations the grant was meant to cover.
 * A cap raise has no ordering to get wrong: overage simply starts past
 * plan + bonus.
 *
 * Withdrawing or expiring a grant drops the cap back. Nothing already created
 * under the higher cap is deleted — only new work stops.
 */

export interface QuotaGrantInput {
  /** Which quota to top up. Defaults to conversations. */
  dimension?: QuotaDimension;
  amount: number;
  reason?: string;
  grantedBy?: string;
  /** Null/undefined = never expires. */
  expiresAt?: Date | null;
}

export interface QuotaGrantRow {
  id: string;
  dimension: string;
  amount: number;
  remaining: number;
  reason: string;
  grantedBy: string;
  expiresAt: Date | null;
  createdAt: Date;
  /** True when `expiresAt` has passed — kept for history, spent by nothing. */
  expired: boolean;
}

/** Rows that can still be spent right now. */
function liveWhere(shopId: string, dimension: QuotaDimension, now: Date) {
  return {
    shopId,
    dimension,
    remaining: { gt: 0 },
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
  };
}

/**
 * Bonus quota this shop currently has for one dimension. 0 when it has none.
 *
 * For a METER this is what is left to spend; for a CEILING it is how much is
 * added to the plan cap right now.
 */
export async function bonusQuota(
  shopId: string,
  dimension: QuotaDimension = "conversations",
  now = new Date(),
): Promise<number> {
  const id = requireShopId(shopId);
  const result = await db.quotaGrant.aggregate({
    where: liveWhere(id, dimension, now),
    _sum: { remaining: true },
  });
  return result._sum.remaining ?? 0;
}

/** Every grant for a shop, newest first — the operator's audit view. */
export async function listGrants(shopId: string, now = new Date()): Promise<QuotaGrantRow[]> {
  const id = requireShopId(shopId);
  const rows = await db.quotaGrant.findMany({
    where: { shopId: id },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return rows.map((r) => ({
    id: r.id,
    dimension: r.dimension,
    amount: r.amount,
    remaining: r.remaining,
    reason: r.reason,
    grantedBy: r.grantedBy,
    expiresAt: r.expiresAt,
    createdAt: r.createdAt,
    expired: r.expiresAt !== null && r.expiresAt <= now,
  }));
}

/**
 * Grant bonus conversations. Returns the new live balance.
 *
 * `amount` is floored at 1 and capped at 100,000: a grant is a deliberate
 * gesture, and a mistyped 1000000 should be refused rather than quietly
 * uncapping a shop.
 */
export async function grantQuota(shopId: string, grant: QuotaGrantInput): Promise<number> {
  const id = requireShopId(shopId);
  const dimension = grant.dimension ?? "conversations";
  if (!isGrantableDimension(dimension)) {
    throw new Error(`Bonus quota is not wired for "" — it would have no effect.`);
  }
  const amount = Math.floor(grant.amount);
  if (!Number.isFinite(amount) || amount < 1) {
    throw new Error("A credit grant must be at least 1 conversation.");
  }
  if (amount > 100_000) {
    throw new Error("A single grant is capped at 100,000 conversations.");
  }
  await db.quotaGrant.create({
    data: {
      shopId: id,
      dimension,
      amount,
      remaining: amount,
      reason: (grant.reason ?? "").slice(0, 300),
      grantedBy: (grant.grantedBy ?? "").slice(0, 200),
      expiresAt: grant.expiresAt ?? null,
    },
  });
  return bonusQuota(id, dimension);
}

/**
 * Withdraw what is left of one grant. The row survives with `remaining = 0`,
 * so the history still shows it was given and then taken back.
 */
export async function revokeGrant(shopId: string, grantId: string): Promise<boolean> {
  const id = requireShopId(shopId);
  const result = await db.quotaGrant.updateMany({
    where: { id: grantId, shopId: id },
    data: { remaining: 0 },
  });
  return result.count > 0;
}

