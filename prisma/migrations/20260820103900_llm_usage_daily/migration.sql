-- CreateTable
CREATE TABLE "llm_usage_daily" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "model" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "cachedTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "llm_usage_daily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "llm_usage_daily_date_idx" ON "llm_usage_daily"("date");

-- CreateIndex
CREATE UNIQUE INDEX "llm_usage_daily_shopId_date_model_purpose_key" ON "llm_usage_daily"("shopId", "date", "model", "purpose");
