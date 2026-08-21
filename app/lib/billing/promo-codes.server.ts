import { Prisma } from "@prisma/client";
import db from "../../db.server";
import { requireShopId } from "../tenancy.server";
import { logWarn } from "../log.server";
import { PLANS } from "./plans.server";
import {
  isPaidPlan,
  yearlyTotal,
  type BillingIntervalId,
  type PaidPlanId,
} from "./shopify-billing.server";

// Promo codes (spec 15 · discount coupons). Operator creates codes in the
// platform console (/platform/promo-codes) and hands them to merchants by mail
// or chat; the merchant applies one on Plan & Usage. The discount is NOT
// applied by us — it is passed to Shopify as the `discount` of the recurring
// line in appSubscriptionCreate, so the approval page, invoices and proration
// all show the discounted price. Shopify's percentage is a 0–1 fraction.
//
// Tenancy: promo_codes is operator data (cross-tenant BY DESIGN);
// promo_redemptions rows are shop-scoped and every read/write takes shopId.
//
// ── Redemption model (decisions) ──────────────────────────────────────────
// A promo_redemptions row is the SHOP's relationship with a CODE, not with a
// subscription — enforced by @@unique([shopId, promoCodeId]). Consequences:
//
//  1. Plan changes carry the discount. Upgrading creates a *new* Shopify
//     subscription, so the discount must be re-attached to it. Re-entering
//     the same code is therefore allowed for the shop that already holds it:
//     the existing row is re-pointed at the new subscription instead of being
//     refused ("20% off forever" used to evaporate on the first upgrade).
//     The shop still consumes exactly ONE maxRedemptions slot, ever.
//  2. `maxRedemptions` counts SHOPS holding the code (rows that are `redeemed`
//     or freshly `pending`), and the count + insert happen inside one
//     SERIALIZABLE transaction, so concurrent redemptions cannot exceed it.
//  3. A `pending` row reserves a slot, but only for PENDING_TTL_MS — an
//     abandoned approval page must not burn a slot forever. Stale pendings are
//     garbage-collected opportunistically whenever the code is reserved again.
//  4. When the shop's subscription ends (downgrade to Free, cancel, uninstall)
//     its rows move to `released`: the slot returns to the pool and the shop
//     may use the code again if it comes back. Accepted trade-off: a merchant
//     could cancel/re-subscribe to replay a duration-limited code — codes are
//     operator-issued and the operator has `active`, `expiresAt` and
//     `maxRedemptions` as levers.

import {
  PENDING_TTL_MS,
  describePromo,
  normalizePromoCode,
  promoCodeProblem,
  type PromoKind,
} from "./promo-shared";

export {
  describePromo,
  generatePromoCode,
  normalizePromoCode,
  promoCodeProblem,
  promoValueProblem,
  type PromoKind,
} from "./promo-shared";

/** Redemption statuses (promo_redemptions.status). */
export const REDEMPTION_PENDING = "pending";
export const REDEMPTION_REDEEMED = "redeemed";
export const REDEMPTION_RELEASED = "released";

/** How long an unapproved reservation holds a maxRedemptions slot. */
export { PENDING_TTL_MS } from "./promo-shared";

export interface PromoSummary {
  id: string;
  code: string;
  kind: PromoKind;
  value: number;
  durationIntervals: number | null;
  plans: string[];
  intervals: string[];
  /** Human copy, e.g. "20% off for 3 billing cycles". */
  label: string;
}

export type PromoValidation =
  | { ok: true; promo: PromoSummary }
  | { ok: false; error: string };

type PromoRow = NonNullable<
  Awaited<ReturnType<typeof db.promoCode.findUnique>>
>;

function toSummary(row: PromoRow): PromoSummary {
  return {
    id: row.id,
    code: row.code,
    kind: row.kind === "fixed" ? "fixed" : "percent",
    value: row.value.toNumber(),
    durationIntervals: row.durationIntervals,
    plans: row.plans,
    intervals: row.intervals,
    label: describePromo(row),
  };
}

