# 01 — Foundation (Phase 0)

> Project skeleton: database, schema, tenancy, jobs, app proxy/SSE, extension shell.
> Sources: `PRODUCTION-BUILD-SPEC.md` §4–§6, §11; `LLM-Guide.html` slide 11 (effective DB calls); template repo state.

## Purpose

Convert the fresh template into the ChatConvert foundation every feature builds on: Postgres + pgvector, the full multi-tenant schema, background jobs, storefront transport (app proxy + SSE), and the service-layer seams (LLM provider, embeddings, search, tenancy).

## Scope

In: everything listed below. Out: pipeline logic (03), any admin UI, widget UI (05), billing (15).

## Deliverables

### 1. Dev database

- `docker-compose.yml`: `pgvector/pgvector:pg17`, host port **5433**, named volume (never a Windows bind mount for pgdata), `pg_isready` healthcheck.
- Scripts: `"db:up": "docker compose up -d"`, `"db:down": "docker compose down"`.
- `.env` (gitignored) / `.env.example` (committed; add `!.env.example` to `.gitignore`):
  - `DATABASE_URL=postgresql://chatconvert:chatconvert@localhost:5433/chatconvert`
  - `OPENAI_API_KEY=`, `LLM_PROVIDER=openai`, `CHAT_MODEL=gpt-4o-mini`, `EMBEDDING_MODEL=text-embedding-3-small`
  - `PRISMA_CLIENT_ENGINE_TYPE=binary` (Windows dll fix, documented)
- Note in README/PROGRESS: `npm run db:up` must precede `npm run dev` (shopify.web.toml runs `prisma migrate deploy` first).

### 2. Prisma schema (provider `postgresql`)

- Generator `previewFeatures = ["postgresqlExtensions"]`; datasource `extensions = [vector]`.
- Delete the old SQLite migration (`20240530213853_create_session_table`) — fresh history.
- All domain tables snake_case via `@@map`, `shopId` on every one, `@@index([shopId])` minimum.

Models (fields per `PRODUCTION-BUILD-SPEC.md` §5, extended by feature needs):

| Model | Key fields | Notes |
|---|---|---|
| `Session` | template fields unchanged | Shopify session storage |
| `Shop` | id, domain (unique), name, currency, plan, planStatus, installedAt, uninstalledAt | tenant root; `resolveShopId(domain)` |
| `Product` | shopId, shopifyProductId, title, description, productType, vendor, tags, price, stock, imageUrl, handle, status, `embedding Unsupported("vector(1536)")?`, `searchText Unsupported("tsvector")?` | `@@unique([shopId, shopifyProductId])`; btree `(shopId, price)`, `(shopId, stock)`; embedding **nullable** (written by raw UPDATE) |
| `Collection` | shopId, shopifyCollectionId, title, description, productCount, learnEnabled | `@@unique([shopId, shopifyCollectionId])` |
| `Knowledge` | shopId, dataSourceId, topic, body, `embedding vector(1536)?` | RAG chunks |
| `DataSource` | shopId, type (url/manual/csv/file/pages/faq), name, url, status, crawlScope, reCrawlWeekly, chunkCount, lastSyncedAt, metadata Json | |
| `Faq` | shopId, categoryId, question, answerHtml, status, featured, position | |
| `FaqCategory` | shopId, name, icon, position, status, featured, isDefault | |
| `CuratedAnswer` | shopId, question, synonyms String[], productIds String[], talkingPoints, status, priority, servedCount, `embedding vector(1536)?` | |
| `Persona` | shopId (unique), role, brandVoice, communicationStyle, behaviours, guidelines String[], avoid String[], scope, offTopicMessage, defaultLanguage, languages String[], autoDetectLanguage, welcomeMessage | |
| `Guardrails` | shopId (unique), answerOnlyFromKnowledge, bannedTopics String[], fallbackMessage, minMeaningScore (0.30), curatedMatchThreshold (0.80), curatedBorderline (0.65), bannedMatchThreshold (0.35) | defaults from `data-sources/guardrails.json` |
| `Conversation` | shopId, sessionId, contactId?, mode (ai/human), status (open/resolved), outcome, starred, blocked, unread, assigneeId?, channel, startedAt, endedAt, lastMessageAt | |
| `Message` | conversationId, role (in/out/sys), content, productCards Json?, sourceLayer, intent Json?, seenAt, createdAt | index `(conversationId, createdAt)` |
| `Contact` | shopId, name, email, phone, type (customer/lead/anonymous), channel, location, marketingOptIn | `@@index([shopId, email])` |
| `AnalyticsEvent` | shopId, type, payload Json, occurredAt | index `(shopId, type, occurredAt)` |
| `WidgetSettings` | shopId (unique), settings Json | chatbox config (06) — single JSON blob v1 |
| `Campaign` | shopId, name, templateType, status, priority, settings Json, metrics fields | proactive chat (12) |
| `PlanUsage` | shopId, periodStart, conversationCount, overageCount | billing meter (15) |
| `HandoverConfig` | shopId (unique), config Json | destinations + triggers (08) |

