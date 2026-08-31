#!/usr/bin/env bash
#
# Server half of the release flow. Run on the droplet AFTER the PR is merged:
#
#     cd /var/www/chatconvert.progryss.com/html
#     bash scripts/deploy.sh
#
# Pulls main, works out what actually needs rebuilding, restarts pm2, and then
# proves the app is answering before it reports success. Refuses to do anything
# if the working tree is dirty or the branch is not main.
#
# SCOPE: this script only ever touches its own checkout, its own pm2 entry
# ("chatconvert") and its own .env. It never reads or writes any other app on
# this box.
#
# Flags:
#   --force        redeploy even when git reports nothing new
#   --skip-checks  don't wait for the health check (not recommended)
#
set -Eeuo pipefail

PM2_NAME="chatconvert"

# --- Locate the checkout from the script's own path ------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
cd "$APP_DIR"

FORCE=0
SKIP_CHECKS=0
for arg in "$@"; do
  case "$arg" in
    --force)       FORCE=1 ;;
    --skip-checks) SKIP_CHECKS=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

bold()  { printf '\n\033[1;36m-> %s\033[0m\n' "$1"; }
good()  { printf '\033[1;32m   %s\033[0m\n' "$1"; }
warn()  { printf '\033[1;33m   %s\033[0m\n' "$1"; }
die()   { printf '\n\033[1;31m   x %s\033[0m\n\n' "$1" >&2; exit 1; }

# --- Sanity: are we where we think we are? ---------------------------------
[ -f "$APP_DIR/ecosystem.config.cjs" ] || die "no ecosystem.config.cjs in $APP_DIR - wrong directory?"
[ -f "$APP_DIR/.env" ]                 || die "no .env in $APP_DIR - the app cannot boot without it"
command -v pm2 >/dev/null              || die "pm2 not on PATH"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "main" ] || die "on branch '$BRANCH'. Production runs main; checkout main first."

if [ -n "$(git status --porcelain)" ]; then
  git status --short
  die "working tree is dirty. Production must match main exactly - commit or discard the above first."
fi

# --- Pull ------------------------------------------------------------------
BEFORE="$(git rev-parse HEAD)"
bold "Pulling main"
git pull --ff-only origin main
AFTER="$(git rev-parse HEAD)"

if [ "$BEFORE" = "$AFTER" ] && [ "$FORCE" -eq 0 ]; then
  good "Already up to date at ${AFTER:0:7} - nothing to deploy."
  good "Use --force to rebuild and restart anyway."
  exit 0
fi

if [ "$BEFORE" = "$AFTER" ]; then
  warn "No new commits, but --force was given: rebuilding everything."
  CHANGED=""
  NEED_INSTALL=1; NEED_MIGRATE=1; NEED_BUILD=1
else
  CHANGED="$(git diff --name-only "$BEFORE" "$AFTER")"
  echo "$CHANGED" | sed 's/^/     /'

  # package-lock.json changed -> dependencies moved -> full reinstall.
  NEED_INSTALL=0
  if echo "$CHANGED" | grep -qE '^(package\.json|package-lock\.json)$'; then NEED_INSTALL=1; fi

  # Schema or migrations changed -> the database needs the new migrations.
  NEED_MIGRATE=0
  if echo "$CHANGED" | grep -qE '^prisma/'; then NEED_MIGRATE=1; fi

  # Build unless EVERY changed file is documentation or dev-only tooling.
  # Deliberately conservative: anything not on this list forces a rebuild,
  # because a stale bundle in production is far worse than a wasted 90 seconds.
  NEED_BUILD=1
  if ! echo "$CHANGED" | grep -qvE '^(docs/|\.claude/|scripts/qa/)|\.md$'; then
    NEED_BUILD=0
  fi
fi

# --- .env line endings -----------------------------------------------------
# A .env pasted from Windows arrives with CRLF, and node's --env-file keeps the
# trailing \r inside every value. That is what produced
# `Invalid environment: LLM_PROVIDER` and a 54-restart crash loop on 2026-08-27:
# every value was corrupted, but only the enum-validated ones failed loudly.
# Only rewrite when there is something to fix, and put the mode back afterwards
# so the secrets file never widens to 644.
if grep -q $'\r' .env; then
  warn "CRLF line endings found in .env - normalising"
  sed -i 's/\r$//' .env
  chmod 600 .env
