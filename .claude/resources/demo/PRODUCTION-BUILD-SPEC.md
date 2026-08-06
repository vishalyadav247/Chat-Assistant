# ChatConvert — Production Build Spec (source of truth)

**Purpose of this file (two jobs):**
1. **Alignment** — so the human (Aditya) can read it and confirm "my requirements and this implementation match."
2. **Build context** — so an AI coding assistant (e.g. Claude Code) can load it and implement the real app consistently with what the demo already validated.

Keep this file authoritative. If the design changes, change it here first.

---

## 1. What we're building

A **public, embedded Shopify app**: an AI **sales + support** chat agent for storefronts.
- On the storefront it helps shoppers find products and answers questions (shipping, returns, sizing, order status), and nudges toward purchase.
- In Shopify Admin, merchants configure the persona, knowledge, curated answers, and guardrails, and view analytics.

**Core principle:** the LLM is only the *voice*. A pipeline around it decides *what* the shopper needs, retrieves the *right* data (catalog / knowledge / live Shopify facts), and constrains the model so answers are accurate and safe. The LLM never touches the database directly.

---

## 2. What the demo already validated

The demo (`chatconvert_ui.py` + `data-sources/*.json`) is a working, runnable proof of the pipeline:
`guardrail → curated-answer match → intent router (LLM) → [hybrid product search | RAG over knowledge | chat] → grounded LLM reply`.

Production keeps this exact pipeline. It changes only the *infrastructure* (see §11):
- in-memory numpy vectors → **Postgres + pgvector**
- Tkinter window → **Shopify storefront widget + backend**
- static JSON files → **DB tables + live Shopify sync**

---

## 3. Requirements & key decisions — CONFIRM THESE

> Human: tick each line as correct, or correct it. This is the alignment checklist.

- [ ] **Stack:** Remix app (React Router) + **Postgres (with pgvector)** backend. *(Note: the older `chatconvert` repo was Gadget-based; confirm the pivot to Remix + own Postgres.)*
- [ ] **Models:** OpenAI `text-embedding-3-small` (1536-dim) for embeddings; `gpt-4o-mini` for routing + replies. Swappable behind an interface.
- [ ] **Multi-tenant:** one app serves many shops; every row and query is scoped by `shop_id`. No cross-shop access, ever.
- [ ] **Agent behaviour:** sales (product recommendations) **and** support (policy/FAQ/order status).
- [ ] **Grounding:** the model may only recommend products returned by search, and answer questions only from retrieved text. Enforced in code.
- [ ] **Live facts** (stock, price, order status) come from the **Shopify API at answer time**, never from the vector index.
- [ ] **Streaming** replies to the widget.
- [ ] **Human handover** when the agent can't help.
- [ ] **Compliance:** mandatory GDPR webhooks, data-retention window, PII care (required for App Store).
- [ ] **Billing:** Shopify Billing API with per-plan usage caps.

---

## 4. System architecture (components)

```
Storefront chat widget  ─┐                         ┌─ Vector DB (Postgres + pgvector, per shop)
(theme app extension)    ├──►  App backend  ───────┼─ LLM provider (embeddings + chat)
Merchant admin app       ┘     (multi-tenant,       └─ Shopify Admin API + webhooks
(embedded in Admin)            agent pipeline)          (catalog, orders, GDPR)
```

- **Backend** holds all logic: the agent pipeline, tenant isolation, caching, rate-limiting, billing.
- The LLM and vector DB are dependencies the backend calls. Swapping either doesn't change the rest.
- API keys live **only** on the backend. The widget never calls the LLM directly.

See `LLM-Architecture-Shopify.html` for the visual version.

---

## 5. Data model (Postgres + pgvector)

Enable pgvector: `CREATE EXTENSION IF NOT EXISTS vector;`

```sql
-- catalog (synced from Shopify, embedded for meaning search)
products(
  id, shop_id, shopify_product_id, title, description, product_type,
  price numeric, stock int, image_url, handle,
  embedding vector(1536)
)

-- merchant knowledge (policies/FAQ/docs, chunked + embedded → RAG)
knowledge(
  id, shop_id, source_id, topic, body, embedding vector(1536)
)
data_source(  -- where knowledge came from (URL, PDF, CSV, manual, policy page)
  id, shop_id, type, url, status, last_synced_at, metadata jsonb
)

-- hand-picked answers (embedded question, deterministic reply)
curated_answer(
  id, shop_id, question, synonyms text[], product_ids text[],
  talking_points text, status, embedding vector(1536)
)

-- per-shop config (no vectors)
persona(shop_id, role, brand_voice, behaviours, guidelines text[], avoid text[],
        default_language, languages text[], welcome_message)
guardrails(shop_id, answer_only_from_knowledge bool, banned_topics text[],
           fallback_message, min_meaning_score, curated_match_threshold)

-- conversations & logging (analytics + feedback loop)
conversation(id, shop_id, session_id, outcome, status, started_at, ended_at)
message(id, conversation_id, role, content, product_cards jsonb, source_layer,
        intent jsonb, created_at)
analytics_event(id, shop_id, type, payload jsonb, occurred_at)
```

- Every table carries `shop_id` and is always filtered by it.
- Add a pgvector index for scale: `CREATE INDEX ON products USING hnsw (embedding vector_cosine_ops);` (same for `knowledge`, `curated_answer`).

---

## 6. Ingestion pipeline (background)

Runs on install, on Shopify webhooks, and on a schedule.

