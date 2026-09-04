// Plan matrix TYPES + pure constants shared by server (plans.server.ts) and
// client (admin dashboard UI). No secrets, no DB — safe in the browser
// bundle. The live matrix itself stays server-only in plans.server.ts.

export type PlanId = "free" | "basic" | "pro" | "plus";

export type GatedFeature =
  | "remove_branding"
  | "unanswered_analytics"
  | "discount_realtime_sync"
  | "catalog_auto_sync"
  | "premium_campaign_templates"
  | "inbox_cart_view"
  | "exports"
  | "csv_import"
  | "file_upload"
  | "survey" // post-chat CSAT survey (spec 16) — Basic+
  | "push_notifications" // browser push in the web app (spec 18) — Basic+
  | "custom_recommendations"; // custom recommendations + cross-sell pairs (spec 08) — Pro+
// "multi_language" (persona auto-detect language, spec 08) was gated until
// 2026-09-03 — un-gated on every plan (user decision; matches the spec 15
// matrix). Stored plan overrides naming it are tolerated and filtered out
// (plans.server planPatchSchema).

export type QuotaDimension =
  | "conversations"
  | "products_synced"
  | "curated_answers"
  | "manual_qas"
  | "policy_pages"
  | "crawl_pages"
  | "file_uploads"
  | "metafields_enabled" // product/variant metafields opted into AI training (spec 07)
  | "team_seats" // team members (excluding the owner) who can log into the web app (spec 18)
  | "active_campaigns" // simultaneously ACTIVE proactive campaigns (spec 12)
  | "analytics_range_days"; // how far back /app/analytics may look (spec 14)

/** Sentinel for "no limit". Kept here (not in plans.server) so the admin
 *  dashboard and the quota meters can recognise it in the browser bundle. */
/**
 * What "open" enforcement grants every store: the top tier's entitlements as the
 * matrix currently defines them — NOT unlimited (user, 2026-09-03). Lives here
 * rather than in plans.server so the admin UI can name the plan without
 * importing a server module.
 */
export const OPEN_MODE_PLAN: PlanId = "plus";

export const UNLIMITED_QUOTA = Number.MAX_SAFE_INTEGER;

export function isUnlimitedQuota(value: number): boolean {
  return value >= UNLIMITED_QUOTA;
}

export const PLAN_IDS: PlanId[] = ["free", "basic", "pro", "plus"];

export const GATED_FEATURES: GatedFeature[] = [
  "remove_branding",
  "unanswered_analytics",
  "discount_realtime_sync",
  "catalog_auto_sync",
  "premium_campaign_templates",
  "inbox_cart_view",
  "exports",
  "csv_import",
  "file_upload",
  "survey",
  "push_notifications",
  "custom_recommendations",
];

export const QUOTA_DIMENSIONS: QuotaDimension[] = [
  "conversations",
  "products_synced",
  "curated_answers",
  "manual_qas",
  "policy_pages",
  "crawl_pages",
  "file_uploads",
  "metafields_enabled",
  "team_seats",
  "active_campaigns",
  "analytics_range_days",
];

export interface PlanDefinition {
  id: PlanId;
  name: string;
  priceMonthly: number;
  priceYearlyPerMonth: number;
  trialDays: number;
  overagePerConversation: number | null; // null = AI stops at cap
  quotas: Record<QuotaDimension, number>;
  features: GatedFeature[];
  /** Operator switch (/admin/plans): true = never offered to merchants. A shop
   *  already ON the plan keeps every quota and still sees it as its current
   *  plan — hiding withdraws an OFFER, it never downgrades anyone. */
  hidden: boolean;
}
