import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate, useRouteError, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";
import db from "../db.server";
import { getQuota, nextPlanNameForQuota } from "../lib/billing/plans.server";
import {
  handoverConfigSchema,
  shopSettingsSchema,
  type HandoverConfigData,
} from "../lib/settings/schemas";
import {
  deleteCrossSellPair,
  deleteRecommendation,
  saveCrossSellPair,
  saveGeneralInstructions,
  saveHandoverConfig,
  saveRecommendation,
  saveRecommendationRules,
  setRecommendationStatus,
} from "../lib/instructions/save.server";
import { InstructionsGeneralTab } from "../components/InstructionsGeneralTab";
import { InstructionsRecommendationsTab } from "../components/InstructionsRecommendationsTab";
import { InstructionsHandoverTab } from "../components/InstructionsHandoverTab";
import { RecommendationDetail } from "../components/RecommendationDetail";
import { PageHeader } from "../components/ui/PageHeader";
import { requireShopAccess } from "../lib/access.server";
import { routeError } from "../lib/ui/route-error";
import { APP_NAME } from "./app";

// Instructions (spec 08, design ai-agent.html #viewInstructions): three tabs
// via ?tab= — General Instructions / Product recommendations / Human handover.
// One merged "App recommendations" section: the
// former Custom recommendations section folded in — a rule holds products AND
// collections, and its trigger phrases fire semantically (instant answer) or
// as contained keywords (buy-lane pool). Detail view (#viewRec) renders
// in-route via the ?rec= search param. All reads/writes shop-scoped.

export type InstructionsTab = "general" | "recommendations" | "handover";

export interface GeneralData {
  role: string;
  communicationStyle: string;
  brandVoice: string;
  behaviours: string;
  defaultLanguage: string;
  autoDetectLanguage: boolean;
  bannedTopics: string[];
  fallbackMessage: string;
  /** Store info text (ShopSettings.storeInfo.about) — the store_info knowledge bridge. */
  storeInfoAbout: string;
  /** Store scope + off-topic message (persona columns; QA-A3). */
  scope: string;
  offTopicMessage: string;
}

export interface RecommendationRowData {
  id: string;
  title: string;
  triggerQuestions: string[];
  productIds: string[];
  collectionIds: string[];
  status: string;
  updatedAt: string;
}

export interface CrossSellPairRowData {
  id: string;
  productId: string;
  companionIds: string[];
  updatedAt: string;
}

export interface ProductMeta {
  title: string;
  imageUrl: string | null;
}

export interface CollectionMeta {
  title: string;
  productCount: number;
}

export interface InstructionsActionResult {
  ok: boolean;
  intent: string;
  id?: string;
  error?: string;
  /** store-info-prefill: the draft built from Shopify, for the merchant to review. */
  draft?: string;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shopId } = await requireShopAccess(request, { permission: "ai_agent" });

  const [shop, persona, guardrails, handoverRow, settingsRow, recommendations, pairs] =
    await Promise.all([
      db.shop.findUnique({ where: { id: shopId }, select: { plan: true } }),
      db.persona.findUnique({ where: { shopId } }),
      db.guardrails.findUnique({ where: { shopId } }),
      db.handoverConfig.findUnique({ where: { shopId }, select: { config: true } }),
      db.shopSettings.findUnique({ where: { shopId }, select: { settings: true } }),
      db.recommendation.findMany({
        where: { shopId },
        orderBy: { updatedAt: "desc" },
        select: {
          id: true, title: true, triggerQuestions: true, productIds: true, collectionIds: true,
          status: true, updatedAt: true,
        },
      }),
      db.crossSellPair.findMany({
        where: { shopId },
        orderBy: { updatedAt: "desc" },
        select: { id: true, productId: true, companionIds: true, updatedAt: true },
      }),
    ]);

  const plan = shop?.plan ?? "free";

  // Meta for every referenced product/collection so tables and detail views
  // can render titles/thumbnails without refetching.
  const productGids = new Set<string>();
  for (const rec of recommendations) rec.productIds.forEach((id) => productGids.add(id));
  for (const pair of pairs) {
    productGids.add(pair.productId);
    pair.companionIds.forEach((id) => productGids.add(id));
  }
  const collectionGids = new Set<string>();
  for (const rec of recommendations) rec.collectionIds.forEach((id) => collectionGids.add(id));

  const [productRows, collectionRows] = await Promise.all([
    productGids.size
      ? db.product.findMany({
          where: { shopId, shopifyProductId: { in: [...productGids] } },
          select: { shopifyProductId: true, title: true, imageUrl: true },
        })
      : Promise.resolve([]),
    collectionGids.size
      ? db.collection.findMany({
          where: { shopId, shopifyCollectionId: { in: [...collectionGids] } },
          select: { shopifyCollectionId: true, title: true, productCount: true },
        })
      : Promise.resolve([]),
  ]);
  const productMeta: Record<string, ProductMeta> = {};
  for (const p of productRows) productMeta[p.shopifyProductId] = { title: p.title, imageUrl: p.imageUrl };
  const collectionMeta: Record<string, CollectionMeta> = {};
  for (const c of collectionRows) {
    collectionMeta[c.shopifyCollectionId] = { title: c.title, productCount: c.productCount };
  }

  const general: GeneralData = {
    role: persona?.role ?? "",
    communicationStyle: persona?.communicationStyle ?? "friendly",
    brandVoice: persona?.brandVoice ?? "",
    behaviours: persona?.behaviours ?? "",
    defaultLanguage: persona?.defaultLanguage ?? "en",
    autoDetectLanguage: persona?.autoDetectLanguage ?? false,
    bannedTopics: guardrails?.bannedTopics ?? [],
    fallbackMessage: guardrails?.fallbackMessage ?? "",
    storeInfoAbout: shopSettingsSchema.parse(settingsRow?.settings ?? {}).storeInfo.about,
    scope: persona?.scope ?? "",
    offTopicMessage: persona?.offTopicMessage ?? "",
  };

  return {
    general,
    recommendations: recommendations.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() })),
    pairs: pairs.map((p) => ({ ...p, updatedAt: p.updatedAt.toISOString() })),
    productMeta,
    collectionMeta,
    handover: handoverConfigSchema.parse(handoverRow?.config ?? {}) as HandoverConfigData,
    rules: shopSettingsSchema.parse(settingsRow?.settings ?? {}).recommendationRules,
    // Both features are on every plan. Recommendation rules are still counted
    // per tier (recommendation_rules); cross-sell pairs have no limit since
    // 2026-09-11.
    recommendationQuota: getQuota(plan, "recommendation_rules"),
    // Upgrade hints for the PlanMeter rows (same pattern as the FAQ tab).
    recommendationNextPlan: nextPlanNameForQuota(plan, "recommendation_rules"),
  };
};

