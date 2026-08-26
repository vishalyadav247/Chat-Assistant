-- Shop.widgetSeenAt — last storefront widget-config request.
--
-- Theme app-embed detection normally requires the read_themes scope, which this
-- app deliberately does not request (a scope addition forces every merchant
-- through re-auth). Only the embed makes this request, so a recent stamp proves
-- the embed is live with no extra scope at all. It can prove "on"; it cannot
-- prove "off" (a store with no traffic looks the same as one with the embed
-- disabled), so the existing "unknown" state is retained for that case.
ALTER TABLE "shops" ADD COLUMN "widgetSeenAt" TIMESTAMP(3);
