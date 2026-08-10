---
name: shopify-app-dev
description: Shopify platform patterns for this app — Admin GraphQL, webhooks, app proxy, embedded-app rules. Use when writing any route, webhook handler, proxy endpoint, or Admin API call.
---

# Shopify app development patterns

## Authoritative source

For any Shopify API question (schema fields, webhook payloads, billing mutations, extension config): query the **shopify-dev-mcp** server (configured in `.mcp.json`) or shopify.dev docs. Do not answer from memory — API versions move quarterly. This app pins **ApiVersion.July26**; toml and code must always agree.

## Admin API

- Always via `authenticate.admin(request)` in loaders/actions, or `unauthenticated.admin(shop)` in jobs (offline token).
- GraphQL only (no REST). Tag queries `#graphql`; run `npm run graphql-codegen` after adding queries → types in `app/types/`.
- Paginate with `pageInfo { hasNextPage endCursor }`, 250/page max; respect cost-based rate limits (retry on THROTTLED with backoff).

## Embedded admin routes

- Nested under `app/routes/app.tsx`; every nested route with a loader/action exports `boundary.error` + `boundary.headers`.
- Navigation: `Link`/`useNavigate` from react-router — never `<a>`. Redirects: the `redirect` returned by `authenticate.admin` — never react-router's. Forms: `useSubmit`.
- External/top-level redirects (billing confirmation URLs) go through App Bridge, not `window.location`.

## Webhooks

- Subscriptions declared in `shopify.app.toml` only (synced on deploy) — never `registerWebhooks`/afterAuth.
- Handler shape, always: `const { topic, shop, payload } = await authenticate.webhook(request)` → `boss.send(...)` → `return new Response()`. **Nothing slow inline** (5s limit). HMAC is handled by the library — never hand-rolled.
- Handlers idempotent: webhooks redeliver; upsert on natural keys like `(shopId, shopifyProductId)`.

## App proxy (storefront endpoints)

- Routes under `proxy.*`; authenticate with `authenticate.public.appProxy(request)` — gives verified shop + optional admin. Shop identity comes from the proxy signature, **never from client input**.
- Streaming responses: `text/event-stream` + `Cache-Control: no-cache` + `X-Accel-Buffering: no`; POST + fetch-stream (EventSource is GET-only).

## Scopes

- Current: `read_products` only. Adding a scope = toml change + deploy + merchant re-auth; adding `read_orders`/customer scopes triggers Protected Customer Data approval — a deliberate decision, ask the user first (see spec 17).

## Local dev

- `npm run db:up` before `npm run dev` (shopify.web.toml runs migrate deploy).
- CLI tunnels buffer streams — verify streaming behavior with the `/apps/chatconvert/ping` probe, and test SSE-critical work against `localhost`-based dev if the tunnel buffers.
