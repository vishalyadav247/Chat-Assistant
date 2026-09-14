-- QA-FIX-PLAN-2026-09-14 (QA-C3, QA-C4). Hand-authored from
-- `prisma migrate diff --from-schema-datasource --to-schema-datamodel`, keeping
-- only these statements: the rest of that diff was the known Prisma differ noise
-- that scripts/scrub-migration.ts removes (HNSW/GIN index drops, searchText default).
-- Timestamped after 20260914090000_turn_traces so it sorts last.

-- AlterTable
ALTER TABLE "data_requests" ADD COLUMN     "customerPhone" TEXT,
ADD COLUMN     "shopifyCustomerId" TEXT;

-- AlterTable
ALTER TABLE "platform_admins" ADD COLUMN     "role" TEXT NOT NULL DEFAULT 'admin';

-- Backfill: the OLDEST operator account becomes the owner (the account created
-- first is the one the company bootstrapped). Others stay "admin".
UPDATE "platform_admins" SET "role" = 'owner'
WHERE "id" = (SELECT "id" FROM "platform_admins" ORDER BY "createdAt" ASC LIMIT 1);
