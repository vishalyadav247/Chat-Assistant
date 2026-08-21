import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { recordEvent } from "../lib/analytics/events.server";
import { invalidateShopConfig } from "../lib/config/shop-config.server";
import {
  getBillingProvider,
  planFromSubscriptionName,
} from "../lib/billing/shopify-billing.server";
import { logError, logWarn } from "../lib/log.server";

// app_subscriptions/update (spec 15): keep Shop.planStatus in sync with Shopify.
// ACTIVE → active/trial; CANCELLED → free + cancelled; EXPIRED/DECLINED → free +
// none. A tiny idempotent DB update is fine inline (well under the 5s rule —
// no enqueue needed). Redeliveries are safe: updates converge on the same state.
//
// Guards (QA D2/D4):
//  - the plan is derived ONLY from the subscription name; an unmappable name
//    (never "fall back to the current plan") is logged and ignored;
//  - an ACTIVE for a subscription id other than the stored one is applied only
//    when Shopify confirms it is the live active subscription — a stale /
//    out-of-order ACTIVE for an already-replaced subscription is ignored;
//  - CANCELLED/EXPIRED/DECLINED only downgrade when the id matches the stored
//    subscription (plan switches cancel the replaced subscription).

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
  // Non-creating lookup: never materialise a Shop row from a webhook (D11).
  const shop = await db.shop.findUnique({ where: { domain: shopDomain } });
  if (!shop || !subscriptionId) return new Response();

  if (status === "ACTIVE") {
    const plan = planFromSubscriptionName(String(sub?.name ?? ""));
    if (!plan) {
      logError("app_subscription_unknown_name", { subscriptionName: sub?.name, subscriptionId }, { shopDomain });
      return new Response();
    }

    // Review m1: if the callback never ran (closed tab), this webhook is the
    // only writer — backfill interval/trial/usage-line-item from the live
    // subscription so overage reporting doesn't silently skip forever.
    let trialEndsAt: Date | null = shop.trialEndsAt;
    let backfill: {
      billingInterval?: string | null;
      trialEndsAt?: Date | null;
      usageLineItemId?: string | null;
    } = {};
    if (shop.subscriptionId !== subscriptionId) {
      try {
        const live = await getBillingProvider().getActiveSubscription(shopDomain);
        if (live && live.id !== subscriptionId) {
          // Stale / out-of-order ACTIVE for a subscription Shopify has since
          // replaced — applying it would point plan/subscriptionId at a dead
          // subscription (and a later CANCELLED for it would drop us to Free).
          logWarn(
            "app_subscription_stale_active_ignored",
            { webhookId: subscriptionId, liveId: live.id },
            { shopDomain },
          );
          return new Response();
        }
        if (live && live.id === subscriptionId) {
          const created = new Date(live.createdAt);
          trialEndsAt =
            live.trialDays > 0
              ? new Date(created.getTime() + live.trialDays * 24 * 60 * 60 * 1000)
              : null;
          backfill = {
            billingInterval: live.interval,
            trialEndsAt,
            usageLineItemId: live.usageLineItemId,
          };
        } else {
          // Could not confirm a live subscription: the stored usage line item
          // belongs to the previous subscription — never report usage to it.
          backfill = { usageLineItemId: null };
        }
      } catch (error) {
        logError("app_subscription_backfill_error", error);
        backfill = { usageLineItemId: null };
      }
    }

    // Status derives from the (backfilled) trial end, not the pre-switch value.
    const inTrial = trialEndsAt !== null && trialEndsAt.getTime() > Date.now();
    const planStatus = inTrial ? "trial" : "active";
    const changed =
      shop.plan !== plan || shop.planStatus !== planStatus || shop.subscriptionId !== subscriptionId;

    await db.shop.update({
      where: { id: shop.id },
      data: { plan, planStatus, subscriptionId, ...backfill },
    });
    if (changed) {
      await recordEvent(shop.id, "plan_changed", {
        plan,
        planStatus,
        subscriptionId,
        reason: "subscription_active",
      });
    }
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
    } else {
      console.log(
        `app_subscriptions/update: ignoring ${status} for non-current subscription ${subscriptionId} (${shopDomain})`,
      );
    }
  } else if (status === "FROZEN") {
    // Shopify freezes a subscription when the merchant's billing fails. The
    // charge is not collected, so continuing to serve the paid tier gives the
    // plan away (QA D-09 — previously this fell into the "ignore" branch and
    // the shop kept every paid feature indefinitely).
    //
    // We do NOT clear subscriptionId/billingInterval/usageLineItemId: the same
    // subscription can be unfrozen once payment succeeds, and the ACTIVE branch
    // above then restores the tier from the verified subscription name. Only
    // the entitlement is suspended.
    if (shop.subscriptionId === subscriptionId && shop.planStatus !== "frozen") {
      await db.shop.update({
        where: { id: shop.id },
        data: { plan: "free", planStatus: "frozen" },
      });
      await recordEvent(shop.id, "plan_changed", {
        plan: "free",
        reason: "subscription_frozen",
      });
      invalidateShopConfig(shop.id);
    }
  } else if (status === "PENDING") {
    // Awaiting merchant approval — not an entitlement yet. Nothing to do; the
    // ACTIVE delivery (or the billing callback) grants the plan.
    logWarn("app_subscription_pending", `pending approval for ${shopDomain}`, {
      shopDomain,
      subscriptionId,
    });
  } else {
    logWarn("app_subscription_unhandled_status", `unhandled status ${status}`, {
      shopDomain,
      subscriptionId,
      status,
    });
  }

  return new Response();
};
