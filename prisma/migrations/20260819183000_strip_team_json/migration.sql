-- The team roster now lives in team_members (spec 18, backfilled by the previous
-- migration). Drop the duplicated JSON so member emails aren't stored twice.
UPDATE "shop_settings" SET "settings" = "settings" - 'team' WHERE "settings" ? 'team';
