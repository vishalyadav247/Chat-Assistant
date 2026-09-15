# 26 — AI setup: instructions written from the store

Status: **built** (branch `feature/description-passages`, uncommitted).
Owner decision 2026-09-15: **apply automatically** + **FAQ drafts**. This reverses spec 24's rule
"store info stays empty — the merchant adds it".

## Why

Most merchants never open Instructions → General. Their chat then runs on generic defaults:
- a role saying "shopping assistant for this store";
- empty store info;
- no connected policies.

Concrete failures from those defaults:
- "what do you sell?" was answered "apparel, wallets, belts" on a crystal-bracelet store;
- COD and return questions went unanswered.

Hand-written instructions built from the store's own data fixed these on production Ankastra.
This feature does the same for every store, once, right after install.

## Flow

1. **Install** (`onShopAuthenticated`), for a new store (`!before || !persona`): `requestAiSetup` sets
   `settings.aiSetup.status = pending` and enqueues `ai-setup`. Existing stores are not rewritten on a
   token refresh.
2. **`ai-setup` job** (`aiSetupJob` → `runAiSetup`):
   - Waits for `productSyncAt`. If it is missing, the job re-queues itself with `startAfter` 180 s,
     up to 10 attempts, then sets `skipped`.
   - **Connects every Shopify legal policy that has text** as a `policy` knowledge source (idempotent).
     Before this, only a merchant who connected them by hand had policies.
   - **Collects** (no billing address, no customer data):
     - Shopify `shop`: name, description, contact email, currency, ships-to, primary domain;
     - live policies (≤ 3,000 chars each);
     - ≤ 4 store pages whose title or handle suggests store facts (about, contact, shipping, returns,
       FAQ, sizing, care…);
     - catalogue shape: product count, top collections, product types, common tags, price range,
       30 example titles, active discounts.
   - **One gpt-4.1 call** (`AI_SETUP_SYSTEM` in prompts.ts, `json_object`, temperature 0.2, purpose `setup`)
     returns: storeInfo, role, brandVoice, behaviours, scope, offTopicMessage, fallbackMessage,
     bannedTopics, language, faqDrafts, conflicts. Output is validated with zod and clamped to field
     limits; one retry.
   - **Fact guard (code):** every email, domain/link, phone number and number in store info, behaviours,
     the fallback message and FAQ answers must appear in the collected data. A sentence citing one that
     doesn't is removed; such an FAQ answer becomes empty.
   - **Ownership:** a field is written only if its current value is empty, the install default, or the
     exact text AI wrote last time (`settings.aiSetup.hashes`). A merchant's text is never overwritten.
     Banned topics must be phrases of 2+ words.
   - Persona, guardrails and settings are written in one transaction, then `invalidateShopConfig` runs
     and the store_info knowledge bridge is rebuilt.
   - **FAQ drafts** (≤ 10): status `draft`, default category, duplicates of existing questions skipped,
     stop at the plan's FAQ quota. Drafts never reach shoppers or knowledge.
   - `settings.aiSetup = { status: done, generatedAt, model, hashes, conflicts, faqDrafts, reviewedAt: "" }`.
     Events `ai_setup_completed` / `ai_setup_error` / `ai_setup_facts_removed`.
3. **Merchant**:
   - Instructions → General banner: "written from your store — review", listing the conflicts found in
     the store's own data and the FAQ draft count.
   - **Write / Rewrite from my store** button (`ai-setup-regenerate`): force run, 10-minute cooldown,
     only AI-owned fields are rewritten.
   - Saving General sets `reviewedAt`. Fields the merchant changed drop out of `hashes`.
   - Dashboard step "Review your AI instructions" (todo until reviewed); otherwise the existing
     "Add store info" step.
4. **Existing stores:** `npm run ai-setup -- --shop <domain> | --all [--force]` (inline, no worker).

## Invariants

- Every query is shop-scoped. The prompt carries only the shop's own data (AS-4i/j).
- Invalid output twice → status `error`, nothing written (AS-7).
- Never throws into install/afterAuth.
- Usage is recorded under purpose `setup`. It is not a chat conversation, so the usage meter is untouched.

## Cost

One gpt-4.1 call per store: about 8–14k input and 1.5k output tokens, roughly $0.03–0.05.
Regenerate has the same cost and a 10-minute cooldown.

## Tests

`scripts/qa/ai-setup.test.ts` (AS-1…AS-9, scripted fake model, no spend): **31/31**. It covers the fact
guard, ownership, waiting for sync, applying fields, FAQ drafts, merchant edits surviving a forced
rewrite, invalid output, the rate limit, tenancy and the install trigger.

## Not done / follow-ups

- Live run on a real store is pending the owner's go (it writes instructions): run
  `npm run ai-setup -- --shop <domain>` on one store and review the result.
- Language only supports en / hi / es / fr / de; other stores stay on their current language setting.
