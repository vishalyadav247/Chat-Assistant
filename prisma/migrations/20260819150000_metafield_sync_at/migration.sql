-- "Last synced" for the metafield definitions catalog (spec 07 Manage metafields, 2026-08-19).
ALTER TABLE "sync_states" ADD COLUMN "metafieldSyncAt" TIMESTAMP(3);
