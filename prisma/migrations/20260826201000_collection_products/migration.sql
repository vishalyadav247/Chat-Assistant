-- Product <-> collection membership (spec 07 / spec 08).
--
-- Collections were synced but never usable: nothing in the database could turn
-- a collection into the products inside it, so CustomRecommendation.collectionIds
-- and campaign message.collectionIds saved fine and then matched nothing.
CREATE TABLE "collection_products" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,

    CONSTRAINT "collection_products_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "collection_products_shopId_collectionId_shopifyProductId_key"
    ON "collection_products"("shopId", "collectionId", "shopifyProductId");

-- Membership of one collection (resolving a collection to its products).
CREATE INDEX "collection_products_shopId_collectionId_idx"
    ON "collection_products"("shopId", "collectionId");

-- Reverse lookup: which collections is this product in?
CREATE INDEX "collection_products_shopId_shopifyProductId_idx"
    ON "collection_products"("shopId", "shopifyProductId");
