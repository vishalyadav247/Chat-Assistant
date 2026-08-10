# ChatConvert — Project Progress

> The single tracking doc for spec-driven development. Update on every feature status change.
> Workflow: `.claude/skills/spec-workflow/SKILL.md` · Specs: `.claude/specs/` · Overview: `.claude/specs/00-overview.md`

## Current phase

**BUILD RUN COMPLETE** (2026-08-06). All 17 features done; all audits passed and findings fixed; all automated gates green. Remaining work = the PENDING-MANUAL dev-store session below, then feature-tier decisions + submission prep.

### Definition-of-done status (plan §gate)

1. Acceptance criteria recorded per feature (this table + spec deltas) ✅
2. Core suite green: typecheck 0 / lint / build / widget 9.69KB gz (≤30) / smoke / golden 9-case ✅ (2026-08-06 final run)
3. `prisma migrate status` clean — 4 migrations, all via guarded workflow ✅
4. Gate inventory: every matrix row → grep-able server enforcement point (15b report + `.claude/review-checklist-run.md`) ✅ — enforcement in ALLOW-ALL mode by user directive
5. Audits ✅ ALL COMPLETE: Waves 1/2 tenancy (0 leaks) + reviews (all fixed) · Wave-3 tenancy **0 LEAK** (R1 plan-escalation FIXED — verified-subscription-name derivation; N1 analytics cron scheduled) · Final Shopify review **0 Critical** — all 3 Major + 4 minor FIXED: M2 test-charge flag (BILLING_FORCE_TEST_CHARGES env for app review), M3 ctaUrl scheme validation (schema + client), m1 webhook backfills usage line item when callback never ran, m2 data-request redelivery dedupe, m3 embed-status behind EMBED_STATUS_ENABLED (skips doomed calls until read_themes), m4 campaign revenue recomputed server-side (client beacon ignored; test updated to assert ignoring)
6. Widget ≤30KB gz ✅; uninstalled shop renders nothing (code-verified; storefront confirm below)
7. E2E scripts all green: golden (chat paths incl. curated/recommendation/handover) · verify-compliance 36/36 (redact/export/purge/retention) · analytics fixtures · campaign metrics · billing mock 22/22 ✅
8. Pending-manual list ⬇️ ✅

### PENDING-MANUAL — the one dev-store session (walk in order)

1. ✅ DONE 2026-08-07 — installed on jgw-check.myshopify.com. Scopes now 6 (`write_app_proxy` added). **Start dev on a self-managed tunnel**, not a bare `npm run dev` — see the decisions log and README.
2. ✅ DONE — app embed enabled; widget renders on the storefront
3. ✅ DONE — **SSE streams correctly** (frames ~500ms apart through a Cloudflare quick tunnel). Fallback transport not needed. Details in the Phase 0 checklist below.
4. **Storefront walkthrough**: launcher variants, chat streaming, product cards + one-click ATC + cart drawer, pre-chat form, FAQ screen, order tracking, handover ("talk to a human") → reply from /app/inbox → widget delivery + Seen, survey, proactive campaign bubble on home page
5. **Admin walkthrough**: all 10 nav pages render; chatbox live preview parity; training tabs (run Sync products); Test AI console incl. Review source
6. **Billing test charges** (dev store, test:true): subscribe each tier monthly + one yearly; verify callback lands plan + trial; cancel/downgrade; check `app_subscriptions/update` webhook fires post-deploy
7. **Semantic re-verification**: `npx prisma db seed && npm run smoke && npx tsx scripts/eval-golden.ts` (already green — re-run to confirm on your machine)
8. **Lighthouse** on a storefront page with the widget enabled (no degradation >10 pts; widget is deferred + 9.69KB)
9. Before submission: privacy policy URL (must name OpenAI as processor), listing copy/screenshots, support contact — then re-run `.claude/review-checklist-run.md` items 8/9
10. **When you define final plan tiers**: edit matrix values in `app/lib/billing/plans.server.ts` + flip `ENFORCEMENT` to "enforced" — every gate activates, no other code changes

