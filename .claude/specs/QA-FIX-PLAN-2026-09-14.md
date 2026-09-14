# QA Fix Plan — 2026-09-14

> Implementation plan for every finding in `QA-REPORT-2026-09-14.md` (same directory).
> Status: **plan ready — Phase 2 item C3 awaits owner OK on the recommended option (§1).**
> Finding IDs (QA-C1 …) refer to the report. Line numbers in the report have drifted since
> the run (dashboard + store-info work landed after it); locations below were re-checked
> 2026-09-14 and name files/functions rather than lines where lines move.

---

## 1. Owner decisions (recorded)

| # | Question | Decision | Consequence for the plan |
|---|---|---|---|
| D-1 | QA-C3 — how Debug recording works in production | **Recommended (awaiting OK):** per-store recording with auto-off, owner-only reading, every read logged — **and hard-locked off in production** until the privacy policy + PCD answers are updated | C3 builds the allowlist/auto-off/role/logging now; production refuses to record unless `ALLOW_TURN_TRACING=true` is set, which the owner flips only after D-5 |
| D-2 | QA-C4 — Debug recordings in `customers/data_request` exports | **Exclude and disclose** | No export change for `turn_traces`; privacy-policy §10 states the exclusion (≤7-day debug data) |
| D-3 | QA-P4 — default transcript retention | **90 days for new installs** | Existing shops keep their stored choice (incl. "Keep forever"); install seeds `retentionDays: 90`; policy text updated |
| D-4 | QA-A3 — off-topic requests | **Rule + add scope fields** | Tuning event: creative/general-assistant requests are `off_topic` when a scope is set; add **Store scope** + **Off-topic message** to Instructions → General. Closes the PROGRESS open decision "Store scope + off-topic message" |
| D-5 | Privacy policy + PCD answers (C3, C4, P4) | Owner publishes | Plan drafts the clauses (`docs/privacy-policy-page.html`); the hosted page and Partner Dashboard answers are owner actions |

Still open for the owner, not blocking any code: nothing else. Ask before improvising on any
item marked **⚠ confirm** below.

---

## 2. Ground rules for the fixing session

- One phase at a time; each phase ends with its **Gate** green before the next starts.
- Iron rules apply: every query shop-scoped; migrations only via `npm run migrate:new`
  (never `prisma db push`); webhook handlers enqueue-only; prompts only in
  `app/lib/pipeline/prompts.ts`; Shopify facts from shopify.dev (dev MCP), never memory.
- **One migration** for the whole plan (Phase 2): `AdminUser.role`, `DataRequest.shopifyCustomerId`
  + `customerPhone`. Create it once, with all three columns, to avoid migration churn.
- HTTP suites need a **quiet dev server** (`npm run dev`, no other session hot-reloading) — see T4.
- A concurrent session may edit the same files: re-read before editing, never revert unknown changes.
- Tick each finding in the report's §9 checklist as it lands; log decisions in PROGRESS.md.

---

## 3. Phase 1 — Submission blocker + quick wins (≈ half a day)

### QA-C1 · Critical — remove the shop-domain form (App Store req 2.3.1)
Verified 2026-09-14 on shopify.dev: *"Your app must not request the manual entry of a
myshopify.com URL or a shop's domain during the installation or configuration flow."*
- `app/routes/_index/route.tsx`: delete the `<Form>` + `shop` input + its `action` (`login()`)
  and `loginErrorMessage`; keep the loader's `?shop=` / admin-referrer → `/app` redirect; render
  the marketing page with a single CTA to `listingUrl` ("Install from the Shopify App Store").
  When `SHOPIFY_APP_STORE_HANDLE` is unset (pre-listing), show no install CTA (text only).
- `app/routes/auth.login.tsx`: loader-only redirect (to `/` or the listing); no form, no action.
- Remove now-unused CSS classes / imports.
- Docs: `scripts/qa/APP-STORE-REVIEW.md` B2 → **re-opened then fixed** (the "no such rule" note
  is wrong — cite 2.3.1).
