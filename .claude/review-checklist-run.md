# App Store review checklist — executed run (spec 17, item-by-item)

> Executed 2026-08-06 against the current repo as part of feature 17 (Compliance & GDPR).
> Verdicts: **PASS** (verified in code / by live test), **PENDING-MANUAL** (requires a human step
> before submission — exact step listed), **GAP** (missing, with file).
> Deletion workflows were verified live by `scripts/verify-compliance.ts` (all 36 checks passed
> in this run against the dev DB; see feature 17 report).

## 1. Auth & install — PASS (code) / PENDING-MANUAL (fresh-store install)

- Embedded app via `shopifyApp()` with `PrismaSessionStorage`, `AppDistribution.AppStore`, and
  session-token auth throughout — `app/shopify.server.ts`.
- Every admin page authenticates before rendering anything: `app/routes/app.tsx` loader calls
  `authenticate.admin(request)`; nested routes export `boundary.error` / `boundary.headers`.
  No pre-auth UI exists (`/_index` is the login form redirecting into OAuth).
- **Manual step**: install on a *fresh* dev store and confirm OAuth completes first try with no
  interstitial UI, then re-open from the Apps list.

## 2. Billing — PASS (code path) / PENDING-MANUAL (real charges + final tiers)

- All charges go through the Shopify Billing API: `app/lib/billing/shopify-billing.server.ts`
  (AppSubscriptionCreate + return-url callback `app/routes/app.billing-callback.tsx`,
  `app_subscriptions/update` webhook with replaced-subscription guard). Mock flow verified
  22/22 checks (PROGRESS.md, feature 15b).
- ⚠️ Plan matrix is PROVISIONAL and `ENFORCEMENT = "open"` (`app/lib/billing/plans.server.ts:29`)
  by user directive. Before submission the final tiers must be set, enforcement flipped, and the
  listing pricing must match.
- **Manual steps**: (a) run real *test* charges on a dev store (needs `npm run deploy` so the
  billing webhook is registered — flagged NEEDS-MANUAL in PROGRESS.md); (b) confirm
  plans/trial/overage in the listing match `PLANS` exactly.

## 3. Mandatory compliance webhooks — PASS

- Declared in `shopify.app.toml:43-45`: `compliance_topics = ["customers/data_request",
  "customers/redact", "shop/redact"]` → `/webhooks/compliance`.
- HMAC: `app/routes/webhooks.compliance.tsx:12` calls `authenticate.webhook(request)` — the
  library verifies the HMAC and **throws a 401 Response on invalid signatures before any handler
  code runs** (this is the automated review check). Valid requests return 200.
- 5-second budget: `customers/data_request` performs one indexed row insert
  (`webhooks.compliance.tsx:18-24`); `customers/redact` and `shop/redact` are **enqueue-only**
  (`webhooks.compliance.tsx:29-38` → pg-boss, `enqueue()` is a single fast insert).
- Workflows behind the jobs verified live (`scripts/verify-compliance.ts`): customer redact
  (email OR shopify customer id, idempotent on redelivery), data-request export, shop purge.

## 4. Scopes — PASS (code) / PENDING-MANUAL (listing justification text)

- `shopify.app.toml:14` — exactly five scopes, each justified inline:
  - `read_products` — catalog sync for AI product recommendations
  - `read_discounts` — discount sync (training data + realtime webhooks)
  - `write_files` — merchant logo/icon uploads (Shopify Files staged uploads)
  - `read_legal_policies` — policy knowledge connector (merchant content, not PCD)
  - `read_online_store_pages` — pages knowledge connector (merchant content, not PCD)
- No `read_orders` / customer scopes — Protected Customer Data process deliberately deferred
  (toml comment cites spec 17).
- **Manual step**: copy the per-scope justifications into the App Store listing form.

## 5. Performance — PASS (mechanical safeguards) / PENDING-MANUAL (Lighthouse run)

- Widget initial payload gated at ≤30KB gzip by `scripts/check-widget-size.ts`
  (`npm run widget:size`, exits 1 over budget); renderer/transport lazy-load on first click;
  `<script defer>`; no external CDNs (`extensions/chat-widget/blocks/chat-widget.liquid`).
  Launcher is a fixed-position element — no CLS by construction.
