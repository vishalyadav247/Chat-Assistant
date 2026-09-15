// Plan matrix TYPES + pure constants shared by server (plans.server.ts) and
// client (admin dashboard UI). No secrets, no DB — safe in the browser
// bundle. The live matrix itself stays server-only in plans.server.ts.

export type PlanId = "free" | "basic" | "pro" | "plus";

export type GatedFeature =
  | "remove_branding"
  | "unanswered_analytics"
  | "premium_campaign_templates"
  | "inbox_cart_view"
  | "push_notifications" // browser push in the web app (spec 18) — Basic+
  | "order_tracking"; // shopper order lookup in the widget (spec 06) — Basic+ by default
// Un-gated features (user decisions; stored plan overrides naming them are
// tolerated and filtered out by plans.server planPatchSchema):
//   "multi_language" — persona auto-detect language, every plan.
//   "custom_recommendations" — the merged App-recommendation rules
//   and cross-sell pairs are on every plan; what varies per tier is the
//   cross_sell_pairs QUOTA below.
//   "csv_import" (FAQ consolidation) — the knowledge-CSV source is
//   retired; the FAQ CSV importer is on every plan, bounded by the faqs QUOTA.
//   "exports" — data export/import on every plan, no gate and no
//   operator setting (user decision).
//   "file_upload" — file upload sources on every plan; the
//   file_uploads QUOTA below is the only cap (user decision).
//   "survey" (2026-09-11) — the post-chat CSAT survey is on every plan (user:
//   "a small feature, serve it in all the plans"). Gated, Free showed the
//   survey but the rating endpoint refused it, so answers were discarded.
//   "discount_realtime_sync" + "catalog_auto_sync" — discount
//   webhooks apply on every plan, and the only scheduled sync is a weekly one
//   for what no webhook reports (collection membership, pages, blogs). Keeping
//   synced data correct is not a tier feature (user decision).

export type QuotaDimension =
  | "conversations"
  | "products_synced"
  | "pages_synced" // store pages mirrored on the Pages tab (spec 22) — sync ceiling
  | "articles_synced" // blog articles mirrored on the Blogs tab (spec 22) — sync ceiling
  | "curated_answers"
  // "manual_qas" was retired (FAQ consolidation) — the "faqs" dimension
  // below is the Q&A count cap now.
  | "faqs"
  // "policy_pages" was retired: Shopify has at most 8
  // policy types, so 10/15/20 could never be reached and Free's 5 only stopped a
  // store connecting all of its legal policies. Every plan connects them all.
  | "crawl_pages"
  | "file_uploads"
  | "metafields_enabled" // product/variant metafields opted into AI training (spec 07)
  | "team_seats" // team members (excluding the owner) who can log into the web app (spec 18)
  | "active_campaigns" // simultaneously ACTIVE proactive campaigns (spec 12)
  | "analytics_range_days" // how far back /app/analytics may look (spec 14)
  // "cross_sell_pairs" retired 2026-09-11 (user decision): pairs cost nothing
  // per chat turn (one indexed lookup for the few shown products) and are
  // already bounded — one pair per product, products capped by products_synced.
  | "recommendation_rules"; // merged App-recommendation rules per shop (spec 08, 2026-09-10)

/** Sentinel for "no limit". Kept here (not in plans.server) so the admin
 *  dashboard and the quota meters can recognise it in the browser bundle. */
/**
 * What "open" enforcement grants every store: the top tier's entitlements as the
 * matrix currently defines them — NOT unlimited. Lives here
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
  "premium_campaign_templates",
  "inbox_cart_view",
  "push_notifications",
  "order_tracking",
];

export const QUOTA_DIMENSIONS: QuotaDimension[] = [
  "conversations",
  "products_synced",
  "pages_synced",
  "articles_synced",
  "curated_answers",
  "faqs",
  "crawl_pages",
  "file_uploads",
  "metafields_enabled",
  "team_seats",
  "active_campaigns",
  "analytics_range_days",
  "recommendation_rules",
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
 * `conversations` (usage.server.ts), `products_synced` (catalog-sync.server.ts)
 * and `pages_synced` / `articles_synced` (content-sync.server.ts).
 * Offering the rest in the admin picker would let an operator grant 500 curated
 * answers, see it saved, and have nothing change — a silent no-op is worse than
 * an absent option. Adding one is two lines: read the bonus at that quota's own
 * check site, then list it here.
 *
 * Lives here rather than in quota-grants.server.ts because the admin picker is
 * client code, and a `.server` import from a component fails the BUILD (tsc does
 * not catch it) — the same trap that moved OPEN_MODE_PLAN here before it.
 */
export const GRANTABLE_DIMENSIONS = [
  "conversations",
  "products_synced",
  // Spec 22 — ceilings exactly like products_synced, so a grant raises them the
  // same way; bonusQuota() is read at the cap in content-sync.server.ts.
  "pages_synced",
  "articles_synced",
] as const;

export function isGrantableDimension(dimension: string): boolean {
  return (GRANTABLE_DIMENSIONS as readonly string[]).includes(dimension);
}
