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
import { useAppBridge } from "../lib/ui/surface";
import db from "../db.server";
import { hasFeature, PlanGateError } from "../lib/billing/plans.server";
import {
  DASHBOARD_RANGES,
  dashboardMetrics,
  type DashboardRange,
} from "../lib/dashboard/dashboard.server";
import {
  ANALYTICS_RANGES,
  conversationSeries,
  csatSummary,
  exportAnalyticsCsv,
  exportConversationsCsv,
  recommendationFunnel,
  resolutionBreakdown,
  responsePerformance,
  topQuestions,
  type AnalyticsRange,
} from "../lib/analytics/reports.server";
import { DashboardOverview } from "../components/DashboardOverview";
import { AnalyticsLineChart } from "../components/AnalyticsLineChart";
import { AnalyticsCsat, AnalyticsResolutionDonut } from "../components/AnalyticsBreakdown";
import { requireShopAccess } from "../lib/access.server";
import { routeError } from "../lib/ui/route-error";
import {
  AnalyticsFunnel,
  AnalyticsResponsePerformance,
} from "../components/AnalyticsFunnelPerf";
import {
  AnalyticsTopQuestions,
  AnalyticsUnansweredCard,
} from "../components/AnalyticsTopQuestions";

// Analytics page (spec 14, design analytics.html): reused dashboard Overview
// KPI card (spec 13 shared component), conversations-over-time line chart
// (Human vs AI, own range), resolution donut, CSAT, recommendation funnel,
// response performance, top questions, unanswered mini-card, CSV exports
// (Plus gate "exports"; design gap — the export button lives in the header).
// All aggregates read shop-scoped MetricsDaily rollups; isTest excluded.

function isDashboardRange(value: string | null): value is DashboardRange {
  return value !== null && (DASHBOARD_RANGES as string[]).includes(value);
}

function isAnalyticsRange(value: string | null): value is AnalyticsRange {
  return value !== null && (ANALYTICS_RANGES as string[]).includes(value);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shopId } = await requireShopAccess(request, { permission: "analytics" });
  const url = new URL(request.url);
  const range: DashboardRange = isDashboardRange(url.searchParams.get("range"))
    ? (url.searchParams.get("range") as DashboardRange)
    : "7d";
  const chartRange: AnalyticsRange = isAnalyticsRange(url.searchParams.get("crange"))
    ? (url.searchParams.get("crange") as AnalyticsRange)
    : "7d";

  const shop = await db.shop.findUnique({ where: { id: shopId }, select: { plan: true } });
  const plan = shop?.plan ?? "free";

  const [metrics, series, breakdown, csat, funnel, perf, questions, pendingQuestions] =
    await Promise.all([
      dashboardMetrics(shopId, range),
      conversationSeries(shopId, chartRange),
      resolutionBreakdown(shopId, chartRange),
      csatSummary(shopId),
      recommendationFunnel(shopId, chartRange),
      responsePerformance(shopId, chartRange),
      topQuestions(shopId),
      db.unresolvedQuestion.count({ where: { shopId, status: "pending" } }),
    ]);

  return {
    range,
    chartRange,
    metrics,
    series,
    breakdown,
    csat,
    funnel,
    perf,
    questions,
    pendingQuestions,
    exportsAllowed: hasFeature(plan, "exports"),
    unansweredAllowed: hasFeature(plan, "unanswered_analytics"),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shopId } = await requireShopAccess(request, { permission: "analytics" });
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const stamp = new Date().toISOString().slice(0, 10);

  try {
    if (intent === "export-analytics") {
      const range = isAnalyticsRange(formData.get("range") as string | null)
        ? (formData.get("range") as AnalyticsRange)
        : "30d";
      const csv = await exportAnalyticsCsv(shopId, range);
      return { intent, filename: `analytics-${range}-${stamp}.csv`, csv, locked: false };
    }
    if (intent === "export-conversations") {
      const csv = await exportConversationsCsv(shopId);
      return { intent, filename: `conversations-${stamp}.csv`, csv, locked: false };
    }
  } catch (error) {
    // Server-side plan gate (spec 15): exports are Plus-only when enforced.
    if (error instanceof PlanGateError) {
      return { intent, filename: "", csv: "", locked: true };
    }
    throw error;
  }
  return { intent: "unknown", filename: "", csv: "", locked: false };
};

export default function AnalyticsPage() {
  const data = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const [, setSearchParams] = useSearchParams();
  const exportFetcher = useFetcher<typeof action>();

  // CSV round-trip → client-side Blob download (same pattern as app.contacts.tsx:
  // in the embedded iframe only App-Bridge-authenticated fetches carry the
  // session token, so the CSV rides back in the action payload).
  const processedExport = useRef<unknown>(null);
  useEffect(() => {
    const result = exportFetcher.data;
    if (exportFetcher.state !== "idle" || !result || processedExport.current === result) return;
    processedExport.current = result;
    if (!result.intent.startsWith("export-")) return;
    if (result.locked) {
      shopify.toast.show("CSV exports are available on the Plus plan", { isError: true });
      return;
    }
    const blob = new Blob([String.fromCharCode(0xfeff) + result.csv], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = result.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    shopify.toast.show("Export downloaded");
  }, [exportFetcher.state, exportFetcher.data, shopify]);

  const exporting = exportFetcher.state !== "idle";
  const runExport = (intent: "export-analytics" | "export-conversations") => {
    if (!data.exportsAllowed) {
      // Gated visual (Plus): the server enforces too — this just short-circuits.
      shopify.toast.show("CSV exports are available on the Plus plan", { isError: true });
      return;
    }
    exportFetcher.submit({ intent, range: data.chartRange }, { method: "post" });
  };

  return (
    <s-page heading="Analytics">
      <s-button
        slot="primary-action"
        variant="primary"
        disabled={exporting}
        onClick={() => runExport("export-analytics")}
      >
        {data.exportsAllowed ? "Export CSV" : "Export CSV (Plus)"}
      </s-button>
      <s-button
        slot="secondary-actions"
        disabled={exporting}
        onClick={() => runExport("export-conversations")}
      >
        {data.exportsAllowed ? "Export conversations" : "Export conversations (Plus)"}
      </s-button>

      <s-stack gap="base">
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

        <AnalyticsLineChart
          series={data.series}
          range={data.chartRange}
          onRangeChange={(range) =>
            setSearchParams((params) => {
              params.set("crange", range);
              return params;
            })
          }
        />

        {/* Paired cards stretch to the row height so side-by-side cards always
            share the same card-background extent (no ragged bottoms). */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
            gap: 16,
          }}
        >
          <AnalyticsResolutionDonut breakdown={data.breakdown} />
          <AnalyticsCsat csat={data.csat} />
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
            gap: 16,
          }}
        >
          <AnalyticsFunnel funnel={data.funnel} />
          <AnalyticsResponsePerformance perf={data.perf} />
        </div>

        <AnalyticsTopQuestions questions={data.questions} />

        <AnalyticsUnansweredCard
          pendingQuestions={data.pendingQuestions}
          allowed={data.unansweredAllowed}
          onReview={() => navigate("/app/ai-agent/review")}
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
