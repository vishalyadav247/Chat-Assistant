import db from "../../db.server";
import { requireShopId } from "../tenancy.server";
import { logError } from "../log.server";
import { overageRate } from "./plans.server";
import { isBillingTestMode, USAGE_CAPPED_AMOUNT } from "./shopify-billing.server";

// The spend ceiling on the usage line (spec 15 · added 2026-09-03).
//
// Shopify's `cappedAmount` is the most a merchant can be charged for usage in
// one 30-day BILLING cycle, and it is the merchant's own approved limit —
// `appUsageRecordCreate` simply fails once it is reached ("Failed to create
// usage charge", confirmed in the Admin API docs). Before this module the app
// logged that failure and kept answering, so every conversation past the
// ceiling was served for free and nobody was told.
//
// `balanceUsed` on the same line item is the authority on how much of the cap
// is spent, so it is read from Shopify rather than recomputed locally — that
// also sidesteps the fact that our quota resets on the 1st of the month while
// Shopify's ceiling resets on the subscription's own cycle.
//
// Raising the ceiling needs the merchant's approval (appSubscriptionLineItemUpdate
// returns a confirmationUrl), which is why this only ever REPORTS the state;
// the merchant acts on it from Plan & Usage.

const BALANCE_QUERY = `#graphql
  query UsageBalance($id: ID!) {
    node(id: $id) {
      ... on AppSubscription {
        id
        lineItems {
          id
          plan {
            pricingDetails {
              ... on AppUsagePricing {
                cappedAmount { amount currencyCode }
                balanceUsed { amount currencyCode }
              }
            }
          }
        }
      }
    }
  }
`;

export interface UsageBalance {
  /** The merchant-approved ceiling for this billing cycle, in USD. */
  capped: number;
  /** Spent against it so far this cycle, in USD. */
  used: number;
  /** capped - used, never negative. */
  remaining: number;
  /** true when we could not reach Shopify — callers must fail SAFE, not open. */
  unknown: boolean;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { value: UsageBalance; at: number }>();

/** After a rejected usage record, stop guessing: nothing more fits this cycle. */
export function markCapExhausted(shopId: string): void {
  const cached = cache.get(shopId);
  const capped = cached?.value.capped ?? USAGE_CAPPED_AMOUNT;
  cache.set(shopId, {
    value: { capped, used: capped, remaining: 0, unknown: false },
    at: Date.now(),
  });
}

/** Forget the cached balance — used right after a successful record. */
export function invalidateUsageBalance(shopId: string): void {
  cache.delete(shopId);
}

/**
 * How much of the merchant's approved usage ceiling is left.
 *
 * Mock/test mode never calls Shopify: it derives the balance from what we have
 * locally reported, so the whole flow (including the "ceiling reached" branch)
 * is exercisable on a dev store with no real charges.
 */
export async function usageBalance(shopId: string): Promise<UsageBalance> {
  const id = requireShopId(shopId);
  const cached = cache.get(id);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const shop = await db.shop.findUnique({
    where: { id },
    select: { domain: true, plan: true, subscriptionId: true, usageLineItemId: true },
  });
  if (!shop?.usageLineItemId || !shop.subscriptionId) {
    // No usage line at all (Free, a legacy annual row, or a subscription that predates the
    // line). Nothing can be billed, so there is no headroom to report.
    const value: UsageBalance = { capped: 0, used: 0, remaining: 0, unknown: false };
    cache.set(id, { value, at: Date.now() });
    return value;
  }

  if (isBillingTestMode()) {
    const reported = await reportedSpend(id, shop.plan);
    const value: UsageBalance = {
      capped: USAGE_CAPPED_AMOUNT,
      used: reported,
      remaining: Math.max(0, USAGE_CAPPED_AMOUNT - reported),
      unknown: false,
    };
    cache.set(id, { value, at: Date.now() });
    return value;
  }

  try {
    const { unauthenticated } = await import("../../shopify.server");
    const { admin } = await unauthenticated.admin(shop.domain);
    const response = await admin.graphql(BALANCE_QUERY, {
      variables: { id: shop.subscriptionId },
    });
    const body = (await response.json()) as {
      data?: {
        node?: {
          lineItems?: Array<{
            id: string;
            plan?: { pricingDetails?: { cappedAmount?: { amount: string }; balanceUsed?: { amount: string } } };
          }>;
        };
      };
    };
    const line =
      body.data?.node?.lineItems?.find((item) => item.id === shop.usageLineItemId) ??
      body.data?.node?.lineItems?.find((item) => item.plan?.pricingDetails?.cappedAmount);
    const capped = Number(line?.plan?.pricingDetails?.cappedAmount?.amount);
    const used = Number(line?.plan?.pricingDetails?.balanceUsed?.amount);
    if (!Number.isFinite(capped)) throw new Error("no usage pricing on the subscription line");
    const value: UsageBalance = {
      capped,
      used: Number.isFinite(used) ? used : 0,
      remaining: Math.max(0, capped - (Number.isFinite(used) ? used : 0)),
      unknown: false,
    };
    cache.set(id, { value, at: Date.now() });
    return value;
  } catch (error) {
    logError("usage_balance_read_error", error, { shopDomain: shop.domain });
    // Do NOT cache an unknown: the next request should try again. Callers treat
    // `unknown` as "assume there is headroom" — a merchant must never lose
    // service because Shopify was briefly unreachable; the reconcile job bills
    // whatever we serve in the meantime.
    return { capped: 0, used: 0, remaining: 0, unknown: true };
  }
}

/** What we have successfully billed this period, in USD (mock-mode fallback). */
async function reportedSpend(shopId: string, plan: string): Promise<number> {
  const rate = overageRate(plan) ?? 0;
  const { currentPeriodStart } = await import("./usage.server");
  const row = await db.planUsage.findUnique({
    where: { shopId_periodStart: { shopId, periodStart: currentPeriodStart() } },
    select: { overageReported: true },
  });
  return Number(((row?.overageReported ?? 0) * rate).toFixed(2));
}

/**
 * Is there room for one more billable conversation?
 *
 * FAILS SAFE, not open: when Shopify cannot be reached the answer is yes, and
 * the hourly reconcile job bills what was served. Cutting a merchant's chat off
 * because of our own API hiccup would be the worse failure.
 */
export async function hasUsageHeadroom(shopId: string, plan: string): Promise<boolean> {
  const rate = overageRate(plan);
  if (rate === null || rate <= 0) return false;
  const balance = await usageBalance(shopId);
  if (balance.unknown) return true;
  return balance.remaining >= rate;
}
