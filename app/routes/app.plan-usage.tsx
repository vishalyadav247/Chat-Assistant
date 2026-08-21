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
import {
  PLANS,
  displayQuota,
  overageRate,
  type PlanDefinition,
} from "../lib/billing/plans.server";
import { currentUsage, overageBillable } from "../lib/billing/usage.server";
import {
  downgradeToFree,
  getBillingProvider,
  isBillingInterval,
  isPaidPlan,
  yearlyTotal,
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
import { PlanDiscountCard, PlanDoneForYouCard } from "../components/PlanExtras";
import { PlanFaq } from "../components/PlanFaq";
import { requireShopAccess } from "../lib/access.server";
import { routeError } from "../lib/ui/route-error";
import { useDateTime } from "../lib/format/context";
import { logError } from "../lib/log.server";

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

/** Design bullet copy with all numbers taken from the plan matrix. */
function bulletsFor(def: PlanDefinition): string[] {
  const n = (value: number) => value.toLocaleString("en-US");
  const bullets = [
    `${n(def.quotas.conversations)} conversations / month`,
    `Up to ${n(def.quotas.products_synced)} products synced`,
    `${n(def.quotas.curated_answers)} curated answers · ${n(def.quotas.manual_qas)} manual Q&As`,
    `${n(def.quotas.policy_pages)} policy pages`,
    // Available on every plan (not gated) — listed on all cards so the
    // comparison stays factual.
    "Multi-language + auto language detection",
  ];
  switch (def.id) {
    case "free":
      bullets.push(
        `${def.quotas.crawl_pages} website page source (this page only)`,
      );
      break;
    case "basic":
    case "pro":
      bullets.push(
        `Website crawl: this page + linked pages (${def.quotas.crawl_pages} pages)`,
        "Unanswered-questions analytics",
        "Remove ChatConvert branding",
      );
      break;
    case "plus":
      bullets.push(
        `Full-site website crawl (${def.quotas.crawl_pages} pages)`,
        // No csv-row quota dimension exists in the plan matrix — don't invent
        // one in the copy (QA D10); file_uploads covers the PDF side.
        `CSV import + PDF upload (${def.quotas.file_uploads} files)`,
        "Analytics CSV + conversation exports",
      );
      break;
  }
  return bullets;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const access = await requireShopAccess(request, { permission: "plan" });
  const { shopId, shopDomain } = access;

  const [shop, usage] = await Promise.all([
    db.shop.findUnique({
      where: { id: shopId },
      select: {
        plan: true,
        planStatus: true,
        billingInterval: true,
        trialEndsAt: true,
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

  const plans: PlanCardData[] = Object.values(PLANS).map((def) => ({
    id: def.id,
    name: def.name,
    description: PLAN_DESCRIPTIONS[def.id] ?? "",
    priceMonthly: def.priceMonthly,
    priceYearlyPerMonth: def.priceYearlyPerMonth,
    yearlyTotal: def.id === "free" ? 0 : yearlyTotal(def.id),
    trialDays: def.trialDays,
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
    usage,
    quota: displayQuota(plan, "conversations"),
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

  const [interval, setInterval] = useState<"monthly" | "yearly">(
    data.billingInterval === "yearly" ? "yearly" : "monthly",
  );
  const [subscribingPlan, setSubscribingPlan] = useState<string | null>(null);
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
        interval,
        // Carry an already-redeemed code into the new subscription so an
        // upgrade doesn't silently drop a "forever" discount and force the
        // merchant to retype it. The server re-validates it against the
        // chosen plan+interval either way.
        code: promo?.code ?? data.activePromo?.code ?? "",
      },
      { method: "post" },
    );
  };

  const pct = data.quota > 0 ? Math.round((data.usage / data.quota) * 100) : 0;
  const badge = statusBadge(data.planStatus, data.trialEndsAt, dt.date);
  const actionError =
    fetcher.state === "idle" && fetcher.data && !fetcher.data.ok
      ? fetcher.data.error
      : null;

  return (
    <s-page heading="Plan & Usage">
      <s-stack gap="base">
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
            You&apos;re at <b>{pct}%</b> of the {data.planName} allowance.
          </s-paragraph>
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
            interval={interval}
            onIntervalChange={setInterval}
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

        <PlanDiscountCard
          applied={promo}
          onApplied={setPromo}
          onRemove={() => setPromo(null)}
          disabled={!data.billingManageable}
        />
        <PlanDoneForYouCard contactHref={CONTACT_HREF} />
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
