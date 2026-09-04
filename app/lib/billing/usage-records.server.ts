import db from "../../db.server";
import { requireShopId } from "../tenancy.server";
import { isBillingTestMode } from "./shopify-billing.server";
import { overageRate } from "./plans.server";
import { invalidateUsageBalance, markCapExhausted } from "./usage-cap.server";
import { logError, logWarn } from "../log.server";

// Overage reporting (spec 15, hardened 2026-09-03): each conversation beyond
// the plan allowance is billed to Shopify via appUsageRecordCreate at the
// plan's overagePerConversation rate, against the subscription's usage line
// item (Shop.usageLineItemId, stored on billing return).
//
// The unit of truth is a PAIR of counters on PlanUsage:
//   overageCount    — conversations served past the allowance
//   overageReported — conversations Shopify has accepted a charge for
// The difference is work done but not yet paid for. Everything here exists to
// drive that difference to zero: tick time submits immediately, and the hourly
// reconcile job (jobs/handlers.server.ts) retries whatever is still owed.
// Before this, a failed call was logged and forgotten — the conversation had
// been served and could never be billed again.
//
// QA D5: the rate is read from the live plan matrix (admin-overridable) at
// record time — the Shop row has no column to persist the agreed rate, so an
// operator's rate change applies to subsequent records.
// Yearly subscriptions carry no usage line (QA D1) → usageLineItemId null →
// nothing is reported (the meter hard-caps instead).
//
// Mutation shape verified against @shopify/shopify-api
// node_modules .../lib/billing/create-usage-record.mjs and revalidated against
// the 2026-07 Admin schema (2026-09-03).

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

export interface OverageSubmission {
  /** Records Shopify accepted (and therefore billed). */
  accepted: number;
  /** Still owed after this run — retried by the reconcile job. */
  owed: number;
  /** The merchant's approved ceiling stopped us. Nothing more fits this cycle. */
  capped: boolean;
}

/** Conversations served past the allowance that Shopify has not yet billed. */
export async function unbilledOverage(shopId: string, periodStart: Date): Promise<number> {
  const row = await db.planUsage.findUnique({
    where: { shopId_periodStart: { shopId: requireShopId(shopId), periodStart } },
    select: { overageCount: true, overageReported: true },
  });
  return Math.max(0, (row?.overageCount ?? 0) - (row?.overageReported ?? 0));
}

/** The capped-amount rejection is a userError, not an exception. */
function isCapError(message: string): boolean {
  return /capped|failed to create usage charge|exceed/i.test(message);
}

/**
 * Bill up to `max` owed conversations for this shop, one usage record each
 * (Shopify has no batch form). Stops at the first cap rejection.
 *
 * Never throws: the caller is either the chat request path or a background job,
 * and neither should die over billing. Whatever is left stays owed and is
 * retried on the next reconcile.
 */
export async function submitOverageRecords(
  shopId: string,
  periodStart: Date,
  max = 25,
): Promise<OverageSubmission> {
  const id = requireShopId(shopId);
  const shop = await db.shop.findUnique({
    where: { id },
    select: { domain: true, plan: true, billingInterval: true, usageLineItemId: true },
  });
  let owed = await unbilledOverage(id, periodStart);
  if (!shop?.usageLineItemId) return { accepted: 0, owed, capped: false };
  if (shop.billingInterval === "yearly") return { accepted: 0, owed, capped: false }; // D1
  const amount = overageRate(shop.plan);
  if (amount === null || amount <= 0) return { accepted: 0, owed, capped: false };
  if (owed <= 0) return { accepted: 0, owed: 0, capped: false };

  const description = "Extra AI conversation beyond the plan allowance";
  let accepted = 0;
  let capped = false;

  const commit = async () => {
    if (accepted === 0) return;
    await db.planUsage
      .update({
        where: { shopId_periodStart: { shopId: id, periodStart } },
        data: { overageReported: { increment: accepted } },
      })
      .catch((error: unknown) => logError("overage_reported_commit_error", error, { shopDomain: shop.domain }));
  };

  if (isBillingTestMode()) {
    const batch = Math.min(owed, max);
    console.log(
      `[billing mock] appUsageRecordCreate x${batch} ${shop.domain} ` +
        `lineItem=${shop.usageLineItemId} $${amount} USD each`,
    );
    accepted = batch;
    await commit();
    invalidateUsageBalance(id);
    return { accepted, owed: owed - accepted, capped: false };
  }

  try {
    // Lazy import so mock-mode scripts never boot the full Shopify app config.
    const { unauthenticated } = await import("../../shopify.server");
    const { admin } = await unauthenticated.admin(shop.domain);

    for (let i = 0; i < Math.min(owed, max); i++) {
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
      const errors = body.data?.appUsageRecordCreate?.userErrors ?? [];
      if (errors.length > 0) {
        const message = errors.map((e) => e.message).join("; ");
        if (isCapError(message)) {
          // The merchant's approved ceiling is reached. aiAllowed() stops
          // serving billable conversations from here until they raise it, so
          // nothing more is given away free.
          markCapExhausted(id);
          capped = true;
          logWarn("overage_cap_reached", message, { shopDomain: shop.domain });
        } else {
          logError("overage_usage_record_error", message, { shopDomain: shop.domain });
        }
        break;
      }
      accepted++;
    }
  } catch (error) {
    // Network / token / rate-limit. Whatever was accepted before the throw is
    // still committed below; the rest stays owed for the reconcile job.
    logError("overage_usage_record_error", error, { shopDomain: shop.domain });
  }

  await commit();
  if (accepted > 0) invalidateUsageBalance(id);
  owed = await unbilledOverage(id, periodStart);
  return { accepted, owed, capped };
}
