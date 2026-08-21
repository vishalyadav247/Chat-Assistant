// Turn-trace shapes. Client-safe on purpose: pure types, no server imports, so
// the Test AI inspector can type its SSE frames without pulling a .server
// module into the browser bundle. The collector lives in trace.server.ts.

export type TraceStatus =
  /** Layer ran and let the turn continue. */
  | "pass"
  /** Layer matched and decided the turn. */
  | "hit"
  /** Layer ran and found nothing usable. */
  | "miss"
  /** Layer did not run (not configured / disabled). */
  | "skip"
  /** Neutral context — no decision. */
  | "info"
  /** Layer failed; the pipeline degraded around it. */
  | "error";

export interface TraceStep {
  seq: number;
  /** Stable machine key — "curated_match", "router", "product_search"… */
  layer: string;
  label: string;
  status: TraceStatus;
  /** ms since the previous step (≈ this step's own work). */
  ms: number;
  /** ms since the turn began. */
  atMs: number;
  detail?: Record<string, unknown>;
}

export interface TraceSummary {
  totalMs: number;
  /** Generation/router/moderation calls — the billable chat spend this turn. */
  llmCalls: number;
  embeddingCalls: number;
  byPurpose: Record<string, number>;
}
