import { useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useLocation, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { resolveShopId } from "../lib/tenancy.server";
import { PLANS, displayQuota, type PlanDefinition } from "../lib/billing/plans.server";
import { currentUsage } from "../lib/billing/usage.server";
import {
  downgradeToFree,
  getBillingProvider,
  isBillingInterval,
  isPaidPlan,
  yearlyTotal,
} from "../lib/billing/shopify-billing.server";
import { QuotaMeter } from "../components/QuotaMeter";
import { PlanCards, type PlanCardData } from "../components/PlanCards";
import { PlanDiscountCard, PlanDoneForYouCard } from "../components/PlanExtras";
import { PlanFaq } from "../components/PlanFaq";

// Plan & Usage (spec 15 / feature 15b, design plan-usage.html): usage meter,
// current-plan card, tier cards with Monthly|Yearly toggle, discount code,
// done-for-you card, billing-policy FAQ. All tier numbers derive from the plan
// matrix (plans.server.ts) — never hard-coded (known design bug avoided).
// Subscribing goes through the Shopify Billing API; the confirmation URL needs
// a top-level redirect (embedded app must break out of the iframe).

const CONTACT_HREF = "mailto:hello@progryss.com?subject=ChatConvert%20done-for-you%20setup";

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
  ];
  switch (def.id) {
    case "free":
      bullets.push(
        `${def.quotas.crawl_pages} website page source (this page only)`,
        "English only",
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
        `CSV import (50 rows) + PDF upload (${def.quotas.file_uploads} files)`,
        "Analytics CSV + conversation exports",
        "Multi-language + auto language detection",
      );
      break;
  }
  return bullets;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = await resolveShopId(session.shop);

  const [shop, usage] = await Promise.all([
    db.shop.findUnique({
      where: { id: shopId },
      select: { plan: true, planStatus: true, billingInterval: true, trialEndsAt: true },
    }),
    currentUsage(shopId),
  ]);
  const plan = shop?.plan ?? "free";

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
    usage,
    quota: displayQuota(plan, "conversations"),
    plans,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  await resolveShopId(session.shop); // ensure shop row exists

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "subscribe") {
    const plan = String(formData.get("plan") ?? "");
    const interval = String(formData.get("interval") ?? "monthly");
    if (!isBillingInterval(interval)) {
      return { ok: false as const, error: "Invalid billing interval." };
    }
    if (plan === "free") {
      const result = await downgradeToFree(session.shop);
      return result.ok
        ? { ok: true as const, downgraded: true }
        : { ok: false as const, error: result.error ?? "Could not switch to Free." };
    }
    if (!isPaidPlan(plan)) {
      return { ok: false as const, error: "Unknown plan." };
    }
    try {
      const { confirmationUrl } = await getBillingProvider().createSubscription({
        shopDomain: session.shop,
        plan,
        interval,
      });
      return { ok: true as const, confirmationUrl };
    } catch (error) {
      console.error("billing_subscribe_error", session.shop, error);
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
): { label: string; tone?: "success" | "info" | "warning" } {
  switch (planStatus) {
    case "active":
      return { label: "Active", tone: "success" };
    case "trial": {
      const ends = trialEndsAt
        ? new Date(trialEndsAt).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          })
        : null;
      return { label: ends ? `Free trial — ends ${ends}` : "Free trial", tone: "info" };
    }
    case "cancelled":
      return { label: "Cancelled", tone: "warning" };
    default:
      return { label: "No active subscription" };
  }
}

export default function PlanUsagePage() {
  const data = useLoaderData<typeof loader>();
  const location = useLocation();
  const shopify = useAppBridge();
  const fetcher = useFetcher<typeof action>();

  const [interval, setInterval] = useState<"monthly" | "yearly">(
    data.billingInterval === "yearly" ? "yearly" : "monthly",
  );
  const [subscribingPlan, setSubscribingPlan] = useState<string | null>(null);

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
    if (fetcher.data.ok && "confirmationUrl" in fetcher.data && fetcher.data.confirmationUrl) {
      // Embedded apps must break out of the iframe for the billing confirmation
      // page — top-level redirect (App Bridge intercepts window.open "_top").
      window.open(fetcher.data.confirmationUrl, "_top");
      return;
    }
    setSubscribingPlan(null);
    if (fetcher.data.ok && "downgraded" in fetcher.data && fetcher.data.downgraded) {
      shopify.toast.show("Switched to the Free plan");
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const selectPlan = (planId: string) => {
    if (planId === data.plan) return;
    setSubscribingPlan(planId);
    fetcher.submit({ intent: "subscribe", plan: planId, interval }, { method: "post" });
  };

  const pct = data.quota > 0 ? Math.round((data.usage / data.quota) * 100) : 0;
  const badge = statusBadge(data.planStatus, data.trialEndsAt);
  const actionError =
    fetcher.state === "idle" && fetcher.data && !fetcher.data.ok ? fetcher.data.error : null;

  return (
    <s-page heading="Plan & Usage">
      <s-stack gap="base">
        {billingError ? (
          <s-banner tone="critical" heading="Subscription not completed">
            The subscription could not be verified — no charge was made. Please try again.
          </s-banner>
        ) : null}
        {actionError ? (
          <s-banner tone="critical" heading="Something went wrong">
            {actionError}
          </s-banner>
        ) : null}

        <s-section heading="Usage this month">
          <s-paragraph>Resets on the 1st. Conversations are your plan meter.</s-paragraph>
          <QuotaMeter used={data.usage} quota={data.quota} label="conversations used" />
          <s-paragraph>
            You&apos;re at <b>{pct}%</b> of the {data.planName} allowance.
          </s-paragraph>
        </s-section>

        <s-section heading="Your plan">
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-heading>{data.planName}</s-heading>
            <s-badge tone={badge.tone}>{badge.label}</s-badge>
          </s-stack>
        </s-section>

        <s-section>
          <PlanCards
            plans={data.plans}
            currentPlan={data.plan}
            interval={interval}
            onIntervalChange={setInterval}
            onSelect={selectPlan}
            subscribingPlan={subscribingPlan}
          />
        </s-section>

        <PlanDiscountCard />
        <PlanDoneForYouCard contactHref={CONTACT_HREF} />
        <PlanFaq contactHref={CONTACT_HREF} />
      </s-stack>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
