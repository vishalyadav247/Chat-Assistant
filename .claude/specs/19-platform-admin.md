# 19 — Platform admin panel (operator dashboard)

> Internal dashboard for the **company that builds ChatConvert** (not merchants).
> Global settings changed here apply to every shop that has the app installed.
> v1 scope (user, 2026-08-20): AI model / model settings + full plan-feature matrix.
> More operator settings will be added later — build the shell so new pages slot in.

## Surface & auth (user decision 2026-08-20: DB-backed admin accounts)

- URL space: `/platform/*`. Never embedded, no App Bridge, `frame-ancestors 'none'`,
  `Cache-Control: no-store`. Mirrors the `/web/*` public-shell pattern (spec 18):
  `AppProvider embedded={false}` so Polaris `<s-*>` components work.
- Accounts: `platform_admins` table (scrypt `passwordHash` via the spec-18
  `password.server.ts` helpers). Sessions: `platform_sessions` — opaque 32-byte
  token in cookie `cc_platform` (HttpOnly, SameSite=Lax, **Path=/** — NOT
  /platform: React Router client navigations fetch `/platform.data`, which a
  /platform-scoped cookie does not match under RFC 6265 path rules (next char
  is "." not "/"), so the overview tab's data request arrived signed-out;
  found live 2026-08-20. Secure on https / forced in production), DB stores
  sha256(token). TTL 7 days sliding (renewed at most daily). Migration
  `20260820054345_platform_admin` (guarded workflow; scrub removed the usual
  6 differ artifacts).
- Login: `/platform/login` — email + password, same-origin check + in-memory
  attempt limiter reused from the web login. Timing-burn on unknown email.
- **Bootstrap**: `npx tsx scripts/platform-admin.ts create <email> <name> <password>`
  (also `list` / `reset-password` / `remove`). Convenience: while ZERO admins
  exist, a login matching `PLATFORM_ADMIN_EMAIL`+`PLATFORM_ADMIN_PASSWORD` env
  vars creates the first account. Login page shows bootstrap help when empty.
- `requirePlatformAdmin(request)` guard in every loader AND action of the
  authed pages (layout chrome is not a security boundary).
- Password change (self) revokes the admin's other sessions; account removal
  guards: never yourself, never the last admin.

## Tenancy exemption (deliberate)

Platform routes are **cross-tenant by design** — they aggregate over all shops and
write **global** (non-shop) configuration. They must never take a `shopId` from
user input to mutate shop rows. Files under `app/routes/platform.*` and
`app/lib/platform/` are exempt from the per-shop-scoping iron rule; the
tenancy-auditor should verify the guard (`requirePlatformAdmin`) instead.

## Storage — global config in `app_secrets`

Reuse the existing global KV table (`AppSecret`), zod-validated on read & write:

- `platform:ai` → `{ chatModel?: string; temperature?: number|null; maxTokens?: number|null }`
- `platform:plans` → `{ enforcement?: "open"|"enforced"; plans?: Partial<Record<PlanId, PlanDefinition-shaped partial>> }`

Blank/absent field = fall back to the code/env default. Corrupt JSON = ignored
(fail open to defaults, log once).

## Pages

1. **`/platform` (overview)** — shop count, breakdown by plan × planStatus,
   recent installs (domain, plan, installed date), currently effective AI model +
   enforcement mode, nav to the settings pages.
2. **`/platform/ai` (AI model settings)** —
   - Chat model: preset select (gpt-4o-mini, gpt-4o, gpt-4.1-mini, gpt-4.1) +
     "Custom…" free-text. Blank override = env `CHAT_MODEL`.
   - Temperature override (0–2, optional) and Max tokens override (optional).
     **When set these WIN over the per-call tuned values** (that's the point of a
     global lever); blank = keep the per-call tuning. UI carries a warning that
     the pipeline's temperatures are eval-tuned (decisions log 2026-08-17/18).
   - Embedding model: **read-only display** of env `EMBEDDING_MODEL` with a note —
     the pgvector column is pinned to 1536 dims by migration and every stored
     vector would need re-embedding; not a dashboard toggle.
3. **`/platform/plans` (plan features)** —
   - Enforcement mode switch (`open` ↔ `enforced`) with an explanatory banner —
     replaces the "edit ENFORCEMENT const in plans.server.ts" step from spec 15
     (PROGRESS pending-manual item 10 updated).
   - Per-plan editor (tab per tier): monthly price, yearly-per-month price, trial
     days, overage per conversation (blank = AI stops at cap), all 9 quota
     dimensions, all 10 gated-feature checkboxes.
   - "Reset all to code defaults" (deletes the override row).
   - Price note: changed prices apply to **new** subscriptions only; existing
     Shopify subscriptions keep their agreed charge.
4. **`/platform/admins`** — list operator accounts, add admin (name/email/
   password), remove (not self, not the last one), change own password.
5. **`/platform/usage` + `/platform/usage/:shopId` (token analytics)** —
   per-merchant LLM consumption and estimated cost (user request 2026-08-20).
   - **Capture**: `LlmCallContext { shopId, purpose }` is a REQUIRED argument on
     every `LlmProvider` method, so the compiler proves no call site consumes
     tokens anonymously (26 sites threaded). Purposes: `router | reply |
     summary | moderation | embedding`.
   - **Exact counts, not estimates**: non-streaming replies read
     `response.usage`; **streamed** replies set `stream_options:
     { include_usage: true }` and read the final usage-only chunk; embeddings
     read `response.usage.prompt_tokens` per batch. Cached prompt tokens are
     captured separately (they bill cheaper).
   - **Storage**: `llm_usage_daily` — one row per shop × UTC day × model ×
     purpose (calls + prompt/cached/completion tokens). Written
     **fire-and-forget** from `app/lib/llm/usage.server.ts`: never awaited,
     never throws, a blank shopId is dropped rather than written globally.
   - **Pricing**: maintained in code (`app/lib/platform/llm-pricing.ts`) from
     OpenAI's official price page, with `PRICING_VERIFIED_AT` shown in the UI —
     the operator never types prices (user decision). Unknown models count
     tokens but are flagged "unpriced" instead of costing $0.
   - **Index page**: totals (tokens / est. cost / active stores), 7·30·90-day
     range, per-merchant table sorted by cost (conversations, tokens, cost,
     cost per conversation), and a where-the-tokens-go breakdown by purpose.
   - **Detail page**: daily cost bars + by-purpose and by-model tables. The
     `:shopId` is validated against the shop table (404 when unknown) and is
     READ-only — no platform route ever mutates shop rows.
   - Uninstall cleanup deletes `llm_usage_daily` with every other shop table, so
     the audited "no rows survive cleanupShop" contract is unchanged
     (`verify-compliance` extended to 31 tables). Trade-off: churned merchants'
     cost history is deleted with them.

## Runtime plumbing

- `app/lib/billing/plans.server.ts`: code matrix becomes `DEFAULT_PLANS`; the
  exported `PLANS` object keeps its name/shape but is **mutated in place** when
  overrides load, so all 20+ existing consumers (incl. direct `PLANS[...]` reads
  in billing + plan-usage) pick up changes with zero signature churn. Sync
  accessors (`hasFeature`/`getQuota`/…) stay sync; each call triggers a
  fire-and-forget DB refresh when the cached copy is >30s old; eager load at
  module init + immediate reload after a platform save.
- `app/lib/llm/openai.server.ts`: `chat`/`chatStream` resolve
  `model = override.chatModel || env.CHAT_MODEL`,
  `temperature = override.temperature ?? options.temperature ?? 0.3`,
  `max_tokens = override.maxTokens ?? options.maxTokens ?? 300`.
  Overrides cached 30s, fail open to env defaults on DB error. Embeddings +
  moderation untouched.

## Files (as built)

- `app/lib/platform/platform-auth.server.ts` — session mint/read/destroy, login verify (+env bootstrap), guards.
- `app/lib/platform/platform-settings.server.ts` — AI + plan override read/save/reset (zod schemas), cache busting.
- `app/lib/billing/plan-shared.ts` — client-safe plan types + `PLAN_IDS`/`GATED_FEATURES`/`QUOTA_DIMENSIONS` (re-exported by `plans.server.ts` so existing consumers are untouched).
- `app/routes/platform.tsx` — layout (headers, css links, AppProvider).
- `app/routes/platform.login.tsx`, `platform.logout.tsx`, `platform._index.tsx`, `platform.ai.tsx`, `platform.plans.tsx`, `platform.admins.tsx`.
- `app/components/platform/PlatformShell.tsx` + `app/components/platform/platform.css` — top-bar chrome for authed pages.
- `scripts/platform-admin.ts` — account CLI · `scripts/platform-check.ts` — settings round-trip check.
- Env (bootstrap only): `PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD` in `env.server.ts` + `.env.example`.
- Migration `prisma/migrations/20260820054345_platform_admin/`.

## Environment-variable audit (2026-08-20)

Reviewed every variable in `env.server.ts` and moved everything operational out
of `.env` into `/platform/settings` (stored in `app_secrets["platform:runtime"]`).

**Stays in env — no dashboard equivalent:**
`DATABASE_URL` (needed to reach the store that holds the settings),
`SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` / `SHOPIFY_APP_URL` / `SCOPES`
(platform identity, injected by the CLI/host; the app cannot boot without them),
`PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD` (chicken-and-egg bootstrap —
they exist to create the first admin who could use the dashboard),
`LLM_PROVIDER` (one implementation; a toggle would be meaningless),
`EMBEDDING_MODEL` (**deliberate**: vectors are pinned to 1536 dims, so a change
needs a re-embed migration, not a settings toggle), plus `PORT` / `NODE_ENV` /
`PRISMA_CLIENT_ENGINE_TYPE`.

**Now dashboard-managed (env kept as fallback):** `OPENAI_API_KEY`,
`CHAT_MODEL`, `EMAIL_PROVIDER`, `EMAIL_FROM`, `RESEND_API_KEY`, `SMTP_HOST`,
`SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE`, `WEB_APP_URL`,
`SHOPIFY_APP_STORE_HANDLE`, `BILLING_TEST_MODE`, `BILLING_FORCE_TEST_CHARGES`,
`EMBED_STATUS_ENABLED`. (`VAPID_*` already auto-provisioned into `app_secrets`;
the page shows their status.)

### How it works — `app/lib/platform/runtime-config.server.ts`

- **Precedence**: dashboard value → env var → built-in default. Each field's
  live source (`dashboard` / `environment` / `default`) is shown in the UI.
- **Sync accessors** (`runtimeConfig()`), cached with a 30s TTL + eager load at
  boot, so the existing consumers kept their signatures — same pattern as the
  plan matrix. Reads never throw; a DB problem falls back to env.
- **Secrets encrypted at rest** (`secrets-crypto.server.ts`, AES-256-GCM, key
  derived from `SHOPIFY_API_SECRET`): `openaiApiKey`, `resendApiKey`,
  `smtpPass`. Secret fields are write-only in the UI (masked display, blank =
  keep current) and never sent to the browser.
- **Consumers rewired**: `openai.server.ts` (rebuilds its client when the key
  changes — rotation needs no restart), `email.server.ts` (transport re-created
  when credentials change), `shopify-billing.server.ts` (test mode + forced test
  charges), `embed-status.server.ts`, `team.server.ts` (`webBaseUrl`),
  ingestion key checks, and the App Store review link.
- **Page tools**: "Test connection" (validates the OpenAI key against
  `/v1/models`), "Send test email to me", per-section save, and a global
  "Clear all dashboard settings" that reverts everything to env.

## Audit record (2026-08-20)

tenancy-auditor on the full feature: **0 LEAK** (guard coverage, no shopId from
user input, hashed session tokens, plans rework doesn't weaken merchant gates,
AI override unreachable from merchant/shopper input, no cross-surface leakage).
4 RISK + 2 NOTE — **all fixed same day**:

- R1 last-admin count-then-delete race → remove wrapped in `db.$transaction`
  with the count re-checked inside.
- R2 no per-account lockout on the operator login → `PlatformAdmin.failedLogins`
  + `lockedUntil` (5 tries / 15 min, parity with TeamMember; migration
  `20260820061959_platform_admin_lockout`); verified by
  `scripts/platform-lockout-probe.ts`.
- R3 env-bootstrap compared the password non-constant-time → sha256-digest
  `timingSafeEqual`; `.env.example` now says to unset the vars after first login.
- R4 authed actions relied only on SameSite=Lax → `sameOrigin()` check added to
  the ai / plans / admins / logout actions (login already had it).
- N1 plan-override schema accepted junk keys → quota keys validated against
  `QUOTA_DIMENSIONS` (refine — enum-keyed z.record demands all 9 keys, patches
  are partial by design), features array is enum-typed.
- N2 Secure cookie flag depended on `x-forwarded-proto` → forced on when
  `NODE_ENV=production`.

## Out of scope / later

- Admin roles / audit log (v1 = all admins equal).
- Forgot-password email flow (use `scripts/platform-admin.ts reset-password`).
- Per-shop overrides or plan assignment from the panel (use `scripts/set-plan.ts`).
- Embedding-model switching (requires re-embed pipeline + column dim strategy).
- Other operator settings pages (user: "other settings we will implement later").

## Acceptance criteria

1. `/platform` (and every authed page/action) redirects to `/platform/login`
   when signed out; wrong password rejected; bogus/expired cookie rejected;
   correct credentials land on the overview; logout deletes the session row.
2. Admin management: add works; can't remove self or the last admin; password
   change requires the current password and revokes other sessions.
3. Saving a chat-model override changes the model used by the next pipeline LLM
   call **without a server restart** (≤30s cache window); clearing it falls back
   to env `CHAT_MODEL`. ✅ save/clear round-trip via `scripts/platform-check.ts`.
4. Editing a plan's quota/feature/price on `/platform/plans` is visible to
   merchant surfaces (plan-usage page reads the new matrix) and to
   `getQuota`/`hasFeature` once enforcement is on; values persist across restart.
   ✅ `scripts/platform-check.ts` (12/12: in-place PLANS mutation, persistence
   reload, gating under enforcement, untouched tiers keep defaults).
5. Enforcement switch flips `planEnforcementMode()` app-wide without code edits. ✅
6. Reset restores code defaults exactly (deep-equal vs `DEFAULT_PLANS`). ✅
7. `npm run typecheck && npm run lint && npm run build` green + `npm run smoke`
   still passes (plans.server refactor sits in the billing/search import graph).
