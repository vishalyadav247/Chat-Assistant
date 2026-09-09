need some changes in multiple places , updates may be small or large all are mention below -
1- in dashboard setup checklist the review the last step , it dosnt make sense to be have so it should be like enable AI Agent in you site or storefront or anyother word you prefer and action should be a link direct to enable the extension in the customisation and also show the current status like we are showing in settings.
2- in storefront chat widget we have faqs to show and we also add settings to enable/disable them from general settings , now i want to disable the faqs if no faq found even faqs are enabled in the chatbox settings. and the another small change in the same is when we focus on faq search input, an unusuall gap in search bar border and input outline focus.
4- in chat widget i want to show the view product only button in the bottom , and add to cart button should be shown in the image bottom right and now the button label should be "Add".
4- in faqs we have an option for download a sample csv , i have checked - it shows only two columns and what about status , category and featured columns or any other if there.
5- in inbox > shopping cart section - need to show the quantity/ per product , i think you are showing variant size per item just after it like multiplication sign and current quantity but make sure if the quantity is more then 1.
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
