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
5. LANES:
   buy      → hybrid product search (below) → grounded recommend
   question → RAG: knowledge-search top k=3; if answerOnlyFromKnowledge && (none || top < minMeaningScore 0.30) → fallbackMessage, no LLM
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

- Two queries in parallel (`Promise.all`, `$queryRaw`) — accuracy batch 2026-08-17:
  - keyword: weighted generated tsvector `searchText` = title (A) ‖ productType + vendor + tags (B) ‖ **full** description (C) (migration `product_search_weighted`); query = **OR** of `plainto_tsquery` per router keyword (demo's ANY-keyword recall) plus a lower tier of the shopper's own significant words; `searchText @@ q`, ordered router-hit first then `ts_rank_cd`; `ts_headline` returns the matching description fragment; hard filters `shop_id = $shop AND learn_enabled AND purchasable AND (price <= $price_max OR $price_max IS NULL)`
  - vector: same hard filters, `ORDER BY embedding <=> $q::vector LIMIT 8`; product embedding text = title. productType. vendor. tags. full description (`productEmbeddingText`)
- Merge: **reciprocal rank fusion** (k=60; message-word-only keyword hits weighted 0.5; vector-only rows still gated by minMeaningScore 0.30) → sorted → `.slice(0, 8)` — the allow-list, in relevance order.
- LLM payload per candidate: `{ title, price, snippet }` where snippet = type · tags · matching description fragment (headline) or description start (vector-only). Titles/prices still only from DB rows.
- Fallbacks: empty + price_max present → "browse" cheapest in-budget in-stock top 4 (never "no match" when budget known); truly empty → fixed clarifying question, **no LLM call**.
- Upgrade path (backlog): per-chunk product vectors for very long descriptions, cross-encoder reranker.
- Cards shown capped at 4 = the top-4 fused candidates.

## Chat history / session memory

- `Conversation` by `sessionId` (widget-generated UUID, spec 05); messages persisted every turn.
- Context = rolling summary (system msg: "Earlier conversation summary: ...") + last 10 messages verbatim for **both** router and generation (demo's uniform 10 restored 2026-08-17 — the 10/6 split cost follow-up accuracy). The current shopper message is persisted before history loads and is excluded from the window by id (it is appended once as the final user turn, never twice).
- Summary: gpt-4o-mini temp 0.2 max_tokens 130 (prompts.summary_system), refreshed when older-than-window messages exist and count changed by ~4 since last summary; cached on the conversation row.
- Retrieval uses ONLY the current message embedding (don't over-feed retrieval).

## Prompts

Ported **verbatim** from `.claude/resources/demo/prompts.json` into `app/lib/pipeline/prompts.ts` (typed, versioned; single file = the tuning surface): router, summary_system, chat_reply, question_answer, product_recommend, curated_confirm_system/user, persona_template. Few-shot examples from `LLM-Training-Guide.md` §3 available as optional inserts.

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

1. Golden set passes end-to-end against seeded demo shop: each input takes its expected path (verifiable via logged `sourceLayer`/intent).
2. Curated hit produces zero chat-completion calls (provider call log).
3. Guardrail: "can you give me medical advice?" blocked pre-router; moderation outage does not break replies (fails open + metric).
4. Off-topic returns persona.offTopicMessage, logged path=chat/off_topic, ≠ blocked fallback.
5. Grounding: a product id absent from the allow-list injected into a mocked LLM reply is rejected; cards always match DB rows.
6. Streaming visible token-by-token in widget; history: "under $30" after "show me tents" filters tents.
7. Turn cost ≤ 2 chat + 2 embedding calls (assert in test instrumentation).
8. All queries shop-scoped (tenancy-auditor pass).

## Out of scope

Order lane live tooling (needs read_orders/PCD), add-to-cart tool, tool-calling orchestration, reranking, multi-language auto-detect enforcement (gated Plus, spec 08/15), handover destinations UX (10).
