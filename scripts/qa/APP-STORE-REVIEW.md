# App Store review checklist — executed run (spec 17, item-by-item)

> **Re-executed 2026-08-21** against the current repo (previous run: 2026-08-06).
> Verdicts: **PASS** (verified in code / by live test), **PENDING-MANUAL** (requires a human step
> before submission — exact step listed), **GAP** (missing or wrong, with the file to fix).
> Requirements were re-fetched live from
> `shopify doc fetch --url https://shopify.dev/docs/apps/launch/app-store-review/app-store-ai-self-review-requirements`
> rather than recalled, so numbered requirement ids below (1.1.x / 1.2.x / 2.2.x / 2.3.x / 3.x / 5.1.x)
> are the current official ones.
>
> Live evidence for this run:
> - `npx tsx scripts/qa/install-lifecycle.test.ts` → **104/104 PASS** (install, reinstall, uninstall,
>   webhook HMAC, app-proxy signature, purge)
> - `npx tsx scripts/verify-compliance.ts` → **ALL PASS** (redact / data-request / retention /
>   zero-row purge across **34** shop-scoped tables)
> - `npm run widget:size` → chat-widget.js **15.30 KB gzip** (budget 30 KB)
> - `npx tsc --noEmit` → clean · `npm run lint` → clean except `scripts/qa/perf-queries.test.ts`
>   (owned by the perf QA workstream, 2× `no-inner-declarations`)

---

## SUBMISSION BLOCKERS (fix before you press Submit)

| # | Blocker | File |
|---|---|---|
| B1 | **Protected Customer Data level 2 not requested.** `read_customers` / `write_customers` / `read_orders` read customer name/email/phone and order email/phone/shipping address. A public app must request PCD access **and the specific fields** in the Partner Dashboard, implement level 1 + level 2 requirements, and take part in data-protection reviews. Submitting without this is an automatic hold. | `shopify.app.toml` (justifications now inline), `app/routes/proxy.order-track.tsx`, `app/lib/contacts/contacts.server.ts` |
| B2 | **`.myshopify.com` shop-domain login form still shipped** at `/auth/login` — violates req **2.3.1** ("must not request the manual entry of a myshopify.com URL"). It was deliberately removed from `_index` but the template route was never deleted, and `authPathPrefix = "/auth"` makes the library bounce to it. Delete `app/routes/auth.login/` and the now-unused `login` export. | `app/routes/auth.login/route.tsx:34-42`, `app/routes/auth.login/error.server.tsx:10,12`, `app/shopify.server.ts:44` |
| B3 | **All app URLs are a `trycloudflare` dev tunnel** and `automatically_update_urls_on_dev = true`. `application_url`, `[auth].redirect_urls` and `[app_proxy].url` must point at the production host with valid TLS (req **3.1.1**) before `npm run deploy`. Note the app-proxy URL is pinned per store at install time. | `shopify.app.toml` (warning comment added) |
| B4 | **`billingTestMode` can hand a merchant a paid plan with no Shopify charge in production.** The mock provider makes no Shopify call and persists a fake subscription gid. Operator-only + banner-warned, but it should hard-fail when `NODE_ENV === "production"` — this is the only code path in the repo that bypasses the Billing API (req **1.2.1**). | `app/lib/billing/shopify-billing.server.ts:73-80,363-368` |
| B5 | **Privacy policy document does not exist yet.** Must name OpenAI as processor, state the merchant-configurable transcript retention windows *and* the 7-day post-uninstall retention window, and give a GDPR contact. | listing + hosted policy URL |

---

## 1. Auth & install — PASS (code) / GAP (B2) / PENDING-MANUAL (fresh-store run)

- Embedded app via `shopifyApp()` with `PrismaSessionStorage`, `AppDistribution.AppStore`,
  session-token auth throughout, `future.expiringOfflineAccessTokens` — `app/shopify.server.ts`.
- **1.1.1 session tokens** — PASS. `AppProvider embedded apiKey` (`app/routes/app.tsx:145`) injects the
  current App Bridge; auth is Shopify session token + HttpOnly server-side session rows. Repo-wide
  sweep found **no** `document.cookie`, `window.top`/`window.parent`, and no auth token in
  `localStorage` (only UI-dismissal flags). Works with third-party cookies blocked.
