import { AsyncLocalStorage } from "node:async_hooks";
import db from "../../db.server";
import { logError } from "../log.server";
import type { ChatMessage } from "../llm/types";
import type { Trace } from "./trace.server";
import type { PipelineFrame } from "./index.server";

// Turn capture (Admin → Debug, 2026-09-14). Records REAL storefront turns —
// shopper message, reply, decision trail and the EXACT prompts sent to the
// LLM — so the pipeline can be debugged against real conversations instead of
// re-typed guesses in `npm run trace`.
//
// Design constraints, in order:
//   1. NEVER breaks a reply. Every write is fire-and-forget inside try/catch.
//   2. Costs nothing while the operator switch is off (the default): the
//      proxy passes the usual TimingTrace and none of this module runs.
//   3. The prompt is captured at the ONE seam every call crosses — the LLM
//      provider (app/lib/llm/index.server.ts) — via AsyncLocalStorage, so the
//      10 call sites in the pipeline needed no changes and future call sites
//      are captured automatically.
//
// Size discipline (the payload is a debugging aid, not a log sink):
//   - each prompt message keeps up to PROMPT_CHAR_CAP chars (the decision
//     trail's own strings are already capped at 400 by trace.server.ts);
//   - a whole row is capped at PAYLOAD_BYTE_CAP; when over, LLM responses are
//     dropped first, then step details — prompts are the LAST thing trimmed,
//     because they are the reason this exists.

const PROMPT_CHAR_CAP = 6_000;
const RESPONSE_CHAR_CAP = 4_000;
const MAX_LLM_CALLS = 12;
const MAX_PROMPT_MESSAGES = 40;
const PAYLOAD_BYTE_CAP = 32 * 1024;
const TEXT_CAP = 2_000;

export interface CapturedLlmCall {
  purpose: string;
  messages: { role: string; content: string }[];
  response: string;
  atMs: number;
}

export class TurnCollector {
  private readonly startedAt = Date.now();
  readonly calls: CapturedLlmCall[] = [];

  record(purpose: string, messages: ChatMessage[]): CapturedLlmCall | null {
    try {
      if (this.calls.length >= MAX_LLM_CALLS) return null;
      const call: CapturedLlmCall = {
        purpose,
        messages: messages.slice(0, MAX_PROMPT_MESSAGES).map((m) => ({
          role: m.role,
          content:
            m.content.length > PROMPT_CHAR_CAP
              ? `${m.content.slice(0, PROMPT_CHAR_CAP)}… [+${m.content.length - PROMPT_CHAR_CAP} chars]`
              : m.content,
        })),
        response: "",
        atMs: Date.now() - this.startedAt,
      };
      this.calls.push(call);
      return call;
    } catch {
      return null; // capture must never break the call it observes
    }
  }

  /** Append (streamed) response text to a recorded call, up to the cap. */
  appendResponse(call: CapturedLlmCall | null, text: string): void {
    if (!call || !text) return;
    const room = RESPONSE_CHAR_CAP - call.response.length;
    if (room > 0) call.response += text.slice(0, room);
  }
}

const storage = new AsyncLocalStorage<TurnCollector>();

/** The active collector, when this turn is being recorded (else undefined). */
export function activeTurnCollector(): TurnCollector | undefined {
  return storage.getStore();
}

/**
 * Wrap the pipeline's frame stream so that (a) every await between yields runs
 * inside the collector's ALS context — which is what lets the LLM provider see
 * it — and (b) the finished turn is persisted after the `done` frame.
 * Frames pass through untouched; a capture failure never reaches the shopper.
 */
export async function* observeTurn(args: {
  shopId: string;
  shopperText: string;
  frames: AsyncIterable<PipelineFrame>;
  trace: Trace;
  collector: TurnCollector;
}): AsyncIterable<PipelineFrame> {
  const { shopId, frames, trace, collector } = args;
  let replyText = "";
  let outcome = "";
  let conversationId = "";
  const iterator = frames[Symbol.asyncIterator]();
  try {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const result = await storage.run(collector, () => iterator.next());
      if (result.done) break;
      const frame = result.value;
      try {
        if (frame.type === "token") replyText += frame.text;
        else if (frame.type === "message") replyText += (replyText ? "\n" : "") + frame.text;
        else if (frame.type === "done") {
          outcome = frame.outcome;
          conversationId = frame.conversationId;
        }
      } catch {
        // observation only — never interfere with the stream
      }
      yield frame;
    }
  } finally {
    void saveTurnTrace({
      shopId,
      conversationId,
      shopperText: args.shopperText,
      replyText,
      outcome,
      trace,
      collector,
    }).catch((error: unknown) => logError("turn_trace_save_error", error, { shopId }));
  }
}

async function saveTurnTrace(args: {
  shopId: string;
  conversationId: string;
  shopperText: string;
  replyText: string;
  outcome: string;
  trace: Trace;
  collector: TurnCollector;
}): Promise<void> {
  // No conversation, no row (QA-C4): a turn that never resolved one
  // (rate-limited, bad request) would hold shopper text that customers/redact
  // can never reach, because redact finds traces through conversations.
  if (!args.conversationId) return;
  // Saved fire-and-forget AFTER the turn, so an erasure can land in between.
  // Re-check right before the insert: the shop still installed and the
  // conversation still present (customer redact deletes it). The nightly
  // purgeTurnTraces sweep is the backstop for the remaining race.
  const [shop, conversation] = await Promise.all([
    db.shop.findUnique({ where: { id: args.shopId }, select: { uninstalledAt: true } }),
    db.conversation.findFirst({
      where: { id: args.conversationId, shopId: args.shopId },
      select: { id: true },
    }),
  ]);
  if (!shop || shop.uninstalledAt || !conversation) return;

  const payload: Record<string, unknown> = {
    steps: args.trace.steps(),
    summary: args.trace.summary(),
    llmCalls: args.collector.calls,
  };

  // Stay under the row cap: drop responses first, then step details —
  // prompts go last (they are the point of the feature).
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf-8");
  if (bytes(payload) > PAYLOAD_BYTE_CAP) {
    payload.llmCalls = args.collector.calls.map((c) => ({ ...c, response: "[trimmed]" }));
  }
  if (bytes(payload) > PAYLOAD_BYTE_CAP) {
    payload.steps = args.trace
      .steps()
      .map(({ detail: _detail, ...rest }) => ({ ...rest, detail: undefined }));
  }
  while (bytes(payload) > PAYLOAD_BYTE_CAP && (payload.llmCalls as CapturedLlmCall[]).length > 0) {
    // Oldest calls go first — the final reply prompt is the most useful one.
    payload.llmCalls = (payload.llmCalls as CapturedLlmCall[]).slice(1);
    payload.trimmed = true;
  }

  await db.turnTrace.create({
    data: {
      shopId: args.shopId,
      conversationId: args.conversationId,
      shopperText: args.shopperText.slice(0, TEXT_CAP),
      replyText: args.replyText.slice(0, TEXT_CAP),
      outcome: args.outcome,
      payload: payload as object,
    },
  });
}
