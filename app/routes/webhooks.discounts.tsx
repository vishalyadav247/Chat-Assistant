import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { enqueue } from "../lib/jobs/queue.server";
import { JOBS } from "../lib/jobs/handlers.server";

// Real-time discount sync (spec 02 — feature-gated `discount_realtime_sync`;
// gate checked in the job while enforcement is in open mode). Enqueue-only.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  switch (topic) {
    case "DISCOUNTS_CREATE":
    case "DISCOUNTS_UPDATE":
      await enqueue(JOBS.discountUpsert, { shopDomain: shop, payload });
      break;
    case "DISCOUNTS_DELETE":
      await enqueue(JOBS.discountDelete, { shopDomain: shop, payload });
      break;
    default:
      console.log(`Unhandled discounts webhook topic: ${topic}`);
  }

  return new Response();
};
