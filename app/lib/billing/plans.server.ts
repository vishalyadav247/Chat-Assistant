// Plan matrix + gating seam (spec 15). ⚠️ ENFORCEMENT MODE = "open" by user
// directive (2026-08-06, PROGRESS.md): the matrix below is PROVISIONAL — all
// features are visible and usable on every plan until the user defines final
// tiers. Every gate point in the app calls requirePlan()/getQuota() anyway, so
// enforcing later is a one-line change: set ENFORCEMENT to "enforced".

export type PlanId = "free" | "basic" | "pro" | "plus";

export type GatedFeature =
  | "remove_branding"
  | "unanswered_analytics"
  | "discount_realtime_sync"
  | "catalog_auto_sync"
  | "premium_campaign_templates"
  | "inbox_cart_view"
  | "auto_detect_language"
  | "exports"
  | "csv_import"
  | "file_upload";

export type QuotaDimension =
  | "conversations"
  | "products_synced"
  | "curated_answers"
  | "manual_qas"
  | "policy_pages"
  | "crawl_pages"
  | "file_uploads";

const ENFORCEMENT: "open" | "enforced" = "open";

export interface PlanDefinition {
  id: PlanId;
  name: string;
  priceMonthly: number;
  priceYearlyPerMonth: number;
  trialDays: number;
  overagePerConversation: number | null; // null = AI stops at cap
  quotas: Record<QuotaDimension, number>;
  features: GatedFeature[];
}

// PROVISIONAL values from the design prototype (plan-usage.html) — dummy until finalized.
export const PLANS: Record<PlanId, PlanDefinition> = {
  free: {
    id: "free",
    name: "Free",
    priceMonthly: 0,
    priceYearlyPerMonth: 0,
    trialDays: 0,
    overagePerConversation: null,
    quotas: {
      conversations: 75,
      products_synced: 200,
      curated_answers: 5,
      manual_qas: 10,
      policy_pages: 5,
      crawl_pages: 1,
      file_uploads: 0,
    },
    features: [],
  },
  basic: {
    id: "basic",
    name: "Basic",
    priceMonthly: 19.99,
    priceYearlyPerMonth: 16.39,
    trialDays: 7,
    overagePerConversation: 0.4,
    quotas: {
      conversations: 200,
      products_synced: 500,
      curated_answers: 20,
      manual_qas: 20,
      policy_pages: 10,
      crawl_pages: 10,
      file_uploads: 0,
    },
    features: ["remove_branding", "unanswered_analytics"],
  },
  pro: {
    id: "pro",
    name: "Pro",
    priceMonthly: 49.99,
    priceYearlyPerMonth: 40.99,
    trialDays: 7,
    overagePerConversation: 0.4,
    quotas: {
      conversations: 500,
      products_synced: 1000,
      curated_answers: 50,
      manual_qas: 20,
      policy_pages: 10,
      crawl_pages: 10,
      file_uploads: 0,
    },
    features: [
      "remove_branding",
      "unanswered_analytics",
      "discount_realtime_sync",
      "catalog_auto_sync",
      "premium_campaign_templates",
      "inbox_cart_view",
    ],
  },
  plus: {
    id: "plus",
    name: "Plus",
    priceMonthly: 99.99,
    priceYearlyPerMonth: 81.99,
    trialDays: 7,
    overagePerConversation: 0.4,
    quotas: {
      conversations: 1000,
      products_synced: 5000,
      curated_answers: 100,
      manual_qas: 50,
      policy_pages: 20,
      crawl_pages: 20,
      file_uploads: 5,
    },
    features: [
      "remove_branding",
      "unanswered_analytics",
      "discount_realtime_sync",
      "catalog_auto_sync",
      "premium_campaign_templates",
      "inbox_cart_view",
      "auto_detect_language",
      "exports",
      "csv_import",
      "file_upload",
    ],
  },
};

const UNLIMITED = Number.MAX_SAFE_INTEGER;

export function planEnforcementMode(): "open" | "enforced" {
  return ENFORCEMENT;
}

/** Feature gate. In "open" mode always passes (logs nothing). */
export function hasFeature(plan: string, feature: GatedFeature): boolean {
  if (ENFORCEMENT === "open") return true;
  const def = PLANS[(plan as PlanId) in PLANS ? (plan as PlanId) : "free"];
  return def.features.includes(feature);
}

/** Throwing gate for actions. In "open" mode never throws. */
export function requirePlan(plan: string, feature: GatedFeature): void {
  if (!hasFeature(plan, feature)) {
    throw new PlanGateError(feature);
  }
}

/** Quota for a dimension. In "open" mode everything is effectively unlimited. */
export function getQuota(plan: string, dimension: QuotaDimension): number {
  if (ENFORCEMENT === "open") return UNLIMITED;
  const def = PLANS[(plan as PlanId) in PLANS ? (plan as PlanId) : "free"];
  return def.quotas[dimension];
}

/** Display quota (for meters) — the real matrix value even in open mode. */
export function displayQuota(plan: string, dimension: QuotaDimension): number {
  const def = PLANS[(plan as PlanId) in PLANS ? (plan as PlanId) : "free"];
  return def.quotas[dimension];
}

export function overageRate(plan: string): number | null {
  const def = PLANS[(plan as PlanId) in PLANS ? (plan as PlanId) : "free"];
  return def.overagePerConversation;
}

export class PlanGateError extends Error {
  feature: GatedFeature;
  constructor(feature: GatedFeature) {
    super(`plan_gate:${feature}`);
    this.feature = feature;
  }
}
