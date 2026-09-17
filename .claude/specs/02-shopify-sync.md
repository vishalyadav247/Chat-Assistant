# 02 — Shopify Catalog Sync

> Keep the per-shop product/collection/discount mirror + embeddings fresh.
> Sources: `PRODUCTION-BUILD-SPEC.md` §6; `LLM-Guide.html` slide 3 (ingestion); design `ai-agent.html` Training data tabs (Products/Collections/Discounts).

## Purpose

Mirror each shop's catalog into Postgres (normalized + embedded) so hybrid search works, while live stock/price are still re-checked at answer time. Runs on install, on webhooks, and on a scheduled reconcile.

## Scope

In: product sync, collection sync, discount sync (Pro+ real-time), sync status/meta surfaced to admin (consumed by spec 07 UI), plan-based product caps.
Out: knowledge ingestion (04), the Training-data admin UI itself (07).

## Data model

`Product`, `Collection` per spec 01. Sync metadata on `Shop` or a `SyncState` row: lastProductSyncAt, lastCollectionSyncAt, productCount, syncStatus (idle/running/error), errorMessage.

## Flows

### Initial sync (on install / on demand "Sync products")
1. Enqueue `catalog-sync` job (afterAuth or first admin load if never synced; also from admin button).
2. Job pages Admin GraphQL (`products` query, 250/page, via `unauthenticated.admin(shop)` offline token): id, title, descriptionHtml→text, productType, vendor, tags, status, featuredImage, handle, priceRangeV2 min, totalInventory, variants (id, price, inventory, options).
3. Normalize → upsert on `(shopId, shopifyProductId)`.
4. Embed `title + ". " + description` in batches (≤100 texts/request) → raw `UPDATE products SET embedding = $1::vector`.
5. Respect plan cap (200/500/1000/5000 by tier — spec 15): sync stops at cap (derived from the plan quota + bonus, nothing stored); admin shows "X of Y learned" + upgrade nudge.
6. Update SyncState; emit `analytics_event(type: catalog_synced)`.

### Webhook incremental
- `products/create|update` → enqueue `product-upsert` (payload included): normalize → upsert → re-embed **only if title/description changed** (compare hash) → update stock/price always.
- `products/delete` → delete row (embedding goes with it); remove from curated `productIds`? No — curated keeps ids, stock revalidation (09) flags them.
- `collections/create|update|delete` → upsert/delete `Collection` (title, description, productCount, ruleSet→conditions summary).
- **Full collection sync is large-store safe (2026-09-16, owner report: a new 8,000-product store got no collections).** On install it runs beside the product sync on the same Admin API points bucket; it made raw calls, so the first THROTTLED answer threw and nothing was stored. Every collection-list and membership call now goes through `graphqlPaced` (waits out THROTTLED with growing backoff, paces the next call to the bucket), the run continues in a new job with its cursor after 5 minutes (like products), deletions are pruned after the last chunk by `updatedAt < runStartedAt`, and failures are logged as `collection_sync_error` (/admin → Logs). New collections are created learned.
- Discounts: `discounts/create|update|delete` webhooks apply on **every plan** (2026-09-11, user decision — they were Pro+ behind a merchant "Real-time sync" switch, and on other plans the webhook arrived and was discarded). "Sync now" pulls all on demand. Discount rows stored in `metadata`-style table or `DataSource type=discount` — v1: a `Discount` model (shopId, shopifyId, title, summary, status, startsAt, endsAt).

### Scheduled sync (revised 2026-09-11, user decision)
- **Weekly** (`reconcile-all`, Mondays 03:17 UTC), every installed shop, every plan, no merchant toggle — and only for what no webhook reports: **collections** (smart-collection membership follows product tags; no webhook reports a product moving in or out), **pages** and **blogs** (spec 22; Shopify has no webhook topics for either).
- **Products and discounts are not scheduled** — their webhooks apply each change as it happens. Accepted trade-off: a webhook lost to an outage longer than Shopify's retry window (8 retries over 4 hours) is not healed automatically; the tab's Sync button does it.
- Replaces the old daily full re-sync, which was plan-gated (`catalog_auto_sync`, Pro+) behind a per-type merchant toggle and re-read every product of every Pro/Plus shop each night.
- Every tab shows how its data stays current, the last-synced time and a manual Sync button — no Auto sync / Real-time switches.

## Business rules

- Webhook handlers enqueue-only; jobs idempotent.
- Stock/price stored for filtering but **never trusted for display** — answer-time facts come from DB row refreshed by webhooks; product cards re-check live via Admin API only where staleness matters (order lane / add-to-cart in later features).
- Learn toggles (per type: products/collections/discounts — design `ai-agent.html`): when off, rows remain but are **excluded from search** (`learnEnabled` flag honored by product-search).
- Bulk edits fire hundreds of webhooks — pg-boss serializes; upserts make redelivery safe.
- API version pinned with app (July26); sync code isolated in `ingestion/catalog-sync.server.ts`.

## Plan gating

| Plan | Products synced | Discount sync (webhooks on every plan since 2026-09-11) |
|---|---|---|
| Free | 200 | manual only |
| Basic | 500 | manual only |
| Pro | 1,000 | ✅ webhooks |
| Plus | 5,000 | ✅ webhooks |

## Acceptance criteria

1. Fresh install on dev store → catalog fully mirrored + embedded within minutes; "X of X products learned" correct.
2. Edit product title in Shopify admin → row + embedding updated (job log proof); edit only price → no re-embed.
3. Delete product → row gone; search never returns it.
4. Cap enforced: seeding >cap products syncs exactly cap and records capped state.
5. Reconcile job converges after simulated missed webhook (manual row tamper).
6. Learn toggle off → products excluded from hybrid search results.

## Out of scope / gaps

- Metafields: built 2026-08-19 (spec 07 Manage metafields) — catalog sync stores all product/variant metafields (`Product.metafields`), enabled ones feed embedding + full-text via `Product.metafieldText`.
- Metafield definitions webhooks `metafield_definitions/create|update|delete` (2026-08-19, needs `read_content`) → enqueue-only handler → `metafield-definitions-sync` job re-mirrors the catalog; `SyncState.metafieldSyncAt`.
- Collections "conditions" display beyond summary text.
- Discount semantics in the pipeline (the AI mentioning discounts) — pipeline spec 03 forbids invented discounts; synced discounts become RAG-available later.