/** Recurring price Shopify will be asked to charge per interval. */
export function intervalPrice(
  plan: PaidPlanId,
  interval: BillingIntervalId,
): number {
  return interval === "yearly" ? yearlyTotal(plan) : PLANS[plan].priceMonthly;
}

/** Price after the promo for one billing interval (what the approval page shows). */
export function discountedPrice(promo: PromoSummary, price: number): number {
  const next =
    promo.kind === "percent"
      ? price * (1 - promo.value / 100)
      : price - promo.value;
  return Math.max(0, Number(next.toFixed(2)));
}

/**
 * Why a code can't be used on a plan/interval — or null when it can.
 * "scope" = the code is restricted to other plans/terms; "too-large" = a fixed
 * discount that would wipe out the charge (Shopify rejects a free subscription
 * built from a discount). The two need different merchant copy: telling
 * someone "this code doesn't apply to that plan" when the real problem is
 * "$50 off a $29 plan" sends them hunting for the wrong thing.
 */
export function promoApplicabilityProblem(
  promo: Pick<PromoSummary, "plans" | "intervals" | "kind" | "value">,
  plan: PaidPlanId,
  interval: BillingIntervalId,
): "scope" | "too-large" | null {
  if (promo.plans.length && !promo.plans.includes(plan)) return "scope";
  if (promo.intervals.length && !promo.intervals.includes(interval))
    return "scope";
  if (promo.kind === "fixed" && promo.value >= intervalPrice(plan, interval))
    return "too-large";
  return null;
}

/** Does the code cover this plan + interval? (empty lists = any). */
export function promoAppliesTo(
  promo: Pick<PromoSummary, "plans" | "intervals" | "kind" | "value">,
  plan: PaidPlanId,
  interval: BillingIntervalId,
): boolean {
  return promoApplicabilityProblem(promo, plan, interval) === null;
}

// ── Code-enumeration throttle ─────────────────────────────────────────────
// The plan page lets any authenticated merchant POST intent=validate_code, so
// without a limit a single store can enumerate every operator code. Only
// FAILED validations spend a token: a merchant applying a real code (and then
// subscribing with it, which re-validates) is never throttled, while a guessing
// loop runs out in seconds. Same in-memory token-bucket shape as the storefront
// order-track throttle (proxy.order-track.tsx).
declare global {
  // eslint-disable-next-line no-var
  var promoValidateBuckets: Map<string, { tokens: number; at: number }> | undefined;
}
const PROMO_CAPACITY = 10;
const PROMO_REFILL_PER_MS = 10 / 60_000; // 10 failed attempts per minute

/** Returns false when the shop has spent its failed-attempt budget. */
export function consumePromoValidationToken(shopId: string): boolean {
  const key = requireShopId(shopId);
  if (!global.promoValidateBuckets) global.promoValidateBuckets = new Map();
  const now = Date.now();
  const bucket = global.promoValidateBuckets.get(key) ?? {
    tokens: PROMO_CAPACITY,
    at: now,
  };
  bucket.tokens = Math.min(
    PROMO_CAPACITY,
    bucket.tokens + (now - bucket.at) * PROMO_REFILL_PER_MS,
  );
  bucket.at = now;
  global.promoValidateBuckets.set(key, bucket);
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  if (global.promoValidateBuckets.size > 10_000) {
    const cutoff = now - 10 * 60 * 1000;
    for (const [k, b] of global.promoValidateBuckets) {
      if (b.at < cutoff) global.promoValidateBuckets.delete(k);
    }
  }
  return true;
}

/** Test seam: forget every throttle bucket. */
export function resetPromoValidationThrottle(): void {
  global.promoValidateBuckets = undefined;
}

const THROTTLED = {
  ok: false as const,
  error: "Too many code attempts — please wait a minute and try again.",
};

// ── Redemption counting / reservation ─────────────────────────────────────

/** Rows that currently occupy a maxRedemptions slot for a code. */
function occupiedSlots(promoCodeId: string, excludeShopId?: string) {
  return {
    promoCodeId,
    ...(excludeShopId ? { shopId: { not: excludeShopId } } : {}),
    OR: [
      { status: REDEMPTION_REDEEMED },
      {
        status: REDEMPTION_PENDING,
        createdAt: { gte: new Date(Date.now() - PENDING_TTL_MS) },
      },
    ],
  };
}

