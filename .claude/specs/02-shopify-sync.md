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
5. Respect plan cap (200/500/1000/5000 by tier — spec 15): sync stops at cap, records `cappedAt`; admin shows "X of Y learned" + upgrade nudge.
6. Update SyncState; emit `analytics_event(type: catalog_synced)`.

### Webhook incremental
- `products/create|update` → enqueue `product-upsert` (payload included): normalize → upsert → re-embed **only if title/description changed** (compare hash) → update stock/price always.
- `products/delete` → delete row (embedding goes with it); remove from curated `productIds`? No — curated keeps ids, stock revalidation (09) flags them.
- `collections/create|update|delete` → upsert/delete `Collection` (title, description, productCount, ruleSet→conditions summary).
- Discounts (Pro+): `discounts/create|update|delete` webhook subscription registered **only when plan ≥ Pro and merchant enables real-time sync**; Free/Basic use manual "Sync now" button. Discount rows stored in `metadata`-style table or `DataSource type=discount` — v1: a `Discount` model (shopId, shopifyId, title, summary, status, startsAt, endsAt).

### Scheduled reconcile
- Daily pg-boss cron job per shop (design: "Auto sync: Daily"): re-page catalog, fix drift from missed webhooks; cheap no-op when hashes match.

## Business rules

- Webhook handlers enqueue-only; jobs idempotent.
- Stock/price stored for filtering but **never trusted for display** — answer-time facts come from DB row refreshed by webhooks; product cards re-check live via Admin API only where staleness matters (order lane / add-to-cart in later features).
- Learn toggles (per type: products/collections/discounts — design `ai-agent.html`): when off, rows remain but are **excluded from search** (`learnEnabled` flag honored by product-search).
- Bulk edits fire hundreds of webhooks — pg-boss serializes; upserts make redelivery safe.
- API version pinned with app (July26); sync code isolated in `ingestion/catalog-sync.server.ts`.

## Plan gating

| Plan | Products synced | Discount real-time sync |
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
