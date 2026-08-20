import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "../lib/ui/surface";
import db from "../db.server";
import { hasFeature } from "../lib/billing/plans.server";
import {
  deleteCampaign,
  duplicateCampaign,
  listCampaigns,
  reorderCampaign,
  saveCampaign,
  toggleCampaign,
  type CampaignRow,
} from "../lib/campaigns/campaigns.server";
import { campaignTemplate, type CampaignTemplate } from "../lib/campaigns/templates";
import type { BrowseItemMeta } from "../components/BrowseProductsModal";
import { ProactiveCampaignEditor, type CampaignDraft } from "../components/ProactiveCampaignEditor";
import { campaignCtr, ProactiveCampaignTable } from "../components/ProactiveCampaignTable";
import { ProactiveTemplatePicker } from "../components/ProactiveTemplatePicker";
import { SaveBar } from "../components/SaveBar";
import { StatGrid, StatTile } from "../components/ui/StatTile";
import { requireShopAccess } from "../lib/access.server";
import { routeError } from "../lib/ui/route-error";

// Proactive Chat admin (spec 12, design proactive-chat.html): dashboard
// (overview KPIs + campaign table) ⇄ template picker ⇄ minimal editor.
// KPI counters are all-time in v1 (range chip is static "Last 7 days" —
// event-based range aggregation lands with analytics, spec 14).

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shopId } = await requireShopAccess(request, { permission: "proactive" });

  const [shop, campaigns] = await Promise.all([
    db.shop.findUnique({ where: { id: shopId }, select: { plan: true, currency: true } }),
    listCampaigns(shopId),
  ]);

  // Resolve titles/thumbnails for products/collections referenced by campaigns
  // (editor pick lists). Newly browsed items arrive via the modal's meta.
  const productGids = [...new Set(campaigns.flatMap((c) => c.settings.productIds))];
  const collectionGids = [...new Set(campaigns.flatMap((c) => c.settings.collectionIds))];
  const [products, collections] = await Promise.all([
    productGids.length
      ? db.product.findMany({
          where: { shopId, shopifyProductId: { in: productGids } },
          select: { shopifyProductId: true, title: true, imageUrl: true },
        })
      : Promise.resolve([]),
    collectionGids.length
      ? db.collection.findMany({
          where: { shopId, shopifyCollectionId: { in: collectionGids } },
          select: { shopifyCollectionId: true, title: true },
        })
      : Promise.resolve([]),
  ]);

  const productMeta: Record<string, BrowseItemMeta> = {};
  for (const p of products) productMeta[p.shopifyProductId] = { title: p.title, imageUrl: p.imageUrl };
  const collectionMeta: Record<string, BrowseItemMeta> = {};
  for (const c of collections) collectionMeta[c.shopifyCollectionId] = { title: c.title, imageUrl: null };

  const plan = shop?.plan ?? "free";
  return {
    campaigns,
    currency: shop?.currency ?? "USD",
    premiumAllowed: hasFeature(plan, "premium_campaign_templates"),
    productMeta,
    collectionMeta,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shopId } = await requireShopAccess(request, { permission: "proactive" });
  const shop = await db.shop.findUnique({ where: { id: shopId }, select: { plan: true } });
  const plan = shop?.plan ?? "free";
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const id = String(formData.get("id") ?? "");

  if (intent === "save") {
    let payload: unknown;
    try {
      payload = JSON.parse(String(formData.get("payload") ?? "{}"));
    } catch {
      return { intent: "save" as const, ok: false as const, error: "Invalid payload" };
    }
    const result = await saveCampaign(shopId, plan, payload);
    if (!result.ok) return { intent: "save" as const, ok: false as const, error: result.error };
    return { intent: "save" as const, ok: true as const, id: result.id };
  }
  if (intent === "duplicate") {
    const copyId = await duplicateCampaign(shopId, id);
    return { intent: "duplicate" as const, ok: copyId !== null };
  }
  if (intent === "delete") {
    return { intent: "delete" as const, ok: await deleteCampaign(shopId, id) };
  }
  if (intent === "toggle") {
    const active = String(formData.get("active")) === "true";
    return { intent: "toggle" as const, ok: await toggleCampaign(shopId, id, active) };
  }
  if (intent === "reorder") {
    const direction = String(formData.get("direction")) === "up" ? ("up" as const) : ("down" as const);
    return { intent: "reorder" as const, ok: await reorderCampaign(shopId, id, direction) };
  }
  return { intent: "unknown" as const, ok: false as const, error: "Unknown intent" };
};

