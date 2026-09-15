# 04 — Knowledge Ingestion (Data Sources)

> Merchant knowledge in → chunked, embedded RAG rows out.
> Sources: `PRODUCTION-BUILD-SPEC.md` §6; `LLM-Guide.html` slide 3; design `ai-agent.html` Custom knowledge tab + modals (source types, quotas, crawl scopes).

## Purpose

Everything the AI can answer support questions from: URL sources, file uploads, and Shopify policies — ingested into `knowledge` rows (chunk ~1500 chars, ~150 overlap, embedded) linked to a `data_source`.

> **FAQ consolidation (2026-09-10, user decision):** the `manual` and `csv` source types are **retired** — FAQs (spec 07) are the one Q&A surface now (manual add + CSV import both live there, on every plan, capped by the `faqs` quota 25/50/100/250). The suggested-Q&A review queue was removed with them (the generator was never enabled). LEGACY manual/csv rows keep working: still listed, deletable, and ingested — just no new ones can be created.

## Scope

In: the three source types + FAQ-to-knowledge bridge, re-sync, quotas, background jobs.
Out: the admin UI chrome (07 renders it), FAQs CRUD itself (07), pipeline consumption (03).

## Source types (from design, with per-plan quotas — spec 15 matrix)

| Type | Behavior | Quota dimension |
|---|---|---|
| `url` | **URL source** — one web page per source (spec 22). Several can be added at once (one per line); each is its own row in Manage sources. Optional weekly re-crawl; status Active/Inactive | `crawl_pages` = number of URL sources: 1 / 10 / 15 / 20 |
| `file` | .pdf .txt .json ≤2MB; **merchant-written title required** (2026-09-11) — shown in Manage sources and used as the chunk topic; filename kept in metadata (its extension decides parsing); each file is its own row and deletable | files: 5 on every plan |
| `policy` | **One Shopify legal policy per source** (2026-09-11): the "Connect policies" modal lists `shop.shopPolicies` only; each switch creates/deletes that policy's own source; ingest re-reads the live policy (fail-soft to its snapshot; a policy removed in Shopify yields zero chunks and is flagged on the row); weekly re-crawl on | **No limit** (2026-09-11, user decision) — Shopify has at most 8 policy types, so 10/15/20 could never be reached and Free's 5 only blocked connecting all of a store's policies. The card shows "N policies connected"; the modal shows "X of Y policies connected" against the store's own non-empty policies |
| `pages` | **LEGACY** combined "policies & pages" source — still listed ("Policies & pages (legacy)"), ingested and deletable. Its policies are pre-selected in the Connect policies modal, and the first save there recreates them as individual `policy` sources and removes the legacy row; its store pages are on the Pages tab (spec 22) | — |
| `manual` / `csv` | **LEGACY, creation retired 2026-09-10** — old rows are still listed, deletable, and re-ingested; Q&As now live in FAQs (07) | — (was manual_qas; now `faqs`) |

Published FAQs (07) are also embedded as knowledge rows (`dataSource type=faq`) so RAG can use them.

## Flows

### Ingest (any type)
1. Admin action creates `data_source` (status: pending) + enqueues `knowledge-ingest` job.
2. Job: fetch content —
   - url: HTTP GET with **SSRF guard** (deny private IP ranges/localhost/redirect re-check, https preferred, size cap, timeout), strip HTML → text; one page only since spec 22 — link-following, sitemap parsing and robots.txt handling were removed with those scopes
   - file: parse pdf (text layer), txt, json
   - manual/csv (legacy rows): text directly
3. Chunk ~1500 chars / ~150 overlap (paragraph-aware split).
4. Embed batch → insert `knowledge` rows (topic = page title/question, body = chunk) with `dataSourceId`.
5. Update source: chunkCount, lastSyncedAt, status Active; failures → status error + message.

### Re-sync (url/pages only, per design)
Delete source's knowledge rows → re-run ingest. Weekly re-crawl = pg-boss cron for sources with reCrawlWeekly.

- **`pages` re-sync re-fetches from Shopify** (2026-09-11). The source stores `policyTypes` (the selected ShopPolicyType / Page GIDs) and each page's `type`; ingest re-reads them via the Admin API before embedding, so an edited policy reaches the agent on the next re-sync or weekly run. Before this it re-embedded the connect-time snapshot, so edits never arrived.
- Rules (`mergeRefreshedPages`): a selected item Shopify still returns → current title/body; one it no longer returns → dropped (deleted or emptied); a page missing from a listing capped at 200 → snapshot kept, since absence past the cap proves nothing. Merchant's selection order preserved.
- **Fail-soft:** the re-fetch runs in strict mode; if Shopify can't be read (missing scope, outage, no token) the stored snapshot is re-embedded unchanged. A transient failure must never wipe connected knowledge. Sources without `policyTypes` (pre-connector rows) keep their snapshot.
- `policyTypes` is written in the same create as the pages — never patched in afterwards, since the ingest job is already queued and a worker that read the row first would persist its metadata over the patch.

### Delete source
Cascade-delete its knowledge rows.

### Suggested Q&A review queue — REMOVED 2026-09-10
Queue mechanics (approve/dismiss endpoints, banner) removed with the FAQ consolidation; the generator behind them was a stub that was never enabled. `listSources` still filters `status=suggested` defensively.

## Business rules

- Quotas enforced server-side at creation (UI meters read the same numbers — never hard-code Plus values, a known design bug).
- All content is shop-scoped; embeddings written via raw UPDATE.
- Chunking deterministic (same input → same chunks) for idempotent re-sync.
- Fetch requests carry an identifying User-Agent. (robots.txt was only consulted for discovered pages; with single-page URLs there are none — the merchant-entered URL was always fetched.)
- No PII expected in knowledge; retention policy does not apply (merchant content, kept until deleted / shop redact).

## Acceptance criteria

1. Each source type round-trips: create → chunks embedded → RAG (03) answers from it → delete removes retrievability.
2. URL source fetches exactly one page; adding past `crawl_pages` is refused ("2 of 20 pages used" counter accurate); SSRF probe (http://169.254.169.254, localhost) rejected.
3. Re-sync rebuilds chunks after source content change; weekly cron fires for flagged sources.
4. Quota exceeded → clear server error, meters correct per plan.
5. FAQ CSV import (spec 07) with/without header; bad rows reported, good rows imported as FAQs (bridged to knowledge on publish).
6. Policy connector lists real shop policies/pages; toggling on indexes within seconds; toggling off removes.

## Out of scope / gaps

- OCR / PDF-with-tables parsing.
- Automatic language detection of sources.
- Translation settings (referenced in design, unbuilt) — backlog.