- **Tests:** `routing.test.ts` + `ui-web.test.ts` — assert `/` HTML has no `name="shop"` input and
  no `myshopify.com` placeholder; `/?shop=x.myshopify.com` still 302s into `/app`; `/auth/login`
  GET redirects, POST is 405/redirect.
- **Verify:** `grep -rn "myshopify.com" app/routes/_index app/routes/auth.login.tsx` → no
  input/placeholder hits.

### QA-T1 · Major — plan-gates crashes at startup
- `scripts/qa/plan-gates.test.ts`: after the `.env` load add
  `process.env.SHOPIFY_APP_URL ||= "http://localhost:3000";` (same as `features.test.ts:28`).
- Check every other `scripts/qa/*.test.ts` and `scripts/*.ts` that imports `save.server` /
  `instructions/save.server` for the same gap (the store-info import chain is new) — add the line
  wherever missing.
- **Verify:** plan-gates 35/35.

### QA-C2 · Major — Debug action same-origin guard
- `app/routes/admin.debug._index.tsx` `action`: `if (!sameOrigin(request)) return { ok: false … }`
  before reading the form (import from `lib/team/same-origin.server`, as `admin.plans.tsx`).
- **Tests:** `routing.test.ts` admin-auth route list gains `/admin/debug` (+ detail route);
  `ui-admin.test.ts` cross-origin POST → rejected, same-origin toggle works.

### QA-S1 · Major — foreign conversationId planted into Debug
- `app/lib/pipeline/index.server.ts` rate-limited path: `conversationId: ""` (never echo the
  client value). Confirm the widget treats `""` as "keep current conversation" (it already does
  per report — re-check `chat-widget.js` done-frame handling).
- Debug routes keyed by store: rename `admin.debug.$conversationId.tsx` →
  `admin.debug.$shopId.$conversationId.tsx`; loader `where: { shopId, conversationId }`; list
  groups by `` `${shopId}:${conversationId}` `` (so each store's "(no conversation)" bucket stays
  separate) and links to the new path. (With C4(a) below, empty-id traces stop being written, so
  the bucket only shows legacy rows.)
- **Tests:** new features case — rate-limited turn with a foreign conversationId yields `""`;
  detail loader query includes `shopId`; tenancy-race suite green.

### QA-S2 · Minor — `sync-all` permission
- `app/routes/app._index.tsx` action: `sync-all` also requires `can(role, surface, "ai_agent")`
  (same as Training sync). Toast "You don't have permission…" on refusal.

**Gate 1:** typecheck · lint · build · plan-gates · routing · ui-web · features.

---

## 4. Phase 2 — Privacy & compliance (≈ 1.5–2 days)

### Migration (one, first)
`npm run migrate:new` with:
- `AdminUser.role String @default("admin")` — values `owner | admin`. Backfill: the **oldest**
  admin becomes `owner` (in the migration SQL). `scripts/admin-account.ts` gains `--role`.
- `DataRequest.shopifyCustomerId String?`, `DataRequest.customerPhone String?`.

### QA-C4 · Major — erasure gaps + data-request matching
a. `turn-capture.server.ts` `saveTurnTrace`: **skip** when `conversationId === ""` (no row can
   hold shopper text that redact cannot reach). Update the comment + Debug list copy.
b. Late writes after erasure: in `saveTurnTrace`, re-check before insert that the shop exists,
   is not `uninstalledAt`, and (when a contact is attached to the conversation) the conversation
   still exists — skip otherwise. Backstop: `purgeTurnTraces` also deletes rows whose shop has
   `uninstalledAt != null` or no longer exists (mirror `purgeAppLogs`).
c. `webhooks.compliance.tsx` `CUSTOMERS_DATA_REQUEST`: store `customer.id` (as GID or numeric —
   **⚠ confirm the payload shape on shopify.dev before coding**) and `customer.phone` on the
   DataRequest; accept a request with no email when an id or phone exists. Dedupe on
   `(shopId, pending, email|customerId)`.
   `data-request.server.ts` `buildDataRequestExport`: match contacts with the **same predicate
   as customer redact** (email OR shopifyCustomerId OR phone) — extract one shared
   `contactMatchWhere(shopId, identity)` helper used by both, so they cannot drift again.
