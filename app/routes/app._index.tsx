import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import {
  useFetcher,
  useLoaderData,
  useNavigate,
  useRevalidator,
  useRouteError,
  useSearchParams,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "../lib/ui/surface";
import db from "../db.server";
import { enqueueSync } from "../lib/jobs/queue.server";
import { JOBS } from "../lib/jobs/handlers.server";
import { invalidateShopConfig } from "../lib/config/shop-config.server";
import {
  DASHBOARD_RANGES,
  dashboardMetrics,
  liveFeed,
  setupChecklist,
  type DashboardRange,
} from "../lib/dashboard/dashboard.server";
import { DashboardHero } from "../components/DashboardHero";
import { DashboardOverview } from "../components/DashboardOverview";
import { DashboardChecklist } from "../components/DashboardChecklist";
import { DashboardLiveFeed } from "../components/DashboardLiveFeed";
import { StripBanner } from "../components/ui/StripBanner";
import { allowedRanges } from "../lib/analytics/reports.server";
import { currentUsage } from "../lib/billing/usage.server";
import { getQuota, nextPlanNameForQuota } from "../lib/billing/plans.server";
import { can, requireShopAccess } from "../lib/access.server";
import { routeError } from "../lib/ui/route-error";
import { logError } from "../lib/log.server";
import { APP_NAME } from "./app";

// Dashboard (spec 13, design dashboard.html): greeting hero, overview KPIs
// with range/compare, 6-step setup checklist with progress ring, live
// conversations feed. All aggregates are shop-scoped and exclude isTest
// conversations (app/lib/dashboard/dashboard.server.ts).

const SHOP_INFO_QUERY = `#graphql
  query DashboardShopInfo {
    shop {
      name
      ianaTimezone
      currencyCode
    }
  }
`;

function isRange(value: string | null): value is DashboardRange {
  return value !== null && (DASHBOARD_RANGES as string[]).includes(value);
}

function greetingFor(timezone: string): string {
  let hour = new Date().getUTCHours();
  try {
    hour = Number(
      new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        hour12: false,
        timeZone: timezone,
      }).format(new Date()),
    );
  } catch {
    // invalid shop timezone — fall back to UTC hour
  }
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 17) return "Good afternoon";
  return "Good evening";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const access = await requireShopAccess(request, { permission: "dashboard" });
  const { shopId, shopDomain } = access;
  // Used only for the one-off identity backfill below. The dashboard must render
  // for a web-surface member even when no Shopify session is available, so a
  // missing admin client skips the backfill rather than failing the page.
  const admin = await access.getAdminOptional();
  const url = new URL(request.url);
  const rangeParam = url.searchParams.get("range");
  const range: DashboardRange = isRange(rangeParam) ? rangeParam : "7d";

  const shopSelect = {
    name: true,
    timezone: true,
    currency: true,
    aiEnabled: true,
    plan: true,
  } as const;
  let shop = await db.shop.findUnique({ where: { id: shopId }, select: shopSelect });

  // Backfill shop identity (name / timezone / currency) once from the Admin
  // API — the greeting uses the shop timezone (spec 13 business rules).
  if (admin && shop && (!shop.name || !shop.timezone || !shop.currency)) {
    try {
      const response = await admin.graphql(SHOP_INFO_QUERY);
      const body = (await response.json()) as {
        data?: { shop?: { name?: string; ianaTimezone?: string; currencyCode?: string } };
      };
      const info = body.data?.shop;
      if (info?.name) {
        shop = await db.shop.update({
          where: { id: shopId },
          data: {
            name: info.name,
            timezone: info.ianaTimezone ?? shop.timezone,
            currency: info.currencyCode ?? shop.currency,
          },
          select: shopSelect,
        });
        // shop-config caches name/timezone/currency for 60s. Without this the
        // backfilled identity is invisible to the widget and to every
        // date-formatting call for up to a minute (QA cache audit).
        invalidateShopConfig(shopId);
      }
    } catch (error) {
      logError("dashboard_shop_info_error", error);
    }
  }

  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [metrics, checklist, ranges, feed, pendingQuestions, atcThisMonth, usage] =
    await Promise.all([
      dashboardMetrics(shopId, range),
      setupChecklist(shopId, shopDomain),
      allowedRanges(shopId),
      liveFeed(shopId),
      db.unresolvedQuestion.count({ where: { shopId, status: "pending" } }),
      db.analyticsEvent.count({
        where: { shopId, type: "added_to_cart", occurredAt: { gte: monthAgo } },
      }),
      currentUsage(shopId),
    ]);

  // Conversation quota for the near-cap banner. In "open" enforcement mode
  // getQuota returns effectively-unlimited, so the banner stays hidden until
  // enforcement flips — exactly the intended behavior.
  const quota = getQuota(shop?.plan ?? "free", "conversations");

  const timezone = shop?.timezone || "UTC";
  return {
    shopDomain: shopDomain,
    shopName: shop?.name || shopDomain.replace(".myshopify.com", ""),
    greeting: greetingFor(timezone),
    aiEnabled: shop?.aiEnabled ?? true,
    range,
    metrics,
    checklist,
    feed,
    pendingQuestions,
    atcThisMonth,
    usage,
    quota: Number.isSafeInteger(quota) && quota < Number.MAX_SAFE_INTEGER ? quota : null,
    // Tier that raises the monthly conversation cap — named in the near-cap
    // banner so "upgrade" points somewhere specific.
    quotaNextPlan: nextPlanNameForQuota(shop?.plan ?? "free", "conversations"),
    // Same treatment as /app/analytics: ranges past the plan's history window
    // are shown DISABLED with the tier that unlocks them, because clampRange
    // narrows them silently and a shorter window looks like a quiet quarter.
    allowedRanges: ranges,
    rangeNextPlan: nextPlanNameForQuota(shop?.plan ?? "free", "analytics_range_days"),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const access = await requireShopAccess(request, { permission: "dashboard" }); // shop row guaranteed by access seam
  const { shopDomain } = access;
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "sync-all") {
    // Same permission as the Training tab's Sync buttons (QA-S2) — the dashboard
    // must not be a side door to work its own page would refuse.
    if (!can(access.role, access.surface, "ai_agent")) {
      return { ok: false, intent, startedAt: null };
    }
    // Everything step 1 counts (spec 13): catalogue + store content. Workers do
    // the rest. startedAt is SERVER time so the "Syncing…" rows compare it with
    // server-written sync timestamps, never with a skewed browser clock.
    const startedAt = new Date().toISOString();
    let queued: boolean[];
    try {
      // Throttled per store + type (QA-U1): a repeat click inside the window
      // queues nothing new, and a queue failure is an error toast, not a 500.
      queued = await Promise.all(
        [JOBS.catalogSync, JOBS.collectionSync, JOBS.discountSync, JOBS.pageSync, JOBS.articleSync].map(
          (job) => enqueueSync(job, shopDomain),
        ),
      );
    } catch (error) {
      logError("dashboard_sync_all_error", error);
      return { ok: false, intent, startedAt: null };
    }
    // Nothing queued ⇒ every sync is already queued from a click moments ago;
    // no startedAt, so the step-1 rows do not wait for a sync that is not new.
    return { ok: true, intent, startedAt: queued.some(Boolean) ? startedAt : null };
  }

  if (intent === "enable-ai") {
    // Same write as the AI Agent page's toggle, behind the same permission.
    if (!can(access.role, access.surface, "ai_agent")) {
      return { ok: false, intent, startedAt: null };
    }
    await db.shop.update({ where: { id: access.shopId }, data: { aiEnabled: true } });
    invalidateShopConfig(access.shopId);
    return { ok: true, intent, startedAt: null };
  }
  return { ok: false, intent, startedAt: null };
};

