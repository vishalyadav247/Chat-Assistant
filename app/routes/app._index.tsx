import { useEffect, useRef } from "react";
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
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { resolveShopId } from "../lib/tenancy.server";
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
  const { session, admin } = await authenticate.admin(request);
  const shopId = await resolveShopId(session.shop);
  const url = new URL(request.url);
  const rangeParam = url.searchParams.get("range");
  const range: DashboardRange = isRange(rangeParam) ? rangeParam : "7d";

  const shopSelect = {
    name: true,
    timezone: true,
    currency: true,
    aiEnabled: true,
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
  const [metrics, checklist, feed, pendingQuestions, atcThisMonth] = await Promise.all([
    dashboardMetrics(shopId, range),
    setupChecklist(shopId, session.shop),
    liveFeed(shopId),
    db.unresolvedQuestion.count({ where: { shopId, status: "pending" } }),
    db.analyticsEvent.count({
      where: { shopId, type: "added_to_cart", occurredAt: { gte: monthAgo } },
    }),
  ]);

  const timezone = shop?.timezone || "UTC";
  return {
    shopDomain: session.shop,
    shopName: shop?.name || session.shop.replace(".myshopify.com", ""),
    greeting: greetingFor(timezone),
    aiEnabled: shop?.aiEnabled ?? true,
    range,
    metrics,
    checklist,
    feed,
    pendingQuestions,
    atcThisMonth,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  await resolveShopId(session.shop); // shop row must exist before jobs run
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "sync-catalog") {
    // Same jobs the install bootstrap enqueues (spec 02) — workers do the rest.
    await enqueue(JOBS.catalogSync, { shopDomain: session.shop });
    await enqueue(JOBS.collectionSync, { shopDomain: session.shop });
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

  return (
    <s-page heading={`${data.greeting}, ${data.shopName} 👋`} inlineSize="large">
      <s-stack gap="base">
        <DashboardHero
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
            gap: 16,
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
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
