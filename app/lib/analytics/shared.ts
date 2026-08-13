// Client-safe analytics types + constants (spec 14). Kept out of
// reports.server.ts so the Analytics* components can import them without
// pulling server-only code into the client bundle (same split as
// dashboard.server.ts types vs DashboardOverview).

export type AnalyticsRange = "7d" | "30d" | "3m" | "12m";

export const ANALYTICS_RANGES: AnalyticsRange[] = ["7d", "30d", "3m", "12m"];

export const ANALYTICS_RANGE_LABELS: Record<AnalyticsRange, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "3m": "Last 3 months",
  "12m": "Last 12 months",
};

export interface SeriesPoint {
  date: string; // yyyy-mm-dd
  ai: number;
  human: number;
}

export interface ResolutionBreakdown {
  total: number;
  resolvedByAiPct: number;
  resolvedByHumanPct: number;
  unresolvedPct: number;
  /** Center label: AI + human together. */
  resolvedPct: number;
}

export interface CsatSummary {
  /** 1-decimal average, null when no responses. */
  avg: number | null;
  responses: number;
  /** Counts for 5★ → 1★ (index 0 = 5 stars). */
  histogram: number[];
}

export interface RecommendationFunnel {
  shown: number;
  atc: number;
  /** DELTA (spec 14): purchase attribution deferred until the orders scope — UI renders "—". */
  purchased: null;
}

export interface ResponsePerformance {
  avgFirstResponseMs: number | null;
  avgResolutionMs: number | null;
  /** % of conversations answered without a fallback turn; null when no conversations. */
  answeredFirstTryPct: number | null;
  handedToHuman: number;
  /** vs the previous equal period; null when the previous period has no data. */
  deltas: {
    firstResponsePct: number | null;
    resolutionPct: number | null;
    answeredFirstTryPts: number | null;
    handedToHuman: number | null;
  };
}

export interface TopQuestion {
  question: string;
  count: number;
  /** Relative bar width, 100 for the top entry. */
  pct: number;
}

/** Humanize a duration for the performance tiles ("4s", "2m 18s", "1h 4m"). */
export function humanizeMs(ms: number | null): string {
  if (ms === null) return "—";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`;
}
