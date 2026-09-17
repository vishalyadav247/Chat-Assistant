need some changes in multiple places , updates may be small or large all are mention below -
1- in dashboard setup checklist the review the last step , it dosnt make sense to be have so it should be like enable AI Agent in you site or storefront or anyother word you prefer and action should be a link direct to enable the extension in the customisation and also show the current status like we are showing in settings.
2- in storefront chat widget we have faqs to show and we also add settings to enable/disable them from general settings , now i want to disable the faqs if no faq found even faqs are enabled in the chatbox settings. and the another small change in the same is when we focus on faq search input, an unusuall gap in search bar border and input outline focus.
4- in chat widget i want to show the view product only button in the bottom , and add to cart button should be shown in the image bottom right and now the button label should be "Add".
4- in faqs we have an option for download a sample csv , i have checked - it shows only two columns and what about status , category and featured columns or any other if there.
5- in inbox > shopping cart section - need to show the quantity/ per product , i think you are showing variant size per item just after it like multiplication sign and current quantity but make sure if the quantity is more then 1.

6 faqs are not showing in chatwidget preview in chatbox page
7 in settings we have theme detection - and inside this you add multiple options , but i need only three auto detect as now , dawn and horizon , and make the app compatable to auto detect and app should work properly in dawn and horizon initially and the flow is when shopper add the product , chat will close as currently working and the drawer will open with the updated items ( first update the item then open the drawer ) also update the header cart bubble , in dawn every thing is working fine in both the themes only the problem in horizon is cart drawer is open first then close immediately , drawer must not be close only the concern is and removed the other options.
8 some time i didn't get the recomandation if i type products under 1000 but getting if i wrote items under 1000 , so please add the keywords like products, items or any other relevant keywords which shows the refrence to the products store dealing in. and the other thing is product under 1000 and product under 3000 show different results currently showing sometimes similiar results in both the cases
9 product recommendation should be two atleast and max should be four.
10 still not understand where you are using the discount data , i ask multiple times that how many currently offers or discounts are running on your store , i am only getting "I'm not sure about that one — leave your email and our team will get back to you."
11 also we have a issue "I'm not sure about that one — leave your email and our team will get back to you." , when the fallback message triggered nothing happening right now , but it should be like show the email popup to right the email , currently even shopper write the email in the chat nothing is happening which dosnt make sense.
---

## Status — all five shipped 2026-09-09

| # | Change | Where |
|---|---|---|
| 1 | Checklist step reworded to **"Enable the AI agent on your storefront"**; the action is now the **theme editor deep link** (was a second admin page that only offered the same link), and the row shows the live **On / Draft theme only / Off / Unknown** badge Settings shows, plus the draft-theme note | `dashboard.server.ts`, `DashboardChecklist.tsx` |
| 2a | FAQ block hidden when the shop has **no published FAQ**, whatever the Chatbox toggle says | `widget/config.server.ts` (`faqAvailable`), `widget-renderer.js` |
| 2b | FAQ search focus ring moved to the **search box** (`:focus-within`) — the gap was the global `:focus-visible` outline drawing around the bare input, inset from the box border | `chat-widget.css` |
| 3 | Product card: **Add** overlays the image bottom-right; **View product** takes the row below on its own | `widget-renderer.js`, `chat-widget.css` |
| 4 | Sample CSV now carries **all five columns** the importer accepts (`question,answer,category,status,featured`) in the same order `exportFaqCsv` writes, so an export round-trips | `FaqManager.tsx` |
| 5 | Inbox cart rows show **× N** after the variant, only when quantity > 1 | `InboxDetails.tsx`, `app.inbox.tsx` (CSS) |

### Decisions worth keeping

- **2a keys on published FAQs, not featured ones.** `featuredFaqs` is capped at 8 featured entries, but the widget's search reaches every published FAQ — gating on the featured list would have hidden a working search. A separate `faqAvailable` count answers the right question.
- **1 keeps `href` as well as `externalUrl`.** The button uses the theme editor; the internal route stays as the fallback destination the checklist contract already expects.
- **1 drops `activateAppId` once the embed is ON.** Shopify has no deactivate parameter, so re-sending activate on an already-enabled embed is a no-op dressed as an action. The link label changes to "Open Theme editor" there.
- **3 removed the "Adding…" text** from the pending state: the overlay button is ~44px wide, so it now shows the spinner alone and returns to "Add".

### Verified

`npm run typecheck`, `npm run lint`, `npm run build` clean; widget budget 26.5 KB of 30 gzip. Checklist rendered against the seeded dev shop — the new step returns `link="Open Theme editor" external=yes status=On`. `storefront.test.ts` gained two `faqAvailable` assertions (needs `npm run dev`).

