import db from "../../db.server";
import { PLANS, type PlanId } from "./plans.server";

// Trial entitlement (spec 15 · QA D-23).
//
// THE PROBLEM. `appSubscriptionCreate` grants whatever `trialDays` the app asks
// for, every single time. Asking for the plan's headline 7 days on every call
// means the trial restarts on any of these:
//
//   • uninstall → reinstall           • Basic → Pro (or Pro → Basic)
//   • downgrade to Free → resubscribe • monthly → yearly
//
// i.e. a merchant can stay on a paid tier forever without ever being charged.
// Shopify DOES protect against this, but only for Shopify App Pricing (managed
// pricing), where trial days are tracked over a rolling 180-day period. This
// app bills through the Billing API (manual pricing), so the entitlement is
// ours to track.
//
// THE MODEL. A shop is entitled to N trial DAYS, once — not N days per
// subscription and not N days per install. Rather than counting consumed days
// (which is farmable: switch plans every 23h and every segment floors to zero),
// the ledger stores an absolute DEADLINE, set the first time a trial is
// granted and never moved forward afterwards:
//
//   trialStartedAt   when the clock first started
//   trialDeadlineAt  when the entitlement runs out
//
// Every later subscription is granted `ceil(deadline - now)` days — the days
// still left, never a fresh allowance. A legitimate mid-trial upgrade therefore
// keeps the SAME trial end date (what merchants expect, and what Shopify's own
// managed pricing does), while an abusive loop gets zero: the deadline it is
// measured against does not move.
//
// Both fields live on the Shop row, which survives uninstall and GDPR
// shop/redact. Every path that cancels a subscription clears `trialEndsAt` (the
// live subscription's trial) and deliberately leaves these two alone — if you
// ever add them to one of those `data:` blocks, the abuse loop reopens.
// scripts/qa/trial.test.ts asserts exactly that.

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Rolling forgiveness window. Consumed entitlement older than this stops
 * counting, matching the 180-day proration Shopify applies on managed pricing:
 * a merchant who genuinely left half a year ago is treated as new. Set to
 * `Infinity` for once-per-shop-forever.
 */
export const TRIAL_WINDOW_DAYS = 180;

/** The two ledger columns. Any object with these fields works (Shop rows, fixtures). */
export interface TrialLedger {
  trialStartedAt: Date | null;
  trialDeadlineAt: Date | null;
}

export interface TrialEntitlement {
  /** Days to send to Shopify as `trialDays`. 0 → omit it; billing starts at once. */
  grantDays: number;
  /** The previous entitlement aged out of the window, so this is a fresh one. */
  reset: boolean;
  /** Deadline the ledger carries after this grant (null → stamp it on confirm). */
  deadlineAt: Date | null;
}

/** Headline trial length for a plan, honouring admin overrides. */
export function trialAllowanceFor(plan: PlanId): number {
  return PLANS[plan]?.trialDays ?? 0;
}

/**
 * How many trial days this shop may still be granted. Pure — no DB, no clock of
 * its own — so the subscribe path, the confirm path and the plan-page copy all
 * derive from one implementation and cannot drift apart.
 */
export function trialEntitlement(
  ledger: TrialLedger,
  allowanceDays: number,
  now: Date = new Date(),
): TrialEntitlement {
  if (allowanceDays <= 0) {
    return { grantDays: 0, reset: false, deadlineAt: ledger.trialDeadlineAt };
  }

  const { trialStartedAt: started, trialDeadlineAt: deadline } = ledger;
  // Never trialled (or a half-written ledger) — full allowance.
  if (!started || !deadline) {
    return { grantDays: allowanceDays, reset: false, deadlineAt: null };
  }

  // Aged out of the rolling window: forgive and start over.
  if (now.getTime() - deadline.getTime() > TRIAL_WINDOW_DAYS * DAY_MS) {
    return { grantDays: allowanceDays, reset: true, deadlineAt: null };
  }

  // The operator can raise trialDays at /admin/plans after a shop has
  // started. Extra days extend the ORIGINAL start, so days already consumed are
  // subtracted from the new total (Shopify's rule) instead of granting a
  // second, full-length trial. Lowering the allowance never shortens a trial
  // already running — Math.max keeps the promised deadline.
  const deadlineAt = new Date(
    Math.max(deadline.getTime(), started.getTime() + allowanceDays * DAY_MS),
  );

  const remainingMs = deadlineAt.getTime() - now.getTime();
  // Round UP: a merchant mid-trial who upgrades keeps the day they are standing
  // in. This cannot compound — the deadline it is measured from never moves, so
  // the total overshoot across any number of switches stays under one day.
  const grantDays = remainingMs <= 0 ? 0 : Math.ceil(remainingMs / DAY_MS);
  return { grantDays, reset: false, deadlineAt };
}

/**
 * The ledger to persist once Shopify has CONFIRMED a subscription.
 *
 * Idempotent by construction: an existing entitlement is carried forward
 * unchanged, so a replayed billing callback (or a redelivered
 * app_subscriptions/update webhook) converges on the same row instead of
 * extending the trial a little further each time.
 */
export function trialLedgerAfterGrant(args: {
  ledger: TrialLedger;
  allowanceDays: number;
  /** Shopify's `createdAt` for the subscription — the real start of the clock. */
  subscriptionCreatedAt: Date;
  /** Shopify's trial end for this subscription, or null when it granted none. */
  trialEndsAt: Date | null;
  now?: Date;
}): TrialLedger {
  const { ledger, allowanceDays, subscriptionCreatedAt, trialEndsAt } = args;
  const now = args.now ?? new Date();

  // No trial on this subscription (allowance spent, or a 0-day plan): the
  // entitlement is untouched — importantly NOT cleared, or the next subscribe
  // would hand out a fresh one.
  if (!trialEndsAt) return ledger;

  const entitlement = trialEntitlement(ledger, allowanceDays, now);
  const fresh = entitlement.reset || !ledger.trialStartedAt || !ledger.trialDeadlineAt;
  if (fresh) {
    return { trialStartedAt: subscriptionCreatedAt, trialDeadlineAt: trialEndsAt };
  }
  return { trialStartedAt: ledger.trialStartedAt, trialDeadlineAt: entitlement.deadlineAt };
}

/**
 * Trial days to request for a NEW subscription on `plan`.
 *
 * Called from inside both billing providers rather than from the route, so no
 * present or future call site can subscribe a shop while bypassing the ledger.
 * A shop row that does not exist yet gets the full allowance — it cannot have
 * spent one.
 */
export async function trialDaysForNewSubscription(
  shopDomain: string,
  plan: PlanId,
  now: Date = new Date(),
): Promise<number> {
  const allowanceDays = trialAllowanceFor(plan);
  if (allowanceDays <= 0) return 0;
  const shop = await db.shop.findUnique({
    where: { domain: shopDomain },
    select: { trialStartedAt: true, trialDeadlineAt: true },
  });
  if (!shop) return allowanceDays;
  return trialEntitlement(shop, allowanceDays, now).grantDays;
}

/**
 * Remaining trial days per plan, for merchant-facing copy. The plan cards must
 * not advertise "7-day free trial" to a shop Shopify will bill immediately —
 * App Store requirement 1.1.4 (pricing must be accurate), and the fastest way
 * to earn a support ticket.
 */
export function trialDaysByPlan(
  ledger: TrialLedger,
  planIds: readonly PlanId[],
  now: Date = new Date(),
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of planIds) {
    out[id] = trialEntitlement(ledger, trialAllowanceFor(id), now).grantDays;
  }
  return out;
}