- **2.2.3 latest App Bridge** — PASS. `@shopify/app-bridge-react@^4.2.4`; no legacy `@shopify/app-bridge`.
- **2.2.4 GraphQL-only Admin API** — PASS. Zero REST hits (`/admin/api/*.json`, `restResources`) anywhere.
- **2.3.2 authenticate immediately** — PASS. Every `/app/*` loader calls `requireShopAccess`
  (`app/lib/access.server.ts:107` → `authenticate.admin`). `/` is a static marketing page that
  redirects `?shop=` straight into `/app` (`app/routes/_index/route.tsx:28`) — no pre-auth app UI.
- **2.3.3 redirect to app UI** — PASS (library-handled OAuth callback → `/app`).
- **2.3.4 OAuth on reinstall, no install-once flag** — PASS, verified live: `onShopAuthenticated`
  is idempotent, clears `uninstalledAt`, re-seeds defaults, and a **fully purged** shop reinstalls
  cleanly (`install-lifecycle.test.ts` §8, §9).
- **2.3.1** — **GAP (B2)**, see above.
- **Manual step**: install on a *fresh* dev store, confirm OAuth completes first try with no
  interstitial UI, then re-open from the Apps list.

## 2. Billing — PASS (code path) / GAP (B4) / PENDING-MANUAL (real test charges)

- **1.2.1 Billing API only** — PASS. The only subscription-creation path is
  `appSubscriptionCreate` (`app/lib/billing/shopify-billing.server.ts:137-157,236-303`); overage is
  `appUsageRecordCreate` (`app/lib/billing/usage-records.server.ts:23-38`); cancel/downgrade is
  `appSubscriptionCancel`. **No Stripe/PayPal/external checkout anywhere in the repo.**
  Promo codes do **not** bypass billing — they become an `AppSubscriptionDiscountInput` on the
  recurring line, so Shopify applies and invoices the discount.
- No merchant-triggerable path sets `Shop.plan` to a paid tier without a verified `subscriptionId`
  (every writer traced: billing callback verifies the live subscription name, the
  `app_subscriptions/update` webhook derives the plan from the subscription name only).
  `platform.plans.tsx` edits the plan *matrix*, never `Shop.plan`, and is `requirePlatformAdmin` +
  same-origin gated.
- `test: true` is `NODE_ENV !== "production" || billingForceTestCharges` — correctly gated, not hardcoded.
- **1.2.2 accept/decline + resubscribe after reinstall** — PASS (code): decline returns to
  `/app/plan-usage?billing_error=1`; reinstall leaves the shop on Free with no stale
  `subscriptionId`, so the plan page offers a fresh charge (verified live, §8 of the lifecycle test).
- **1.2.3 upgrade/downgrade in-app** — PASS. `app/routes/app.plan-usage.tsx` handles subscribe +
  `downgradeToFree` without support contact or reinstall.
- Plan enforcement is now **`DEFAULT_ENFORCEMENT = "enforced"`** (`app/lib/billing/plans.server.ts:41`) —
  the previous run's `"open"` gap is closed; gates and quotas are live and server-side
  (verified live: `exportAnalyticsCsv` throws `PlanGateError` for a Free shop).
- **Manual steps**: (a) real *test* charges on a dev store after `npm run deploy` (needed for the
  billing webhook to be registered); (b) confirm listing pricing/trial/overage matches `PLANS` exactly.

## 3. Mandatory compliance webhooks — PASS (live-verified)

- Declared as `compliance_topics` (the required form) in `shopify.app.toml` →
  `/webhooks/compliance`: `customers/data_request`, `customers/redact`, `shop/redact`.
- **HMAC** — verified live with genuinely signed and genuinely forged requests:
  invalid signature → **401 for all three topics, before any handler code runs**, and produced
  **no** DataRequest rows. Valid signature → **200**.
- **5-second budget** — measured this run: data_request **17 ms**, customers/redact **5 ms**
  (enqueue-only), shop/redact **16 ms**.
- **Real workflows, not stubs** (`scripts/verify-compliance.ts`, all PASS):
  - `customers/data_request` → `DataRequest` row with a 30-day `dueAt`, redelivery-deduped;
    export is compute-on-download (no stored PII artifact) and contains *exactly* that customer's
    contacts/conversations/transcripts/rating/unresolved questions — verified to exclude a
    same-shop neighbor customer and a neighbor shop sharing the same email.
  - `customers/redact` → deletes contacts, conversations, messages, unresolved questions, scrubs
    the request email, writes `RedactLog`; idempotent on redelivery; tenancy-safe.
  - `shop/redact` → stamps `uninstalledAt`, deletes lingering sessions, and (**new this run**)
    resets the dead billing fields; day-7 `uninstall-purge` performs the erasure, well inside the
    30-day SLA.

