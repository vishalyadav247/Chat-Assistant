import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";
import db from "../db.server";
import { recordEvent } from "../lib/analytics/events.server";
import { resolveShopId } from "../lib/tenancy.server";
import { hasFeature } from "../lib/billing/plans.server";
import { authenticate } from "../shopify.server";

// POST /apps/chatconvert/survey — satisfaction survey result (spec 05/16).
// Stores the rating on the conversation (shop-scoped) + analytics event.

const bodySchema = z.object({
  conversationId: z.string().min(1).max(64),
  sessionId: z.string().min(8).max(64),
  rating: z.number().int().min(1).max(5),
});

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) {
    return new Response("app not installed", { status: 404 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return new Response("bad request", { status: 400 });
  }

  const shopId = await resolveShopId(session.shop);

  // Post-chat CSAT is a Basic+ feature (spec 15). The widget config already
  // withholds the survey on Free, but the endpoint is public — gate it here too
  // so a crafted POST can't write ratings a Free shop never paid for.
  const shop = await db.shop.findUnique({ where: { id: shopId }, select: { plan: true } });
  if (!hasFeature(shop?.plan ?? "free", "survey")) {
    return new Response("not available on this plan", { status: 403 });
  }

  const updated = await db.conversation.updateMany({
    // sessionId binds the rating to the caller's own conversation (review C1).
    where: { id: parsed.data.conversationId, shopId, sessionId: parsed.data.sessionId },
    data: { rating: parsed.data.rating },
  });
  if (updated.count === 0) {
    return new Response("not found", { status: 404 });
  }

  await recordEvent(shopId, "survey_submitted", { rating: parsed.data.rating });

  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
};