1. **Catalog sync** — Shopify `products/create|update|delete` webhooks → normalize → embed `title + description` → upsert `products.embedding`. Keeps vectors fresh; stock/price also stored but re-checked live at answer time.
2. **Knowledge ingestion** — merchant adds policy URL / page / PDF / CSV / manual text → fetch (SSRF-guarded) → strip HTML → chunk (~1500 chars, ~150 overlap) → embed → insert `knowledge` rows linked to a `data_source`.
3. **Curated answers** — embed `question + synonyms` on save.
4. **Config** — persona/guardrails saved as plain rows.

---

## 7. Runtime agent pipeline (per shopper message)

Legend: **L** = LLM chat call, **E** = embedding call, **D** = DB query, **S** = Shopify API.

```
1. backend   identify shop, session; rate-limit + abuse check          (no LLM)
2. backend   guardrail: banned-topic check (guardrails.banned_topics)   (no LLM)
             → if hit: return fallback_message. DONE.
3. E + D     curated match: embed msg; pgvector search curated_answer
             → if score ≥ curated_match_threshold: return curated reply. DONE (no LLM)
4. L         intent router → {intent: buy|support|order|chat, price_max, keywords}
5. retrieve depending on intent:
   • buy     E + D  embed msg; hybrid search products (see §8)
   • support E + D  embed msg; pgvector search knowledge (RAG), top-k
   • order   S      call Shopify API for order status
   • chat    —      no retrieval
6. L (stream) generation: system(persona + rules) + retrieved data + message
             → grounded reply, streamed to widget
7. backend   assemble product cards from DB rows; log conversation/message/analytics
```

**Two orchestration options for steps 4–6:**
- **Router-first** (deterministic): the router call picks the lane; backend runs the query. Simple, predictable.
- **Tool-calling** (agentic): give the LLM tools (`search_products`, `search_knowledge`, `get_order_status`, `add_to_cart`); it decides which to call, backend executes, returns results, LLM answers. Handles mixed intents ("warm gloves under $30, and where's order #1234?") in one exchange.
- **Recommended:** start router-first; add tool-calling for live-data/actions and mixed intents.

A normal turn ≈ **2 LLM chat calls + 1–2 embedding calls + a few DB/Shopify queries.**

---

## 8. Hybrid product search (the accuracy core)

```sql
-- keyword + filters (exact terms, budget, stock, type) AND meaning ranking
SELECT id, title, price
FROM products
WHERE shop_id = $shop
  AND stock > 0
  AND ($price_max IS NULL OR price <= $price_max)
  AND (
        to_tsvector(title||' '||description) @@ plainto_tsquery($keywords)   -- keyword
     OR TRUE                                                                 -- (union w/ vector below)
      )
ORDER BY embedding <=> $query_embedding      -- pgvector cosine distance, closest meaning first
LIMIT 8;
```

In practice: run a keyword/filter query and a vector query, **merge + dedupe**, apply hard filters (price/stock), and hand the top ~8 to the LLM as the candidate allow-list. If nothing matches but a price filter exists → **browse** cheapest in-budget items (don't say "no match"). If truly nothing → ask a clarifying question.

---

## 9. Tools (function-calling signatures)

```
search_products(query: string, price_max?: number, product_type?: string) -> [{title, price, id}]
search_knowledge(query: string) -> [{topic, body}]
get_order_status(order_number: string, email: string) -> {status, eta, tracking_url}
add_to_cart(variant_id: string, quantity: int) -> {ok, cart_url}
create_handover(reason: string, contact?: {email}) -> {ok}
```

The backend implements each (DB or Shopify API) and enforces `shop_id` scoping. The LLM only ever receives what these return.

---

## 10. Prompts, guardrails & grounding

- The exact system prompts (router, product, RAG, chat) and the always/never rules are in **`LLM-Training-Guide.md`** — use those verbatim as the starting point.
- **Grounding is mechanical:** filter candidates by allow-list before the LLM sees them; reject any product id the model returns that wasn't retrieved; build card fields (title, price, image) from DB rows, never from model text.
- **Output guard:** nothing in the reply text should contain invented discounts, delivery promises, or stock claims; keep facts in cards/tools.

---

## 11. Demo → production mapping

| Concern | Demo (now) | Production |
|---|---|---|
| Vector search | in-memory numpy cosine | Postgres + pgvector (`<=>`, HNSW index) |
| Data source | static JSON in `data-sources/` | DB tables + Shopify catalog sync + knowledge ingestion |
| Front end | Tkinter desktop window | Shopify storefront widget (theme app extension) |
| Live facts | none | Shopify Admin API (stock, price, order status) |
| Multi-tenant | single dataset | `shop_id` scoping on every row/query |
| Reply delivery | full text | streamed tokens |
| Improvement | manual file edits | logged conversations + eval/feedback loop |

The **pipeline logic, prompts, grounding, and guardrails carry over unchanged** — only the infrastructure grows up.

---

## 12. Open questions to confirm

1. Remix + own Postgres, or continue on the existing Gadget backend? (affects data-access layer)
2. Router-first vs tool-calling first for v1?
3. Which live tools for v1 — product search + knowledge only, or also order status + add-to-cart?
4. Streaming transport from backend to widget (SSE / websockets)?
5. Reranking and per-plan caps — v1 or later?

---

*Related files: `LLM-Architecture-Shopify.html` (visual architecture), `LLM-Concepts-Explained.md` (the ideas), `LLM-Training-Guide.md` (the exact prompts), `chatconvert_ui.py` + `data-sources/` (the runnable proof).*
