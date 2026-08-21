import db from "../../db.server";
import { requireShopId } from "../tenancy.server";
import { isBillingTestMode } from "./shopify-billing.server";
import { overageRate } from "./plans.server";
import { logError } from "../log.server";

// Overage reporting (spec 15): each conversation beyond the plan allowance is
// reported to Shopify immediately at tick time via appUsageRecordCreate at the
// plan's overagePerConversation rate, against the subscription's usage line
// item (Shop.usageLineItemId, stored on billing return).
// QA D5: the rate is read from the live plan matrix (platform-overridable) at
// record time — the Shop row has no column to persist the agreed rate (no
// migration added), so a platform rate change applies to subsequent records.
// Yearly subscriptions carry no usage line (QA D1) → usageLineItemId null →
// nothing is reported (the meter hard-caps instead). One tick = one usage record, so no separate
// "reported count" bookkeeping column is needed. Called fire-and-forget from
// tickConversation — a billing hiccup must never break the chat request path
// (overageCount on PlanUsage remains the local source of truth for the meter).
//
// Mutation shape verified against @shopify/shopify-api
// node_modules .../lib/billing/create-usage-record.mjs (2026-07-compatible).

const CREATE_USAGE_RECORD_MUTATION = `
  mutation AppUsageRecordCreate(
    $description: String!
    $price: MoneyInput!
    $subscriptionLineItemId: ID!
  ) {
    appUsageRecordCreate(
      description: $description
      price: $price
      subscriptionLineItemId: $subscriptionLineItemId
    ) {
      appUsageRecord { id }
      userErrors { field message }
    }
  }
`;

/**
 * Report one overage conversation for this shop. Skips silently when the shop
 * has no usage line item (Free plan / no subscription). Mock mode logs only.
 */
export async function reportOverageUsage(shopId: string, description: string): Promise<void> {
  const shop = await db.shop.findUnique({
    where: { id: requireShopId(shopId) },
    select: { domain: true, plan: true, billingInterval: true, usageLineItemId: true },
  });
  if (!shop?.usageLineItemId) return; // no usage line on the subscription — nothing to report
  if (shop.billingInterval === "yearly") return; // annual subs cannot carry usage lines (D1)
  const amount = overageRate(shop.plan);
  if (amount === null || amount <= 0) return; // plan no longer bills overage

  if (isBillingTestMode()) {
    console.log(
      `[billing mock] appUsageRecordCreate ${shop.domain} lineItem=${shop.usageLineItemId} ` +
        `$${amount} USD "${description}"`,
    );
    return;
  }

  // Lazy import so mock-mode scripts never boot the full Shopify app config.
  const { unauthenticated } = await import("../../shopify.server");
  const { admin } = await unauthenticated.admin(shop.domain);
  const response = await admin.graphql(CREATE_USAGE_RECORD_MUTATION, {
    variables: {
      description,
      price: { amount, currencyCode: "USD" },
      subscriptionLineItemId: shop.usageLineItemId,
    },
  });
  const body = (await response.json()) as {
    data?: { appUsageRecordCreate?: { userErrors?: Array<{ message: string }> } };
  };
  const errors = body.data?.appUsageRecordCreate?.userErrors;
  if (errors?.length) {
    // Capped amount reached returns a userError — log, never throw into the pipeline.
    logError("overage_usage_record_error", errors.map((e) => e.message).join("; "), {
      shopDomain: shop.domain,
    });
  }
}
