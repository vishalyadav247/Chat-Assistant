// Turn trace (Test AI inspector, spec 03 + spec 08). Records every decision the
// runtime pipeline makes — which layer fired, the score it compared against its
// threshold, the rows it retrieved, and the exact payload handed to the model —
// so a merchant can see WHY a reply came out the way it did, not just which
// lane produced it.
//
// Two hard rules, because this sits in the shopper chat hot path:
//   1. NEVER throws — a trace failure must not break a reply.
//   2. Costs nothing when disabled. Storefront turns (proxy.chat.tsx) get the
//      shared noop; only Test AI turns (api.test-chat.tsx) collect.
//
// Nothing here is persisted: the trace rides the SSE stream of the turn that
// produced it and dies with the page. The durable per-reply record stays what
// it was — Message.sourceLayer / intent / productCards.

export type { TraceStatus, TraceStep, TraceSummary } from "./trace-types";
import type { TraceStatus, TraceStep, TraceSummary } from "./trace-types";

export interface Trace {
  readonly enabled: boolean;
  step(
    layer: string,
    label: string,
    status: TraceStatus,
    detail?: Record<string, unknown>,
  ): void;
  /** Count one API call so the summary can show the turn's real cost shape. */
  countLlm(purpose: string): void;
  steps(): TraceStep[];
  summary(): TraceSummary;
}

// Bounds — a trace is a debugging aid streamed to a browser, never a log sink.
const MAX_STRING = 400;
const MAX_ARRAY = 12;
const MAX_STEPS = 80;
const MAX_DEPTH = 4;

function sanitize(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (typeof value === "number") {
    // Cosine scores need precision; wall-clock numbers do not.
    return Number.isFinite(value) ? Math.round(value * 1e4) / 1e4 : null;
  }
  if (typeof value === "boolean") return value;
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) {
    const out: unknown[] = value.slice(0, MAX_ARRAY).map((v) => sanitize(v, depth + 1));
    if (value.length > MAX_ARRAY) out.push(`…+${value.length - MAX_ARRAY} more`);
    return out;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = sanitize(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

class NoopTrace implements Trace {
  readonly enabled = false;
  step(): void {}
  countLlm(): void {}
  steps(): TraceStep[] {
    return [];
  }
  summary(): TraceSummary {
    return { totalMs: 0, llmCalls: 0, embeddingCalls: 0, byPurpose: {} };
  }
}

class LiveTrace implements Trace {
  readonly enabled = true;
  private readonly startedAt = Date.now();
  private lastAt = Date.now();
  private seq = 0;
  private readonly collected: TraceStep[] = [];
  private readonly purposes: Record<string, number> = {};

  step(
    layer: string,
    label: string,
    status: TraceStatus,
    detail?: Record<string, unknown>,
  ): void {
    try {
      if (this.collected.length >= MAX_STEPS) return;
      const now = Date.now();
      this.collected.push({
        seq: ++this.seq,
        layer,
        label,
        status,
        ms: now - this.lastAt,
        atMs: now - this.startedAt,
        detail: detail ? (sanitize(detail) as Record<string, unknown>) : undefined,
      });
      this.lastAt = now;
    } catch {
      // A trace must never break a reply.
    }
  }

  countLlm(purpose: string): void {
    this.purposes[purpose] = (this.purposes[purpose] ?? 0) + 1;
  }

  steps(): TraceStep[] {
    return this.collected;
  }

  summary(): TraceSummary {
    const byPurpose = { ...this.purposes };
    const embeddingCalls = byPurpose.embedding ?? 0;
    const llmCalls = Object.entries(byPurpose)
      .filter(([purpose]) => purpose !== "embedding")
      .reduce((total, [, count]) => total + count, 0);
    return { totalMs: Date.now() - this.startedAt, llmCalls, embeddingCalls, byPurpose };
  }
}

const NOOP = new NoopTrace();

export function createTrace(enabled: boolean): Trace {
  return enabled ? new LiveTrace() : NOOP;
}
