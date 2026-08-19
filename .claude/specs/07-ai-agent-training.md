# 07 — AI Agent: Home & Training Data

> The AI Agent hub: overview + the five training-data tabs.
> Sources: design `ai-agent.html` (views #viewAgent, #viewTraining + modals) + NOTES.md; backend from specs 02 (sync) and 04 (ingestion).

## Purpose

Admin section `/app/ai-agent` — a multi-view page (matching the design's SPA feel via nested routes): **Agent home** (status + setup steps) and **Training data** (Products / Collections / Discounts / FAQs / Custom knowledge). Instructions + Test AI are spec 08.

## Routes

`/app/ai-agent` (home) · `/app/ai-agent/training` (?tab=products|collections|discounts|faqs|knowledge) · detail modals in-page. Recommendation views live under spec 08's routes.

## Agent home (#viewAgent)

- Header: "AI Agent" + On/Off badge; buttons **Test AI** (→ 08 test view), **Deactivate/Activate** (master AI switch — off → pipeline replies disabled, widget falls back to contact/leave-message mode).
- Dismissible banner "Your AI agent is on…".
- **AI unresolved questions** card: count of pending unresolved questions (fell-back turns logged by 03) + "Go to review" → review queue: list of shopper questions that hit fallback, with actions: add as FAQ / add as manual Q&A / add curated answer / dismiss. (Design references this screen but never drew it — minimal list+actions UI.)
- **Setup AI agent** 3 steps with progress bars: Training data ("X items learned" — computed: learned products + knowledge chunks + FAQs), Instructions (completeness heuristic: role+style+behaviours set), Test AI (ready when 1&2 nonzero). Each → Manage/Test links.
- Promo card "Set it up for me" → mailto/support link (done-for-you service, see 15).

## Training data tabs

Common pattern: **learn card** (count chip, description, master switch = `learnEnabled` per type) + **manage card**.

### Products
- Chip "X of Y products learned"; meta "Auto sync: Daily · Last updated {ts}" (from SyncState, spec 02); buttons Sync products (enqueue catalog-sync), **Manage metafields** (built 2026-08-19, see below).
- Sub-tabs All/Active/Inactive; search; table: checkbox | Product (image+title) | Collections | Tags | Status | FAQs | actions (view, kebab). Pagination 10/page.
- **View product modal** (read-only): ID (admin deep link), title, status, URL, vendor, FAQs count, description, tags, prices table (variant|price), inventory table (variant|status e.g. "Sold out"), options table.
- Learn switch off → excluded from search (02 rule).
- **Manage metafields modal** (2026-08-19, reference `resources/other/productMetafields.png`; Order tab excluded — user decision): tabs *Product metafields* / *Product variant metafields*; "Sync now" bar (refreshes definitions + "Used in N products" counts from Shopify `metafieldDefinitions(ownerType)`); search + All/Enabled/Disabled filter; table Metafield (name · namespace.key · type) | Used in | Status (switch). Unsupported types (references, files, JSON) are HIDDEN with a footnote count (user decision 2026-08-19); footer link "View types of supported metafields" opens a second popup listing them; `color` is supported (hex → nearest colour name + hex). **Structured metafields only** (user decision 2026-08-19): metafields without a definition (app-private/legacy `namespace.key` — review widgets, SEO tags…) are neither listed nor stored; the product query selects `definition { id }` and drops null ones. Merchants promote legacy metafields by adding a definition in Shopify Settings → Custom data. **Freshness (2026-08-19, user decision: no separate auto-sync toggle):** definitions catalog refreshed by every full product sync, by the modal Sync now, and live by `metafield_definitions/create|update|delete` webhooks (`webhooks.metafield-definitions.tsx` → `metafield-definitions-sync` job; needs `read_content`); a deleted-but-enabled definition triggers a product text re-render. `SyncState.metafieldSyncAt` shows as "Last synced" in the modal, with the note "Auto sync: follows Products auto sync and Shopify webhooks"; footer link "View types of supported metafields" (text, numbers, measurements, boolean/date/URL/link, lists thereof — references/JSON/color unsupported) + Close; plan cap `metafields_enabled` (banner at cap, enforced server-side). Data flow: catalog sync + product webhooks store the DEFINED product/variant metafields on `Product.metafields` (webhook path refetches them — the payload has none); only ENABLED ones render into `Product.metafieldText` ("Name: value" lines, variant lines prefixed "Variant <title> —"), which is part of `productEmbeddingText()` (vector), of the weighted tsvector (weight C) + typo lexicon, and of the LLM candidate snippet. Toggling enqueues `metafield-apply` (re-render from stored JSON + re-embed only changed products — no Shopify call). View-product modal lists every synced metafield with an "AI" badge on enabled ones.

### Collections
Chip "X of X collections learned"; switch (off default per design); Sync collections; table: checkbox | Title | Description | Conditions (Manual/automated summary) | Products | Learn switch. **Status column removed 2026-08-12 (user decision)**: Shopify collections have no intrinsic status; publication status would need the extra `read_product_listings` scope — not worth it for a display column (the old column just mirrored the Learn flag). Sub-tabs relabeled All / Learning on / Learning off since they filter the learn flag.

### Discounts
- Upgrade banner (below Pro): "Upgrade to real-time discount sync — Pro/Plus sync discounts instantly via webhooks." + Upgrade button → plan page.
- Learn card "X discounts learned" + switch; manage card: Real-time sync mini-switch (Pro+ only, enables webhook subscription per 02), Last updated, **Manage** (opens the store's Discounts admin), **Sync now** (manual pull all plans), empty state "No items found".
- Discounts table (revised 2026-08-12 per `resources/other/discount_screen.png` + `discount_screen_2.png`; built on native `s-table`): status pills All/Active/Inactive + collapsible search (icon toggles field); columns select-checkbox | Title (+summary line) | Status | Method (Code/Automatic) | Type (icon + Amount off order/Amount off products/Free shipping/Buy X get Y) | Start date | End date | Used | AI learning (per-row switch); centered pager + one-line items-per-page (10/25/50). Backing fields `Discount.method`/`discountType`/`usedCount` come from GraphQL `__typename` + `discountClasses` + `asyncUsageCount`; the discount webhook refetches the node so these stay accurate in real time.
- Discount AI learning (**user decision 2026-08-12: app-only — never mutates the discount in Shopify**): `Discount.learnEnabled` (default true). Row selection bar bulk buttons **Enable for AI / Disable for AI** + per-row switch (`discounts-learn` with ids). Pipeline `activeDiscountContext` only voices `learnEnabled: true` discounts. (Design's "Set as active/inactive" wording was intentionally NOT used since the buttons don't change Shopify status.)
- **Master vs per-row learning (user decision 2026-08-12)**: the Learn card switch on Products/Collections/Discounts is a shop-level PERMISSION stored in `ShopSettings.learn.{products,collections,discounts}` (`learn-master` intent) — it is NOT computed from rows and per-row toggles never move it. Per-row/bulk `learnEnabled` applies only when the master is ON. Runtime: master products OFF ⇒ buy lane skips search + browse (clarify path); master discounts OFF ⇒ no discount context; collections flag stored (no runtime consumer yet). The old `*-learn-all` bulk-row intents were removed with this change.

### FAQs
- Toolbar: **More actions** (Import CSV ≤1MB w/ sample download; Export: All/Only published), **Add new** (Add FAQ / Add category), search across categories+FAQs, filter chips Status (Published/Draft/Clear) + Featured (Featured/Not featured/Clear) — functional filters.
- Category tree (featured stars are display-only since 2026-08-17, user decision — featured is changed via the edit modals' checkboxes; clicking a star opens the row's modal): category rows (drag reorder, icon — **Polaris icon names only since 2026-08-12 (user decision)**: picker offers a curated preset set, free emoji input removed, legacy emoji rows render as text; name, count, `Default` badge on Uncategorized, status pill, featured star) → FAQ rows (drag, question, status, star) → per-category "+ Add FAQ". Empty state "No FAQs match your filters."
- **Category modal**: name, icon picker (presets + upload + more), position select, status, "Feature category" checkbox (featured categories appear on widget FAQ home screen).
- **FAQ modal** (wide): question, rich-text answer (full toolbar incl. image/video), status, category select, Featured question checkbox ("show on first page of chatbox"); Delete in edit mode. *Built 2026-08-17 with the app's `RichTextEditor` (bold/italic/underline/lists/link — image/video not in v1); same editor as conversation-starter answers; sanitized server-side.*
- Published FAQs feed: widget FAQ screen (05, featured first) + knowledge embeddings (04 bridge).

### Custom knowledge
- Learn card "X items learned"; suggested-Q&A review banner ("N suggested Q&As waiting for review" → Review now, queue per 04).
- Manage table: Source (name · N chunks) | Type | Status | Last synced | actions (Edit → type-specific modal, **Re-sync (url/pages only)**, Delete). Sub-tab filters All/URL/Manual/CSV/File/Pages. Note under table: "Re-sync re-reads a source and rebuilds its chunks…".
- **Add data tiles** with live quota meters (values from plan matrix 15, never hard-coded): Website URL ("N of M pages used"), Manual Q&A ("N of M used"), Import CSV ("up to 50 rows/file"), Upload file ("N of 5 used"), wide tile Connect policies and pages ("N of M pages used").
- Modals per 04: URL (crawl-scope radios + weekly re-crawl + status), Q&A (synonym chips), CSV upload (dropzone → mapping), file upload (format/size bullets), file edit, CSV content edit, policies connector (per-page switches, live "N of M used" counter, Policy/Page badges).

## Business rules

- All counts/quota meters computed server-side from plan matrix + actual rows.
- Master AI switch + per-type learn switches are independent; pipeline honors both.
- Import/export jobs async via pg-boss with toast + refresh.
- Every mutation shop-scoped; rich text sanitized server-side (XSS).

## Acceptance criteria

1. Home step progress reflects real state; deactivate stops AI replies on storefront (widget falls back gracefully).
2. Unresolved-questions queue populates from fallback turns; "add as curated/FAQ/Q&A" prefills the target form; dismiss removes.
3. Products/Collections tabs mirror sync state; view-product modal fields correct; learn toggles affect search.
4. FAQ tree CRUD + drag order + filters + featured stars persist; import/export round-trip; published+featured FAQs appear in widget.
5. Custom-knowledge table + all five modals functional per 04; quota meters match plan.
6. Discounts gating: Free/Basic see banner + manual sync only; Pro toggles real-time.

## Out of scope / gaps

"Automation settings"/"AI settings"/"Translation settings" links (design references, unbuilt — backlog); suggested-Q&A generator quality (04).
