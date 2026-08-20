---
name: db-tenancy
description: Prisma + Postgres + pgvector conventions and multi-tenant safety. Use when touching schema.prisma, migrations, any database query, or vector operations.
---

# Database & tenancy conventions

## Multi-tenancy (non-negotiable)

- Every domain table has `shopId`; **every** query filters by it — reads, writes, aggregates, raw SQL, jobs.
- Raw SQL takes `shopId` as the first bound parameter; helpers in `app/lib/tenancy.server.ts` throw when it's missing. Composite indexes put `shop_id` first.
- Cross-shop anything is a bug of the highest severity — run the `tenancy-auditor` subagent on every feature diff.
- Shop identity comes from `authenticate.admin` (admin), `authenticate.public.appProxy` (storefront), webhook payload, or — for the standalone web surface (spec 18) — the `TeamSession` row looked up by the opaque `cc_web_session` cookie inside `requireShopAccess()` (`app/lib/access.server.ts`) — **never** from client-supplied input (params, body, headers, client JSON). `/app/*` routes call `requireShopAccess()`, not `authenticate.admin()` directly.

## Migrations

- **Never `prisma db push`** — it bypasses migration files and destroys hand-written SQL.
- **Always create migrations with `npm run migrate:new -- --name <name>`** — never raw `prisma migrate dev`. PROVEN (2026-08-06): Prisma 6.16's differ does NOT ignore Unsupported-column indexes — a raw `migrate dev` regenerates `DROP INDEX` for every HNSW/GIN index and strips the generated tsvector expression. `migrate:new` runs create-only → `scripts/scrub-migration.ts` (removes those exact statements; extend its PROTECTED_INDEXES list when adding vector indexes) → applies.
- After scrubbing, review the migration SQL; add new custom SQL (vector indexes for new tables, generated columns) by hand in the same file. `npm run smoke` asserts the protected indexes still exist — run it after every migration.
- HNSW only for vector indexes (no IVFFlat). `postgresqlExtensions` preview + `extensions = [vector]` owns `CREATE EXTENSION`.

## pgvector usage

- Vector columns are `Unsupported("vector(1536)")?` and **nullable** — the Prisma client cannot write them; rows are created normally, embeddings written via raw SQL:
  `await db.$executeRaw`UPDATE products SET embedding = ${toSqlVector(vec)}::vector WHERE id = ${id} AND shop_id = ${shopId}``
- All vector/tsvector SQL is centralized in `app/lib/search/*` and `app/lib/embeddings/embedding.server.ts` (`toSqlVector()` serializer). Cosine distance: `embedding <=> $q::vector`; score = `1 - distance`. Always `LIMIT`; never select embedding columns back to the app.
- Keyword search uses the generated `search_text` tsvector column with `@@ plainto_tsquery(...)`; hard filters (price, stock, learn_enabled) are SQL `WHERE`, never similarity.

## Operational

- Prisma client singleton (`app/db.server.ts` global pattern) — same pattern for pg-boss.
- Windows: `PRISMA_CLIENT_ENGINE_TYPE=binary` if the dll error appears; DB via `npm run db:up` (port 5433, named volume).
- Seeds: `prisma/seed.ts` from `.claude/resources/demo/data-sources/*.json`; smoke: `npm run smoke`.
- Batch embedding at ingestion (≤100 texts/call, backoff on 429); cache shop config (persona/guardrails) per request lifecycle.
