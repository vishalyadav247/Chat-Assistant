# ChatConvert — production deployment

DigitalOcean droplet `159.89.173.131` (`shopify-public-apps`), alongside three existing
apps. Every command below runs **on the droplet as root** unless the heading says otherwise.

Surveyed 2026-08-27. Re-check the "already in place" table before following this on a
different box — most of the risky work is already done on this one.

---

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
  needs fixing before the app works (step 8).
- **Swap** — 2 GB already configured.
- **Node 22.23.2** satisfies the `>=22.12` engine requirement. Do not upgrade the global
  Node; the other three apps run on it.

### Conventions this follows

Matching `seoconvert`, the sibling app built from the same template:

- App lives at `/var/www/<domain>/html`, a git clone
- Runs as **root** under the existing pm2 daemon
- Secrets in `<app>/.env`, `chmod 600` — and `.env` is gitignored, so `git pull` never
  touches it

**One deviation.** `seoconvert` depends on `dotenv`; this app does not, and nothing in it
reads `.env` at runtime. So the file is loaded by Node itself with `--env-file` (step 7).
A `.env` sitting beside the app would otherwise be **silently ignored** and the app would
refuse to boot with `Invalid environment: DATABASE_URL is required`.

---

## Step 1 — SSH key

Already done. Key auth to `root@159.89.173.131` is working.

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIINbTIIpAxqO9EqXtudokPUhlt7ajre/RWlH9UV5Fj6I vishal@gmail.com" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

---

## Step 2 — Database, role, vector extension

Run from `/tmp`. `sudo -u postgres` cannot read `/root`, and running there prints a
`could not change directory` warning that looks like a failure but isn't.

```bash
cd /tmp
```

**2a — generate a password and save it.** Hex on purpose: no `@`, `/` or `#` to break the
connection string.

```bash
openssl rand -hex 24
```

**2b — create the role and database.** Replace `DB_PASSWORD` with the output of 2a.

```bash
sudo -u postgres psql <<'SQL'
CREATE ROLE chatconvert LOGIN PASSWORD 'DB_PASSWORD';
CREATE DATABASE chatconvert OWNER chatconvert;
SQL
```

**2c — enable pgvector inside the new database.**

```bash
sudo -u postgres psql -d chatconvert -c 'CREATE EXTENSION IF NOT EXISTS vector;'
sudo -u postgres psql -d chatconvert -c 'GRANT ALL ON SCHEMA public TO chatconvert;'
```

> `CREATE EXTENSION` requires superuser. Migration `20260806000000_init` contains the same
> statement, but Prisma runs it as the unprivileged `chatconvert` role and would fail.
> Creating it here first turns that line into a harmless no-op.
>
> The role must **own** the database, not merely have rights on it: pg-boss builds its own
> `pgboss` schema there at boot.

**2d — verify.**

```bash
sudo -u postgres psql -d chatconvert -c '\dx'
psql "postgresql://chatconvert:DB_PASSWORD@localhost:5432/chatconvert" -c 'SELECT current_user, current_database();'
```

Expect `vector | 0.6.0`, then `chatconvert | chatconvert`. The second command tests the
exact connection string the app will use.

---

## Step 3 — Clone the repo

The `html` directory currently holds the hello-world files. Keep them until the deploy is
proven, then delete the backup.

```bash
cd /var/www/chatconvert.progryss.com
mv html html-helloworld-backup
git clone git@github.com:progryss/chatconvert.git html
cd html
git log --oneline -1
```

The repo is **private** and the droplet has no GitHub credentials, so this needs a
deploy key first — generate one with `ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519`,
add the public half at `github.com/progryss/chatconvert` → Settings → Deploy keys
(read-only), then `ssh-keyscan github.com >> ~/.ssh/known_hosts`. Full sequence in
`DEPLOY-COMMANDS.md` steps 10a–10e.

Note `seoconvert` uses an HTTPS remote; a deploy key is preferred here because nothing has
to store a token that can expire or leak.

---

## Step 4 — Environment file

```bash
cd /var/www/chatconvert.progryss.com/html
nano .env
```

Paste this, filling in the four blanks:

```ini
NODE_ENV=production
PORT=3003

DATABASE_URL=postgresql://chatconvert:DB_PASSWORD@localhost:5432/chatconvert?schema=public

# Shopify — the CLI injects these in dev; in production you set them yourself.
SHOPIFY_API_KEY=d8b180fa8bf4edbda15692d2652516d7
SHOPIFY_API_SECRET=
SHOPIFY_APP_URL=https://chatconvert.progryss.com
SCOPES=read_content,read_customers,write_customers,read_discounts,read_legal_policies,read_online_store_pages,read_orders,read_products,read_themes,write_app_proxy,write_files

# LLM
OPENAI_API_KEY=
LLM_PROVIDER=openai
CHAT_MODEL=gpt-4o-mini
EMBEDDING_MODEL=text-embedding-3-small

# Email — use EMAIL_PROVIDER=log to defer this
EMAIL_PROVIDER=resend
RESEND_API_KEY=
EMAIL_FROM="ChatConvert <no-reply@progryss.com>"
```

