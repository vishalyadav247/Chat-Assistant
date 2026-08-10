import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { enqueue } from "../lib/jobs/queue.server";
import { JOBS } from "../lib/jobs/handlers.server";

// Enqueue-only (5s rule): no embedding/API work inline. Jobs are idempotent.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  switch (topic) {
    case "PRODUCTS_CREATE":
    case "PRODUCTS_UPDATE":
      await enqueue(JOBS.productUpsert, { shopDomain: shop, payload });
      break;
    case "PRODUCTS_DELETE":
      await enqueue(JOBS.productDelete, { shopDomain: shop, payload });
      break;
    default:
      console.log(`Unhandled products webhook topic: ${topic}`);
  }

  return new Response();
};