/** How many shops currently hold this code (redeemed + live reservations). */
export async function countRedemptions(promoCodeId: string): Promise<number> {
  return db.promoRedemption.count({ where: occupiedSlots(promoCodeId) });
}

function isRetryableWriteConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    // P2034 = write conflict / deadlock, P2002 = unique violation (two requests
    // from the SAME shop racing; the retry finds the row and returns "ok").
    (error.code === "P2034" || error.code === "P2002")
  );
}

/** Advisory-lock namespace for promo reservations (arbitrary, app-wide unique). */
const PROMO_LOCK_NAMESPACE = 2001;

/**
 * Atomically claim (or re-claim) this shop's slot on a code.
 *
 * The count→insert pair is serialized per CODE with a transaction-scoped
 * Postgres advisory lock: without it two shops can both read `used = max - 1`
 * and both insert, blowing past maxRedemptions (and the old code made this
 * worse by counting at validate time and inserting much later, from a
 * different request). The lock is released automatically when the transaction
 * commits or rolls back, and it only ever contends with other redemptions of
 * the same code.
 */
async function reserveSlot(
  shopId: string,
  promo: PromoRow,
  plan: PaidPlanId,
  interval: BillingIntervalId,
): Promise<"ok" | "limit"> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await db.$transaction(
        async (tx) => {
          // $executeRaw, not $queryRaw: the lock function returns void, which
          // Prisma's row deserializer cannot represent.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PROMO_LOCK_NAMESPACE}::int, hashtext(${promo.id})::int)`;
          const mine = await tx.promoRedemption.findUnique({
            where: {
              shopId_promoCodeId: { shopId, promoCodeId: promo.id },
            },
          });
          if (mine) {
            // Already holds the slot (any status) — refresh the target plan.
            await tx.promoRedemption.update({
              where: { id: mine.id },
              data: { plan, interval },
            });
            return "ok" as const;
          }

          // Abandoned approvals must not reserve forever (GC on write path).
          await tx.promoRedemption.deleteMany({
            where: {
              promoCodeId: promo.id,
              status: REDEMPTION_PENDING,
              redeemedAt: null,
              createdAt: { lt: new Date(Date.now() - PENDING_TTL_MS) },
            },
          });
          if (promo.maxRedemptions !== null) {
            const used = await tx.promoRedemption.count({
              where: occupiedSlots(promo.id, shopId),
            });
            if (used >= promo.maxRedemptions) return "limit" as const;
          }
          await tx.promoRedemption.create({
            data: {
              shopId,
              promoCodeId: promo.id,
              plan,
              interval,
              status: REDEMPTION_PENDING,
            },
          });
          return "ok" as const;
        },
        { timeout: 15_000 },
      );
    } catch (error) {
      if (!isRetryableWriteConflict(error) || attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
  return "limit";
}

/**
 * Validate a code for a shop. When plan/interval are given the applicability
 * is enforced too AND the shop's maxRedemptions slot is atomically reserved
 * (subscribe path — the reservation must exist BEFORE the Shopify
 * subscription is created, otherwise the cap can be blown by concurrent
 * approvals). Without them only the code's own state is checked (Apply button
 * on the plan page — the cards then preview per plan).
 */
export async function validatePromoCode(args: {
  shopId: string;
  code: string;
  plan?: PaidPlanId;
  interval?: BillingIntervalId;
}): Promise<PromoValidation> {
  const shopId = requireShopId(args.shopId);
  const fail = (error: string): PromoValidation => {
    if (!consumePromoValidationToken(shopId)) return THROTTLED;
    return { ok: false, error };
  };

  const code = normalizePromoCode(args.code);
  const problem = promoCodeProblem(code);
  if (problem) return fail(problem);

  const row = await db.promoCode.findUnique({ where: { code } });
  if (!row || !row.active) return fail("That code isn't valid.");
  // expiresAt is stored as end-of-day UTC by the operator console (a coupon
  // dated 2026-12-31 dies at 23:59:59.999Z). Deliberate: codes are issued and
  // dated by the operator, who works in UTC, and a merchant-local expiry would
  // make one code expire at 24 different instants. Documented on the form.
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
    return fail("That code has expired.");
  }

  const mine = await db.promoRedemption.findUnique({
    where: { shopId_promoCodeId: { shopId, promoCodeId: row.id } },
    select: { id: true, status: true },
  });
  // NOTE (decision 1 above): the shop's own row is never a rejection reason —
  // it is what lets the discount follow the shop onto a new subscription.
  if (row.maxRedemptions !== null && !mine) {
    const used = await countRedemptions(row.id);
    if (used >= row.maxRedemptions) {
      return fail("That code has reached its redemption limit.");
    }
  }

  const promo = toSummary(row);
  if (args.plan && args.interval) {
    const applicability = promoApplicabilityProblem(
      promo,
      args.plan,
      args.interval,
    );
    if (applicability === "too-large") {
      return fail(promoTooLargeMessage(promo, args.plan, args.interval));
    }
    if (applicability === "scope") return fail(promoScopeMessage(promo));

    const reserved = await reserveSlot(shopId, row, args.plan, args.interval);
    if (reserved === "limit") {
      return fail("That code has reached its redemption limit.");
    }
  }
  return { ok: true, promo };
}

