import db from "../../db.server";
import { adminAppUrl } from "../format/admin-url";
import { requireShopId } from "../tenancy.server";
import { runtimeConfig } from "../admin/runtime-config.server";
import { DEFAULT_PLANS, PLANS, PLAN_IDS, type PlanId } from "./plans.server";
import { recordEvent } from "../analytics/events.server";
import { invalidateShopConfig } from "../config/shop-config.server";
import { logError, logWarn } from "../log.server";
import { confirmRedemption, releaseRedemptionsForShop } from "./promo-codes.server";
import {
  trialAllowanceFor,
  trialDaysForNewSubscription,
  trialLedgerAfterGrant,
} from "./trial.server";

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

// Monthly is the ONLY billing interval. Annual was withdrawn entirely on
// 2026-09-07: Shopify rejects usage lines on ANNUAL subscriptions, so a yearly
// subscriber could never be billed for conversations past their quota and hard-
// capped instead — on the top tier with nothing left to upgrade to. Keeping the
// named type (rather than deleting the parameter) means the callback URL, the
// webhook reader and the Shop row keep their shape, and the compiler now
// refuses anything but "monthly".
export type BillingIntervalId = "monthly";
export type PaidPlanId = Exclude<PlanId, "free">;

/** Overage usage line: capped amount per spec 15 ($100 cap). The per-conversation
 *  rate comes from the plan matrix (admin-overridable) — see usageTermsFor. */
export const USAGE_CAPPED_AMOUNT = 100;

/** Usage-line terms text, derived from the plan's (possibly overridden) rate (QA D5). */
export function usageTermsFor(plan: PaidPlanId): string {
  return `$${PLANS[plan].overagePerConversation ?? 0} per extra AI conversation`;
}

/**
 * Subscription name sent to Shopify. Uses the STABLE default name
 * ("ChatConvert Basic/Pro/Plus"), never the admin-overridable display name,
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
  // Operator-managed at /admin/settings; BILLING_TEST_MODE env is the fallback.
  //
  // HARD-DISABLED IN PRODUCTION. The mock provider persists a paid plan against
  // a fabricated subscription gid without ever calling Shopify, and its
  // "verified" subscription name is reconstructed from the client-supplied
  // ?plan= — which makes the anti-plan-escalation check in
  // completeBillingReturn self-fulfilling. A stray operator toggle (or a stale
  // BILLING_TEST_MODE in the deploy environment) would therefore hand out free
  // paid tiers on the live app, so the flag is ignored outside development.
  // App Review is covered without any switch: reviewers check the production
  // app on a DEV store, and shouldCreateTestCharge() detects that per shop —
  // real Shopify flow, `test: true` on the charge, no money and nothing to
  // remember to turn back off.
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
  // Without a key the app-list fallback in adminAppUrl() would drop the
  // callback path entirely, so this path keeps its own fallback: the raw app
  // domain, which at least still carries the query string.
  if (!apiKey) return `${appUrl()}${path}`;
  return adminAppUrl(shopDomain, apiKey, path);
}

export function isPaidPlan(plan: string): plan is PaidPlanId {
  return plan === "basic" || plan === "pro" || plan === "plus";
}

/**
 * Reverse of the "ChatConvert {Plan}" subscription-name convention (audit R1).
 * Matches case-insensitively against the plan id, the DEFAULT name and the
 * CURRENT (admin-overridden) name, so subscriptions created before a rename
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
  return value === "monthly";
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

const SHOP_PLAN_QUERY = `#graphql
  query ShopIsDevelopment {
    shop {
      plan {
        partnerDevelopment
      }
    }
  }
`;

/**
 * Is this a development store?
 *
 * Replaces the old `billingForceTestCharges` operator switch (removed
 * 2026-09-07). That switch was global and manual: left on, EVERY merchant's
 * subscription was created with `test: true` and Shopify never billed any of
 * them — silently, with nothing on screen. Shopify's own guidance is the same
 * trap in prose: "After you finish testing, set test to false. Otherwise, app
 * users who install your app aren't charged."
 *
 * A development store is knowable instead of configurable: `ShopPlan
 * .partnerDevelopment` is the documented flag, and dev stores cannot process
 * real transactions at all. App reviewers check the production app on a dev
 * store, so review is covered with nothing to remember and nothing to switch
 * back off.
 *
 * Fails CLOSED. If the lookup errors we return false, meaning a REAL charge.
 * The alternative — defaulting to a test charge on an unreachable API — is the
 * revenue leak this whole change exists to remove. A dev store that wrongly
 * gets a real charge simply cannot approve it (Shopify blocks the transaction),
 * which is a visible, recoverable failure; the reverse is invisible.
 */
