# 17 — Compliance, GDPR & App Review

> Mandatory webhooks, retention, PII posture, and the App Store review checklist.
> Sources: design `settings.html` privacy tab; `PRODUCTION-BUILD-SPEC.md` §3 (compliance line); Shopify public-app requirements (verify current details via shopify-dev-mcp at build time).

## Purpose

Everything required to pass App Store review and honor privacy obligations: the three compliance webhooks with real workflows, retention enforcement, PII minimization, and a pre-submission checklist.

## Compliance webhooks (endpoints ship in Phase 0; workflows here)

Declared in `shopify.app.toml` `compliance_topics` → `/webhooks/compliance`. `authenticate.webhook` verifies HMAC (401 on invalid — a review test).

### customers/data_request
1. Payload: shop, customer (email/id), orders_requested.
2. Create `DataRequest` row (shopId, customerEmail, status: pending, requestedAt, dueAt = +30 days).
3. Job compiles export: conversations + messages tied to that email (via Contact) → JSON/CSV artifact stored per shop.
4. Surfaced in Settings → Privacy (16): list + Download; merchant fulfils to customer. Email notification to merchant.
5. Status → completed on download; overdue flagged before 30-day SLA.

### customers/redact
1. Enqueue redact job: find Contacts by email/customer id → delete their conversations, messages, contact rows, analytics payload PII for that shop.
2. Record `RedactLog` (shopId, type, receivedAt, completedAt) — audit trail, no PII in log.
3. Idempotent (re-delivery safe).

### shop/redact (~48h after uninstall)
1. Enqueue full purge: all rows for shop across every table (products, knowledge, sources, curated, persona, guardrails, conversations, messages, contacts, events, settings, campaigns, usage, sessions) — the backstop behind Phase-0's uninstall `shop-cleanup`.
2. RedactLog entry; job verifies zero remaining rows (count assertion).

## Data retention (16 UI)

- Setting: Forever/90/60/30/7 days. Daily pg-boss cron: delete conversations+messages older than window (per shop), independent of webhooks. Contacts kept (redact/uninstall governs them). Analytics rollups (14) survive (aggregates, no transcripts).

## PII posture

- Stored customer PII = optional email/name/phone from pre-chat/handover forms, conversation text, coarse location. No payment data, no addresses, no order contents (until orders scope, which triggers Protected Customer Data process — deliberately deferred).
- PII never sent to the LLM beyond the shopper's own message text; system prompts contain no customer PII.
- Logs/analytics events store ids, not emails, where feasible; provider (OpenAI) usage under DPA — document in privacy policy.
- Secrets: OPENAI_API_KEY server-only; session tokens via library; no PII in URLs.

## App Store review checklist (pre-submission gate — also lives in `shopify-compliance` skill)

1. **Auth & install**: OAuth immediately, no UI before auth; embedded, session-token auth; works on a fresh dev store first try.
2. **Billing**: all charges via Billing API; plans/trial/overage match listing; test charges verified.
3. **Mandatory webhooks**: three compliance topics respond 200 w/ valid HMAC, 401 invalid (automated review check).
4. **Scopes**: minimal (`read_products` v1); each scope justified in listing; no PCD scopes without approval.
5. **Performance**: no Lighthouse degradation >10 pts on storefront (widget deferred, <30KB, no CLS); admin loads within Shopify limits.
6. **Theme extension**: app embed off by default until merchant enables; uninstall leaves no theme residue (extension-based, auto).
7. **UX**: Polaris admin, App Bridge nav, no broken links, contextual save bars, error states.
8. **Listing**: accurate screenshots, privacy policy URL, support contact, data-use disclosure (AI/LLM processing disclosed).
9. **Privacy policy**: names OpenAI as processor, retention windows, GDPR contact.
10. **Uninstall**: app/uninstalled cleanup + shop/redact purge verified.
11. **AI-specific**: grounding claims accurate (no invented discounts/policies); moderation in place; human handover exists (good-faith AI merchant experience).

## Acceptance criteria

1. All three webhooks: valid-HMAC 200 within 5s, invalid-HMAC 401 (automated test); jobs execute the described workflows.
2. data_request produces a downloadable export containing exactly that customer's data; appears in Settings with due date.
3. customers/redact removes the customer's rows; unrelated shop data untouched (tenancy test).
4. shop/redact leaves zero rows for the shop (count assertion across all tables).
5. Retention job deletes only past-window transcripts per shop setting.
6. Checklist run recorded in PROGRESS.md before any submission.

## Out of scope

Protected Customer Data application (deferred with read_orders), SOC2-style audit tooling, cookie consent banners (widget uses functional storage only).
