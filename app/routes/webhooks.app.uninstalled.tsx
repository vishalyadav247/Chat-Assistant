import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { recordEvent } from "../lib/analytics/events.server";
import { invalidateShopConfig } from "../lib/config/shop-config.server";

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
  //
  // Billing (QA D6): Shopify cancels every app subscription on uninstall, so the
  // plan fields are reset to Free right here (tiny idempotent update) — a
  // reinstall inside the grace window must not resume a dead subscription.
  // cleanupShop (day-7 purge) resets them again as a backstop.
  const existing = await db.shop.findUnique({ where: { domain: shop } });
  if (existing && !existing.uninstalledAt) {
    const hadPlan = existing.plan !== "free" || existing.subscriptionId !== null;
    await db.shop.update({
      where: { id: existing.id },
      data: {
        uninstalledAt: new Date(),
        plan: "free",
        planStatus: "none",
        subscriptionId: null,
        billingInterval: null,
        trialEndsAt: null,
        usageLineItemId: null,
      },
    });
    if (hadPlan) {
      await recordEvent(existing.id, "plan_changed", {
        plan: "free",
        planStatus: "none",
        reason: "app_uninstalled",
      });
    }
    invalidateShopConfig(existing.id);
  }

  return new Response();
};
