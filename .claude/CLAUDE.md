# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This app is scaffolded from a Shopify app template (see README for framework details). Use the [Shopify AI Toolkit](https://shopify.dev/docs/apps/build/ai-toolkit) for Shopify API and platform work — do not add such tooling to this repo.

## Spec-driven development (READ FIRST for feature work)

This repo builds **ChatConvert** — a multi-tenant AI product-recommendation + support chat app (public Shopify app). All feature work is spec-driven:

- **`.claude/PROGRESS.md`** — current phase, feature statuses, decisions log. Update it on every status change.
- **`.claude/specs/`** — one spec per feature; start with `00-overview.md` (architecture, tenancy rules, guidelines, spec index).
- **`.claude/skills/spec-workflow/`** — the loop: pick from PROGRESS.md → read spec → implement → verify acceptance criteria → update PROGRESS.md. Other project skills: `shopify-app-dev`, `shopify-compliance`, `polaris-admin-ui`, `theme-extension-widget`, `db-tenancy`, `ai-pipeline`.
- **`.claude/agents/`** — `feature-builder`, `shopify-reviewer`, `tenancy-auditor`, `qa-verifier`, `docs-researcher`.
- **`.claude/resources/`** — original requirements: `demo/PRODUCTION-BUILD-SPEC.md` (authoritative product spec), `html_design/` (UI prototypes + NOTES.md), demo pipeline + prompts.

Iron rules: every DB query shop-scoped (`shopId`); never `prisma db push`; webhook handlers enqueue-only; LLM keys server-only; prompts/thresholds only from their canonical locations; plan gates enforced server-side.

## Commands

- `npm run dev` — start local development via Shopify CLI (handles auth, env vars, tunnel, and config sync). Press P to open the app URL.
- `npm run build` — production build (`react-router build`)
- `npm run lint` — ESLint
- `npm run typecheck` — generates React Router route types (`react-router typegen`) then runs `tsc --noEmit`
- `npm run db:up` / `npm run db:down` — start/stop the dev Postgres (Docker, pgvector, port 5433). **Required before `dev`/`setup`.**
- `npm run setup` — `prisma generate && prisma migrate deploy`
- `npx prisma db seed` — seed the dev shop from `.claude/resources/demo/data-sources/` (works without OPENAI_API_KEY via pseudo-embeddings)
- `npm run smoke` — foundation smoke test (pgvector, hybrid/keyword search, curated match, RAG)
- `npm run deploy` — deploy app config and extensions to Shopify
- `npm run graphql-codegen` — regenerate GraphQL types into `app/types/` (config in `.graphqlrc.ts`)

There is no test suite configured.

## Architecture

Embedded Shopify Admin app built on **React Router v7** (framework mode, converted from the Remix template) with **Prisma + Postgres/pgvector** (sessions + all domain data; Docker for dev) and **Polaris web components** (`<s-*>` elements) for UI. Domain logic lives in `app/lib/` (tenancy, llm provider, embeddings, search, pipeline, ingestion, pg-boss jobs, SSE). **Never `prisma db push`** — migrations only (custom vector/GIN SQL lives in migration files).

- `app/shopify.server.ts` — central Shopify app setup. Exports `authenticate`, `unauthenticated`, `login`, `apiVersion`, `sessionStorage`. All Shopify auth and Admin GraphQL access goes through this module. API version: July 2026.
- `app/routes.ts` — uses `flatRoutes()`; routes are file-convention based under `app/routes/` (dot-delimited nesting, e.g. `app.additional.tsx` nests under `app.tsx`).
- `app/routes/app.tsx` — layout for embedded admin pages: calls `authenticate.admin(request)` in the loader, wraps children in `AppProvider`, and exports the `boundary.error`/`boundary.headers` helpers Shopify needs on every nested route with a loader/action.
- `app/routes/auth.*` — OAuth/login flows.
- `app/routes/webhooks.*.tsx` — webhook handlers using `authenticate.webhook(request)`. Webhook subscriptions are declared app-specific in `shopify.app.toml` (not via `afterAuth`/`registerWebhooks`), so they sync automatically on deploy.
- `app/db.server.ts` — Prisma client singleton; schema in `prisma/schema.prisma` (Session table only).
- `shopify.app.toml` — app config: access scopes, webhook subscriptions, and declarative custom data (product metafield + metaobject definitions). Changes here take effect on `npm run deploy`.
- `extensions/` — Shopify app extensions workspace (npm workspaces); currently empty. Generate with `npm run generate`.

### Data access pattern

In loaders/actions, authenticate first, then query the Admin GraphQL API:

```ts
const { admin } = await authenticate.admin(request);
const response = await admin.graphql(`#graphql ...`);
```

## Embedded-app gotchas

Because the app runs in an iframe, session handling breaks with standard browser navigation:

- Use `Link` from `react-router` (or Polaris), never `<a>`.
- Use the `redirect` helper returned from `authenticate.admin`, not `redirect` from `react-router`.
- Use `useSubmit` from `react-router` for form submissions.

## Windows note

If Prisma fails with `query_engine-windows.dll.node is not a valid Win32 application`, set `PRISMA_CLIENT_ENGINE_TYPE=binary`.
