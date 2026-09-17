import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";
import { authenticate } from "../shopify.server";
import { resolveShopId } from "../lib/tenancy.server";
import { runPipeline } from "../lib/pipeline/index.server";
import { pageContextSchema } from "../lib/widget/page-context.server";
import { sseResponse } from "../lib/sse.server";
import { createTimingTrace, createTrace, type TimingTrace } from "../lib/pipeline/trace.server";
import { observeTurn, TurnCollector } from "../lib/pipeline/turn-capture.server";
import { isTracingShop } from "../lib/admin/turn-tracing.server";
import { logWarn } from "../lib/log.server";

// Storefront chat endpoint (POST /apps/chatconvert/chat → SSE stream).
// Widget reads response.body via fetch-stream (POST carries the message body;
// EventSource is GET-only). Shop identity comes ONLY from the verified proxy
// signature — never from the client payload.

const bodySchema = z.object({
  sessionId: z.string().min(8).max(64),
  // Stable per-browser id, so a shopper returning after the 30-minute session
  // rotation is still recognised. Same trust model as sessionId: an opaque
  // client-minted uuid, only ever used to find this shop's own contact row.
  visitorId: z.string().min(8).max(64).optional(),
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
  // Admin → Debug: while the operator records THIS store (per-store allowlist,
  // time-limited, production-locked — QA-C3), run the FULL decision trace and
  // capture the exact LLM prompts; the finished turn persists to turn_traces.
  // The check is a ≤5 s cached read that fails closed; the default path below
  // is byte-for-byte what it always was.
  const recording = await isTracingShop(shopId);
  const timing = createTimingTrace();
  const trace = recording ? createTrace(true) : timing;
  const frames = runPipeline(
    {
      shopId,
      sessionId: parsed.data.sessionId,
      visitorId: parsed.data.visitorId,
      conversationId: parsed.data.conversationId,
      message: parsed.data.message,
      pageContext: parsed.data.pageContext,
      userAgent: request.headers.get("user-agent")?.slice(0, 300) ?? undefined,
    },
    trace,
  );

  const observed = recording
    ? observeTurn({
        shopId,
        shopperText: parsed.data.message,
        frames,
        trace,
        collector: new TurnCollector(),
      })
    : logSlowTurns(frames, timing, shopId);
  return sseResponse(observed, request.signal);
};

/** A turn slower than this is worth a log line naming the stage that ate it. */
const SLOW_TURN_MS = 8_000;

/**
 * Pass the frames through, and when the turn ends report it if it was slow.
 *
 * Until now nothing measured a storefront turn, so "the first message takes too
 * long" could only be answered by timing message rows in the database after the
 * fact. Stage names and milliseconds only — no shopper text ever reaches the
 * log (spec 21 keeps app_logs out of GDPR redact scope), and the rate cap in
 * log.server.ts bounds the volume at 50 rows/hour.
 */
async function* logSlowTurns(
  frames: AsyncIterable<unknown>,
  timing: TimingTrace,
  shopId: string,
): AsyncIterable<unknown> {
  try {
    yield* frames;
  } finally {
    const report = timing.report();
    if (report.totalMs >= SLOW_TURN_MS) {
      logWarn("chat_turn_slow", `chat turn took ${report.totalMs}ms`, { shopId, ...report });
    }
  }
}
