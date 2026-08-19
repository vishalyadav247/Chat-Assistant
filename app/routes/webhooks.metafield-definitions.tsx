import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { enqueue } from "../lib/jobs/queue.server";
import { JOBS } from "../lib/jobs/handlers.server";

// metafield_definitions/create|update|delete (spec 07 Manage metafields,
// 2026-08-19; needs the read_content scope). Enqueue-only (5s rule): the job
// re-mirrors the whole definitions catalog from the Admin API, so the payload
// is not needed and redeliveries are harmless.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop } = await authenticate.webhook(request);

  switch (topic) {
    case "METAFIELD_DEFINITIONS_CREATE":
    case "METAFIELD_DEFINITIONS_UPDATE":
    case "METAFIELD_DEFINITIONS_DELETE":
      await enqueue(JOBS.metafieldDefinitionsSync, { shopDomain: shop });
      break;
    default:
      console.log(`Unhandled metafield definitions webhook topic: ${topic}`);
  }

  return new Response();
};
