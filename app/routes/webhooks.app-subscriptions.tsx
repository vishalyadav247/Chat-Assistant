import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { enqueue } from "../lib/jobs/queue.server";
import { JOBS } from "../lib/jobs/handlers.server";

// app_subscriptions/update (spec 15). Enqueue-only, like every webhook handler
// (QA-C5): the reconciliation — plan mapping, the live-subscription lookup on
// the Admin API, stale/replaced-subscription guards, trial ledger backfill,
// cache invalidation — runs in the `subscription-reconcile` job
// (app/lib/billing/subscription-reconcile.server.ts), grouped per shop so two
// deliveries for one store never run concurrently.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop: shopDomain, payload } = await authenticate.webhook(request);
  if (topic !== "APP_SUBSCRIPTIONS_UPDATE") {
    console.log(`Unhandled app-subscriptions webhook topic: ${topic}`);
    return new Response();
  }
  await enqueue(JOBS.subscriptionReconcile, { shopDomain, payload }, { group: { id: shopDomain } });
  return new Response();
};
