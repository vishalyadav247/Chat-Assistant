-- Generalise the bonus ledger from conversations-only to any quota dimension.
--
-- HAND-WRITTEN on purpose. Prisma models a rename as DROP + CREATE, which would
-- have destroyed every grant on the table — and this ledger exists precisely so
-- a grant can be audited after the fact. Renaming in place keeps the history.
ALTER TABLE "conversation_credits" RENAME TO "quota_grants";
ALTER TABLE "quota_grants" RENAME CONSTRAINT "conversation_credits_pkey" TO "quota_grants_pkey";

-- Existing rows are all conversation grants, which is exactly the default.
ALTER TABLE "quota_grants" ADD COLUMN "dimension" TEXT NOT NULL DEFAULT 'conversations';

DROP INDEX "conversation_credits_shopId_expiresAt_idx";
CREATE INDEX "quota_grants_shopId_dimension_expiresAt_idx"
  ON "quota_grants"("shopId", "dimension", "expiresAt");
