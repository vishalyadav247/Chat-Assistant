import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// app/scopes_update: Shopify granted/revoked scopes for this shop. Keep the
// stored scope string in sync so `authenticate.admin` does not bounce the
// merchant through a needless re-grant.
//
// updateMany over EVERY session row for the shop (not `update` on the one the
// library happened to resolve): a shop can hold more than one session row
// (offline + per-user online tokens), and a stale scope string on any of them
// re-triggers the OAuth grant screen. `update` would also throw P2025 — a 500
// Shopify retries forever — if the row had just been deleted by a racing
// app/uninstalled.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, topic, shop } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  const current = payload?.current;
  if (!Array.isArray(current)) return new Response();

  await db.session.updateMany({
    where: { shop },
    data: { scope: current.map(String).join(",") },
  });

  return new Response();
};
