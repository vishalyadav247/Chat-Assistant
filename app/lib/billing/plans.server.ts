// Plan matrix + gating seam (spec 15) + platform overrides (spec 19).
// The code matrix below is the DEFAULT; the operator can edit every value from
// the /platform dashboard. Overrides live in app_secrets["platform:plans"] and
// are merged into the exported PLANS object IN PLACE, so the 20+ sync consumers
// (incl. direct PLANS[...] reads) pick them up with zero signature changes.
// ENFORCEMENT default = "enforced" (2026-08-21): the final tiers below match
// .claude/imp-details/plan-allocation.xlsx, so every quota and feature gate is
// live. The operator can still flip back to "open" from /platform/plans
// (spec 19) — no code edit — which makes every gate pass and every quota
// unlimited without touching the displayed matrix.

import { z } from "zod";
import db from "../../db.server";
import {
  GATED_FEATURES,
  PLAN_IDS,
  QUOTA_DIMENSIONS,
  UNLIMITED_QUOTA,
  isUnlimitedQuota,
  type GatedFeature,
  type PlanDefinition,
  type PlanId,
  type QuotaDimension,
} from "./plan-shared";
import { logError } from "../log.server";

// Types + pure constants live in plan-shared.ts (client-safe); re-export so
// the 20+ existing server consumers keep importing from this module.
export {
  GATED_FEATURES,
  PLAN_IDS,
  QUOTA_DIMENSIONS,
  UNLIMITED_QUOTA,
  isUnlimitedQuota,
  type GatedFeature,
  type PlanDefinition,
  type PlanId,
  type QuotaDimension,
};

/** Compiled-in default. The operator can override it from /platform/plans. */
export const DEFAULT_ENFORCEMENT: "open" | "enforced" = "enforced";

// FINAL tiers — reconciled 2026-08-21 against .claude/imp-details/plan-allocation.xlsx.
// Any change here must be mirrored in that sheet and in the App Store listing pricing.
export const DEFAULT_PLANS: Record<PlanId, PlanDefinition> = {
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
      metafields_enabled: 3,
      team_seats: 1,
      active_campaigns: 0,
      analytics_range_days: 7,
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
      manual_qas: 25,
      policy_pages: 10,
      crawl_pages: 10,
      file_uploads: 0,
      metafields_enabled: 10,
      team_seats: 2,
      active_campaigns: 2,
      analytics_range_days: 30,
    },
    features: ["remove_branding", "unanswered_analytics", "survey", "push_notifications"],
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
      manual_qas: 50,
      policy_pages: 15,
      crawl_pages: 15,
      file_uploads: 0,
      metafields_enabled: 25,
      team_seats: 5,
      active_campaigns: 10,
      analytics_range_days: 90,
    },
    features: [
      "remove_branding",
      "unanswered_analytics",
      "survey",
      "push_notifications",
      "discount_realtime_sync",
      "catalog_auto_sync",
      "premium_campaign_templates",
      "inbox_cart_view",
      "custom_recommendations",
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
      manual_qas: 100,
      policy_pages: 20,
      crawl_pages: 20,
      file_uploads: 5,
      metafields_enabled: 100,
      team_seats: 10,
      active_campaigns: UNLIMITED_QUOTA,
      analytics_range_days: 365,
    },
    features: [
      "remove_branding",
      "unanswered_analytics",
      "survey",
      "push_notifications",
      "discount_realtime_sync",
      "catalog_auto_sync",
      "premium_campaign_templates",
      "inbox_cart_view",
      "custom_recommendations",
      "exports",
      "csv_import",
      "file_upload",
      "multi_language",
    ],
  },
};

/** The LIVE matrix. Same object identity forever — overrides mutate it in place. */
export const PLANS: Record<PlanId, PlanDefinition> = structuredClone(DEFAULT_PLANS);

// ── Platform overrides (app_secrets["platform:plans"], written by /platform/plans) ──

export const PLAN_CONFIG_SECRET_KEY = "platform:plans";

