-- Product keyword search: treat "No - 5" and "number 5" as the same thing.
-- Hand-written raw SQL (Prisma's differ ignores Unsupported-column changes —
-- same pattern as 20260817120000 and 20260819120000; scrub-migration.ts strips
-- the drop that later `migrate dev` diffs keep emitting for this column).
--
-- WHY (measured on production, ankastra.myshopify.com, 2026-09-04). A shopper
-- asked for a bracelet for "ruling number 5". The catalogue holds nine of them
-- and names them two different ways:
--
--     The Self-Charging Abundance Bracelet for Ruling Number 1
--     Self-Charging Abundance Bracelet for Ruling No - 5
--
-- Postgres' english config drops "no" as a stop word, so the second title
-- indexed as {ruling, 5} — the word "number" the shopper typed simply is not
-- in it, and neither is the phrase "ruling number". Field-aware coverage then
-- ranked the ONE product that actually matched dead last of the nine:
--
--     Ruling Number 1   4.00   <- wrong number, matched the phrase in its title
--     Ruling Number 2   4.00   <- wrong number
--     Ruling No - 3..9  2.20   <- wrong numbers, matched "number" in their prose
--     Ruling No - 5     2.00   <- the right one, last
--
-- It never reached the 8-row allow-list, so the model was never shown it and
-- recommended something else twice in a row. Normalising the identity spelling
-- at index time puts it first (7.00 against 4.00) and, because it is then the
-- only row in its relevance tier, `constrainToTier` stops the model widening
-- back to the wrong numbers.
--
-- This changes only the KEYWORD index. Product embeddings are deliberately
-- untouched: productEmbeddingText feeds contentHash, so normalising there
-- would re-embed every product in every shop for a gain the keyword lane
-- already delivers.

-- "No. 5" / "No - 5" / "no5" / "num 5" / "nr 5" / "#5" / "№5" -> "number 5".
-- Anchored on a non-alphanumeric boundary so "piano5" and "casino 5" are left
-- alone, and requiring the digits so the ordinary English "no" is untouched.
-- Generated columns require IMMUTABLE; regexp_replace is.
CREATE OR REPLACE FUNCTION immutable_normalize_number_ids(text)
  RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT regexp_replace(
      coalesce($1, ''),
      '(^|[^[:alnum:]])(no|nos|num|nr|#|№)\.?[[:space:]]*[-–—]?[[:space:]]*([0-9]+)',
      '\1number \3',
      'gi')
  $$;

DROP INDEX IF EXISTS "products_search_text_gin";
ALTER TABLE "products" DROP COLUMN "searchText";
ALTER TABLE "products" ADD COLUMN "searchText" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', immutable_normalize_number_ids(coalesce("title", ''))), 'A') ||
    setweight(to_tsvector('english', immutable_normalize_number_ids(
      coalesce("productType", '') || ' ' || coalesce("vendor", '') || ' ' ||
      coalesce(immutable_array_to_string("tags", ' '), ''))), 'B') ||
    setweight(to_tsvector('english', immutable_normalize_number_ids(
      coalesce("description", '') || ' ' || coalesce("metafieldText", ''))), 'C')
  ) STORED;

CREATE INDEX "products_search_text_gin" ON "products" USING GIN ("searchText");
