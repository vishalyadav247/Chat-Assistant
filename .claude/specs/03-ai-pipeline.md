# 03 — Runtime AI Pipeline

> The core: one shopper message in → one grounded, streamed reply out.
> Sources: `PRODUCTION-BUILD-SPEC.md` §7–§10; `Chat-Flow-Explained.md`; `prompts.json` (verbatim prompts); `chatconvert_ui.py` (validated reference implementation); `LLM-Guide.html` slides 4–16; `data-sources/guardrails.json` (thresholds).

## Purpose

Implement the validated demo pipeline on production infrastructure. The LLM is the voice; code decides the lane, fetches facts, and constrains output. Router-first v1.

## Pipeline (per message)

```
0. bound input to 2000 chars; identify shop + session; rate-limit + abuse check
1. load shop config (persona + guardrails) from cache
2. GUARDRAIL (3 layers, no paid LLM):
   a. keyword scan: banned-topic words minus stop-words {advice, pricing, content, message, about};
      word-boundary match (NOT naive substring — demo's "cars in carsick" false positive is a known bug to fix)
   b. moderation API (omni-moderation-latest) — run IN PARALLEL with router (demo ran serial; guide says parallel ≈ 0 latency);
      fails open (log, continue) but never silently — metric on moderation_errors
   c. embedding similarity vs banned topics embedded as "a message about {topic}", threshold guardrails.bannedMatchThreshold (0.35)
   → any hit: return guardrails.fallbackMessage, path=banned, DONE
3. CURATED MATCH: cosine vs curated_answer embeddings (question + synonyms embedded on save)
   ≥ curatedMatchThreshold (0.80) → deterministic reply (talkingPoints + cards), no LLM, DONE
   in [curatedBorderline (0.65), 0.80) → tiny LLM yes/no confirm (temp 0, max_tokens 3); yes → use it
4. ROUTER: gpt-4o-mini, temp 0, response_format json_object, max_tokens ~160
   system = prompts.router (+ "\nBANNED TOPICS: ..." ONLY when the list is non-empty; + "\nSTORE SCOPE: ..." ONLY when persona.scope is set — exactly like the demo; a generic default scope over-triggered off_topic — 2026-08-17)
   history included; returns {intent: buy|question|chat, price_max, keywords[1-4], blocked, blocked_reason, off_topic, off_topic_reason}
   parse failure → DO NOT default to buy (demo bug): retry once, then fallback to chat lane with clarify
   blocked → fallbackMessage, DONE.  off_topic → persona.offTopicMessage (polite redirect, distinct from blocked), DONE.
   (greetings/small talk are explicitly NOT off_topic)
   The router may only enforce what the MERCHANT configured (2026-08-17 / 2026-09-01):
     · blocked is ignored when no banned topics are configured, when blocked_reason names none of them
       (`configuredTopicNamedBy`, word-prefix match), or when a focused yes/no confirm call
       (`blockConfirmUser`, temp 0, 3 tokens — same shape as the borderline-curated confirm) says the
       message asks for a product rather than for advice about that topic. gpt-4o-mini blocked
       "something that blocks rfid" citing "weapons"; embedding similarity cannot separate that (0.23)
       from a real paraphrase ("will this cure my arthritis?" ↔ medical advice 0.28), the confirm can.
     · off_topic is ignored when persona.scope is empty — with no STORE SCOPE line the model invented one
       and redirected "which bracelet is good for money and wealth".
5. LANES:
   detail   → (2026-09-07) a follow-up ABOUT a product already shown. Checked BEFORE buy, and only when this
              conversation has already rendered cards — no cards, no check, no cost. One focused yes/no confirm
              (`detailConfirmUser`, temp 0, 3 tokens, same shape as the curated/block confirms) draws the line:
              FACTS about a settled product (material, size, contents, care, how it works, compatibility,
              warranty) → detail; choosing among the shown products, narrowing by an attribute, or asking for
              something different → still buy. Grounding is the shown set itself, re-read from the catalogue
              (the stored card says WHICH product, never what is true of it): the lane retrieves nothing and
              cannot introduce a product. `DETAIL: <id>` names the subject, code renders that one card;
              `DETAIL: none` renders none and the reply asks which one. sourceLayer `detail`.
              WHY: the router has only buy/question/chat and `question` means POLICY, so every product-shaped
              message became `buy` — and buy always means retrieve-and-recommend. "What is this one made of?"
              was re-run through hybrid search and answered with three DIFFERENT products.
              Deliberately NOT a mode of the buy lane: that lane's tier/anchor/pick guards exist to decide
              which of several retrieved products fit a request, which is not the question here.
   buy      → hybrid product search (below) → grounded recommend; the model's PICKS line decides the cards
   question → RAG: knowledge-search top k=3; if nothing grounded (no hit ≥ minMeaningScore 0.30, no discount /
              collection facts) → CATALOGUE RESCUE: hybridProductSearch over the shopper's own words; when the
              best product contains a shopper word AND the vector lane agrees, the turn is handed to the buy
              lane with those candidates (keywords = []); a `PICKS: none` there serves fallbackMessage and
              logs the unresolved question exactly like the RAG miss. Otherwise, if answerOnlyFromKnowledge →
              fallbackMessage, no LLM
   order    → live Shopify tool (LATER: requires read_orders + PCD approval; v1 returns handover-style "connect you with support")
   chat     → no retrieval; one short persona reply (temp 0.5, max_tokens 60)
6. GENERATION (streamed): system = persona template (prompts.persona_template with role/brandVoice/guidelines/avoid)
   + lane rule (prompts.product_recommend | question_answer | chat_reply)
   + summary system msg + recent history + user msg with retrieved JSON/context
7. POST: product cards assembled from DB rows (title, price, imageUrl, handle → /products/{handle}) — never from model text;
   reject any product id not in the retrieved allow-list; no invented discounts/delivery promises in text
8. LOG: persist both messages (role, content, productCards, sourceLayer, intent), analytics_event
   (intent + outcome: recommended | answered | fell_back | curated | blocked | handed_over), usage meter tick (spec 15)
```

