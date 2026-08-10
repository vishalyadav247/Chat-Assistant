# 09 — Curated Answers

> Merchant-authored deterministic replies with hand-picked products — the "can't hallucinate" layer.
> Sources: design `curated-answers.html` + NOTES.md; `PRODUCTION-BUILD-SPEC.md` §5, §7 step 3; `data-sources/curated_answers.json` (shape + seeds); demo matcher (thresholds 0.80/0.65).

## Purpose

Admin page `/app/curated-answers` to CRUD curated answers; runtime layer in the pipeline (03 step 3) that matches by meaning and replies instantly with zero LLM generation.

## Data model

`CuratedAnswer` (01): question, synonyms[], productIds[] (Shopify product ids), talkingPoints (one per line), status draft/published, priority Low/Normal/High, servedCount, embedding (question + synonyms joined, embedded on save).

## UI (per design)

- **KPI row**: Published ("N of M total"), Served this month (servedCount sum from analytics), Needs attention ("dead-stock picks" — curated answers referencing OOS/deleted products), Answer match rate (% of shopper questions matched by curated layer, from analytics).
- Usage bar "N of M used" (plan cap 5/20/50/100).
- **List view**: buttons Revalidate stock + Add new; search by question; table Question | Status | Priority | Products (count/thumbnails) | Stock (In stock / issues pill); row Edit/Delete; empty state "No answers match your search."; pagination 10/page.
- **Add/Edit** (design shows segmented add view + modal — implement as modal or dedicated view, one pattern for both): Shopper question; "Also matches (synonyms/phrasings)" inline chip add (placeholder "e.g. gift idea, present for someone"); Talking points textarea one-per-line; Status Draft/Published; Priority Normal/High/Low; Hand-picked products → Browse catalog (reuse 08's browse-products modal); Save/Cancel/Delete (edit only). Suggestions sidebar: top unmatched shopper questions (from unresolved queue, 07) as one-click prefills.

## Runtime rules (shared matcher with 03)

- Only `status=published` participate.
- Match: cosine ≥ curatedMatchThreshold (0.80) → serve directly; [0.65, 0.80) → LLM yes/no confirm.
- Priority breaks ties (High > Normal > Low) when multiple exceed threshold.
- Reply = talkingPoints text + product cards **built from DB product rows** (price/image live from mirror); OOS products dropped from cards at serve time (never shown out of stock).
- Merchant curated answers outrank app recommendations (08) on the same question.
- Serve → servedCount++ + analytics_event(type=curated_served).

## Stock revalidation

- "Revalidate stock" button + daily job: check each published answer's productIds against product mirror; flag answers with OOS/missing products → "Needs attention" KPI + row pill; widget still serves the answer minus dead products (if all dead → treated as no-match).

## Plan gating

Caps: Free 5 / Basic 20 / Pro 50 / Plus 100. Server enforces on create/publish; usage bar reads matrix (15).

## Dependencies

01 (model), 02 (product mirror), 03 (matcher integration), 08 (browse modal reuse), 15 (caps). Onboarding step "Publish your first five curated answers" (13) reads published count.

## Acceptance criteria

1. CRUD round-trips; synonyms chips; draft vs published behavior in pipeline verified ("what are your best sellers" seed serves without LLM).
2. Borderline phrasing (paraphrase scoring 0.65–0.80) triggers confirm path (observable in sourceLayer log).
3. Cap enforced at plan limit with clear error + upgrade nudge.
4. Revalidation flags an answer after its product is zero-stocked; card omitted at serve time.
5. Served counter + match-rate KPI update from real traffic; suggestions sidebar shows unresolved questions.
6. Priority ordering respected when two answers match.

## Out of scope

Auto-generation of curated answers from top questions (suggestions prefill only); per-language variants.