export const action = async ({ request }: ActionFunctionArgs): Promise<InstructionsActionResult> => {
  const { shopId, shopDomain } = await requireShopAccess(request, { permission: "ai_agent" });
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  let payload: unknown = null;
  try {
    payload = JSON.parse(String(formData.get("payload") ?? "null"));
  } catch {
    return { ok: false, intent, error: "Invalid payload" };
  }

  try {
    switch (intent) {
      case "store-info-prefill": {
        const { buildStoreInfoDraft } = await import("../lib/instructions/store-info.server");
        return { ok: true, intent, draft: await buildStoreInfoDraft(shopDomain) };
      }
      case "save-general": {
        await saveGeneralInstructions(shopId, payload);
        return { ok: true, intent };
      }
      case "save-handover": {
        await saveHandoverConfig(shopId, payload);
        return { ok: true, intent };
      }
      case "save-rules": {
        await saveRecommendationRules(shopId, payload);
        return { ok: true, intent };
      }
      case "save-recommendation": {
        const id = await saveRecommendation(shopId, payload);
        return { ok: true, intent, id };
      }
      case "toggle-recommendation": {
        const p = payload as { id?: string; status?: string };
        await setRecommendationStatus(
          shopId,
          String(p?.id ?? ""),
          p?.status === "active" ? "active" : "inactive",
        );
        return { ok: true, intent };
      }
      case "delete-recommendation": {
        await deleteRecommendation(shopId, String((payload as { id?: string })?.id ?? ""));
        return { ok: true, intent };
      }
      case "save-pair": {
        await saveCrossSellPair(shopId, payload);
        return { ok: true, intent };
      }
      case "delete-pair": {
        await deleteCrossSellPair(shopId, String((payload as { id?: string })?.id ?? ""));
        return { ok: true, intent };
      }
      default:
        return { ok: false, intent, error: `Unknown intent: ${intent || "(none)"}` };
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      // Friendly "field: message" instead of the raw issues JSON (QA D5) —
      // same mapping as training.tsx's friendlyError.
      const issue = error.issues[0];
      return {
        ok: false,
        intent,
        error: issue ? `${issue.path.join(".") || "input"}: ${issue.message}` : "Invalid input",
      };
    }
    return {
      ok: false,
      intent,
      error: error instanceof Error ? error.message : "Could not save — try again.",
    };
  }
};

const TABS: { id: InstructionsTab; label: string }[] = [
  { id: "general", label: "General Instructions" },
  { id: "recommendations", label: "Product recommendations" },
  { id: "handover", label: "Human handover" },
];

export default function InstructionsPage() {
  const data = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get("tab");
  const tab: InstructionsTab = TABS.some((t) => t.id === rawTab)
    ? (rawTab as InstructionsTab)
    : "general";
  const recParam = searchParams.get("rec");

  const setTab = (next: InstructionsTab) => {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        params.set("tab", next);
        params.delete("rec");
        return params;
      },
      { preventScrollReset: true },
    );
  };

  const closeDetail = () => {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      params.set("tab", "recommendations");
      params.delete("rec");
      return params;
    });
  };

  // Detail view replaces the tabbed page (design #viewRec).
  if (recParam) {
    const existing = data.recommendations.find((r) => r.id === recParam) ?? null;
    return (
      <RecommendationDetail
        key={recParam}
        recommendation={existing}
        productMeta={data.productMeta}
        collectionMeta={data.collectionMeta}
        onClose={closeDetail}
      />
    );
  }

  return (
    <s-page heading={APP_NAME}>
      <s-stack gap="base">
        <PageHeader
          title="Instructions"
          backTo="/app/ai-agent"
          backLabel="AI Agent"
          tabs={TABS}
          activeTab={tab}
          onTabChange={setTab}
          toolbar={<s-button onClick={() => navigate("/app/ai-agent/test")}>Test AI</s-button>}
        />

        {tab === "general" ? (
          <InstructionsGeneralTab
            initial={data.general}
          />
        ) : null}
        {tab === "recommendations" ? (
          <InstructionsRecommendationsTab
            recommendations={data.recommendations}
            pairs={data.pairs}
            productMeta={data.productMeta}
            rules={data.rules}
            recommendationQuota={data.recommendationQuota}
            recommendationNextPlan={data.recommendationNextPlan}
            onOpenRec={(id) =>
              setSearchParams((prev) => {
                const params = new URLSearchParams(prev);
                params.set("tab", "recommendations");
                params.set("rec", id);
                return params;
              })
            }
          />
        ) : null}
        {tab === "handover" ? <InstructionsHandoverTab initial={data.handover} /> : null}
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
