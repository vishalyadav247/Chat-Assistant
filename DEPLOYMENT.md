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

---

# Part 1 — Routine release

`main` is what production runs. Never commit to it directly — the droplet pulls it.

```
dev  ──commit──►  push origin dev  ──►  PR  ──►  merge to main  ──►  pull on server
```

## Three destinations, three commands

This is the part that catches people. A release is not one action, and a file
only reaches production through **its own** path:

| What changed | Ends up on | Gets there via | Run from |
|---|---|---|---|
| `app/**`, `prisma/**` | your droplet | `bash scripts/deploy.sh` | the server |
| `extensions/**` | Shopify's CDN | `npm run deploy:prod` | your laptop |
| `shopify.app.toml` (scopes, webhooks, URLs, proxy) | the Shopify app record | `npm run deploy:prod` | your laptop |

Pulling on the droplet does nothing for the storefront widget — it is hosted by
Shopify, not by you. A release touching both needs **both** commands, and the
usual failure is running only `deploy.sh` and wondering why the widget never
changed.

Conversely, `shopify app deploy` never touches your server. It means exactly one
thing: *publish to Shopify*.

### Check which app you are pointed at — every time

```powershell
npm run config:which
```

```
active config file : shopify.app.toml
app name           : ChatConvert - AI Sales ChatBot
client id          : 6b2bcbe0ed1fc4b0600f96acc4f0eb72  <- PRODUCTION
```

**The selection is machine-local CLI state, not something in this repo.**
`.shopify/project.json` holds only dev-store URLs; nothing in git records which
app the CLI has active. So it never appears in a diff, it survives across
sessions, and it is left pointing at the **dev** app every time you finish a day
of `npm run dev`. Checked 2026-09-02: it was on `shopify.app.dev.toml`.

That is the hazard an unguarded `npm run deploy` walks into — it publishes a
version of *chatConvert2* instead of production. Nothing errors, nothing warns,
and merchants simply never receive the change.

To switch:

```powershell
npm run config:use -- shopify.app.toml     # production
npm run config:use -- dev                  # back to dev
```

### Use `deploy:prod`, not `deploy`

```powershell
npm run deploy:prod -- "what this version contains"
```

It re-reads the active config, pins `--client-id` to the production app so the
CLI itself rejects a mismatch, and refuses outright if `shopify.app.toml` has
picked up a `trycloudflare` / `ngrok` / `localhost` URL from a stray dev session.
Plain `npm run deploy` has none of those guards — it deploys wherever the CLI
happens to be pointed.

### Dev deploys are a different job

| | Dev | Production |
|---|---|---|
| Command | `npm run dev:push-proxy` | `npm run deploy:prod` |
| Run it when | the tunnel hostname changed (every cloudflared restart), or you are testing a widget change on the dev store | `extensions/**` changed, or `shopify.app.toml` changed |
| Never for | — | changes confined to `app/**` |

### Rebuilding on the server is decided for you

