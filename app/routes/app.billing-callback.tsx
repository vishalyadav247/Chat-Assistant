import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { routeError } from "../lib/ui/route-error";
import {
  completeBillingReturn,
  isBillingInterval,
  isPaidPlan,
} from "../lib/billing/shopify-billing.server";
import { logError } from "../lib/log.server";

// Billing return URL (spec 15 / 15b): Shopify redirects here after the merchant
// approves the subscription (charge_id appended). Verify the subscription is
// ACTIVE, persist plan/status/subscription fields on the Shop row, then bounce
// back to the Plan & Usage page. Uses the redirect helper from
// authenticate.admin (embedded-app safe), never react-router's redirect.
//
// QA D8: this GET never mutates billing state on its own — downgrading to Free
// is a POST on the plan page action (app.plan-usage.tsx), so a plain
// `?plan=free` link cannot cancel a subscription.

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, redirect } = await authenticate.admin(request);
  const url = new URL(request.url);
  const plan = url.searchParams.get("plan") ?? "";
  const interval = url.searchParams.get("interval") ?? "monthly";
  const chargeId = url.searchParams.get("charge_id");

  let ok = false;
  if (isPaidPlan(plan) && isBillingInterval(interval)) {
    const result = await completeBillingReturn({
      shopDomain: session.shop,
      plan,
      interval,
      chargeId,
    });
    if (!result.ok) logError("billing_callback_error", result.error, { shopDomain: session.shop });
    ok = result.ok;
  }

  return redirect(ok ? "/app/plan-usage?upgraded=1" : "/app/plan-usage?billing_error=1");
};

export function ErrorBoundary() {
  return routeError(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