## 4. Scopes — GAP (B1: PCD) / PENDING-MANUAL (listing justification text)

- Ten scopes, each now justified inline in `shopify.app.toml`.
- ⚠️ The previous run's claim *"No `read_orders` / customer scopes"* is **stale** — the app now
  requests `read_orders`, `read_customers`, `write_customers`. That is PCD **level 2** (B1).
- `read_all_orders` is **not** requested (req 3.2.1 N/A). `write_payment_mandate`,
  `write_checkout_extensions_apis`, `read_advanced_dom_pixel_events`,
  `read_checkout_extensions_chat` are **not** requested (3.2.2–3.2.5 N/A).
- **Manual step**: copy the inline justifications into the App Store listing form and the PCD request.

## 5. Performance — PASS (mechanical) / PENDING-MANUAL (Lighthouse run)

- `npm run widget:size` this run: **chat-widget.js 15.30 KB gzip** (budget 30 KB), CSS 5.53 KB,
  renderer 12.91 KB and transport 1.60 KB lazy-loaded on first launcher click.
- `<script defer>`, no external CDNs, fixed-position launcher (no CLS by construction).
- **Manual step**: Lighthouse a storefront page before/after enabling the embed; degradation ≤10 pts.

## 6. Theme extension — PASS

- **5.1.1** — app embed block only (`extensions/chat-widget/blocks/chat-widget.liquid`,
  `"target": "body"`). No ScriptTag, no Asset/Theme API, no theme file writes anywhere in the repo.
  App embeds are off by default and are removed automatically on uninstall — no theme residue.
- **5.1.3 onboarding + deep link** — PASS. Theme-editor deep links with `activateAppId` exist in the
  dashboard setup checklist (`app/lib/dashboard/dashboard.server.ts:200`) and Settings → General
  (`app/components/SettingsGeneral.tsx:342`).
- **5.1.5 collected data returned to the merchant** — PASS. Chat contacts and full transcripts are
  visible in-app (`/app/contacts`, `/app/inbox`) and can be converted into real Shopify customers.

## 7. UX / embedded correctness — PASS (previous GAP closed) / MINOR

- `npx tsc --noEmit` is **clean** — the previous run's analytics build errors are fixed.
- Polaris web components throughout; App Bridge nav via `<s-app-nav>`; contextual save bars.
- **`redirect` helper** — PASS. No `app.*.tsx` imports `redirect` from `react-router`; the one
  embedded redirect uses the helper from `authenticate.admin`
  (`app/routes/app.billing-callback.tsx:24,42`).
- **Raw `<a>` in embedded routes** — PASS. Zero in `app/routes/app.*.tsx`. The two in
  `app/components/TrainingProductsTab.tsx:255,270` are external URLs with `target="_blank" rel="noreferrer"`.
- **`boundary.error` / `boundary.headers`** — every `app.*.tsx` exports `headers = boundary.headers`.
  All 17 routes with a UI export `ErrorBoundary`. The 4 without one
  (`app.browse-data.tsx`, `app.inbox-events.tsx`, `app.push-subscription.tsx`, `app.web-handoff.tsx`)
  are resource routes with no default export, so a thrown response bubbles to `app.tsx`'s boundary.
  **MINOR** — add for template parity.
- **Form submissions** — `useSubmit`/`useFetcher` everywhere. Three raw `fetch()` calls remain and
  are justified (two SSE streams that a fetcher cannot carry, one `DELETE` that could be a fetcher):
  `app/components/TestAiConsole.tsx:154`, `app/lib/ui/inbox-live.ts:25`, `app/lib/ui/push-client.ts:45,71`.
- **MINOR** — 4 internal `<s-link href="/app/plan-usage">` do a document navigation inside the
  iframe instead of a client transition: `app/components/AnalyticsTopQuestions.tsx:89`,
  `app/routes/app.proactive-chat.tsx:334`, `app/routes/app.curated-answers.tsx:489`,
  `app/components/ProactiveTemplatePicker.tsx:164`.