const planPatchSchema = z.object({
  name: z.string().min(1).max(40).optional(),
  priceMonthly: z.number().min(0).optional(),
  priceYearlyPerMonth: z.number().min(0).optional(),
  trialDays: z.number().int().min(0).max(90).optional(),
  overagePerConversation: z.number().min(0).nullable().optional(),
  // Partial by design (a patch may set one dimension); enum-keyed z.record
  // would demand all 9 keys, so unknown keys are rejected via refine instead.
  quotas: z
    .record(z.string(), z.number().int().min(0))
    .refine((q) => Object.keys(q).every((k) => (QUOTA_DIMENSIONS as string[]).includes(k)), {
      message: "unknown quota dimension",
    })
    .optional(),
  // Tolerant on read: a stored override may still name a feature that has since
  // been un-gated (e.g. auto_detect_language). Rejecting it would invalidate the
  // WHOLE config and silently drop every other override, so unknown names are
  // accepted here and filtered against GATED_FEATURES in applyConfig().
  features: z.array(z.string()).optional(),
});

export const planConfigSchema = z.object({
  enforcement: z.enum(["open", "enforced"]).optional(),
  plans: z
    .object({
      free: planPatchSchema.optional(),
      basic: planPatchSchema.optional(),
      pro: planPatchSchema.optional(),
      plus: planPatchSchema.optional(),
    })
    .optional(),
});

export type PlanConfig = z.infer<typeof planConfigSchema>;

let enforcement: "open" | "enforced" = DEFAULT_ENFORCEMENT;
let lastLoadedAt = 0;
let loading: Promise<void> | null = null;
const REFRESH_TTL_MS = 30_000;

function applyConfig(config: PlanConfig): void {
  enforcement = config.enforcement ?? DEFAULT_ENFORCEMENT;
  for (const id of PLAN_IDS) {
    const merged = structuredClone(DEFAULT_PLANS[id]);
    const patch = config.plans?.[id];
    if (patch) {
      if (patch.name !== undefined) merged.name = patch.name;
      if (patch.priceMonthly !== undefined) merged.priceMonthly = patch.priceMonthly;
      if (patch.priceYearlyPerMonth !== undefined) merged.priceYearlyPerMonth = patch.priceYearlyPerMonth;
      if (patch.trialDays !== undefined) merged.trialDays = patch.trialDays;
      if (patch.overagePerConversation !== undefined) merged.overagePerConversation = patch.overagePerConversation;
      for (const dim of QUOTA_DIMENSIONS) {
        const value = patch.quotas?.[dim];
        if (typeof value === "number") merged.quotas[dim] = value;
      }
      if (patch.features) {
        merged.features = GATED_FEATURES.filter((f) => patch.features!.includes(f));
      }
    }
    // Mutate in place so direct `PLANS[...]` readers see the update.
    Object.assign(PLANS[id], merged);
  }
}

/** Read + apply the stored override row. Fail-open to current values on error. */
export async function loadPlanConfig(): Promise<void> {
  try {
    const row = await db.appSecret.findUnique({ where: { key: PLAN_CONFIG_SECRET_KEY } });
    if (!row) {
      applyConfig({});
    } else {
      const parsed = planConfigSchema.safeParse(JSON.parse(row.value));
      if (parsed.success) applyConfig(parsed.data);
      else logError("platform_plan_config_invalid", parsed.error.issues[0]);
    }
    lastLoadedAt = Date.now();
  } catch (error) {
    // Keep the last-known matrix; never break a gate check over a config read.
    lastLoadedAt = Date.now();
    logError("platform_plan_config_load_error", error);
  }
}

/** Fire-and-forget refresh when the in-memory copy is stale (>30s). */
function maybeRefresh(): void {
  if (Date.now() - lastLoadedAt < REFRESH_TTL_MS || loading) return;
  loading = loadPlanConfig().finally(() => {
    loading = null;
  });
}

// Eager load at boot so the first requests already see stored overrides.
void loadPlanConfig().catch(() => undefined);

const UNLIMITED = UNLIMITED_QUOTA;

export function planEnforcementMode(): "open" | "enforced" {
  maybeRefresh();
  return enforcement;
}

/** Feature gate. In "open" mode always passes (logs nothing). */
export function hasFeature(plan: string, feature: GatedFeature): boolean {
  maybeRefresh();
  if (enforcement === "open") return true;
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
  maybeRefresh();
  if (enforcement === "open") return UNLIMITED;
  const def = PLANS[(plan as PlanId) in PLANS ? (plan as PlanId) : "free"];
  return def.quotas[dimension];
}

/** Display quota (for meters) — the real matrix value even in open mode. */
export function displayQuota(plan: string, dimension: QuotaDimension): number {
  maybeRefresh();
  const def = PLANS[(plan as PlanId) in PLANS ? (plan as PlanId) : "free"];
  return def.quotas[dimension];
}

export function overageRate(plan: string): number | null {
  maybeRefresh();
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
