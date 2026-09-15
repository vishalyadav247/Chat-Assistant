-- Spec 25 — product description passages. Hand-authored (the vector column and
-- HNSW index are outside what Prisma's differ can express; see
-- scripts/scrub-migration.ts for the known differ noise this avoids).
--
-- A long product description is split into ~800-char passages, each embedded,
-- so meaning search covers the WHOLE description (the product vector only holds
-- its first 2,000 chars) and product-detail answers can use the passages that
-- match the shopper's question. Rows cascade with their product.

CREATE TABLE "product_passages" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    -- Normalised-text hash: the same paragraph repeated across a shop's products
    -- is boilerplate and is down-weighted at query time.
    "bodyHash" TEXT NOT NULL,
    -- Hash of the description these passages were built from (rebuild on change).
    "sourceHash" TEXT NOT NULL,
    "embedding" vector(1536),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_passages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "product_passages_productId_fkey" FOREIGN KEY ("productId")
        REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "product_passages_shopId_productId_idx" ON "product_passages"("shopId", "productId");
CREATE INDEX "product_passages_shopId_bodyHash_idx" ON "product_passages"("shopId", "bodyHash");
CREATE INDEX "product_passages_embedding_hnsw" ON "product_passages" USING hnsw ("embedding" vector_cosine_ops);
