# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Commands

- `npm run dev` — start local development via Shopify CLI (handles auth, env vars, tunnel, and config sync). Press P to open the app URL.
- `npm run build` — production build (`react-router build`)
- `npm run lint` — ESLint
- `npm run typecheck` — generates React Router route types (`react-router typegen`) then runs `tsc --noEmit`
- `npm run setup` — `prisma generate && prisma migrate deploy` (run if you see "The table `main.Session` does not exist")
- `npm run deploy` — deploy app config and extensions to Shopify
- `npm run graphql-codegen` — regenerate GraphQL types into `app/types/` (config in `.graphqlrc.ts`)

There is no test suite configured.

## Architecture

Embedded Shopify Admin app built on **React Router v7** (framework mode, converted from the Remix template) with **Prisma + SQLite** for session storage and **Polaris web components** (`<s-*>` elements) for UI.

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
