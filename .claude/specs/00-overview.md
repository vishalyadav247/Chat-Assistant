# 00 — Project Overview & Architecture

> Spec index and shared context for all feature specs. Read this before any feature spec.
> Sources: `.claude/resources/demo/PRODUCTION-BUILD-SPEC.md` (authoritative), `Chat-Flow-Explained.md`, `LLM-Training-Guide.md`, `LLM-Concepts-Explained.md`, `LLM-Guide.html`, `html_design/` + `NOTES.md`, demo `chatconvert_ui.py` + `data-sources/*.json`.

## What we are building

**ChatConvert** — a public, embedded Shopify app: an AI **sales + support** chat agent for storefronts.

- **Storefront**: a chat widget (theme app extension) helps shoppers find products, answers questions (shipping, returns, sizing, order status), and nudges toward purchase.
- **Shopify Admin**: merchants configure persona, knowledge, curated answers, guardrails; manage an inbox with human handover; run proactive chat campaigns; view analytics; manage plan/billing.

**Core principle:** the LLM is only the *voice*. A pipeline around it decides *what* the shopper needs, retrieves the *right* data (catalog / knowledge / live Shopify facts), and constrains the model so answers are accurate and safe. The LLM never touches the database directly. Grounding is **mechanical** — enforced in code, not by prompt hope.

## Tech stack (confirmed decisions)

| Concern | Choice |
|---|---|
| App framework | React Router v7 (Shopify app template), embedded admin, Polaris web components (`s-*`) |
| Database | Postgres + pgvector via Prisma (Docker `pgvector/pgvector:pg17` for dev, port 5433) |
| LLM | OpenAI `gpt-4o-mini` (routing + replies) + `text-embedding-3-small` (1536-dim), behind swappable `LlmProvider` interface in `app/lib/llm/` |
| Orchestration | Router-first v1; tool-calling added later for order status / add-to-cart |
| Streaming | SSE (POST + fetch-stream) via Shopify App Proxy; fallback: direct app-domain streaming with signed token |
| Jobs | pg-boss on the same Postgres (webhook handlers are enqueue-only) |
| Widget | Theme app extension in `extensions/chat-widget/` |
| Billing | Shopify Billing API (see spec 15) |

## System architecture

```
Storefront chat widget  ─┐                          ┌─ Postgres + pgvector (per-shop rows)
(theme app extension)    ├──►  App backend  ────────┼─ LLM provider (embeddings + chat)
Merchant admin app       ┘     (multi-tenant,        └─ Shopify Admin API + webhooks
(embedded in Admin)             agent pipeline)          (catalog, orders, GDPR)
```

- Backend holds all logic: agent pipeline, tenant isolation, caching, rate-limiting, billing.
- API keys live **only** on the backend. The widget never calls the LLM directly.
- Live facts (stock, price, order status) come from the Shopify API at answer time, never from the vector index.

## Multi-tenancy rules (non-negotiable)

1. Every domain table carries `shop_id`; every query filters by it. No cross-shop access, ever.
2. `shop_id` is the **first column** of every composite index.
3. Tenancy is enforced through `app/lib/tenancy.server.ts` helpers — raw queries take `shopId` as the first parameter; helpers throw if missing.
4. Uninstall → `shop-cleanup` job deletes all shop rows; `shop/redact` webhook (~48h later) is the backstop purge.
5. The `tenancy-auditor` subagent reviews every feature PR for scope leaks.

## Runtime pipeline (one shopper message)

```
1. identify shop + session; rate-limit; load config (cache)        (no LLM)
2. guardrail: keyword scan → moderation (parallel) → embedding sim  (no LLM)
3. curated match: ≥0.80 use directly; 0.65–0.80 LLM confirm         (0–1 tiny LLM)
4. router LLM → {intent, price_max, keywords, blocked, off_topic}
5. lane: buy=hybrid search | question=RAG | order=Shopify tool | chat=none
6. grounded generation, streamed                                     (1 LLM)
7. product cards from DB rows; log conversation/message/analytics
```

