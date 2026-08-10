-- AlterTable
ALTER TABLE "shops" ADD COLUMN     "billingInterval" TEXT,
ADD COLUMN     "subscriptionId" TEXT,
ADD COLUMN     "trialEndsAt" TIMESTAMP(3),
ADD COLUMN     "usageLineItemId" TEXT;
