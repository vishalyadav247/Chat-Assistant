import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";
import { authenticate } from "../shopify.server";
import { resolveShopId } from "../lib/tenancy.server";
import { runPipeline } from "../lib/pipeline/index.server";
import { pageContextSchema } from "../lib/widget/page-context.server";
import { sseResponse } from "../lib/sse.server";

// Storefront chat endpoint (POST /apps/chatconvert/chat → SSE stream).
// Widget reads response.body via fetch-stream (POST carries the message body;
// EventSource is GET-only). Shop identity comes ONLY from the verified proxy
// signature — never from the client payload.

const bodySchema = z.object({
  sessionId: z.string().min(8).max(64),
  conversationId: z.string().max(64).optional(),
  message: z.string().min(1).max(2000), // input bound per spec 03
  // Malformed context degrades to none — never fail the chat turn over it.
  pageContext: pageContextSchema.optional().catch(undefined),
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
  const frames = runPipeline({
    shopId,
    sessionId: parsed.data.sessionId,
    conversationId: parsed.data.conversationId,
    message: parsed.data.message,
    pageContext: parsed.data.pageContext,
    userAgent: request.headers.get("user-agent")?.slice(0, 300) ?? undefined,
  });

  return sseResponse(frames, request.signal);
};
