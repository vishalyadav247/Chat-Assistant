// Client-safe constants for Admin → Debug recording (QA-C3). They live here,
// not in turn-tracing.server.ts, because the Debug page's component imports
// them — a `.server` import from route UI code fails the build.

export const TRACE_DURATION_HOURS = [1, 4, 24] as const;
export const DEFAULT_TRACE_HOURS = 4;
export const MAX_TRACE_SHOPS = 20;
