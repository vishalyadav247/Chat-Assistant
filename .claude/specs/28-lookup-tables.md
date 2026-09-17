# 28 — Lookup tables (structured CSV knowledge)

> User request 2026-09-16: "in custom knowledge we will upload the giant data, for example the csv file for product finder (manufacturer, model, year, engine, skus and many more), so we can use the data to search the best product" — "records may be up to 2 lacs for now".

## Generic by rule (2026-09-16, owner)

The feature is for ANY tabular data, not a product finder. No domain vocabulary may appear in the agent's tool description, the store-context line, the column-role guess or the merchant UI copy: what a table is for reaches the AI only through the merchant's own title, description, column names and sample values. The role guess is judged from the data (short repeated or numeric values → Filter, long text → Show, a header containing "sku" / "handle" → Product link). The fitment examples below are test data, not product wording.

## Purpose

Let a merchant upload a large tabular CSV (vehicle fitment, size charts, spec sheets, compatibility lists, store locations — any table) that the AI queries by **exact filters**, instead of cutting it into text chunks for similarity search. Similarity search cannot tell a 2015 Civic 1.8 row from a 2014 Civic 2.0 row, sees only a handful of chunks, and cannot link a row's SKU to a product card.

## Scope

In: CSV upload as a lookup table (Custom knowledge → Upload file), column mapping, background import up to the plan's row quota (Plus 200,000), an agent tool that filters rows, product cards for rows linked by SKU / handle / title, edit mapping without re-upload, delete, tenancy + shop cleanup.
Out: XLSX, re-sync from a URL/Google Sheet, legacy pipeline mode (`AI_AGENT_MODE=pipeline` has no tools — tables are simply not used there), merchant-side row editing.

The "Reference text" CSV mode from spec 04 (`csv_upload_mb`, chunks + embeddings) stays for prose-like CSVs; the upload modal offers both.

## Data model

- `data_sources` row, **type `table`**. `chunkCount` = imported row count (so "items learned" and the dashboard step count it). Metadata:
  - `filename`, `description` (merchant: what the table is for — goes into the tool description), `delimiter`, `importedAt`, `error`
  - `columns: [{ key: "c0", name, role, numeric, distinct, samples[] }]` — `role` ∈ `filter | info | link_sku | link_handle | link_title | ignore`; `numeric` = ≥ 90 % of non-empty cells are a number or a range `a-b`; `distinct` capped count (5001 = "more than 5000"); `samples` = most frequent values (≤ 12)
  - `ranges: [{ name, from, to }]` — auto-detected header pairs ("Year From"/"Year To", "Start Year"/"End Year", "Min X"/"Max X"); queried as one numeric filter
- `lookup_rows` (id, shopId, dataSourceId, rowIndex, `values` jsonb {key: raw cell}, `norm` jsonb {key: normalised}, `nums` jsonb {key: [lo, hi]}). Indexes: btree (shopId, dataSourceId, rowIndex); GIN `norm jsonb_path_ops`.
- `lookup_files` (dataSourceId PK, shopId, gzip bytea, bytes) — the uploaded file, kept so the import job (and a later re-import) can read it; deleted with the source.

Normalise = NFKD, strip diacritics, lowercase, collapse whitespace, trim.

## Limits (plan matrix, spec 15)

- New quota `lookup_rows` = total rows across a shop's tables: **Free 1,000 · Basic 10,000 · Pro 50,000 · Plus 200,000** (operator-editable).
- A table counts as one `file_uploads` item.
- Upload: the browser gzips the file (CompressionStream; raw fallback) and posts multipart. Compressed ≤ 20 MB (nginx 25M), decompressed ≤ 100 MB, ≤ 60 columns, header row required. Checked in the action (row count vs remaining quota → clear error, nothing stored) and again in the job.

## Flows