async function isDevelopmentStore(shopDomain: string): Promise<boolean> {
  try {
    const admin = await adminFor(shopDomain);
    const response = await admin.graphql(SHOP_PLAN_QUERY);
    const body = (await response.json()) as {
      data?: { shop?: { plan?: { partnerDevelopment?: boolean } } };
    };
    return body.data?.shop?.plan?.partnerDevelopment === true;
  } catch (error) {
    logError("shop_plan_lookup_failed", error, { shopDomain });
    return false;
  }
}

/** Whether this subscription should be created as a Shopify TEST charge. */
export async function shouldCreateTestCharge(shopDomain: string): Promise<boolean> {
  if (process.env.NODE_ENV !== "production") return true;
  return isDevelopmentStore(shopDomain);
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
  // A legacy ANNUAL subscription reads back as null: the app no longer models
  // annual, and claiming "monthly" for one would be a lie the meter acts on.
  const interval =
    recurring?.plan.pricingDetails.interval === "EVERY_30_DAYS" ? "monthly" : null;
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
            amount: def.priceMonthly,
            currencyCode: "USD",
          },
          interval: "EVERY_30_DAYS",
          // Promo code (spec 15): Shopify applies the discount itself, so the
          // approval page and every invoice show the reduced price.
          ...(discount ? { discount } : {}),
        },
      },
    };
    const lineItems: unknown[] = [recurringLine];
    // Every paid subscription is monthly now, so every paid tier with a rate
    // carries a usage line and overage works end to end (the reason annual went).
    if (def.overagePerConversation !== null) {
      lineItems.push({
        plan: {
          appUsagePricingDetails: {
            terms: usageTermsFor(plan),
            cappedAmount: { amount: USAGE_CAPPED_AMOUNT, currencyCode: "USD" },
          },
        },
      });
    }

    // NOT def.trialDays: the shop's REMAINING entitlement (trial.server.ts).
    // Shopify grants whatever we ask for, so asking for the headline allowance
    // every time restarts the trial on every reinstall and every plan switch.
    const trialDays = await trialDaysForNewSubscription(shopDomain, plan);

    const response = await admin.graphql(CREATE_MUTATION, {
      variables: {
        name: subscriptionNameFor(plan),
        returnUrl: callbackUrl(shopDomain, plan, interval),
        // Dev stores can only approve TEST subscriptions, and reviewers check the
        // production app on one. Derived per shop rather than switched by hand —
        // see shouldCreateTestCharge().
        test: await shouldCreateTestCharge(shopDomain),
        trialDays: trialDays > 0 ? trialDays : undefined,
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

/**
 * Rebuild the subscription the mock "created" purely from callback params.
 * `trialDays` is the shop's remaining entitlement, resolved by the caller —
 * the mock must not hand out the headline allowance the real provider no
 * longer asks for, or mock-mode tests would prove the wrong behaviour.
 */
export function mockSubscriptionFromParams(
  plan: PaidPlanId,
  interval: BillingIntervalId,
  chargeId?: string | null,
  trialDays: number = PLANS[plan].trialDays,
): ActiveSubscription {
  const def = PLANS[plan];
  const id = chargeId || mockSubscriptionId();
  return {
    id,
    name: subscriptionNameFor(plan),
    status: "ACTIVE",
    createdAt: new Date().toISOString(),
    trialDays,
    interval,
    // Mirrors the real provider: every monthly paid tier with a rate gets one.
    usageLineItemId:
      def.overagePerConversation !== null
        ? `${id.replace("AppSubscription", "AppSubscriptionLineItem")}-usage`
        : null,
  };
}

const mockProvider: BillingProvider = {
  async createSubscription({ shopDomain, plan, interval }) {
    const id = mockSubscriptionId();
    const confirmationUrl = `${callbackUrl(shopDomain, plan, interval)}&charge_id=${encodeURIComponent(id)}`;
    // Resolved for parity with the real provider (and so the log tells the
    // truth), even though the mock's trial is re-derived at callback time.
    const trialDays = await trialDaysForNewSubscription(shopDomain, plan);
    console.log(
      `[billing mock] createSubscription ${shopDomain} ${plan}/${interval} trial=${trialDays}d → ${id}`,
    );
    return { confirmationUrl, subscriptionId: id };
  },

  async getActiveSubscription(shopDomain) {
    // Mock has no Shopify to ask — return what the Shop row says.
    const shop = await db.shop.findUnique({ where: { domain: shopDomain } });
    if (!shop?.subscriptionId || !isPaidPlan(shop.plan)) return null;
    // Trial length is whatever the shop's live trial actually has left, not the
    // plan's headline allowance — the webhook backfill path reads this.
    const start = shop.trialStartedAt ?? shop.installedAt;
    const trialDays = shop.trialEndsAt
      ? Math.max(0, Math.round((shop.trialEndsAt.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)))
      : 0;
    return {
      id: shop.subscriptionId,
      name: subscriptionNameFor(shop.plan),
      status: "ACTIVE",
      createdAt: start.toISOString(),
      trialDays,
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
    ? mockSubscriptionFromParams(
        args.plan,
        args.interval,
        args.chargeId,
        // Same ledger the real provider consulted at create time — the mock
        // must not fabricate a full-length trial the entitlement doesn't allow.
        await trialDaysForNewSubscription(args.shopDomain, args.plan),
      )
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

  // Record the entitlement this trial came out of. Idempotent: an existing
  // ledger is carried forward, so a replayed callback can never push the
  // deadline further out (trial.server.ts).
  const ledger = trialLedgerAfterGrant({
    ledger: shop,
    allowanceDays: trialAllowanceFor(verifiedPlan),
    subscriptionCreatedAt: created,
    trialEndsAt,
  });

  // QA D8: a replayed return URL converges on the same row — don't record a
  // duplicate plan_changed event when nothing actually changed.
  const unchanged =
    shop.plan === verifiedPlan &&
    shop.planStatus === planStatus &&
    shop.subscriptionId === subscription.id &&
    shop.billingInterval === interval &&
    (shop.trialEndsAt?.getTime() ?? null) === (trialEndsAt?.getTime() ?? null) &&
    (shop.trialDeadlineAt?.getTime() ?? null) === (ledger.trialDeadlineAt?.getTime() ?? null) &&
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
      trialStartedAt: ledger.trialStartedAt,
      trialDeadlineAt: ledger.trialDeadlineAt,
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
      // Only the LIVE subscription's trial ends here. trialStartedAt /
      // trialDeadlineAt are the shop's entitlement ledger and must survive —
      // clearing them would let "downgrade to Free, resubscribe" mint a new
      // 7-day trial on demand (trial.server.ts).
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

// ── Raising the usage ceiling (spec 15, added 2026-09-03) ──────────────────
//
// `cappedAmount` is the merchant's approved maximum for one 30-day billing
// cycle. Once it is reached Shopify refuses further usage records, and the app
// stops answering rather than working for free (usage.server.ts → aiAllowed).
// Only the merchant can lift it: appSubscriptionLineItemUpdate returns a
// confirmationUrl they must approve, exactly like the original subscription.

const RAISE_CAP_MUTATION = `
  mutation RaiseUsageCap($id: ID!, $cappedAmount: MoneyInput!) {
    appSubscriptionLineItemUpdate(id: $id, cappedAmount: $cappedAmount) {
      confirmationUrl
      appSubscription { id }
      userErrors { field message }
    }
  }
`;

/** Ceiling steps offered on Plan & Usage, in USD. */
export const USAGE_CAP_STEPS = [100, 250, 500, 1000] as const;

/** The next step above the current ceiling (never lowers it). */
export function nextUsageCap(current: number): number {
  return USAGE_CAP_STEPS.find((step) => step > current) ?? Math.ceil((current * 2) / 50) * 50;
}

export async function raiseUsageCap(
  shopDomain: string,
  lineItemId: string,
  cappedAmount: number,
): Promise<{ ok: true; confirmationUrl: string | null } | { ok: false; error: string }> {
  if (isBillingTestMode()) {
    console.log(`[billing mock] raiseUsageCap ${shopDomain} ${lineItemId} → $${cappedAmount}`);
    return { ok: true, confirmationUrl: null };
  }
  try {
    const { unauthenticated } = await import("../../shopify.server");
    const { admin } = await unauthenticated.admin(shopDomain);
    const response = await admin.graphql(RAISE_CAP_MUTATION, {
      variables: { id: lineItemId, cappedAmount: { amount: cappedAmount, currencyCode: "USD" } },
    });
    const body = (await response.json()) as {
      data?: {
        appSubscriptionLineItemUpdate?: {
          confirmationUrl?: string | null;
          userErrors?: Array<{ message: string }>;
        };
      };
    };
    const payload = body.data?.appSubscriptionLineItemUpdate;
    const errors = payload?.userErrors ?? [];
    if (errors.length > 0) {
      const message = errors.map((e) => e.message).join("; ");
      logError("usage_cap_raise_error", message, { shopDomain });
      return { ok: false, error: message.slice(0, 200) };
    }
    return { ok: true, confirmationUrl: payload?.confirmationUrl ?? null };
  } catch (error) {
    logError("usage_cap_raise_error", error, { shopDomain });
    return { ok: false, error: "Shopify could not update the limit. Try again in a moment." };
  }
}