Rebuilding is a droplet concern — `app/**` compiled by Vite, restarted under
pm2 — and has nothing to do with `shopify app deploy`. You do not judge when it
is needed: `deploy.sh` reads the diff and runs only the stages that diff
requires. The table is under [The short version](#the-short-version).

## The short version

Two scripts do the whole loop. Everything under [The long version](#the-long-version)
is what they run, kept because you need to recognise the steps when one of them
stops.

**On your laptop:**

```powershell
npm run release -- "what changed and why"
```

Merges `origin/main` into `dev`, runs typecheck and lint, commits, pushes `dev`,
and opens the PR compare view. It stops before merging — that review is the last
place a stray secret or an unwanted migration gets caught. Nothing is committed
or pushed if typecheck or lint fails.

After you merge the PR on GitHub:

```powershell
npm run release:sync
```

**On the droplet:**

```bash
cd /var/www/chatconvert.progryss.com/html
bash scripts/deploy.sh
```

Pulls `main`, works out what actually changed, runs only the steps that change
needs, restarts pm2, and then **proves the app is answering on its port** before
reporting success. It refuses to run on a dirty tree or a branch other than
`main`, and prints the rollback command if the health check fails.

**And, only if `extensions/**` or `shopify.app.toml` changed** — back on your
laptop:

```powershell
npm run config:which                       # confirm PRODUCTION, not dev
npm run deploy:prod -- "what changed"
```

That is a separate destination, not an extra step of the same one. See
[Three destinations](#three-destinations-three-commands).

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

Scope: everything below stays inside `/var/www/chatconvert.progryss.com/`.
The only things this app owns outside that directory are its nginx site file
(`/etc/nginx/sites-available/chatconvert.progryss.com`), its pm2 entry
(`chatconvert`) and its database (`chatconvert`). Never touch the other apps on
this box.

```bash
cd /var/www/chatconvert.progryss.com/html
bash scripts/deploy.sh
```

That is the whole deploy. The sequence it runs, when every stage is needed, is:

```bash
git pull --ff-only origin main
npm ci
sed -i 's/\r$//' .env                          # only when CRLF is present
( set -a; . ./.env; set +a; npm run setup )    # prisma generate && migrate deploy
npm run build
pm2 restart chatconvert
```

> **Why `npm run setup` and not just `migrate deploy`.** `npm ci` deletes
> `node_modules`, which takes the generated Prisma client with it, and this repo's
> `.npmrc` environment does not reliably re-run Prisma's postinstall. Skipping the
> generate step produced a live outage on 2026-08-27: the build succeeded, pm2
> reported `online`, nothing listened on 3003, and the only clue was
> `@prisma/client did not initialize yet` in the error log. `npm run setup` is the
> repo's own script for exactly this pair — generate, then migrate.
>
> Order matters too: generate **before** build, so the build compiles against the
> client that will exist at runtime.

The script's last stage is the one worth understanding. It polls
`http://127.0.0.1:$PORT/` for up to 45 seconds and treats **any** HTTP status as
success — the failure it is looking for is `000`, a refused connection, which is
precisely what a green `pm2 list` hides. That is how the 2026-08-27 outage went
unnoticed: pm2 said `online` while nothing was listening.

If it fails, the script dumps the last 40 error lines and prints the rollback
command. To check by hand at any time:

```bash
curl -I https://chatconvert.progryss.com/
pm2 list | grep chatconvert
```

Watch the restart counter. If it climbs, the deploy failed — check
`pm2 logs chatconvert --err --lines 50` before doing anything else.

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

**1. A separate Shopify app for development.** This is the important one.
`shopify.app.toml` is the production app — it points at
`chatconvert.progryss.com` and is installed on real stores. Running
`shopify app dev` against it rewrites its URLs to a throwaway tunnel and rotates
the live store's access token (that is what produced 21 x 401
`embed_status_error` in production on 2026-08-27). Shopify's own guidance is to
never develop against an app that is installed on a live store.

```powershell
npm run config:link          # name it "dev" -> creates shopify.app.dev.toml
npm run config:use -- dev    # make it the default for dev commands
```

In `shopify.app.dev.toml` set `automatically_update_urls_on_dev = true` — the dev
app *should* follow the tunnel. In `shopify.app.toml` it stays `false`, forever.
`shopify.app.*.toml` is gitignored, so a dev config can never be mistaken for
production.

Keep the two configs honest with:

```powershell
npm run config:diff
```

It compares scopes, webhooks and custom data between dev and production, ignoring
the URLs and client id that are *supposed* to differ. Run it before promoting a
feature that touched `shopify.app.toml`.

**2. The database.** Postgres with pgvector, in Docker, on port 5433 so it
cannot collide with anything else:

```powershell
npm run db:up
npm run setup                # prisma generate && migrate deploy
npx prisma db seed           # demo shop + catalog; works without an OpenAI key
```

**3. `.env`.** Copy `.env.example` and point `DATABASE_URL` at
`postgresql://chatconvert:chatconvert@localhost:5433/chatconvert`. This file is
yours alone — it is never the server's `.env`.

## The app proxy — the expensive one to get wrong

The storefront widget reaches the app **only** through the app proxy
(`/apps/ccwidget`, hardcoded in `extensions/chat-widget/blocks/chat-widget.liquid`).
Getting it wrong costs a whole session, because every symptom looks like a
broken widget. It is not — it is a routing gap.

**`shopify app dev` does not manage `[app_proxy].url`.** It rewrites
`application_url` and `redirect_urls` on every run and leaves the proxy alone.
`scripts/sync-dev-urls.cjs` (run automatically by `npm run dev:tunnel`) fixes the
local file — but the local file is not what Shopify routes on.

**A plain `shopify app deploy` does not push it either.** The CLI strips
`include_config_on_deploy` from the config file after every deploy, and without
that key a deploy releases the *extension* and silently leaves the app
configuration behind. Two releases (`chatconvert2-3`, `-4`) were burned
discovering that.

So after the tunnel hostname changes — which with a cloudflared quick tunnel is
**every restart** — run:

```powershell
npm run dev:push-proxy
```

It re-adds `include_config_on_deploy`, deploys `--config dev`, and refuses to run
if `shopify.app.dev.toml` is carrying the production client id. The manual
equivalent is Dev Dashboard → App setup → App proxy:

| Field | Value |
|---|---|
| Subpath prefix | `apps` |
| Subpath | `ccwidget` |
| Proxy URL | `https://<current-tunnel-host>/proxy` |

> **ngrok would fix the churn, but cannot be used here.** A reserved ngrok domain
> never changes, so the proxy URL would be a one-time setting. But ngrok's free
> tier serves an interstitial page to anything with a browser User-Agent
> (`ERR_NGROK_6024`), and Shopify forwards the shopper's real User-Agent through
> the proxy — so every widget request gets the interstitial instead of your app.
> Verified by hand: plain curl UA → 400 (the app), browser UA → `ERR_NGROK_6024`,
> browser UA + `ngrok-skip-browser-warning` → still the interstitial. A paid plan
> or a stable cloudflared named tunnel are the two real fixes.

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
npm run db:up                # once per boot; Docker keeps it running after
npm run dev                  # or: npm run dev:tunnel
```

Vite hot-reloads on save, so most changes appear without restarting anything.

`npm run dev:tunnel` is the alternative when the CLI's built-in tunnel is
unreliable, and the one to use when you need the storefront widget. It stops
orphaned servers, refreshes the Prisma client, points `shopify.app.dev.toml` at
the tunnel (including `[app_proxy].url`), and starts the CLI against a
cloudflared quick tunnel you leave running all day in its own window:

```powershell
cloudflared tunnel --url http://localhost:3000 --metrics 127.0.0.1:20241
```

Then, if the hostname changed since last time, `npm run dev:push-proxy`.

When you are done:

```powershell
npm run dev:stop
```

Use it. `shopify app dev` spawns a child Vite process that survives Ctrl-C on
Windows, and each orphan holds a lock on the Prisma query engine — which is what
makes a later `prisma generate` fail with EPERM. `dev-stop.ps1` deliberately does
**not** kill other project node processes (`eval:golden`, a QA suite, prisma
studio); it names them instead, because those also hold that lock.

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

> **Keep the quotes on `EMAIL_FROM`.** Without them the `<` becomes a shell redirect in
> command 21 and breaks it.
>
> `SCOPES` must match `shopify.app.toml` exactly — copy it verbatim.
>
> Everything else in `.env.example` is optional: the operator sets it at `/platform`
> after login, and the dashboard value wins over the file.
>
> No Resend account yet? Set `EMAIL_PROVIDER=log` and leave `RESEND_API_KEY` blank.

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

> **Memory.** This box has ~1.0 GB available and the Vite build is the biggest spike
> the app ever produces. Watch it in a second SSH session with `free -h`. If the build
> dies with no error message, that was the OOM killer — retry with a cap:
>
> ```bash
> NODE_OPTIONS=--max-old-space-size=1024 npm run build
> ```
>
> If it still fails, build on your laptop and `rsync` the `build/` directory up.

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

> `ecosystem.config.cjs` ships in the repo, so there is nothing to type or mistype. It
> derives every path from `__dirname`, so it works from any checkout location, and it
> carries **no secrets** — `.env` is loaded by node's `--env-file`, which the file wires
> up. This app has no `dotenv` dependency; without that wiring the process starts and
> immediately dies with `Invalid environment: DATABASE_URL is required` while `.env`
> sits right there.
>
> It mirrors how `zipeta` is registered (same script path, same
> `./build/server/index.js` argument, same fork mode) and additionally pins
> `instances: 1`, disables `watch`, and sets `max_memory_restart: 500M` as a leak
> guard on this memory-constrained box.
>
> **Exactly one instance. Never `pm2 start -i` / cluster mode.** The pg-boss job queue
> starts *inside* the web process (`app/entry.server.tsx`) and owns the cron schedules
> for GDPR erasure, retention purge, analytics rollup and auto-resolve. Two copies run
> every job twice.

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
> `subpath` and `prefix` when the app is installed and never refreshes them. Changing
> any of the three later requires a real uninstall and reinstall on **every** store —
> redeploying alone does nothing, and the storefront just returns "There was an error
> in the third-party application" while the widget renders nothing.
>
> With no merchants installed yet, this is the one moment it is free to get right.

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
