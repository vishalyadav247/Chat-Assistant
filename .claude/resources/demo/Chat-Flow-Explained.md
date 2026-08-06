# How the chat runs — every step, explained

This walks through **one shopper message from start to finish**, in plain language,
so you can see exactly how the process runs during a chat — including what happens
after the intent is identified, and how human handover works.

The golden rule throughout: **the LLM decides *what kind* of message it is and *phrases*
the reply; your code decides *what to do* and fetches the real facts. The LLM only ever
sees the data you retrieved for that one message.**

---

## The big picture (one sentence)

A message is checked for safety → maybe answered instantly from a curated answer →
otherwise the **router LLM labels the intent** → your code runs the matching **lane**
(buy / question / order / chat / human handover) → the LLM writes a grounded reply →
it streams back and the turn is logged.

---

## Step 1 — The message arrives

The storefront chat widget sends the shopper's text to your backend, along with a
`shopId` (which store) and a `sessionId` (which conversation). The widget never calls
the AI directly — everything happens on your server, so your keys and logic stay private.

## Step 2 — Housekeeping & safety (before any AI)

Your backend does a few cheap things first:

- **Identify the shop** and scope everything to it (one store can never see another's data).
- **Rate-limit / abuse check** so nobody can spam or run up cost.
- **Load the shop's config** (persona + guardrails) from cache.
- **Guardrail — cheap checks:** a keyword scan and the **free moderation model** (catches
  universal-unsafe content: sexual, hate, violence, self-harm). If either fires → return
  the fallback message and stop. No AI spend.

## Step 3 — Curated answer shortcut

Embed the message and compare it (by meaning) to the merchant's hand-picked questions.
If it's a confident match → return that pre-written answer **instantly, with no AI
generation** (deterministic, can't hallucinate). If the match is borderline, one cheap
LLM yes/no confirms it. If no match → continue.

## Step 4 — The intent is identified (the router)

One small, fast LLM call reads the message (plus the last few turns of history) and
returns a structured label:

```
{ "intent": "buy | question | chat",
  "price_max": 30, "keywords": ["gloves"],
  "blocked": false, "blocked_reason": "" }
```

- It **classifies** the message into a lane using its own understanding of language.
- It **also flags `blocked`** for the store's own banned topics (politics, competitor
  pricing, medical advice…) that the cheap checks missed. If `blocked` → fallback, stop.

**This is the fork in the road.** Everything below is "what happens next," chosen by the
`intent` label. Your code branches to the matching lane.

---

## Step 5 — What happens after the intent (the lanes)

### Lane A — BUY (the shopper wants a product)

1. **Hybrid search** for candidate products, scoped to the shop and filtered by price/stock:
   - **Keyword search** — exact words and hard filters.
   - **Vector (meaning) search** — finds items by idea, even with different words.
   - **Merge + dedupe** them into a shortlist (this is the "allow-list").
2. **Fallbacks:** if nothing matches but there's a budget, show the cheapest in-budget items
   ("browse"); if genuinely nothing fits, ask a clarifying question instead of guessing.
3. **Grounded recommendation:** hand that shortlist to the LLM with the rule "recommend ONLY
   from these; never invent a product, price, or discount." It picks 1–3 and writes a short pitch.
4. **Product cards** are built from the database rows (real price/image), not the LLM's text.

### Lane B — QUESTION (support / policy: shipping, returns, sizing…)

1. **RAG** — vector search over the merchant's knowledge base returns the few most relevant text chunks.
2. **Grounding gate:** if nothing relevant is found (and "answer only from knowledge" is on),
   return the fallback — don't guess.
3. **Grounded answer:** the LLM answers **using only those retrieved snippets**, and can cite
   the source. It cannot invent a policy.

### Lane C — LIVE DATA / ORDER (facts that change: stock, price, order status)

These are **never** answered from the vector index (it goes stale). Instead the agent calls a
**tool** that hits the live Shopify API — e.g. "get order status for #1234" — gets the real,
current data, and the LLM phrases it ("your order is out for delivery, arriving tomorrow").

### Lane D — CHAT (greeting / small talk)

No lookup. The LLM gives one short, on-persona reply. Optionally nudges toward shopping.

### Lane E — BLOCKED (banned topic)

Return the configured fallback message and stop. (Triggered by the cheap guardrail checks or
the router's `blocked` flag.)

---

## Step 6 — Human handover (when the agent shouldn't or can't handle it)

Some messages should reach a person. Handover is a **defined exit, not a dead end.**

**When it triggers:**
- The shopper **explicitly asks** for a human ("can I talk to someone?").
- The agent **repeatedly can't help** (several fallbacks in a row / low confidence).
- A **sensitive situation** — a complaint, a damaged order, a refund dispute, anything
  emotional or high-stakes.
- A **merchant rule** — e.g. "always hand over for refunds" or "hand over after 3 unanswered turns."

**What happens:**
1. The agent posts a calm handover message ("Let me connect you with our team.").
2. It **captures the shopper's email** (or contact) if not already known, so the merchant can follow up.
3. It **creates a conversation/ticket in the merchant's inbox** (and can notify them by email/Slack).
4. The **same conversation thread** is handed to a human — the merchant sees the full history and
   replies in the shopper's widget. The widget switches to "a team member will reply" mode.
5. The agent can **stay dormant** on that conversation (so it doesn't talk over the human) until closed.

This keeps the experience graceful: instead of the bot failing or looping, the shopper is smoothly
passed to a person with all the context.

---

## Step 7 — Generation & streaming (how the reply is produced)

For the lanes that generate (buy / question / order / chat), the LLM call is built from three parts:

- **System message:** the persona (voice) + the lane's rule (e.g. "recommend only from these").
- **Recent history:** the last few turns, so it stays coherent across the conversation.
- **User message:** the retrieved data (products / snippets / order) + the shopper's question.

The reply is **streamed** token-by-token to the widget, so the shopper sees it appear immediately.
Because the LLM only receives the retrieved facts, it **cannot invent** a product, price, or policy —
that's grounding, enforced by controlling what goes into the prompt.

## Step 8 — After the reply (cards, logging, learning)

- **Product cards** are assembled from database rows and sent with the reply.
- **Both messages** (shopper + assistant) are saved to the conversation — this is what makes
  history work on the next turn.
- **An analytics event** records the intent and outcome (recommended / answered / fell back /
  added to cart / handed over) — powering dashboards and the improvement loop.

## Step 9 — The next turn

Because every turn is saved under the same `sessionId`, the next message carries context. The
router and generation get the recent history, so "under $30" right after "show me tents" is
understood as "tents under $30." The conversation feels continuous.

---

## One-look summary

| After the router labels intent… | Your code runs… | The LLM's job in that lane |
|---|---|---|
| **buy** | hybrid search (keyword + vector) → shortlist | recommend only from the shortlist |
| **question** | RAG (vector search over knowledge) | answer only from retrieved snippets |
| **order / live** | tool call to Shopify API (live data) | phrase the real, current fact |
| **chat** | no lookup | one short persona reply |
| **blocked** | none | (none — return fallback) |
| **human handover** | capture contact → create ticket → notify | hand off; stay quiet until resolved |

**The pattern never changes:** decide the lane → fetch the right facts (search / RAG / tool) →
let the LLM phrase the answer *only* from those facts → stream it → log it. Human handover is the
safety valve when the agent shouldn't answer alone.

*Note: the runnable demo (`chatconvert_ui.py`) implements the buy / question / chat / blocked lanes.
The order/live-data and human-handover lanes are part of the production design (they need the live
Shopify API and a merchant inbox) — described here and in `PRODUCTION-BUILD-SPEC.md`.*
