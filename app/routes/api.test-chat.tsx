import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";
import { runPipeline } from "../lib/pipeline/index.server";
import { sseResponse } from "../lib/sse.server";
import { requireShopAccess } from "../lib/access.server";

// Test AI streaming endpoint (spec 08): POST /api/test-chat → SSE stream of
// the SAME pipeline frames the storefront gets (proxy.chat.tsx), but behind
// authenticate.admin and with isTest: true — Test AI conversations never tick
// the usage meter (usage.server.ts tickConversation returns noTick() when
// isTest) and are flagged isTest on the Conversation row so analytics can
// exclude them. App Bridge patches fetch in the embedded admin, so the
// session token rides along automatically.

const bodySchema = z.object({
  // Client-generated, persisted per console session; reset issues a new one.
  sessionId: z.string().regex(/^test-[A-Za-z0-9_-]{6,60}$/),
  conversationId: z.string().max(64).optional(),
  message: z.string().min(1).max(2000),
});

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shopId } = await requireShopAccess(request, { permission: "ai_agent" });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return new Response("bad request", { status: 400 });
  }
  const frames = runPipeline({
    shopId,
    sessionId: parsed.data.sessionId,
    conversationId: parsed.data.conversationId,
    message: parsed.data.message,
    isTest: true,
  });

  return sseResponse(frames, request.signal);
};
