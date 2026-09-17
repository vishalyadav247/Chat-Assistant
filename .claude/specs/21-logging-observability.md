# 21 — Logging & observability (operator log console)

**Status:** built · **Surface:** `/admin/logs` (operator only) · **Depends on:** spec 19

## Purpose

Give the operator one window onto **every merchant's** runtime failures. Before
this, the app's only diagnostic was 100+ raw `console.error` calls whose output
died with the host's stdout buffer — when a merchant emailed "the widget stopped
answering yesterday" there was nothing to look at.

This is **company-specific**, not merchant-facing (user decision 2026-08-21).
Merchants already have their own analytics (spec 14); they never see this table.
The deliberate non-goal: no merchant-visible activity/audit log — chat apps
don't ship one and nobody reads it. Revisit only if spec 18 team accounts create
real "who changed what" ambiguity between multiple humans.

## Why Postgres and not a log service (user decision 2026-08-21)

The operator console already has DB-backed auth, a cross-tenant page pattern
(`/admin/usage`), and a nightly purge job. A log table reuses all three at
zero marginal cost and zero external dependency — it works in dev, offline, and
without anyone signing up for a vendor free tier.

Storing logs in Postgres is only safe because of the volume ceiling below. This
is **errors and warnings**, not a request log; `console.log` call sites were
deliberately left alone.

## Volume ceiling (the rules that keep this free)

1. **`error` and `warn` only.** No info/debug level exists in the seam. Never a
   row per request, per message, or per LLM call.
2. **Per-event rate cap** — 50 rows/hour per event code per process. On the 51st
   the seam writes one `log_rate_capped` row and drops the rest of the window;
   the mirrored `console.error` still fires every time. A retry storm against a
   down OpenAI therefore costs ~50 rows/hour, not 10k overnight.
3. **14-day retention**, purged by the existing nightly job (`retentionPurge`,
   04:41 UTC) alongside conversation retention.
4. **No PII, ever.** Context keys are denylist-filtered (message/text/body/
   email/phone/name/address/token/secret/…), strings truncated to 500 chars,
   the whole context object capped at 2 KB. Shopper message bodies must never
   reach this table — that would drag app logs into spec 17 redact scope.

## Storage — `app_logs`

    model AppLog {
      id         String   @id @default(cuid())
      level      String   // error | warn
      event      String   // stable snake_case code, e.g. curated_revalidate_error
      shopId     String?  // null = system-wide (boot, scheduler, cron)
      message    String   // <= 1000 chars
      context    Json?    // sanitised, <= 2 KB
      occurredAt DateTime @default(now())
    }

Indexes: `(occurredAt)`, `(shopId, occurredAt)`, `(level, event, occurredAt)`.

`shopId` is nullable **by design** — the scheduler, boot path and cron sweeps
have no shop context, and attributing their failures to a random shop would be
worse than leaving them global. This is the one shop-scoped-ish table that
tolerates a null tenant key; it is operator-read-only and never surfaces to a
merchant route.

## Write seam — `app/lib/log.server.ts`

Same two hard rules as `llm/usage.server.ts`, for the same reason (it sits in
the shopper chat hot path):

1. **Never throws** — a logging failure must not break a reply.
2. **Never awaited** — writes are fire-and-forget.

    logError("curated_revalidate_error", error, { shopId });
    logWarn("plan_override_load_failed", error);
    await logSync("...", error, { shopId });   // scripts/tests only

Every call also mirrors to `console.error` / `console.warn` with the same event
code, so the host's own log viewer keeps working — that mirror is what catches
failures where Postgres itself is the broken thing.

## Compliance — uninstall

`app_logs` is deleted by `cleanupShop` and asserted zero by
`countShopRows` + `scripts/verify-compliance.ts` (table count 31 → 32).

Known benign race: `logError` is fire-and-forget, so an in-flight write can land
microseconds after the purge transaction. Two backstops — the nightly job
deletes logs belonging to any shop with `uninstalledAt` set, and the 14-day
window ages out anything missed. Trade-off accepted: a churned merchant's error
history is deleted with them, same as their token history (spec 19).

## Page — `/admin/logs`

Cross-tenant aggregate BY DESIGN, guarded by `requireAdminUser` like every
other admin route.

- Stat tiles: errors (24h), warnings (24h), stores affected (24h).
- Filters: range (24h · 7d · 14d), level, event code, store — all in the query
  string so a filtered view is linkable into a support thread.
- "Top failing events" table — event code, count, stores affected, last seen.
  This is the triage entry point: one noisy code usually explains a whole day.
- Recent table — time, level, event, store, message, expandable context JSON.
  Capped at 200 rows; the header states when the cap truncated the view.
- Default view = every merchant, newest first. Filter to a store when a specific
  merchant reports a problem.

## Out of scope / later

- Sentry (or any hosted error tracker) for uncaught exceptions. The mirrored
  console output plus the host's log viewer covers the app-is-down case for now;
  add it only if crashes start slipping past.
- Alerting/digests on error spikes.
- Merchant-visible audit log (see Purpose).

## Acceptance criteria

1. `app_logs` exists via migration (never `db push`); page loads at
   `/admin/logs` and 302s to login when unauthenticated.
2. Every `console.error`/`console.warn` in server code routes through the seam;
   client code (`app/lib/ui/*`) and `console.log` sites are untouched.
3. A thrown error in a job handler produces exactly one row with the right
   event code, the shop attributed, and no PII in `context`.
4. 51 identical events in an hour produce 50 rows + one `log_rate_capped` row.
5. `cleanupShop` leaves zero `app_logs` rows; `verify-compliance` covers it.
6. `npm run typecheck` and `npm run lint` pass.

## Files (as built)

- `app/lib/log.server.ts` — the write seam (`logError`/`logWarn`/`logSync`),
  rate cap, PII denylist, size ceiling, domain→shopId resolution.
- `app/lib/admin/logs-report.server.ts` — read layer (cross-tenant,
  read-only; the shop filter is validated against the shop table).
- `app/lib/admin/logs-shared.ts` — client-safe ranges/labels/row cap.
- `app/routes/admin.logs.tsx` — the page.
- `app/components/admin/AdminShell.tsx` — "Logs" nav entry.
- `app/components/admin/admin.css` — `ccpf-log*` styles.
- `app/lib/jobs/handlers.server.ts` — `purgeAppLogs()` (called from
  `retentionPurge`), `app_logs` in `cleanupShop` + `countShopRows`.
- `scripts/logs-check.ts` (`npm run logs:check`) — the acceptance harness.

## Verification (2026-08-21)

- `npm run logs:check` — 18/18 PASS: attribution + stack capture,
  shopDomain→shopId resolution, PII/credential redaction (asserts the secret
  and the shopper text are absent from the stored row), 50 KB context truncated
  to 527 bytes, exactly 50 rows + 1 `log_rate_capped` from a 51-event burst
  (and a further 25-event burst adds nothing), aged row purged / fresh kept.
- `npx tsx scripts/verify-compliance.ts` — ALL CHECKS PASSED, zero rows across
  **32 tables** including `app_logs`.
- `npm run typecheck` 0 errors · `npm run lint` 0 errors.