- **2.2.6 / 2.2.7** — N/A, no admin UI extensions and no Max modal.
- **Manual step**: click-through sweep of every admin page for broken links / empty states.

## 8. Listing — PENDING-MANUAL

Accurate screenshots of the current UI; privacy policy URL; support contact; explicit data-use
disclosure that conversations are processed by an LLM (OpenAI). **1.1.4** — PASS repo-side: no
fabricated reviews, sales popups or simulated statistics; every storefront-visible number comes
from real store data.

## 9. Privacy policy — GAP (B5)

Mechanics all exist and are verified (retention windows Forever/90/60/30/7 enforced daily;
redaction verified live), but the policy *document* must be authored and hosted.

## 10. Install / uninstall lifecycle — PASS (live-verified, 104/104)

Run: `npx tsx scripts/qa/install-lifecycle.test.ts`.

- **Install** — `onShopAuthenticated` (the real `afterAuth` hook) creates the Shop row, seeds
  Persona + Guardrails + 2 app recommendations, and enqueues `catalog-sync`/`collection-sync`/
  `discount-sync`. Idempotent on token refresh. `WidgetSettings` / `ShopSettings` / `HandoverConfig`
  / `SyncState` are deliberately **not** seeded — **37 server read paths were executed against the
  bare shop and none threw**; every one falls back to zod schema defaults, so no page 500s.
- **Uninstall** — `app/uninstalled` deletes **all** session rows, stamps `uninstalledAt`, resets
  `plan/planStatus/subscriptionId/billingInterval/trialEndsAt/usageLineItemId` to Free, records a
  `plan_changed` event and invalidates the config cache. **17 ms**, redelivery-safe, and a
  redelivery does **not** move the grace-window clock. Domain data is retained for the 7-day grace
  window by design (spec 17, 2026-08-13 decision) — the previous run's claim that the handler
  "enqueues shop-cleanup" was stale and is corrected here.
- **Background jobs deactivate on uninstall**: every scheduled sweep filters `uninstalledAt: null`
  (reconcile, curated revalidate, auto-resolve, analytics rollup, knowledge re-crawl,
  data-request reminder). No explicit cancellation is needed.
- **Widget stops rendering** — verified live through the real app-proxy route with a genuinely
  signed request: 200 while installed, **404 after uninstall** (sessions are gone, so
  `authenticate.public.appProxy` yields no session). A **forged** proxy signature is rejected (400).
- **Reinstall** — clears `uninstalledAt`, restores retained transcripts, does **not** duplicate the
  default config, re-enqueues a catalog sync (the catalog changed unobserved), and — critically —
  does **not** resume the cancelled subscription: the shop stays Free until a fresh
  `appSubscriptionCreate`.
- **Zero orphan rows** — `cleanupShop` now zeroes **all 34** shop-scoped tables (`verify-compliance.ts`
  step 4 + `countShopRows`), sessions included, keeping only the `Shop` row (stamped) and the
  `RedactLog` audit row. Neighbor shop provably untouched.

### Defects found and fixed in this run

| Defect | Impact | Fix |
|---|---|---|
| `shop/redact` stamped `uninstalledAt` but left `plan`/`subscriptionId` untouched. If `app/uninstalled` was missed, a reinstall inside the 7-day window resurrected a **paid plan against a subscription Shopify had already cancelled** — free paid tier, indefinitely. | Revenue + req 1.2.2 | `app/routes/webhooks.compliance.tsx` — SHOP_REDACT now deletes lingering sessions, resets all billing fields and invalidates the config cache. |
| `PromoRedemption` (shop-scoped) survived `cleanupShop`/`shop-redact` — an orphan row after erasure that also held a `maxRedemptions` slot forever. | GDPR erasure completeness | `app/lib/jobs/handlers.server.ts` — added to `cleanupShop` + `countShopRows`; `scripts/verify-compliance.ts` now seeds and count-asserts it (and `ProductMetafieldDefinition`). |
| `app/scopes_update` used `db.session.update({ where: { id } })`: updated only one of a shop's session rows, and threw `P2025` (→ 500, infinite Shopify retries) if the row had just been deleted by a racing `app/uninstalled`. | Spurious re-grant prompts, webhook retry storms | `app/routes/webhooks.app.scopes_update.tsx` — rewritten to `updateMany({ where: { shop } })` with an array guard on the payload. |

## 11. AI-specific — PASS

