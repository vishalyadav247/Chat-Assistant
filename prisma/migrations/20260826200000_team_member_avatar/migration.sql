-- Team member profile photo (spec 06 "Chat avatar" → Team member profile).
-- Nullable: existing members keep rendering as initials until one is uploaded.
ALTER TABLE "team_members" ADD COLUMN "avatarUrl" TEXT;
