import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { resolveShopId } from "../lib/tenancy.server";

// Collections change rarely and the payload is tiny — direct upsert is still
// fast enough for the 5s rule; embedding work (none for collections) stays out.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);
  const shopId = await resolveShopId(shop);
  const p = payload as { admin_graphql_api_id?: string; id?: number; title?: string; body_html?: string };
  const shopifyCollectionId = p.admin_graphql_api_id ?? `gid://shopify/Collection/${p.id}`;

  switch (topic) {
    case "COLLECTIONS_CREATE":
    case "COLLECTIONS_UPDATE":
      await db.collection.upsert({
        where: { shopId_shopifyCollectionId: { shopId, shopifyCollectionId } },
        update: {
          title: p.title ?? "",
          description: (p.body_html ?? "").replace(/<[^>]*>/g, " ").trim(),
        },
        create: {
          shopId,
          shopifyCollectionId,
          title: p.title ?? "",
          description: (p.body_html ?? "").replace(/<[^>]*>/g, " ").trim(),
        },
      });
      break;
    case "COLLECTIONS_DELETE":
      await db.collection.deleteMany({ where: { shopId, shopifyCollectionId } });
      break;
    default:
      console.log(`Unhandled collections webhook topic: ${topic}`);
  }

  return new Response();
};
