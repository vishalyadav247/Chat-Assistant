# ChatConvert — deployment

Everything about running this app outside your laptop: the daily dev loop, the
release loop, and the one-time server build.

**Production:** `root@159.89.173.131` (DigitalOcean, `shopify-public-apps`) ·
app dir `/var/www/chatconvert.progryss.com/html` · port **3003** ·
https://chatconvert.progryss.com

Commands run **on the droplet as root** unless the heading says otherwise.
Surveyed 2026-08-27; re-check [Part 3](#part-3--first-time-server-build) before
following this on a different box.

## Which part do you need?

| You want to | Go to |
|---|---|
| Ship a change that already works locally | [Part 1 — Routine release](#part-1--routine-release) |
| Develop and test without pushing | [Part 2 — Local development](#part-2--local-development) |
| Build the server from nothing | [Part 3 — First-time server build](#part-3--first-time-server-build) |
| Fix something that is broken | [Troubleshooting](#troubleshooting) |

Part 3 is a one-time job. If the app is already running, you never open it.

## Cheat sheet

**Every dev session**

```powershell
npm run db:up            # Docker Postgres on 5433 — dev:tunnel does NOT start it
cloudflared tunnel --url http://localhost:3000 --metrics 127.0.0.1:20241
npm run dev:tunnel
npm run dev:push-proxy   # only if the cloudflared hostname changed
npm run dev:stop         # when done
```

**Promoting to production**

```powershell
npm run release -- "what changed"
#   merge the PR on GitHub
npm run release:sync
```
```bash
bash scripts/deploy.sh                      # on the droplet — SERVER FIRST
```
```powershell
npm run config:use -- shopify.app.toml      # then the widget
npm run config:which                        # must say PRODUCTION
npm run deploy:prod -- "what changed"
npm run config:use -- dev                   # switch back, always
```

**Server before widget.** A new widget calling an endpoint the server does not
have yet breaks for shoppers immediately; a new server with the old widget is
almost always fine, because endpoint changes are additive.

**Switch back to dev.** Left on the production config, the next `npm run dev`
runs against the live app and rotates the real store's access token — the cause
of 21x 401 `embed_status_error` on 2026-08-27.

**Neither deploy is always needed:**

| Changed | `deploy.sh` | `deploy:prod` |
|---|---|---|
| `app/**`, `prisma/**` only | yes | no |
| `extensions/**` | no | yes |
| `shopify.app.toml` | no | yes — run `npm run config:diff` first |
| docs only | no | no |


---

# Part 1 — Routine release

`main` is what production runs. Never commit to it directly — the droplet pulls it.

```
dev  ──commit──►  push origin dev  ──►  PR  ──►  merge to main  ──►  pull on server
```

## Three destinations, three commands

A file only reaches production through **its own** path:

| What changed | Ends up on | Gets there via | Run from |
|---|---|---|---|
| `app/**`, `prisma/**` | your droplet | `bash scripts/deploy.sh` | the server |
| `extensions/**` | Shopify's CDN | `npm run deploy:prod` | your laptop |
| `shopify.app.toml` | the Shopify app record | `npm run deploy:prod` | your laptop |

Pulling on the droplet does nothing for the widget — Shopify hosts it.
`shopify app deploy` never touches your server. Server first, then widget: a new
widget calling a missing endpoint breaks shoppers immediately; the reverse is
safe.

### Which app are you pointed at?

```powershell
npm run config:which        # then: npm run config:use -- shopify.app.toml | dev
```

**The selection is machine-local CLI state, absent from git**, so it never shows
in a diff and stays on the **dev** app after every dev session. An unguarded
`npm run deploy` then publishes *chatConvert2* — no error, no warning, merchants
get nothing.

`npm run deploy:prod` closes that: it re-checks the active config, pins
`--client-id`, and refuses if a `trycloudflare`/`ngrok`/`localhost` URL has leaked
into `shopify.app.toml`.

| | Dev | Production |
|---|---|---|
| Command | `npm run dev:push-proxy` | `npm run deploy:prod` |
| When | tunnel hostname changed | `extensions/**` or `shopify.app.toml` changed |
| Never for | — | changes confined to `app/**` |

## The short version

Commands are in the [cheat sheet](#cheat-sheet). What they do:

**`npm run release`** — merges `origin/main` into `dev`, runs typecheck and lint,
commits, pushes `dev`, opens the PR compare view. It stops before merging: that
review is the last place a stray secret or unwanted migration is caught. Nothing
is pushed if a check fails. **`npm run release:sync`** afterwards levels local
`main` and `dev` with the remote.

**`scripts/deploy.sh`** — pulls `main`, runs only the stages the diff needs,
restarts pm2, then **proves the app answers on its port** before reporting
success. Refuses a dirty tree or a branch other than `main`; prints the rollback
command if the health check fails. You never judge what to rebuild:

| Changed files | `npm ci` | `npm run setup` | `npm run build` | restart |
|---|---|---|---|---|
| `package-lock.json` | yes | yes | yes | yes |
| `prisma/**` | no | yes | yes | yes |
| any other source | no | no | yes | yes |
| only `docs/`, `.claude/`, `scripts/qa/`, `*.md` | no | no | no | **no** |

`--force` rebuilds everything even when git reports nothing new.

## The long version

### Step 1 — work on `dev`

```bash
git checkout dev
git pull origin dev
# ... make changes ...
npm run typecheck && npm run lint
git add -A
git commit -m "what changed and why"
git push origin dev
```

### Step 2 — open the PR

`gh` is not installed, so use the browser:

**https://github.com/progryss/chatconvert/compare/main...dev**

Review the diff there before merging — that view is the last chance to catch a
secret, a stray file, or a migration that should not ship yet.

### Step 3 — merge to `main`

Merge in the GitHub UI. Then bring your local copy in line:

```bash
git checkout main
git pull origin main
git checkout dev
git merge main          # keeps dev level with main, avoids drift
git push origin dev
```

Mirror to the personal remote when you want it:

```bash
git push personal main
```

### Step 4 — deploy to the server

```bash
cd /var/www/chatconvert.progryss.com/html
bash scripts/deploy.sh
```

Scope: stay inside `/var/www/chatconvert.progryss.com/`. Outside it this app owns
only its nginx site file, its pm2 entry (`chatconvert`) and its database. Never
touch the other apps on this box.

The sequence the script runs, when every stage is needed:

```bash
git pull --ff-only origin main
npm ci
sed -i 's/$//' .env                          # only when CRLF is present
( set -a; . ./.env; set +a; npm run setup )    # prisma generate && migrate deploy
npm run build
pm2 restart chatconvert
```

> **`npm run setup`, not bare `migrate deploy`.** `npm ci` deletes `node_modules`
> and the generated Prisma client with it, and this repo's `.npmrc` does not
> reliably re-run Prisma's postinstall. Skipping generate caused the 2026-08-27
> outage: build succeeded, pm2 said `online`, nothing listened on 3003, and the
> only clue was `@prisma/client did not initialize yet`. Generate **before**
> build, so the build compiles against the client that exists at runtime.

The last stage matters: it polls `http://127.0.0.1:$PORT/` for 45s and accepts
**any** HTTP status — the failure it hunts is `000`, a refused connection, which
is exactly what a green `pm2 list` hides. On failure it dumps the last 40 error
lines and prints the rollback command.

By hand:

```bash
curl -I https://chatconvert.progryss.com/
pm2 list | grep chatconvert          # a climbing restart counter = failed deploy
```

## What never goes in that loop

- **`npm run deploy:prod`** (and bare `npm run deploy`) — publishes a Shopify
  app version to merchants and can repoint the app-proxy URL that stores pin at
  install time. A release decision, run by hand from your laptop, never by the
  server. Always the `:prod` form: it verifies which app is selected first.
- **`npx prisma db seed`** — development fixtures only.
- **`pm2 delete` + `pm2 start`** — only when the process definition itself must
  change (a new `ecosystem.config.cjs`, or a poisoned cached environment).
  A plain `pm2 restart` re-runs the app with its existing definition.

## If a deploy has to be rolled back

The database is the part that does not roll back. Code is easy:

```bash
cd /var/www/chatconvert.progryss.com/html
git log --oneline -5          # find the last good commit
git checkout <sha>
npm ci && npm run build
pm2 restart chatconvert
```

Migrations are forward-only — `migrate deploy` never reverts. If a release adds
a destructive migration, that is the one to think hard about *before* merging the
PR, not after.

---

# Part 2 — Local development

You do not push to see a change. Everything runs on your machine; the release
loop above is only for shipping something you have already tested.

## One-time setup

**1. A separate Shopify app.** Never run `shopify app dev` against
`shopify.app.toml` — it rewrites the production URLs to a throwaway tunnel and
rotates the live store's access token (21 x 401 `embed_status_error` in
production, 2026-08-27).

```powershell
npm run config:link          # name it "dev" -> creates shopify.app.dev.toml
npm run config:use -- dev
```

Set `automatically_update_urls_on_dev = true` in `shopify.app.dev.toml` (the dev
app *should* follow the tunnel); in `shopify.app.toml` it stays `false`, forever.
`shopify.app.*.toml` is gitignored, so a dev config can never be mistaken for
production. `npm run config:diff` compares scopes, webhooks and custom data
between the two, ignoring the URLs and client id that are meant to differ — run
it before promoting anything that touched `shopify.app.toml`.

**2. The database.** Postgres + pgvector in Docker on port 5433:

```powershell
npm run db:up
npm run setup                # prisma generate && migrate deploy
npx prisma db seed           # demo shop + catalog; no OpenAI key needed
```

**3. `.env`.** Copy `.env.example`, point `DATABASE_URL` at
`postgresql://chatconvert:chatconvert@localhost:5433/chatconvert`. Yours alone —
never the server's `.env`.

## The app proxy — the expensive one to get wrong

The widget reaches the app **only** through `/apps/ccwidget` (hardcoded in
`extensions/chat-widget/blocks/chat-widget.liquid`). Every symptom looks like a
broken widget; it is a routing gap.

- **`shopify app dev` does not manage `[app_proxy].url`.** It rewrites
  `application_url` and `redirect_urls` only. `sync-dev-urls.cjs` (run by
  `dev:tunnel`) fixes the local file — but Shopify does not route on that file.
- **A plain `shopify app deploy` does not push it either.** The CLI strips
  `include_config_on_deploy` after every deploy; without that key a deploy ships
  the *extension* and silently drops the app configuration. Two releases
  (`chatconvert2-3`, `-4`) were burned discovering this.

So whenever the tunnel hostname changes — every cloudflared restart:

```powershell
npm run dev:push-proxy
```

It re-adds the key, deploys `--config dev`, and refuses if
`shopify.app.dev.toml` carries the production client id. Manual equivalent: Dev
Dashboard → App setup → App proxy, prefix `apps`, subpath `ccwidget`, URL
`https://<current-tunnel-host>/proxy`.

> **ngrok would end the churn but cannot be used.** A reserved domain never
> changes, so the proxy URL would be set once — but ngrok's free tier serves an
> interstitial to any browser User-Agent (`ERR_NGROK_6024`) and Shopify forwards
> the shopper's real UA. Verified: curl UA → 400 (the app); browser UA →
> `ERR_NGROK_6024`; browser UA + `ngrok-skip-browser-warning` → still the
> interstitial. Fixes: a paid plan, or a stable cloudflared named tunnel.

### Telling the two 404s apart

They look identical in the network tab. Read the response headers:

```bash
curl -s -D - -o /dev/null "https://<dev-store>.myshopify.com/apps/ccwidget/widget-config?t=1"
```

| Response | Meaning | Fix |
|---|---|---|
| `200 application/json` | Working | — |
| `500` | Routing to a dead tunnel — the hostname changed | `npm run dev:push-proxy` |
| `404`, `powered-by: Shopify`, `Content-Length: 0` | **Shopify never forwarded it.** The proxy URL is wrong or missing on the released app version. Nothing about your code is involved | `npm run dev:push-proxy` |
| `404` with body `app not installed` | It reached your app; `authenticate.public.appProxy` found no session for that shop | Reinstall the app on that store |
| `400` / `401` | It reached your app and the proxy signature was rejected — **expected** for a hand-made request without one | nothing; this means the app is healthy |

To prove the app itself is healthy independently of Shopify, sign a proxy
request yourself: HMAC-SHA256 the sorted `key=value` params (no separator) with
the app's client secret and pass it as `signature`. A 200 from that means every
part except Shopify's routing is correct.

## The daily loop

```powershell
npm run db:up            # Docker Desktop must be running; dev:tunnel does NOT do this
npm run dev              # admin-only work
```

Vite hot-reloads on save. For anything involving the storefront widget, use the
tunnel instead — leave cloudflared running all day in its own window:

```powershell
cloudflared tunnel --url http://localhost:3000 --metrics 127.0.0.1:20241
npm run dev:tunnel       # stops orphans, refreshes Prisma, points the dev toml at the tunnel
npm run dev:push-proxy   # only if the hostname changed since last time
npm run dev:stop         # when done
```

Skipping `db:up` fails late and confusingly — the app boots and only the first
query reports `Can't reach database server at localhost:5433`.

Always `dev:stop`: `shopify app dev` spawns a child Vite process that survives
Ctrl-C on Windows, and each orphan locks the Prisma query engine, which is what
makes a later `prisma generate` fail with EPERM. It deliberately does **not**
kill other project node processes (`eval:golden`, a QA suite, prisma studio) —
it names them instead, since those hold the same lock.

## Checking your work without a browser

| Command | What it proves |
|---|---|
| `npm run typecheck` | Types across the whole app |
| `npm run lint` | ESLint |
| `npm run smoke` | pgvector, hybrid + keyword search, curated match, RAG |
| `npm run eval:golden` | The AI pipeline against the golden question set |
| `npm run widget:size` | The storefront bundle is inside its gzip budget |
| `npm run logs:check` | That no PII leaked into `app_logs` |
| `npx tsx scripts/qa/<suite>.test.ts` | One QA suite; cases are in `scripts/qa/TEST-CASES.md` |
| `npm run trace` | One chat turn end to end, with timings |

`scripts/qa/BROWSER-TEST-PLAN.md` has the 60 manual checks for anything that
needs a real storefront.

## The two rules

- **Never run `npm run dev` with the production config selected.** Check with
  `npm run config:use` (no argument) and look at which file it names. If
  `shopify.app.toml` ever comes back from a dev session with a
  `trycloudflare.com` URL in it, discard that change — do not commit it.
- **Before publishing to merchants**, confirm which app is selected with
  `npm run config:which`, switch with `npm run config:use -- shopify.app.toml`,
  and publish with `npm run deploy:prod` — which checks again and refuses a
  mismatch.

---

# Part 3 — First-time server build

**One-time. If the app is already running, you are in the wrong part.**

Run each command, check the **Expect** line, move on. The blockquotes explain
why a step exists — read one when a command surprises you.

## Target environment

| | |
|---|---|
| OS | Ubuntu 24.04.4 LTS |
| Node | v22.23.2 (global, shared with the other apps) |
| Postgres | 16.15, port 5432 |
| pgvector | **0.6.0, already installed** |
| nginx | 1.24.0 |
| Process manager | pm2 v7.0.3, `pm2-root.service`, fork mode |
| App directory | `/var/www/chatconvert.progryss.com/html` |
| Public URL | https://chatconvert.progryss.com |
| Port | 3003 (3000/3001/3002 are taken) |
| Memory | 1.9 GB total, ~1.0 GB available, 2 GB swap |

### Already in place — do not redo

- **pgvector 0.6.0** is installed at the OS level. Verified sufficient: the migrations use
  `USING hnsw (vector_cosine_ops)` and `vector(1536)`, with no `halfvec`/`sparsevec`.
- **TLS** for `chatconvert.progryss.com` is issued and auto-renewing via certbot.
- **nginx site** exists and already proxies to `localhost:3003` — but its location block
  needs fixing before the app works (Part G).
- **Swap** — 2 GB already configured.
- **Node 22.23.2** satisfies the `>=22.12` engine requirement. Do not upgrade the global
  Node; the other three apps run on it.
- **SSH key auth** to `root@159.89.173.131` is working.

### Conventions this follows

Matching `seoconvert`, the sibling app built from the same template:

- App lives at `/var/www/<domain>/html`, a git clone
- Runs as **root** under the existing pm2 daemon
- Secrets in `<app>/.env`, `chmod 600` — and `.env` is gitignored, so `git pull` never
  touches it

**One deviation.** `seoconvert` depends on `dotenv`; this app does not, and nothing in it
reads `.env` at runtime. So the file is loaded by Node itself with `--env-file` (Part F).
A `.env` sitting beside the app would otherwise be **silently ignored** and the app would
refuse to boot with `Invalid environment: DATABASE_URL is required`.

### Fill these in before you start

| Placeholder | Where it comes from |
|---|---|
| `DB_PASSWORD` | Generated in command 2 — save it, you paste it 4 times |
| `SHOPIFY_SECRET` | Partner Dashboard → your app → API credentials |
| `OPENAI_KEY` | platform.openai.com |
| `RESEND_KEY` | resend.com → API Keys (or skip — see command 14) |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Your choice — the `/platform` operator login |

---

## Part A — Database

### 1. Move to a directory postgres can read

```bash
cd /tmp
```

*`sudo -u postgres` cannot read `/root`, and running there prints a
`could not change directory` warning that looks like a failure but isn't.*

### 2. Generate the database password

```bash
openssl rand -hex 24
```

**Expect:** 48 hex characters. **Save this now** — it becomes `DB_PASSWORD`.

*Hex on purpose: no `@`, `/` or `#` to break the connection string.*

### 3. Create the role and database

Replace `DB_PASSWORD` with the string from command 2.

```bash
sudo -u postgres psql <<'SQL'
CREATE ROLE chatconvert LOGIN PASSWORD 'DB_PASSWORD';
CREATE DATABASE chatconvert OWNER chatconvert;
SQL
```

**Expect:** `CREATE ROLE` then `CREATE DATABASE`.

> The role must **own** the database, not merely have rights on it: pg-boss builds
> its own `pgboss` schema there at boot.

### 4. Enable pgvector

```bash
sudo -u postgres psql -d chatconvert -c 'CREATE EXTENSION IF NOT EXISTS vector;'
```

**Expect:** `CREATE EXTENSION`.

> `CREATE EXTENSION` requires superuser. Migration `20260806000000_init` contains
> the same statement, but Prisma runs it as the unprivileged `chatconvert` role and
> would fail. Creating it here first turns that line into a harmless no-op.

### 5. Grant schema rights

```bash
sudo -u postgres psql -d chatconvert -c 'GRANT ALL ON SCHEMA public TO chatconvert;'
```

**Expect:** `GRANT`.

### 6. Verify the extension

```bash
sudo -u postgres psql -d chatconvert -c '\dx'
```

**Expect:** a row `vector | 0.6.0`.

### 7. Verify the exact connection string the app will use

Replace `DB_PASSWORD` again.

```bash
psql "postgresql://chatconvert:DB_PASSWORD@localhost:5432/chatconvert" -c 'SELECT current_user, current_database();'
```

**Expect:** `chatconvert | chatconvert`.
**If this fails, stop.** `DATABASE_URL` will not work either.

---

## Part B — Code

### 8. Go to the site directory

```bash
cd /var/www/chatconvert.progryss.com
```

### 9. Park the hello-world files

```bash
mv html html-helloworld-backup
```

*Keep this backup until the deploy is proven. Deleted in command 46.*

### 10a. Create a deploy key on the droplet

The repo is **private**, and the droplet has no GitHub credentials. A deploy key is
read-only and scoped to this one repo — it cannot reach your other repos, and it does not
expire the way a token does. (`seoconvert` uses an HTTPS remote; a deploy key is preferred
here because nothing has to store a token that can expire or leak.)

```bash
ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519 -C "droplet-chatconvert"
```

**Expect:** `Your identification has been saved`.
This is the droplet's *outbound* key to GitHub. It is separate from `authorized_keys`, so
your own SSH access is unaffected.

### 10b. Print the public key

```bash
cat ~/.ssh/id_ed25519.pub
```

Copy the whole line.

### 10c. Register it on GitHub

In a browser: `github.com/progryss/chatconvert` → **Settings** → **Deploy keys** →
**Add deploy key**. Title it `droplet`, paste the key.

**Leave "Allow write access" unchecked** — the droplet only ever pulls.

### 10d. Trust github.com and test

```bash
ssh-keyscan github.com >> ~/.ssh/known_hosts
ssh -o BatchMode=yes -T git@github.com
```

**Expect:** `Hi progryss/chatconvert! You've successfully authenticated, but GitHub does
not provide shell access.`
That message **is** success — GitHub never gives a shell.

**If you see `Permission denied (publickey)`, stop.** The key is not registered yet; redo
10c.

### 10e. Clone

```bash
git clone git@github.com:progryss/chatconvert.git html
```

**Expect:** `Resolving deltas: 100% ... done.`

### 11. Enter the app directory

```bash
cd /var/www/chatconvert.progryss.com/html
```

### 12. Confirm you have the latest commit

```bash
git log --oneline -1
```

**Expect:** the newest commit from `origin/main`.

---

## Part C — Environment

### 13. Open the env file

```bash
nano .env
```

### 14. Paste this, then fill in the 4 blanks

```ini
NODE_ENV=production
PORT=3003

DATABASE_URL=postgresql://chatconvert:DB_PASSWORD@localhost:5432/chatconvert?schema=public

# Shopify — the CLI injects these in dev; in production you set them yourself.
# Must equal client_id in shopify.app.toml (the production app record).
# Verify: grep client_id shopify.app.toml
SHOPIFY_API_KEY=6b2bcbe0ed1fc4b0600f96acc4f0eb72
SHOPIFY_API_SECRET=SHOPIFY_SECRET
SHOPIFY_APP_URL=https://chatconvert.progryss.com
SCOPES=read_content,read_customers,write_customers,read_discounts,read_legal_policies,read_online_store_pages,read_orders,read_products,read_themes,write_app_proxy,write_files

# LLM
OPENAI_API_KEY=OPENAI_KEY
LLM_PROVIDER=openai
CHAT_MODEL=gpt-4o-mini
EMBEDDING_MODEL=text-embedding-3-small

# Email — use EMAIL_PROVIDER=log to defer this
EMAIL_PROVIDER=resend
RESEND_API_KEY=RESEND_KEY
EMAIL_FROM="ChatConvert <no-reply@progryss.com>"
```

Save with `Ctrl+O`, `Enter`, then `Ctrl+X`.

> **Keep the quotes on `EMAIL_FROM`** — without them `<` is a shell redirect in
> command 21. `SCOPES` must match `shopify.app.toml` verbatim. Everything else in
> `.env.example` is optional: the operator sets it at `/platform`, and the dashboard
> value wins. No Resend account yet? `EMAIL_PROVIDER=log`, blank `RESEND_API_KEY`.

### 15. Strip Windows line endings — do not skip

```bash
sed -i 's/\r//g' .env
```

> Pasting into `nano` from a Windows clipboard writes CRLF, which glues an invisible `\r`
> onto **every value**. `LLM_PROVIDER` becomes `"openai\r"` and fails loudly; but
> `DATABASE_URL` and `SHOPIFY_API_SECRET` are corrupted just as badly and pass validation
> *silently*. Run this even when you are sure the file is clean.

### 16. Verify zero carriage returns

```bash
grep -c $'\r' .env
```

**Expect: `0`. Do not continue until it is.**

### 17. Lock permissions and confirm the format

```bash
chmod 600 .env
file .env
ls -l .env
```

**Expect:** `ASCII text` with no mention of CRLF, then `-rw------- 1 root root`.

### 18. Prove the values parse — without exporting them

```bash
node --env-file=.env -e "for (const k of ['LLM_PROVIDER','EMAIL_PROVIDER','PORT','DATABASE_URL']) console.log(k.padEnd(14), JSON.stringify(process.env[k]));"
```

**Expect** the closing quote immediately after each value:

```
LLM_PROVIDER   "openai"
EMAIL_PROVIDER "resend"
PORT           "3003"
DATABASE_URL   "postgresql://chatconvert:...@localhost:5432/chatconvert?schema=public"
```

> Deliberately **not** `set -a; . ./.env`. Sourcing exports these into your shell, and
> `pm2 start` snapshots your shell — so one bad value gets frozen into pm2's process
> definition where `--env-file` can never override it.

---

## Part D — Build

### 19. Install dependencies

```bash
npm ci
```

**Expect:** `added ~900 packages`. Takes a few minutes.

> A **full** `npm ci`, not `--omit=dev`: `vite` and `typescript` are devDependencies
> and the build needs them, as does `tsx` in command 34.

### 20. Build

```bash
npm run build
```

**Expect:** `✓ built in ~5s`, then `build/client` and `build/server` written.

> **Memory.** ~1.0 GB free, and this build is the app's biggest spike. A silent
> death is the OOM killer — retry with
> `NODE_OPTIONS=--max-old-space-size=1024 npm run build`, watching `free -h` in a
> second session. Still failing: build on your laptop and `rsync` `build/` up.

**Do not run `npx prisma db seed`.** That loads demo-shop fixtures; it is a
development tool only.

---

## Part E — Migrations

### 21. Run the migrations in a subshell

```bash
( set -a; . ./.env; set +a; npx prisma generate && npx prisma migrate deploy )
```

**Expect:** `Generated Prisma Client`, then `27 migrations found` …
`All migrations have been successfully applied.`

`migrate deploy` only applies — it never resets or drops.

> **The parentheses are load-bearing.** They run this in a subshell, so the exported
> variables die with it and can never be captured by `pm2 start` in command 23. Without
> them, one malformed value in `.env` is frozen into pm2's process definition, survives
> every `pm2 restart`, and the app crash-loops while `.env` looks perfectly correct.

### 22. Verify the schema

```bash
( set -a; . ./.env; set +a; npx prisma migrate status )
```

**Expect:** `Database schema is up to date!`

---

## Part F — Run it

### 23. Start under pm2

```bash
pm2 start ecosystem.config.cjs
```

**Expect:** a pm2 table with `chatconvert` · `online` · `fork` mode.

> `ecosystem.config.cjs` ships in the repo — nothing to mistype. Paths derive from
> `__dirname`, it carries **no secrets**, and it wires `.env` through node's
> `--env-file`. This app has no `dotenv`; without that wiring the process dies with
> `Invalid environment: DATABASE_URL is required` while `.env` sits right there.
> It mirrors `zipeta`'s registration, plus `instances: 1`, `watch: false` and
> `max_memory_restart: 500M`.
>
> **Exactly one instance. Never cluster mode.** pg-boss starts *inside* the web
> process (`app/entry.server.tsx`) and owns the GDPR-erasure, retention-purge,
> rollup and auto-resolve schedules. Two copies run every job twice.

### 24. Persist across reboots

```bash
pm2 save
```

**Expect:** `Successfully saved in /root/.pm2/dump.pm2`.
**Do not skip this** — `pm2-root.service` restores from that dump, so without it the app
never comes back after a reboot.

### 25. Confirm all four apps are up

```bash
pm2 list
```

**Expect:** `zipeta`, `zipeta-cron`, `linkfront`, `seoconvert-web`, `seoconvert-worker`,
`chatconvert` — all `online`.

### 26. Check it answers locally

```bash
curl -I http://127.0.0.1:3003/
```

**Expect:** `HTTP/1.1 200 OK`.

### 27. Read the startup log

```bash
pm2 logs chatconvert --lines 30 --nostream
```

**Expect:** no `Invalid environment`, no `pgboss_error`.

---

## Part G — nginx

The existing block was written for a WebSocket app and will break this one. Four problems:
`Connection 'upgrade'` is wrong for SSE, buffering is on so streamed chat replies never
stream, the default 60s read timeout kills SSE connections, and the default 1 MB body limit
rejects PDF knowledge uploads.

### 28. Back up the current config

```bash
cp /etc/nginx/sites-available/chatconvert.progryss.com \
   /etc/nginx/sites-available/chatconvert.progryss.com.bak
```

### 29. Edit it

```bash
nano /etc/nginx/sites-available/chatconvert.progryss.com
```

### 30. Replace the `location / { ... }` block

In the **first** `server` block (the one with the certbot `ssl_certificate` lines), delete
the existing `location / { ... }` and put this in its place:

```nginx
    # merchants upload PDFs as knowledge sources
    client_max_body_size 25M;

    location / {
        proxy_pass http://127.0.0.1:3003;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection        "";

        # Server-Sent Events: streaming chat replies and the live inbox.
        # Without these, replies arrive all at once at the end — or never.
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        chunked_transfer_encoding off;
    }
```

Leave the certbot `listen` / `ssl_*` lines and the second `server` block (the port-80
redirect) exactly as they are. Save with `Ctrl+O`, `Enter`, `Ctrl+X`.

### 31. Test the config

```bash
nginx -t
```

**Expect:** `syntax is ok` **and** `test is successful`.
**If not, stop and fix it.** Reloading a broken config takes the other three sites down.

### 32. Reload

```bash
systemctl reload nginx
```

**Expect:** no output.

### 33. Check the public URL

```bash
curl -I https://chatconvert.progryss.com/
```

**Expect:** `HTTP/2 200`.

---

## Part H — First login

### 34. Create the operator account

The login for `/platform`, where the OpenAI key, plans and operational flags are set
without redeploying. Replace `ADMIN_EMAIL`, your name and `ADMIN_PASSWORD`. Subshell
again, same reason as command 21.

```bash
cd /var/www/chatconvert.progryss.com/html
( set -a; . ./.env; set +a; npx tsx scripts/platform-admin.ts create ADMIN_EMAIL "Your Name" "ADMIN_PASSWORD" )
```

**Expect:** `created platform admin ADMIN_EMAIL (...)`.

> Prefer this over the `PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD` env pair —
> those stay armed for as long as the admin table is empty. Leave them out of `.env`
> entirely.

### 35. Verify

```bash
npx tsx scripts/platform-admin.ts list
```

**Expect:** one row with your email.

### 36. Confirm the job queue started

```bash
sudo -u postgres psql -d chatconvert -c '\dn'
```

**Expect:** a `pgboss` schema listed.

> This matters more than it looks. If pg-boss failed at boot, the app still serves
> pages perfectly and every scheduled job — including the day-7 GDPR erasure —
> silently never runs. `pm2 restart chatconvert`, then check again.

---

## Part I — Shopify

**These commands run on your Windows laptop, not the droplet.**

### 37. Edit `shopify.app.toml`

```toml
application_url = "https://chatconvert.progryss.com"

[build]
automatically_update_urls_on_dev = false

[auth]
redirect_urls = [ "https://chatconvert.progryss.com/auth/callback" ]

[app_proxy]
url = "https://chatconvert.progryss.com/proxy"
subpath = "ccwidget"
prefix = "apps"
```

> **The app-proxy URL is pinned per store at install time.** A store records `url`,
> `subpath` and `prefix` on install and never refreshes them. Changing any of the
> three later needs a real uninstall + reinstall on **every** store; redeploying
> alone does nothing and the storefront returns "There was an error in the
> third-party application". With no merchants installed, this is the free moment.

### 38. Validate

```bash
shopify app config validate --json
```

**Expect:** valid, no errors.

### 39. Deploy the app version

```bash
npm run config:which        # must report PRODUCTION
npm run deploy:prod -- "point app URLs at production"
```

**Expect:** a new app version created and released.

> **Watch the `[events]` stub.** `shopify.app.toml` carries an empty `[events]` block
> added to work around a server-side validation requirement. It is untested on the
> deploy path, and an equivalent stub broke `shopify app deploy` during the June 2026
> `[definitions]` incident. If the deploy fails, remove that block and retry.

### 40. Ask Shopify what it actually registered

```bash
shopify app info
```

**Expect:** the production URL, not a `trycloudflare` host. Ask Shopify — do not infer
it from what you deployed.

### 41. Commit

```bash
git add shopify.app.toml
git commit -m "Point app URLs at production host"
git push origin main
git push personal main
```

---

## Part J — Verify and clean up

| # | Check | Expected |
|---|---|---|
| 1 | `curl -I https://chatconvert.progryss.com/` | 200, valid TLS |
| 2 | `pm2 list` | `chatconvert` online, 4 apps total |
| 3 | `sudo -u postgres psql -d chatconvert -c '\dn'` | a `pgboss` schema exists — the queue started |
| 4 | `pm2 logs chatconvert --lines 50 --nostream \| grep -i error` | no `pgboss_error`, no `Invalid environment` |

### 42. Install on a development store

From the Partner Dashboard. **Expect:** OAuth completes, the embedded admin loads with no
frame errors, and a row appears in `sessions`.

### 43. Enable the widget and test streaming

Dev store → theme editor → enable the ChatConvert app embed → open the storefront → send a
message.

**Expect:** the reply arrives **token by token**. If it appears all at once, nginx is still
buffering — recheck command 30.

### 44. Test webhooks

Change a product title in the dev store, and watch:

```bash
pm2 logs chatconvert --lines 50 | grep -i webhook
```

**Expect:** a `products/update` webhook within seconds.

### 45. Reboot test

```bash
reboot
```

Wait ~60s, reconnect, then:

```bash
pm2 list
```

**Expect:** `chatconvert` back `online` on its own.

### 46. Remove the hello-world backup

Only after 42–45 all pass.

```bash
rm -rf /var/www/chatconvert.progryss.com/html-helloworld-backup
```

### 47. Rotate the root password

It was shared in plaintext during setup.

```bash
passwd
```

---

# Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Invalid environment: LLM_PROVIDER: expected "openai"` | `.env` written with CRLF — every value carries a trailing `\r` | `sed -i 's/\r//g' .env`, then **`pm2 delete chatconvert`** and start again; a plain `pm2 restart` replays the corrupted values pm2 cached at first start |
| Crash-loops even after `.env` is fixed | pm2 cached the bad env | `pm2 delete chatconvert && pm2 save`, open a **fresh SSH session**, then `pm2 start ecosystem.config.cjs` |
| `Invalid environment: DATABASE_URL is required` | `.env` missing, or pm2 started without the ecosystem file | `pm2 delete chatconvert`, then redo command 23 |
| pm2 says `online` but nothing listens on 3003 | `npm ci` deleted the generated Prisma client — the error log shows `@prisma/client did not initialize yet` | `( set -a; . ./.env; set +a; npm run setup )` then `pm2 restart chatconvert` |
| pm2 shows `errored` / restart count climbing | anything above | `pm2 logs chatconvert --err --lines 50` |
| Migration fails on `CREATE EXTENSION vector` | Extension not created as superuser | Redo command 4 |
| Build killed with no error message | OOM — the Vite spike | `NODE_OPTIONS=--max-old-space-size=1024 npm run build` |
| Chat replies appear all at once | nginx still buffering | Command 30, then 31–32 |
| Storefront: "error in the third-party application" | The store's pinned app-proxy URL does not match | Uninstall and reinstall the app on that store |
| Storefront widget 404 or 500 in **dev** | Tunnel hostname changed, or the proxy URL never reached the released version | [The two 404s](#telling-the-two-404s-apart), then `npm run dev:push-proxy` |
| Deploy reported success but merchants see no change to the **widget** | `npm run deploy` published the DEV app — the CLI was pointed at `shopify.app.dev.toml` | `npm run config:which`, switch to production, re-run `npm run deploy:prod` |
| Server pulled and restarted but the **widget** is unchanged | `extensions/**` lives on Shopify's CDN; `deploy.sh` cannot ship it | `npm run deploy:prod` from your laptop |
| Embedded admin is a blank frame | `SHOPIFY_APP_URL` ≠ registered `application_url` | Compare `shopify app info` against `.env` |
| Scheduled jobs never run | pg-boss failed at boot; the app kept serving | Command 36, then `pm2 restart chatconvert` |
| OAuth redirect loop on install | `redirect_urls` missing the production callback | Command 37, then redeploy |
| App gone after reboot | `pm2 save` was skipped | Command 23, then 24 |
| `nginx -t` fails | broken edit in command 30 | `cp /etc/nginx/sites-available/chatconvert.progryss.com.bak /etc/nginx/sites-available/chatconvert.progryss.com` to restore |
| `prisma generate` fails with EPERM on Windows | an orphaned project node process holds the query engine | `npm run dev:stop`, then kill any PID it names |

---

# Still blocking the App Store, not the deploy

From `scripts/qa/APP-STORE-REVIEW.md` — three open blockers. None stops the deploy; all
three stop merchants.

- **B1 — protected customer data level 2 not requested.** `read_orders`, `read_customers`
  and `write_customers` read order email/phone/shipping address and customer records. A
  public app must request PCD access *and the specific fields* in the Partner Dashboard,
  implement the level 1 + level 2 requirements, and take part in data-protection reviews.
  Submitting without it is an automatic hold. Has lead time — start it early.
- **B3 — production URLs.** Closed by command 37.
- **B5 — privacy policy does not exist.** Must name OpenAI as a processor, state the
  merchant-configurable transcript retention windows *and* the 7-day post-uninstall window,
  and give a GDPR contact. `docs/privacy-policy-page.html` is written and ready to paste.

# Security follow-ups

- The droplet root password was shared in plaintext during setup — rotate it (`passwd`)
  now that key auth works.
- Consider disabling password authentication entirely: `PasswordAuthentication no` in
  `/etc/ssh/sshd_config`, then `systemctl restart ssh`. Confirm key auth works from a
  second session *before* restarting, or you can lock yourself out.
- This app runs as root in the shared pm2 daemon, matching the other three. That was a
  deliberate trade — a dedicated user costs a second pm2 daemon (~70 MB measured) on a box
  with ~1 GB free. Worth revisiting on a larger droplet.