Budget: a normal turn ≈ 2 LLM chat calls + 1–2 embedding calls + a few DB/Shopify queries. One embedding per turn, reused across guardrail/curated/search/RAG. Details: spec 03.

## Guidelines (apply to every feature)

- **Embedded-app gotchas**: `Link` from react-router (never `<a>`), `redirect` from `authenticate.admin`, `useSubmit`; `boundary.error`/`boundary.headers` exports on nested admin routes.
- **Webhooks**: declared in `shopify.app.toml`; handlers do `authenticate.webhook` → enqueue → `200` within 5s. Idempotent upserts (webhooks redeliver).
- **No `prisma db push`** — migrations only (custom SQL for vector/GIN indexes lives in migration files).
- **Prompts** live in versioned config (ported verbatim from `resources/demo/prompts.json`), not scattered in code.
- **Plan gating** is data-driven from the plan matrix (spec 15) — never hard-code a tier's quota in UI (the design prototypes hard-code Plus values; that is a known design bug).
- **Currency**: always the shop's currency from Shopify (designs mix ₹ metrics with $ pricing; pricing is USD via Billing API, metrics use shop currency).
- **Naming cleanups**: design copy leaks "Chatty" (handover tab) and "Chittpa" (widget default name) — always "ChatConvert".
- Feature work follows the `spec-workflow` skill; compliance checked with `shopify-compliance` skill before merge.

## Spec index

| # | Spec | Feature |
|---|---|---|
| 00 | this file | Overview, architecture, guidelines |
| 01 | `01-foundation.md` | DB, schema, tenancy, jobs, proxy/SSE, project skeleton |
| 02 | `02-shopify-sync.md` | Catalog sync (products/collections/discounts) |
| 03 | `03-ai-pipeline.md` | Runtime agent pipeline |
| 04 | `04-knowledge-ingestion.md` | Data sources & knowledge ingestion |
| 05 | `05-storefront-widget.md` | Storefront chat widget |
| 06 | `06-chatbox-settings.md` | Chatbox settings + live preview |
| 07 | `07-ai-agent-training.md` | AI Agent home + training data |
| 08 | `08-ai-instructions.md` | Instructions, recommendations, handover config, Test AI |
| 09 | `09-curated-answers.md` | Curated answers |
| 10 | `10-inbox-handover.md` | Inbox + human handover runtime |
| 11 | `11-contacts.md` | Contacts CRM |
| 12 | `12-proactive-chat.md` | Proactive chat campaigns |
| 13 | `13-dashboard-onboarding.md` | Dashboard + onboarding checklist |
| 14 | `14-analytics.md` | Analytics |
| 15 | `15-billing-plans.md` | Billing, plans, usage metering, gating matrix |
| 16 | `16-settings.md` | Settings (general, availability, survey, tracking) |
| 17 | `17-compliance-gdpr.md` | GDPR, retention, app review |

## Suggested build order (after Phase 0 foundation)

02 sync → 03 pipeline → 05 widget → 06 chatbox → 09 curated → 04 ingestion → 07/08 AI agent admin → 10 inbox → 13 dashboard → 15 billing → 16 settings → 17 compliance hardening → 11 contacts → 14 analytics → 12 proactive chat.

(Compliance webhook *endpoints* ship in Phase 0; spec 17 is the full workflow + review checklist.)

## Glossary

- **Grounding** — restricting the model to retrieved facts only; product cards built from DB rows, never model text.
- **Hybrid search** — keyword (tsvector) + vector (pgvector cosine) merged, hard filters in SQL.
- **RAG** — retrieve top-k knowledge chunks, generate answer only from them.
- **Curated answer** — merchant-authored deterministic reply matched by embedding similarity; skips generation.
- **Handover** — defined exit to a human: capture contact, create inbox ticket, AI goes dormant on that conversation.
- **Lane** — the branch chosen by the router: buy / question / order / chat / blocked / handover.
