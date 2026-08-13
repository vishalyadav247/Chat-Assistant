import type { LoaderFunctionArgs } from "react-router";
import { getWidgetThreadHistory } from "../lib/inbox/inbox.server";
import { resolveShopId } from "../lib/tenancy.server";
import { authenticate } from "../shopify.server";

// GET /apps/ccwidget/history?conversationId=&sessionId= — full thread restore
// for the widget after a storefront page navigation (spec 05 delta closed
// 2026-08-10). Shop identity from the verified proxy signature; the
// conversation must belong to the caller's own widget session.

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) {
    return new Response("app not installed", { status: 404 });
  }

  const url = new URL(request.url);
  const conversationId = url.searchParams.get("conversationId") ?? "";
  const sessionIdParam = url.searchParams.get("sessionId") ?? "";
  if (
    !conversationId ||
    conversationId.length > 64 ||
    !sessionIdParam ||
    sessionIdParam.length > 64
  ) {
    return new Response("bad request", { status: 400 });
  }

  const shopId = await resolveShopId(session.shop);
  const state = await getWidgetThreadHistory(shopId, conversationId, sessionIdParam);
  if (!state) {
    return new Response("not found", { status: 404 });
  }

  return Response.json(state, { headers: { "Cache-Control": "no-store" } });
};