- Grounding is mechanical: product cards are built from DB rows, live facts fetched at answer time
  (`app/lib/pipeline/`). Listing claims about "no invented discounts/policies" hold.
- Moderation runs in the pipeline (`app/lib/pipeline/guardrail.server.ts:36`), failures logged,
  never silently skipped.
- Human handover always available (`app/lib/pipeline/handover.server.ts` + Inbox takeover).

## 12. Security & tenancy — PASS (tenancy) / MINOR (headers)

- **Cross-tenant leak hunt: clean.** All 11 `proxy.*` storefront endpoints call
  `authenticate.public.appProxy` first and derive `shopId` **only** from the verified
  `session.shop`; every caller-supplied `conversationId`/`contactId` is bound by
  `{ id, shopId, sessionId }`, so a leaked id is useless both cross-tenant and cross-shopper.
  `api.test-chat.tsx` goes through `requireShopAccess`. `platform.*` is cross-tenant **by design**
  and every loader *and* action is `requirePlatformAdmin` + same-origin gated.
- **Header findings — outside this workstream's file territory, listed for the owner:**
  - `entry.server.tsx` — `/platform/*` documents can have their `frame-ancestors 'none'`
    **clobbered** by `addDocumentResponseHeaders` when an attacker appends `?shop=evil.myshopify.com`
    (`frame-ancestors` overrides the `X-Frame-Options: DENY` that `platform.tsx:24` sets). Fix: add
    `pathname.startsWith("/platform")` to the deny condition, or run the deny block *after*
    `addDocumentResponseHeaders`. Impact limited because the `cc_platform` cookie is `SameSite=Lax`.
  - `X-Content-Type-Options: nosniff` is set **nowhere** in the repo.
  - Embedded `/app/*` documents render shopper PII with **no `Cache-Control: no-store`**.
  - No `Strict-Transport-Security` — confirm it is applied at the edge.
  - `proxy.order-track.tsx` throttles on `x-forwarded-for`; confirm the edge **overwrites** rather
    than appends it, or the rate limit is spoofable.

---

## Grep-able plan-gate inventory

Canonical gate list = the `GatedFeature` union, `app/lib/billing/plans.server.ts`:
`remove_branding | unanswered_analytics | discount_realtime_sync | premium_campaign_templates |
inbox_cart_view | auto_detect_language | exports | csv_import | file_upload`.

| Gate | Enforced at (server-side) |
|---|---|
| `premium_campaign_templates` | `app/lib/campaigns/campaigns.server.ts` |
| `remove_branding` | `app/lib/widget/settings-save.server.ts` |
| `csv_import` / `file_upload` | `app/lib/ingestion/sources.server.ts` |
| `auto_detect_language` | `app/lib/instructions/save.server.ts` |
| `exports` | `app/lib/analytics/reports.server.ts` (`requireExports`) |
| quotas (`getQuota`) | catalog cap `app/lib/ingestion/catalog-sync.server.ts`, curated/manual-QA/crawl seams |

`DEFAULT_ENFORCEMENT = "enforced"` — gates are live.

---

## Submission gate summary

| # | Item | Verdict |
|---|---|---|
| 1 | Auth & install | PASS / **GAP B2** (`/auth/login` shop-domain form) / PENDING-MANUAL |
| 2 | Billing | PASS / **GAP B4** (`billingTestMode` in prod) / PENDING-MANUAL (test charges) |
| 3 | Mandatory compliance webhooks | **PASS** (HMAC 401, <20 ms, real workflows — live-verified) |
| 4 | Scopes | **GAP B1** (PCD level 2 not requested) / PENDING-MANUAL (listing text) |
| 5 | Performance | PASS (15.30 KB gzip) / PENDING-MANUAL (Lighthouse) |
| 6 | Theme extension | PASS |
| 7 | UX / embedded correctness | PASS / MINOR (4 internal `s-link`, 4 resource-route boundaries) |
| 8 | Listing | PENDING-MANUAL |
| 9 | Privacy policy | **GAP B5** |
| 10 | Install / uninstall lifecycle | **PASS** (104/104 live) — 3 defects found and fixed |
| 11 | AI-specific | PASS |
| 12 | Security & tenancy | PASS (tenancy) / MINOR (headers, `entry.server.tsx`) |
| — | Production URLs | **GAP B3** (dev tunnel in `shopify.app.toml`) |