export default function DashboardPage() {
  const data = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const [, setSearchParams] = useSearchParams();
  const syncFetcher = useFetcher<typeof action>();
  const processedSync = useRef<unknown>(null);

  // Overview "Reload" shows its busy state only for a reload the MERCHANT
  // clicked. It used to read `revalidator.state` directly, which the silent 5s
  // poll below also drives — so the button flickered to "Reloading…" (and went
  // disabled) every few seconds on its own.
  const [manualReload, setManualReload] = useState(false);
  useEffect(() => {
    if (manualReload && revalidator.state === "idle") setManualReload(false);
  }, [manualReload, revalidator.state]);
  const reload = () => {
    setManualReload(true);
    revalidator.revalidate();
  };

  // Live KPI + feed poll (spec 13): every ~5s while the tab is visible.
  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState === "visible" && revalidator.state === "idle") {
        revalidator.revalidate();
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [revalidator]);

  // Server time of the last sync-all queued on this visit — the setup card's
  // training detail shows each source as "Syncing…" until its own sync lands.
  const [syncStartedAt, setSyncStartedAt] = useState<string | null>(null);

  useEffect(() => {
    if (syncFetcher.state !== "idle" || !syncFetcher.data) return;
    if (processedSync.current === syncFetcher.data) return;
    processedSync.current = syncFetcher.data;
    if (syncFetcher.data.ok) {
      if (syncFetcher.data.startedAt) {
        setSyncStartedAt(syncFetcher.data.startedAt);
        shopify.toast.show("Sync started — products, collections, pages, blogs and discounts are updating");
      } else {
        // Throttled (QA-U1): the syncs queued moments ago are still the current ones.
        shopify.toast.show("A sync is already running — it will finish shortly");
      }
      revalidator.revalidate();
    } else {
      shopify.toast.show("Couldn't start the sync", { isError: true });
    }
  }, [syncFetcher.state, syncFetcher.data, shopify, revalidator]);

  const syncing = syncFetcher.state !== "idle";
  const syncAll = () => syncFetcher.submit({ intent: "sync-all" }, { method: "post" });

  // "Turn it on" switches the AI on right here (spec 13 revision).
  const aiFetcher = useFetcher<typeof action>();
  const processedAi = useRef<unknown>(null);
  useEffect(() => {
    if (aiFetcher.state !== "idle" || !aiFetcher.data) return;
    if (processedAi.current === aiFetcher.data) return;
    processedAi.current = aiFetcher.data;
    if (aiFetcher.data.ok) shopify.toast.show("AI assistant turned on");
    else shopify.toast.show("You don't have permission to turn the AI on", { isError: true });
  }, [aiFetcher.state, aiFetcher.data, shopify]);
  const enablingAi = aiFetcher.state !== "idle";

  // Status banner (max one, by priority): AI off → near quota. The old
  // "N setup steps left" banner is gone — the setup card below says the same
  // thing with a percentage.
  const nearQuota = data.quota !== null && data.quota > 0 && data.usage >= data.quota * 0.8;

  const banner =
    !data.aiEnabled && !enablingAi ? (
      <StripBanner
        tone="warning"
        icon="alert-triangle"
        title="Your AI assistant is turned off"
        action={{
          label: "Turn it on",
          onClick: () => aiFetcher.submit({ intent: "enable-ai" }, { method: "post" }),
        }}
      >
        {/* Describes human-support mode as the pipeline runs it (index.server.ts:
            AI off ⇒ the shopper gets the waiting message, the conversation goes to
            the Inbox and the team is notified). The old copy said shoppers could
            only "leave messages", which stopped being true with human mode. */}
        Shoppers get your waiting message and their chats go to the Inbox for your team to
        answer. Turn the AI on to answer questions and recommend products automatically.
      </StripBanner>
    ) : nearQuota ? (
      <StripBanner
        tone="warning"
        icon="chart-line"
        title={`You've used ${data.usage} of ${data.quota} conversations this month`}
        action={{
          label: data.quotaNextPlan ? `Upgrade to ${data.quotaNextPlan}` : "View plans",
          onClick: () => navigate("/app/plan-usage"),
        }}
      >
        When the limit is reached the assistant pauses until the next billing period — upgrade to
        keep it answering.
      </StripBanner>
    ) : null;

  return (
    <s-page heading={APP_NAME}>
      {/* One column (spec 13 revision): hero, banner, overview, setup, live feed. */}
      <s-stack gap="base">
        <DashboardHero
          greeting={data.greeting}
          shopName={data.shopName}
          pendingQuestions={data.pendingQuestions}
          atcThisMonth={data.atcThisMonth}
          aiEnabled={data.aiEnabled || enablingAi}
          onAnswerQuestions={() => navigate("/app/ai-agent/review")}
          onPreviewWidget={() =>
            window.open(`https://${data.shopDomain}`, "_blank", "noopener,noreferrer")
          }
        />

        {banner}

        <DashboardOverview
          metrics={data.metrics}
          range={data.metrics.range}
          allowedRanges={data.allowedRanges}
          rangeNextPlan={data.rangeNextPlan}
          reloading={manualReload}
          onRangeChange={(range) =>
            setSearchParams((params) => {
              params.set("range", range);
              return params;
            })
          }
          onReload={reload}
        />

        <DashboardChecklist
          checklist={data.checklist}
          syncing={syncing}
          syncStartedAt={syncStartedAt}
          onSync={syncAll}
          onNavigate={(href) => navigate(href)}
        />

        <DashboardLiveFeed items={data.feed} onOpen={(id) => navigate(`/app/inbox?c=${id}`)} />
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
