import db from "../../db.server";
import { recordEvent } from "../analytics/events.server";
import { invalidateShopConfig } from "../config/shop-config.server";
import { getBillingProvider, planFromSubscriptionName } from "./shopify-billing.server";
import { logError, logWarn } from "../log.server";
import { trialAllowanceFor, trialLedgerAfterGrant } from "./trial.server";

// app_subscriptions/update reconciliation (spec 15), run as the
// `subscription-reconcile` JOB — the webhook route only enqueues (QA-C5: the
// ACTIVE branch calls the Admin API, which has no place inside Shopify's
// 5-second webhook budget). Jobs for one shop run one at a time (pg-boss group
// = shop domain), so an out-of-order pair cannot interleave.
//
// Keeps Shop.planStatus in sync with Shopify:
// ACTIVE → active/trial; CANCELLED → free + cancelled; EXPIRED/DECLINED → free +
// none; FROZEN → free + frozen (subscription kept for an unfreeze). Redeliveries
// are safe: updates converge on the same state.
//
// Guards (QA D2/D4):
//  - the plan is derived ONLY from the subscription name; an unmappable name
//    (never "fall back to the current plan") is logged and ignored;
//  - an ACTIVE for a subscription id other than the stored one is applied only
//    when Shopify confirms it is the live active subscription — a stale /
//    out-of-order ACTIVE for an already-replaced subscription is ignored;
//  - CANCELLED/EXPIRED/DECLINED only downgrade when the id matches the stored
//    subscription (plan switches cancel the replaced subscription).

export interface AppSubscriptionPayload {
  app_subscription?: {
    admin_graphql_api_id?: string;
    name?: string;
    status?: string;
  };
}

export async function reconcileSubscription(shopDomain: string, payload: unknown): Promise<void> {
  const sub = (payload as AppSubscriptionPayload).app_subscription;
  const subscriptionId = sub?.admin_graphql_api_id ?? "";
  const status = String(sub?.status ?? "").toUpperCase();
  // Non-creating lookup: never materialise a Shop row from a webhook (D11).
  const shop = await db.shop.findUnique({ where: { domain: shopDomain } });
  if (!shop || !subscriptionId) return;

  if (status === "ACTIVE") {
    const plan = planFromSubscriptionName(String(sub?.name ?? ""));
    if (!plan) {
      logError("app_subscription_unknown_name", { subscriptionName: sub?.name, subscriptionId }, { shopDomain });
      return;
    }

    // Review m1: if the callback never ran (closed tab), this webhook is the
    // only writer — backfill interval/trial/usage-line-item from the live
    // subscription so overage reporting doesn't silently skip forever.
    let trialEndsAt: Date | null = shop.trialEndsAt;
    let backfill: {
      billingInterval?: string | null;
      trialEndsAt?: Date | null;
      trialStartedAt?: Date | null;
      trialDeadlineAt?: Date | null;
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
          return;
        }
        if (live && live.id === subscriptionId) {
          const created = new Date(live.createdAt);
          trialEndsAt =
            live.trialDays > 0
              ? new Date(created.getTime() + live.trialDays * 24 * 60 * 60 * 1000)
              : null;
          // This webhook is the ONLY writer when the merchant closed the tab
          // before the callback ran, so it has to record the trial entitlement
          // too — otherwise that merchant's trial goes unbanked and their next
          // plan switch mints a fresh one (trial.server.ts).
          const ledger = trialLedgerAfterGrant({
            ledger: shop,
            allowanceDays: trialAllowanceFor(plan),
            subscriptionCreatedAt: created,
            trialEndsAt,
          });
          backfill = {
            billingInterval: live.interval,
            trialEndsAt,
            trialStartedAt: ledger.trialStartedAt,
            trialDeadlineAt: ledger.trialDeadlineAt,
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
          // Entitlement ledger survives a cancellation — see trial.server.ts.
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

}
