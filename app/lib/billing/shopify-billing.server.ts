import db from "../../db.server";
import { requireShopId } from "../tenancy.server";
import { runtimeConfig } from "../platform/runtime-config.server";
import { DEFAULT_PLANS, PLANS, PLAN_IDS, type PlanId } from "./plans.server";
import { recordEvent } from "../analytics/events.server";
import { invalidateShopConfig } from "../config/shop-config.server";
import { logError, logWarn } from "../log.server";
import { confirmRedemption, releaseRedemptionsForShop } from "./promo-codes.server";

// Shopify Billing API integration (spec 15 / feature 15b), behind a
// BillingProvider interface so the confirmation flow is unit-testable offline.
//
// Two implementations:
//  - RealBillingProvider — Admin GraphQL appSubscriptionCreate / appSubscriptionCancel
//    / currentAppInstallation.activeSubscriptions. Mutation shapes verified against
//    @shopify/shopify-api (node_modules .../lib/billing/{request,cancel,subscriptions}.mjs),
//    which this app's pinned 2026-07 API version ships with.
//  - MockBillingProvider (BILLING_TEST_MODE=1) — no network: the confirmation URL
//    is the billing-callback URL itself carrying a mock subscription id, and the
//    callback reconstructs the subscription from those params.
//
// Enforcement stays OPEN (plans.server.ts): subscribing persists the plan on the
// Shop row but no feature is blocked anywhere.

export type BillingIntervalId = "monthly" | "yearly";
export type PaidPlanId = Exclude<PlanId, "free">;

/** Overage usage line: capped amount per spec 15 ($100 cap). The per-conversation
 *  rate comes from the plan matrix (platform-overridable) — see usageTermsFor. */
export const USAGE_CAPPED_AMOUNT = 100;

/** Usage-line terms text, derived from the plan's (possibly overridden) rate (QA D5). */
export function usageTermsFor(plan: PaidPlanId): string {
  return `$${PLANS[plan].overagePerConversation ?? 0} per extra AI conversation`;
}

/**
 * Subscription name sent to Shopify. Uses the STABLE default name
 * ("ChatConvert Basic/Pro/Plus"), never the platform-overridable display name,
 * so planFromSubscriptionName() keeps resolving after a rename (QA D2).
 */
export function subscriptionNameFor(plan: PaidPlanId): string {
  return `ChatConvert ${DEFAULT_PLANS[plan].name}`;
}

export interface ActiveSubscription {
  id: string;
  name: string;
  status: string; // ACTIVE | CANCELLED | EXPIRED | ...
  createdAt: string; // ISO timestamp
  trialDays: number;
  interval: BillingIntervalId | null;
  usageLineItemId: string | null;
}

/** Shopify AppSubscriptionDiscountInput (promo-codes.server.ts builds it). */
export interface SubscriptionDiscountInput {
  value: { percentage: number } | { amount: number };
  durationLimitInIntervals?: number;
}

export interface BillingProvider {
  createSubscription(args: {
    shopDomain: string;
    plan: PaidPlanId;
    interval: BillingIntervalId;
    discount?: SubscriptionDiscountInput | null;
  }): Promise<{ confirmationUrl: string; subscriptionId: string }>;
  getActiveSubscription(shopDomain: string): Promise<ActiveSubscription | null>;
  cancelSubscription(shopDomain: string, subscriptionId: string): Promise<void>;
}

export function isBillingTestMode(): boolean {
  // Operator-managed at /platform/settings; BILLING_TEST_MODE env is the fallback.
  //
  // HARD-DISABLED IN PRODUCTION. The mock provider persists a paid plan against
  // a fabricated subscription gid without ever calling Shopify, and its
  // "verified" subscription name is reconstructed from the client-supplied
  // ?plan= — which makes the anti-plan-escalation check in
  // completeBillingReturn self-fulfilling. A stray operator toggle (or a stale
  // BILLING_TEST_MODE in the deploy environment) would therefore hand out free
  // paid tiers on the live app, so the flag is ignored outside development.
  // For App Review, use `billingForceTestCharges` instead: it keeps the real
  // Shopify flow and only sets `test: true` on the charge.
  if (process.env.NODE_ENV === "production") return false;
  return runtimeConfig().billingTestMode;
}