(WidgetSettings/HandoverConfig as JSON blobs v1 — schema-validated with zod at the boundary; promote to columns if queried.)

### 3. Initial migration (customized SQL workflow)

1. `npx prisma migrate dev --create-only --name init`
2. Hand-append to `migration.sql`:
   - `search_text` rewritten to `GENERATED ALWAYS AS (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(description,''))) STORED`
   - `CREATE INDEX ... USING hnsw (embedding vector_cosine_ops)` on `products`, `knowledge`, `curated_answers`
   - `CREATE INDEX ... USING GIN (search_text)` on `products`
3. `npx prisma migrate dev` to apply.
- **Never `prisma db push`.** ⚠️ VERIFIED 2026-08-06: Prisma 6.16's differ does NOT ignore Unsupported-column indexes — raw `migrate dev` regenerates DROPs for the HNSW/GIN indexes. All future migrations go through `npm run migrate:new -- --name <name>` (create-only → `scripts/scrub-migration.ts` → apply); smoke test asserts the indexes exist.
- No IVFFlat (needs training data, degrades on empty tables). HNSW only.

### 4. Service layer (`app/lib/`)

| Module | Responsibility |
|---|---|
| `env.server.ts` | zod-validated env; imported at boot → fail fast |
| `tenancy.server.ts` | `resolveShopId(shopDomain)`, scoped-query helpers; throws if shopId missing |
| `llm/types.ts` | `LlmProvider { chat, chatStream(): AsyncIterable<string>, embed, embedBatch }` |
| `llm/openai.server.ts` | OpenAI impl (only file importing `openai`) |
| `llm/index.server.ts` | `getLlmProvider()` env-driven factory — the swap seam |
| `embeddings/embedding.server.ts` | batch ≤100/req, 429 exponential backoff, `toSqlVector(number[]): string` for `::vector` casts |
| `search/product-search.server.ts` | hybrid: keyword+filters query and vector query via `$queryRaw`, merge+dedupe in TS, hard price/stock filters, top 8 |
| `search/knowledge-search.server.ts` | RAG top-k vector search |
| `search/curated-match.server.ts` | curated similarity match |
| `pipeline/index.server.ts` | signature stubs only (feature 03 fills) |
| `ingestion/catalog-sync.server.ts` | full paged sync + single upsert via `unauthenticated.admin(shop)` |
| `ingestion/knowledge-ingest.server.ts` | stub: fetch → chunk → embed |
| `jobs/queue.server.ts` | pg-boss singleton (global pattern like `db.server.ts` — HMR-safe) |
| `jobs/handlers.server.ts` | registry: `catalog-sync`, `product-upsert`, `shop-cleanup`, `knowledge-ingest` (stub) |
| `sse.server.ts` | ReadableStream → `text/event-stream` framing, 15s heartbeat comments |

Dependencies: `openai`, `pg-boss`, `zod` (+ dev `tsx`).

### 5. shopify.app.toml changes