```bash
chmod 600 .env
ls -l .env
```

Notes:

- `SHOPIFY_API_SECRET` — Partner Dashboard → your app → API credentials.
- `SCOPES` must match `shopify.app.toml` exactly. Copy it verbatim.
- Keep `EMAIL_FROM` **quoted**. The `<` would be a shell redirect in step 6, which sources
  this file.
- Everything else in `.env.example` is optional — the operator sets it at `/platform`
  after login, and the dashboard value wins over the file.

---

## Step 5 — Install and build

```bash
cd /var/www/chatconvert.progryss.com/html
npm ci
npm run build
```

Use a **full `npm ci`**, not `--omit=dev`: `vite` and `typescript` are devDependencies and
the build needs them, as does `tsx` in step 9.

> **Memory.** This box has ~1.0 GB available and the Vite build is the biggest spike the
> app ever produces. Watch it in a second SSH session with `free -h`. If the build is
> killed with no error, that was the OOM killer — retry with a cap:
>
> ```bash
> NODE_OPTIONS=--max-old-space-size=1024 npm run build
> ```
>
> If it still fails, build on your laptop and `rsync` the `build/` directory up.

Expect `✓ built in ~5s` and a `build/` directory containing `client/` and `server/`.

**Do not run `npx prisma db seed`.** That loads demo-shop fixtures; it is a development
tool only.

---

## Step 6 — Run the migrations

```bash
cd /var/www/chatconvert.progryss.com/html
set -a; . ./.env; set +a
npx prisma generate
npx prisma migrate deploy
npx prisma migrate status
```

27 migrations. `migrate deploy` only applies — it never resets or drops.

---

## Step 7 — Start under pm2

```bash
cd /var/www/chatconvert.progryss.com/html
pm2 start node_modules/@react-router/serve/bin.js \
  --name chatconvert \
  --node-args="--env-file=/var/www/chatconvert.progryss.com/html/.env" \
  -- ./build/server/index.js
pm2 save
pm2 list
```

This mirrors how `zipeta` is registered (same script path, same `./build/server/index.js`
argument, same fork mode). The `--node-args` part is the addition that loads `.env`,
including `PORT=3003`.

`pm2 save` writes the process list so `pm2-root.service` restores it on reboot. **Skipping
it means the app does not come back after a reboot.**

**Verify:**

```bash
curl -I http://127.0.0.1:3003/
pm2 logs chatconvert --lines 30 --nostream
```

> **Exactly one instance. Never `pm2 start -i` / cluster mode.** The pg-boss job queue
> starts *inside* the web process (`app/entry.server.tsx`) and owns the cron schedules for
> GDPR erasure, retention purge, analytics rollup and auto-resolve. Two copies run every
> job twice.

---

## Step 8 — Fix the nginx location block

The existing block was written for a WebSocket app and will break this one. Four problems:
`Connection 'upgrade'` is wrong for SSE, buffering is on so streamed chat replies never
stream, the default 60s read timeout kills SSE connections, and the default 1 MB body limit
rejects PDF knowledge uploads.

```bash
cp /etc/nginx/sites-available/chatconvert.progryss.com \
   /etc/nginx/sites-available/chatconvert.progryss.com.bak
nano /etc/nginx/sites-available/chatconvert.progryss.com
```

Replace the `location / { ... }` block in the **first** `server` block (the one with the
certbot SSL lines) with:

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

Leave the certbot `listen`/`ssl_*` lines and the second `server` block (the port-80
redirect) exactly as they are.

```bash
nginx -t
systemctl reload nginx
curl -I https://chatconvert.progryss.com/
```

`nginx -t` must say **syntax is ok** before reloading. A reload with a broken config would
take the other three sites down with it.

---

## Step 9 — Create the operator account

The login for `/platform`, where the OpenAI key, plans and operational flags are set
without redeploying.

```bash
cd /var/www/chatconvert.progryss.com/html
set -a; . ./.env; set +a
npx tsx scripts/platform-admin.ts create you@progryss.com "Your Name" "STRONG_PASSWORD"
npx tsx scripts/platform-admin.ts list
```

Prefer this over the `PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD` env pair — those
stay armed for as long as the admin table is empty. Leave them out of `.env` entirely.

---

## Step 10 — Point Shopify at production

**This step runs on your laptop, not the droplet.**

Edit `shopify.app.toml`:

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

```bash
shopify app config validate --json
npm run deploy
shopify app info
```

`shopify app info` asks Shopify what it actually registered. Do not infer it from what you
deployed.

> **The app proxy URL is pinned per store at install time.** A store records `url`,
> `subpath` and `prefix` when the app is installed and never refreshes them. Changing any
> of the three later requires a real uninstall and reinstall on **every** store —
> redeploying alone does nothing, and the storefront just returns "There was an error in
> the third-party application" while the widget renders nothing.
>
> With no merchants installed yet, this is the one moment it is free to get right.

