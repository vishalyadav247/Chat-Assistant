# 25 — Product description passages

Status: **built** (branch `feature/description-passages`). Used by the AI agent (spec 24) only;
the rollback pipeline (spec 03) is unchanged.

## Why

A product has one vector built from its title, tags, specs and the **first 2,000 characters** of
its description (`productEmbeddingText`). Long SEO descriptions keep real facts far past that: on
jgw-check, 19 of 167 products have 7,400–8,600-character descriptions, and the Moonstone
bracelet's "hormonal balance / menstrual cycles" text sits at ~5,500 characters — invisible to
meaning search and cut from the agent's product details (first 5,000 characters). Keyword search
covers the whole description but only exact words, at 40% weight.

## What

1. **Passages** — descriptions ≥ 1,200 characters are split into sentence-grouped passages of
   ~800 characters (no overlap), each embedded on its own text, stored in `product_passages`
   (`shopId`, `productId` → cascade, `position`, `body`, `bodyHash`, `sourceHash`, `embedding`).
   Built at catalog sync (full sync and webhooks, `upsertProducts`) and rebuilt only when the
   description's `sourceHash` changes. Shorter descriptions need none (they fit the product vector
   and the details whole). `npm run passages:backfill -- --shop <domain> | --all [--force]` builds
   them for existing stores; `--force` after switching `EMBEDDING_MODEL`.
2. **Product search** (`hybridProductSearch({ usePassages: true })`, agent only) — a passage lane:
   the best passage per product (boilerplate skipped) raises the product's meaning score, adds an
   RRF share, and becomes the candidate snippet ("matching description: …").
3. **Product details** (`get_product(product, question)`) — for products with passages, the model
   receives a short overview (opening ~500 chars) plus the **3 passages most similar to the
   shopper's question** (in description order) instead of the first 5,000 characters. No passages
   → the whole description (≤ 5,000). A different question re-calls the tool.
4. **Store-info search** (`search_store_info`) — also returns up to 2 matching product-description
   passages (`source: "product description"`), so a product question asked through that tool
   still reaches the product's own description.
4b. **Search results** (`search_products`) — when the model's search words differ from the
   shopper's message, each result carries `description_about_shoppers_question`: that product's
   passage best matching the shopper's own words (≥ 0.55, `bestPassagePerProduct`, one query, no
   extra embedding). Without it, "moonstone bracelet" searched for a hormonal-balance question
   returned the generic snippet and the model concluded "not mentioned" (0/3).
5. **Boilerplate** — a passage whose normalised text (`bodyHash`) appears in ≥ 3 of the shop's
   products is excluded from search lanes (it matches every product equally).
6. **Multi-tenant vector scans** — passage queries run with `SET LOCAL hnsw.iterative_scan =
   relaxed_order` (pgvector ≥ 0.8), so a small shop's results stay complete on a database shared
   with large ones.

Design note: passages were first embedded as "title. body" — that made every passage of a product
near-identical (0.775 / 0.770 / 0.769 for "menstrual problems", the answer ranked below a care
paragraph). Embedding the body alone separated them (menstrual → positions 7–8; cleanse →
position 11 at 0.50 vs 0.37; sizes → positions 0 and 2).

## Invariants

- Every query shop-scoped; passages join back to showable products (active, published, learn,
  stock/price filters) before they are used.
- Never fails a sync (errors logged `product_passages_sync_error`); no key → skipped with
  `embedding_skipped`.
- Purge: rows cascade with products and are also deleted explicitly in `cleanupShop`;
  `countShopRows` includes `product_passages`.

## Cost / storage (jgw-check measured)

19 products → 188 passages, avg 692 chars, **3.4 MB** incl. HNSW index; embedding ≈ $0.001
one-time. Re-sync of unchanged products: one indexed query, no embeddings (23 ms). Per product
question: ≈ same or fewer input tokens than the 5,000-char cut (overview + 3 passages ≈ 2,900
chars), +1 embedding when the model passes a question different from the shopper's words.

## Acceptance

- `deep-description-fact` conversation case: "does the moonstone bracelet help with hormonal
  balance or menstrual problems?" → answered from the description (0/3 before, 3/3 after).
- typecheck 0 · lint 0; pipeline-hardening, install-lifecycle, features green; conversation eval
  not below the spec-24 baseline (89% pipeline-tagged turns).
