# ChatConvert — Local Development

Multi-tenant AI product-recommendation + support chat app for Shopify (public app).

Embedded Shopify Admin app on **React Router v7**, **Prisma + Postgres/pgvector**, **Polaris web components**, plus a storefront **theme app extension** chat widget.

> Product specs and the build workflow live in `.claude/` — see `.claude/PROGRESS.md` and `.claude/specs/00-overview.md`. This README covers only how to run the thing on your machine.

---

## Prerequisites

| Tool | Notes |
|---|---|
| **Node.js** | `>=20.19 <22` or `>=22.12` (see `engines` in `package.json`) |
| **Docker Desktop** | Hosts the dev Postgres + pgvector. Must be running before anything else. |
| **Shopify CLI** | `npm i -g @shopify/cli@latest` — handles auth, env vars, tunnel, config sync |
| **A Shopify dev store** | With the app installed |

`cloudflared` ships inside the Shopify CLI, so there's nothing extra to install — but **do not rely on the CLI's default tunnel** for storefront/widget work. Its hostname changes on every restart, which breaks the app proxy. See [Tunnels](#tunnels).

### One-time setup

```bash
npm install
cp .env.example .env      # then fill in OPENAI_API_KEY
npm run db:up             # start Postgres (first run pulls the pgvector image)
npm run setup             # prisma generate && prisma migrate deploy
npx prisma db seed        # dev shop + demo catalog/knowledge/curated answers
```

Seeding works **without** `OPENAI_API_KEY` (it falls back to pseudo-embeddings), but semantic search and the AI pipeline need a real key.

---

## Every day

```bash
# 1. Start Docker Desktop, wait for "Engine running"

# 2. Start Postgres + pgvector on port 5433
npm run db:up

# 3. Confirm it's healthy before starting the app
docker ps --filter name=chatconvert-db     # expect "Up ... (healthy)"

# 4. Start the tunnel ONCE (leave running all day) — see Tunnels for why
cloudflared tunnel --url http://localhost:3000 --metrics 127.0.0.1:20241
curl http://127.0.0.1:20241/quicktunnel     # -> {"hostname":"<host>.trycloudflare.com"}

# 5. Start the app against that stable tunnel
npm run dev -- --tunnel-url https://<host>.trycloudflare.com:3000
#    press P to open the app preview
```

**Order matters** — `npm run dev` fails if Postgres isn't up, because the app connects on boot.

⚠️ A bare `npm run dev` works for admin-only work, but mints a **new tunnel hostname** each time, which breaks the storefront widget. If the hostname changes you must update `shopify.app.toml`, `npm run deploy`, **and reinstall the app** — see [the pinning rule](#-the-one-rule-a-store-pins-the-app-proxy-at-install-time).

You do **not** need a separate worker process. pg-boss starts lazily inside the dev server (`app/lib/jobs/queue.server.ts`) and registers every handler and cron itself.

### Handy alongside

```bash
npx prisma studio --port 5555     # browse the DB at localhost:5555
```

⚠️ **Stop Prisma Studio before starting `npm run dev`.** On Windows it holds a lock on `node_modules/.prisma/client/query_engine-windows.dll.node`, so the CLI's pre-dev `npx prisma generate` fails with `EPERM` and the app server never boots — the CLI then reports `Unreachable target "http://localhost:<port>"`. `PRISMA_CLIENT_ENGINE_TYPE=binary` in `.env` avoids this; a stale `react-router dev` process can cause it too.

### Shutting down

`Ctrl+C` the dev server. `npm run db:down` is optional — data lives in the named volume `chatconvert-pgdata` and survives either way. The container is `restart: unless-stopped`, so leaving it running is fine.

---

## What to run when you change something

This is the section worth bookmarking.

| You changed… | Run |
|---|---|
| **`extensions/chat-widget/assets/*`** (JS/CSS) | Nothing — `shopify app dev` serves them live. Hard-refresh the storefront (`Ctrl+Shift+R`) |
| **`extensions/chat-widget/blocks/*.liquid`** | Nothing — same live reload. Hard-refresh the storefront |
| **`extensions/chat-widget/shopify.extension.toml`** (new settings/blocks) | Restart `npm run dev` — schema changes aren't hot-reloaded |
| **Theme extension, ready for other stores** | `npm run deploy` — creates and releases an app version |
| `app/routes/**`, `app/lib/**` | Nothing — Vite HMR |
| **`shopify.app.toml`** — scopes, webhooks | **Restart `npm run dev`** — it pushes config to your dev store only at startup. For all stores: `npm run deploy` |
| **`shopify.app.toml`** — `[app_proxy]` url/prefix/subpath | `npm run deploy` **+ uninstall and reinstall the app on every store**. Nothing else updates it — see [the pinning rule](#-the-one-rule-a-store-pins-the-app-proxy-at-install-time) |
| `prisma/schema.prisma` | `npm run migrate:new -- --name your_change` |
| Pulled someone else's migrations | `npm run setup` |
| `package.json` / after `git pull` | `npm install` |
| A GraphQL query | `npm run graphql-codegen` |
| Want fresh dev data | `npx prisma db seed` |

> 🚨 **Never run `prisma db push`, and never run raw `prisma migrate dev`.** Prisma 6.16's differ does not understand `Unsupported`-column indexes: it silently emits `DROP INDEX` for every HNSW/GIN index and strips the generated tsvector column. Always go through `npm run migrate:new`, which runs `--create-only`, scrubs the migration via `scripts/scrub-migration.ts`, then applies it. `npm run smoke` asserts the 5 protected indexes still exist.

### After touching the widget, before you commit

```bash
npm run widget:size     # bundle must stay ≤30KB gz
```

---

## Tunnels

### 🚨 The one rule: a store pins the app proxy at install time

**Read this before touching anything proxy-related.** It cost a full day of debugging on 2026-08-07.

When a store installs the app, Shopify **copies the app-proxy destination URL into the store's own record** and never refreshes it. Nothing you do afterwards changes it:

| Action | Updates the store's proxy record? |
|---|---|
| `npm run deploy` | ❌ no |
| Restarting `shopify app dev` | ❌ no |
| Accepting a scope re-authorization prompt | ❌ no — refreshes the access token only |
| **Genuine uninstall → fresh install** | ✅ **yes, only this** |

So if the app was ever installed while `shopify.app.toml` held a placeholder or a since-dead tunnel host, that store keeps dispatching every `/apps/<subpath>/*` request there forever. Shopify fails in ~99ms and renders *"There was an error in the third-party application"* inside the theme. The widget aborts silently (its `widget-config` fetch fails), so the storefront just shows nothing.

The same pinning applies to `prefix` and `subpath` — the CLI warns `Any changes to prefix and subpath will only apply to new installs`.

**Whenever you change `[app_proxy]` (url, prefix, or subpath): uninstall and reinstall the app on every store that already has it.** Re-authorizing is not enough, and it looks successful because the session token really does refresh.

### Run dev on a stable tunnel — not the default

`npm run dev` on its own opens a Cloudflare Quick Tunnel with a **random hostname that changes on every restart**. Combined with install-time pinning, that guarantees the registered URL goes stale within minutes.

Start a tunnel *you* control and point dev at it. It survives dev restarts, so the config stays valid:

```bash
# terminal 1 — start ONCE, leave running all day
cloudflared tunnel --url http://localhost:3000 --metrics 127.0.0.1:20241

# read the hostname it was assigned
curl http://127.0.0.1:20241/quicktunnel
# -> {"hostname":"affair-posting-they-bearing.trycloudflare.com"}

# terminal 2 — the port must match the tunnel's target port
npm run dev -- --tunnel-url https://<that-host>.trycloudflare.com:3000
```

`cloudflared` ships with the Shopify CLI — no separate install:
`%APPDATA%\npm\node_modules\@shopify\cli\bin\cloudflared.exe`

Put that host into `application_url`, `auth.redirect_urls`, and `[app_proxy].url` (absolute, ending in `/proxy`), `npm run deploy`, then **uninstall + reinstall**. After that you can restart dev freely — only restarting *cloudflared* invalidates things.

`ngrok http 3000` + `--tunnel-url https://<id>.ngrok-free.app:3000` works identically. For a permanent hostname, use a named Cloudflare tunnel (needs an account and a domain):

```bash
cloudflared tunnel login
cloudflared tunnel create chatconvert-dev
cloudflared tunnel route dns chatconvert-dev chatconvert-dev.yourdomain.com
cloudflared tunnel --url http://localhost:3000 run chatconvert-dev
```

### Relative vs absolute `[app_proxy].url`

Shopify documents both forms. A relative `/proxy` is *supposed* to be prefixed with `application_url` automatically. **In practice we could not get the relative form to resolve** — deployed relative URLs produced storefront 500s with no request ever reaching the tunnel. Use the **absolute** form and keep it in sync with the tunnel host.

### The application_url deploy trap

Two `[build]` settings pull in opposite directions:

| Setting | Effect |
|---|---|
| `automatically_update_urls_on_dev = true` | While `shopify app dev` runs, the app URL + redirect URLs are updated **on Shopify's side only**. It does **not** edit your local `shopify.app.toml`. |
| `include_config_on_deploy = true` | `npm run deploy` publishes `shopify.app.toml` **verbatim** — overwriting what `dev` set remotely |

So the toml can sit at `https://example.com` forever while dev works fine, and then one `npm run deploy` publishes `example.com` as the real app URL. **Before any deploy, make sure `application_url` is a reachable host.**

Before a real production deploy, `application_url` and `auth.redirect_urls` must point at your actual hosted domain, not a tunnel. Set `automatically_update_urls_on_dev = false` once you have production hosting so a stray `dev` run can't overwrite them.

### Reading Shopify's *actual* registered config

Do not infer it from what you deployed — ask Shopify. This is the single most useful debugging move:

```bash
cp shopify.app.toml /tmp/mine.toml            # config link OVERWRITES the file
shopify app config link --client-id <client_id>
grep -E "application_url|^url|subpath|prefix" shopify.app.toml
cp /tmp/mine.toml shopify.app.toml            # restore your version
```

The app proxy also requires the **`write_app_proxy`** access scope, which is in `[access_scopes]`. Removing it silently breaks every widget request.

### Optional — localhost, no tunnel

```bash
npm run dev -- --use-localhost          # reverse proxy on port 3458, override with --localhost-port
```

Fastest startup. But Shopify can't reach you, so **webhooks and the app proxy don't work** — meaning the chat widget doesn't work. Good for admin UI work only.

### Enabling the widget on the storefront

The proxy subpath is **`ccwidget`** (`prefix = "apps"`), so the storefront path is `/apps/ccwidget/*`. It's wired in three places that must agree: `shopify.app.toml`, `extensions/chat-widget/blocks/chat-widget.liquid` (`data-proxy-base`), and the fallback in `assets/chat-widget.js`.

1. `npm run deploy` — registers the `chat-widget` theme app extension
2. **Uninstall and reinstall** the app on the store (see the pinning rule above)
3. Shopify admin → **Online Store → Themes → Customize**
4. **App embeds** → enable **ChatConvert Chat Widget** → Save (uninstalling clears this)
5. View the storefront — the launcher appears bottom-right

Sanity-check the proxy end to end:

```bash
curl -i https://your-store.myshopify.com/apps/ccwidget/ping          # -> 200 text/event-stream
curl -s https://your-store.myshopify.com/apps/ccwidget/widget-config # -> 200 application/json
```

| Result | Meaning |
|---|---|
| **200** + SSE / JSON | working |
| **500** + a page of theme HTML | proxy registered, destination dead → stale install-time record |
| **404**, empty body | no proxy registered for that subpath on this store |

### SSE streaming through the tunnel — verified working

**Measured 2026-08-07 on a Cloudflare quick tunnel: SSE streams correctly, it is not buffered.** `/apps/ccwidget/ping` returned frames at `11:05:08.266`, `11:05:08.767`, `11:05:09.267` — ~500ms apart, exactly as emitted.

So the fallback transport seam (`window.__ccDirectStream`, spec `01-foundation.md`) is **not needed** for local development. The template README's warning about Cloudflare buffering response streams did not reproduce here.

To re-check after any transport change, load any storefront page with `?ccprobe=1` and watch the console: `[ChatConvert probe]` frames ~500ms apart = streaming; all at once = buffered.

---

## Command reference

| Command | What it does |
|---|---|
| `npm run dev` | Shopify CLI dev — auth, env vars, tunnel, config sync. Press **P** for the app URL |
| `npm run db:up` / `db:down` | Start/stop dev Postgres (Docker, pgvector, port 5433) |
| `npm run setup` | `prisma generate && prisma migrate deploy` |
| `npm run migrate:new -- --name x` | The **only** safe way to create a migration |
| `npx prisma db seed` | Seed the dev shop from `.claude/resources/demo/data-sources/` |
| `npx prisma studio` | DB browser on port 5555 |
| `npm run deploy` | Deploy app config + extensions (creates & releases an app version) |
| `npm run generate` | Scaffold a new extension |
| `npm run graphql-codegen` | Regenerate GraphQL types into `app/types/` |
| `npm run build` | Production build (`react-router build`) |
| `npm run typecheck` | `react-router typegen && tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run smoke` | pgvector, hybrid/keyword search, curated match, RAG |
| `npm run widget:size` | Widget bundle size gate (≤30KB gz) |
| `shopify app config validate --json` | Validate `shopify.app.toml` before dev/deploy |

### Before you commit

```bash
npm run typecheck && npm run lint && npm run build
npm run smoke
npm run widget:size
npx tsx scripts/eval-golden.ts     # 9-case AI golden set (needs OPENAI_API_KEY)
```

Other verification scripts in `scripts/`: `verify-compliance.ts`, `test-analytics.ts`, `test-billing-mock.ts`, `test-campaign-metrics.ts`, `test-campaign-triggers.ts`, `test-ingest.ts`.

There is no unit test suite — verification is these scripts plus the acceptance criteria in each spec.

---

## Environment variables

`.env` (see `.env.example`). The Shopify CLI injects `SHOPIFY_API_KEY` and friends during `npm run dev` — don't add those yourself.

| Var | Purpose |
|---|---|
| `DATABASE_URL` | `postgresql://chatconvert:chatconvert@localhost:5433/chatconvert` |
| `OPENAI_API_KEY` | LLM + embeddings. Seeding works without it; the pipeline doesn't |
| `LLM_PROVIDER` / `CHAT_MODEL` / `EMBEDDING_MODEL` | Defaults: `openai` / `gpt-4o-mini` / `text-embedding-3-small` |
| `BILLING_TEST_MODE=1` | Mock the Shopify Billing API for offline testing |
| `BILLING_FORCE_TEST_CHARGES=1` | Force `test: true` charges (app review / partner test stores) |
| `EMBED_STATUS_ENABLED=1` | Theme embed detection — needs the `read_themes` scope, not requested yet |
| `PRISMA_CLIENT_ENGINE_TYPE=binary` | Windows only, see troubleshooting |

---

## Project layout

```
app/
  routes/app.*.tsx        embedded admin pages (Polaris <s-*> web components)
  routes/proxy.*.tsx      app-proxy endpoints the storefront widget calls
  routes/webhooks.*.tsx   webhook handlers — enqueue-only, never do work inline
  routes/auth.*           OAuth / login
  lib/                    tenancy, llm, embeddings, search, pipeline, ingestion, jobs, sse
  shopify.server.ts       central Shopify setup — all auth + Admin GraphQL goes through here
  db.server.ts            Prisma singleton
extensions/chat-widget/
  blocks/chat-widget.liquid   app embed block (sets data-proxy-base="/apps/ccwidget")
  assets/                     widget JS/CSS
prisma/                   schema + migrations (custom vector/GIN SQL lives in migration files)
shopify.app.toml          scopes, webhooks, app proxy, declarative custom data
scripts/                  smoke + verification scripts
```

### Rules that bite if ignored

- **Every DB query is shop-scoped by `shopId`.** No exceptions.
- **Webhook handlers enqueue only** — fast (<10ms), all work happens in pg-boss jobs.
- **LLM keys are server-only.** Never reach a loader's client payload.
- Prompts and thresholds come from their canonical locations only (`app/lib/pipeline/prompts.ts` is frozen).
- Plan gates are enforced server-side. Currently in **ALLOW-ALL** mode — flip `ENFORCEMENT` in `app/lib/billing/plans.server.ts` when tiers are final.

### Embedded-app gotchas

The app runs in an iframe, so ordinary browser navigation breaks the session:

1. Use `Link` from `react-router` (or Polaris) — **never** `<a>`
2. Use the `redirect` helper returned by `authenticate.admin` — **not** `redirect` from `react-router`
3. Use `useSubmit` from `react-router` for form submissions

---

## Troubleshooting

### `query_engine-windows.dll.node is not a valid Win32 application`

Set `PRISMA_CLIENT_ENGINE_TYPE=binary` in `.env`. Forces the binary engine, which runs the query engine as a separate process and works under Windows ARM64 emulation.

### `The table ... does not exist`

Postgres is up but unmigrated: `npm run setup`.

### Widget doesn't appear on the storefront

In order: (1) is the app embed enabled in the theme editor? (2) did you `npm run deploy` at least once so the extension exists? (3) is `npm run dev` running?

### The app version / app URL still says `example.com`

`npm run deploy` published the toml verbatim while `application_url` was still the placeholder. `shopify app dev` never edits the local file — it only updates Shopify's copy. Put the live tunnel host in `application_url` yourself, then deploy. See [the deploy trap](#the-application_url-deploy-trap).

### Storefront shows "There was an error in the third-party application"

Shopify **is** routing `/apps/ccwidget/*` to the app proxy, but the destination is unreachable.

**The cause is almost always a stale install-time record** — the store is still dispatching to whatever `[app_proxy].url` said when the app was last *installed* (often the `example.com` placeholder, or a dead tunnel host). Fix `[app_proxy].url`, `npm run deploy`, then **genuinely uninstall and reinstall** the app. See [the pinning rule](#-the-one-rule-a-store-pins-the-app-proxy-at-install-time).

#### Proving where the requests actually go

This is the technique that cracked it. cloudflared's counter increments for every request that reaches your machine:

```bash
curl -s http://127.0.0.1:20241/metrics | grep cloudflared_tunnel_total_requests
curl -s -o /dev/null https://<your-store>.myshopify.com/apps/ccwidget/ping
curl -s http://127.0.0.1:20241/metrics | grep cloudflared_tunnel_total_requests
```

| Counter | Meaning |
|---|---|
| **unchanged** | Shopify is dispatching somewhere other than your tunnel → stale install-time record |
| **incremented** | the request reached your app → fault is in the route or signature; check the dev server log |

Two more diagnostics worth knowing:

- **Is a proxy registered at all?** `/apps/some-unconfigured-subpath/x` → **404**. A registered-but-broken one → **500** with a page of theme HTML. Deploy a throwaway subpath and see which you get: a 404 proves the store never picked up your config.
- **Can Shopify reach you at all?** Webhooks use a different path than the proxy, so they isolate network problems from proxy-config problems:
  ```bash
  shopify app webhook trigger --topic=products/update --api-version=2026-07 \
    --delivery-method=http --address=https://<host>.trycloudflare.com/webhooks/products
  ```
  Counter moves → the network is fine and the fault is purely proxy configuration.

Response headers are informative too: `server-timing: ...render;dur=36...` with ~99ms total means Shopify rendered its error page without ever attempting an outbound HTTP call.

### Widget appears but every request 404s

Check, in order:

A **404** (empty body) means no proxy is registered for that subpath *on this store*. Check, in order:

1. `[app_proxy].subpath` matches `data-proxy-base` in `chat-widget.liquid` (both should be `ccwidget`)
2. `[app_proxy].url` is absolute and ends in `/proxy`, pointing at the **live** tunnel host
3. `write_app_proxy` is in `[access_scopes]`
4. You ran `npm run deploy` **and then genuinely uninstalled + reinstalled** the app — a scope re-authorization prompt is *not* sufficient
5. Verify Shopify's registered config with `shopify app config link` (see [Reading Shopify's actual registered config](#reading-shopifys-actual-registered-config))

### Chat replies arrive all at once instead of streaming

Not expected — SSE was verified streaming correctly through a Cloudflare quick tunnel on 2026-08-07 (frames ~500ms apart). If you see batching, check the transport before blaming the tunnel, then confirm with `?ccprobe=1` on any storefront page.

### Theme extension edits aren't showing up

Hard-refresh (`Ctrl+Shift+R`). If you edited `shopify.extension.toml`, restart `npm run dev`.

### Webhook subscriptions aren't updating

They're declared app-specific in `shopify.app.toml`, so they sync on `npm run deploy` — not via `afterAuth`/`registerWebhooks`.

### `admin` is undefined in a CLI-triggered webhook

Expected. `shopify app webhook trigger` uses a valid but non-existent shop, so there's no session to build an `admin` client from. Test with real events from your dev store instead.

### `"nbf" claim timestamp check failed`

Your machine clock drifted. Enable "Set time and date automatically".

### Port 5433 already in use

Something else is on it (a local Postgres?). The compose file deliberately maps `5433:5432` to avoid the default; change the host side in `docker-compose.yml` and `DATABASE_URL` together if you must.

---

## Resources

- [Networking options for local development](https://shopify.dev/docs/apps/build/cli-for-apps/networking-options)
- [App proxies and dynamic data](https://shopify.dev/docs/apps/build/online-store/app-proxies)
- [Theme app extensions](https://shopify.dev/docs/apps/build/online-store/theme-app-extensions)
- [App configuration (`shopify.app.toml`)](https://shopify.dev/docs/apps/build/cli-for-apps/app-configuration)
- [Shopify App React Router](https://shopify.dev/docs/api/shopify-app-react-router)
- [Polaris web components](https://shopify.dev/docs/api/app-home/polaris-web-components)
- [React Router docs](https://reactrouter.com/home)
