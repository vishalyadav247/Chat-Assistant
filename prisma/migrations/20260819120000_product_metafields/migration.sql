-- Product metafields as AI training data (spec 07 "Manage metafields", 2026-08-19).
--  * products.metafields     — every product + variant metafield as synced (JSON)
--  * products.metafieldText  — rendered text of the ENABLED metafields; part of
--                              the embedding text (contentHash) and of the
--                              weighted full-text index below (weight C, like
--                              the description).
--  * product_metafield_definitions — per-shop catalog of metafields with the
--                              merchant's enable flag.
-- The generated tsvector column is hand-written like the 2026-08-17 migration
-- (Prisma's differ ignores Unsupported columns; scrub-migration.ts protects it).

ALTER TABLE "products" ADD COLUMN "metafields" JSONB;
ALTER TABLE "products" ADD COLUMN "metafieldText" TEXT NOT NULL DEFAULT '';

CREATE TABLE "product_metafield_definitions" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "ownerType" TEXT NOT NULL DEFAULT 'product',
    "namespace" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'single_line_text_field',
    "hasDefinition" BOOLEAN NOT NULL DEFAULT false,
    "usedIn" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_metafield_definitions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "product_metafield_definitions_shopId_ownerType_namespace_key_key"
  ON "product_metafield_definitions"("shopId", "ownerType", "namespace", "key");
CREATE INDEX "product_metafield_definitions_shopId_idx" ON "product_metafield_definitions"("shopId");

-- Rebuild the weighted search vector with the enabled-metafield text at weight C.
DROP INDEX IF EXISTS "products_search_text_gin";
ALTER TABLE "products" DROP COLUMN "searchText";
ALTER TABLE "products" ADD COLUMN "searchText" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce("title", '')), 'A') ||
    setweight(to_tsvector('english',
      coalesce("productType", '') || ' ' || coalesce("vendor", '') || ' ' ||
      coalesce(immutable_array_to_string("tags", ' '), '')), 'B') ||
    setweight(to_tsvector('english',
      coalesce("description", '') || ' ' || coalesce("metafieldText", '')), 'C')
  ) STORED;

CREATE INDEX "products_search_text_gin" ON "products" USING GIN ("searchText");