**Not verified by me:** the three visual changes (2b focus ring, 3 card layout, 5 cart row) need eyes on a storefront and the inbox — same standing rule as the rest of the widget work.

---

## Status — 6 to 11, shipped 2026-09-09

| # | Change | Where |
|---|---|---|
| 6 | **Regression fix.** The FAQ gate from #2a hid FAQs in the Chatbox preview too — the preview builds its own config and never set `faqAvailable`, so `undefined` read as "no FAQs". Preview now sets it from its featured list, and the renderer treats only an explicit `false` as "hide" so a caller that forgets the flag keeps the block | `ChatboxPreview.tsx`, `widget-renderer.js` |
| 7 | Theme options cut to **auto / Dawn / Horizon**; the setting now actually **picks the cart path**; Horizon drawer no longer closes itself | `schemas.ts`, `save.server.ts`, `SettingsGeneral.tsx`, `widget/config.server.ts`, `chat-widget.js` |
| 8 | Generic product nouns ("products", "items", …) stripped from **router keywords** before search | `product-search.server.ts`, `index.server.ts` |
| 9 | Recommendations: **2–4 cards**, minimum topped up only from the same relevance tier | `index.server.ts`, `prompts.ts` |
| 10 | Discount questions now **route to the RAG lane** and match far more phrasings | `prompts.ts` (ROUTER), `index.server.ts` (`DISCOUNT_INTENT_RE`) |
| 11 | The fallback now **shows the leave-your-email form**, every time | `handover.server.ts`, `index.server.ts` |

### Why each behaved the way it did

- **7 — the Horizon drawer.** `updateCart` never opens anything. On a Horizon-shaped theme its default *"dispatches a `cart:update` event on document for those components to pick up"* (Shopify's Configure-actions reference), so the theme re-renders its cart **asynchronously, after our promise resolves**. `openCart()` in that same tick opened a drawer the pending re-render then replaced — which reads as an instant close. The fix waits for `shopify:cart:lines-update` (plus two frames, with a 400 ms escape hatch) before opening, which is also the order asked for: update the item, then open. Dawn is untouched — it takes the `/cart/add.js` + `sections` path, which is what `renderContents` and the `cart-icon-bubble` swap are built on.
- **7 — why the setting exists at all.** Detection can only probe what a theme exposes, and a Dawn fork that also ships the actions runtime looks like both. `dawn` forces the sections path, `horizon` forces the actions path, `auto` probes as before. `refresh`/`craft`/`custom` were removed because all three only ever selected the same Dawn-shaped path while implying the app knew something specific about them; a stored legacy value degrades to `auto`.
- **8 — the real asymmetry.** `FILLER` already dropped "products" from the shopper-word tier, but **router keywords bypass it**. So "products under 1000" arrived as `keywords: ["products"]` and was searched literally — matching only items whose prose happens to contain the word — while "items under 1000" produced no keywords and fell through to the browse/price path that actually answers it. Same question, two answers, decided by a word carrying no information. Stripping can empty the keyword list, which is correct: that IS a browse-by-price, and the ceiling then does the discriminating — which is also why "under 1000" and "under 3000" were returning near-identical sets.
- **9 — the minimum is best-effort, deliberately.** It tops up only from the tier the mechanical fallback would have shown, never by reaching down the list. A shop with one selenite bracelet must still answer "do you have selenite bracelets" with that one product; a second, unrelated bracelet added to make up the number is a *wrong* answer rather than a thin one. Evidence: the golden set still returns exactly 1 card for all five precision cases.
- **11 — why not the existing escalation.** The form already existed, but only after `cannotAnswer.threshold` **consecutive** dead ends (3 by default), so the first two shoppers were invited to leave an email the widget never offered. The new path emits the form only — not `executeHandover`, which marks the conversation handed over, can silence the AI and notifies the team; doing that on every unanswered question would page a merchant for a typo. Submitting still goes through `/handover-form`, which is the point the shopper has actually asked for a person.

### Verified

**GOLDEN SET PASS (19/19)** — required, since ROUTER and PRODUCT_RECOMMEND both changed. `handover.test.ts` 197/197. typecheck, lint, build clean; widget 27.4 KB of 30.

Pre-existing and unrelated: `features.test.ts` has 3 curated-embedding failures (a verbatim question scores 0.262, i.e. pseudo-embeddings from a seed run without `OPENAI_API_KEY`) — fix with `scripts/qa/reembed-curated.ts`.

**Needs your eyes / a real store:** #7 on Horizon and Dawn (I cannot drive either theme), and #10 against production data — the mechanism is proven on the dev copy of jgw-check, where 6 discounts pass the exact filter the pipeline uses, but the live shop is a different database.
