import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";
import { runPipeline, type PipelineFrame } from "../lib/pipeline/index.server";
import { createTrace, type Trace } from "../lib/pipeline/trace.server";
import { sseResponse } from "../lib/sse.server";
import { requireShopAccess } from "../lib/access.server";

// Test AI streaming endpoint (spec 08): POST /api/test-chat → SSE stream of
// the SAME pipeline frames the storefront gets (proxy.chat.tsx), but behind
// authenticate.admin and with isTest: true — Test AI conversations never tick
// the usage meter (usage.server.ts tickConversation returns noTick() when
// isTest) and are flagged isTest on the Conversation row so analytics can
// exclude them. App Bridge patches fetch in the embedded admin, so the
// session token rides along automatically.
//
// This endpoint is ALSO the only one that collects a turn trace: the merchant
// console needs to see which layer decided the reply and on what evidence
// (trace.server.ts). The storefront path passes no trace and pays nothing.

const bodySchema = z.object({
  // Client-generated, persisted per console session; reset issues a new one.
  sessionId: z.string().regex(/^test-[A-Za-z0-9_-]{6,60}$/),
  conversationId: z.string().max(64).optional(),
  message: z.string().min(1).max(2000),
});

/** Append the collected trace after the pipeline's own frames. It rides behind
 *  "done" on purpose: the console renders the reply the instant it is ready and
 *  fills the inspector a tick later, so tracing never delays a token. */
async function* withTrace(
  frames: AsyncIterable<PipelineFrame>,
  trace: Trace,
): AsyncIterable<PipelineFrame> {
  for await (const frame of frames) yield frame;
  yield { type: "trace", steps: trace.steps(), summary: trace.summary() };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shopId } = await requireShopAccess(request, { permission: "ai_agent" });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return new Response("bad request", { status: 400 });
  }
  const trace = createTrace(true);
  const frames = runPipeline(
    {
      shopId,
      sessionId: parsed.data.sessionId,
      conversationId: parsed.data.conversationId,
      message: parsed.data.message,
      isTest: true,
    },
    trace,
  );

  return sseResponse(withTrace(frames, trace), request.signal);
};
