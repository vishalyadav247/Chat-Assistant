-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "meteredAt" TIMESTAMP(3),
ADD COLUMN     "summaryMessageCount" INTEGER NOT NULL DEFAULT 0;