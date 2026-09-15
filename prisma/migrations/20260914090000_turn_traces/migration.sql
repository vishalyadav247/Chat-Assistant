-- Turn traces (Admin → Debug, 2026-09-14): one row per RECORDED storefront
-- chat turn — shopper message, reply, decision trail and the exact LLM
-- prompts. Written only while the operator's `turnTracingEnabled` runtime
-- switch is ON (off by default). GDPR: deleted by shop purge, customer
-- redact and the daily retention job (7 days / 20,000-row ceiling).
CREATE TABLE "turn_traces" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "shopperText" TEXT NOT NULL DEFAULT '',
    "replyText" TEXT NOT NULL DEFAULT '',
    "outcome" TEXT NOT NULL DEFAULT '',
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "turn_traces_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "turn_traces_shopId_conversationId_createdAt_idx"
    ON "turn_traces"("shopId", "conversationId", "createdAt");

CREATE INDEX "turn_traces_createdAt_idx" ON "turn_traces"("createdAt");
