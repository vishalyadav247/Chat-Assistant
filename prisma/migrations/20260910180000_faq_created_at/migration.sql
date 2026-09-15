-- FAQ createdAt (2026-09-10, user decision): DB-stamped on insert, shown as
-- the "Created" column in the admin FAQ table. Merchants never enter it.
-- Pre-existing rows get the migration time — their true creation time was
-- never recorded.
ALTER TABLE "faqs" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