export function getBillingProvider(): BillingProvider {
  return isBillingTestMode() ? mockProvider : realProvider;
}

function appUrl(): string {
  return (process.env.SHOPIFY_APP_URL || "").replace(/\/+$/, "");
}

/**
 * Billing return URL. Points at the app INSIDE the Shopify admin
 * (admin.shopify.com/store/{store}/apps/{api-key}/app/billing-callback) rather
 * than the raw app domain, mirroring @shopify/shopify-api's default for embedded
 * apps: after approval the merchant lands back in the embedded iframe, the
 * callback request carries embedded=1 and the authenticate.admin redirect
 * helper can bounce to /app/plan-usage inside the admin. A bare app-domain URL
 * leaves the merchant on a top-level page outside the admin.
 * Falls back to the app domain when the API key is unavailable (tests).
 */
function callbackUrl(shopDomain: string, plan: PlanId, interval: BillingIntervalId): string {
  const path = `/app/billing-callback?plan=${plan}&interval=${interval}`;
  const apiKey = process.env.SHOPIFY_API_KEY;
  if (!apiKey) return `${appUrl()}${path}`;
  const storeHandle = shopDomain.replace(/\.myshopify\.com$/i, "");
  return `https://admin.shopify.com/store/${storeHandle}/apps/${apiKey}${path}`;
}

export function isPaidPlan(plan: string): plan is PaidPlanId {
  return plan === "basic" || plan === "pro" || plan === "plus";
}

/**
 * Reverse of the "ChatConvert {Plan}" subscription-name convention (audit R1).
 * Matches case-insensitively against the plan id, the DEFAULT name and the
 * CURRENT (platform-overridden) name, so subscriptions created before a rename
 * and subscriptions created with a renamed plan both still resolve (QA D2).
 */
export function planFromSubscriptionName(name: string): PaidPlanId | null {
  const match = /^ChatConvert\s+(.+)$/i.exec(name.trim());
  if (!match) return null;
  const candidate = match[1].trim().toLowerCase();
  for (const id of PLAN_IDS) {
    if (!isPaidPlan(id)) continue;
    const names = [id, DEFAULT_PLANS[id].name, PLANS[id].name].map((n) => n.trim().toLowerCase());
    if (names.includes(candidate)) return id;
  }
  return null;
}

export function isBillingInterval(value: string): value is BillingIntervalId {
  return value === "monthly" || value === "yearly";
}

/** Yearly subscriptions are charged annually: per-month price × 12, in cents-safe form. */
export function yearlyTotal(plan: PaidPlanId): number {
  return Number((PLANS[plan].priceYearlyPerMonth * 12).toFixed(2));
}

// ── Real provider (Admin GraphQL, offline token via unauthenticated.admin) ──

const CREATE_MUTATION = `
  mutation AppSubscriptionCreate(
    $name: String!
    $returnUrl: URL!
    $test: Boolean
    $trialDays: Int
    $lineItems: [AppSubscriptionLineItemInput!]!
  ) {
    appSubscriptionCreate(
      name: $name
      returnUrl: $returnUrl
      test: $test
      trialDays: $trialDays
      lineItems: $lineItems
    ) {
      appSubscription { id }
      confirmationUrl
      userErrors { field message }
    }
  }
`;

const CANCEL_MUTATION = `
  mutation AppSubscriptionCancel($id: ID!, $prorate: Boolean) {
    appSubscriptionCancel(id: $id, prorate: $prorate) {
      appSubscription { id status }
      userErrors { field message }
    }
  }
`;

const ACTIVE_SUBSCRIPTIONS_QUERY = `
  query ActiveAppSubscriptions {
    currentAppInstallation {
      activeSubscriptions {
        id
        name
        status
        trialDays
        createdAt
        lineItems {
          id
          plan {
            pricingDetails {
              __typename
              ... on AppRecurringPricing { interval }
              ... on AppUsagePricing { terms }
            }
          }
        }
      }
    }
  }
`;

async function adminFor(shopDomain: string) {
  // Lazy import: keeps mock-mode scripts from booting the full Shopify app config.
  const { unauthenticated } = await import("../../shopify.server");
  const { admin } = await unauthenticated.admin(shopDomain);
  return admin;
}

