---
name: shopify-compliance
description: Public-app App Store review and privacy requirements. Use before merging any feature, when touching webhooks/billing/scopes/PII, and before any app submission.
---

# Shopify public-app compliance

Full checklist lives in `.claude/specs/17-compliance-gdpr.md`. This skill is the per-change gate.

## Check on every feature merge

1. **Scopes**: did this change add/need a scope? Minimal scopes only; `read_orders` or customer scopes = Protected Customer Data process — stop and confirm with the user.
2. **PII**: what new personal data is stored? Must be: minimal, shop-scoped, covered by retention + redaction jobs (customers/redact, shop/redact must delete it — extend those jobs when adding PII-bearing tables).
3. **Billing**: any paid feature must be gated via `requirePlan()` server-side (spec 15 matrix) and charged only through Shopify Billing API.
4. **Webhooks**: compliance topics must keep returning 200 (valid HMAC) / 401 (invalid). Never remove or bypass `authenticate.webhook`.
5. **Storefront performance**: widget/extension changes keep the bundle deferred, small (<30KB gz core), zero CLS, no external CDNs.
6. **Embedded UX**: session-token auth for every embedded (admin) request, no cookie-based auth fallback inside the admin, Polaris UI, App Bridge for top-level redirects. The standalone web surface (spec 18) is the one sanctioned cookie session (first-party, HttpOnly, SameSite=Lax, `TeamSession`-backed) — it must stay additive (embedded app remains feature-complete, req 2.2.2) and reviewers need a web test login (req 4.5).

## AI-specific obligations

- Grounding claims in the listing must stay true: no invented products/prices/discounts/policies (mechanically enforced, spec 03).
- Moderation layer stays in the pipeline; human handover path always exists.
- Privacy policy must disclose LLM processor (OpenAI), data flows, retention.

## Red flags → stop and surface to user

External payment collection; storing payment/checkout data; scraping other stores; sending merchant data to third parties beyond OpenAI; disabling HMAC checks "temporarily"; shipping with test billing mutations.

Verify current review rules via shopify-dev-mcp / shopify.dev before submission — requirements change.
