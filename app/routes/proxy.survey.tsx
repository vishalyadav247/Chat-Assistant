import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";
import db from "../db.server";
import { recordEvent } from "../lib/analytics/events.server";
import { resolveShopId } from "../lib/tenancy.server";
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