Waves: 0 ✅ · 1 (02/03/16/05/06) ✅ · 2 (modals/09/04/07/08/10/11) ✅ · 3 (15/12/13/14/17) ✅

## Feature table

Status: `not-started` → `spec-ready` → `in-progress` → `review` → `done`

| # | Feature | Spec | Status | Depends on | Notes |
|---|---------|------|--------|-----------|-------|
| 00 | Overview & guidelines | `00-overview.md` | done | — | Living doc |
| 01 | Foundation (DB, jobs, proxy/SSE, skeleton) | `01-foundation.md` | done | — | All automated criteria pass; dev-store items in pending-manual |
| 02 | Shopify catalog sync | `02-shopify-sync.md` | done | 01 | Code complete: caps seam, collections/discounts sync+webhooks, daily reconcile cron, afterAuth initial sync + default config seeding. Master learn-toggle UI → 07. Dev-store verification pending-manual |
| 03 | Runtime AI pipeline | `03-ai-pipeline.md` | done | 01, 02 | **GOLDEN SET PASS (7/7 live w/ OpenAI)** 2026-08-06. prompts.ts FROZEN. Diamond-necklace case → off_topic accepted (persona scope, documented in eval). Multi-turn history continuity test → with 05 storefront testing |
| 04 | Knowledge ingestion | `04-knowledge-ingestion.md` | done | 01 | Built (subagent, 48/48 verification incl. live SSRF suite + real-embedding round-trips for manual/pages/csv/file(txt) + FAQ bridge). Jobs + weekly recrawl cron wired. Deltas: **PDF/DOCX parser deferred (dependency decision needed — sources error cleanly)**; shopPolicies scope worth a docs check before 07 wiring; suggested-Q&A generator behind flag |
| 05 | Storefront widget | `05-storefront-widget.md` | done | 01, 03 | Built (subagent + ATC/beacon upgrades): renderer module (06 reuses), transport w/ fallback seam, all screens, prechat, survey, human-poll, real one-click ATC via variantId, 7.09KB gz initial (≤30KB). Deltas in spec. Storefront render/SSE/Lighthouse pending-manual |
| 06 | Chatbox settings | `06-chatbox-settings.md` | done | 01, 05 | Built (subagent): 3 tabs + live preview using the STOREFRONT renderer via ?raw seam (parity by construction, all 7 criteria pass). Deltas: starter answers plain-text v1, import-from-FAQs deferred, up/down reorder, activate-while-dirty discards edits (edge), extra file renderer-assets.server.ts. Onboarding-step flip → 13 |
| 07 | AI Agent home + training data | `07-ai-agent-training.md` | done | 02, 04 | Built (subagent, 12/12 live FAQ checks, all 6 criteria pass). Unresolved-queue population wired into pipeline by orchestrator (dedupe-by-text, 3 fallback sites). Deltas: FAQ plain-text editor + up/down reorder; export/import partial round-trip; discounts real-time switch display-only; policies-only connector (Pages need read_content — deliberate); pdf/docx inherit 04 delta |
| 08 | AI instructions + recommendations + handover config + Test AI | `08-ai-instructions.md` | done | 03 | Built (subagent, criteria pass w/ live evidence: no-meter Test AI, review-source, curated>recommendation ranking). Orchestrator added the missing runtimes post-landing: custom-recommendation buy-lane constraint (term match → hand-picked pool) + cross-sell companion append (6-card cap); stale tooltips cleaned. Deltas: OOS/overstock toggles display-only (OOS hard-enforced in SQL); lazy-cache re-embeds replace the spec's "re-embed job" wording; collections constraint deferred (membership not mirrored) |
| 09 | Curated answers | `09-curated-answers.md` | done | 02, 03 | Built (subagent, all 6 criteria pass — CRUD/revalidation verified live vs dev DB). Browse modals shipped as shared components (08/12 reuse). Deltas: collection filter resolves membership live via Admin GraphQL; served-KPI all-time v1; "pending index" pill for unembedded answers. Daily revalidation job wired by orchestrator |
| 10 | Inbox + human handover | `10-inbox-handover.md` | done | 03, 05, 08 | Built (subagent, all 7 criteria scripted-pass incl. AI→handover→merchant-reply→widget chain, dormancy, leave-message lead, auto-resolve, seen receipts). Auto-resolve cron wired (*/10). Deltas: email notify = logged seam (provider decision pending); cart card renders pageContext.cart else empty state; composer textarea; shopper-facing blocked UI deferred |
| 11 | Contacts | `11-contacts.md` | done | 05, 10 | Built (subagent, 37/37 live checks incl. export RFC-4180/UTF-8 round-trips + negative cross-shop tests). Deltas: anonymous auto-creation not yet (tile reads 0); email→customer Admin-API matching deferred (session-id classification only); export = client-side Blob save (embedded-admin token constraint), async job deferred; inbox links not deep-linked |
| 12 | Proactive chat campaigns | `12-proactive-chat.md` | done | 05, 15 | Built (subagent: CRUD 10/10, triggers 20/20 via node-vm on the real shell file, metrics 8/8, widget 9.69KB gz). Deltas: KPIs all-time (range chip static — event aggregation w/ 14), Smart Product Page = bubble w/ cards + variant ATC (no in-bubble picker), {{cart_total}} not implemented, priority via ▲▼, metric bumps updatedAt (frozen model). Storefront visual pass → pending-manual |
| 13 | Dashboard + onboarding | `13-dashboard-onboarding.md` | done | 02, 06, 09, 12 | Built (subagent, all criteria script-verified live: checklist detection per step, metrics math 3 ranges + deltas + isTest exclusion, live feed tags). Deltas: assisted-revenue KPI = "Chat add-to-carts" proxy (orders/PCD deferred); **embed detection needs read_themes — NOT added (re-auth cost), returns "unknown" w/ verify-in-theme-editor link, code ready**; count-up/sparkline animations omitted (Polaris-native) |
| 14 | Analytics | `14-analytics.md` | done | 03, 10, 16 | Built (subagent, all 5 criteria via deterministic 3-day fixtures — exact-number assertions incl. weighted response averages, donut largest-remainder 100%, rollup idempotency, isTest exclusion everywhere). Rollup cron wired. Deltas recorded in spec by agent (event counters via Message.sourceLayer, human≈handover, 3m daily buckets, sync exports w/ 5000 cap) |
| 15 | Billing & plans | `15-billing-plans.md` | done | 01 | 15a metering (Wave 0) + 15b built (subagent, 22/22 mock-flow checks): BillingProvider real+mock, callback, app_subscriptions webhook (replaced-sub guard), overage usage records, full plan page w/ verbatim FAQ, gate inventory produced. ENFORCEMENT stays open. Deltas: discount code cosmetic (no API param in 2026-07); contact mailto constant; real test charges NEEDS-MANUAL (+ deploy for webhook) |
| 16 | Settings | `16-settings.md` | done | 01 | Built (subagent): all tabs/sub-views, hash deep links, saves + cache invalidation, IANA timezones, availability preview. Deltas recorded in spec. Embed detection→13, retention job→17, survey firing→05/10 |
| 17 | Compliance & GDPR | `17-compliance-gdpr.md` | done | 01, 11, 16 | Built (subagent, **36/36 E2E checks live**: export exact-scope, redact w/ untouched neighbors incl. cross-shop same-email, **zero-row purge count-assert across all 27 tables + sessions**, retention window). Data-request export = compute-on-download (no stored PII artifact — spec delta, documented). Executed review checklist: `.claude/review-checklist-run.md`. Reminder job wired via registerComplianceJobs. Email delivery = logged seam |

