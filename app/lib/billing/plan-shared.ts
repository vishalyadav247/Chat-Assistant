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
  trialDays: number;
  overagePerConversation: number | null; // null = AI stops at cap
  quotas: Record<QuotaDimension, number>;
  features: GatedFeature[];
  /** Operator switch (/admin/plans): true = never offered to merchants. A shop
   *  already ON the plan keeps every quota and still sees it as its current
   *  plan — hiding withdraws an OFFER, it never downgrades anyone. */
  hidden: boolean;
}

/**
 * Dimensions a per-shop bonus grant actually AFFECTS.
 *
 * Deliberately not "every QuotaDimension": a grant only does something where the
 * enforcement site adds `bonusQuota()` to the plan cap, and today that is
 * `conversations` (usage.server.ts) and `products_synced` (catalog-sync.server.ts).
 * Offering the rest in the admin picker would let an operator grant 500 curated
 * answers, see it saved, and have nothing change — a silent no-op is worse than
 * an absent option. Adding one is two lines: read the bonus at that quota's own
 * check site, then list it here.
 *
 * Lives here rather than in quota-grants.server.ts because the admin picker is
 * client code, and a `.server` import from a component fails the BUILD (tsc does
 * not catch it) — the same trap that moved OPEN_MODE_PLAN here before it.
 */
export const GRANTABLE_DIMENSIONS = ["conversations", "products_synced"] as const;

export function isGrantableDimension(dimension: string): boolean {
  return (GRANTABLE_DIMENSIONS as readonly string[]).includes(dimension);
}
