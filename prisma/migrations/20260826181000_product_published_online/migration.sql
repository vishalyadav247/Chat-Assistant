-- Product.publishedOnline — is this product on the Online Store sales channel?
--
-- Shopify's `status: ACTIVE` does NOT mean published: on a real store 99 of 175
-- ACTIVE products were unpublished, and the AI recommended them, giving the
-- shopper a product card whose link 404s.
--
-- DEFAULT true on purpose. Existing rows have never been told either way, and a
-- default of false would remove every merchant's whole catalogue from
-- recommendations the moment this deploys, until their next sync. The sync and
-- the product webhooks both set it explicitly from then on.
ALTER TABLE "products" ADD COLUMN "publishedOnline" BOOLEAN NOT NULL DEFAULT true;

-- Recommendation candidate queries filter on (shopId, learnEnabled, status) and
-- now also publishedOnline; keep them index-served.
CREATE INDEX IF NOT EXISTS "products_shopId_publishedOnline_idx"
  ON "products" ("shopId", "publishedOnline");
