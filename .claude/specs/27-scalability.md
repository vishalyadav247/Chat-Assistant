# 27 — Scalability review: many stores, big catalogues

Status: **spec / review only — nothing implemented.** Written 2026-09-16 after the owner asked, before
onboarding more stores: is the app scalable, how much load does the storefront widget create, is there
a browser-storage problem, and what breaks with many tenants?

Evidence: code review (file:line below) + a live measurement of the production widget on
ankastra.com with the current build.

---

## 1. Verdict

The **app's per-shopper load is small and the tenancy discipline is sound**. The limit is the
**deployment shape**: one Node process (`exec_mode: fork, instances: 1`, `max_memory_restart: "500M"`
— `ecosystem.config.cjs:36-49`) running the web server **and** every background job, on a 1.9 GB box,
with no per-shop limit on OpenAI use.

- **Today (a handful of small stores):** fine.
- **Dozens of stores, or any store with a large catalogue:** one sync can restart the process that
  serves every store's live chat, and one busy store can exhaust the shared OpenAI rate limit for
  everyone.
- Nothing here requires a rewrite. The fixes are configuration, job pacing, a few guards and indexes.

---

## 2. Storefront load (measured, ankastra.com, 2026-09-16)

| Situation | Requests to our server |
|---|---|
| Page view, chat closed | **1** `POST /apps/ccwidget/event` beacon; JS/CSS come from **Shopify's CDN** |
| Widget config | `GET /widget-config`, cached in `sessionStorage` for ≤ 5 min per tab (`chat-widget.js:319-354`), `public, max-age=300` (`proxy.widget-config.tsx:34`) |
| Chat open, no conversation | **zero** — verified: no repeat requests in 15 s |
| Chat open **with** a conversation | `GET /messages` every **5 s**, backing off to **15 s** after 4 empty polls and **30 s** after 12 (`chat-widget.js:2027-2049`) |
| One shopper turn | one SSE stream, closed when the reply ends; server heartbeat every 15 s (`sse.server.ts:5`), client stall watchdog 45 s (`widget-transport.js:14`) |
| Proactive campaigns | evaluated **in the browser** from the cached config — no server call per page view (`chat-widget.js:1627-1713`) |
| FAQ search | 250 ms debounce, `max-age=60` |

So traffic costs almost nothing; **conversations** are the cost. A store with 10k daily visitors and
200 chats is ~10k tiny beacons + ~200 × (1 SSE + a handful of polls).

**Storefront defects worth fixing**

| # | Issue | Where | Effect |
|---|---|---|---|
| S1 | `requestAnimationFrame` viewport loop runs ~60 fps for the whole time the panel is open, with no visibility/throttle check | `chat-widget.js:599-606` | battery/CPU on mobile |
| S2 | A dropped reply stream is not resumed (`stream_stalled` / `stream_truncated`) | `widget-transport.js:14-103` | shopper must retype on a flaky connection |
| S3 | `cc:open` survives navigation, so an abandoned open panel keeps polling at 30 s across page views | `chat-widget.js:417, 2060` | steady background polls per abandoned tab |
| S4 | Widget bundle **27.55 KB gzip against a 30 KB budget** (warn threshold already passed) | `npm run widget:size` | little headroom for new widget features |

---

## 3. Browser storage

`localStorage`: `cc:session` (rotates after 30 min idle), `cc:visitor` (**permanent, no TTL, no clear
path**), `cc:prechat`. `sessionStorage`: `cc:config`, `cc:convo`, `cc:poll`, `cc:human`, `cc:blocked`,
`cc:survey`, `cc:open`, `cc:screen`, `cc:cartn`, plus one `cc:camp:<id>` per campaign shown
(`chat-widget.js:129-256`). No cookies, no IndexedDB; every access is try/catch-wrapped, so private
mode degrades silently. **No PII is stored.**

| # | Issue | Effect |
|---|---|---|
| B1 | `cc:visitor` is a permanent cross-session identifier with no expiry or deletion path | privacy/GDPR posture; give it a TTL (e.g. 12 months) and clear it on consent withdrawal |
| B2 | `cc:camp:<id>` keys accumulate per session | cosmetic, unbounded key growth |

---

## 4. Server, database and multi-tenant risks (ranked)

### R1 — CRITICAL: one process runs everything
`startQueueOnBoot()` runs inside the web process (`app/entry.server.tsx:18`); pm2 is single-fork with
a 500 MB restart ceiling (`ecosystem.config.cjs:36-49`), and the config itself notes a second instance
would double-run every cron. Every `boss.work()` is registered with **no options**, so pg-boss
defaults apply: **batch 1, concurrency 1**, 2 s polling, 15 min job expiry, 2 retries
(`handlers.server.ts`, `pg-boss/dist/plans.js:46-54`).

Consequences: a big catalogue sync competes with live chat for the same memory and event loop; jobs
run strictly one at a time; ~25 queues each poll every 2 s (~12 q/s of idle DB polling).

**Fix direction:** split the worker into its own pm2 process (crons registered in ONE of them), raise
the memory ceiling, give the sync queues explicit concurrency.

### R2 — CRITICAL: no OpenAI concurrency or budget control
Single global key (`runtime-config.server.ts:138`), no per-shop concurrency, no global in-flight cap,
no spend circuit breaker; `withBackoff` retries twice over ~3 s (`openai.server.ts:364-378`). One busy
store can exhaust the shared rate limit and every other tenant's shopper sees a failed reply.

**Fix direction:** a small per-shop concurrency gate + a global in-flight cap in the LLM seam, plus a
shared backoff when 429s appear, and an operator-visible spend guard.

