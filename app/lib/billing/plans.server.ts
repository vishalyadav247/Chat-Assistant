// Plan matrix + gating seam (spec 15) + admin overrides (spec 19).
// The code matrix below is the DEFAULT; the operator can edit every value from
// the /admin dashboard. Overrides live in app_secrets["admin:plans"] and
// are merged into the exported PLANS object IN PLACE, so the 20+ sync consumers
// (incl. direct PLANS[...] reads) pick them up with zero signature changes.
// ENFORCEMENT default = "enforced" (2026-08-21): the tiers below are FINAL, so
// every quota and feature gate is live. The operator can still flip to "open"
// from /admin/plans (spec 19) — no code edit — which grants every store the TOP
// TIER's entitlements (see OPEN_MODE_PLAN). Open is deliberately not "unlimited"
// any more: a ceiling that is a real plan is still a ceiling.

import { z } from "zod";
import db from "../../db.server";
import {
  GATED_FEATURES,
  PLAN_IDS,
  QUOTA_DIMENSIONS,
  OPEN_MODE_PLAN,
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
  OPEN_MODE_PLAN,
  UNLIMITED_QUOTA,
  isUnlimitedQuota,
  type GatedFeature,
  type PlanDefinition,
  type PlanId,
  type QuotaDimension,
};

/** Compiled-in default. The operator can override it from /admin/plans. */
export const DEFAULT_ENFORCEMENT: "open" | "enforced" = "enforced";

/**
 * Whether annual billing is offered at all. Operator switch on /admin/plans.
 *
 * It exists because yearly is not just a discount: Shopify rejects usage lines
 * on ANNUAL subscriptions, so a yearly subscriber can never be billed for extra
 * conversations — they hard-cap at the quota instead, and on the top tier there
 * is not even an upgrade to sell them. Switching yearly OFF makes every paying
 * shop monthly, which is the only interval where the overage path works end to
 * end. Existing annual subscriptions are NEVER touched by this: it only decides
 * what is offered from here on.
 */
export const DEFAULT_YEARLY_BILLING = true;

// FINAL tiers (reconciled 2026-08-21). THIS FILE IS THE SOURCE OF TRUTH for pricing.
// There is deliberately no companion spreadsheet: two copies drifted once (D-16 —
// manual_qas, policy_pages, crawl_pages, team_seats all wrong). A change here must be
// mirrored in the App Store listing pricing, and nowhere else.
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
    hidden: false,
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
    hidden: false,
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
    hidden: false,
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
    ],
    hidden: false,
  },
};

/** The LIVE matrix. Same object identity forever — overrides mutate it in place. */
export const PLANS: Record<PlanId, PlanDefinition> = structuredClone(DEFAULT_PLANS);

// ── Admin overrides (app_secrets["admin:plans"], written by /admin/plans) ──

export const PLAN_CONFIG_SECRET_KEY = "admin:plans";

const planPatchSchema = z.object({
  name: z.string().min(1).max(40).optional(),
  priceMonthly: z.number().min(0).optional(),
  priceYearlyPerMonth: z.number().min(0).optional(),
  trialDays: z.number().int().min(0).max(90).optional(),
  // Editable, but PAID TIERS ONLY — applyConfig() drops it for `free`. A $0.50
  // rate was once set on Free (2026-09-03), a plan that can never be billed
  // because charging needs a Shopify usage line and Free has no subscription;
  // the card then advertised a charge the app would never make. null = this
  // plan hard-caps at the quota instead of billing.
  overagePerConversation: z.number().min(0).max(100).nullable().optional(),
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
  // Operator visibility switch — hides the plan from every merchant-facing
  // list. Never affects a shop already on it (see PlanDefinition.hidden).
  hidden: z.boolean().optional(),
  features: z.array(z.string()).optional(),
  // The gated-feature list as it existed when this override was SAVED. Without
  // it, a feature added to the product later is indistinguishable from one the
  // operator deliberately switched off — and would be silently gated off for
  // this plan forever (which is exactly how push_notifications ended up off for
  // Plus). Absent on legacy rows; those fall back to the plan default.
  knownFeatures: z.array(z.string()).optional(),
});