> **Watch the `[events]` stub.** `shopify.app.toml` carries an empty `[events]` block added
> to work around a server-side validation requirement. It is untested on the deploy path,
> and an equivalent stub broke `shopify app deploy` during the June 2026 `[definitions]`
> incident. If the deploy fails, remove that block and try again.

Commit the change:

```bash
git add shopify.app.toml
git commit -m "Point app URLs at production host"
git push origin main
git push personal main
```

---

## Verification

| # | Check | Expected |
|---|---|---|
| 1 | `curl -I https://chatconvert.progryss.com/` | 200, valid TLS |
| 2 | `pm2 list` | `chatconvert` online, 4 apps total |
| 3 | `sudo -u postgres psql -d chatconvert -c '\dn'` | a `pgboss` schema exists — the queue started |
| 4 | `pm2 logs chatconvert --lines 50 --nostream \| grep -i error` | no `pgboss_error`, no `Invalid environment` |
| 5 | Install on a dev store from the Partner Dashboard | OAuth completes, a row appears in `sessions` |
| 6 | Enable the app embed in the dev store theme, send a chat message | reply streams token by token |
| 7 | Change a product title in the dev store | `products/update` webhook arrives within seconds |
| 8 | Reboot test — `reboot`, wait, `pm2 list` | `chatconvert` back online |

Check 3 matters more than it looks: if pg-boss fails to start, the app still serves pages
perfectly and every scheduled job silently never runs — including the day-7 GDPR erasure.

Once checks 1–8 pass:

```bash
rm -rf /var/www/chatconvert.progryss.com/html-helloworld-backup
```

---

## Redeploying after a code change

Everything above is one-time. From here on:

```bash
cd /var/www/chatconvert.progryss.com/html
git pull origin main
npm ci
npm run build
set -a; . ./.env; set +a
npx prisma migrate deploy
pm2 restart chatconvert
pm2 logs chatconvert --lines 40 --nostream
```

**`npm run deploy` never belongs in that loop.** It publishes a Shopify app version to
merchants and can repoint the pinned app-proxy URL. It is a release decision, run by hand
from your laptop.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Invalid environment: DATABASE_URL is required` | `.env` not loaded — the `--node-args` flag is missing from the pm2 entry | `pm2 delete chatconvert`, redo step 7 exactly |
| App restart-loops right after `pm2 start` | Same as above, or a typo in `DATABASE_URL` | `pm2 logs chatconvert --err --lines 50` |
| Migration fails on `CREATE EXTENSION vector` | Extension not created as superuser | Redo step 2c |
| Build killed with no error message | OOM — the Vite spike | `NODE_OPTIONS=--max-old-space-size=1024 npm run build` |
| Chat replies appear all at once | nginx still buffering | Step 8, then `nginx -t` and reload |
| Storefront: "error in the third-party application" | The store's pinned app-proxy URL does not match | Uninstall and reinstall the app on that store |
| Embedded admin is a blank frame | `SHOPIFY_APP_URL` ≠ registered `application_url` | Compare `shopify app info` against `.env` |
| Scheduled jobs never run | pg-boss failed at boot; the app kept serving | Check 3 above, then `pm2 restart chatconvert` |
| OAuth redirect loop on install | `redirect_urls` missing the production callback | Step 10, redeploy |
| App gone after reboot | `pm2 save` was skipped | `pm2 save` after starting |

---

## Still blocking the App Store, not the deploy

From `scripts/qa/APP-STORE-REVIEW.md` — three open blockers. None stops the deploy; all
three stop merchants.

- **B1 — protected customer data level 2 not requested.** `read_orders`, `read_customers`
  and `write_customers` read order email/phone/shipping address and customer records. A
  public app must request PCD access *and the specific fields* in the Partner Dashboard,
  implement the level 1 + level 2 requirements, and take part in data-protection reviews.
  Submitting without it is an automatic hold. Has lead time — start it early.
- **B3 — production URLs.** Closed by step 10.
- **B5 — privacy policy does not exist.** Must name OpenAI as a processor, state the
  merchant-configurable transcript retention windows *and* the 7-day post-uninstall window,
  and give a GDPR contact.

## Security follow-ups

- The droplet root password was shared in plaintext during setup — rotate it (`passwd`)
  now that key auth works.
- Consider disabling password authentication entirely: `PasswordAuthentication no` in
  `/etc/ssh/sshd_config`, then `systemctl restart ssh`. Confirm key auth works from a
  second session *before* restarting, or you can lock yourself out.
- This app runs as root in the shared pm2 daemon, matching the other three. That was a
  deliberate trade — a dedicated user costs a second pm2 daemon (~70 MB measured) on a box
  with ~1 GB free. Worth revisiting on a larger droplet.