### R3 — HIGH: weekly fan-out with no stagger
`reconcile-all` (Mondays 03:17) enqueues **3 jobs per shop at once** (`handlers.server.ts:134-149`);
knowledge re-crawl (Mondays 05:23) one per data source (`knowledge-jobs.server.ts:64-71`). With one
worker this is a week-long queue at scale.

**Fix direction:** `startAfter` jitter per shop, and a cap on how many shops are queued per minute.

### R4 — HIGH: fleet loops abort on one tenant's error
`handlers.server.ts:139-143` (reconcile), `:194-213` (retention purge — GDPR-adjacent),
`knowledge-jobs.server.ts:64`, `compliance/jobs.server.ts:47-49` have **no per-shop try/catch**: one
failure skips every shop after it.

### R5 — MEDIUM: vector search does not isolate small tenants
All five HNSW indexes are global with default parameters and **shopId is a post-filter**
(`20260806000000_init/migration.sql:533-536`, `product-search.server.ts:725-738`). Only the passage
lanes set `hnsw.iterative_scan = relaxed_order` (`product-search.server.ts:762`,
`product-passages.server.ts:162`). With many large stores, a small store's rows can fall outside the
candidate set → fewer/zero results, silently. Index size also grows fast: 1536-dim vectors ≈ 6 KB
each plus graph links.

**Fix direction:** set iterative scan on the product/knowledge/curated lanes too; consider partial or
partitioned indexes once a few stores pass ~10k products; measure recall per shop.

### R6 — MEDIUM: migrations lock big tables
No `CREATE INDEX CONCURRENTLY` anywhere in 39 migrations; two past migrations rewrote the whole
`products` table (`20260817120000_product_search_weighted`, `20260904120000_search_text_number_ids`).
At 500 stores × 5k products that pattern is a multi-minute fleet outage during deploy.

**Fix direction:** an online-DDL rule in the spec guidelines (concurrent index builds, no rewriting
ALTERs on `products`/`messages`), and a migration checklist entry.

### R7 — MEDIUM: silent plan cap on products
`catalog-sync.server.ts:253, 315-320`: past the plan cap the sync stops paging **and** skips deletion
reconciliation; only an analytics event records it. Live example: **taravya stores 672 products on a
200 limit** — 472 rows never refresh, and the AI still recommends them.

**Fix direction:** surface "capped" in the dashboard, and decide whether over-cap rows are trimmed,
kept, or the plan is raised (owner decision).

### R8 — MEDIUM: tables that never shrink
No purge for `analytics_events`, `metrics_daily`, `llm_usage_daily` (only orphans),
`collection_products`, `plan_usage` (`handlers.server.ts:463-589`). Retention default is
**0 = keep forever** for conversations.

### R9 — LOW/MEDIUM: index gaps
`products` has no index covering `(shopId, learnEnabled, status, publishedOnline)` — the exact filter
of every search lane (`product-search.server.ts:702-732`); Shopify `sessions` has **no index at all**
(`schema.prisma:18-38`) though it is read on every authenticated request.

### R10 — LOW: public endpoints are unthrottled
Only `/order-track` has a limiter (in-process, per shop+IP — `proxy.order-track.tsx:17-36`).
`/chat`, `/messages`, `/history`, `/event`, `/faq-search`, `/prechat`, `/survey`, `/campaign-lead`
rely on Shopify's proxy HMAC and the plan usage cap. A scripted client can burn a store's quota and
our OpenAI spend.

### R11 — LOW: in-memory caches are per-process
~15 module-level caches (config 60 s/500 entries, catalogue overview 5 min, banned-topic and
recommendation vectors with **no TTL**, lexicon, usage-cap balances — an **unbounded** Map at
`billing/usage-cap.server.ts:57`). `invalidateShopConfig()` only clears the local process
(`shop-config.server.ts:110`), so with 2+ instances a merchant's setting change can take up to 60 s to
appear, and a purge invalidation may never reach the other instance.

### Tenancy (checked, no issues found)
`requireShopId()` (`tenancy.server.ts:52`) plus `requireShopAccess` (`access.server.ts:16-25`); ~35 raw
SQL sites all shop-scoped; **no query takes shopId from client input**. Deliberate fleet-wide deletes
exist only in retention paths (`handlers.server.ts:476-493, 566`) — correct, but unguarded by shopId,
so a boundary bug there would cross tenants (debug/log tables only).

---

## 5. Suggested staging

**Stage A — before onboarding more stores**
R1 (split web/worker, memory ceiling, queue concurrency) · R2 (OpenAI gates) · R3 (stagger) ·
R4 (per-shop try/catch) · R10 (basic rate limits on `/chat` and `/messages`).

**Stage B — before ~50 stores**
R5 (vector isolation + recall check) · R6 (online-DDL rule) · R7 (cap visibility + decision) ·
R8 (retention for analytics/usage) · R9 (indexes) · S1–S3 (widget CPU, stream resume, abandoned
polling) · B1 (visitor id TTL).

**Stage C — measurement, not guesswork**
A load test: N concurrent chats against one store and across many stores, recording p50/p95 reply
time, memory, DB connections, and OpenAI 429s — so capacity is a number, not an estimate.

## 6. Owner decisions needed

1. Hosting shape: stay on one box with separate web/worker processes, or move workers to a second
   machine?
2. taravya-style over-cap stores: trim to the plan, keep the extra rows, or raise the plan?
3. Default conversation retention (today: keep forever) — set a fleet default, e.g. 90 days?
4. Rate limits for public chat endpoints: per shop and per IP — what numbers?
