# 23 — AI pipeline & learning hardening

**Status:** built (2026-09-14) — verification record + implementation deltas in §Implementation record at the bottom.
**Source:** tri-agent read-only review of `app/lib/pipeline/*`, `app/lib/search/*`, `app/lib/embeddings/*`, `app/lib/llm/*`, `app/lib/ingestion/*` (+ FAQ knowledge bridge). 38 verified findings, each cited file:line against the code as of commit b92e389 + working tree.
**Goal (owner's words):** "our only aim is to improve the ai agent conversation."

The review's one-line diagnosis: **the answering architecture (mechanical grounding, allow-lists, router caging) is sound; what rots silently is conversation memory and the learning supply chain.** This spec fixes that in four phases, ordered by conversation impact. Each item lists the defect, the fix, and acceptance criteria.

Conventions that bind every item (ai-pipeline skill):

- Prompts only in `app/lib/pipeline/prompts.ts`; any prompt change is a tuning event → run `npm run eval:golden` before calling the phase done, note it in PROGRESS.md.
- Thresholds live in the shop `guardrails` row, never hard-coded.
- Cost budget: normal turn ≈ 2 chat calls + 1–2 embeddings; curated/blocked/clarify paths make zero generation calls. No item may regress this except where explicitly noted.
- Every DB query shop-scoped; migrations only (never `prisma db push`).

---

## Phase 1 — Reliability of what the AI knows

The "it worked yesterday" class: silent rot that makes the agent forget or unlearn with no operator signal.

### 1.1 Rolling summary freezes after ~50 messages — HIGH

`app/lib/pipeline/history.server.ts:46-66`. `fetched` is capped at `take: ROUTER_WINDOW + 40`, so `olderCount = rows.length - ROUTER_WINDOW` saturates at 40; once `summaryMessageCount` reaches 40 the refresh condition `olderCount - summaryMessageCount >= 4` is `0 >= 4` forever. Every message that ages out of the 10-message window after ~message 50 is lost from both the verbatim window and the summary.

**Fix:** derive the older-message count from a real `db.message.count({ where: { conversationId, shopId, ... } })` (or equivalent tracked cursor) instead of the capped fetch length, and fold only the not-yet-summarized slice. Keep the fetch cap for the *verbatim* window — it is the count arithmetic that must be exact.

**Accept:** unit-style check (script or scripts/qa suite) that walks a synthetic 70-message conversation through `loadHistory` and asserts the summary refresh still fires past message 50 and the stored `summaryMessageCount` keeps advancing.

### 1.2 One transient failure permanently silences a knowledge source — HIGH

`knowledge-ingest.server.ts:116-133` (any ingest failure → `status: "error"`), `knowledge-search.server.ts:29` (retrieval requires `status: "active"`), `knowledge-jobs.server.ts:36` (weekly recrawl selects only active). One 5s fetch timeout or one failed embed call (swallowed by `syncFaqKnowledgeSafe`, `faq.server.ts:592-598`) ⇒ all chunks of the source — for the FAQ bridge, every published FAQ — stop serving forever, while admin still shows the source/FAQs as fine.

**Fix (both halves):**
(a) *Serve stale rather than nothing*: when a re-ingest fails but the source already has chunks, keep the existing chunks and mark the failure without leaving retrieval (`status: "error"` + `lastError`, but retrieval treats error-with-chunks as servable; or a distinct `stale` status included in the retrieval filter). First-ever ingest failure (no chunks yet) stays non-serving.
(b) *Retry*: the weekly recrawl sweep includes `status: "error"` (and stale) sources, with an attempt cap / backoff so a permanently-dead URL doesn't burn the job queue.

**Accept:** simulate a failing fetch on a source with existing chunks → chunks still returned by `knowledgeSearch`; source row carries the error; next recrawl sweep enqueues it again.

### 1.3 Knowledge rebuild is non-atomic and unserialized — HIGH

`knowledge-ingest.server.ts:86-102`: delete all chunks → re-create rows → embed → write vectors row by row; no transaction, no per-source lock. Consequences: (1) during every FAQ save, FAQ grounding is a blackout window (rows deleted or `embedding IS NULL`) for concurrently-chatting shoppers; (2) two overlapping runs for one source interleave into duplicated chunk sets, which crowd the `LIMIT 3` retrieval.

**Fix:** compute chunks *and their embeddings* first (no DB writes), then swap delete+insert(+vector updates) inside one transaction. Serialize per source (pg advisory lock keyed on source id, or equivalent) so overlapping runs queue instead of interleaving. Embedding-skipped mode (no key) still swaps atomically.

**Accept:** script that fires two concurrent `ingestSource` runs for one source → final chunk set has no duplicates and matches one run's output; a query issued mid-rebuild (before the transaction commits) still sees the previous complete chunk set.

### 1.4 Recommendation cache serves stale product lists until restart — HIGH

`recommendation-match.server.ts:49-54,63-69,72`. Cache key fingerprints only `id + triggerQuestions`, cached value carries `productIds`/`collectionIds`, no TTL — a merchant editing a recommendation's product set without touching triggers serves the old set until process restart. Eviction at 500 entries is `clear()` — wipes every tenant at once.

**Fix:** cache only trigger *vectors* keyed by trigger text (or fingerprint including row `updatedAt`); always return product/collection ids from the rows just fetched. Replace whole-cache `clear()` with per-entry (oldest/LRU) eviction.

**Accept:** in a script: match once → edit the rec's productIds directly in DB (triggers unchanged) → match again in the same process returns the new ids.

---

## Phase 2 — Grounding integrity

Wrong or ungrounded facts reaching (or being withheld from) the model.

### 2.1 Sub-threshold knowledge chunks bypass the meaning gate — MEDIUM

`index.server.ts:1554-1555`. When discount/collection intent co-fires, ALL top-3 hits go into "Answer using ONLY the store info below" even when below `minMeaningScore`.
**Fix:** filter `hits` to ≥ `minMeaningScore` before building context; discount/collection blocks unchanged.
**Accept:** trace shows a discount-intent turn with only sub-threshold hits gets discount facts but no knowledge chunks in the prompt.

### 2.2 Transient curated/meaning failure kills the turn — MEDIUM

`index.server.ts:371-382,421,436`. `recommendationPromise` has `.catch(() => null)`; `curatedPromise`/`meaningPromise` are awaited bare (`settle()` attaches the catch to a branch, not the awaited promise).
**Fix:** catch both, treat failure as a miss (log it), continue the turn.
**Accept:** code inspection + typecheck; failure path logs and pipeline proceeds to router/lanes.

### 2.3 Detail lane cards archived/unpublished products — MEDIUM

`detail.server.ts:73-74` filters `shownProducts` only by `learnEnabled`, not the `SHOWABLE_PRODUCT` contract (`status: "active", publishedOnline: true`, defined index.server.ts:~2232).
**Fix:** apply the same showable filter in the detail lane's by-id lookup.
**Accept:** archived product previously carded → detail question no longer re-cards it.

### 2.4 Exact-synonym curated lane requires an embedding it never uses — MEDIUM

`curated-match.server.ts:66`. `AND "embedding" IS NOT NULL` excludes a freshly-published curated answer from the synonym lane (score forced to 1 at :84) while its embed job is pending/failed.
**Fix:** let NULL-embedding rows participate in the synonym lane only (vector distance treated as worst).
**Accept:** row with NULL embedding + matching synonym → curated hit; without synonym → no vector participation.

### 2.5 Router-echoed typos bypass typo correction — MEDIUM

`product-search.server.ts:471-479` corrects only `msgTerms`; `:325` excludes router-echoed words from `messageTerms`. A router echoing "rulling" puts the typo uncorrected in the high-weight tier and correction never sees it.
**Fix:** run single-word router keywords through `correctTerms` too (corrected form used in the query; keep original as fallback term).
**Accept:** trace for a typo the router echoes shows the corrected term in the keyword lane.

### 2.6 Webhook description path leaks HTML entities and churns contentHash — MEDIUM

`catalog-sync.server.ts:330,457-459` (webhook `stripHtml` decodes no entities) vs `:212` (full sync uses decoded GraphQL `description`).
**Fix:** run webhook `body_html` through the same `htmlToText`/entity-decoding pipeline (fetchers.server.ts:261-303) so both paths emit byte-identical text.
**Accept:** product with `&amp;`/`&nbsp;` in body_html → webhook-stored description equals full-sync description; contentHash stable across the two paths.

### 2.7 Variants truncated at 10; variant titles absent from embeddings — MEDIUM

`catalog-sync.server.ts:47,64-65` (`variants(first: 10)`) vs webhook storing all; `embedding.server.ts:68-87` excludes variants entirely, so "do you have it in 8mm?" can't vector-match.
**Fix:** raise the variant fetch (50) on both sync queries; fold a compact distinct-option-values line (e.g. `Options: 6mm, 8mm, 10mm · Gold, Silver`) into `productEmbeddingText`. This is an embedding-formula change → contentHash flips → catalog re-embeds once (documented safe, embedding.server.ts:64-66). Do it in the same formula change as 3.1 so the catalog re-embeds ONCE, not twice.
**Accept:** 14-variant product stores all variants after full sync; embedding text contains the options line; `npm run eval:golden` green.

---

## Phase 3 — Conversation quality

What the shopper actually experiences.

### 3.1 SEO prose dominates the product vector; metafields can be cut — MEDIUM (high value for real stores)

`embedding.server.ts:29-31,76-86`: untrimmed description sits *before* metafields inside the 8,000-char embed cap. Long SEO prose (the owner's real store) dilutes the vector and can push curated metafield lines past the cap. The vector-reserve slots (`product-search.server.ts:134,199-218`) then force prose-driven neighbours into the model's candidates.
**Fix:** reorder `productEmbeddingText` — title · type · vendor · tags · options (2.7) · metafields · description — and cap the description's contribution (~2,000 chars) in the *embedding text only* (keyword index keeps full description; the field-aware DESC_WEIGHT already handles it there). Ship together with 2.7 as one formula change → one re-embed.
**Accept:** eval:golden green, including the two SEO-prose traps ("black bracelets" / "selenite") which must still card correctly; embedding text for a long-description product shows metafields intact ahead of the truncated prose.

### 3.2 Blocked turns promise "leave your email" with no form — MEDIUM

`index.server.ts:1902-1919` serves the fallback copy without the `fallbackLeaveMessageForm` that RAG misses get (`:1626-1643`; rationale handover.server.ts:294-309).
**Fix:** use distinct blocked copy that doesn't promise collection (inviting follow-up on a banned topic is wrong anyway): a fixed safe constant, merchant fallback NOT reused. Keep zero-generation.
**Accept:** guardrail-blocked turn shows the blocked copy, no dangling email promise, no form.

### 3.3 Discount facts never reach the buy lane — MEDIUM

`index.server.ts:1374-1385` builds discount context for the question lane only; a buy-routed "any deals on bracelets?" cards the bracelets and must stay silent about the live code (PRODUCT_RECOMMEND forbids inventing discounts).
**Fix:** when `DISCOUNT_INTENT_RE` matches a buy-routed message, append the same code-built `discountFacts` block to the buy-lane user turn (grounded, mechanical — rule 2 intact). Prompt text addition lives in prompts.ts.
**Accept:** trace of a discount-worded buy turn shows discount facts in the prompt and the reply may cite the real code; eval:golden green.

### 3.4 `PICKS: none` asks for prose about an invisible product — MEDIUM

`prompts.ts:72-73` + `index.server.ts:1284-1287`: on the none path the prompt demands "offer the closest alternative" while zero cards render and product names are forbidden — the model names an uncarded product (the exact owner-flagged failure).
**Fix:** prompt change — on the none branch instruct an honest miss + invite a re-ask ("tell the shopper nothing matches exactly and ask one short question to redirect"), and drop the unconditional "the shopper sees product cards" claim from that branch.
**Accept:** eval:golden green (esp. "a fancy diamond necklace" → clarify-style, no invented/uncarded product names).

### 3.5 Handover heuristics misfire — MEDIUM

`handover.server.ts:54-60` (caps ratio 0.8 fires on "SHOW ME RED BRACELETS", "???" pre-answer), `:63-76` (repeat trigger is exact-equality so real rephrases never count), `:105` (`detectCannotAnswer` counts `banned_router` but not `banned_keyword`/`banned_meaning`/`banned_moderation`, saved as `banned_${layer}` index.server.ts:1911).
**Fix:** (a) negative-sentiment trigger requires ≥1 prior AI turn in the conversation AND a negative lexical signal alongside the caps/punctuation heuristic; (b) count all `banned_*` layers in cannot-answer (consistent policy); (c) repeat-trigger paraphrase matching via the already-computed turn embedding vs recent shopper messages (no extra embedding calls) — mark optional if risk is high, exact-match stays the floor.
**Accept:** all-caps first message does not trigger handover; 3 consecutive keyword-guardrail blocks trigger cannot-answer like router blocks; cost budget unchanged.

### 3.6 Typo-snapping rewrites valid words into wrong products — MEDIUM

`product-search.server.ts:426-449`: ≥0.5 trigram similarity, ±2 length, no runner-up margin — "anklet" can snap to an unrelated catalog word, producing confident wrong retrieval instead of "we don't carry that".
**Fix:** floor to ~0.6 and require best-candidate margin over second-best (e.g. +0.1); skip correction when the word is a common English dictionary word (small stoplist acceptable).
**Accept:** eval:golden green; a not-stocked common word no longer snaps (trace shows term unchanged).

### 3.7 Duplicate/near-duplicate chunks crowd retrieval; url sources embed page chrome — MEDIUM

No cross-source dedup (`loadDocs`, knowledge-ingest.server.ts:173-339): FAQ bridge + crawled FAQ URL + synced page can fill all 3 retrieval slots with copies, and a stale copy can outvote the fresh answer. Plus `fetchers.server.ts:288-332`: crawled pages keep nav/footer/cookie text in every chunk and prepend the full SEO `<title>` as topic.
**Fix:** (a) retrieval-time near-dup suppression: fetch a wider LIMIT (e.g. 8), skip a hit whose cosine to an already-selected hit ≥ ~0.95, return 3; (b) `htmlToText` drops the *content* of `nav/header/footer/aside` (it already special-cases the tags); (c) trim crawled `<title>` at the first `|`/`–` separator.
**Accept:** two identically-worded chunks from different sources → only one occupies a slot; crawled page chunk text contains no nav/footer strings.

### 3.8 Borderline-curated confirm sees no context — LOW

`prompts.ts:127-129`: "and the popular ones?" is confirmed against the curated question with zero history.
**Fix:** include the previous shopper turn (one line, truncated) in `curatedConfirmUser`. Still a 3-token confirm.
**Accept:** eval:golden green ("what are your best sellers?" still curated).

### 3.9 Deterministic strings are English-only — scoped fix — MEDIUM

`index.server.ts:128-152,561,706-708`: clarify/fallback/busy/cap/picks-banner are English constants, so non-English conversations flip language on deterministic turns. Full fix for auto-detect (mirror the shopper) can't be done without per-turn generation — **stays a documented limitation**. The scoped fix: when the persona has a fixed non-English default language (auto-detect OFF), serve these strings in that language via a one-time cached LLM translation per (string, language) — cached in DB so serve-time stays zero-generation after warm-up.
**Accept:** shop with default language ≠ English → clarify/fallback strings arrive translated on the second occurrence at the latest; English shops entirely unchanged; no per-turn generation added after cache warm.

### 3.10 Non-ASCII messages lose the keyword+typo lanes — MEDIUM

`product-search.server.ts:324,451-459`: tokenizer splits on `[^a-z0-9]+` ("élégant" → "l","gant" garbage; CJK → nothing), lexicon regex and FILLER are ASCII, tsqueries use `'english'`. Curated-match already does it right (`\p{L}\p{N}`, curated-match.server.ts:34).
**Fix:** unicode-aware tokenization (`\p{L}\p{N}` with lowercase via `toLocaleLowerCase`); when the message is predominantly non-ASCII, skip the english-stemmed tsquery lane (vector lane carries the turn — honest, not garbage matches). Also align the curated synonym SQL normalization (`[^[:alnum:]]`, curated-match.server.ts:60) with the JS unicode rule (finding B5) — normalize synonyms in JS at save/compare time so both sides agree.
**Accept:** eval:golden green (English unchanged); an accented query no longer produces fragment terms in the trace.

---

## Phase 4 — Cost, budget & observability

### 4.1 `INTENT_RULE_THRESHOLD` hard-coded — MEDIUM (iron-rule violation)

`handover.server.ts:37` (0.5) is the only similarity gate outside the guardrails row.
**Fix:** move to the guardrails row (`handoverIntentThreshold`, default 0.5), read like the other four thresholds.
**Accept:** threshold read from DB row; default seeded/fallback 0.5; plan-gates/features suites green.

### 4.2 Detail-confirm runs on every post-cards turn — LOW

`index.server.ts:770-780`: once cards exist, even "thanks!" pays the 3-token confirm — post-cards turns drift to 3–4 chat calls.
**Fix:** cheap pre-filter: skip the confirm when the router already classified `chat` AND the message has no product-detail signal (no interrogative, no digits/units, short length). Conservative — when in doubt, keep the confirm.
**Accept:** trace: "thanks!" after cards makes no detail-confirm call; "does it come in 8mm?" still enters the detail lane.

### 4.3 Full-catalog DF scan on most product turns — MEDIUM

`product-search.server.ts:521-546`: per-term `count(*) FILTER` over all active products, no GIN help, on the hot path.
**Fix:** cache per-shop term document-frequencies with the same 10-minute lexicon cache lifecycle (compute the DF query once per cache fill for terms seen; or memoize per (shop, term) with the lexicon's TTL).
**Accept:** second identical query within TTL issues no DF SQL (verify via query log/trace); ranking unchanged for the golden cases.

### 4.4 Key-less ingest marks sources green with unservable chunks — MEDIUM

`knowledge-ingest.server.ts:94,105-114` vs the product path's `embedding_skipped` event (metafields.server.ts:719-726).
**Fix:** mirror the product path: log + `recordEvent("embedding_skipped", …)`; keep the chunks but do NOT report the source fully `active`-and-healthy (status `active` + a recorded skip event is acceptable; a visible flag is better).
**Accept:** ingest without key produces the event + log line.

### 4.5 NULL-embedding rows are invisible — MEDIUM

All three lanes filter `embedding IS NOT NULL` with zero telemetry (product-search.server.ts:620, knowledge-search.server.ts:28, curated-match.server.ts:66).
**Fix:** cheap per-shop NULL-embedding counts (products, chunks, curated) logged from the existing daily/retention job when > 0.
**Accept:** seeded shop with a NULL-embedding row → next job run logs the count.

### 4.6 Cap-driven prune forgets the merchant's learn-off choice — LOW

`content-sync.server.ts:180-229`: `learnEnabled` set only on create; pruned-then-recreated pages come back learn-enabled.
**Fix:** tombstone per-shop disabled GIDs (persist the set on the shop's content-sync state or source row config JSON) consulted on re-create.
**Accept:** disable page → prune → re-create → still disabled.

### 4.7 Aborted reply streams lose usage metering — LOW

`openai.server.ts:147-154`: usage chunk arrives last; consumer abandonment skips `report()`.
**Fix:** `try/finally` around iteration; on early exit report an estimate from accumulated deltas (flagged estimated).
**Accept:** simulated early-exit consumer still records a usage row.

### 4.8 Consistency small-fry — LOW

(a) `emptyReplyText` for chat/question lanes (only buy has it, index.server.ts:1348) so an ACTION-only reply never yields a silent empty turn. (b) Convert the pk-only `update`s (history.server.ts:63-66; index.server.ts:1886-1891,1944-1951,1964-1971) to shop-scoped `updateMany` for mechanical tenancy auditing.
**Accept:** typecheck/lint green; tenancy-grep for bare pk updates in these files comes back empty.

---

## Verification gates (every phase)

1. `npm run typecheck` and `npm run lint` (touched files) green.
2. Targeted suites: `scripts/qa/features.test.ts`, `plan-gates.test.ts`, detail-lane suite, `test-ingest.ts` for Phase 1/2 ingestion items.
3. `npm run eval:golden` after ANY prompt/threshold/embedding-formula change (2.7, 3.1, 3.3, 3.4, 3.6, 3.8, 3.10, 4.2) — run once per phase after the phase's changes land, from PowerShell with env loaded.
4. PROGRESS.md updated per phase with tuning-event notes.

## Explicit non-goals

- Auto-detect-language localization of deterministic strings (needs per-turn generation; stays a known limitation, see 3.9).
- Cross-source ingest-time dedup UI warnings (3.7 does retrieval-time suppression only).
- Reworking the vector-reserve mechanism itself (3.1 reduces the harm at the source).

---

## Implementation record (2026-09-14)

Every item built the same day; deltas from the written fix where the code taught better:

- **1.1** history.server.ts — true count via `db.message.count`, paid only when the 50-row fetch saturates; plus a guard the review missed: a failed summarize used to persist `""` and mark the fold done, wiping the prior summary — now nothing persists on failure.
- **1.2** knowledge-search filter is `ds.status <> 'inactive'` — so `pending` sources also keep serving their previous chunks (the old `= 'active'` blacked out every rebuild window, not just failures). Failure path keeps chunks (nothing is deleted pre-transaction), records `metadata.consecutiveFailures`, and preserves `pagesUsed` when chunks were kept (QA D9 zeroing now applies only to a chunkless first crawl). Weekly sweep retries error sources of EVERY type (so a dead FAQ bridge self-heals) up to `MAX_ERROR_RETRIES = 8`.
- **1.3** ingestSource: embed BEFORE any delete; delete+insert+vectors+status swap inside one `$transaction` (120s timeout) serialized by `pg_advisory_xact_lock(hashtext(shopId), hashtext('knowledge:'+sourceId))`. §4.4's embedding-skipped logWarn landed here too.
- **1.4** recommendation-match: cache holds vectors only (keyed rec id → vectors, fingerprint id+triggers); ids/title always from the fresh rows; per-shop stale-fingerprint cleanup + oldest-first eviction replaces the whole-cache `clear()`.
- **2.1** `groundedHits = hits.filter(score >= minMeaningScore)` builds the question-lane context.
- **2.2** meaning/curated promises get `.catch(() => null)` + logError, like recommendation.
- **2.3** detail lane `shownProducts` uses `SHOWABLE_PRODUCT` (the QA session had already extracted it to search/showable.ts).
- **2.4 + B5** curated-match synonym lane rewritten in JS: same `\p{L}\p{N}` normalization on both sides (the SQL `[[:alnum:]]` was locale-dependent), and no `embedding IS NOT NULL` requirement — a pending-embed answer still matches its synonyms. Vector lane unchanged.
- **2.5** single-word router keywords go through `correctTerms`; message-tier exclusion holds raw+corrected spellings.
- **2.6** webhook description via `htmlToText` + whitespace collapse (entities decoded, `stripHtml` deleted).
- **2.7 + 3.1** ONE embedding-formula change (tuning event): `variants(first: 50)` on both sync queries; `productEmbeddingText` = title · type · vendor · tags · `Options: <distinct variant titles>` (≤40) · metafields · description capped at 2,000 chars. `applyMetafieldSelection` and reembed-products select `variants` so every hash-computing caller agrees (a caller mismatch would flip-flop contentHash).
- **3.2** already fixed by the parallel QA session (QA-A6, `TOPIC_BLOCKED_MESSAGE`); this spec's contribution is localizing it (3.9).
- **3.3** buy lane appends the code-built `discountFacts` block when `DISCOUNT_INTENT_RE` matches (learn.discounts gated); traced.
- **3.4** PRODUCT_RECOMMEND: card claim now conditional ("After `PICKS: none` there are no cards, so do not name or describe any candidate"); none-branch asks a redirect question. (QA-A7 had already removed "closest alternative".)
- **3.5** negative sentiment needs ≥1 prior AI turn AND (negative word with caps/`???`, or a negative emoji alone); `detectCannotAnswer` counts every `banned_*` layer; repeat trigger also matches trigram ≥ 0.85 (typo-level rephrases; true paraphrases stay a documented gap — no embeddings for past messages). handover.test.ts updated to the new contract + new cases.
- **3.6** snap floor 0.6 + best-vs-runner-up margin 0.08 (no dictionary stoplist — floor+margin suffice).
- **3.7** knowledgeSearch overfetches k+5 and drops near-duplicates (token-set Jaccard ≥ 0.85 — copies are near-verbatim, so no vectors shipped to JS); `htmlToText` drops nav/footer/aside CONTENT (header kept — in articles it holds the real title); crawled `<title>` trimmed at the first `|`/`–`.
- **3.8** `curatedConfirmUser` carries the previous shopper turn (≤200 chars) from the already-in-flight history promise.
- **3.9** NEW `canned.server.ts`: STATIC translations (en/hi/es/fr/de — the fixed spec-08 language set) for clarify/fallback/busy/orderStatus/blockedTopic/cap/humanWait/picksOnly/chatClosed/offTopic + the recommendation banner. Fixed non-English default language serves its translation; auto-detect keeps English (per-turn mirroring would need generation). Better than the planned cached-LLM-translation: zero calls, zero drift. Rate-limit busy stays English (config not yet loaded there, by design).
- **3.10** messageTerms splits on `[^\p{L}\p{N}]+u`. No explicit english-lane skip needed: whole non-Latin words simply miss the English index (honest miss, vector carries) — the harm was the garbage fragments, which are gone.
- **4.1** `handoverConfigSchema.intentRuleThreshold` (default 0.5) — HandoverConfig is zod-validated JSON, so no migration; handover.server reads it with the old constant as fallback.
- **4.2** detail-confirm skipped for chat-routed messages ≤30 chars with no `?`, no digits, no shown-title word (traced as skip).
- **4.3** per-shop DF cache (`termDocumentFrequencies`) with the lexicon's 10-min TTL/eviction; only uncounted terms enter the aggregate scan.
- **4.4** in 1.3 (ingest logWarn `embedding_skipped` with source id + chunk count).
- **4.5** `reportNullEmbeddings()` in the nightly retentionPurge: grouped NULL-embedding counts for products (learn-enabled), knowledge, published curated — one `null_embeddings` warn per affected shop.
- **4.6** learn-off tombstones in `metadata.learnDisabled` on the kind's bridge source (cap 2000); consulted on re-create, cleared when a row is pruned while enabled.
- **4.7** chatStream `try/finally`: abandoned stream reports a ~4-chars-per-token estimate and aborts the upstream stream.
- **4.8** ACTION-only replies: streamAndLog now backstops EVERY lane (`emptyReplyText` fallback chain; question lane passes its merchant fallback); pk-only updates in history/index converted to shop-scoped `updateMany`.

### Verification

- typecheck 0 · eslint 0 across every touched file.
- Phase 1 acceptance script (scratchpad `phase1-check.ts`): 12/12 — summary advances past the frozen 40; dead-URL re-ingest keeps + serves chunks, flags error, counts failure; concurrent CSV ingests → 6 distinct fully-embedded chunks; rec productIds edit served immediately.
- handover suite: 202/202 (new cases: pre-answer no-fire, enthusiastic caps no-fire, `???` without negative words no-fire, typo-level repeat fires, banned_keyword/meaning count toward cannot-answer).
- features / detail-lane / test-ingest / eval:golden — see PROGRESS.md gate line for this date.
