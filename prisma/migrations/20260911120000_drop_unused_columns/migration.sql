-- Columns that were replaced or that nothing in the app ever read.
-- Hand-authored (migrate dev prompts interactively on data loss).
--
-- Replaced:
--   data_sources.crawlScope        always 'page' since spec 22 — a URL source is one page.
--   personas.guidelines / avoid    superseded by personas.behaviours (the Instructions →
--                                  General box). No screen could edit them; every row
--                                  held the same install defaults, so nothing a merchant
--                                  wrote is lost. The AI now reads behaviours instead.
-- Never read:
--   data_requests.exportPath       exports are computed on download; never written.
--   sync_states.cappedAt           the cap is derived from the plan quota at render time.
--   push_subscriptions.lastUsedAt / failedAt   write-only health stamps.
--   blog_articles.blogHandle, store_pages.publishedAt, blog_articles.publishedAt
--                                  synced from Shopify, never displayed or used.

ALTER TABLE "data_sources" DROP COLUMN "crawlScope";

ALTER TABLE "personas" DROP COLUMN "guidelines",
DROP COLUMN "avoid";

ALTER TABLE "data_requests" DROP COLUMN "exportPath";

ALTER TABLE "sync_states" DROP COLUMN "cappedAt";

ALTER TABLE "push_subscriptions" DROP COLUMN "lastUsedAt",
DROP COLUMN "failedAt";

ALTER TABLE "blog_articles" DROP COLUMN "blogHandle",
DROP COLUMN "publishedAt";

ALTER TABLE "store_pages" DROP COLUMN "publishedAt";
