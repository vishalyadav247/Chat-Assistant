-- Product keyword search: weighted, richer full-text index (accuracy batch 2026-08-17).
-- Hand-written raw SQL (Prisma's differ ignores Unsupported-column changes — same
-- pattern as the init migration; later `migrate dev` diffs will keep emitting a
-- drop for this generated column + GIN index, scrub-migration.ts removes them).
--
-- Title (A) > productType / vendor / tags (B) > description (C). Descriptions are
-- indexed in full so detail-level asks match; ts_rank_cd's default weights make
-- title/type hits outrank description-only hits.

-- array_to_string() is STABLE; generated columns require IMMUTABLE expressions.
CREATE OR REPLACE FUNCTION immutable_array_to_string(text[], text)
  RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT array_to_string($1, $2) $$;

ALTER TABLE "products" DROP COLUMN "searchText";
ALTER TABLE "products" ADD COLUMN "searchText" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce("title", '')), 'A') ||
    setweight(to_tsvector('english',
      coalesce("productType", '') || ' ' || coalesce("vendor", '') || ' ' ||
      coalesce(immutable_array_to_string("tags", ' '), '')), 'B') ||
    setweight(to_tsvector('english', coalesce("description", '')), 'C')
  ) STORED;

CREATE INDEX "products_search_text_gin" ON "products" USING GIN ("searchText");
