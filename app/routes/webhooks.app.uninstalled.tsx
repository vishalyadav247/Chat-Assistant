import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { enqueue } from "../lib/jobs/queue.server";
import { JOBS } from "../lib/jobs/handlers.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  // Delete all shop data (idempotent); shop/redact (~48h later) is the backstop.
  await enqueue(JOBS.shopCleanup, { shopDomain: shop });

  return new Response();
};
