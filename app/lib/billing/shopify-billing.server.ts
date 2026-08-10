import db from "../../db.server";
import { requireShopId } from "../tenancy.server";
import { PLANS, type PlanId } from "./plans.server";
import { recordEvent } from "../analytics/events.server";
import { invalidateShopConfig } from "../config/shop-config.server";

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

/** Overage usage line: capped amount per spec 15 ($0.4/conversation, $100 cap). */
export const USAGE_CAPPED_AMOUNT = 100;
export const USAGE_TERMS = "$0.4 per extra AI conversation";

export interface ActiveSubscription {
  id: string;
  name: string;
  status: string; // ACTIVE | CANCELLED | EXPIRED | ...
  createdAt: string; // ISO timestamp
  trialDays: number;
  interval: BillingIntervalId | null;
  usageLineItemId: string | null;
}

export interface BillingProvider {
  createSubscription(args: {
    shopDomain: string;
    plan: PaidPlanId;
    interval: BillingIntervalId;
  }): Promise<{ confirmationUrl: string }>;
  getActiveSubscription(shopDomain: string): Promise<ActiveSubscription | null>;
  cancelSubscription(shopDomain: string, subscriptionId: string): Promise<void>;
}

export function isBillingTestMode(): boolean {
  return process.env.BILLING_TEST_MODE === "1";
}

export function getBillingProvider(): BillingProvider {
  return isBillingTestMode() ? mockProvider : realProvider;
}

function appUrl(): string {
  return (process.env.SHOPIFY_APP_URL || "").replace(/\/+$/, "");
}

function callbackUrl(plan: PlanId, interval: BillingIntervalId): string {
  return `${appUrl()}/app/billing-callback?plan=${plan}&interval=${interval}`;
}

export function isPaidPlan(plan: string): plan is PaidPlanId {
  return plan === "basic" || plan === "pro" || plan === "plus";
}

/** Reverse of the "ChatConvert {Plan}" subscription-name convention (audit R1). */
export function planFromSubscriptionName(name: string): PaidPlanId | null {
  const match = /^ChatConvert\s+(.+)$/i.exec(name.trim());
  if (!match) return null;
  const candidate = match[1].trim().toLowerCase();
  return isPaidPlan(candidate) ? candidate : null;
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
  async createSubscription({ shopDomain, plan, interval }) {
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
        },
      },
    };
    const lineItems: unknown[] = [recurringLine];
    if (def.overagePerConversation !== null) {
      lineItems.push({
        plan: {
          appUsagePricingDetails: {
            terms: USAGE_TERMS,
            cappedAmount: { amount: USAGE_CAPPED_AMOUNT, currencyCode: "USD" },
          },
        },
      });
    }

    const response = await admin.graphql(CREATE_MUTATION, {
      variables: {
        name: `ChatConvert ${def.name}`,
        returnUrl: callbackUrl(plan, interval),
        // Review M2: dev stores can only approve test subscriptions. Default to
        // test outside production, and allow forcing test charges in production
        // (app review + partner test stores) via env.
        test:
          process.env.NODE_ENV !== "production" ||
          process.env.BILLING_FORCE_TEST_CHARGES === "1",
        trialDays: def.trialDays > 0 ? def.trialDays : undefined,
        lineItems,
      },
    });
    const body = (await response.json()) as {
      data?: {
        appSubscriptionCreate?: {
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
    return { confirmationUrl: result.confirmationUrl };
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
    name: `ChatConvert ${def.name}`,
    status: "ACTIVE",
    createdAt: new Date().toISOString(),
    trialDays: def.trialDays,
    interval,
    usageLineItemId:
      def.overagePerConversation !== null
        ? `${id.replace("AppSubscription", "AppSubscriptionLineItem")}-usage`
        : null,
  };
}

const mockProvider: BillingProvider = {
  async createSubscription({ shopDomain, plan, interval }) {
    const id = mockSubscriptionId();
    const confirmationUrl = `${callbackUrl(plan, interval)}&charge_id=${encodeURIComponent(id)}`;
    console.log(`[billing mock] createSubscription ${shopDomain} ${plan}/${interval} → ${id}`);
    return { confirmationUrl };
  },

  async getActiveSubscription(shopDomain) {
    // Mock has no Shopify to ask — return what the Shop row says.
    const shop = await db.shop.findUnique({ where: { domain: shopDomain } });
    if (!shop?.subscriptionId || !isPaidPlan(shop.plan)) return null;
    const def = PLANS[shop.plan];
    return {
      id: shop.subscriptionId,
      name: `ChatConvert ${def.name}`,
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

  // Tenancy-audit R1: the plan is derived from the VERIFIED subscription's
  // name ("ChatConvert {Plan}") — never from the client-controllable callback
  // params. A mismatched/unknown name rejects the return (prevents plan
  // escalation via a crafted ?plan= once enforcement closes).
  const verifiedPlan = planFromSubscriptionName(subscription.name);
  if (!verifiedPlan) {
    return { ok: false, error: "subscription name does not match a known plan" };
  }
  if (verifiedPlan !== args.plan) {
    console.warn("billing_return_plan_mismatch", { claimed: args.plan, verified: verifiedPlan });
  }

  const created = new Date(subscription.createdAt);
  const trialEndsAt =
    subscription.trialDays > 0
      ? new Date(created.getTime() + subscription.trialDays * 24 * 60 * 60 * 1000)
      : null;
  const planStatus = trialEndsAt && trialEndsAt.getTime() > Date.now() ? "trial" : "active";

  await db.shop.update({
    where: { id: requireShopId(shop.id) },
    data: {
      plan: verifiedPlan,
      planStatus,
      subscriptionId: subscription.id,
      billingInterval: subscription.interval ?? args.interval,
      trialEndsAt,
      usageLineItemId: subscription.usageLineItemId,
    },
  });
  await recordEvent(shop.id, "plan_changed", {
    plan: verifiedPlan,
    interval: subscription.interval ?? args.interval,
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
      console.error("billing_cancel_error", shopDomain, error);
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
  await recordEvent(shop.id, "plan_changed", { plan: "free", planStatus: "none" });
  invalidateShopConfig(shop.id);
  return { ok: true };
}
