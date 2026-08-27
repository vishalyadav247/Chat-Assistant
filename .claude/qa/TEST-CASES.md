# ChatConvert — Pre-Submission Test Cases

> Written 2026-08-21 for the manual-QA pass that gates production deploy + App Store submission.
> Execution results live in `.claude/qa/test-matrix.xlsx` (regenerate with
> `npx tsx scripts/qa/make-test-matrix.ts`). Defects are logged in the PROGRESS.md decisions log.
>
> **Scenario legend** — every case is run in as many of these as apply:
> `H` happy path · `B` boundary/limit · `A` adversarial (forged input, replay, injection) ·
> `T` tenancy (shop A must never see or mutate shop B) · `P` plan-gated (all four tiers) ·
> `S` surface (embedded admin vs standalone web)
>
> **Precondition P0 (applies to every case unless overridden):** dev Postgres up and migrated;
> `npx prisma db seed` run; `scripts/qa/seed-curated.ts` run; `OPENAI_API_KEY` set;
> shop = `dev-shop.myshopify.com`.

---

## A. Billing — plan activation & change (spec 15)

| ID | Case | Steps | Expected | Scenarios |
|---|---|---|---|---|
| A-01 | Subscribe to each paid tier, monthly | For basic/pro/plus: `intent=subscribe`, interval=monthly → approve → callback | `Shop.plan`, `planStatus=trial`, `subscriptionId`, `billingInterval=monthly`, `trialEndsAt=+7d`, `usageLineItemId` all set; one `plan_changed` event | H, P |
| A-02 | Subscribe to each paid tier, yearly | Same with interval=yearly | `billingInterval=yearly`; **no usage line item** (Shopify rejects usage lines on ANNUAL); price = `priceYearlyPerMonth × 12` | H, B |
| A-03 | Yearly hard-caps at quota | Yearly Basic shop exceeds `conversations` quota | AI stops at cap — no overage billed, because there is no usage line. Merchant-facing copy must not promise overage | B |
| A-04 | Upgrade | basic → pro | New subscription created; Shopify cancels + prorates the old one; plan updates; old subscription id replaced | H |
| A-05 | Downgrade paid → paid | plus → basic | Same as A-04; over-quota data **kept**, new creates blocked, banner shown. No deletions | H, B |
| A-06 | Downgrade to Free | `intent=subscribe` plan=free | `appSubscriptionCancel` called; all subscription fields reset; data kept | H |
| A-07 | Cancel failure is fail-safe | Force `cancelSubscription` to error | Returns `{ok:false}`; the Shop row is **not** modified | A |
| A-08 | Trial → active transition | Set `trialEndsAt` in the past | `planStatus` becomes `active`. *(Fixed D-08: `transitionExpiredTrials()` nightly sweep)* | B |
| A-09 | Callback idempotency | Replay the same return URL | No duplicate `plan_changed` event; the 6-field `unchanged` check short-circuits | A |
| A-10 | Callback charge_id mismatch | Return URL with a foreign `charge_id` | Rejected + `billing_return_charge_mismatch` warning logged | A |
| A-11 | Plan escalation via `?plan=` | Return URL claiming `plan=plus` for a basic subscription | Plan derived from the **verified subscription name**, never the query param. Claimed≠verified logs a warning and proceeds with verified | A |
| A-12 | Unknown subscription name | Subscription named outside the matrix | Rejected; never falls back to the current plan | A |
| A-13 | `app_subscriptions/update` ACTIVE | Webhook for the current subscription | Plan/interval/trial/usage-line backfilled; `plan_changed` only when something changed | H |
| A-14 | Stale/out-of-order ACTIVE webhook | Webhook id ≠ live subscription id | Ignored + `app_subscription_stale_active_ignored` logged. A paying shop is never downgraded | A |
| A-15 | CANCELLED/EXPIRED/DECLINED | Webhook for a **replaced** subscription | Ignored unless `shop.subscriptionId === subscriptionId` (a plan switch cancels the replaced sub) | A |
| A-16 | FROZEN / PENDING status | Webhook with those statuses | **Known defect: ignored, so an unpaid frozen subscription keeps the paid plan** | A |
| A-17 | Overage reporting | Exceed quota on a monthly paid plan | `PlanUsage.overageCount++`; `appUsageRecordCreate` at `overageRate(plan)`; errors logged, never thrown into chat | H, B |
| A-18 | Conversation metering | One shopper session, many turns | Exactly one tick; `SESSION_INACTIVITY_MS`=30min creates a new billable session; `isTest` never ticks | H, B |
| A-19 | Billing on the web surface | `intent=subscribe` from `/web` | 403 — `billing_manage` is admin-surface only for every role; a deep link to the admin is offered | S, A |
| A-20 | Reinstall inside grace window | Uninstall then reinstall | Plan reset to free; a dead subscription is never resumed | B |

### A-T. Free-trial entitlement (spec 15 · D-23)

The trial is granted **once per shop** — not once per subscription and not once
per install. Shopify grants whatever `trialDays` the app asks for, and its
documented 180-day proration covers Shopify App Pricing only, not the Billing
API this app uses. Suite: `scripts/qa/trial.test.ts` (33 checks).