fi

# --- Dependencies ----------------------------------------------------------
if [ "$NEED_INSTALL" -eq 1 ]; then
  bold "Installing dependencies (package-lock.json changed)"
  npm ci
  # npm ci deletes node_modules, and the generated Prisma client with it. Skipping
  # the regenerate here is what took production down on 2026-08-27: the build
  # succeeded, pm2 said "online", nothing listened on the port, and the only clue
  # was `@prisma/client did not initialize yet`.
  NEED_MIGRATE=1
else
  good "Dependencies unchanged - skipping npm ci"
fi

# --- Prisma ----------------------------------------------------------------
# `npm run setup` is `prisma generate && prisma migrate deploy`, in that order,
# and it runs BEFORE the build so the build compiles against the client that
# will exist at runtime. The subshell exports .env only for these commands -
# never into this shell, because pm2 would snapshot whatever is exported here
# into the process definition and replay it on every future restart.
if [ "$NEED_MIGRATE" -eq 1 ]; then
  bold "Prisma generate + migrate deploy"
  ( set -a; . ./.env; set +a; npm run setup )
else
  good "No schema or dependency change - skipping prisma"
fi

# --- Build -----------------------------------------------------------------
if [ "$NEED_BUILD" -eq 1 ]; then
  bold "Building"
  npm run build
else
  good "Documentation-only change - skipping build"
fi

# --- Restart ---------------------------------------------------------------
if [ "$NEED_BUILD" -eq 0 ] && [ "$NEED_MIGRATE" -eq 0 ] && [ "$NEED_INSTALL" -eq 0 ]; then
  good "Nothing that affects the running process changed - not restarting."
  good "Now at $(git rev-parse --short HEAD)."
  exit 0
fi

bold "Restarting pm2 process '$PM2_NAME'"
if pm2 describe "$PM2_NAME" >/dev/null 2>&1; then
  pm2 restart "$PM2_NAME" --update-env
else
  warn "'$PM2_NAME' is not registered with pm2 - starting it"
  pm2 start ecosystem.config.cjs
fi
pm2 save >/dev/null

# --- Prove it actually came back -------------------------------------------
if [ "$SKIP_CHECKS" -eq 1 ]; then
  warn "Health check skipped (--skip-checks)."
  exit 0
fi

# PORT lives in .env; read it without exporting anything into this shell.
PORT="$(sed -n 's/^[[:space:]]*PORT[[:space:]]*=[[:space:]]*\([0-9]\{1,\}\).*/\1/p' .env | head -1)"
PORT="${PORT:-3003}"

bold "Health check on 127.0.0.1:$PORT"
DEADLINE=$(( SECONDS + 45 ))
CODE=000
while [ "$SECONDS" -lt "$DEADLINE" ]; do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/" || echo 000)"
  # Any HTTP status means the server is listening and routing. 000 means the
  # connection was refused - which is exactly the failure mode a green pm2
  # status hides.
  if [ "$CODE" != "000" ]; then break; fi
  sleep 2
done

STATUS="$(pm2 jlist | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s).find(p=>p.name==="'"$PM2_NAME"'");process.stdout.write(a?`${a.pm2_env.status} restarts=${a.pm2_env.restart_time}`:"missing")})')"

if [ "$CODE" = "000" ]; then
  printf '\n'
  pm2 logs "$PM2_NAME" --err --lines 40 --nostream || true
  printf '\n'
  die "app is not answering on port $PORT after 45s (pm2 says: $STATUS).
     Logs are above. To roll back:
       git checkout ${BEFORE:0:7} && npm ci && npm run build && pm2 restart $PM2_NAME"
fi

printf '\n'
good "HTTP $CODE from 127.0.0.1:$PORT   (pm2: $STATUS)"
good "Deployed ${BEFORE:0:7} -> ${AFTER:0:7}"
printf '\n'
