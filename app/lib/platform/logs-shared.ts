// Client-safe constants for the platform logs view (spec 21). Kept out of
// logs-report.server.ts so the route component can import them without
// dragging the DB layer into the browser bundle.

/** Selectable windows, in hours. Capped at the 14-day retention window. */
export const LOG_RANGE_HOURS = [24, 72, 168, 336] as const;
export type LogRangeHours = (typeof LOG_RANGE_HOURS)[number];

export const RANGE_LABELS: Record<number, string> = {
  24: "24 hours",
  72: "3 days",
  168: "7 days",
  336: "14 days",
};

export const LEVEL_LABELS: Record<string, string> = {
  error: "Error",
  warn: "Warning",
};

/** Newest rows rendered per page load — the table states when it truncated. */
export const ROW_LIMIT = 200;
