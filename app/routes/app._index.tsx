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
import { enqueue } from "../lib/jobs/queue.server";
import { JOBS } from "../lib/jobs/handlers.server";
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
import { SPACE } from "../components/ui/tokens";
import { currentUsage } from "../lib/billing/usage.server";
import { getQuota } from "../lib/billing/plans.server";
import { requireShopAccess } from "../lib/access.server";
import { routeError } from "../lib/ui/route-error";

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
  const admin = await access.getAdmin();
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
  if (shop && (!shop.name || !shop.timezone || !shop.currency)) {
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
      }
    } catch (error) {
      console.error("dashboard_shop_info_error", error);
    }
  }

  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [metrics, checklist, feed, pendingQuestions, atcThisMonth, usage] = await Promise.all([
    dashboardMetrics(shopId, range),
    setupChecklist(shopId, shopDomain),
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
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shopDomain } = await requireShopAccess(request, { permission: "dashboard" }); // shop row guaranteed by access seam
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "sync-catalog") {
    // Same jobs the install bootstrap enqueues (spec 02) — workers do the rest.
    await enqueue(JOBS.catalogSync, { shopDomain: shopDomain });
    await enqueue(JOBS.collectionSync, { shopDomain: shopDomain });
    return { ok: true, intent };
  }
  return { ok: false, intent };
};

export default function DashboardPage() {
  const data = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const [, setSearchParams] = useSearchParams();
  const syncFetcher = useFetcher<typeof action>();
  const processedSync = useRef<unknown>(null);

  // Live KPI + feed poll (spec 13): every ~5s while the tab is visible.
  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState === "visible" && revalidator.state === "idle") {
        revalidator.revalidate();
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [revalidator]);

  useEffect(() => {
    if (syncFetcher.state !== "idle" || !syncFetcher.data) return;
    if (processedSync.current === syncFetcher.data) return;
    processedSync.current = syncFetcher.data;
    if (syncFetcher.data.ok) {
      shopify.toast.show("Catalog sync started — products and collections are updating");
    } else {
      shopify.toast.show("Couldn't start the sync", { isError: true });
    }
  }, [syncFetcher.state, syncFetcher.data, shopify]);

  const syncing = syncFetcher.state !== "idle";

  // Status banner (max one, by priority): AI off → near quota → setup left.
  const [setupBannerDismissed, setSetupBannerDismissed] = useState(
    () =>
      typeof window !== "undefined" &&
      window.localStorage.getItem("cc-dashboard-setup-banner") === "1",
  );
  const nearQuota = data.quota !== null && data.quota > 0 && data.usage >= data.quota * 0.8;
  const setupLeft = data.checklist.total - data.checklist.completed;

  const banner = !data.aiEnabled ? (
    <StripBanner
      tone="warning"
      icon="alert-triangle"
      title="Your AI assistant is turned off"
      action={{ label: "Turn it on", onClick: () => navigate("/app/ai-agent") }}
    >
      Shoppers can still leave messages, but the assistant isn&apos;t answering questions or
      recommending products. Turn it back on from the AI Agent page.
    </StripBanner>
  ) : nearQuota ? (
    <StripBanner
      tone="warning"
      icon="chart-line"
      title={`You've used ${data.usage} of ${data.quota} conversations this month`}
      action={{ label: "View plans", onClick: () => navigate("/app/plan-usage") }}
    >
      When the limit is reached the assistant pauses until the next billing period — upgrade to
      keep it answering.
    </StripBanner>
  ) : setupLeft > 0 && !setupBannerDismissed ? (
    <StripBanner
      tone="info"
      icon="info"
      title={`${setupLeft} setup step${setupLeft === 1 ? "" : "s"} left to unlock the best results`}
      onDismiss={() => {
        setSetupBannerDismissed(true);
        window.localStorage.setItem("cc-dashboard-setup-banner", "1");
      }}
    >
      Finish the setup checklist below — stores that complete every step see noticeably better
      answer quality and more assisted sales.
    </StripBanner>
  ) : null;

  return (
    <s-page heading="Home" inlineSize="large">
      <s-stack gap="base">
        <DashboardHero
          greeting={data.greeting}
          shopName={data.shopName}
          pendingQuestions={data.pendingQuestions}
          atcThisMonth={data.atcThisMonth}
          aiEnabled={data.aiEnabled}
          syncing={syncing}
          onAnswerQuestions={() => navigate("/app/ai-agent/review")}
          onSyncCatalog={() =>
            syncFetcher.submit({ intent: "sync-catalog" }, { method: "post" })
          }
          onPreviewWidget={() =>
            window.open(`https://${data.shopDomain}`, "_blank", "noopener,noreferrer")
          }
        />

        {banner}

        <DashboardOverview
          metrics={data.metrics}
          range={data.range}
          reloading={revalidator.state !== "idle"}
          onRangeChange={(range) =>
            setSearchParams((params) => {
              params.set("range", range);
              return params;
            })
          }
          onReload={() => revalidator.revalidate()}
        />

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
            gap: SPACE.base,
            alignItems: "start",
          }}
        >
          <DashboardChecklist checklist={data.checklist} onNavigate={(href) => navigate(href)} />
          <DashboardLiveFeed items={data.feed} onOpen={(id) => navigate(`/app/inbox?c=${id}`)} />
        </div>
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
