-- Hand-written index (Prisma's schema language cannot express a GIN opclass) —
-- MUST be listed in scripts/scrub-migration.ts PROTECTED_INDEXES so the
-- differ's regenerated DROP is stripped from future migrations.
--
-- Contact detail resolves a contact's cart + conversion timeline by matching
-- ids INSIDE analytics_events.payload. Measured at 150k events on the QA perf
-- shop (scripts/qa/perf-queries.test.ts):
--   contact_converted by payload contactId : 2627 ms -> 1.0 ms
--   added_to_cart by 20 conversation ids   :  161 ms -> 3.7 ms
-- jsonb_path_ops keeps the index small (3.8 MB for 150k rows) and supports the
-- `payload @> '{"key":"value"}'` containment form the queries now use.
CREATE INDEX IF NOT EXISTS "analytics_events_payload_gin"
  ON "analytics_events" USING gin ("payload" jsonb_path_ops);
