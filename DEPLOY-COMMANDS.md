# ChatConvert — deploy run sheet

Copy-paste sequence, one command at a time. Run each, check the **Expect** line, move on.
The reasoning behind every step is in [`DEPLOYMENT.md`](./DEPLOYMENT.md) — read that if a
command surprises you.

**Server:** `root@159.89.173.131` · **App dir:** `/var/www/chatconvert.progryss.com/html`
· **Port:** 3003

---

## Fill these in before you start

| Placeholder | Where it comes from |
|---|---|
| `DB_PASSWORD` | Generated in command 2 — save it, you paste it 4 times |
| `SHOPIFY_SECRET` | Partner Dashboard → your app → API credentials |
| `OPENAI_KEY` | platform.openai.com |
| `RESEND_KEY` | resend.com → API Keys (or skip — see command 14) |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Your choice — the `/platform` operator login |

---

# Part A — Database

### 1. Move to a directory postgres can read

```bash
cd /tmp
```

*Avoids a confusing `could not change directory to "/root"` warning.*

### 2. Generate the database password

```bash
openssl rand -hex 24
```

**Expect:** 48 hex characters. **Save this now** — it becomes `DB_PASSWORD`.

### 3. Create the role and database

Replace `DB_PASSWORD` with the string from command 2.

```bash
sudo -u postgres psql <<'SQL'
CREATE ROLE chatconvert LOGIN PASSWORD 'DB_PASSWORD';
CREATE DATABASE chatconvert OWNER chatconvert;
SQL
```

**Expect:** `CREATE ROLE` then `CREATE DATABASE`.

### 4. Enable pgvector

```bash
sudo -u postgres psql -d chatconvert -c 'CREATE EXTENSION IF NOT EXISTS vector;'
```

**Expect:** `CREATE EXTENSION`.

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

# Part B — Code

### 8. Go to the site directory

```bash
cd /var/www/chatconvert.progryss.com
```

### 9. Park the hello-world files

```bash
mv html html-helloworld-backup
```

*Keep this backup until the deploy is proven. Deleted in command 48.*

### 10a. Create a deploy key on the droplet

The repo is **private**, and the droplet has no GitHub credentials. A deploy key is
read-only and scoped to this one repo — it cannot reach your other repos, and it does not
expire the way a token does.

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

# Part C — Environment

### 13. Open the env file

```bash
nano .env
```

### 14. Paste this, then fill in the 4 blanks

```ini
NODE_ENV=production
PORT=3003

DATABASE_URL=postgresql://chatconvert:DB_PASSWORD@localhost:5432/chatconvert?schema=public

SHOPIFY_API_KEY=d8b180fa8bf4edbda15692d2652516d7
SHOPIFY_API_SECRET=SHOPIFY_SECRET
SHOPIFY_APP_URL=https://chatconvert.progryss.com
SCOPES=read_content,read_customers,write_customers,read_discounts,read_legal_policies,read_online_store_pages,read_orders,read_products,read_themes,write_app_proxy,write_files

OPENAI_API_KEY=OPENAI_KEY
LLM_PROVIDER=openai
CHAT_MODEL=gpt-4o-mini
EMBEDDING_MODEL=text-embedding-3-small

EMAIL_PROVIDER=resend
RESEND_API_KEY=RESEND_KEY
EMAIL_FROM="ChatConvert <no-reply@progryss.com>"
```

Save with `Ctrl+O`, `Enter`, then `Ctrl+X`.

> **Keep the quotes on `EMAIL_FROM`.** Without them the `<` becomes a shell redirect in
> command 19 and breaks it.
>
> No Resend account yet? Set `EMAIL_PROVIDER=log` and leave `RESEND_API_KEY` blank.

### 15. Lock the permissions

```bash
chmod 600 .env
```

### 16. Verify

```bash
ls -l .env
```

**Expect:** `-rw------- 1 root root`.

---

# Part D — Build

### 17. Install dependencies

```bash
npm ci
```

**Expect:** `added ~900 packages`. Takes a few minutes.

### 18. Build

```bash
npm run build
```

**Expect:** `✓ built in ~5s`, then `build/client` and `build/server` written.

> **If it dies with no error message**, that was the OOM killer. Retry with:
> ```bash
> NODE_OPTIONS=--max-old-space-size=1024 npm run build
> ```

---

# Part E — Migrations

### 19. Load the env into your shell

```bash
set -a; . ./.env; set +a
```

### 20. Confirm it loaded

```bash
echo $PORT
```

**Expect:** `3003`. If blank, command 14 or 19 went wrong — do not continue.

### 21. Generate the Prisma client

```bash
npx prisma generate
```

**Expect:** `Generated Prisma Client`.

### 22. Apply the migrations

```bash
npx prisma migrate deploy
```

**Expect:** `27 migrations found` … `All migrations have been successfully applied.`

### 23. Verify

```bash
npx prisma migrate status
```

**Expect:** `Database schema is up to date!`

---

# Part F — Run it

### 24. Start under pm2

```bash
pm2 start node_modules/@react-router/serve/bin.js \
  --name chatconvert \
  --node-args="--env-file=/var/www/chatconvert.progryss.com/html/.env" \
  -- ./build/server/index.js
```

**Expect:** a pm2 table with `chatconvert` · `online`.

> The `--node-args` part is what loads `.env`. This app has no `dotenv` dependency — without
> that flag it starts and immediately dies with `Invalid environment: DATABASE_URL is required`.

### 25. Persist across reboots

```bash
pm2 save
```

**Expect:** `Successfully saved in /root/.pm2/dump.pm2`.
**Do not skip this** — without it the app never comes back after a reboot.

### 26. Confirm all four apps are up

```bash
pm2 list
```