**Suggested order** (from 00-overview): 01 → 02 → 03 → 05 → 06 → 09 → 04 → 07 → 08 → 10 → 13 → 15 → 16 → 17 → 11 → 14 → 12.

## Phase 0 checklist (spec 01 acceptance)

- [x] docker-compose + .env(.example) written — **container start pending Docker Desktop install (user installing)**
- [x] Prisma → Postgres, full schema, init migration w/ pgvector + HNSW + GIN (SQL generated offline via `migrate diff`, custom SQL appended)
- [x] `app/lib/` scaffolding (env, tenancy, llm, embeddings, search, pipeline stubs, ingestion, jobs, sse)
- [x] toml: demo blocks removed, scopes `read_products`, webhooks (products/collections/compliance), app_proxy, api_version aligned to 2026-07
- [x] Webhook routes (enqueue-only) + uninstall cleanup
- [x] proxy.ping + proxy.chat skeleton (echo pipeline)
- [x] Theme extension shell `chat-widget` (launcher + probe + echo-chat client)
- [x] Container healthy (pgvector 0.8.6, port 5433); migration applied cleanly; HNSW ×4 + GIN + generated tsvector column verified in DB (2026-08-06)
- [x] Seed pass (40 products, 30 knowledge docs, 6 curated answers, persona, guardrails — pseudo-embeddings, no OPENAI_API_KEY yet)
- [x] Smoke pass: pgvector, custom-index guard, hybrid search, keyword search, browse fallback, curated match, RAG (2026-08-06)
- [x] typecheck / lint / build pass (2026-08-06)
- [x] Migration drift-guard built & tested: `npm run migrate:new` + `scripts/scrub-migration.ts` (see decisions log)
- [x] `shopify app dev` boots; install on dev store OK (jgw-check.myshopify.com, 2026-08-07)
- [x] **SSE probe result: STREAMING WORKS — no fallback transport needed.** Measured 2026-08-07 via `GET /apps/ccwidget/ping` through a Cloudflare quick tunnel: frames at `11:05:08.266`, `11:05:08.767`, `11:05:09.267` — ~500ms apart, `content-type: text/event-stream`, delivered incrementally. The template README's "Cloudflare tunnels buffer the stream" warning did **not** reproduce. Spec-01 fallback seam (`window.__ccDirectStream`) stays unused.
- [x] Widget renders on the storefront and boots against the app proxy (`widget-config` → 200 JSON, `active:true`)

