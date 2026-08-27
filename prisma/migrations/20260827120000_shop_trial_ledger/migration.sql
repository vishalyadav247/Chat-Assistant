-- Trial entitlement ledger (spec 15 · QA D-23).
--
-- Before this, every appSubscriptionCreate asked Shopify for a fresh 7-day
-- trial, so a merchant could reinstall -- or just switch plans -- and restart
-- the trial indefinitely. Shopify's documented 180-day trial proration only
-- covers Shopify App Pricing (managed pricing); this app bills through the
-- Billing API, where tracking the entitlement is the app's responsibility.
--
-- trialStartedAt  = when this shop's trial clock first started
-- trialDeadlineAt = absolute end of the entitlement; never moves forward
ALTER TABLE "shops" ADD COLUMN "trialStartedAt" TIMESTAMP(3);
ALTER TABLE "shops" ADD COLUMN "trialDeadlineAt" TIMESTAMP(3);

-- Backfill: a shop already mid-trial has an entitlement running, and losing it
-- here would hand that shop a second trial on its next plan change. The
-- deadline is the trial end Shopify is honouring; the start is derived from the
-- 7-day allowance every paid tier ships with, which is exact for every existing
-- row (no merchant has installed yet).
UPDATE "shops"
   SET "trialDeadlineAt" = "trialEndsAt",
       "trialStartedAt"  = "trialEndsAt" - INTERVAL '7 days'
 WHERE "trialEndsAt" IS NOT NULL;
