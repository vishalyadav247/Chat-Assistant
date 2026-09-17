# 24 — AI agent with tools (conversation-aware replies)

Status: **global default (2026-09-15)** — every shop runs the agent (`AI_AGENT_MODE=tools`),
default model **gpt-4.1-mini**. The spec-03 router + lanes remain only as the rollback switch
(`AI_AGENT_MODE=pipeline`). Spec 03's safety rules still apply. Explained for humans in
`docs/AI-AGENT.md`.

## Why

The 2026-09-14 review of every jgw-check conversation (PROGRESS decisions log, same date)
found that the pipeline decides what a message means from **the latest message alone**:

- the router may only return `intent: buy | question | chat` + keywords — whatever the model
  understood about the conversation is thrown away;
- retrieval embeds only the words just typed ("is it unisex");
- the product-detail check is a narrow yes-list; no record of which product is being discussed.

Follow-ups therefore fall back ("how to wear this", "is it unisex"), answer about **another**
product ("price of this" → Pyrite; "is this for men" → Amethyst Womens), or refuse
("any offer running" blocked by the `competitor pricing` meaning scan). Every fix so far was a
new prompt rule or regex for one phrasing.

## What

One agent call loop replaces router → lane selection → detail confirm → rescue → per-lane
prompts. The model reads the **whole conversation** (with system notes listing the products each
reply showed and the facts it looked up) and **looks facts up with tools** that code implements
and validates:

| Tool | Returns | Gate |
|---|---|---|
| `search_products(query, max_price?)` | ≤ 8 candidates: id, title, price (shop currency), availability, `match` best/possible, snippet | Learn products |
| `get_product(product)` | the product row: price, availability, variants, type, vendor, tags, metafields, description | Learn products |
| `show_products(products)` | renders ≤ 4 cards (+ merchant cross-sell only under a fresh search) | Learn products |
| `lookup_table(table, filters[])` | spec 28 — rows of the merchant's CSV lookup tables matched exactly (typo / punctuation / word-prefix tolerant, numeric ranges), `narrow_by` for filters not given, rows linked to products by SKU/handle/title become retrievable for `show_products` | ≥ 1 active table |
| `search_store_info(question)` | curated answers ≥ curatedBorderline (+ pinned products) + knowledge chunks ≥ minMeaningScore (searched with the model's question AND the shopper's words) + collection names | always |
| `get_discounts()` | active, AI-enabled discounts with codes | Learn discounts |
| `offer_button(button)` | track_order / contact_team / browse_faq (only those the shop enabled) | widget settings |
| `decline(kind)` | ends the turn with the store's own message (off-topic message / translated blocked-topic text) | always |
| `cannot_answer(question)` | logs the unresolved question; the reply offers the leave-message form | always |

Products are named by **title** (preferred) or id; `resolveProduct` matches id → products already
shown in the conversation → exact title → partial title (≥ 5 chars), always shop-scoped and
showable.

## Invariants

- **Grounding is code-enforced.** Cards (title, price, image, variant) are built from DB rows,
  never model text. Every tool query is shop-scoped (tenancy audit 2026-09-15: no leak).
- **Deterministic layers still run first:** rate limit, blocked visitor, human mode, AI off /
  usage cap (+ leave-message form), handover text triggers (the repeated-question trigger does
  not re-fire once handed over) + intent rules, banned-topic **phrase** scan (singular/plural
  tolerant; refusals count toward the cannot-answer handover), moderation, curated answers at
  the serve threshold, recommendation rules, order status (bare numbers need `#` / `no.` /
  `number`).
- The embedding meaning scan and the borderline-curated confirm are not used in agent mode.
- **No off-site links:** `LinkGuard` strips absolute URLs that are not the shop's domain from the
  streamed text.
- **Privacy:** the model gets first name, returning-customer flag, location, current product page
  and cart — never email, phone or address. Leave-message form submissions are replaced by a
  placeholder in history and summaries.
- **Bounded:** ≤ 5 rounds, ≤ 4 tool calls per round, 15 s tool budget, 30 s request timeout,
  45 s hard limit per streamed round, retries only in `withBackoff` (2).
- **Failure-safe:** a failed round serves the fallback + form and logs the question; the built-in
  fallback without a form promises no email (`fallbackNoForm`).
- Keys server-only; only `app/lib/llm/openai.server.ts` imports the SDK.

## Prompts

- `AGENT_SYSTEM` (`prompts.ts`) — category-neutral behaviour in five short sections (understand
  the conversation · use the tools for facts · recommend well · be honest · style). No store,
  category or phrasing rules.
- Dynamic: persona (install defaults for blank role / brand voice), language rule, shopper facts,
  `agentStoreContext` (store name, currency), `agentPolicy` (banned topics, scope or the generic
  "stay on this store" line), tool list per shop settings.

## Install defaults (`app/lib/ai-defaults.ts`)

Seeded once at install: generic role, "Friendly" brand voice, structured behaviours
(ROLE / GUIDELINES / AVOID), welcome message, banned topics (medical advice, legal advice,
competitor pricing), **blank** fallback (served as the translated built-in; the English text
earlier installs stored is treated as blank). **Store info is not seeded** — the merchant adds it.

## Model

Resolution: `AGENT_MODEL` (optional pin) → /admin dashboard model → `CHAT_MODEL`
(default `gpt-4.1-mini`). Global, not per store.

## Results (2026-09-14, jgw-check, 10 real conversations × 3 runs, gpt-4.1 judge)

| Engine | Pipeline-controlled turns | Conversations fully correct | Median / p90 | Model calls/turn | ≈ cost / shopper message |
|---|---|---|---|---|---|
| Pipeline (router + lanes) | 49/87 (56%) | 8/30 | 3.6 s / 5.4 s | 3.2 | $0.0009 (on gpt-4.1-mini) |
| Agent, gpt-4.1-mini | 76/87 (87%) | 14/30 | 3.7 s / 5.9 s | 2.9 | $0.001 |
| Agent, gpt-4.1 | 84/87 (97%) | 21/30 | 3.7 s / 5.5 s | 2.8 | $0.005 |

Post-hardening re-measurement (2026-09-15) is recorded in the PROGRESS decisions log.

## Acceptance

1. `npm run eval:conversations -- --runs 3` (agent, default model) at or above 87% of
   pipeline-tagged turns.
2. `pipeline-hardening` 136/136 (pipeline pinned), `install-lifecycle` all green, `data-sources`
   green except environment-timing checks, typecheck 0 · lint 0.
3. Tenancy audit and Shopify review findings resolved or documented.
