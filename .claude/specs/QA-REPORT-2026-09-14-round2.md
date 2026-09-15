# QA Report — Round 2 (verification of QA-FIX-PLAN + spec 23) — 2026-09-14

> **Status:** awaiting owner review → fixes in a separate session.
> **Scope:** the two specs implemented after round 1 — `QA-FIX-PLAN-2026-09-14.md` (all 6 phases) and `23-pipeline-hardening.md` (items 1.1–4.8).
> **Method:** (1) per-item code review against each spec + owner decisions; (2) two new committed suites for everything not already covered; (3) full one-at-a-time regression of every suite + golden eval. No app code was edited.
> Round 1: `QA-REPORT-2026-09-14.md`. Items marked ✔ were re-checked directly in code.

---

## 1. New test suites (added this round)

| Suite | Cases | Result | Notes |
|---|---|---|---|
| `scripts/qa/pipeline-hardening.test.ts` | 136 (PH-1.1a … PH-4.8d) | **130 pass · 6 fail** | Every spec-23 item. Fake model via the provider seam, stubbed Shopify/fetch, send-only queue, per-case timeouts, throwaway `qa-ph-*` shops cleaned. One live check (PH-3.4d) when `OPENAI_API_KEY` set. |
| `scripts/qa/qa-fixes.test.ts` | 91 (QF-C1-1 … QF-P4-2) | **86 pass · 5 fail** | Gaps not covered by existing DBG/D-SYNC/D-AI/RV/TAI/DS/HS cases. In-memory enqueue stub (never a pg-boss worker); runtime config restored and verified. |

Both are registered in `scripts/qa/TEST-CASES.md` → Suite index. **The 11 failures are real product defects — the assertions are deliberately left red** (see §3). Do not weaken them; fix the code.

---

## 2. Full regression (one at a time, single dev server)

| Area | Result |
|---|---|
| preflight (start / end) | CLEAN / CLEAN |
| migrate status | 39 migrations, up to date |
| typecheck · lint · build | PASS |
| smoke · verify-compliance · admin-check · admin-settings-check | PASS |
| widget:size | PASS — 27.55–27.65 KB gz (budget 30) |
| test-ingest 43 · plan-gates 34 · promo-codes 88 · subscription-webhook 13 · model-portability 88 · availability 96 · handover **202** · logs 71 · install-lifecycle 105 · **features 280** · human-mode 11 · routing 241 · ui-embedded 378 · overage 45 · quota-grants 41 · detail-lane 33 · widget-viewport 32 · tenancy-race 10 · polaris-events 5 · trial · ui-web 225 | **0 failures** |
| pipeline-hardening | 130 / 6 fail — exactly the known defects |
| qa-fixes | 86 / 5 fail — exactly the known defects |
| auth-sessions | 160 / 2 fail — local admin-credential blocker (baseline) |
| ui-admin | 118 / 3 fail — **test drift**, see QA2-T1 |
| data-sources | 52 / 1 fail — **test drift**, see QA2-T2 |
| eval:golden | 24/25 lines — 1 **intermittent** fail, see QA2-A5 |
| storefront | 231 / 1 fail / 1 skip — **incomplete**: dev server hung under load mid-rerun, see QA2-E1 |
| agent-quality | not confirmed this round (jgw-check AI off → "nothing to measure" baseline) |

