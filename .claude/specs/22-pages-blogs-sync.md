# 22 — Pages & Blogs sync (AI agent → Training)

> Status: built (2026-09-11) — live-verified on jgw-check. User decision, replacing website crawling as
> the way store content reaches the agent. Depends on 02 (catalog sync), 04
> (knowledge ingestion), 07 (training UI), 15 (plans).

## Why

Website crawling scraped the rendered storefront: header, nav and footer text
landed in every chunk (~1,670 chars of identical chrome per page on jgw-check),
drafts and password-protected stores were invisible, and Shopify's sitemap has no
policy type. Store pages and blog articles already exist as structured data in
the Admin API — sync them the way Products and Collections are synced.

## Scope

**In**
- Two new Training tabs, **Pages** and **Blogs**, beside Products / Collections.
- Mirror tables synced from the Admin API; per-row "AI learn" toggle, bulk
  enable/disable, master "Learn pages" / "Learn blogs" switch, Sync button,
  a sync-status line (weekly background sync) — the Collections tab pattern.
- Per-plan limits `pages_synced` and `articles_synced`, editable in
  `/admin/plans`, enforced as a sync ceiling exactly like `products_synced`
  (plan cap + live bonus grant), shown on Plan & Usage.
- Website URL source reduced to **this page only** (user decision).

**Out**
- Legal policies — stay in "Connect policies & pages" (user decision). That
  connector keeps listing store pages too; see "Overlap" below.
- Real-time sync: Shopify has **no webhook topics for pages or articles**
  (verified against the 2026-07 WebhookSubscriptionTopic enum:
  `ORDERS_UPDATED` → `PAYMENT_…`, `APP_UNINSTALLED` → `AUDIT_EVENTS_…`).

## Data model

`StorePage` (`store_pages`) — shopId, shopifyPageId (Page GID), title, handle,
bodyText (HTML stripped), isPublished, shopifyUpdatedAt,
learnEnabled, updatedAt. `@@unique([shopId, shopifyPageId])`.

`BlogArticle` (`blog_articles`) — shopId, shopifyArticleId (Article GID),
blogTitle, title, handle, bodyText, summary, tags, author,
isPublished, shopifyUpdatedAt, learnEnabled, updatedAt.
`@@unique([shopId, shopifyArticleId])`.

`SyncState` gains `pageSyncAt`, `articleSyncAt`.

**learnEnabled default = isPublished at first sync.** A draft is listed but off,
so the agent never quotes unreleased content; a merchant may switch a draft on
deliberately (e.g. internal notes meant only for the bot). Later syncs never
overwrite the merchant's per-row choice.

## Sync

Admin GraphQL (validated 2026-07, scope `read_content` — Page/Blog/Article accept read_content OR read_online_store_pages; the second was dropped as redundant 2026-09-14, QA-P2,
both already granted):

- `pages(first: 100, after, sortKey: UPDATED_AT, reverse: true)`
- `articles(first: 100, after, sortKey: UPDATED_AT, reverse: true)` with
  `blog { title handle }`, `author { name }`, `summary`, `tags`

Newest-updated first, so when a store exceeds its limit the cap keeps the
freshest content. Cap = `getQuota(plan, dim) + bonusQuota(shopId, dim)`. A run
**always prunes the rows it did not see** — deliberately unlike products. Because
the listing is newest-updated first, the rows a capped run sees are exactly the N
freshest, so an unseen row is either deleted in Shopify or outside the limit, and
both should go. This is what makes the limit hold after a plan downgrade (the
products rule, stop-and-keep, would leave a Plus shop's 100 pages feeding the agent
on Free). A GraphQL error throws before pruning, so a failed page never reads as
"the end of the list".

Triggers: Sync button (enqueued job), the **weekly** background sync (Mondays
03:17 UTC, every plan, no toggle — revised 2026-09-11, see spec 02 "Scheduled
sync"), install / reinstall.

## How the agent uses it

Pages and articles are prose, so they go to the **RAG knowledge base** (question
lane), not product search. Same bridge as FAQs: one system `DataSource` per kind
(`type: "store_pages"` / `"blog_articles"`) whose docs are built from rows that
are `learnEnabled` **and** whose master switch (`learn.pages` / `learn.blogs`) is
on. Master off ⇒ the bridge is emptied, so the agent has none of it.

The bridge is rebuilt after a sync that changed content, a per-row or bulk
toggle, and a master-switch change. Bridge sources are hidden from the Custom
knowledge list — they are managed on their own tabs.

## Website URL (changed)

Only "This page only" remains, so a URL source has no scope field at all
(the `crawlScope` column was dropped). `crawl_pages` becomes the number
of URL sources a shop may add (each is one page) — it was a per-crawl page cap,
which is meaningless once a crawl is one page. Existing sources over the new
limit are kept; only new adds are refused. Sitemap/link discovery code is removed.

## Known limitation — theme-section pages

The Admin API exposes only a page's own `body` field. Pages built from theme
sections (Online Store 2.0 templates) have an empty body, so they sync with no
text; the table says so per row rather than implying the AI knows them. Measured
on jgw-check: 29 pages synced, several empty; "sujeet" is 0 chars via the Admin API
where the crawler had indexed 1,674 chars — all of it theme header/footer.

## Overlap with "Connect policies & pages"

The connector still lists store pages. A page both connected and synced on the
Pages tab would be indexed twice. Out of scope for this spec; noted in PROGRESS
as a follow-up.

## Acceptance criteria

1. Pages and Blogs tabs render beside Collections with learn card + master
   switch, Sync button, sync-status line, search, Learning on/off sub-tabs,
   bulk enable/disable, per-row switch.
2. Sync writes rows with HTML stripped; drafts arrive with learnEnabled = false.
3. `pages_synced` / `articles_synced` appear in `/admin/plans`, Plan & Usage and
   the bonus-grant picker; a sync stops at plan cap + bonus.
4. A sync prunes every row it did not see (deleted, or beyond the limit); a
   GraphQL error aborts before any prune.
5. The bridge contains exactly the learnEnabled rows while the master is on,
   nothing while it is off; question-lane RAG retrieves them.
6. The weekly background sync enqueues page and article sync for every installed shop.
7. Shop redact / uninstall purge deletes both tables.
8. Website URL form has no scope picker; ingest fetches one page; adding a URL
   past `crawl_pages` is refused.
9. Every query shop-scoped; typecheck / lint / build clean; QA cases added.
