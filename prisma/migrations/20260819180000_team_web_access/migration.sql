-- Team members, web sessions/one-time tokens, push subscriptions (spec 18, 2026-08-19).

CREATE TABLE "team_members" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'agent',
    "status" TEXT NOT NULL DEFAULT 'invited',
    "passwordHash" TEXT,
    "notifyPrefs" JSONB,
    "failedLogins" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "invitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "joinedAt" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "team_members_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "team_members_shopId_email_key" ON "team_members"("shopId", "email");
CREATE INDEX "team_members_shopId_idx" ON "team_members"("shopId");
CREATE INDEX "team_members_email_idx" ON "team_members"("email");

CREATE TABLE "team_sessions" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'session',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userAgent" TEXT,
    CONSTRAINT "team_sessions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "team_sessions_tokenHash_key" ON "team_sessions"("tokenHash");
CREATE INDEX "team_sessions_shopId_memberId_idx" ON "team_sessions"("shopId", "memberId");
CREATE INDEX "team_sessions_expiresAt_idx" ON "team_sessions"("expiresAt");

CREATE TABLE "push_subscriptions" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");
CREATE INDEX "push_subscriptions_shopId_memberId_idx" ON "push_subscriptions"("shopId", "memberId");

-- Backfill: the JSON roster previously kept in shop_settings.settings.team.members
-- (ids preserved so conversation.assigneeId keeps pointing at the same people).
INSERT INTO "team_members" ("id", "shopId", "email", "name", "role", "status", "invitedAt", "createdAt", "updatedAt")
SELECT
    m->>'id',
    s."shopId",
    lower(trim(m->>'email')),
    COALESCE(NULLIF(trim(m->>'name'), ''), split_part(m->>'email', '@', 1)),
    CASE WHEN m->>'role' = 'admin' THEN 'admin' ELSE 'agent' END,
    'invited',
    COALESCE(NULLIF(m->>'since', '')::timestamp, CURRENT_TIMESTAMP),
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "shop_settings" s,
     LATERAL jsonb_array_elements(COALESCE(s."settings"->'team'->'members', '[]'::jsonb)) AS m
WHERE (m->>'id') IS NOT NULL AND (m->>'email') IS NOT NULL
ON CONFLICT DO NOTHING;