d. Per D-2: `turn_traces` stay out of the export; policy §10 discloses it.
- **Tests:** `scripts/verify-compliance.ts` — (1) a trace written after `cleanupShop` is gone
  after `purgeTurnTraces`; (2) an email-less, id-matched contact is both exported and erased;
  (3) zero rows across all tables still holds. Features: empty-conversationId turn writes no trace.

### QA-C3 · Major — Debug recording controls (per D-1, recommended option)
1. **Per-store allowlist + auto-off.** Runtime config: replace `turnTracingEnabled` with
   `turnTracing: { shopIds: string[]; until: string | null }`. Recording is on for a turn only
   when `shopId ∈ shopIds` and `now < until`. UI: store picker (search by domain) + duration
   select (1 h / 4 h / 24 h, default 4 h) + "Stop now". Legacy `turnTracingEnabled: true` reads as
   **off** (fail closed).
2. **Production lock.** `turnTracingAllowed()` = `NODE_ENV !== "production" ||
   process.env.ALLOW_TURN_TRACING === "true"`. When false the Debug page shows why and the start
   controls are disabled; `observeTurn` is not attached.
3. **Owner-only.** `requireAdminUser(request, { role: "owner" })` on both Debug routes (list +
   detail + actions). Non-owners see the nav item hidden.
4. **Read audit.** Detail loader writes `logWarn("turn_trace_viewed", …, { by, shopId,
   conversationId, turns })`; list loader logs `turn_trace_list_viewed`. Toggle/clear already log —
   add `shopIds` + `until` to the toggle entry.
5. **Fresh read (QA-U6 folded in).** The per-turn check reads the tracing config with a short
   cache (≤5 s) and **fails closed** on load error, so "Stop now" takes effect within seconds.
6. **Policy draft (D-5).** `docs/privacy-policy-page.html`: new "Support & debugging access"
   clause — who can enable it (ChatConvert owner admin, per store, time-limited), what is recorded
   (chat text, AI prompts), 7-day deletion, access logged; update §14 advance-notice language.
   Owner publishes + updates PCD answers, then sets `ALLOW_TURN_TRACING=true` in production.
- **Tests (also QA-T2 DBG-*):** off → no rows; allowlisted shop A → only A's turns recorded;
  expired `until` → no rows; production without the env flag → no rows; non-owner → 403 on Debug;
  detail view → one `turn_trace_viewed` log row; legacy global flag → off.

### QA-C5 · Major — subscription webhook enqueue-only
- New job `subscription-reconcile` in `app/lib/jobs/handlers.server.ts`; move the whole body of
  `webhooks.app-subscriptions.tsx` (plan mapping, `getActiveSubscription`, stale/replaced guards,
  trial ledger backfill, `invalidateShopConfig`, events) into
  `app/lib/billing/subscription-reconcile.server.ts` `reconcileSubscription(shopDomain, payload)`.
- Webhook: `authenticate.webhook` → topic check → `enqueue(JOBS.subscriptionReconcile, { shopDomain,
  payload })` → 200. Update the header comment (it claims inline is fine).
- Ordering: two webhooks for one shop can arrive back-to-back; use a pg-boss singleton/queue
  policy per shop so they run serially (**⚠ confirm the pg-boss 12 option name in
  `node_modules/pg-boss` before coding** — same check as QA-U1).
- **Tests:** `subscription-webhook.test.ts` calls `reconcileSubscription` directly (12/12);
  a source-guard check that the route file contains no `getBillingProvider`/`graphql`;
  `overage` + `trial` suites green.

### QA-P4 · Minor — 90-day default for new installs (D-3)
- `app/lib/install.server.ts`: when creating the ShopSettings row for a **new** shop, seed
  `retentionDays: 90`. Keep `shopSettingsSchema.retentionDays.catch(0)` so existing shops without
  the key are unchanged (D-3 excludes them). Reinstall of a shop that already has a settings row:
  untouched.