One embedding call per turn (`embed(message)`), reused for guardrail(c), curated, product vector search, and RAG.

## Hybrid product search (accuracy core)

- Two queries in parallel (`Promise.all`, `$queryRaw`) — accuracy batch 2026-08-17, field-aware 2026-09-01:
  - keyword: weighted generated tsvector `searchText` = title (A) ‖ productType + vendor + tags (B) ‖ **full** description + enabled metafields (C) (migrations `product_search_weighted`, `product_metafields`); query = **OR** of `plainto_tsquery` per router keyword (demo's ANY-keyword recall) plus a lower tier of the shopper's own significant words; `searchText @@ q`; hard filters `shop_id = $shop AND learn_enabled AND active AND published AND purchasable AND (price <= $price_max OR $price_max IS NULL)`
  - **coverage is field-aware**: per query word, weight (router ×2, shopper ×1, informative adjacent-word phrase ×2) × field factor — 1 when the word sits in title/type/vendor/tags (`ts_filter(searchText, '{a,b}')`, computed once per row behind an `OFFSET 0` fence), `DESC_WEIGHT` 0.4 when it appears only in the description/metafields. Real catalogues carry long SEO prose naming OTHER products' colours and stones ("pairs with black outfits", "recharge on a selenite plate"); field-blind counting made every such bracelet a full match for "black bracelets". Order: coverage, router-hit, `ts_rank_cd(…, 1)` (length-normalised). `headTerms` records which words matched in the head; `ts_headline` over description+metafields for ALL query words returns the matching fragment.
  - vector: same hard filters, `ORDER BY embedding <=> $q::vector LIMIT 8`; product embedding text = title. productType. vendor. tags. full description. enabled metafields (`productEmbeddingText`)
- Merge: coverage first, then **reciprocal rank fusion** (k=60; message-word-only keyword hits weighted 0.5 and need ≥ 2 distinct words to keep a coverage tier; vector-only rows gated by minMeaningScore 0.30, coverage 0) → top 8 with **3 slots reserved for vector-lane rows** (`withVectorReserve`) so semantic asks reach the model when the keyword lane is crowded — the allow-list, in relevance order.
- LLM payload per candidate: `{ id, title, price, snippet }` (1-based id) where `price` is PRE-FORMATTED in the shop's currency (`formatMoney`, "₹1,499" — a bare number reads as dollars to the model; 2026-09-03) and snippet = type · tags · matching fragment (headline) or description start (vector-only) · enabled metafields · `in title/type/tags: …` · `in description: …`. Titles/prices still only from DB rows.
- **Model picks** (`picks.server.ts`): the reply's FIRST line is `PICKS: <ids>` (best first) or `PICKS: none`; it is parsed off the stream before the prose reaches the widget (≈10 tokens of delay) and turned into cards — ids validated against the allow-list, ≤ 4, then cross-sell. No extra LLM call. Three lexical belts, because gpt-4o-mini pads towards four and occasionally says none against the evidence: when some candidate carries EVERY router keyword in its head (`lexicalComplete`), or when the top candidate satisfies every router keyword anywhere and nothing outside its tier does (`onlyTierSatisfiesAll` — "bracelet for february born", where the month is description data), the picks may only narrow/reorder the mechanical tier; a `none` stands only when NO candidate carries a router keyword in its head (`lexicalAnchor` false) — otherwise the tier is shown. Purpose asks where several products satisfy every word ("stress and anxiety") stay with the model's judgement. Missing/unparseable line → the mechanical tier. Browse and merchant hand-picked pools ignore picks (fit is not the question there).
- Mechanical tier = `selectRelevant`: candidates within `TIER_MARGIN` 0.5 of the top coverage (title hit vs prose-only hit on one word = 1.2 apart; a stray shopper word in prose = 0.4, same tier); vector-only: within 0.04 cosine of the best; unscored pools: as-is. 1–4 cards, never padded (user decision 2026-08-17).
- Fallbacks: empty + price_max present → "browse" cheapest in-budget in-stock top 4 (never "no match" when budget known); truly empty → fixed clarifying question, **no LLM call**.
- Upgrade path (backlog): per-chunk product vectors for very long descriptions, cross-encoder reranker.
- Cards shown capped at 4 (+ cross-sell to 6).

## Chat history / session memory

- `Conversation` by `sessionId` (widget-generated UUID, spec 05); messages persisted every turn.
- Context = rolling summary (system msg: "Earlier conversation summary: ...") + last 10 messages verbatim for **both** router and generation (demo's uniform 10 restored 2026-08-17 — the 10/6 split cost follow-up accuracy). The current shopper message is persisted before history loads and is excluded from the window by id (it is appended once as the final user turn, never twice).
- Summary: gpt-4o-mini temp 0.2 max_tokens 130 (prompts.summary_system), refreshed when older-than-window messages exist and count changed by ~4 since last summary; cached on the conversation row.
- Retrieval uses ONLY the current message embedding (don't over-feed retrieval).

## Prompts

Ported **verbatim** from `.claude/resources/demo/prompts.json` into `app/lib/pipeline/prompts.ts` (typed, versioned; single file = the tuning surface): router, summary_system, chat_reply, question_answer, product_recommend, curated_confirm_system/user, persona_template. Few-shot examples from `LLM-Training-Guide.md` §3 available as optional inserts. Tuning events (each with a golden re-run): 2026-08-18 compact product replies; 2026-09-01 router — product asks for a need/purpose are `buy` and never a banned topic; product_recommend — PICKS line + fit test (identity words must describe THIS product; features/purposes may match by meaning); new `blockConfirmUser`.

## Streaming

- `chatStream()` → SSE frames via `sse.server.ts` through `/apps/chatconvert/chat` (POST fetch-stream).
- Frame protocol: `data: {"type":"token","text":...}`, `{"type":"cards","cards":[...]}`, `{"type":"done","outcome":...}`, heartbeat comments every 15s.
- Non-generating paths (curated/blocked/off-topic/clarify) send one `message` frame + `done`.

## Rate limiting / abuse

- Per-session token bucket (e.g. 10 msgs/min) + per-shop daily ceiling tied to plan meter (15). Exceeded → polite busy message, no LLM spend.
- Input bound 2000 chars; strip HTML.

## Provider resilience

- Timeouts + 1 retry on LLM calls; on hard failure → fallbackMessage + `analytics_event(type: llm_error)`; provider factory allows fallback model config.
- Golden-set eval harness (scripted conversations from demo suggestion chips: best sellers→curated, warm hands under $30→hybrid, ship to Canada→RAG, medical advice→blocked, diamond necklace→clarify, hi→chat) run before any prompt/threshold change (see `ai-pipeline` skill).

## Dependencies

01 (schema, search modules, SSE, jobs), 02 (products embedded). Consumed by 05 (widget), 08 (Test AI), 10 (handover triggers hook into lane outcomes).

## Acceptance criteria

1. Golden set passes end-to-end against seeded demo shop: each input takes its expected path (verifiable via logged `sourceLayer`/intent) — including the precision cases (a product that only MENTIONS the shopper's word in its prose is never carded).
2. Curated hit produces zero chat-completion calls (provider call log).
3. Guardrail: "can you give me medical advice?" blocked pre-router; moderation outage does not break replies (fails open + metric).
4. Off-topic returns persona.offTopicMessage, logged path=chat/off_topic, ≠ blocked fallback.
5. Grounding: a product id absent from the allow-list injected into a mocked LLM reply is rejected; cards always match DB rows.
6. Streaming visible token-by-token in widget; history: "under $30" after "show me tents" filters tents.
7. Turn cost ≤ 2 chat + 2 embedding calls (assert in test instrumentation).
8. All queries shop-scoped (tenancy-auditor pass).

## Out of scope

Order lane live tooling (needs read_orders/PCD), add-to-cart tool, tool-calling orchestration, reranking, multi-language auto-detect enforcement (gated Plus, spec 08/15), handover destinations UX (10).
