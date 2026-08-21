-- Hot-path indexes (QA perf pass, measured at 20k conversations / 200k messages
-- / 150k analytics events on a synthetic shop — see scripts/qa/perf-*.ts).
--
-- NOTE: `npm run migrate:new`'s scrub step picks the alphabetically-last
-- migration folder, which is NOT this one while a hand-timestamped future
-- migration exists, so the 5 protected HNSW/GIN DROP INDEX statements and the
-- products.searchText DROP DEFAULT that Prisma's differ regenerates were
-- removed by hand here. Verified against pg_indexes after applying.

-- DropIndex: superseded by "messages_shopId_createdAt_idx" below (same leading
-- column, so every plan that used it is still served).
DROP INDEX "messages_shopId_idx";

-- CreateIndex
-- Inbox list (`WHERE shopId AND isTest = false ORDER BY lastMessageAt DESC`) —
-- the most-run query in the app. Was a full scan + top-N sort because the
-- existing (shopId, status, lastMessageAt) index has an unconstrained middle
-- column.
CREATE INDEX "conversations_shopId_isTest_lastMessageAt_idx" ON "conversations"("shopId", "isTest", "lastMessageAt");

-- CreateIndex
-- Analytics rollup day windows, dashboard KPI counts and the conversations CSV
-- all filter/sort on startedAt. Was a seq scan (69ms/day × 365 days on a cold
-- 12-month analytics load).
CREATE INDEX "conversations_shopId_startedAt_idx" ON "conversations"("shopId", "startedAt");

-- CreateIndex
-- Contacts list (conversation counts per contact) + contact detail.
CREATE INDEX "conversations_shopId_contactId_idx" ON "conversations"("shopId", "contactId");

-- CreateIndex
-- Analytics rollup day window (`shopId + createdAt` range) and Top questions
-- (`shopId + newest first`). Both were parallel seq scans of the whole
-- messages table (123ms per rollup day).
CREATE INDEX "messages_shopId_createdAt_idx" ON "messages"("shopId", "createdAt");