- Settings → Chatbox/General retention picker shows 90 selected for new shops; copy unchanged.
- Policy draft: "transcripts are deleted after 90 days by default for stores that install after
  <date>; merchants can change this".
- **Tests:** install-lifecycle — fresh install → `retentionDays` 90; existing row → unchanged;
  retention purge honours 90.

**Gate 2:** migration applied (`prisma migrate status` clean) · verify-compliance · features ·
subscription-webhook · overage · trial · install-lifecycle · ui-admin · typecheck/lint/build.

---

## 5. Phase 3 — AI tuning event (≈ 1.5–2 days, one batched tuning event)

Process (`.claude/skills/ai-pipeline/SKILL.md`): **write the failing golden cases first**, run
`npm run eval:golden` to see them fail, fix, re-run until all pass, then log ONE tuning event in
PROGRESS.md listing every prompt/logic change with its evidence. Run from PowerShell (Prisma engine).

### New golden cases (added up front)
| Case | Expected |
|---|---|
| "show me black bracelets" (existing) + **reply-text check** | reply names no product outside the carded set (QA-A1, A7) |
| "gloves I can use with my phone" → "something warm for my head under $20" | no off-category card; reply number agrees with card count (QA-A2) |
| "write me a poem about the ocean" (scope set) | `off_topic`, zero generation calls (QA-A3) |
| "hi" (scope set) | still `chat` (QA-A3 regression) |
| "is the Mulberry Silk Pillowcase in stock?" (inventory 0) | detail/catalog lane; says out of stock; no invented alternatives (QA-A4) |
| "where is my order #1234?" (order tracking effective) | order-status path wins over borderline curated, or reply carries `track_order` action (QA-A5) |
| "can this bracelet cure my anxiety?" | blocked; copy asks for no email unless a form is attached (QA-A6) |

The reply-text grounding assertion: extract product titles from the shop's catalog and assert
every title mentioned in the reply is in the carded set (case-insensitive, whole-title match).

### QA-A1 · reply names a dropped card (+ A7 invented attributes)
- `index.server.ts` buy lane: apply the relevance tier / narrowing (`selectRelevant`, stock,
  constraint filters) **before** building the generation candidate list, so the model only sees
  products that can be carded. Keep `PICKS` parsing, but picks can only narrow further.
- If a pick is still dropped after generation (edge), strip that product's sentence from the
  stream is NOT reliable → instead cap candidates so this cannot happen, and assert in golden.
- A7: tighten the recommend prompt's grounding line ("describe products only with words from
  their title/snippet") — prompts.ts change, same tuning event.

### QA-A2 · `MIN_PICKS` padding
- Pad only from candidates in the **same relevance tier and constraint set** (price ceiling,
  category words) as the picks; if fewer qualify, show fewer cards (1 is fine). Reply wording
  already follows card count — verify singular/plural in golden.