interface SubscriptionNode {
  id: string;
  name: string;
  status: string;
  trialDays: number;
  createdAt: string;
  lineItems: Array<{
    id: string;
    plan: { pricingDetails: { __typename: string; interval?: string; terms?: string } };
  }>;
}

function toActiveSubscription(node: SubscriptionNode): ActiveSubscription {
  const recurring = node.lineItems.find(
    (li) => li.plan.pricingDetails.__typename === "AppRecurringPricing",
  );
  const usage = node.lineItems.find(
    (li) => li.plan.pricingDetails.__typename === "AppUsagePricing",
  );
  const interval =
    recurring?.plan.pricingDetails.interval === "ANNUAL"
      ? "yearly"
      : recurring?.plan.pricingDetails.interval === "EVERY_30_DAYS"
        ? "monthly"
        : null;
  return {
    id: node.id,
    name: node.name,
    status: node.status,
    createdAt: node.createdAt,
    trialDays: node.trialDays ?? 0,
    interval,
    usageLineItemId: usage?.id ?? null,
  };
}

const realProvider: BillingProvider = {
  async createSubscription({ shopDomain, plan, interval, discount }) {
    const def = PLANS[plan];
    const admin = await adminFor(shopDomain);

    const recurringLine = {
      plan: {
        appRecurringPricingDetails: {
          price: {
            amount: interval === "yearly" ? yearlyTotal(plan) : def.priceMonthly,
            currencyCode: "USD",
          },
          interval: interval === "yearly" ? "ANNUAL" : "EVERY_30_DAYS",
          // Promo code (spec 15): Shopify applies the discount itself, so the
          // approval page and every invoice show the reduced price.
          ...(discount ? { discount } : {}),
        },
      },
    };
    const lineItems: unknown[] = [recurringLine];
    // Shopify rejects usage lines on ANNUAL subscriptions (QA D1): yearly plans
    // carry no usage line → no usageLineItemId → the meter hard-caps at quota
    // (same path as Free). Overage is only billable on monthly subscriptions.
    if (def.overagePerConversation !== null && interval !== "yearly") {
      lineItems.push({
        plan: {
          appUsagePricingDetails: {
            terms: usageTermsFor(plan),
            cappedAmount: { amount: USAGE_CAPPED_AMOUNT, currencyCode: "USD" },
          },
        },
      });
    }

    const response = await admin.graphql(CREATE_MUTATION, {
      variables: {
        name: subscriptionNameFor(plan),
        returnUrl: callbackUrl(shopDomain, plan, interval),
        // Review M2: dev stores can only approve test subscriptions. Default to
        // test outside production, and allow forcing test charges in production
        // (app review + partner test stores) via env.
        test: process.env.NODE_ENV !== "production" || runtimeConfig().billingForceTestCharges,
        trialDays: def.trialDays > 0 ? def.trialDays : undefined,
        lineItems,
      },
    });
    const body = (await response.json()) as {
      data?: {
        appSubscriptionCreate?: {
          appSubscription?: { id: string } | null;
          confirmationUrl?: string;
          userErrors?: Array<{ field?: string[]; message: string }>;
        };
      };
    };
    const result = body.data?.appSubscriptionCreate;
    if (result?.userErrors?.length) {
      throw new Error(
        `appSubscriptionCreate: ${result.userErrors.map((e) => e.message).join("; ")}`,
      );
    }
    if (!result?.confirmationUrl) {
      throw new Error("appSubscriptionCreate: no confirmationUrl returned");
    }
    return {
      confirmationUrl: result.confirmationUrl,
      subscriptionId: result.appSubscription?.id ?? "",
    };
  },

  async getActiveSubscription(shopDomain) {
    const admin = await adminFor(shopDomain);
    const response = await admin.graphql(ACTIVE_SUBSCRIPTIONS_QUERY);
    const body = (await response.json()) as {
      data?: { currentAppInstallation?: { activeSubscriptions?: SubscriptionNode[] } };
    };
    const subs = body.data?.currentAppInstallation?.activeSubscriptions ?? [];
    const active = subs.find((s) => s.status === "ACTIVE") ?? subs[0];
    return active ? toActiveSubscription(active) : null;
  },

  async cancelSubscription(shopDomain, subscriptionId) {
    const admin = await adminFor(shopDomain);
    const response = await admin.graphql(CANCEL_MUTATION, {
      variables: { id: subscriptionId, prorate: true },
    });
    const body = (await response.json()) as {
      data?: {
        appSubscriptionCancel?: { userErrors?: Array<{ message: string }> };
      };
    };
    const errors = body.data?.appSubscriptionCancel?.userErrors;
    if (errors?.length) {
      throw new Error(`appSubscriptionCancel: ${errors.map((e) => e.message).join("; ")}`);
    }
  },
};

