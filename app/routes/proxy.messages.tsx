import type { LoaderFunctionArgs } from "react-router";
import { getWidgetThreadState } from "../lib/inbox/inbox.server";
import { resolveShopId } from "../lib/tenancy.server";
import { authenticate } from "../shopify.server";

// GET /apps/chatconvert/messages?conversationId=&since=&seen=1 — human-mode
// polling (spec 05/10). Returns agent/system messages created after `since`
// for THAT shop's conversation only, plus the conversation's mode/status so
// the widget knows when a human took over or the thread was resolved.
// `seen=1` (widget is visibly rendering the thread) marks agent replies seen.

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) {
    return new Response("app not installed", { status: 404 });
  }

  const url = new URL(request.url);
  const conversationId = url.searchParams.get("conversationId") ?? "";
  const sessionIdParam = url.searchParams.get("sessionId") ?? "";
  const sinceRaw = url.searchParams.get("since") ?? "";
  const since = new Date(sinceRaw);
  if (
    !conversationId ||
    conversationId.length > 64 ||
    !sessionIdParam ||
    sessionIdParam.length > 64 ||
    Number.isNaN(since.getTime())
  ) {
    return new Response("bad request", { status: 400 });
  }
  const markSeen = url.searchParams.get("seen") === "1";

  const shopId = await resolveShopId(session.shop);
  // Ownership: the conversation must belong to the caller's widget session
  // (review C1 — conversationId alone is a weak bearer token).
  const state = await getWidgetThreadState(shopId, conversationId, since, markSeen, sessionIdParam);
  if (!state) {
    return new Response("not found", { status: 404 });
  }

  return Response.json(state, { headers: { "Cache-Control": "no-store" } });
};