| ID | Case | Steps | Expected | Scenarios |
|---|---|---|---|---|
| A-T1 | First subscription, every paid tier | Subscribe basic / **pro** / plus | Full 7 days; `trialStartedAt` + `trialDeadlineAt` stamped. *(Pro was previously never driven end-to-end)* | H |
| A-T2 | Free tier grants nothing | `trialAllowanceFor("free")` | 0 days; `trialDays` omitted from the mutation | B |
| A-T3 | Upgrade mid-trial | Basic day 3 → Pro | 4 days granted; **same deadline**; trial does not restart | H, A |
| A-T4 | Upgrade minutes after subscribing | Basic → Pro at +10 min | Full 7 days — a legitimate switch costs the merchant nothing | H |
| A-T5 | Plan-switch farming | 200 switches over one 7-day window | Deadline never moves; entitlement cannot be extended | A |
| A-T6 | Downgrade to Free → resubscribe | plan=free then subscribe again | Ledger survives the downgrade; no new trial | A |
| A-T7 | Uninstall → reinstall → subscribe | Uninstall reset, then subscribe | `trialDays=0`; `planStatus=active` immediately, no trial | A |
| A-T8 | Rolling window | Entitlement spent >180 days ago | Forgiven — full 7 days again (matches Shopify's managed-pricing rule) | B |
| A-T9 | Window boundary | Spent 179 days ago | Still 0 days | B |
| A-T10 | Operator raises `trialDays` | 7 → 10 while a shop is on day 3 | 7 more days (10 total − 3 used), not a second full trial | B |
| A-T11 | Operator lowers `trialDays` | 7 → 3 while a shop is on day 3 | A running trial is never shortened | B |
| A-T12 | Replayed confirmation | Same callback / redelivered webhook twice | Ledger identical; deadline never creeps outward | A |
| A-T13 | Closed-tab subscribe | Callback skipped; `app_subscriptions/update` is the only writer | Webhook stamps the ledger too — the trial is still banked | A |
| A-T14 | GDPR shop/redact + cleanupShop | Purge a shop | Ledger survives on purpose: shop-level abuse record, not customer PII | A |
| A-T15 | Reset-path source guard | Scan the 5 files that cancel a subscription | None may write `trialStartedAt` / `trialDeadlineAt` outside a `trialLedgerAfterGrant()` result | A |
| A-T16 | Plan-card copy | Shop with a part-used entitlement | Cards advertise the days actually remaining; 0 days → no trial promised (App Store req 1.1.4) | S |

## B. Plan feature propagation & gating (specs 15/19)

| ID | Case | Steps | Expected | Scenarios |
|---|---|---|---|---|
| B-01 | Matrix matches the spreadsheet | Compare `DEFAULT_PLANS` to `plan-allocation.xlsx` | Every price, trial, overage, quota and feature matches exactly | H |
| B-02 | Operator edits a quota | `/platform/plans` → change `curated_answers` for Pro → save | `getQuota("pro","curated_answers")` returns the new value immediately in-process, and within `REFRESH_TTL_MS` (30s) in any other process | H |
| B-03 | Propagation is app-wide | After B-02, check **every** installed shop on that tier | All shops on that plan see the new value — plans are global, only `Shop.plan` is per-shop | H, T |
| B-04 | Operator toggles a feature | Uncheck `exports` for Plus → save | `hasFeature("plus","exports")` false; the export action returns a plan-gate error | H, P |
| B-05 | Enforcement switch | Flip `open` ⇄ `enforced` | `open`: every gate passes, every quota `UNLIMITED`. `enforced`: real matrix values | H |
| B-06 | Reset to defaults | "Reset all plans" | Row deleted; `PLANS` deep-equals `DEFAULT_PLANS` | H |
| B-07 | Corrupt override row | Write invalid JSON to `platform:plans`, then save one plan | **Known defect: `getStoredPlanConfig()` returns `{}` on parse failure, so the save drops every other plan's overrides** | A |
| B-08 | Unknown feature name in a stored override | Override lists a since-removed feature | Tolerated on read and filtered against `GATED_FEATURES` — the whole config must not be invalidated | A |
| B-09 | Unknown `Shop.plan` value | Set `plan="enterprise"` | All four accessors silently fall back to Free. Verify that is intentional and safe | A |
| B-10 | Every quota gate bites | For each of the 11 dimensions, at each tier, create up to the limit then one more | The Nth+1 create is refused with a merchant-readable message and an upgrade path | B, P |
| B-11 | Every feature gate bites | For each of the 13 features, at each tier | Gated features refused server-side, not merely hidden in the UI | A, P |
| B-12 | Downgrade keeps over-quota data | Create 50 curated answers on Plus → downgrade to Free (quota 5) | All 50 rows survive; new creates blocked; banner explains. **No deletions** | B |
| B-13 | Never-gated surfaces | On Free: inbox, human handover, GDPR flows, Test AI console | All fully functional — these must never be gated | P |
| B-14 | Same LLM on every tier | Compare model used on free vs plus | Identical — plans differ on volume and tooling only | P |
| B-15 | New seams enforce | `active_campaigns`, `analytics_range_days`, `survey`, `push_notifications`, `custom_recommendations`, `multi_language` | Each blocked at the right tier, server-side | B, P |
| B-16 | Price change doesn't re-price existing subs | Change Pro price → check an existing Pro subscriber | Shopify keeps the agreed charge; only new subscriptions get the new price. UI copy must say so | B |

## C. Promo / coupon codes (spec 15)

| ID | Case | Expected | Scenarios |
|---|---|---|---|
| C-01 | Valid percent code on an eligible plan+interval | Discount applied to the recurring line; `PromoRedemption` pending → redeemed on callback | H |
| C-02 | Valid fixed code | `amount` discount applied | H |
| C-03 | Fixed discount ≥ interval price | Refused — Shopify rejects a $0 subscription. Error copy must say "discount too large", not "wrong plan" | B |
| C-04 | Expired code | Refused. `expiresAt` is end-of-day **UTC** — verify and document | B |
| C-05 | `maxRedemptions` exhausted | Refused | B |
| C-06 | `maxRedemptions` race | Two shops redeem the last slot concurrently → must not both succeed | A |
| C-07 | Inactive (toggled off) code | Refused | H |
| C-08 | Wrong plan / wrong interval | Refused with a specific scope message | B |
| C-09 | Same shop redeems twice | Refused | A |
| C-10 | Casing + internal whitespace | `" save20 "` and `"SAVE 20"` normalise to `SAVE20` | B |
| C-11 | Duration-limited vs forever | `durationLimitInIntervals` set vs omitted entirely | H |
| C-12 | Promo survives a plan change | Upgrade while a "forever" code is active → discount must not silently vanish | B |
| C-13 | Approved but callback skipped | Merchant approves then closes the tab → redemption must still be confirmed (webhook path) | A |
| C-14 | Abandoned pending redemptions | Garbage-collected, not left forever | B |
| C-15 | Delete a code with redemptions | Refused server-side (deactivate instead); billing history preserved | A |
| C-16 | Tenancy | Shop A cannot see, consume or confirm shop B's redemption | T |
| C-17 | Code enumeration | `validate_code` is rate-limited | A |
| C-18 | Percent rounding | 33.335% → representable value; validated | B |

## D. AI pipeline & model portability (spec 03)

| ID | Case | Expected | Scenarios |
|---|---|---|---|
| D-01 | Golden set | `npm run eval:golden` passes 16/16 | H |
| D-02 | gpt-4 family params unchanged | `samplingParams` returns exactly `{temperature, max_tokens}` for gpt-4o-mini/4o/4.1/4.1-mini/4.1-nano — byte-identical guarantee | B |
| D-03 | Reasoning models | o1/o3-mini/o4-mini/gpt-5* → `max_completion_tokens`, no temperature/max_tokens | B |
| D-04 | Switch chat model at runtime | Change `CHAT_MODEL` or the `/platform/ai` override → effective within the 30s cache, no code change, no redeploy | H |
| D-05 | Platform temp/token override must not de-tune the router | Set temperature 1.2 globally → the router's strict-JSON call must keep its own tuning | A |
| D-06 | jsonObject + reasoning model | Router budget must not be consumed entirely by hidden reasoning tokens leaving empty content | B |
| D-07 | Unpriced custom model | Free-text model at `/platform/ai` → warned, and `/platform/usage` doesn't silently show $0 | B |
| D-08 | Embedding model change | Different-dimension model must fail **loudly** at `toSqlVector`, never corrupt data; a re-embed path must exist for all four vector columns | A |
| D-09 | Chat 429 backoff | A rate-limited chat call retries rather than surfacing instantly to the shopper | A |
| D-10 | Router-first grounding | Every reply is grounded; no hallucinated products | H |
| D-11 | Curated match thresholds | 0.80 match / 0.65 borderline behave correctly with the near-miss fixture pairs | B |
| D-12 | Banned topics | Configured banned topics are refused with the fallback message | A |
| D-13 | Test AI console never meters | `isTest` conversations excluded from usage, analytics, inbox and the unresolved queue | B |

## E. Knowledge ingestion (spec 04)

| ID | Case | Expected | Scenarios |
|---|---|---|---|
| E-01 | All five source types | URL crawl, manual Q&A, CSV, file, Shopify pages ingest and become retrievable | H |
| E-02 | Chunking | ~1500 chars with 150 overlap, deterministic | B |
| E-03 | SSRF rejection | Internal IPs, localhost, non-http schemes, redirects to internal hosts all refused | A |
| E-04 | Quotas | `manual_qas`, `policy_pages`, `crawl_pages`, `file_uploads` enforced per tier | B, P |
| E-05 | Unsupported file type | Errors cleanly (PDF/DOCX parsing is deferred by design) | B |
| E-06 | Delete cascade | Deleting a source removes its knowledge rows and makes content unretrievable | H |
| E-07 | Re-sync / weekly recrawl | Idempotent; no duplicate chunks | B |
| E-08 | Failed ingest | Reports `pagesUsed: 0` and does not consume quota | A |

## F. Storefront widget (spec 05)

| ID | Case | Expected | Scenarios |
|---|---|---|---|
| F-01 | Launcher variants | icon / label / icon_label × 4 positions × custom colours all render | H |
| F-02 | Streaming reply | SSE frames arrive incrementally, not buffered | H |
| F-03 | Stream truncated | Body ends without a terminal frame → widget recovers, never hangs | A |
| F-04 | Stream stalled | 45s idle watchdog fires | A |
| F-05 | Product cards + one-click ATC | Real `variantId` add; cart drawer/bubble re-render; fallback to the product page if the theme rejects AJAX | H |
| F-06 | Pre-chat form | guest / anonymous / both modes; required fields; marketing opt-in; sanitized disclaimer | H, B |
| F-07 | FAQ screen | Featured FAQs render; server-side search covers **all** published FAQs, not just featured | H |
| F-08 | Order tracking | order# + email/phone; tracking number; default/custom/integration modes | H |
| F-09 | Order-track brute force | Throttled 8/min per shop+IP; ≥4-char order suffix; ≥10-digit phone; never echoes the order's own PII | A |
| F-10 | Survey | Stars/emoji; triggers on resolve and on keywords; once per conversation | H |
| F-11 | Persistence | Thread survives navigation via `/history`; no duplicate rendering against the poll cursor | H |
| F-12 | Blocked visitor | Composer locked, polling stopped, AI silent, thread not re-flagged unread | A |
| F-13 | Proactive campaigns | Page-type/path/delay/exit-intent/cart triggers; one per page view, once per session; suppressed while the panel is open | H, B |
| F-14 | Campaign CTA safety | `link` action accepts only relative or http(s) — never `javascript:`/`data:` | A |
| F-15 | Uninstalled shop | Widget renders nothing | A |
| F-16 | Size budget | `chat-widget.js` ≤ 30KB gzipped | B |
| F-17 | Branding | "Powered by" hidden only when `remove_branding` is granted, decided server-side | P, A |

## G. Human handover (spec 10)

| ID | Case | Expected | Scenarios |
|---|---|---|---|
| G-01 | Explicit ask | "talk to a human" triggers handover; always on | H |
| G-02 | Negative sentiment | Caps ratio, `!!!`, negative emoji — only when opted in | B |
| G-03 | Repeated question | Fires at the configured threshold. **Spec says embedding similarity; code uses exact normalized text — reconcile** | B |
| G-04 | Intent rule | Cosine ≥ 0.5 against configured topics | B |
| G-05 | Cannot-answer escalation | N consecutive fallback replies escalate | B |
| G-06 | Destination `inbox`, online | `afterHandoverMessage`; thread flagged; merchant notified | H |
| G-07 | Destination `inbox`, offline + leave_message | Form shown; notification deferred to form submit | H |
| G-08 | Destination `collect_email` | Form always; AI stays awake | H |
| G-09 | Destination `contact_methods` | Message **plus contact chips** per spec step 4 | H |
| G-10 | `aiWhileWaiting` | never → dormant; outside_hours → dormant only when humans are available; always → never dormant | B |
| G-11 | Merchant reply reaches the shopper | Reply via inbox → delivered by `/messages` polling → "Seen" when read | H, S |
| G-12 | Reply while not in human mode | Take-over or post-resolve replies still reach the shopper | A |
| G-13 | Reply to a blocked visitor | Refused | A |
| G-14 | Resolve | `status=resolved`, `mode=ai`, `unread=false`, sys message, survey trigger | H |
| G-15 | Reopen | AI must wake up — `mode` must not stay `human` | A |
| G-16 | Auto-resolve inactive | Honours the configured interval; batched | B |
| G-17 | Notification delivery | Email for handover to opted-in members; push per prefs; assignee-only when assigned; owner row bootstrapped even if never opened | H |
| G-18 | Handover email contains no transcript | PII minimisation — deliberate | A |
| G-19 | Conversation ownership | Every widget-side lookup binds `conversationId` **and** `sessionId` | A, T |

## H. Chat availability (spec 16)

| ID | Case | Expected | Scenarios |
|---|---|---|---|
| H-01 | `mode: always` | Always online; `{{schedule}}` resolves to null → "soon" | H |
| H-02 | Working hours | Online inside, offline outside, in the **shop's** timezone | H, B |
| H-03 | Overnight range | 22:00–06:00 wraps correctly, including the previous weekday | B |
| H-04 | `start === end` | 09:00–09:00 reads as closed, not 24h — confirm intentional | B |
| H-05 | Breaks | Apply only inside working hours | B |
| H-06 | Holidays | Inclusive local date range; malformed dates must be rejected at save, not silently ignored | A |
| H-07 | `onlineStatusMode` — all three | `working_hours`, `working_hours_or_agent`, `agent_during_hours` must each behave distinctly. **Known defect: `agentOnline` is never passed, so two of three are dead** | A |
| H-08 | DST boundary | Correct on both sides of a DST change in `America/New_York` | B |
| H-09 | Widget offline copy | Offline welcome message replaces the normal one when enabled | H |
| H-10 | Status staleness | Widget status must not contradict the handover branch (config cached up to ~10 min) | A |
| H-11 | Message merge fields | `{{schedule}}` renders "9 AM" / "tomorrow 9 AM" / "Monday 9 AM" | B |

## I. Inbox & contacts (specs 10/11)

| ID | Case | Expected | Scenarios |
|---|---|---|---|
| I-01 | Filters + live counts | open/resolved/unread/handover/starred/assigned all correct | H |
| I-02 | Unread badge excludes test chats | `isTest` conversations never counted | A |
| I-03 | SSE inbox feed | Updates within the 3s tick; reconnects after the 10-min cap; falls back to polling | H, S |
| I-04 | Actions | send, resolve, reopen, star, read, block, delete, assign | H |
| I-05 | Delete conversation | Removes messages **and** the unresolved-question row | B |
| I-06 | Contact classification | Re-evaluated on events; lead ↔ anonymous transitions correct | B |
| I-07 | Contact CSV export | Formula-injection safe (`=`,`+`,`-`,`@` prefixed); plan-gated | A, P |
| I-08 | Duplicate email | Case-insensitive duplicate rejected | B |
| I-09 | Cross-session contact hijack | `proxy.prechat` binds writes to the caller's own `sessionId` | A, T |

## J. Routing — all three surfaces

| ID | Case | Expected | Scenarios |
|---|---|---|---|
| J-01 | Embedded admin (21 routes) | Each resolves, authenticates first, exports `boundary.error`/`boundary.headers` where it has a loader/action | H, A |
| J-02 | Web (8 routes) | Each resolves; signed-out lands on `/web/login`; signed-in `/web` → `/app/inbox` | H, A |
| J-03 | Platform (12 routes) | Each resolves; unauthenticated → `/platform/login`; never embedded (`frame-ancestors 'none'`) | H, A |
| J-04 | Proxy (11 routes) | Reject requests without a valid Shopify proxy signature | A |
| J-05 | Webhooks (8 routes) | Invalid HMAC → 401 before any handler code; valid → 200 within 5s; enqueue-only | A |
| J-06 | Deep links survive auth | `/app/inbox?c=<id>`, `/app/settings?tab=...` preserved across the bounce | H |
| J-07 | Wrong HTTP method | Resource routes reject cleanly, no 500 | A |
| J-08 | Logout is POST-only | GET must not log out (CSRF) — both web and platform | A |
| J-09 | Nav integrity | Every `NAV` entry resolves; role filtering matches `can()` | H, S |
| J-10 | No shop-domain login form | App Store req 2.3.1 — `_index` must never ask for `.myshopify.com` | A |
| J-11 | Embedded navigation | `Link`/`useSubmit`/`authenticate.admin`'s `redirect` — never raw `<a>` or react-router `redirect` | A |

## K. Sessions, auth, authorization & cookies (spec 18/19)

| ID | Case | Expected | Scenarios |
|---|---|---|---|
| K-01 | Shopify session storage | Row written on OAuth; deleted on uninstall | H |
| K-02 | TeamSession TTL | 30-day sliding, renewed at most once/day; expired rejected | B |
| K-03 | Stale session cleanup | Expired `team_sessions` / `platform_sessions` are actually pruned, not accumulated | B |
| K-04 | PlatformSession TTL | 7-day sliding; `reset-password` revokes all | B |
| K-05 | Role matrix | agent → inbox+contacts only; admin → all but billing; billing_manage → admin surface only. Enforced by **direct URL**, not just nav | A, S |
| K-06 | Cross-tenant | A member of shop A cannot read or mutate shop B through any route | A, T |
| K-07 | Login anti-enumeration | Constant generic error + dummy hash burn for unknown/locked accounts | A |
| K-08 | Lockout | 5 failures → 15-min lock; correct password during lock still refused; counters reset after expiry | B, A |
| K-09 | Open redirect | `next=https://evil.com`, `//evil.com`, `/\evil.com` all refused | A |
| K-10 | Token single-use | invite (7d), reset (1h), handoff (2min) — replay must fail | A |
| K-11 | Password reset revokes other sessions | Only the resetting session survives | A |
| K-12 | Disable member | Sessions revoked + push subscriptions deleted | A |
| K-13 | Cookie flags | `cc_web_session` HttpOnly+Secure+SameSite=Lax+Max-Age; `cc_surface` deliberately not HttpOnly; platform cookie likewise | A |
| K-14 | Logout clears cookie | `Max-Age=0` | H |
| K-15 | Iframe isolation | `SameSite=Lax` keeps the web cookie out of the admin iframe | A |
| K-16 | CSRF | `sameOrigin` enforced on every platform + web mutation | A |

## L. Database efficiency

| ID | Case | Expected | Scenarios |
|---|---|---|---|
| L-01 | Volume baseline | Test at ~20k conversations / 200k messages, not the seed's 358/1129 | B |
| L-02 | Inbox list | Index scan for every filter+sort combination; no seq scan at volume | B |
| L-03 | Analytics queries | Rollup, series, donut, CSAT, funnel, top questions, exports all indexed | B |
| L-04 | Vector search | HNSW indexes actually used; not bypassed by a filter | B |
| L-05 | Contacts + dashboard | Indexed; bounded | B |
| L-06 | N+1 | No per-row query inside a loop on a request path | B |
| L-07 | Index coverage | Existing indexes match the real filter/sort combinations | B |
| L-08 | Restore | Synthetic volume fully removed afterwards | H |

## M. Caching

| ID | Case | Expected | Scenarios |
|---|---|---|---|
| M-01 | Plan matrix cache | 30s TTL; immediate in-process after a save | H |
| M-02 | Shop config cache | 60s TTL; `invalidateShopConfig` called on **every** write path that changes cached data | A |
| M-03 | Platform settings / runtime config | 30s TTL; dashboard beats env; secrets never returned to the browser | A |
| M-04 | Search lexicon | 10min TTL | B |
| M-05 | Per-shop keying | No cross-tenant leak through any cache | T |
| M-06 | Memory bounds | Every cache has an eviction policy — no unbounded growth | B |
| M-07 | Widget config cache | `max-age=300` + 5min sessionStorage must not contradict live server state | A |

## N. Install / uninstall lifecycle

| ID | Case | Expected | Scenarios |
|---|---|---|---|
| N-01 | Fresh install | Shop row, default persona/guardrails/widget/handover config, initial sync enqueued, session stored | H |
| N-02 | Complete default state | Every admin page loads for a brand-new shop with no missing-row 500s | A |
| N-03 | Reinstall | `uninstalledAt` cleared; plan reset; no dead subscription resumed | B |
| N-04 | Uninstall webhook | Sessions deleted, `uninstalledAt` stamped, plan reset, enqueue-only, <5s | H, B |
| N-05 | `scopes_update` | Stored scopes updated | H |
| N-06 | Data purge | `cleanupShop` zeroes **every** table in the schema | A |
| N-07 | Widget after uninstall | Renders nothing | A |

## O. Compliance & App Store review (spec 17)

| ID | Case | Expected | Scenarios |
|---|---|---|---|
| O-01 | Three mandatory webhooks | Declared, HMAC-verified (401 before handler), <5s, real workflows | A |
| O-02 | `customers/redact` scoping | Redacts only the named customer — never every DataRequest when email is absent | A, T |
| O-03 | `customers/data_request` | Export contains only that customer's data; pending→ready→completed | A, T |
| O-04 | `shop/redact` | Full tenant purge | A |
| O-05 | Retention purge | Honours the configured window; purges logs for uninstalled shops | B |
| O-06 | Redelivery dedupe | Repeated webhook delivery is idempotent | A |
| O-07 | Billing compliance | All charges via the Shopify Billing API; no alternative payment path | A |
| O-08 | No pre-auth UI | OAuth completes before anything renders | A |
| O-09 | Security headers | Non-embedded surfaces set `frame-ancestors 'none'`, `X-Frame-Options`, `no-store`, `Referrer-Policy` | A |
| O-10 | Performance | Widget ≤30KB gz; no Lighthouse regression >10 pts *(manual)* | B |
| O-11 | PII minimisation | Logs redact PII; no transcript in emails; order tracking never echoes order PII | A |
| O-12 | Privacy policy | Names OpenAI and Resend as processors *(manual, pre-submission)* | — |

## P. Platform admin & observability (specs 19/21)

| ID | Case | Expected | Scenarios |
|---|---|---|---|
| P-01 | Operator auth | DB-backed accounts; lockout parity with team members; never embedded | A |
| P-02 | Cross-tenant overview | Aggregates correct; shop drill-down scoped | H |
| P-03 | Admin management | Cannot remove yourself or the last admin (atomically) | A |
| P-04 | AI settings | Model/temperature/max-tokens overrides save, clear, and take effect | H |
| P-05 | Runtime settings | Dashboard beats env; secrets encrypted at rest; partial saves don't wipe; reset restores env | A |
| P-06 | Usage reporting | Per-shop token consumption + cost; streamed calls counted exactly once | B |
| P-07 | Logs — levels | `error` and `warn` only, by design. **Confirm the 1-row table is correct, not a wiring gap** | B |
| P-08 | Logs — attribution | `shopId` or `shopDomain`-resolved | H |
| P-09 | Logs — redaction | PII/credential denylist enforced; oversized context truncated | A |
| P-10 | Logs — rate cap | 50/event/hour + one `log_rate_capped`. Per-process — document the multi-instance implication | B |
| P-11 | Logs — retention | 14-day purge; uninstalled shops' rows dropped | B |
| P-12 | Logs — read layer | Filters, bounded scan, "(removed store)", 302 when unauthenticated | H, A |

## Q. Remaining admin modules

| ID | Case | Expected | Scenarios |
|---|---|---|---|
| Q-01 | Dashboard & onboarding (13) | KPIs correct; 6-step checklist reflects real completion; live feed updates | H |
| Q-02 | Catalog sync (02) | Products/collections/discounts mirrored; webhooks enqueue-only; daily reconcile **prunes deleted items**; product cap per plan | H, B, P |
| Q-03 | Chatbox settings (06) | All three tabs save; live preview has storefront parity | H |
| Q-04 | AI training (07) | All five tabs; metafield opt-in quota; unresolved-question queue → FAQ/Q&A/curated prefill | H, P |
| Q-05 | AI instructions (08) | Persona, guardrails, recommendation rules, handover config all persist and take effect | H |
| Q-06 | Curated answers (09) | CRUD; quota; draft never served; published-without-embedding never matches; HTML stripped from talking points | H, B, P |
| Q-07 | Analytics (14) | Series/donut/CSAT/funnel/top questions; test chats excluded; rollup idempotent; range gated by plan; exports gated | H, B, P |
| Q-08 | Settings (16) | General, chatbox, privacy tabs; store info; auto-resolve; team; order tracking; retention | H |
| Q-09 | Proactive campaigns (12) | Dashboard, templates, editor, metrics; revenue recomputed server-side (client beacon ignored); active-campaign quota | H, A, P |
| Q-10 | Mobile responsive (20) | Every `/app` page usable at ~390px on both surfaces; desktop pixel-identical *(manual visual)* | S |
| Q-11 | Unsaved-changes guard | SaveBar blocks navigation on both surfaces | H, S |
| Q-12 | FAQ CSV import | Header row detected exactly; duplicates deduped; skipped rows reported | B |

---

## Execution notes

- Areas A–P map to the automated scripts in `scripts/qa/` plus the pre-existing suites in
  `scripts/`. Anything marked *(manual)* needs a human dev-store or browser session and is
  listed as pending in the matrix rather than passed.
- A case that exposes a defect is recorded as **FAIL**, the defect is fixed, and the case is
  re-run; the matrix records the final state and the defect id.

---

# Round 2 — surface-by-surface execution (2026-08-26)

Round 1 (areas A–Q) proved the *logic*. Round 2 proves that each of the four surfaces actually
**renders and behaves** — the gap Round 1 left open, because `routing.test.ts` only asserted that
route files exist, never that their loaders run or their pages paint.

## R. Embedded admin — every page executes (`scripts/qa/ui-embedded.test.ts`)

| ID | Case | Expected | Scenarios |
|---|---|---|---|
| R-01 | Every `/app/*` loader runs | Resolves without throwing, for all 16 pages | H |
| R-02 | Loader payload matches what the component destructures | No missing key (a missing key is a render crash, not a warning) | H |
| R-03 | Every loader query is shop-scoped | `shopId` present on every query in the loader body | T |
| R-04 | Renders on `free` **and** on `plus` with enforcement ON | Gates degrade; no page throws | P |
| R-05 | Empty-data shop | No page throws with zero conversations/products/knowledge | B |
| R-06 | Every action: valid input | Succeeds and persists | H |
| R-07 | Every action: missing/invalid input | Rejected with a useful message; nothing persisted | B |
| R-08 | Every action: foreign `shopId` in the payload | Never mutates the other shop | T, A |
| R-09 | `boundary.headers` / error boundary exported where required | Present on every nested route with a loader/action | H |
| R-10 | Embedded-app rules | No raw anchor tags for internal nav, no `react-router` `redirect`, submits via `useSubmit` | H |
| R-11 | Every `<s-*>` component exists | An invented element renders as nothing — silent blank UI | H |
| R-12 | Labels / accessible names | Every input labelled; every button named | H |

## S. Standalone web app — render + roles (`scripts/qa/ui-web.test.ts`)

| ID | Case | Expected | Scenarios |
|---|---|---|---|
| S-01 | Every `/web/*` page renders | 200 **and** real content — not an error boundary, not a blank main | H |
| S-02 | Promised controls present | Composer, reply, assign, filters actually in the HTML | H |
| S-03 | Nav per role | Shows exactly the permitted entries | H |
| S-04 | Direct request to a forbidden page | Refused **server-side**, not merely hidden in nav | A |
| S-05 | Forbidden action per role | Refused server-side with the right status | A |
| S-06 | Login | Right password gives session + cookie; wrong gives a generic error + lockout counter | H, A |
| S-07 | Lockout | Actually blocks at the threshold | B, A |
| S-08 | Forgot / reset | Single-use, expiring, wrong-shop rejected, kills existing sessions | B, A, T |
| S-09 | Invite | Correct role; reuse, expiry and foreign-shop tokens all rejected | B, A, T |
| S-10 | `/web/handoff` | Signs in the right member of the right shop; replay/expired/foreign rejected | A, T |
| S-11 | CSRF | Foreign Origin/Referer refused on login, logout, forgot, reset | A |
| S-12 | Multi-shop member | Shop picker; no id tampering can reach the other shop | T, A |

## T. Platform console — every form takes effect (`scripts/qa/ui-platform.test.ts`)

| ID | Case | Expected | Scenarios |
|---|---|---|---|
| T-01 | Every page renders with real cross-tenant data | Tables/forms present; no error boundary | H |
| T-02 | Every form: valid POST | Persists, survives a fresh GET, visible in the DB | H |
| T-03 | Every form: change takes effect in app behaviour | e.g. a plan edit moves `getQuota`/`hasFeature` inside the 30s TTL | H |
| T-04 | Every form: invalid POST | Rejected; nothing persisted | B, A |
| T-05 | Plans — `knownFeatures` | A feature added later is **not** silently gated off | B |
| T-06 | Plans — corrupt stored config | Detected and archived, not silently dropping every override | A |
| T-07 | AI overrides | Cannot de-tune the strict-JSON router or the summariser | A |
| T-08 | Promo codes | CRUD plus percent/fixed, dates, max redemptions, plan/interval restrictions | H, B |
| T-09 | Admins | Add/change role/remove; cannot remove the last operator | H, B |
| T-10 | Logs | Filter, level, search, pagination all return correct rows | H |
| T-11 | Usage drill-down | Figures match that shop's own Plan and Usage page; bogus shopId 404s, never leaks | H, A, T |
| T-12 | Auth | Unauthenticated / bogus / expired all 302 to login | A |
| T-13 | Not framable | Frame-ancestors none, including with a shop query param | A |
| T-14 | Cookie isolation | Web cookie cannot open `/platform`; platform cookie cannot open `/app` or `/web` | A, T |
| T-15 | Restore | Every global setting changed during T-02 to T-08 restored and verified | — |

## U. Storefront — the full app-proxy contract (`scripts/qa/storefront.test.ts`)

| ID | Case | Expected | Scenarios |
|---|---|---|---|
| U-01 | Unsigned / tampered signature | Every endpoint rejects | A |
| U-02 | `shop` param not matching the signature | Rejected | A |
| U-03 | Shop A's conversation id used from a shop-B-signed request | Refused on every endpoint that takes an id | T, A |
| U-04 | No endpoint leaks another shop's data, PII, the LLM key, prompt text or a stack trace | — | T, A |
| U-05 | Hostile input | Oversized body, non-UTF8, deep JSON, SQL-ish, prompt injection — nothing 500s | A, B |
| U-06 | `widget-config` | Real merchant config; `remove_branding` gate reflected; cache header understood | H, P |
| U-07 | Online/offline over the wire | All 3 modes across hours, timezone, overnight, break, holiday | H, B |
| U-08 | `prechat` | Creates the conversation, captures fields, honours required-field config | H, B |
| U-09 | `chat` — product question | SSE well-formed, terminates, persists; product cards carry real variant ids | H |
| U-10 | `chat` — policy question | Grounded in knowledge; no invented URL | H |
| U-11 | `chat` — curated hit | Curated text returned verbatim | H |
| U-12 | `chat` — curated near-miss | Falls through to RAG rather than returning a wrong curated answer | B |
| U-13 | `chat` — out of scope | Graceful refusal | B |
| U-14 | `chat` — conversation quota | Gate bites at the plan limit | P, B |
| U-15 | `messages` / `history` | Resumes with the same visitor token; a foreign token cannot resume | H, A, T |
| U-16 | `order-track` | Valid order works; a foreign order returns **nothing**; nonexistent handled | H, A, T |
| U-17 | `survey` | Plan-gated; submits | P |
| U-18 | `faq-search`, `handover-form`, `campaign-lead`, `campaign-products`, `event` | Each behaves and is shop-scoped | H, T |
| U-19 | Widget bundle contract | Client reads exactly the fields the server returns (a renamed field means a silent blank) | H |
| U-20 | SSE client resilience | Stream error, mid-stream disconnect, truncation, non-SSE error response | A, B |
| U-21 | No hardcoded shop/URL/secret in client code | — | A |
| U-22 | Widget accessibility | Launcher and panel keyboard reachable, named, sensible focus | H |
| U-23 | Widget below ~390px | Nothing breaks | B |

## V. Browser pass — what only a human eye catches

Executed from `.claude/qa/BROWSER-TEST-PLAN.md` (60 numbered checks, B1–B5): visual rendering
inside the Shopify iframe, console and network cleanliness, click-through of every form, live
cross-surface updates over SSE, storefront add-to-cart, mobile at 390px, keyboard-only operation,
and Lighthouse. **These cannot be asserted by a script** and are recorded as `PENDING-MANUAL` in
the matrix until run against a real browser and dev store.

---

## Suite index — how to run everything

Run from the repo root with `PRISMA_CLIENT_ENGINE_TYPE=binary npx tsx <path>`.
Every suite prints `PASS`/`FAIL` per case, ends with `N passed, M failed`, and exits non-zero on
failure. The HTTP suites additionally require `npm run dev` to be running on `:3000`.

| Suite | Area | Needs dev server |
|---|---|---|
| `scripts/qa/plan-gates.test.ts` | B | no |
| `scripts/qa/promo-codes.test.ts` | C | no |
| `scripts/qa/subscription-webhook.test.ts` | A | no |
| `scripts/qa/model-portability.test.ts` | D | no |
| `scripts/qa/availability.test.ts` | H | no |
| `scripts/qa/handover.test.ts` | G | no |
| `scripts/qa/logs.test.ts` | E, P | no |
| `scripts/qa/install-lifecycle.test.ts` | N | no |
| `scripts/qa/cache.test.ts` | M | no |
| `scripts/qa/perf-queries.test.ts` | L | no |
| `scripts/qa/features.test.ts` | E, I, Q | no |
| `scripts/qa/routing.test.ts` | J | **yes** |
| `scripts/qa/auth-sessions.test.ts` | K | **yes** |
| `scripts/qa/ui-embedded.test.ts` | R | **yes** |
| `scripts/qa/ui-web.test.ts` | S | **yes** |
| `scripts/qa/ui-platform.test.ts` | T | **yes** |
| `scripts/qa/storefront.test.ts` | U | **yes** |

Seeding: `scripts/qa/seed-curated.ts` (curated fixtures), `scripts/qa/perf-seed.ts` (synthetic
volume — **remove it again afterwards**).