### Remaining manual steps (need Shopify CLI login)

```
npm run dev            # press P → install on dev store
# Theme editor → App embeds → enable "ChatConvert Chat Widget" → view storefront
# Click the "💬 ChatConvert (setup)" launcher → open browser console:
#   [ChatConvert probe] frames ~500ms apart? → record SSE result above
#   [ChatConvert chat] echo tokens streaming? → transport round-trip OK
# Add OPENAI_API_KEY to .env, then re-run: npx prisma db seed && npm run smoke  (semantic assertions)
```

## Decisions log

| Date | Decision |
|---|---|
| 2026-08-06 | Dev DB = Docker Postgres + pgvector (user choice); replaces SQLite entirely |
| 2026-08-06 | LLM = OpenAI gpt-4o-mini + text-embedding-3-small behind LlmProvider interface (user choice) |
| 2026-08-06 | Orchestration v1 = router-first; tool-calling later (user choice) |
| 2026-08-06 | Streaming = SSE (POST fetch-stream) via app proxy; fallback = signed-token direct streaming |
| 2026-08-06 | Jobs = pg-boss on same Postgres; webhook handlers enqueue-only |
| 2026-08-06 | Scopes v1 = read_products only; read_orders/PCD deliberately deferred |
| 2026-08-06 | No RLS v1 — tenancy via code seam + tenancy-auditor |
| 2026-08-06 | History window: 10 msgs for router / 6 for generation + rolling summary (resolves demo-vs-guide inconsistency) |
| 2026-08-06 | Router parse failure → retry then chat-clarify (fixes demo's default-to-buy bug) |
| 2026-08-06 | **PROVEN: Prisma 6.16 differ does NOT ignore Unsupported-column indexes** — raw `migrate dev` regenerates DROP INDEX for all HNSW/GIN indexes + strips the generated tsvector expression. Mitigation shipped & tested: all migrations via `npm run migrate:new -- --name <x>` (create-only → scrub-migration.ts → apply); smoke test asserts the 5 protected indexes exist. db-tenancy skill + spec 01 updated. |
| 2026-08-06 | Docker Desktop = per-user install; CLI at `%LOCALAPPDATA%\Programs\DockerDesktop\resources\bin` (may need PATH in fresh shells) |
| 2026-08-06 | **Plan gating = ALLOW-ALL mode for now** (user directive): the spec-15 matrix is provisional/dummy. `requirePlan`/`getQuota` seams are wired at every gate point but enforcement mode is "open" — all features shown & usable on every plan, no locks/limits. User will define final per-tier features later; flipping to enforced = one config change in `app/lib/billing/plans.server.ts`. |
| 2026-08-06 | OPENAI_API_KEY verified working — dev shop re-seeded with real embeddings |
| 2026-08-06 | App-recommendation runtime layer added to pipeline (pre-08, orchestrator-built): per-trigger embeddings via in-memory cache (joined-string embedding dilutes matches — eval-proven), threshold = curatedMatchThreshold, ranked below merchant curated (golden 9/9 proves ordering). Prompts unchanged — freeze intact |
| 2026-08-07 | **App proxy subpath changed `chatconvert` → `ccwidget`.** The original subpath's record on the dev store was pinned to the `https://example.com/proxy` placeholder; moving to a fresh subpath guaranteed a clean binding. Changed in 3 places that must stay in sync: `shopify.app.toml` `[app_proxy].subpath`, `chat-widget.liquid` `data-proxy-base`, and the fallback in `assets/chat-widget.js`. Storefront path is now `/apps/ccwidget/*`. |
| 2026-08-07 | **PROVEN: a store pins the app-proxy destination at install time and never refreshes it.** Not `npm run deploy`, not restarting `shopify app dev`, not a scope re-authorization (which refreshes the access token, so it *looks* like it worked). Only a genuine uninstall → fresh install rewrites it. Symptom: storefront 500 + "There was an error in the third-party application", ~99ms, zero requests reaching the tunnel; widget renders nothing because its `widget-config` fetch fails silently by design. **Any `[app_proxy]` change (url/prefix/subpath) requires uninstall+reinstall on every store.** Documented in README. |
| 2026-08-07 | **Dev must run on a self-managed tunnel**, not the CLI's default. `npm run dev` mints a new `trycloudflare.com` hostname per restart; combined with install-time pinning the registered proxy URL goes stale within minutes. Workflow: start `cloudflared tunnel --url http://localhost:3000 --metrics 127.0.0.1:20241` once, then `npm run dev -- --tunnel-url https://<host>:3000`. Survives dev restarts. |
| 2026-08-07 | Relative `[app_proxy].url` (`/proxy`) is documented by Shopify as auto-prefixed with `application_url`, but **could not be made to resolve** in practice — deployed relative URLs gave storefront 500s with no request reaching the tunnel. Use the absolute form. |
| 2026-08-07 | `write_app_proxy` scope added — required to configure `[app_proxy]` at all. Scopes now 6; merchant re-auth required. |
| 2026-08-07 | `PRISMA_CLIENT_ENGINE_TYPE=binary` enabled in `.env` (was commented). Prisma Studio and stale `react-router dev` processes lock `query_engine-windows.dll.node` on Windows, making the CLI's pre-dev `npx prisma generate` fail with `EPERM` — the app server then never boots and the CLI reports `Unreachable target`. Stop Studio before `npm run dev`. |
| 2026-08-10 | **PROVEN: releasing an app version from the Partner dashboard (e.g. manually editing URLs after a tunnel change) publishes config WITHOUT the theme-extension asset bundle.** The embed liquid still renders and the proxy still works, but chat-widget.js/.css 404 on the CDN → widget silently renders nothing. Fix: `npm run deploy` (CLI) to release a version with assets. Rule: after a tunnel change, never edit URLs in the dashboard — sync `shopify.app.toml` and let the CLI handle it (`automatically_update_urls_on_dev` covers dev; deploy covers releases). |
| 2026-08-06 | Handover RUNTIME added to pipeline (pre-10, orchestrator-built): explicit-ask/sentiment/repeat pre-router + intent-rules post-embedding + cannot-answer escalation after fallback turns; executeHandover applies destination config (inbox/collect_email/contact_methods), aiWhileWaiting × availability dormancy, sys messages, handover frame for widget. Explicit-ask path verified live (conversation flagged, mode=human). Golden 9/9 unaffected. Merchant email notify + widget form UI → feature 10 |
| 2026-08-10 | **FAQ manager rebuilt to match `.claude/resources/other/faq.png`** (Chatty-style, user-provided reference). Patterns now standard for list-manager UIs: (1) toolbar = grouped menu buttons via `s-button commandFor` + `s-menu` ("More actions" → Import/Export, primary "Add new" → Add FAQ/Add category) instead of a row of flat buttons; (2) reordering = drag handles (`s-icon type="drag-handle"`, HTML5 DnD, before/after midpoint detection) replacing ↑/↓ Order columns — FAQ tree supports cross-category drops (new `placeFaq`/exported `placeCategory` + `faq-place`/`category-place` intents; drag disabled while filtered/busy; handles keep ArrowUp/Down keyboard fallback via the old move intents); (3) shared `app/components/DragReorder.tsx` (`useDragReorder` + `DragHandle` + `arrayMove`) applied to chatbox starter questions and contact methods (client-side lists, saved via save bar). Campaigns table keeps ▲▼ (paginated/searchable DataTable — drag indexes ambiguous). |
| 2026-08-10 | **Icons-only + drag-from-handle polish** (user directive): all UI text glyphs (▸▾▲▼★☆✕✓←→↑↓) replaced with official Polaris `s-icon`/`s-button icon` across the app (FAQ chevrons/stars, modal/chip closes → `x`, campaign priority → `caret-up/down`, back buttons → `arrow-left`, StatTile deltas → `arrow-up/down`, inbox + analytics star ratings → `star`/`star-filled`, resolve ✓ → `check`); decorative trailing "→" dropped from buttons/links; merchant-editable emoji (category icons, starters) stay. **Use only supported Polaris icons for all future UI** — rule recorded in polaris-admin-ui skill. Drag now starts ONLY from the handle (rows scroll/select normally — Chatty behavior); FAQ search filtering deferred via useDeferredValue; FAQ filters = `s-clickable-chip` + `s-popover` inline dropdowns; FAQ table = rounded container + row hover shadow (scoped CSS). |
| 2026-08-10 | **App-wide save UX standardized** (user feedback: FAQ save looked frozen). (1) Modal primary actions show `s-button loading` while their fetcher is in flight (FaqManager, TrainingKnowledgeTab, delete banners, AI toggle). (2) Page-level forms use ONLY the App Bridge contextual save bar — removed the duplicate bottom Save/Cancel rows from Instructions tabs and Settings sub-views (SettingsPrivacy/Survey/Availability props slimmed). (3) Full-page editors converted to the SaveBar pattern with JSON-snapshot dirty tracking + back-chevron headers: curated-answers editor, ProactiveCampaignEditor (route owns save; editor lost onSave/saving props), RecommendationDetail, RecommendationDetailCustom. Rule going forward: new admin forms = contextual save bar; modals = footer button with `loading`. |

## Wave-1 gate results (2026-08-06)

- **Tenancy audit: 0 LEAK / 1 RISK — FIXED** (rate-limit bucket now keyed `${shopId}:${sessionId}` + stale-prune instead of global clear). Same-shop notes accepted: conversation ids are non-enumerable cuids; customerRedact email-only + missing no-email RedactLog → owned by feature 17.
- **Shopify review: 2 Critical / 3 Major / 5 minor — ALL FIXED** except accepted notes:
  - C1/C2: scopes now `read_products,read_discounts,write_files` (discounts + Files API were dead code without them) — **merchant re-auth required on next install**
  - M1: daily retention-purge job shipped (Settings promise now enforced); M2: customerRedact scrubs DataRequest emails; M3: cleanupShop deletes Session rows (offline token + owner PII)
  - m1: discount-sync plan-gate seam added; m2: FAQ HTML sanitized at serve time; m3: embed deep link now carries `activateAppId={api_key}/chat-widget`; m4: widget CSS lazy-loads after config check (disabled shops pay zero bytes)
  - m5 accepted: conversationId as bearer capability (cuid unguessability), noted for 10

## Wave-2 gate results (2026-08-06)

- **Tenancy audit: 0 LEAK.** Findings all FIXED: inbox preview raw SQL used snake_case columns (failed closed — would have broken every Inbox load; fixed + live-verified); cleanupShop now deletes crossSellPair + unresolvedQuestion; customerRedact + retentionPurge now delete unresolved-question copies of purged/redacted conversations. Accepted note: proxy conversationId remains cuid-gated (defense-in-depth binding to sessionId in backlog).
- **Shopify review: 1 Critical / 3 Major / 6 minor — FIXED** except accepted/backlogged:
  - C1 FIXED: conversation ownership now bound to widget sessionId across proxy.messages (+widget param), proxy.survey, submitHandoverForm, and the pipeline's by-id conversation resume (v1 cuids are NOT unguessable — id alone was a weak bearer token)
  - M1 was already fixed post-tenancy-audit (same finding); M2 FIXED: customers/redact matches email OR shopifyCustomerId; M3 FIXED: unverified handover submissions can no longer hijack an existing contact's identity (customer match → fresh lead row; no sessionId/phone overwrite)
  - m1 FIXED: review-queue → curated prefill deep link now opens the add form + marks handled on save; m4 FIXED: handover form labels htmlFor + role=alert/aria-live; m6 FIXED: intentRules capped at 20
  - Backlogged (Follow-up backlog): m2 unbounded loader queries (server pagination before scale), m3 collection-filter 250-member truncation, m5 swap regex sanitizer for a vetted dependency

## Blockers / open questions

- SSE-through-app-proxy behavior unknown until probe runs (fallback designed).
- Sales-share KPI + order attribution need orders scope (PCD) — deferred; v1 uses cart-attribute attribution.
- Shopify Files vs app CDN for logo/icon uploads — decide in 06.

## Follow-up backlog (build-discovered)

- PDF/DOCX text extraction for file sources (needs a parser dependency decision; sources currently error cleanly with "parser pending")
- SSRF guard: pinned-socket anti-DNS-rebinding hardening (current: per-hop resolve-then-fetch)
- Served-this-month KPI on curated page → month-accurate via curated_served events (one-line swap)
- proxy.messages: bind conversation lookups to widget sessionId (bearer-capability hardening, with 10)
- Activate-while-dirty on chatbox page discards unsaved edits (UX edge)
- Server pagination for training/contacts/browse-data loaders (unbounded at 10k+ products)
- Collection filter truncates at 250 members (add cursor loop or surface truncation)
- Swap regex HTML sanitizer for sanitize-html/DOMPurify-server (dependency decision, with pdf-parser)

## Design-gap backlog (referenced in designs, not drawn — minimal specs exist)

Unresolved-questions review queue (07) · suggested-Q&A review (04/07) · proactive campaign editor (12) · CSV column-mapping step (04) · Manage metafields (07) · AI settings / Automation settings / Translation settings screens · analytics export button placement (14) · team invites (16) · cross-sell pair editor (08).

## Naming / consistency cleanups (from design review)

"Chatty" → ChatConvert (handover copy) · "Chittpa" default widget name → blank→"ChatConvert" · currency = shop currency (designs mix ₹/$) · plan CTAs must say Upgrade/Downgrade/Current correctly · quota meters derive from plan matrix, never hard-coded Plus values.
