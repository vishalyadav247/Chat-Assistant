-- Spec 21 — operator error/warning log (cross-tenant, /platform/logs).
-- shopId is nullable by design (scheduler/boot failures have no shop context).
CREATE TABLE "app_logs" (
    "id" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "shopId" TEXT,
    "message" TEXT NOT NULL,
    "context" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_logs_pkey" PRIMARY KEY ("id")
);

-- Recent-first listing (the default page view).
CREATE INDEX "app_logs_occurredAt_idx" ON "app_logs"("occurredAt");

-- Per-merchant support lookups ("what broke for this store?").
CREATE INDEX "app_logs_shopId_occurredAt_idx" ON "app_logs"("shopId", "occurredAt");

-- Triage: top failing event codes by level over a window.
CREATE INDEX "app_logs_level_event_occurredAt_idx" ON "app_logs"("level", "event", "occurredAt");
