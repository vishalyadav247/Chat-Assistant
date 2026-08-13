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
- **Auto-detect shopper's language** toggle → persona.autoDetectLanguage — **Plus gate** (locked + upgrade below Plus).
- **Banned topics & phrases** textarea one-per-line → guardrails.bannedTopics (re-embed banned vectors on save, 03 layer c).
- **Fallback message** textarea, blank → built-in default; hint: "assistant captures the shopper's email as a lead after showing this" (fallback turns trigger email-capture prompt in widget → Contact lead).
- Cancel/Save (contextual save bar).

## Tab: Product recommendations

- **Rules card**: toggle "Never recommend out-of-stock" (default ON; **revised 2026-08-10, user decision**: the toggle now controls OOS exclusion itself — OFF lets unavailable products appear in recommendation cards. Stored in `shopSettings.recommendationRules.excludeOutOfStock`; enforced in hybrid search, browse fallback, custom-rec pool, and all card assembly. "Purchasable" = `stock > 0` OR any variant availableForSale, covering untracked inventory and "continue selling when out of stock". The originally-specced *substitution suggestion* behavior is still unbuilt), toggle "Push overstock" (uses live inventory; optional `overstock` product tag boost).
- **App recommendations** (pre-configured intents; model `Recommendation`: shopId, title, triggerQuestions[], productIds[], status, lastModified):
  - Table Title | Products | Last modified | Status switch | edit/delete. Seeds on install: **Best sellers** ("What are your best sellers?", "Show me your top products"), **New arrivals** ("Any new items?", "What's new?").
  - Detail view (#viewRec): title, trigger-question chips (add/remove), status, Add products → **Browse products modal** (search, filter chips Vendors/Tag/Collections, checkbox rows w/ stock strings "297 in stock for 3 variants"/"Inventory not tracked", live "N selected" footer), product rows w/ view+remove. Cancel/Save.
  - Runtime: trigger questions embedded on save; matched in pipeline **curated-style** (these are effectively system curated answers ranked below merchant curated answers, spec 03/09 share the matcher).
- **Custom recommendations** (model `CustomRecommendation`: shopId, name, searchTerms[], productIds[], collectionIds[], status):
  - Detail view (#viewCustomRec): search-term rows (add/delete, min 1) + View-examples panel (occasion best practices, clickable example terms wedding gift/mother's day/graduation/valentine/christmas); Products conditions: Add by Product (browse modal) + Add by Collection (**Browse collections modal**, name + "N products"), expandable "N selected" lists; products preview table. Cancel/Save.
  - Runtime: when router keywords/message match a search term (embedding or keyword), constrain/boost the buy-lane candidate pool to the configured products/collections.
- **Cross-sell pairs** card: `+ Add pair` (product A → companions list). Empty: "No pairs yet…". Runtime: after recommending A, append companion suggestion. (Design has no editor — minimal pair picker via browse modal.)

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
- Auto-detect language enforced by plan server-side.
- Seeded defaults on install: persona template + guardrails defaults from `data-sources/*.json` shapes, Best sellers/New arrivals recommendations.

## Acceptance criteria

1. General tab round-trips; saving banned topics changes pipeline blocking within one config-cache TTL; fallback message override honored.
2. Auto-detect toggle locked below Plus (server rejects too).
3. App recommendation with trigger "what are your best sellers" answers deterministically with its products (and loses to a merchant curated answer on the same question).
4. Custom recommendation search term "wedding gift" constrains buy-lane candidates to configured collection.
5. OOS toggle: substitution copy appears when a matched product is OOS; overstock toggle boosts tagged items.
6. Handover config: each destination + nested option persists; runtime behavior verified in 10's tests.
7. Test AI: replies match storefront pipeline for same inputs; Review source shows retrieval + scores; no usage-meter tick.

## Out of scope / gaps

Cross-sell pair editor beyond minimal picker; "AI settings"/"Automation settings"/translation screens; sentiment model sophistication (v1 = heuristics listed); multi-language reply enforcement (needs 15 gates + i18n pass).