- **Manual step**: Lighthouse a storefront page before/after enabling the embed and confirm
  degradation ≤10 points (Shopify's automated check mirrors this).

## 6. Theme extension — PASS

- The widget is an app embed block (`extensions/chat-widget/blocks/chat-widget.liquid`,
  `"target": "body"`). App embed blocks are **off by default** until the merchant enables them in
  the theme editor (platform behavior), and uninstalling the app removes the extension
  automatically — no theme residue (no ScriptTags, no theme file writes anywhere in the repo).

## 7. UX — PASS (patterns) / GAP (in-flight analytics build errors) / PENDING-MANUAL (link sweep)

- Polaris web components (`s-*`) across all admin pages; App Bridge nav via `<s-app-nav>`
  (`app/routes/app.tsx:20`); contextual save bars (`app/components/SaveBar.tsx`, used by
  settings/instructions/etc.); react-router `Link`/`useSubmit` (no raw `<a>` in admin routes).
- **GAP (temporary, owned by feature 14 work in flight)**: `npm run typecheck` and `npm run
  lint` currently fail only in `app/components/AnalyticsBreakdown.tsx`,
  `AnalyticsFunnelPerf.tsx` (invalid `emphasis` prop) and `AnalyticsLineChart.tsx` (unused var +
  **client component importing `app/lib/analytics/reports.server` — breaks `npm run build`**).
  Must be green before submission.
- **Manual step**: click-through sweep of every admin page for broken links/empty states.

## 8. Listing — PENDING-MANUAL

- Nothing repo-side to verify. **Manual steps**: accurate screenshots of the current UI;
  privacy policy URL; support contact (mailto constant exists in the plan page); explicit
  data-use disclosure that conversations are processed by an LLM (OpenAI).

## 9. Privacy policy — PENDING-MANUAL

- App mechanics exist and are verified (retention windows Forever/90/60/30/7 enforced daily;
  redaction verified live), but the policy *document* must be authored and hosted: name OpenAI
  as data processor (under DPA), state retention windows and the merchant-configurable
  transcript retention, and provide a GDPR contact.

## 10. Uninstall — PASS

- `app/routes/webhooks.app.uninstalled.tsx` → deletes sessions + enqueues `shop-cleanup`;
  `shop/redact` (~48h later) enqueues the same purge as backstop
  (`webhooks.compliance.tsx:36-40`).
- Verified live this run: `cleanupShop()` left **zero rows across all 27 shop-scoped tables**
  (every domain model in `prisma/schema.prisma`, enumerated, plus `sessions` by shop domain),
  wrote a `RedactLog(type=shop)` audit row, kept the neighbor shop fully intact
  (`scripts/verify-compliance.ts` step 4).

## 11. AI-specific — PASS

- Grounding is mechanical, not prompt-hope: product cards are built from DB rows only, live
  facts fetched at answer time (`app/lib/pipeline/` per spec 03) — listing claims about "no
  invented discounts/policies" hold.
- Moderation layer in the pipeline: `app/lib/pipeline/guardrail.server.ts:36`
  (`moderationCheck`, run in parallel with routing; failures logged, never skipped silently).
- Human handover always exists: `app/lib/pipeline/handover.server.ts` (`executeHandover`) +
  Inbox takeover (spec 10) — AI goes dormant on handover conversations.

---

## Grep-able plan-gate inventory (feature 15b's list)

Canonical gate list = the `GatedFeature` union, `app/lib/billing/plans.server.ts:9-18`:
`remove_branding | unanswered_analytics | discount_realtime_sync | premium_campaign_templates |
inbox_cart_view | auto_detect_language | exports | csv_import | file_upload`.

Server-side call sites (grep `requirePlan(`):

| Gate | Enforced at |
|---|---|
| `premium_campaign_templates` | `app/lib/campaigns/campaigns.server.ts:93` |
| `remove_branding` | `app/lib/widget/settings-save.server.ts:122` |
| `csv_import` | `app/lib/ingestion/sources.server.ts:175` |
| `file_upload` | `app/lib/ingestion/sources.server.ts:186` |
| `auto_detect_language` | `app/lib/instructions/save.server.ts:82` |
| quotas (`getQuota`) | catalog cap `app/lib/ingestion/catalog-sync.server.ts`, + curated/manual-QA/crawl seams |

All gates are no-ops while `ENFORCEMENT = "open"` (provisional tiers) — flipping to
`"enforced"` is the single switch in `plans.server.ts` once tiers are final (see item 2).

## Submission gate summary

| # | Item | Verdict |
|---|---|---|
| 1 | Auth & install | PASS / PENDING-MANUAL (fresh-store run) |
| 2 | Billing | PASS / PENDING-MANUAL (real charges, final tiers) |
| 3 | Mandatory webhooks | PASS |
| 4 | Scopes | PASS / PENDING-MANUAL (listing text) |
| 5 | Performance | PASS / PENDING-MANUAL (Lighthouse) |
| 6 | Theme extension | PASS |
| 7 | UX | PASS / GAP (analytics build errors in flight) |
| 8 | Listing | PENDING-MANUAL |
| 9 | Privacy policy | PENDING-MANUAL |
| 10 | Uninstall | PASS |
| 11 | AI-specific | PASS |
