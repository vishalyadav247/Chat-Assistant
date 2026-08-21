// Client-safe constants for the platform usage views (spec 19). Kept out of
// usage-report.server.ts so route components can import them without dragging
// the DB layer into the browser bundle.

export const RANGE_DAYS = [7, 30, 90] as const;
export type RangeDays = (typeof RANGE_DAYS)[number];

export const PURPOSE_LABELS: Record<string, string> = {
  router: "Intent routing",
  reply: "Replies",
  summary: "Conversation summaries",
  moderation: "Moderation",
  embedding: "Embeddings (sync + ingestion)",
};
