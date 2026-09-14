import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { enqueue } from "../lib/jobs/queue.server";
import { JOBS } from "../lib/jobs/handlers.server";

// Enqueue-only (5s rule), the same as products: the row upsert, membership
// refresh and delete all run in jobs. Jobs are idempotent.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  switch (topic) {
    case "COLLECTIONS_CREATE":
    case "COLLECTIONS_UPDATE":
      await enqueue(JOBS.collectionUpsert, { shopDomain: shop, payload });
      break;
    case "COLLECTIONS_DELETE":
      await enqueue(JOBS.collectionDelete, { shopDomain: shop, payload });
      break;
    default:
      console.log(`Unhandled collections webhook topic: ${topic}`);
  }

  return new Response();
};