**Resolved since round 1:** plan-gates crash (QA-T1) · handover §3.5 (the 4 failures a peer saw were the *committed* test file's old expectations; working tree 202/202) · subscription FROZEN/PENDING now drops to free (TEST-CASES A-16 "known defect" is **fixed** — update the doc).

---

## 3. Defects (real — keep the red tests until fixed)

Severity: **Major** = fix before submission · **Minor** = fix when convenient.

### 3.1 Compliance / Debug recording

#### QA2-C1 · Major ✔ — Debug access log is anonymous (`QF-C3-9`)
- **Where:** `app/routes/admin.debug.$shopId.$conversationId.tsx:41` and `admin.debug._index.tsx` log `by: session.admin.email`; `app/lib/log.server.ts:140-146` rewrites every email in values to `"[email-redacted]"` (and `email` is a denied key at `:63`).
- **Impact:** every `turn_trace_viewed` row says `[email-redacted]` — the PCD access log (QA-C3 step 4) cannot say *who* read shopper data.
- **Fix:** log a non-PII admin identifier (`adminId`) under a key the sanitizer allows, or give audit events an explicit allow path that keeps the admin identity. Apply to the toggle/clear audit rows too.
- **Verify:** QF-C3-9 green; row context shows the admin id.

#### QA2-C2 · Major — Access log drops views after 50/hour (`QF-C3-10`)
- **Where:** `app/lib/log.server.ts` per-event rate cap (50 rows/hour/event code).
- **Impact:** the 51st+ view in an hour is not recorded → "every read logged" is false.
- **Fix:** exempt audit events (`turn_trace_viewed`, `turn_trace_list_viewed`, `turn_tracing_toggled`, `turn_traces_cleared`) from the rate cap, or write them to a dedicated audit path.
- **Verify:** QF-C3-10 green (60 views → 60 rows).

#### QA2-C3 · Minor (deploy risk) — `DEPLOYMENT.md` SCOPES out of sync (`QF-P2-5`)
- **Where:** `DEPLOYMENT.md:655` still lists `read_online_store_pages`, omits `read_metaobjects`; `app/shopify.server.ts:17` reads `SCOPES` from env.
- **Impact:** a production `.env` copied from the doc requests the wrong scopes.
- **Fix:** copy the scope string verbatim from `shopify.app.toml`.

### 3.2 AI pipeline (spec 23 + QA-A)

#### QA2-A1 · Major — Inactive knowledge source keeps serving (`PH-1.2j`)
- **Where:** re-ingest sets `status: "pending"` (`app/lib/ingestion/knowledge-ingest.server.ts:70`), failure sets `"error"` (`:154`); retrieval excludes only `inactive` (`app/lib/search/knowledge-search.server.ts:39`).
- **Scenario:** merchant switches a source off → a rebuild/recrawl flips it to pending/error → its old chunks answer shoppers again. The merchant's off switch is overridden.
- **Fix:** keep "serve last good chunks" only for sources the merchant has enabled — track the merchant's enabled state separately from the ingest status (e.g. never overwrite `inactive` with `pending`/`error`, or add an `enabled` flag read by retrieval).
- **Verify:** PH-1.2j green; data-sources "switch removes it" cases still green.

#### QA2-A2 · Major — Order-status shortcut hijacks bulk purchase questions (`QF-A5-2`) ✔
- **Where:** `app/lib/pipeline/index.server.ts:136-137` — the `order\s*#?\s*\d{3,}` alternative of `ORDER_STATUS_RE`.
- **Scenario:** "can I order 100 bracelets?", "order 250 pieces wholesale" → Track-order reply instead of a product/wholesale answer. Lost sales on high-value intents.
- **Fix:** require a status context for the bare-number form (`order\s*#\s*\d{3,}` with `#`, or `order (number|no\.?)\s*\d+`, or pair with status words); add both bulk phrasings as negative golden/QF cases.
- **Tuning event:** yes (routing shortcut) → `eval:golden`.

#### QA2-A3 · Minor–Major — Fallback message never localized on real shops (`PH-3.9f`)
- **Where:** install seeds an English `fallbackMessage` (`app/lib/install.server.ts:19-20`); `index.server.ts:273` prefers the stored message over `canned.server.ts`'s translation.
- **Scenario:** a Spanish shop that never edited the fallback still gets English on every fallback turn — spec 23 §3.9 has no effect for any installed shop.
- **Fix:** treat the seeded default as "unset" (compare to the install default, or stop seeding it) so the canned translation applies; a merchant-edited message still wins.

#### QA2-A4 · Minor — "Leave your email" with no form when AI unavailable (`QF-A6-2`)
- **Where:** `index.server.ts:265` (usage cap reached / AI off in Test AI) — same promise QA-A6 removed from the blocked path; the widget has no form for this outcome.
- **Fix:** same copy rule as QA-A6 — no email promise unless the leave-message form is attached.

#### QA2-A5 · Minor — Typo snapping: "anklet" still snaps to "ankle" (`PH-3.6a`)
- **Where:** `app/lib/search/product-search.server.ts:461` — trigram 0.625 clears the 0.6 floor; the spec's dictionary stoplist was dropped in implementation.
- **Fix:** add the small common-word stoplist (spec 23 §3.6), or skip correction when the query word is itself a valid English word absent from the catalogue.

#### QA2-A6 · Minor — Real typos uncorrected when singular + plural exist (`PH-3.6b`)
- **Scenario:** "lanterm" → lantern 0.600 vs lanterns 0.545 — margin < 0.08, so no correction.
- **Fix:** collapse candidates to a shared stem (lantern/lanterns) before the runner-up margin check.

#### QA2-A7 · Minor — Guardrail blocks alone never escalate to handover (`PH-3.5f`)
- **Where:** `finishBlocked` (`index.server.ts:2031`) never evaluates `detectCannotAnswer`; three consecutive keyword/router blocks don't hand over (a later clarify/fallback turn does — PH-3.5g).
- **Fix:** run the cannot-answer check in `finishBlocked` (spec 23 §3.5 accept line).

#### QA2-A8 · Minor — Key-less ingest records no analytics event (`PH-4.4b`)
- **Where:** `knowledge-ingest.server.ts:93` logs but does not `recordEvent("embedding_skipped", …)`; the source shows `active` with no flag.
- **Fix:** mirror `metafields.server.ts:719-726`.

#### QA2-A9 · Minor — Intermittent golden failure: "the waterproof one?" (golden 3-turn)
- **Evidence:** failed twice in the loaded regression (`outcome=question`, no cards); passed in an isolated trace (buy → Waterproof Rain Jacket). The trace shows `detail_confirm` answering **no** for "the waterproof one?" even though that product was shown — the turn only succeeds because the router re-searches.
- **Fix direction:** make the detail-confirm recognise attribute-referencing follow-ups ("the waterproof one", "the blue one") against shown titles/snippets; then the turn no longer depends on router variance. Tuning event.
- **Verify:** golden 3-turn case green on 3 consecutive runs.

### 3.3 Lower-severity notes (not asserted)

- Curated synonym winner is non-deterministic when several match (`findMany` without `orderBy` → `.find`, `app/lib/search/curated-match.server.ts:58`).
- Typo lexicon still tokenizes with `[^a-z0-9]+` (`product-search.server.ts:374`) — inconsistent with §3.10's unicode tokenizer.
- Saving handover settings without `intentRuleThreshold` resets it to 0.5.
- Ingest writes back the source `metadata` it read at start → can overwrite learn-off tombstones written concurrently by a page sync (§4.6).
- §4.7 usage estimate for aborted streams is not flagged as estimated.
- Training sync buttons toast "Product sync started" even when throttled (dashboard correctly says "already running").
- Phone matching for data requests is exact-string (no normalisation).
- Shop purged after day 7 then reinstalled → settings row gone → retention falls back to "Keep forever", not 90 (D-3 silent on this case — owner decision).
- Stale comments: `index.server.ts:98-100` (trace frame) and the TurnTrace model comment in `prisma/schema.prisma` still describe the removed trace/global switch.
- Plan said golden should have 27 cases; it has 25 with every planned scenario present (miscount). The QA-A2 singular/plural wording check was not added (needs the LLM).

---

## 4. Test drift & environment

#### QA2-T1 · test drift — `ui-admin.test.ts` (3 failures, deterministic)
- `:340`, `:344` still expect "Plan enforcement" / "Enforcement" copy removed intentionally on 2026-09-08 (`app/routes/admin.plans.tsx:280`).
- `:685` `JSON.parse(row.value)` where `readRow()` (`:651`) already returns the raw string → `JSON.parse(undefined)` aborts the rest of section 4 (plan-corruption recovery checks never run).
- **Fix the test**, then re-run — this was mislabelled a "local blocker" in earlier gate lines.

#### QA2-T2 · test drift — `data-sources.test.ts:470-474` (1 failure)
- Asserts a page is NOT answerable while its bridge rebuild is queued. Spec 23 §1.2 intentionally made pending sources keep serving their last good chunks (`knowledge-search.server.ts:39`). Update the expectation to "still answerable from the previous chunks" (and add the inactive-source case once QA2-A1 is fixed).

#### QA2-T3 · doc drift — `TEST-CASES.md` A-16
- FROZEN/PENDING subscription is now handled (subscription-webhook suite passes "FROZEN drops the shop to free"). Mark fixed.

#### QA2-E1 · environment — dev server hangs under a full regression
- The dev server crashed/hung twice during the run (during ui-embedded — self-recovered — and during storefront — did not recover). `storefront` is therefore **unconfirmed**: first pass 231/232 with one SSE timing check (`inter-frame gaps 92/512/512/502ms`, jitter-shaped) before the hang.
- **Action:** restart the dev server, then run `npx tsx scripts/qa/storefront.test.ts` alone. If the server keeps hanging under sustained load, investigate memory/handles in the dev process (Windows libuv teardown assertion also seen once in install-lifecycle).

---

## 5. Fix plan (suggested order)

| # | ID | Severity | Effort | Tuning event? |
|---|---|---|---|---|
| 1 | QA2-C1 audit log identity | Major | XS | no |
| 2 | QA2-C2 audit events bypass rate cap | Major | XS | no |
| 3 | QA2-A1 inactive source keeps serving | Major | S | no |
| 4 | QA2-A2 ORDER_STATUS_RE bulk-order hijack | Major | XS | yes |
| 5 | QA2-A3 fallback localization | Minor–Major | S | no |
| 6 | QA2-A4 AI-unavailable email promise | Minor | XS | no |
| 7 | QA2-A5/A6 typo snapping | Minor | S | yes |
| 8 | QA2-A7 blocks → cannot-answer | Minor | S | no |
| 9 | QA2-A8 embedding_skipped event | Minor | XS | no |
| 10 | QA2-A9 detail-confirm attribute follow-ups | Minor | M | yes |
| 11 | QA2-C3 DEPLOYMENT.md scopes | Minor | XS | no |
| 12 | QA2-T1 / T2 / T3 test + doc drift | — | S | no |
| 13 | §3.3 notes | Minor | S each | — |

**Done when:** `pipeline-hardening` 136/136 · `qa-fixes` 91/91 · ui-admin + data-sources green · storefront confirmed on a fresh server · `eval:golden` all green on 3 consecutive runs · full regression one at a time · PROGRESS.md gates line + decisions log updated.

## 6. Checklist

- [ ] QA2-C1 · [ ] QA2-C2 · [ ] QA2-C3
- [ ] QA2-A1 · [ ] QA2-A2 · [ ] QA2-A3 · [ ] QA2-A4 · [ ] QA2-A5 · [ ] QA2-A6 · [ ] QA2-A7 · [ ] QA2-A8 · [ ] QA2-A9
- [ ] QA2-T1 · [ ] QA2-T2 · [ ] QA2-T3 · [ ] QA2-E1 (storefront re-run)
