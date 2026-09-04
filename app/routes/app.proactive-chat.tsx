import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "../lib/ui/surface";
import db from "../db.server";
import {
  displayQuota,
  hasFeature,
  nextPlanNameForQuota,
  requiredPlanName,
} from "../lib/billing/plans.server";
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
import { getShopConfig } from "../lib/config/shop-config.server";
import { getWidgetCssText, getWidgetRendererJs } from "../lib/widget/renderer-assets.server";
import type { BrowseItemMeta } from "../components/BrowseProductsModal";
import { ProactiveCampaignEditor, type CampaignDraft } from "../components/ProactiveCampaignEditor";
import { campaignCtr, ProactiveCampaignTable } from "../components/ProactiveCampaignTable";
import { ProactiveTemplatePicker } from "../components/ProactiveTemplatePicker";
import { SaveBar } from "../components/SaveBar";
import { PlanBanner, PlanMeter } from "../components/ui/PlanGate";
import { StatGrid, StatTile } from "../components/ui/StatTile";
import { requireShopAccess } from "../lib/access.server";
import { routeError } from "../lib/ui/route-error";
import { APP_NAME } from "./app";

// Proactive Chat admin (spec 12): dashboard (overview KPIs + campaign table)
// ⇄ template picker ⇄ campaign editor. KPI counters are all-time in v1 (the
// range chip is static — event-based range aggregation lands with analytics,
// spec 14).

/** Discount codes shown in the editor's Message → Discount picker. */
const DISCOUNT_LIMIT = 200;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shopId } = await requireShopAccess(request, { permission: "proactive" });

  const [shop, campaigns, discounts, config] = await Promise.all([
    db.shop.findUnique({ where: { id: shopId }, select: { plan: true, currency: true } }),
    listCampaigns(shopId),
    db.discount.findMany({
      where: { shopId, status: "active", method: "code" },
      orderBy: { updatedAt: "desc" },
      take: DISCOUNT_LIMIT,
      select: { title: true, summary: true },
    }),
    getShopConfig(shopId),
  ]);

  // Resolve titles/thumbnails for products/collections referenced by campaigns
  // (editor pick lists + preview). Newly browsed items arrive via the modal.
  const productGids = [
    ...new Set(
      campaigns.flatMap((c) => [...c.settings.message.productIds, ...c.settings.trigger.pageProductIds]),
    ),
  ];
  const collectionGids = [
    ...new Set(
      campaigns.flatMap((c) => [
        ...c.settings.message.collectionIds,
        ...c.settings.trigger.pageCollectionIds,
      ]),
    ),
  ];
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
  const starters = config.widget.starters?.enabled
    ? (config.widget.starters.items ?? []).map((item) => ({ label: item.question }))
    : [];

  return {
    campaigns,
    currency: shop?.currency ?? "USD",
    premiumAllowed: hasFeature(plan, "premium_campaign_templates"),
    // Tier name for every premium-template chip/banner in this tree. Read from
    // the live matrix rather than hard-coded, because the operator can move the
    // feature between plans from /admin.
    premiumPlan: hasFeature(plan, "premium_campaign_templates")
      ? null
      : requiredPlanName("premium_campaign_templates"),
    // active_campaigns quota (spec 15). Enforced in saveCampaign when a
    // campaign is saved ACTIVE — the merchant now sees the ceiling coming
    // instead of meeting it as a save error.
    activeQuota: {
      used: campaigns.filter((c) => c.status === "active").length,
      quota: displayQuota(plan, "active_campaigns"),
      nextPlan: nextPlanNameForQuota(plan, "active_campaigns"),
    },
    productMeta,
    collectionMeta,
    starters,
    // Discount.title holds the code for code-method discounts (sync mirror).
    discounts: discounts.map((d) => ({ code: d.title, summary: d.summary })),
    // Storefront assets, so the Message Preview renders through the widget's
    // own builder instead of a lookalike (see ProactiveCampaignPreview).
    rendererJs: getWidgetRendererJs(),
    widgetCss: getWidgetCssText(),
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
    const toggled = await toggleCampaign(shopId, id, active);
    if (typeof toggled === "object") {
      return { intent: "toggle" as const, ok: false as const, error: toggled.error };
    }
    return { intent: "toggle" as const, ok: toggled };
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

  // Save errors belong to the draft that produced them — opening another
  // campaign/template must not inherit the previous one's banner.
  const [saveError, setSaveError] = useState<string | null>(null);

  const startFromTemplate = (tpl: CampaignTemplate) => {
    const { name, ...settings } = tpl.defaults;
    const next: CampaignDraft = { id: null, templateType: tpl.type, name, status: "inactive", settings };
    setSaveError(null);
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
    setSaveError(null);
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
    if (result.intent === "save") {
      setSaveError(result.ok ? null : (result.error ?? "Couldn't save campaign"));
      if (result.ok) {
        shopify.toast.show("Campaign saved");
        setView("dashboard");
      }
    }
    if (result.intent === "duplicate") {
      if (result.ok) shopify.toast.show("Campaign duplicated");
      else shopify.toast.show("Couldn't duplicate campaign", { isError: true });
    }
    if (result.intent === "delete") {
      if (result.ok) shopify.toast.show("Campaign deleted");
      else shopify.toast.show("Couldn't delete campaign", { isError: true });
      setPendingDelete(null);
    }
    // Toggle / reorder used to fail silently — the row just snapped back.
    if (result.intent === "toggle" && !result.ok) {
      shopify.toast.show(
        result.error ?? "Couldn't update the campaign — please try again",
        { isError: true },
      );
    }
    if (result.intent === "reorder" && !result.ok) {
      shopify.toast.show("Couldn't reorder the campaign — please try again", { isError: true });
    }
  }, [fetcher.state, fetcher.data, shopify]);

  return (
    <s-page heading={APP_NAME}>
      <SaveBar dirty={dirty} saving={busy} onSave={save} onDiscard={discard} />
      <s-stack gap="base">
        {view === "dashboard" ? (
          <>
            <s-heading>Proactive Chat</s-heading>
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
              <s-box paddingBlockEnd="base">
                <PlanMeter
                  used={data.activeQuota.used}
                  quota={data.activeQuota.quota}
                  label="campaigns active"
                  nextPlan={data.activeQuota.nextPlan}
                />
              </s-box>
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
            premiumPlan={data.premiumPlan}
            onBack={() => setView("dashboard")}
            onCreate={startFromTemplate}
          />
        ) : draft ? (
          <>
            {campaignTemplate(draft.templateType)?.premium && !data.premiumAllowed ? (
              <PlanBanner plan={data.premiumPlan} heading="Premium template" tone="warning">
                This template is available on the {data.premiumPlan} plan and above.
              </PlanBanner>
            ) : null}
            <ProactiveCampaignEditor
              draft={draft}
              setDraft={(updater) => setDraft((d) => (d ? updater(d) : d))}
              error={saveError}
              productMeta={data.productMeta}
              collectionMeta={data.collectionMeta}
              discounts={data.discounts}
              currency={data.currency}
              starters={data.starters}
              premiumAllowed={data.premiumAllowed}
              premiumPlan={data.premiumPlan}
              rendererJs={data.rendererJs}
              widgetCss={data.widgetCss}
              onCancel={() => {
                setSaveError(null);
                setView(draft.id ? "dashboard" : "picker");
              }}
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