function money(value: number): string {
  return `$${value % 1 === 0 ? value.toFixed(0) : value.toFixed(2)}`;
}

function promoTooLargeMessage(
  promo: PromoSummary,
  plan: PaidPlanId,
  interval: BillingIntervalId,
): string {
  const price = intervalPrice(plan, interval);
  const term = interval === "yearly" ? "yearly" : "monthly";
  return `This code takes ${money(promo.value)} off, which is more than the ${PLANS[plan].name} ${term} price (${money(price)}). Choose a plan or term that costs more than the discount.`;
}

function promoScopeMessage(promo: PromoSummary): string {
  const plans = promo.plans.length
    ? promo.plans
        .filter(isPaidPlan)
        .map((p) => PLANS[p].name)
        .join(" or ")
    : null;
  const intervals = promo.intervals.length
    ? promo.intervals.join(" or ")
    : null;
  const parts = [
    plans ? `the ${plans} plan` : null,
    intervals ? `${intervals} billing` : null,
  ]
    .filter(Boolean)
    .join(" with ");
  return parts
    ? `This code only applies to ${parts}.`
    : "This code doesn't apply to that plan.";
}

/** Shopify `AppSubscriptionDiscountInput` for the recurring line. */
export function discountInputFor(promo: PromoSummary): {
  value: { percentage: number } | { amount: number };
  durationLimitInIntervals?: number;
} {
  // 4 dp is Shopify's precision for the 0–1 fraction; promoValueProblem keeps
  // stored percents at ≤2 decimals so this rounding is always exact.
  const percentage = Number((promo.value / 100).toFixed(4));
  if (promo.kind === "percent" && percentage * 100 !== promo.value) {
    logWarn("promo_percent_rounded", {
      code: promo.code,
      stored: promo.value,
      sent: percentage,
    });
  }
  return {
    value:
      promo.kind === "percent"
        ? { percentage }
        : { amount: Number(promo.value.toFixed(2)) },
    ...(promo.durationIntervals
      ? { durationLimitInIntervals: promo.durationIntervals }
      : {}),
  };
}

/**
 * Called right after appSubscriptionCreate: point the shop's redemption row at
 * the subscription the discount rides on, so the billing return (or the
 * app_subscriptions/update webhook, when the merchant closes the callback tab)
 * can confirm it once Shopify says ACTIVE.
 *
 * A row that is already `redeemed` keeps that status: during a plan change the
 * old subscription's discount is still live until the new one activates, and
 * an abandoned upgrade must not silently retire it.
 */