// ── Mock provider (BILLING_TEST_MODE=1) ─────────────────────────────────────

function mockSubscriptionId(): string {
  return `gid://shopify/AppSubscription/mock-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

/** Rebuild the subscription the mock "created" purely from callback params. */
export function mockSubscriptionFromParams(
  plan: PaidPlanId,
  interval: BillingIntervalId,
  chargeId?: string | null,
): ActiveSubscription {
  const def = PLANS[plan];
  const id = chargeId || mockSubscriptionId();
  return {
    id,
    name: subscriptionNameFor(plan),
    status: "ACTIVE",
    createdAt: new Date().toISOString(),
    trialDays: def.trialDays,
    interval,
    // Mirrors the real provider: no usage line on yearly subscriptions (D1).
    usageLineItemId:
      def.overagePerConversation !== null && interval !== "yearly"
        ? `${id.replace("AppSubscription", "AppSubscriptionLineItem")}-usage`
        : null,
  };
}

const mockProvider: BillingProvider = {
  async createSubscription({ shopDomain, plan, interval }) {
    const id = mockSubscriptionId();
    const confirmationUrl = `${callbackUrl(shopDomain, plan, interval)}&charge_id=${encodeURIComponent(id)}`;
    console.log(`[billing mock] createSubscription ${shopDomain} ${plan}/${interval} → ${id}`);
    return { confirmationUrl, subscriptionId: id };
  },

  async getActiveSubscription(shopDomain) {
    // Mock has no Shopify to ask — return what the Shop row says.
    const shop = await db.shop.findUnique({ where: { domain: shopDomain } });
    if (!shop?.subscriptionId || !isPaidPlan(shop.plan)) return null;
    const def = PLANS[shop.plan];
    return {
      id: shop.subscriptionId,
      name: subscriptionNameFor(shop.plan),
      status: "ACTIVE",
      createdAt: shop.installedAt.toISOString(),
      trialDays: def.trialDays,
      interval: isBillingInterval(shop.billingInterval ?? "")
        ? (shop.billingInterval as BillingIntervalId)
        : null,
      usageLineItemId: shop.usageLineItemId,
    };
  },

  async cancelSubscription(shopDomain, subscriptionId) {
    console.log(`[billing mock] cancelSubscription ${shopDomain} ${subscriptionId}`);
  },
};

// ── Shared flows (used by /app/billing-callback and the plan page action) ───

export interface BillingReturnResult {
  ok: boolean;
  error?: string;
}

/**
 * Billing return: verify the subscription is ACTIVE and persist plan/status/
 * subscription details on the Shop row. Mock mode reconstructs the subscription
 * from the callback params instead of querying Shopify.
 */
/** Legacy numeric id of a subscription GID (or the value itself if not a GID). */
function subscriptionLegacyId(id: string): string {
  return id.trim().replace(/\?.*$/, "").split("/").pop() || id.trim();
}

function sameSubscriptionId(a: string, b: string): boolean {
  return a === b || subscriptionLegacyId(a) === subscriptionLegacyId(b);
}

export async function completeBillingReturn(args: {
  shopDomain: string;
  plan: PaidPlanId;
  interval: BillingIntervalId;
  chargeId?: string | null;
}): Promise<BillingReturnResult> {
  const shop = await db.shop.findUnique({ where: { domain: args.shopDomain } });
  if (!shop) return { ok: false, error: "shop not found" };

  const subscription = isBillingTestMode()
    ? mockSubscriptionFromParams(args.plan, args.interval, args.chargeId)
    : await getBillingProvider().getActiveSubscription(args.shopDomain);

  if (!subscription || subscription.status !== "ACTIVE") {
    return { ok: false, error: "subscription is not active" };
  }
  // QA D8: the live active subscription must be the one Shopify just approved.
  // A mismatched charge_id means a stale/replayed return URL (or a different
  // subscription became active in between) — refuse rather than persist it.
  // Shopify puts the bare numeric id in ?charge_id= while the subscription id
  // is a GID (gid://shopify/AppSubscription/123) — compare the trailing id.
  if (args.chargeId && !sameSubscriptionId(subscription.id, args.chargeId)) {
    logWarn(
      "billing_return_charge_mismatch",
      { chargeId: args.chargeId, active: subscription.id },
      { shopDomain: args.shopDomain },
    );
    return { ok: false, error: "charge_id does not match the active subscription" };
  }

  // Tenancy-audit R1: the plan is derived from the VERIFIED subscription's
  // name ("ChatConvert {Plan}") — never from the client-controllable callback
  // params. A mismatched/unknown name rejects the return (prevents plan
  // escalation via a crafted ?plan= once enforcement closes).
  const verifiedPlan = planFromSubscriptionName(subscription.name);
  if (!verifiedPlan) {
    return { ok: false, error: "subscription name does not match a known plan" };
  }
  if (verifiedPlan !== args.plan) {
    logWarn(
      "billing_return_plan_mismatch",
      { claimed: args.plan, verified: verifiedPlan },
      { shopDomain: args.shopDomain },
    );
  }

  const created = new Date(subscription.createdAt);
  const trialEndsAt =
    subscription.trialDays > 0
      ? new Date(created.getTime() + subscription.trialDays * 24 * 60 * 60 * 1000)
      : null;
  const planStatus = trialEndsAt && trialEndsAt.getTime() > Date.now() ? "trial" : "active";
  const interval = subscription.interval ?? args.interval;

  // QA D8: a replayed return URL converges on the same row — don't record a
  // duplicate plan_changed event when nothing actually changed.
  const unchanged =
    shop.plan === verifiedPlan &&
    shop.planStatus === planStatus &&
    shop.subscriptionId === subscription.id &&
    shop.billingInterval === interval &&
    (shop.trialEndsAt?.getTime() ?? null) === (trialEndsAt?.getTime() ?? null) &&
    shop.usageLineItemId === subscription.usageLineItemId;
  // Promo code riding on this subscription (if any) is now redeemed.
  await confirmRedemption(shop.id, subscription.id);

  if (unchanged) return { ok: true };

  await db.shop.update({
    where: { id: requireShopId(shop.id) },
    data: {
      plan: verifiedPlan,
      planStatus,
      subscriptionId: subscription.id,
      billingInterval: interval,
      trialEndsAt,
      usageLineItemId: subscription.usageLineItemId,
    },
  });
  await recordEvent(shop.id, "plan_changed", {
    plan: verifiedPlan,
    interval,
    planStatus,
    subscriptionId: subscription.id,
  });
  invalidateShopConfig(shop.id);
  return { ok: true };
}

/**
 * Free "plan" = no subscription object: cancel any active subscription and
 * reset the Shop row (data is kept — enforcement is open anyway).
 */
export async function downgradeToFree(shopDomain: string): Promise<BillingReturnResult> {
  const shop = await db.shop.findUnique({ where: { domain: shopDomain } });
  if (!shop) return { ok: false, error: "shop not found" };

  if (shop.subscriptionId) {
    try {
      await getBillingProvider().cancelSubscription(shopDomain, shop.subscriptionId);
    } catch (error) {
      logError("billing_cancel_error", error, { shopDomain });
      return { ok: false, error: "could not cancel the current subscription" };
    }
  }

  await db.shop.update({
    where: { id: requireShopId(shop.id) },
    data: {
      plan: "free",
      planStatus: "none",
      subscriptionId: null,
      billingInterval: null,
      trialEndsAt: null,
      usageLineItemId: null,
    },
  });
  // The subscription that carried the discount is gone, so return the promo's
  // redemption slot to the pool — otherwise a shop that downgrades can never
  // re-apply its own code.
  await releaseRedemptionsForShop(shop.id);
  await recordEvent(shop.id, "plan_changed", { plan: "free", planStatus: "none" });
  invalidateShopConfig(shop.id);
  return { ok: true };
}