### Upload (Custom knowledge → Upload file → a .csv)
1. Modal asks **How should the AI use this CSV?** — *Lookup table* (default) or *Reference text* (spec 04 path).
2. Lookup table: Title (required), **What is this table for?** (required, ≤ 300), column mapping table (column, sample values, *Use as* select). Roles are pre-guessed: header matching sku → Product link (SKU), handle → link (handle); short repeated values → Filter (max 8 filters); long text → Show in answers. At least one Filter is required; at most one link column.
3. Action `source-add-table` (multipart): quota/size/format checks → `lookup_files` + `data_sources(type=table, pending)` → enqueue `knowledge-ingest` (ingestSource branches to the table importer).
4. Job: gunzip → parse (delimiter auto: comma, semicolon, tab) → profile columns → delete old rows + insert 1,000 per statement in one transaction → status active, chunkCount = rows. Errors → status error + message (row limit, empty file).

### Edit
Title, description, column roles, Active/Inactive — metadata only, no re-import (norm/nums are stored for every column). Replacing the data = delete + upload.

**Download CSV** (2026-09-16, owner): left side of the Edit lookup table footer. `GET /app/lookup-download?id=` (resource route, `ai_agent` permission, shop-scoped) returns the stored file exactly as uploaded — the gzip bytes with `Content-Encoding: gzip`, so the browser inflates it and the server never decompresses a large table. Reference-text CSVs (type `file`) keep only their extracted text, so they have no download.

### Agent tool `lookup_table` (spec 24 agent)
- Offered when the shop has ≥ 1 active table (max 10 newest listed). Description lists each table: name, purpose, filter columns with sample values / numeric range, shown columns, product link.
- Input: `table` (enum of names), `filters: [{column, value}]`.
- Matching per filter column:
  - numeric column or range pair + numeric value → rows whose value/range contains it
  - text: exact normalised → punctuation-insensitive ("F-150" = "F150") → every word of the value prefixes a word of the cell ("civic" → "Civic Hatchback", "1.8" → "1.8L") → typo (edit distance ≤ 1, ≤ 2 for 8+ chars). Candidates come from the column's distinct values (≤ 5000, cached per import); larger columns match exact or prefix in SQL.
  - no candidate → reported as `unmatched` with the closest values (the model asks / corrects, never guesses).
- Output: `matched_rows` (exact up to 1000, else "more than 1000"), up to 20 rows (filter + info + link columns, `product` title when linked), `narrow_by` — for filter columns the shopper hasn't given, the distinct values among matches with counts (≤ 10 each) when matches > 1 and they differ — and a note telling the model to ask for the missing detail instead of listing everything.
- Linked products are resolved shop-scoped and SHOWABLE_PRODUCT, marked retrieved (tier best) so `show_products` can card them. Rows whose product isn't in the synced catalogue still return their text.
- Store context gains one line naming the tables so the model knows to use the tool before a catalogue search.

### Product link by SKU
Catalogue sync and product webhooks store `sku` on each variant in `products.variants` (no re-embedding: the embedding text doesn't include SKUs). Existing shops get SKUs on their next product sync.

## Business rules

- Every query shop-scoped (`shopId` on rows, files, sources). Tool input never reaches SQL as identifiers — column keys come from stored metadata (`c\d+`).
- Deleting a source deletes its rows and file; `cleanupShop` deletes both tables.
- Inactive tables are not offered to the agent.
- No PII expected (merchant reference data); same retention as other knowledge.

## Acceptance criteria

1. A 200,000-row fitment CSV imports on Plus (rows = 200,000, active); the same file on Pro is refused with the row-limit message before anything is stored.
2. Filters: exact, case-insensitive, "F150"="F-150", "civic" → "Civic Hatchback", "Hondda" → Honda, year 2015 inside a "2012-2016" cell and inside Year From/Year To columns; an unknown value is reported with closest suggestions.
3. `narrow_by` lists the unspecified filter's values with counts; ≤ 20 rows returned; count exact to 1000.
4. SKU link returns the product title and `show_products` shows its card; unlinked rows still return text.
5. Tenancy: shop B's tool call never sees shop A's rows; delete + cleanupShop leave no rows/files.
6. Editing roles changes the tool description and matching without re-import.
7. Live agent turn: "brake pads for my 2015 Honda Civic" → `lookup_table` called; with several engines it asks which engine; with the engine given it names/cards the matching product.
