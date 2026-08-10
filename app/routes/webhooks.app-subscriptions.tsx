import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { recordEvent } from "../lib/analytics/events.server";
import { invalidateShopConfig } from "../lib/config/shop-config.server";
import { getBillingProvider, isPaidPlan } from "../lib/billing/shopify-billing.server";

// app_subscriptions/update (spec 15): keep Shop.planStatus in sync with Shopify.
// ACTIVE → active/trial; CANCELLED → free + cancelled; EXPIRED/DECLINED → free +
// none. A tiny idempotent DB update is fine inline (well under the 5s rule —
// no enqueue needed). Redeliveries are safe: updates converge on the same state.
//
// Guard: when a merchant switches plans Shopify cancels the replaced
// subscription and delivers CANCELLED for it — only downgrade when the webhook's
// subscription id matches the one stored on the Shop row.

interface AppSubscriptionPayload {
  app_subscription?: {
    admin_graphql_api_id?: string;
    name?: string;
    status?: string;
  };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop: shopDomain, payload } = await authenticate.webhook(request);
  if (topic !== "APP_SUBSCRIPTIONS_UPDATE") {
    console.log(`Unhandled app-subscriptions webhook topic: ${topic}`);
    return new Response();
  }

  const sub = (payload as AppSubscriptionPayload).app_subscription;
  const subscriptionId = sub?.admin_graphql_api_id ?? "";
  const status = String(sub?.status ?? "").toUpperCase();
  const shop = await db.shop.findUnique({ where: { domain: shopDomain } });
  if (!shop || !subscriptionId) return new Response();

  if (status === "ACTIVE") {
    // Derive the plan from the subscription name ("ChatConvert Basic" → basic).
    const namePlan = String(sub?.name ?? "").split(" ").pop()?.toLowerCase() ?? "";
    const plan = isPaidPlan(namePlan) ? namePlan : shop.plan;
    const inTrial = shop.trialEndsAt !== null && shop.trialEndsAt.getTime() > Date.now();

    // Review m1: if the callback never ran (closed tab), this webhook is the
    // only writer — backfill interval/trial/usage-line-item from the live
    // subscription so overage reporting doesn't silently skip forever.
    let backfill: {
      billingInterval?: string | null;
      trialEndsAt?: Date | null;
      usageLineItemId?: string | null;
    } = {};
    if (shop.subscriptionId !== subscriptionId) {
      try {
        const live = await getBillingProvider().getActiveSubscription(shopDomain);
        if (live && live.id === subscriptionId) {
          const created = new Date(live.createdAt);
          backfill = {
            billingInterval: live.interval,
            trialEndsAt:
              live.trialDays > 0
                ? new Date(created.getTime() + live.trialDays * 24 * 60 * 60 * 1000)
                : null,
            usageLineItemId: live.usageLineItemId,
          };
        }
      } catch (error) {
        console.error("app_subscription_backfill_error", error);
      }
    }

    await db.shop.update({
      where: { id: shop.id },
      data: { plan, planStatus: inTrial ? "trial" : "active", subscriptionId, ...backfill },
    });
    invalidateShopConfig(shop.id);
  } else if (status === "CANCELLED" || status === "EXPIRED" || status === "DECLINED") {
    // Only downgrade if this is the subscription the shop is actually on.
    if (shop.subscriptionId === subscriptionId) {
      await db.shop.update({
        where: { id: shop.id },
        data: {
          plan: "free",
          planStatus: status === "CANCELLED" ? "cancelled" : "none",
          subscriptionId: null,
          billingInterval: null,
          trialEndsAt: null,
          usageLineItemId: null,
        },
      });
      await recordEvent(shop.id, "plan_changed", {
        plan: "free",
        reason: `subscription_${status.toLowerCase()}`,
      });
      invalidateShopConfig(shop.id);
    }
  } else {
    console.log(`app_subscriptions/update: ignoring status ${status} for ${shopDomain}`);
  }

  return new Response();
};
