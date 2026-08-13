import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  // Sessions go immediately — they hold the (now-revoked) offline token + owner PII.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  // Domain data is NOT deleted here: it survives a 7-day grace window so an
  // accidental uninstall / quick reinstall keeps history. Stamping
  // uninstalledAt deactivates the shop for all background jobs; the daily
  // uninstall-purge sweep (jobs/handlers.server.ts) erases everything at day 7
  // unless a reinstall cleared the stamp. shop/redact (~48h later) is honored
  // by the same sweep, within Shopify's 30-day redaction SLA.
  const existing = await db.shop.findUnique({ where: { domain: shop } });
  if (existing && !existing.uninstalledAt) {
    await db.shop.update({ where: { id: existing.id }, data: { uninstalledAt: new Date() } });
  }

  return new Response();
};
