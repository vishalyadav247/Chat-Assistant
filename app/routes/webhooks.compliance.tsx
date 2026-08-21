import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { enqueue } from "../lib/jobs/queue.server";
import { JOBS } from "../lib/jobs/handlers.server";
import { invalidateShopConfig } from "../lib/config/shop-config.server";
import { logWarn } from "../lib/log.server";

// Mandatory GDPR compliance webhooks (app review requirement).
// authenticate.webhook rejects invalid HMAC with 401 automatically; valid
// requests must get a 200 quickly — workflows run as jobs (spec 17).
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST": {
      // QA D11: non-creating lookup — a webhook for a shop we have no row for
      // (never installed / already purged) holds nothing to export.
      const shopRow = await db.shop.findUnique({ where: { domain: shop }, select: { id: true } });
      if (!shopRow) {
        logWarn("customers_data_request_unknown_shop", undefined, { shopDomain: shop });
        break;
      }
      const shopId = shopRow.id;
      const p = payload as { customer?: { email?: string } };
      const customerEmail = (p.customer?.email ?? "").trim();
      if (!customerEmail) {
        // Nothing to match a contact on — an empty-email DataRequest row would
        // be unfulfillable. Log (no PII) so the SLA clock is still visible.
        logWarn("customers_data_request_missing_email", undefined, { shopId });
        break;
      }
      // Review m2: Shopify redelivers on timeout — don't stack duplicate
      // pending requests for the same customer (no dedicated id column;
      // a recent pending row for the same email is the same request).
      const recent = await db.dataRequest.findFirst({
        where: {
          shopId,
          customerEmail,
          status: "pending",
          requestedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
      });
      if (!recent) {
        await db.dataRequest.create({
          data: {
            shopId,
            customerEmail,
            dueAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30-day SLA
          },
        });
      }
      break;
    }
    case "CUSTOMERS_REDACT": {
      const p = payload as { customer?: { email?: string; id?: number } };
      await enqueue(JOBS.customerRedact, {
        shopDomain: shop,
        customerEmail: p.customer?.email,
        customerId: p.customer?.id ? String(p.customer.id) : undefined,
      });
      break;
    }
    case "SHOP_REDACT": {
      // Arrives ~48h after uninstall. Erasure itself runs via the daily
      // uninstall-purge sweep at day 7 post-uninstall (within the 30-day
      // redaction SLA). Here we only make sure the shop is stamped as
      // uninstalled in case the app/uninstalled webhook was missed — and never
      // stamp a shop that has since reinstalled (it has live sessions).
      const shopRow = await db.shop.findUnique({ where: { domain: shop } });
      if (shopRow && !shopRow.uninstalledAt) {
        const liveSessions = await db.session.count({ where: { shop } });
        if (liveSessions === 0) {
          // Sessions are gone too — kill them explicitly in case app/uninstalled
          // never arrived (they hold the revoked offline token + owner PII).
          await db.session.deleteMany({ where: { shop } });
          // Billing (QA D6): this branch only runs when app/uninstalled was
          // MISSED, so nothing has reset the plan yet. Shopify cancels every
          // app subscription on uninstall, so the stored subscription is dead —
          // leaving `plan` on a paid tier would hand the merchant that tier for
          // free the moment they reinstall inside the 7-day grace window.
          await db.shop.update({
            where: { id: shopRow.id },
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
          invalidateShopConfig(shopRow.id);
        }
      }
      break;
    }
    default:
      console.log(`Unhandled compliance webhook topic: ${topic}`);
  }

  return new Response();
};
