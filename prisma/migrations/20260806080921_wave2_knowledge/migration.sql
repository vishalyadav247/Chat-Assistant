-- CreateTable
CREATE TABLE "cross_sell_pairs" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "companionIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'active',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cross_sell_pairs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unresolved_questions" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "conversationId" TEXT,
    "reason" TEXT NOT NULL DEFAULT 'fell_back',
    "count" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "unresolved_questions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cross_sell_pairs_shopId_productId_key" ON "cross_sell_pairs"("shopId", "productId");

-- CreateIndex
CREATE INDEX "unresolved_questions_shopId_status_idx" ON "unresolved_questions"("shopId", "status");
