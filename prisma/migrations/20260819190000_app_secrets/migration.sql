-- App-level generated secrets (auto-provisioned VAPID keys for Web Push; spec 18).
CREATE TABLE "app_secrets" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "app_secrets_pkey" PRIMARY KEY ("key")
);
