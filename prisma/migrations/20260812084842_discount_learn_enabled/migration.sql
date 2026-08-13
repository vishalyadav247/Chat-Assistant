-- Per-discount AI learning flag (spec 07 Discounts tab; user decision
-- 2026-08-12: bulk enable/disable is app-only — gates AI usage, never mutates
-- the discount in Shopify).
-- NOTE: hand-trimmed — prisma diff again emitted drops of the custom HNSW/GIN
-- indexes and an ALTER on the generated "searchText" column (known drift kept
-- out of prisma schema by design). Only the discounts change belongs here.
ALTER TABLE "discounts" ADD COLUMN     "learnEnabled" BOOLEAN NOT NULL DEFAULT true;
