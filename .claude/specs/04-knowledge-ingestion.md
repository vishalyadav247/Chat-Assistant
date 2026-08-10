# 04 — Knowledge Ingestion (Data Sources)

> Merchant knowledge in → chunked, embedded RAG rows out.
> Sources: `PRODUCTION-BUILD-SPEC.md` §6; `LLM-Guide.html` slide 3; design `ai-agent.html` Custom knowledge tab + modals (source types, quotas, crawl scopes).

## Purpose

Everything the AI can answer support questions from: URL crawls, manual Q&A, CSV imports, file uploads, and Shopify policy/pages — ingested into `knowledge` rows (chunk ~1500 chars, ~150 overlap, embedded) linked to a `data_source`.

## Scope

In: the five source types + FAQ-to-knowledge bridge, re-sync, quotas, suggested Q&A review queue (backend), background jobs.
Out: the admin UI chrome (07 renders it), FAQs CRUD itself (07), pipeline consumption (03).

## Source types (from design, with per-plan quotas — spec 15 matrix)

| Type | Behavior | Quota dimension |
|---|---|---|
| `url` | Crawl scope radio: **this page only** / **+ linked pages** / **entire site via sitemap.xml** — all capped at plan's page limit; optional weekly re-crawl; status Active/Inactive | crawl pages: 1 / 10 / 10 / 20 |
| `manual` | Q&A: question, "Also matches (synonyms)" chips, answer, status | manual Q&As: 10 / 20 / 20 / 50 |
| `csv` | question,answer per row; header optional → column-mapping step; ≤50 rows/file, 1MB | rows/file 50 (Plus feature per plan page) |
| `file` | .pdf .docx .txt .json ≤2MB; "images and PDFs with tables not supported" | files: 5 (Plus) |
| `pages` | Shopify policy/pages connector: list shop policies + pages via Admin API, per-page on/off switches, indexed immediately; badge Policy vs Page | policy pages: 5 / 10 / 10 / 20 |

Published FAQs (07) are also embedded as knowledge rows (`dataSource type=faq`) so RAG can use them.

## Flows

### Ingest (any type)
1. Admin action creates `data_source` (status: pending) + enqueues `knowledge-ingest` job.
2. Job: fetch content —
   - url: HTTP GET with **SSRF guard** (deny private IP ranges/localhost/redirect re-check, https preferred, size cap, timeout), strip HTML → text; linked-pages scope: same-origin links breadth-first up to cap; sitemap scope: parse sitemap.xml up to cap
   - file: parse pdf (text layer), docx, txt, json
   - manual/csv: text directly
3. Chunk ~1500 chars / ~150 overlap (paragraph-aware split).
4. Embed batch → insert `knowledge` rows (topic = page title/question, body = chunk) with `dataSourceId`.
5. Update source: chunkCount, lastSyncedAt, status Active; failures → status error + message.

### Re-sync (url/pages only, per design)
Delete source's knowledge rows → re-run ingest. Weekly re-crawl = pg-boss cron for sources with reCrawlWeekly.

### Delete source
Cascade-delete its knowledge rows.

### Suggested Q&A review queue (design: "15 suggested Q&As waiting for review")
- Background job generates Q&A candidates from store data (product descriptions, policies) via LLM; stored `status=suggested`, surfaced in admin (07) with approve→becomes manual source / dismiss.
- v1: generation job stubbed behind a flag; queue model + approve/dismiss endpoints real.

## Business rules

- Quotas enforced server-side at creation (UI meters read the same numbers — never hard-code Plus values, a known design bug).
- All content is shop-scoped; embeddings written via raw UPDATE.
- Chunking deterministic (same input → same chunks) for idempotent re-sync.
- Crawl requests carry identifying User-Agent; robots.txt respected for site crawl.
- No PII expected in knowledge; retention policy does not apply (merchant content, kept until deleted / shop redact).

## Acceptance criteria

1. Each source type round-trips: create → chunks embedded → RAG (03) answers from it → delete removes retrievability.
2. URL crawl respects scope + cap ("2 of 20 pages used" style counters accurate); SSRF probe (http://169.254.169.254, localhost) rejected.
3. Re-sync rebuilds chunks after source content change; weekly cron fires for flagged sources.
4. Quota exceeded → clear server error, meters correct per plan.
5. CSV with/without header imports via mapping step; bad rows reported, good rows ingested.
6. Policy connector lists real shop policies/pages; toggling on indexes within seconds; toggling off removes.

## Out of scope / gaps

- OCR / PDF-with-tables parsing.
- Automatic language detection of sources.
- The suggested-Q&A **generator** quality tuning (queue mechanics only in v1).
- Translation settings (referenced in design, unbuilt) — backlog.
