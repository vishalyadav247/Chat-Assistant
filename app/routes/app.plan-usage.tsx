import { useEffect, useMemo, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  useFetcher,
  useLoaderData,
  useLocation,
  useRouteError,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "../lib/ui/surface";
import db from "../db.server";
import { resolveShopId } from "../lib/tenancy.server";
import { runtimeConfig } from "../lib/admin/runtime-config.server";
import {
  GATED_FEATURES,
  PLANS,
  QUOTA_DIMENSIONS,
  isUnlimitedQuota,
  offeredPlans,
  overageRate,
  type GatedFeature,
  type PlanDefinition,
  type QuotaDimension,
} from "../lib/billing/plans.server";
import { currentUsage, overageBillable, usageStatus } from "../lib/billing/usage.server";
import { invalidateUsageBalance } from "../lib/billing/usage-cap.server";
import {
  downgradeToFree,
  getBillingProvider,
  isBillingInterval,
  isPaidPlan,
  nextUsageCap,
  raiseUsageCap,
} from "../lib/billing/shopify-billing.server";
import { QuotaMeter } from "../components/QuotaMeter";
import {
  PlanCards,
  type PlanCardData,
  type PlanPromo,
} from "../components/PlanCards";
import {
  activeRedemptionFor,
  discountInputFor,
  recordPendingRedemption,
  validatePromoCode,
} from "../lib/billing/promo-codes.server";
import { PlanDiscountCard, PlanSupportCard } from "../components/PlanExtras";
import { PlanFaq } from "../components/PlanFaq";
import { trialDaysByPlan } from "../lib/billing/trial.server";
import { requireShopAccess } from "../lib/access.server";
import { routeError } from "../lib/ui/route-error";
import { useDateTime } from "../lib/format/context";
import { logError } from "../lib/log.server";
import { APP_NAME } from "./app";

// Plan & Usage (spec 15 / feature 15b, design plan-usage.html): usage meter,
// current-plan card, tier cards with Monthly|Yearly toggle, discount code,
// done-for-you card, billing-policy FAQ. All tier numbers derive from the plan
// matrix (plans.server.ts) — never hard-coded (known design bug avoided).
// Subscribing goes through the Shopify Billing API; the confirmation URL needs
// a top-level redirect (embedded app must break out of the iframe).

const CONTACT_HREF =
  "mailto:hello@progryss.com?subject=ChatConvert%20done-for-you%20setup";

// Verbatim tier descriptions from the design prototype.
const PLAN_DESCRIPTIONS: Record<string, string> = {
  free: "For solo entrepreneurs who need basic live chat and FAQs at no cost.",
  basic: "For small and medium businesses scaling their support service.",
  pro: "For growing businesses that need advanced support and proactive sales conversion.",
  plus: "For large stores with high-volume conversations and unlimited AI capabilities.",
};

const n = (value: number) => value.toLocaleString("en-US");
const amount = (value: number) => (isUnlimitedQuota(value) ? "Unlimited" : n(value));

/** One line per quota dimension, taking the whole definition so a bullet can
 *  read more than one quota. `null` = deliberately NOT a card line: the card
 *  carries the headline limits only, not every dimension the matrix enforces.
 *  A `0` is skipped by the caller — a pricing card lists what you get. */
const QUOTA_BULLET: Record<QuotaDimension, (def: PlanDefinition) => string | null> = {
  conversations: (d) => `${amount(d.quotas.conversations)} conversations / month`,
  products_synced: (d) =>
    isUnlimitedQuota(d.quotas.products_synced)
      ? "Unlimited products synced"
      : `Up to ${n(d.quotas.products_synced)} products synced`,
  // The same idea to a merchant — kept on one line rather than split in two.
  curated_answers: (d) => {
    const curated = `${amount(d.quotas.curated_answers)} curated answers`;
    return d.quotas.manual_qas
      ? `${curated} · ${amount(d.quotas.manual_qas)} manual Q&As`
      : curated;
  },
  manual_qas: () => null, // merged into the curated_answers line above
  policy_pages: (d) => `${amount(d.quotas.policy_pages)} policy pages`,
  crawl_pages: (d) =>
    isUnlimitedQuota(d.quotas.crawl_pages)
      ? "Full-site website crawl"
      : d.quotas.crawl_pages <= 1
        ? "Website crawl: 1 page"
        : `Website crawl: ${n(d.quotas.crawl_pages)} pages`,
  // Covers the csv_import / file_upload FEATURES too — the count says more than
  // a bare "CSV import" line, so those two features render nothing (see below).
  file_uploads: (d) => `CSV import + PDF upload (${amount(d.quotas.file_uploads)} files)`,
  metafields_enabled: () => null,
  team_seats: (d) =>
    d.quotas.team_seats <= 1
      ? "1 team seat (owner only)"
      : `${amount(d.quotas.team_seats)} team seats`,
  active_campaigns: (d) => `${amount(d.quotas.active_campaigns)} active proactive campaigns`,
  analytics_range_days: (d) =>
    isUnlimitedQuota(d.quotas.analytics_range_days)
      ? "Full analytics history"
      : `${n(d.quotas.analytics_range_days)} days of analytics history`,
};

/** One line per gated feature. `null` = not card copy — either a quota line
 *  above already states it with a number, or it is a detail rather than a
 *  headline reason to choose a tier. The gate itself is unaffected either way;
 *  every one of these is still enforced and still surfaced in-product by the
 *  PlanBadge / PlanBanner on the screen that owns the feature. */
const FEATURE_BULLET: Record<GatedFeature, string | null> = {
  remove_branding: null,
  unanswered_analytics: null,
  discount_realtime_sync: null,
  catalog_auto_sync: null,
  premium_campaign_templates: null,
  inbox_cart_view: null,
  exports: null,
  csv_import: null, // stated by the file_uploads quota line
  file_upload: null, // stated by the file_uploads quota line
  survey: null,
  push_notifications: "Browser push notifications",
  custom_recommendations: "Custom recommendations + cross-sell pairs",
};

/** GENERATED from the live plan matrix, never hand-written per plan id.
 *  The matrix is operator-editable at /admin/plans, so hand-authored copy
 *  silently stops matching what the app enforces the moment a limit or a
 *  feature moves between tiers — which is exactly how every card came to
 *  advertise "Multi-language", a feature only Plus has ever granted. */
function bulletsFor(def: PlanDefinition): string[] {
  const bullets: string[] = [];
  for (const dimension of QUOTA_DIMENSIONS) {
    if (!def.quotas[dimension]) continue; // 0 = not included on this plan
    const line = QUOTA_BULLET[dimension](def);
    if (line) bullets.push(line);
  }
  for (const feature of GATED_FEATURES) {
    if (!def.features.includes(feature)) continue;
    const line = FEATURE_BULLET[feature];
    if (line) bullets.push(line);
  }
  return bullets;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const access = await requireShopAccess(request, { permission: "plan" });
  const { shopId, shopDomain } = access;

  // One read of the metering picture for the whole loader (it may call Shopify
  // for the spend balance, so never twice).
  const status = await usageStatus(shopId);

  const [shop, usage] = await Promise.all([
    db.shop.findUnique({
      where: { id: shopId },
      select: {
        plan: true,
        planStatus: true,
        billingInterval: true,
        trialEndsAt: true,
        // Entitlement ledger — the cards must advertise the trial this shop can
        // still get, not the tier's headline allowance (trial.server.ts).
        trialStartedAt: true,
        trialDeadlineAt: true,
        subscriptionId: true,
        // Needed by overageBillable() below — a shop with no usage line item
        // (every ANNUAL subscription) can never be charged for overage.
        usageLineItemId: true,
      },
    }),
    currentUsage(shopId),
  ]);
  const plan = shop?.plan ?? "free";
  const activePromo = await activeRedemptionFor(
    shopId,
    shop?.subscriptionId ?? null,
  );

  // Remaining trial days per tier for this shop: a full allowance on a first
  // subscription, fewer once part-used, 0 once spent.
  const trialDays = trialDaysByPlan(
    shop ?? { trialStartedAt: null, trialDeadlineAt: null },
    Object.keys(PLANS) as (keyof typeof PLANS)[],
  );

  // Withdrawn tiers (/admin/plans) are not offered — except the shop's own,
  // which must still appear or the page would claim it is on something else.
  const plans: PlanCardData[] = offeredPlans(plan).map((def) => ({
    id: def.id,
    name: def.name,
    description: PLAN_DESCRIPTIONS[def.id] ?? "",
    priceMonthly: def.priceMonthly,
    trialDays: trialDays[def.id] ?? 0,
    overagePerConversation: def.overagePerConversation,
    bullets: bulletsFor(def),
    popular: def.id === "pro",
  }));

  return {
    plan,
    planName: PLANS[plan as keyof typeof PLANS]?.name ?? "Free",
    planStatus: shop?.planStatus ?? "none",
    billingInterval: shop?.billingInterval,
    trialEndsAt: shop?.trialEndsAt ? shop.trialEndsAt.toISOString() : null,
    activePromo,
    couponsEnabled: runtimeConfig().promoCodesEnabled,
    usage,
    // Plan allowance PLUS any live bonus grant — the SAME number the meter is
    // held to. `status.quota` already sums them; reading the plan alone here is
    // what made the count exclude a bonus the banner was announcing.
    quota: status.quota,
    // Everything the merchant needs to understand metering: how close they are,
    // whether they are being charged, and whether the AI has stopped because
    // their approved spend limit is full (spec 15, 2026-09-03).
    usageStatus: status,
    // Computed here: nextUsageCap lives in a .server module and the banner is
    // client code.
    nextUsageCap: nextUsageCap(status.capped),
    // FAQ copy reads the overage rate from the matrix, never a literal (D10).
    // It must reflect what this shop can ACTUALLY be billed, not just the
    // tier's headline rate: Shopify rejects usage line items on ANNUAL
    // subscriptions, so a yearly subscriber has no usage line and hard-caps at
    // quota exactly like Free. Passing the matrix rate promised overage billing
    // they can never receive (QA D-15). overageBillable() is the same predicate
    // the meter itself uses, so the copy and the behaviour cannot drift.
    overagePerConversation: shop && overageBillable(shop) ? overageRate(plan) : null,
    plans,
    // Spec 18: Shopify Billing confirmation must run inside the admin, so the
    // web surface is read-only with a deep link back.
    billingManageable: access.surface === "admin",
    adminPlanUrl: `https://admin.shopify.com/store/${shopDomain.replace(".myshopify.com", "")}/apps/${process.env.SHOPIFY_API_KEY ?? ""}/app/plan-usage`,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  // Billing mutations are admin-surface only (spec 18) — requireShopAccess
  // throws 403 for the web surface on "billing_manage".
  const { shopDomain } = await requireShopAccess(request, {
    permission: "billing_manage",
  });
  const shopId = await resolveShopId(shopDomain); // ensure shop row exists

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  // Promo code (spec 15): validate server-side; the cards preview the price,
  // Shopify applies the discount when the subscription is created.
  if (intent === "validate_code") {
    const result = await validatePromoCode({
      shopId,
      code: String(formData.get("code") ?? ""),
    });
    return result.ok
      ? { ok: true as const, promo: result.promo }
      : { ok: false as const, error: result.error, field: "code" as const };
  }

  // Raise the usage ceiling (spec 15). Only the merchant can approve a higher
  // limit, so this returns Shopify's confirmation URL and the page breaks out
  // of the iframe for it, exactly like subscribing.
  if (intent === "raise_cap") {
    const shop = await db.shop.findUnique({
      where: { id: shopId },
      select: { usageLineItemId: true },
    });
    if (!shop?.usageLineItemId) {
      return { ok: false as const, error: "This subscription has no usage limit to raise." };
    }
    const status = await usageStatus(shopId);
    const result = await raiseUsageCap(shopDomain, shop.usageLineItemId, nextUsageCap(status.capped));
    if (!result.ok) return { ok: false as const, error: result.error };
    invalidateUsageBalance(shopId);
    return { ok: true as const, confirmationUrl: result.confirmationUrl };
  }

  if (intent === "subscribe") {
    const plan = String(formData.get("plan") ?? "");
    const interval = String(formData.get("interval") ?? "monthly");
    if (!isBillingInterval(interval)) {
      return { ok: false as const, error: "Invalid billing interval." };
    }
    if (plan === "free") {
      const result = await downgradeToFree(shopDomain);
      return result.ok
        ? { ok: true as const, downgraded: true }
        : {
            ok: false as const,
            error: result.error ?? "Could not switch to Free.",
          };
    }
    if (!isPaidPlan(plan)) {
      return { ok: false as const, error: "Unknown plan." };
    }
    const code = String(formData.get("code") ?? "").trim();
    let promo = null;
    if (code) {
      // Re-validated here (never trust the earlier client round-trip) and now
      // against the chosen plan + interval.
      const result = await validatePromoCode({ shopId, code, plan, interval });
      if (!result.ok)
        return {
          ok: false as const,
          error: result.error,
          field: "code" as const,
        };
      promo = result.promo;
    }
    try {
      const { confirmationUrl, subscriptionId } =
        await getBillingProvider().createSubscription({
          shopDomain: shopDomain,
          plan,
          interval,
          discount: promo ? discountInputFor(promo) : null,
        });
      if (promo && subscriptionId) {
        await recordPendingRedemption({
          shopId,
          promoId: promo.id,
          subscriptionId,
          plan,
          interval,
        });
      }
      return { ok: true as const, confirmationUrl };
    } catch (error) {
      logError("billing_subscribe_error", error, { shopDomain });
      return {
        ok: false as const,
        error: "Could not start the subscription — please try again.",
      };
    }
  }

  return { ok: false as const, error: "Unknown action." };
};

function statusBadge(
  planStatus: string,
  trialEndsAt: string | null,
  formatDate: (iso: string) => string,
): { label: string; tone?: "success" | "info" | "warning" } {
  switch (planStatus) {
    case "active":
      return { label: "Active", tone: "success" };
    case "trial": {
      const ends = trialEndsAt ? formatDate(trialEndsAt) : null;
      return {
        label: ends ? `Free trial — ends ${ends}` : "Free trial",
        tone: "info",
      };
    }
    case "cancelled":
      return { label: "Cancelled", tone: "warning" };
    default:
      return { label: "No active subscription" };
  }
}

export default function PlanUsagePage() {
  const data = useLoaderData<typeof loader>();
  const dt = useDateTime();
  const location = useLocation();
  const shopify = useAppBridge();
  const fetcher = useFetcher<typeof action>();

  const [subscribingPlan, setSubscribingPlan] = useState<string | null>(null);
  const [raisingCap, setRaisingCap] = useState(false);
  const [promo, setPromo] = useState<PlanPromo | null>(null);

  const upgraded = useMemo(
    () => new URLSearchParams(location.search).get("upgraded") === "1",
    [location.search],
  );
  const billingError = useMemo(
    () => new URLSearchParams(location.search).get("billing_error") === "1",
    [location.search],
  );

  useEffect(() => {
    if (upgraded) shopify.toast.show("Plan updated");
  }, [upgraded, shopify]);

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (
      fetcher.data.ok &&
      "confirmationUrl" in fetcher.data &&
      fetcher.data.confirmationUrl
    ) {
      // Embedded apps must break out of the iframe for the billing confirmation
      // page — top-level redirect (App Bridge intercepts window.open "_top").
      window.open(fetcher.data.confirmationUrl, "_top");
      return;
    }
    setSubscribingPlan(null);
    setRaisingCap(false);
    if (
      fetcher.data.ok &&
      "downgraded" in fetcher.data &&
      fetcher.data.downgraded
    ) {
      shopify.toast.show("Switched to the Free plan");
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const selectPlan = (planId: string) => {
    if (planId === data.plan) return;
    setSubscribingPlan(planId);
    fetcher.submit(
      {
        intent: "subscribe",
        plan: planId,
        // Carry an already-redeemed code into the new subscription so an
        // upgrade does not silently drop a "forever" discount and force the
        // merchant to retype it. The server re-validates it against the
        // chosen plan either way.
        code: promo?.code ?? data.activePromo?.code ?? "",
      },
      { method: "post" },
    );
  };

  const usage = data.usageStatus;
  const nextCap = data.nextUsageCap;
  const raiseCap = () => {
    setRaisingCap(true);
    fetcher.submit({ intent: "raise_cap" }, { method: "post" });
  };

  const pct = data.quota > 0 ? Math.round((data.usage / data.quota) * 100) : 0;
  const badge = statusBadge(data.planStatus, data.trialEndsAt, dt.date);
  const actionError =
    fetcher.state === "idle" && fetcher.data && !fetcher.data.ok
      ? fetcher.data.error
      : null;

  return (
    <s-page heading={APP_NAME}>
      <s-stack gap="base">
        <s-heading>Plan &amp; Usage</s-heading>
        {billingError ? (
          <s-banner tone="critical" heading="Subscription not completed">
            The subscription could not be verified — no charge was made. Please
            try again.
          </s-banner>
        ) : null}
        {actionError ? (
          <s-banner tone="critical" heading="Something went wrong">
            {actionError}
          </s-banner>
        ) : null}

        {/* Metering is money, so it says so out loud (spec 15, 2026-09-03).
            Three states, in the order they can happen: approaching the
            allowance, being charged past it, and stopped because the approved
            spend limit is full. */}
        {usage.ceilingReached ? (
          <s-banner tone="critical" heading="AI replies are paused — spending limit reached">
            <s-paragraph>
              You&apos;ve used the ${usage.capped} extra-conversation limit you approved for this
              billing cycle, so the AI has stopped answering new conversations. Raise the limit to
              switch it back on — Shopify will ask you to approve the new amount, and you&apos;re
              only ever charged for conversations actually handled.
            </s-paragraph>
            <s-button
              slot="primary-action"
              variant="primary"
              loading={raisingCap}
              onClick={raiseCap}
            >
              Raise limit to ${nextCap}
            </s-button>
          </s-banner>
        ) : usage.overage > 0 ? (
          <s-banner tone="warning" heading="You're past your plan allowance">
            <s-paragraph>
              {usage.overage.toLocaleString("en-US")} extra conversation
              {usage.overage === 1 ? "" : "s"} this month
              {usage.rate ? ` at $${usage.rate.toFixed(2)} each` : ""}
              {usage.spend > 0 ? ` — $${usage.spend.toFixed(2)} so far` : ""}, billed by Shopify on
              your next invoice. Your limit for this cycle is ${usage.capped}.
              {usage.unbilled > 0
                ? " A few are still being reported to Shopify; they'll appear shortly."
                : ""}{" "}
              Upgrading raises the included allowance.
            </s-paragraph>
          </s-banner>
        ) : usage.nearCap ? (
          <s-banner tone="warning" heading="You're close to your monthly allowance">
            <s-paragraph>
              {usage.used.toLocaleString("en-US")} of {data.quota.toLocaleString("en-US")}{" "}
              conversations used.{" "}
              {usage.billable && usage.rate
                ? `After that the AI keeps replying and extra conversations are billed at $${usage.rate.toFixed(2)} each, up to the $${usage.capped} limit you approved.`
                : "After that the AI stops replying until the 1st. Upgrade for a bigger allowance."}
            </s-paragraph>
          </s-banner>
        ) : null}

        <s-section heading="Usage this month">
          <s-paragraph>
            Resets on the 1st. Conversations are your plan meter.
          </s-paragraph>
          <QuotaMeter
            used={data.usage}
            quota={data.quota}
            label="conversations used"
          />
          <s-paragraph>
            You&apos;re at <b>{pct}%</b> of{" "}
            {usage.credits > 0 ? "your allowance including bonus" : `the  allowance`}.
          </s-paragraph>
          {usage.overage > 0 ? (
            <s-paragraph>
              Plus <b>{usage.overage.toLocaleString("en-US")}</b> extra conversation
              {usage.overage === 1 ? "" : "s"}
              {usage.rate ? ` at $${usage.rate.toFixed(2)} each` : ""} — <b>${usage.spend.toFixed(2)}</b>{" "}
              of your ${usage.capped} limit for this billing cycle.
            </s-paragraph>
          ) : null}
          {/* A silent balance would make the merchant's own numbers look wrong:
              they would pass their allowance and carry on working with nothing
              on screen explaining why. */}
          {usage.credits > 0 ? (
            <s-banner tone="success">
              The count above includes <b>{usage.credits.toLocaleString("en-US")}</b> bonus
              conversation{usage.credits === 1 ? "" : "s"} on top of your {data.planName} plan, added
              by the ChatConvert team. They are never charged, and your limit returns to the plan
              amount if they are withdrawn.
            </s-banner>
          ) : null}
        </s-section>

        <s-section heading="Your plan">
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-heading>{data.planName}</s-heading>
            <s-badge tone={badge.tone}>{badge.label}</s-badge>
            {data.activePromo ? (
              <s-badge tone="success">
                {data.activePromo.code} · {data.activePromo.label}
              </s-badge>
            ) : null}
          </s-stack>
          {!data.billingManageable ? (
            <s-banner tone="info">
              Plan changes are made in the Shopify admin.{" "}
              <s-link href={data.adminPlanUrl} target="_blank">
                Open Plan &amp; Usage in Shopify admin
              </s-link>
            </s-banner>
          ) : null}
        </s-section>

        <s-section>
          <PlanCards
            plans={data.plans}
            currentPlan={data.plan}
            onSelect={
              data.billingManageable
                ? selectPlan
                : () =>
                    shopify.toast.show(
                      "Change your plan from the Shopify admin",
                    )
            }
            subscribingPlan={subscribingPlan}
            promo={promo}
          />
        </s-section>

        {/* Coupons are an operator-level feature switch (/admin/promo-codes).
            Off = no field at all, rather than a field that always fails. */}
        {data.couponsEnabled ? (
          <PlanDiscountCard
            applied={promo}
            onApplied={setPromo}
            onRemove={() => setPromo(null)}
            disabled={!data.billingManageable}
          />
        ) : null}
        <PlanSupportCard />
        <PlanFaq
          contactHref={CONTACT_HREF}
          overagePerConversation={data.overagePerConversation}
        />
      </s-stack>
    </s-page>
  );
}

export function ErrorBoundary() {
  return routeError(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
