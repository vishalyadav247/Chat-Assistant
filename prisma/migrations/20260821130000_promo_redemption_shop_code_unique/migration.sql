-- One promo_redemptions row per (shop, code): the row is the shop's
-- relationship with the code and follows it across plan changes, and the
-- constraint is what makes the maxRedemptions reservation atomic.

-- Collapse any pre-existing duplicates before the unique index can be built:
-- keep the most meaningful row (a redeemed one wins; otherwise the newest).
DELETE FROM "promo_redemptions" a
USING "promo_redemptions" b
WHERE a."shopId" = b."shopId"
  AND a."promoCodeId" = b."promoCodeId"
  AND a."id" <> b."id"
  AND (
    (b."status" = 'redeemed' AND a."status" <> 'redeemed')
    OR (
      (b."status" = 'redeemed') = (a."status" = 'redeemed')
      AND (b."createdAt", b."id") > (a."createdAt", a."id")
    )
  );

-- DropIndex (superseded by the unique index below)
DROP INDEX IF EXISTS "promo_redemptions_shopId_promoCodeId_idx";

-- CreateIndex
CREATE UNIQUE INDEX "promo_redemptions_shopId_promoCodeId_key" ON "promo_redemptions"("shopId", "promoCodeId");