export default function ProactiveChatPage() {
  const data = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const fetcher = useFetcher<typeof action>();

  const [view, setView] = useState<"dashboard" | "picker" | "editor">("dashboard");
  const [draft, setDraft] = useState<CampaignDraft | null>(null);
  // Snapshot of the draft as it was opened — drives the contextual save bar.
  const [baseline, setBaseline] = useState<string>("");
  const [pendingDelete, setPendingDelete] = useState<CampaignRow | null>(null);

  const busy = fetcher.state !== "idle";

  const totals = data.campaigns.reduce(
    (acc, c) => ({
      views: acc.views + c.views,
      clicks: acc.clicks + c.clicks,
      revenue: acc.revenue + c.revenue,
      orders: acc.orders + c.orders,
    }),
    { views: 0, clicks: 0, revenue: 0, orders: 0 },
  );
  const ctr = campaignCtr(totals.views, totals.clicks);
  const money = new Intl.NumberFormat(undefined, { style: "currency", currency: data.currency });

  const startFromTemplate = (tpl: CampaignTemplate) => {
    const { name, ...settings } = tpl.defaults;
    const next: CampaignDraft = { id: null, templateType: tpl.type, name, status: "active", settings };
    setDraft(next);
    setBaseline(JSON.stringify(next));
    setView("editor");
  };

  const openEdit = (row: CampaignRow) => {
    const next: CampaignDraft = {
      id: row.id,
      templateType: row.templateType,
      name: row.name,
      status: row.status === "active" ? "active" : "inactive",
      settings: row.settings,
    };
    setDraft(next);
    setBaseline(JSON.stringify(next));
    setView("editor");
  };

  const dirty = view === "editor" && draft !== null && JSON.stringify(draft) !== baseline;
  const discard = () => setDraft(baseline ? (JSON.parse(baseline) as CampaignDraft) : null);

  const save = () => {
    if (!draft) return;
    if (!draft.name.trim()) {
      shopify.toast.show("Give the campaign a name before saving", { isError: true });
      return;
    }
    fetcher.submit(
      {
        intent: "save",
        payload: JSON.stringify({
          id: draft.id ?? undefined,
          name: draft.name,
          templateType: draft.templateType,
          status: draft.status,
          settings: draft.settings,
        }),
      },
      { method: "post" },
    );
  };

  // Toasts + view transitions after actions round-trip.
  const processed = useRef<unknown>(null);
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data || processed.current === fetcher.data) return;
    processed.current = fetcher.data;
    const result = fetcher.data;
    if (result.intent === "save" && result.ok) {
      shopify.toast.show("Campaign saved");
      setView("dashboard");
    }
    if (result.intent === "duplicate") {
      shopify.toast.show(result.ok ? "Campaign duplicated" : "Couldn't duplicate campaign");
    }
    if (result.intent === "delete") {
      shopify.toast.show(result.ok ? "Campaign deleted" : "Couldn't delete campaign");
      setPendingDelete(null);
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const saveError =
    fetcher.state === "idle" && fetcher.data?.intent === "save" && !fetcher.data.ok
      ? (fetcher.data.error ?? "Couldn't save campaign")
      : null;

  return (
    <s-page heading="Proactive Chat">
      <SaveBar dirty={dirty} saving={busy} onSave={save} onDiscard={discard} />
      <s-stack gap="base">
        {view === "dashboard" ? (
          <>
            <s-section>
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  justifyContent: "space-between",
                  gap: 16,
                  flexWrap: "wrap",
                }}
              >
                <s-paragraph>
                  Create proactive chat to engage with shoppers who visit your online store in real
                  time.
                </s-paragraph>
                <s-button variant="primary" onClick={() => setView("picker")}>
                  Create proactive chat
                </s-button>
              </div>
            </s-section>

            <s-section heading="Overview">
              <s-stack gap="base">
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <s-badge>All time</s-badge>
                  <s-text tone="neutral">Per-range breakdowns arrive with analytics events.</s-text>
                </div>
                <StatGrid>
                  <StatTile
                    label="Views"
                    value={String(totals.views)}
                    icon="view"
                    tone="accent"
                    sub="campaign impressions"
                  />
                  <StatTile
                    label="CTR"
                    value={`${ctr.toFixed(2)}%`}
                    icon="target"
                    tone="info"
                    sub="clicks ÷ views"
                  />
                  <StatTile
                    label="Revenue"
                    value={totals.orders > 0 || totals.revenue > 0 ? money.format(totals.revenue) : money.format(0)}
                    icon="money"
                    tone="success"
                    sub={totals.orders > 0 || totals.revenue > 0 ? "attributed to campaigns" : "no orders yet"}
                  />
                  <StatTile
                    label="Orders"
                    value={String(totals.orders)}
                    icon="order"
                    tone="warning"
                    sub="attributed orders"
                  />
                </StatGrid>
              </s-stack>
            </s-section>

            <s-section heading="Campaigns">
              {pendingDelete ? (
                <s-banner tone="critical" heading={`Delete “${pendingDelete.name}”?`}>
                  <s-paragraph>This can&apos;t be undone.</s-paragraph>
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <s-button
                      variant="primary"
                      tone="critical"
                      disabled={busy}
                      loading={busy}
                      onClick={() =>
                        fetcher.submit({ intent: "delete", id: pendingDelete.id }, { method: "post" })
                      }
                    >
                      Delete
                    </s-button>
                    <s-button onClick={() => setPendingDelete(null)}>Keep it</s-button>
                  </div>
                </s-banner>
              ) : null}
              <ProactiveCampaignTable
                rows={data.campaigns}
                currency={data.currency}
                busy={busy}
                onEdit={openEdit}
                onDuplicate={(id) => fetcher.submit({ intent: "duplicate", id }, { method: "post" })}
                onDelete={(id) => {
                  const row = data.campaigns.find((c) => c.id === id);
                  if (row) setPendingDelete(row);
                }}
                onToggle={(id, active) =>
                  fetcher.submit({ intent: "toggle", id, active: String(active) }, { method: "post" })
                }
                onReorder={(id, direction) =>
                  fetcher.submit({ intent: "reorder", id, direction }, { method: "post" })
                }
              />
            </s-section>
          </>
        ) : view === "picker" ? (
          <ProactiveTemplatePicker
            premiumAllowed={data.premiumAllowed}
            onBack={() => setView("dashboard")}
            onCreate={startFromTemplate}
          />
        ) : draft ? (
          <>
            {campaignTemplate(draft.templateType)?.premium && !data.premiumAllowed ? (
              <s-banner tone="warning" heading="Premium template">
                <s-paragraph>
                  This template requires a Pro or Plus plan.{" "}
                  <s-link href="/app/plan-usage">View plans</s-link>
                </s-paragraph>
              </s-banner>
            ) : null}
            <ProactiveCampaignEditor
              draft={draft}
              setDraft={(updater) => setDraft((d) => (d ? updater(d) : d))}
              error={saveError}
              productMeta={data.productMeta}
              collectionMeta={data.collectionMeta}
              onCancel={() => setView(draft.id ? "dashboard" : "picker")}
            />
          </>
        ) : null}
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
