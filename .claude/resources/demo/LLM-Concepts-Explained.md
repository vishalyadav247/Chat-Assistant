# LLM Concepts, Explained — the ideas you need before building

This is the "clear mindset" file. It explains the five things that make an AI
sales agent work, in plain language, with worked examples. Each concept maps to
a file you can edit and a way to test it in `chatconvert_real_openai.py`.

---

## 1. "Training" the LLM = configuring it (not rebuilding it)

You will **not** build or retrain a language model. You take a ready-made one
(OpenAI `gpt-4o-mini`) and shape its behaviour with four editable layers:

1. **Instructions** — a persona + rules you send every message → `persona.json`
2. **Knowledge** — the store's real products & policies it reads → `products.json`, `knowledge.json`
3. **Examples** — sample good conversations (few-shot) → in `LLM-Training-Guide.md`
4. **Feedback** — what you learn from chat logs and feed back

**Test it:** run the lab, type `/persona` to see the exact system prompt built
from `persona.json`. Edit `persona.json` (change the tone or rules), re-run, and
the assistant behaves differently. *That change is the "training."*

---

## 2. Keyword search — matching exact words

The classic way to find products: match the literal words, plus hard filters
(price, stock, type). In SQL it's an `ILIKE` (contains) query.

**Strength:** exact and precise for filters and specific terms (a SKU, "30-day", "waterproof").
**Weakness:** blind to meaning. "keep my hands warm" finds nothing if no product
description literally contains "warm" or "hands."

Worked example (from the lab):
```
"keep my hands warm under $30"
  keyword search -> NOTHING FOUND   (no product says "warm" or "hands")
```

---

## 3. Vector search — matching by meaning

Each product's text is turned by OpenAI into an **embedding**: a list of ~1536
numbers that captures its *meaning*. A shopper's message becomes an embedding
too. We then find the products whose numbers are closest (cosine similarity).
"warm" ends up numerically near "wool", "fleece", "insulated" — even though the
words differ.

In Postgres this is the **pgvector** extension and the `<=>` operator:
```sql
SELECT title, price FROM products
ORDER BY embedding <=> :query_embedding   -- closest in meaning first
LIMIT 5;
```

Worked example:
```
"keep my hands warm under $30"
  vector search -> Merino Wool Gloves 0.81 | Thermal Socks 0.64 | Fleece Beanie 0.59
```
Vector search rescued a query that keyword search completely missed.

**Strength:** understands intent, synonyms, vibe.
**Weakness:** fuzzy on hard constraints (it won't enforce "under $30" by itself).

---

## 4. Hybrid search — both together (the recommended default)

Run keyword search AND vector search, apply the hard filters (price, stock), and
merge the results into one shortlist. You get exact matches *and* meaning matches.
This is what Algolia, Bloomreach and Amazon Rufus do; it's the practical standard.

```
HYBRID = keyword rows  +  strong vector rows  ->  filter by price/stock  ->  shortlist
```

**Test it:** in the lab type `/compare keep my hands warm` to print keyword-only,
vector-only, and hybrid results side by side. That single command teaches the
whole idea.

---

## 5. RAG — answering questions from your own text

RAG = **R**etrieve, then let the LLM **G**enerate. For a *question* (shipping,
returns, sizing) we:
1. embed the question,
2. retrieve the closest few policy snippets from `knowledge.json` (vector search),
3. hand only those snippets to the LLM and say "answer ONLY from this."

So the model answers from *your* real policies, never from its own guesses.

Worked example:
```
"do you ship to Canada?"
  RAG retrieves -> [Shipping — international] (score 0.72)
  REPLY: "Yes, we ship worldwide including Canada, usually 7-14 business days..."
```

**Key distinction:**
- **Products** use vector/hybrid search but return **product cards** (retrieval only).
- **Questions** use RAG: retrieve text, then the LLM **writes an answer** from it.
Same retrieval idea; different output.

---

## 6. Guardrails — keeping it safe and honest

Rules that constrain the model, from `guardrails.json`:
- **Banned topics** — messages about medical/legal/etc. are declined before any
  product logic runs.
- **Answer-only-from-knowledge** — if nothing relevant is retrieved, the bot says
  "I'm not sure, leave your email" instead of guessing.
- **Grounding** — the model may only recommend products the search returned; it
  physically has no others to mention, so it can't invent items.
- **Thresholds** — `minMeaningScore` (how strong a match must count) and
  `curatedMatchThreshold` (how close to a curated question triggers it).

**Test it:** type `can you give me medical advice?` — the lab blocks it and
returns the fallback message.

---

## 7. Curated answers — hand-written, deterministic

For your top questions ("what are your best sellers?") you can pre-pick the exact
products and wording in `curated_answers.json`. These match by meaning and are
returned **with no LLM call** — instant, free, and impossible to hallucinate.
They win over the AI engine when they match.

**Test it:** type `what are your best sellers?` — the lab matches a curated
answer and skips the LLM entirely.

---

## The pipeline order (how it all fits per message)

```
shopper message
  1. guardrail banned-topic check      (guardrails.json)      -> block if hit
  2. curated answer match              (curated_answers.json) -> deterministic reply
  3. router: buy / question / chat     (gpt-4o-mini)
       buy      -> hybrid search (keyword + vector) -> grounded LLM reply
       question -> RAG over knowledge -> LLM answers only from it
       chat     -> short friendly LLM reply, no products
```

Read `LLM-Training-Guide.md` for the exact prompts and rules. Everything above is
running, for real, in `chatconvert_real_openai.py`.
