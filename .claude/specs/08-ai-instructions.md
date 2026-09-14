# 08 — AI Agent: Instructions, Recommendations, Handover Config & Test AI

> How the AI behaves: persona/instructions, recommendation rules, handover configuration, and the merchant test console.
> Sources: design `ai-agent.html` (#viewInstructions, #viewTest, #viewRec, #viewCustomRec + browse modals) + NOTES.md; persona/guardrails shape from `data-sources/persona.json`, `guardrails.json`; pipeline contract from spec 03.

## Purpose

Admin views under `/app/ai-agent/instructions` (tabs: General Instructions / Product recommendations / Human handover) + `/app/ai-agent/test`, writing to `Persona`, `Guardrails`, recommendation tables, and `HandoverConfig` — all consumed live by the pipeline (03).

## Tab: General Instructions → `Persona` + `Guardrails`

- **Role** textarea (max 250 + counter) → persona.role.
- **Communication style** presets Friendly/Professional/Empathetic/Custom + editable tone textarea → persona.communicationStyle + brandVoice.
- **Behaviours** textarea (max 1000 + counter; seeded with ROLE/KNOWLEDGE/COMMUNICATION STYLE/GUIDELINES/AVOID template) → persona.behaviours.
- **Default language** select (English/Hindi/Spanish/French/German) → persona.defaultLanguage.
- **Auto-detect shopper's language** toggle → persona.autoDetectLanguage — available on every plan (`multi_language` gate removed 2026-09-03, user decision).
- **Banned topics & phrases** textarea one-per-line → guardrails.bannedTopics (re-embed banned vectors on save, 03 layer c).
- **Fallback message** textarea, blank → built-in default; hint: "assistant captures the shopper's email as a lead after showing this" (fallback turns trigger email-capture prompt in widget → Contact lead).
- Cancel/Save (contextual save bar).

## Tab: Product recommendations

- **Rules card**: toggle "Never recommend out-of-stock" (default ON; **revised 2026-08-10, user decision**: the toggle now controls OOS exclusion itself — OFF lets unavailable products appear in recommendation cards. Stored in `shopSettings.recommendationRules.excludeOutOfStock`; enforced in hybrid search, browse fallback, custom-rec pool, and all card assembly. "Purchasable" = `stock > 0` OR any variant availableForSale, covering untracked inventory and "continue selling when out of stock". The originally-specced *substitution suggestion* behavior is still unbuilt). "Push overstock" is not built and not shown.
- **App recommendations** (ONE merged section since 2026-09-10, Option B user decision — the former Custom recommendations section folded in; model `Recommendation`: shopId, title, triggerQuestions[], productIds[], **collectionIds[]**, status, lastModified):
  - Table Title (+ "Triggers on: …" subtitle) | Products ("N + M collections") | Last modified | Status switch | edit/delete. Seeds on install: **Best sellers**, **New arrivals**. Available on **every plan** (the `custom_recommendations` gate was removed 2026-09-10; stored plan overrides naming it are tolerated); the rule COUNT is tiered via the `recommendation_rules` quota (**5/10/25/50**, operator-editable at /admin/plans, enforced on create only — "N of Q rules used" counter, Add disabled at cap).
  - Detail view (#viewRec): title, trigger-phrase chips, status, Add products (**Browse products modal**) OR Add collections (**Browse collections modal**) — **either/or, never both** (user decision 2026-09-10; the other picker locks once one side has entries, save validates, runtime stays tolerant of legacy mixed rows); requires ≥ 1 product or collection.
  - Runtime — each trigger phrase fires TWO ways:
    1. **Whole message ≈ phrase** (semantic, curated threshold; trigger vectors embedded lazily per row): instant deterministic answer, ranked below merchant curated answers — zero generation calls.
    2. **Phrase contained in a shopping message** ("wedding gift" inside "I need a wedding gift"): the buy-lane candidate pool is constrained to this rule's products/collections (stock/price still enforced; the LLM still writes the reply).
    Both resolve products + collection members through `recommendationRulePool` with a **tiered shuffle** (explicit picks first, then collection members, each shuffled) so a repeated trigger shows different picks (user requirement).
- **Cross-sell pairs** card: `+ Add pair` (product A → companions list) — **every plan, no limit** (2026-09-11, user decision — the `cross_sell_pairs` quota was retired: a pair costs nothing per chat turn and is already bounded by one pair per product, ≤20 companions). The card shows "N pairs added"; `+ Add pair` is a primary button. **Picker flow (2026-09-11):** step 1 "Choose a product to pair" is a single-pick (radio; a new pick replaces the old; footer "Selected: X"; **Next** disabled until picked); step 2 "Choose companions for X" counts "N of 20 companions selected", greys out the anchor itself, has **Back** and **Save pair**. Choosing an anchor that already has a pair opens step 2 as "Edit companions for X" with its companions ticked — saves upsert on (shop, product), so starting empty used to replace them silently. Each pair row has an Edit button that opens step 2 directly. Runtime: after recommending A, append companions — gated by the merchant's **"Cross-sell companion products" toggle** (Rules card, `recommendationRules.crossSellEnabled`, default ON).

## Tab: Human handover → `HandoverConfig.config`

```
triggers: {
  explicitAsk: always on (detects "talk to human", "speak to agent", "real person"),
  cannotAnswer: {enabled, threshold: 2 consecutive low-confidence/fallback turns},
  repeatedQuestion: {enabled, threshold: same question 2+ times},
  negativeSentiment: {enabled, signals: wording/ALL CAPS/repeated punctuation/negative emojis/2+ thumbs-down}
},
intentRules: [{topic ≤150}],            // semantic match, add via inline form (submit disabled until text)
destination: inbox | collect_email | contact_methods,   // mutually exclusive radios
inbox: { onlineAskMessage (300), afterHandoverMessage (300),
         offlineMode: leave_message | contact_methods,
         leaveMessage: { replyTime: 24h|12h|48h|same_day, collect: {email: required, issue: required,
                         orderNumber?, phone?, photoUpload?}, formMessage (300), postSubmitMessage (300) },
         aiWhileWaiting: never | outside_hours (default) | always },
collectEmail: { replyTime, collect (same set), formMessage, postSubmitMessage },
contactMethods: { message (300, default apology copy) }
```

Runtime consumption: spec 10 (inbox ticket creation, AI dormant, widget states). Copy notes: design leaks "Chatty" — use ChatConvert. "Support email addresses: Not configured · Edit in AI settings" → v1: notification email field lives here (AI-settings screen unbuilt).

## Test AI view

- Chat console identical transport to real pipeline (same `/apps/...` handler logic invoked server-side with a `test: true` flag — no usage-meter tick, no analytics pollution, conversation flagged test).
- Reset button (new test session); suggestion chips (canned starters + FAQ dropdown chip); "Review sources" info box — each AI reply exposes a **Review source** affordance showing retrieved chunks/products + scores (sourceLayer debug from 03).
- Feedback faces (3) on replies → logged for prompt tuning (analytics_event type=test_feedback).

## Business rules

- Persona/guardrails saves re-embed affected vectors (banned topics; recommendation triggers) via job; save returns fast.
- Server-side length caps mirror UI counters (250/1000/150/300).
- Reply language enforced at generation time (`languageInstruction`, spec 03): auto-detect ON → mirror the shopper's latest message (switches mid-chat); OFF → always the default language. No plan gate (un-gated 2026-09-03).
- Seeded defaults on install: persona template + guardrails defaults from `data-sources/*.json` shapes, Best sellers/New arrivals recommendations.

## Acceptance criteria

1. General tab round-trips; saving banned topics changes pipeline blocking within one config-cache TTL; fallback message override honored.
2. Auto-detect toggle saves on every plan; the reply language follows it at generation time (first message and mid-chat switches).
3. App recommendation with trigger "what are your best sellers" answers deterministically with its products (and loses to a merchant curated answer on the same question); repeat triggers rotate the picks.
4. The SAME rule's trigger phrase contained in a shopping message ("wedding gift") constrains buy-lane candidates to its configured products/collections.
5. OOS toggle: substitution copy appears when a matched product is OOS; overstock toggle boosts tagged items.
6. Handover config: each destination + nested option persists; runtime behavior verified in 10's tests.
7. Test AI: replies match storefront pipeline for same inputs; Review source shows retrieval + scores; no usage-meter tick.

## Out of scope / gaps

Cross-sell pair editor beyond minimal picker; "AI settings"/"Automation settings"/translation screens; sentiment model sophistication (v1 = heuristics listed). ~~Multi-language reply enforcement~~ — built 2026-09-03 (`languageInstruction` in prompts.ts, every plan; see spec 03 and the PROGRESS decisions log). Still out: translated canned strings (fallback/clarify/busy) and cross-language RAG retrieval.
