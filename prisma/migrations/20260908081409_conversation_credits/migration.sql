-- CreateTable
CREATE TABLE "conversation_credits" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "remaining" INTEGER NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "grantedBy" TEXT NOT NULL DEFAULT '',
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_credits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "conversation_credits_shopId_expiresAt_idx" ON "conversation_credits"("shopId", "expiresAt");