- Remove demo `[product.metafields...]` and `[metaobjects...]` blocks.
- Scopes → `read_products`. **Do NOT add `read_orders`** (Protected Customer Data approval — deferred to order-status feature).
- Align api_version: toml webhooks say `2026-10`, code says `ApiVersion.July26` — align both to July26 for now, bump together later.
- Webhooks: `products/create|update|delete` → `/webhooks/products`; `collections/create|update|delete` → `/webhooks/collections`; `compliance_topics = ["customers/data_request","customers/redact","shop/redact"]` → `/webhooks/compliance`.
- `[app_proxy]`: `prefix = "apps"`, `subpath = "chatconvert"`, url dev-managed.

### 6. Routes

- `webhooks.products.tsx`, `webhooks.collections.tsx`, `webhooks.compliance.tsx`: `authenticate.webhook` → enqueue → `new Response()`. Switch on `topic`. No inline embedding/API work (5s rule).
- `webhooks.app.uninstalled.tsx`: keep session delete + enqueue `shop-cleanup`.
- `proxy.ping.tsx`: streams 5 timestamped chunks 500ms apart — **day-one go/no-go probe for SSE through the app proxy**.
- `proxy.chat.tsx`: POST action via `authenticate.public.appProxy(request)` (never hand-rolled HMAC), echo-stream skeleton returning `text/event-stream` (`Cache-Control: no-cache`, `X-Accel-Buffering: no`). Widget reads `response.body.getReader()` — POST + fetch-stream, **not** `EventSource`.

### 7. Theme app extension shell

`npm run generate` → `extensions/chat-widget/`: app-embed block rendering a launcher div + `chat-widget.js` that calls `/apps/chatconvert/ping` and streams `/apps/chatconvert/chat` echo. Real UI = spec 05.

### 8. Seed + smoke

- `prisma/seed.ts` (via `"prisma": { "seed": "tsx prisma/seed.ts" }`): dev shop `dev-shop.local` seeded from `.claude/resources/demo/data-sources/*.json` (products, knowledge, curated_answers, persona, guardrails). Real embeddings if `OPENAI_API_KEY` set; else deterministic hash-seeded pseudo-embeddings (offline-capable).
- `scripts/smoke-vector.ts` (`npm run smoke`): embed "warm gloves under $30" → hybrid search asserts ≥1 result; curated-match round-trip ("what are your best sellers"). Non-zero exit on failure.

## Business rules

- Tenant isolation via code seam (no RLS v1).
- Webhook handlers enqueue-only; jobs idempotent (upsert on `(shopId, shopifyProductId)`).
- `OPENAI_API_KEY` never leaves the server; never in extension assets.
- No Redis/BullMQ/WebSockets.

## Risks

| Risk | Mitigation |
|---|---|
| Prisma can't write vector cols | nullable columns; raw SQL centralized in embeddings/search; migrations-only workflow |
| SSE buffered by app proxy | proxy.ping probe first; fallback = proxy mints short-lived HMAC token, widget streams direct from app domain with CORS (transport swap only) |
| Webhook 5s timeout | enqueue-only handlers |
| Windows | engine binary, named volume, port 5433, tsx scripts |
| HMR double pg-boss | global singleton pattern |

## Acceptance criteria

1. `npm run db:up` → healthy container; `migrate dev` clean; `pg_extension` shows `vector`; HNSW + GIN indexes exist.
2. `npm run typecheck`, `lint`, `build` pass.
3. `prisma db seed` then `npm run smoke` passes (hybrid + curated queries return expected rows).
4. `shopify app dev` boots with Postgres session storage; app installs on dev store.
5. Editing a product in dev-store admin → `product-upsert` job runs → embedding written.
6. Storefront `/apps/chatconvert/ping` chunks arrive **incrementally** (SSE gate) — record result in PROGRESS.md.
7. Uninstall → sessions deleted, `shop-cleanup` executed.

## Out of scope

Pipeline logic, admin UI, widget UI, billing, order-status tooling, RLS.