export const planConfigSchema = z.object({
  enforcement: z.enum(["open", "enforced"]).optional(),
  // Absent = the code default (on). See DEFAULT_YEARLY_BILLING.
  yearlyBilling: z.boolean().optional(),
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
let yearlyBilling: boolean = DEFAULT_YEARLY_BILLING;
let lastLoadedAt = 0;
let loading: Promise<void> | null = null;
const REFRESH_TTL_MS = 30_000;

function applyConfig(config: PlanConfig): void {
  enforcement = config.enforcement ?? DEFAULT_ENFORCEMENT;
  yearlyBilling = config.yearlyBilling ?? DEFAULT_YEARLY_BILLING;
  for (const id of PLAN_IDS) {
    const merged = structuredClone(DEFAULT_PLANS[id]);
    const patch = config.plans?.[id];
    if (patch) {
      if (patch.name !== undefined) merged.name = patch.name;
      if (patch.priceMonthly !== undefined) merged.priceMonthly = patch.priceMonthly;
      if (patch.priceYearlyPerMonth !== undefined) merged.priceYearlyPerMonth = patch.priceYearlyPerMonth;
      if (patch.trialDays !== undefined) merged.trialDays = patch.trialDays;
      if (patch.hidden !== undefined) merged.hidden = patch.hidden;
      // FREE CAN NEVER BILL OVERAGE, so a stored rate for it is ignored rather
      // than applied — the enforcement point for the whole app, since every
      // reader goes through the live matrix. Yearly is excluded at a different
      // layer (overageBillable): the tier itself is fine, the INTERVAL is not.
      if (patch.overagePerConversation !== undefined && id !== "free") {
        merged.overagePerConversation = patch.overagePerConversation;
      }
      for (const dim of QUOTA_DIMENSIONS) {
        const value = patch.quotas?.[dim];
        if (typeof value === "number") merged.quotas[dim] = value;
      }
      if (patch.features) {
        const chosen = new Set(patch.features);
        const seen = new Set(patch.knownFeatures ?? []);
        merged.features = GATED_FEATURES.filter((f) => {
          if (chosen.has(f)) return true; // operator switched it on
          if (seen.has(f)) return false; // operator switched it off
          return DEFAULT_PLANS[id].features.includes(f); // added later → default
        });
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
      else logError("admin_plan_config_invalid", parsed.error.issues[0]);
    }
    lastLoadedAt = Date.now();
  } catch (error) {
    // Keep the last-known matrix; never break a gate check over a config read.
    lastLoadedAt = Date.now();
    logError("admin_plan_config_load_error", error);
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

export function planEnforcementMode(): "open" | "enforced" {
  maybeRefresh();
  return enforcement;
}

/** Is annual billing offered? Checked by the plan page AND its subscribe
 *  action — the interval arrives in a form field, so the card is UI, not a
 *  guard. Existing annual subscriptions keep running either way. */
export function yearlyBillingEnabled(): boolean {
  maybeRefresh();
  return yearlyBilling;
}

function planDef(plan: string): PlanDefinition {
  return PLANS[(plan as PlanId) in PLANS ? (plan as PlanId) : "free"];
}

/** Feature gate. In "open" mode: whatever the top tier grants (plus anything
 *  the shop's own plan already granted — see openQuota for why). */
export function hasFeature(plan: string, feature: GatedFeature): boolean {
  maybeRefresh();
  const def = planDef(plan);
  if (enforcement === "open") {
    return PLANS[OPEN_MODE_PLAN].features.includes(feature) || def.features.includes(feature);
  }
  return def.features.includes(feature);
}

/** Throwing gate for actions. In "open" mode never throws. */
export function requirePlan(plan: string, feature: GatedFeature): void {
  if (!hasFeature(plan, feature)) {
    throw new PlanGateError(feature);
  }
}

/** Quota for a dimension. In "open" mode: the top tier's allowance. */
export function getQuota(plan: string, dimension: QuotaDimension): number {
  maybeRefresh();
  const def = planDef(plan);
  if (enforcement === "open") {
    // NEVER less than the shop's own plan. The matrix is operator-editable, so
    // a mis-set Plus value must not take away something a merchant is already
    // paying for — open mode may only ever be an upgrade.
    return Math.max(PLANS[OPEN_MODE_PLAN].quotas[dimension], def.quotas[dimension]);
  }
  return def.quotas[dimension];
}

/**
 * The plans a merchant may be OFFERED, cheapest first. A hidden plan is left
 * out unless it is the shop's own current plan — a merchant grandfathered onto
 * a withdrawn tier must still see what they are paying for, or the page would
 * claim they are on something they are not.
 */
export function offeredPlans(currentPlan?: string): PlanDefinition[] {
  maybeRefresh();
  return PLAN_IDS.map((id) => PLANS[id]).filter((def) => !def.hidden || def.id === currentPlan);
}

/** true when the plan exists but the operator has withdrawn it from sale. */
export function planIsHidden(plan: string): boolean {
  maybeRefresh();
  return Boolean(PLANS[plan as PlanId]?.hidden);
}

/** Display quota (for meters) — the real matrix value even in open mode. */
export function displayQuota(plan: string, dimension: QuotaDimension): number {
  maybeRefresh();
  const def = PLANS[(plan as PlanId) in PLANS ? (plan as PlanId) : "free"];
  return def.quotas[dimension];
}

/**
 * The cheapest plan that includes `feature`, as its DISPLAY NAME — the one
 * word every upgrade badge and banner shows the merchant.
 *
 * Derived from the live matrix rather than written into each component,
 * because the matrix is operator-editable from /admin: move a feature from
 * Pro to Basic there and a hard-coded "Pro" badge starts lying, on a screen
 * nobody thought to update. Null when no plan has it (the operator switched it
 * off everywhere) — callers should then say nothing rather than invent a tier.
 */
export function requiredPlanName(feature: GatedFeature): string | null {
  maybeRefresh();
  for (const id of PLAN_IDS) {
    if (PLANS[id].hidden) continue; // never advertise a withdrawn plan
    if (PLANS[id].features.includes(feature)) return PLANS[id].name;
  }
  return null;
}

/**
 * The cheapest plan whose `dimension` quota beats the current plan's, as a
 * display name. Powers "N of M used — upgrade to X for more". Null when the
 * merchant is already on the most generous plan for that dimension, which is
 * exactly when a meter should stop nagging.
 */
export function nextPlanNameForQuota(plan: string, dimension: QuotaDimension): string | null {
  maybeRefresh();
  const current = displayQuota(plan, dimension);
  for (const id of PLAN_IDS) {
    if (PLANS[id].hidden) continue; // never advertise a withdrawn plan
    if (PLANS[id].quotas[dimension] > current) return PLANS[id].name;
  }
  return null;
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