**Expect:** `zipeta`, `zipeta-cron`, `linkfront`, `seoconvert-web`, `seoconvert-worker`,
`chatconvert` — all `online`.

### 27. Check it answers locally

```bash
curl -I http://127.0.0.1:3003/
```

**Expect:** `HTTP/1.1 200 OK`.

### 28. Read the startup log

```bash
pm2 logs chatconvert --lines 30 --nostream
```

**Expect:** no `Invalid environment`, no `pgboss_error`.

---

# Part G — nginx

### 29. Back up the current config

```bash
cp /etc/nginx/sites-available/chatconvert.progryss.com \
   /etc/nginx/sites-available/chatconvert.progryss.com.bak
```

### 30. Edit it

```bash
nano /etc/nginx/sites-available/chatconvert.progryss.com
```

### 31. Replace the `location / { ... }` block

In the **first** `server` block (the one with the certbot `ssl_certificate` lines), delete
the existing `location / { ... }` and put this in its place:

```nginx
    client_max_body_size 25M;

    location / {
        proxy_pass http://127.0.0.1:3003;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection        "";

        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        chunked_transfer_encoding off;
    }
```

Leave the certbot `listen` / `ssl_*` lines and the second `server` block untouched.
Save with `Ctrl+O`, `Enter`, `Ctrl+X`.

### 32. Test the config

```bash
nginx -t
```

**Expect:** `syntax is ok` **and** `test is successful`.
**If not, stop and fix it.** Reloading a broken config takes the other three sites down.

### 33. Reload

```bash
systemctl reload nginx
```

**Expect:** no output.

### 34. Check the public URL

```bash
curl -I https://chatconvert.progryss.com/
```

**Expect:** `HTTP/2 200`.

---

# Part H — First login

### 35. Reload the env (new shell since command 19?)

```bash
cd /var/www/chatconvert.progryss.com/html
set -a; . ./.env; set +a
```

### 36. Create the operator account

Replace `ADMIN_EMAIL`, your name, and `ADMIN_PASSWORD`.

```bash
npx tsx scripts/platform-admin.ts create ADMIN_EMAIL "Your Name" "ADMIN_PASSWORD"
```

**Expect:** `created platform admin ADMIN_EMAIL (...)`.

### 37. Verify

```bash
npx tsx scripts/platform-admin.ts list
```

**Expect:** one row with your email.

### 38. Confirm the job queue started

```bash
sudo -u postgres psql -d chatconvert -c '\dn'
```

**Expect:** a `pgboss` schema listed.

> If it is missing, pg-boss failed at boot. The app still serves pages perfectly and every
> scheduled job — including the day-7 GDPR erasure — silently never runs.
> `pm2 restart chatconvert`, then check again.

---

# Part I — Shopify

**These three commands run on your Windows laptop, not the droplet.**

### 39. Edit `shopify.app.toml`

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

> The app-proxy URL is **pinned by each store at install time**. Changing it later needs a
> real uninstall + reinstall on every store. With no merchants installed, this is the one
> moment it is free to get right.

### 40. Validate

```bash
shopify app config validate --json
```

**Expect:** valid, no errors.

### 41. Deploy the app version

```bash
npm run deploy
```

**Expect:** a new app version created and released.

> If it fails, the empty `[events]` block in `shopify.app.toml` is the first suspect —
> remove it and retry.

### 42. Ask Shopify what it actually registered

```bash
shopify app info
```

**Expect:** the production URL, not a `trycloudflare` host.

### 43. Commit

```bash
git add shopify.app.toml
git commit -m "Point app URLs at production host"
git push origin main
git push personal main
```

---

# Part J — Verify and clean up

### 44. Install on a development store

From the Partner Dashboard. **Expect:** OAuth completes, the embedded admin loads with no
frame errors.

### 45. Enable the widget and test streaming

Dev store → theme editor → enable the ChatConvert app embed → open the storefront → send a
message.

**Expect:** the reply arrives **token by token**. If it appears all at once, nginx is still
buffering — recheck command 31.

### 46. Test webhooks

Change a product title in the dev store, and watch:

```bash
pm2 logs chatconvert --lines 50 | grep -i webhook
```

**Expect:** a `products/update` webhook within seconds.

### 47. Reboot test

```bash
reboot
```

Wait ~60s, reconnect, then:

```bash
pm2 list
```

**Expect:** `chatconvert` back `online` on its own.

### 48. Remove the hello-world backup

Only after 44–47 all pass.

```bash
rm -rf /var/www/chatconvert.progryss.com/html-helloworld-backup
```

### 49. Rotate the root password

It was shared in plaintext during setup.

```bash
passwd
```

---

# Redeploying later

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

**`npm run deploy` is never part of this.** It publishes an app version to merchants — run
it by hand from your laptop, deliberately.

---

# If something breaks

| Symptom | Fix |
|---|---|
| `Invalid environment: DATABASE_URL is required` | `pm2 delete chatconvert`, redo command 24 exactly — the `--node-args` flag is missing |
| pm2 shows `errored` / restart count climbing | `pm2 logs chatconvert --err --lines 50` |
| Build killed silently | `NODE_OPTIONS=--max-old-space-size=1024 npm run build` |
| Chat replies not streaming | command 31, then 32–33 |
| Storefront: "error in the third-party application" | Uninstall + reinstall the app on that store |
| Blank embedded admin frame | `SHOPIFY_APP_URL` in `.env` ≠ what `shopify app info` reports |
| App gone after reboot | `pm2 save` was skipped — run command 24, then 25 |
| `nginx -t` fails | `cp /etc/nginx/sites-available/chatconvert.progryss.com.bak /etc/nginx/sites-available/chatconvert.progryss.com` to restore |
