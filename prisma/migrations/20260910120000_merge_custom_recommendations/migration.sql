-- Merge CustomRecommendation into Recommendation (Option B, 2026-09-10).
-- One rule now carries products AND collections; its trigger phrases fire both
-- semantically (instant answer) and as contained keywords (buy-lane pool).
-- Hand-authored: `migrate dev` is interactive-only and would also not order
-- the data copy before the drop.

-- AlterTable
ALTER TABLE "recommendations" ADD COLUMN "collectionIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Data copy: every custom rule becomes a recommendation rule verbatim
-- (name -> title, searchTerms -> triggerQuestions), keeping id and status.
INSERT INTO "recommendations" ("id", "shopId", "title", "triggerQuestions", "productIds", "collectionIds", "status", "updatedAt")
SELECT "id", "shopId", "name", "searchTerms", "productIds", "collectionIds", "status", "updatedAt"
FROM "custom_recommendations";

-- DropTable
DROP TABLE "custom_recommendations";
