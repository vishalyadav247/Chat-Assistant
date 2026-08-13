-- Discount display fields for the Discounts training table (spec 07).
-- NOTE: hand-trimmed — prisma diff also emitted drops of the custom HNSW/GIN
-- indexes and an ALTER on the generated "searchText" column (schema drift by
-- design; those live in raw SQL migrations). Only the discounts change belongs
-- here.
ALTER TABLE "discounts" ADD COLUMN     "discountType" TEXT NOT NULL DEFAULT 'amount_off_order',
ADD COLUMN     "method" TEXT NOT NULL DEFAULT 'code',
ADD COLUMN     "usedCount" INTEGER NOT NULL DEFAULT 0;