export async function recordPendingRedemption(args: {
  shopId: string;
  promoId: string;
  subscriptionId: string;
  plan: PaidPlanId;
  interval: BillingIntervalId;
}): Promise<void> {
  const shopId = requireShopId(args.shopId);
  const key = { shopId_promoCodeId: { shopId, promoCodeId: args.promoId } };
  const existing = await db.promoRedemption.findUnique({ where: key });
  if (existing) {
    await db.promoRedemption.update({
      where: { id: existing.id },
      data: {
        subscriptionId: args.subscriptionId,
        plan: args.plan,
        interval: args.interval,
        ...(existing.status === REDEMPTION_REDEEMED
          ? {}
          : { status: REDEMPTION_PENDING, createdAt: new Date() }),
      },
    });
    return;
  }
  await db.promoRedemption.create({
    data: {
      shopId,
      promoCodeId: args.promoId,
      subscriptionId: args.subscriptionId,
      plan: args.plan,
      interval: args.interval,
      status: REDEMPTION_PENDING,
    },
  });
}

/**
 * Shopify confirmed this subscription ACTIVE → mark its code redeemed.
 * Idempotent, and safe to call from BOTH writers: the billing callback
 * (completeBillingReturn) and the app_subscriptions/update webhook — the
 * webhook is the only writer when the merchant approves the charge and closes
 * the tab, which used to leave the row `pending` forever (discount live on
 * Shopify, but never counted, never blocking reuse, badge never shown).
 */
export async function confirmRedemption(
  shopId: string,
  subscriptionId: string,
): Promise<void> {
  const scoped = { shopId: requireShopId(shopId), subscriptionId };
  // redeemedAt is stamped once (a plan change re-confirms the same row).
  await db.promoRedemption.updateMany({
    where: { ...scoped, redeemedAt: null },
    data: { redeemedAt: new Date() },
  });
  await db.promoRedemption.updateMany({
    where: { ...scoped, status: { not: REDEMPTION_REDEEMED } },
    data: { status: REDEMPTION_REDEEMED },
  });
}

/**
 * The shop's subscription ended (downgrade to Free, cancel, uninstall):
 * retire its redemptions. The maxRedemptions slot returns to the pool and the
 * shop can apply the code again if it ever comes back — leaving the rows live
 * meant a downgraded store was locked out of its own code forever.
 */
export async function releaseRedemptionsForShop(shopId: string): Promise<void> {
  await db.promoRedemption.updateMany({
    where: {
      shopId: requireShopId(shopId),
      status: { in: [REDEMPTION_PENDING, REDEMPTION_REDEEMED] },
    },
    data: { status: REDEMPTION_RELEASED },
  });
}

/** Sweep abandoned reservations across all codes (safe to run from a cron/job). */
export async function purgeStalePendingRedemptions(): Promise<number> {
  const { count } = await db.promoRedemption.deleteMany({
    where: {
      status: REDEMPTION_PENDING,
      redeemedAt: null,
      createdAt: { lt: new Date(Date.now() - PENDING_TTL_MS) },
    },
  });
  return count;
}

/**
 * The code currently riding on the shop's subscription, if any (plan page badge).
 *
 * Keyed on the SHOP, not on the subscription id: a plan change replaces the
 * Shopify subscription, and between "upgrade started" and "upgrade approved"
 * the row already points at the new subscription while the discount is still
 * live on the old one. Requiring an id match made the badge blink out (and, on
 * the old code, made the discount look lost). `subscriptionId` is still the
 * gate — no live subscription means no live discount — and a row matching the
 * current subscription wins over an older one.
 */
export async function activeRedemptionFor(
  shopId: string,
  subscriptionId: string | null,
): Promise<{ code: string; label: string } | null> {
  if (!subscriptionId) return null;
  const rows = await db.promoRedemption.findMany({
    where: { shopId: requireShopId(shopId), status: REDEMPTION_REDEEMED },
    include: { promoCode: true },
    orderBy: { redeemedAt: "desc" },
    take: 10,
  });
  const row =
    rows.find((r) => r.subscriptionId === subscriptionId) ?? rows[0] ?? null;
  return row
    ? { code: row.promoCode.code, label: describePromo(row.promoCode) }
    : null;
}