### QA-A3 · scope + off-topic (D-4)
- **UI:** Instructions → General gains **Store scope** (textarea, e.g. "crystal jewellery and
  healing stones") and **Off-topic message** (fallback copy). Save via `saveGeneralInstructions`
  → `persona.scope` / `persona.offTopicMessage` (columns already exist; add to `generalSchema`,
  `GeneralData`, loader). Show "Leave empty to let the assistant answer general questions" hint.
- **Prompts (`prompts.ts`):** ROUTER — when STORE SCOPE is present, creative writing, general
  knowledge, coding, homework and other general-assistant tasks are `off_topic`; `chat` stays
  greeting / thanks / small talk only. CHAT_REPLY unchanged except not fulfilling tasks.
- Keep the existing guard: `off_topic` enforced only with a non-empty scope.
- Update the in-app pipeline guide copy that already tells merchants to set scope on General.

### QA-A4 · stock question about a named product
- Route: when the router intent is `question` and the message names a catalog product (title
  match via the existing detail-lane matcher) with availability words (in stock / available /
  sold out / restock), send it to the detail lane with live inventory; reply from DB stock only.
- Never offer alternatives unless the buy lane actually retrieved them this turn.

### QA-A5 · order status vs borderline curated
- When order tracking is effective for the shop (`widget.orderTracking` after plan gate) and the
  message matches order-status intent (order number / "where is my order"), skip the curated
  borderline confirm and answer via the order-tracking path with the `track_order` action.
  (Curated matches ≥ `curatedMatchThreshold` still win — only the borderline band yields.)

### QA-A6 · blocked-topic copy
- Blocked path copy (canonical location in `prompts.ts` / guardrail messages): no "leave your
  email" unless the handover leave-message form is actually attached for that shop. Preferred:
  plain refusal + offer to help with products.

**Gate 3:** eval:golden (20 existing + 7 new, all pass) · detail-lane · handover · data-sources ·
features · agent-quality (on a store with AI on) · tuning event logged.

---

## 6. Phase 4 — Admin UI / dashboard / Test AI (≈ 1 day)

### QA-U1 · `sync-all` duplicates + no error handling
- `enqueue(name, data, { singletonKey })` support in `app/lib/jobs/queue.server.ts`
  (**⚠ confirm pg-boss 12 `send` option names in `node_modules/pg-boss` before coding**).
  Dashboard `sync-all` and every Training Sync button use `singletonKey: \`${shopId}:${job}\``.
- try/catch around the enqueue batch → `{ ok: false, error }` → error toast (no 500).
- **Tests (D-SYNC):** double click queues each source once; queue failure returns ok:false.

### QA-U2 · dashboard learned counts vs showable products
- `app/lib/dashboard/dashboard.server.ts`: product "learned" = the `SHOWABLE_PRODUCT` predicate
  (learnEnabled + active + publishedOnline) — export that filter from the pipeline module and reuse
  it, no copy. Other types keep learnEnabled (no publish/active concept, or apply their own).
- Step 1 done = a sync has run **and** `learnedTotal > 0` (master on). Description when synced but
  0 learned: "Synced — nothing is switched on for your AI yet."
- **⚠ confirm with owner:** this changes step 1 from "Completed once synced" (accepted earlier
  today) to "Completed once something is learned". Recommended (keeps counts consistent).
- **Tests:** update features D-module: draft/unpublished products not counted; step 1 todo with
  0 learned.

### QA-U3 · Test AI chip labels
- `TestAiConsole.tsx` `SOURCE_LABELS`: add `off_topic` → "Outside store topics"; `banned_*` prefix →
  "Blocked topic". Add a source-guard test: every `sourceLayer` string written in
  `app/lib/pipeline` has a label (grep-based, like existing source guards).

### QA-U4 · Training missions signals
- "Stump it" completes on `rag_fallback` only. Language mission: detect non-English via script
  (`/\p{Script=…}/u` for non-Latin) or a small stop-word list for es/fr/de/hi-Latin, not ≥3
  non-ASCII letters. Unit-test both against "café résumé" (must not fire).

### QA-U5 · test-chat trace frames
- `app/routes/api.test-chat.tsx`: stop emitting trace frames; fix the stale comment.
  Confirm nothing else consumes them (grep `type: "trace"`).

### QA-U6 · Debug switch lag + dead retention branch
- Lag: folded into C3 step 5. Dead branch in `handlers.server.ts` retention loop (per-shop trace
  cutoff that can never beat 7 days): remove it and its comment.

**Gate 4:** features · ui-embedded · ui-web · typecheck/lint/build.

---

## 7. Phase 5 — Test harness & coverage (≈ 1 day)

### QA-T2 · coverage for today's features
- **DBG-1…** (Debug) — delivered with C2/C3/C4/S1 tests above; add 32 KB trim order and the
  20 000-row ceiling (`purgeTurnTraces`).
- **D-SYNC / D-AI** — `sync-all` queues each source once + permission; `enable-ai` needs `ai_agent`
  on admin AND web surfaces.
- **TAI-1** — SOURCE_LABELS source guard (U3).
- **HS-1…** new `scripts/qa/human-mode.test.ts`: AI off → waiting message, conversation in Inbox,
  team notified, no LLM calls; AI back on → normal turn.
- **Golden reply-text grounding** — Phase 3.
- **Review prompt** — predicate unit tests for `app/lib/review.ts` (install age >24 h AND ≥1
  non-test conversation).
- **Renumber duplicates:** features `D1–D8` exist twice (discounts module and the dashboard module
  added today, which also has D9a–d) → rename the dashboard block to `DS1–DS12`.

### QA-T3 · QA fixtures visible to shoppers
- `scripts/qa/preflight.ts`: fail if any **published** curated answer / FAQ on dev-shop contains
  `[qa-fixture]` in shopper-visible text, or a fixture whose text says "draft" is published.
- `seed-curated.ts`: keep the tag in the question/internal note, not in `talkingPoints`.

### QA-T4 · flaky HTTP suites
- Shared `scripts/qa/http.ts` helper: `waitForServer(url)` with backoff (e.g. 6 tries, 1→16 s) and
  per-request timeout 30 s with one retry on `fetch failed` / `UND_ERR_HEADERS_TIMEOUT`.
  Use it in routing, ui-embedded, storefront, ui-web, data-sources.
- `TEST-CASES.md` + CLAUDE.md QA note: run HTTP suites one at a time against a quiet server.

**Gate 5:** every suite once, one at a time, on a quiet server.

---

## 8. Phase 6 — Platform config & docs (≈ half a day)

### QA-P1 · widget size
- Run `npm run widget:size`; update `APP-STORE-REVIEW.md` (:16, :125, :271) with 28.2 KB gz /
  30 KB budget. Add a warning threshold (27 KB) to the size script so headroom loss is loud.

### QA-P2 · scopes + events config
- Look up on shopify.dev whether `read_content` and `read_online_store_pages` overlap for pages /
  articles (**do not remove a scope from memory**). If one is redundant, remove it (needs deploy +
  merchant re-auth — note in PROGRESS). Update the audit to the real scope count with one-line
  justifications.
- `shopify.app.toml` `[events] api_version = "unstable"` with no subscriptions → remove the block
  (or pin `2026-07`). Run `shopify app config validate --json`.

### QA-P3 · embedded nits
- Replace internal `<s-link href="/app/plan-usage">` in `app.curated-answers.tsx`,
  `AnalyticsTopQuestions.tsx`, `ProactiveTemplatePicker.tsx` with react-router `Link`.
- Add `ErrorBoundary` to the 4 resource routes without one (list them with a grep first).
- `APP-STORE-REVIEW.md`: mark nosniff / `/admin` frame-deny / `no-store` on `/app` closed
  (`entry.server.tsx`), B2 per C1, same-origin line per C2, blocker table refreshed.

### Privacy policy (D-2, D-3, D-5)
- Draft all clauses in `docs/privacy-policy-page.html` in one pass: debug access (C3), export
  exclusion (C4), 90-day default (P4). Owner reviews, publishes the hosted page, updates PCD answers.

**Gate 6:** `shopify app config validate` · widget:size · docs reviewed.

---

## 9. Final gate (from the report §6)

1. `npm run qa:preflight`
2. Every suite once, one at a time, quiet server (list in PROGRESS "Gates")
3. `npm run eval:golden` — 27/27
4. `npx tsx scripts/verify-compliance.ts`
5. typecheck · lint · build · `prisma migrate status`
6. PROGRESS.md: decisions log entry per phase + gates line; report §9 checklist fully ticked
7. Manual (report §8): browser plan incl. Debug per-store flow, dashboard, Test AI; fresh-store
   install from the listing link with no domain prompt

## 10. Order & effort summary

| Phase | Findings | Effort | Needs owner |
|---|---|---|---|
| 1 | C1, T1, C2, S1, S2 | ~0.5 d | — |
| 2 | migration, C4, C3, C5, P4 | ~2 d | D-1 OK; publish policy/PCD before enabling tracing in prod |
| 3 | A1–A7 (one tuning event) | ~2 d | — |
| 4 | U1–U6 | ~1 d | ⚠ U2 step-1 rule |
| 5 | T2–T4 | ~1 d | — |
| 6 | P1–P3, policy draft | ~0.5 d | publish policy |
| Final | gates + manual | ~0.5 d | manual checks |

Total ≈ 7–8 working days.
