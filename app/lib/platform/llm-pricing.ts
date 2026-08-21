// LLM price table (spec 19 · platform usage analytics). Client-safe: pure data
// + math, no DB, no secrets — the platform UI formats costs with it.
//
// Maintained IN CODE deliberately (user decision 2026-08-20: no manual price
// entry). Figures are USD per 1M tokens, taken from OpenAI's official pricing
// page (developers.openai.com/api/docs/pricing) on the date below. When OpenAI
// changes prices, update this table — the UI shows the verification date so a
// stale table is visible rather than silently wrong.

export const PRICING_VERIFIED_AT = "2026-08-20";
export const PRICING_SOURCE = "developers.openai.com/api/docs/pricing";

export interface ModelPrice {
  /** USD per 1M input (prompt) tokens. */
  input: number;
  /** USD per 1M cached input tokens (a discounted subset of prompt tokens). */
  cachedInput: number;
  /** USD per 1M output (completion) tokens. 0 for embedding models. */
  output: number;
}

export const MODEL_PRICING: Record<string, ModelPrice> = {
  "gpt-5": { input: 1.25, cachedInput: 0.125, output: 10.0 },
  "gpt-4.1": { input: 2.0, cachedInput: 0.5, output: 8.0 },
  "gpt-4.1-mini": { input: 0.4, cachedInput: 0.1, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, cachedInput: 0.025, output: 0.4 },
  "gpt-4o": { input: 2.5, cachedInput: 1.25, output: 10.0 },
  "gpt-4o-mini": { input: 0.15, cachedInput: 0.075, output: 0.6 },
  "text-embedding-3-small": { input: 0.02, cachedInput: 0.02, output: 0 },
  "text-embedding-3-large": { input: 0.13, cachedInput: 0.13, output: 0 },
  // Moderation is free; listed so its rows price at $0 instead of "unpriced".
  "omni-moderation-latest": { input: 0, cachedInput: 0, output: 0 },
};

/**
 * Price for a model id. Dated snapshots (`gpt-4o-mini-2024-07-18`) resolve to
 * their base model via longest-prefix match. null = unknown model, which the UI
 * surfaces as "unpriced" rather than pretending the cost is $0.
 */
export function priceFor(model: string): ModelPrice | null {
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];
  let best: string | null = null;
  for (const known of Object.keys(MODEL_PRICING)) {
    if (model.startsWith(known) && (best === null || known.length > best.length)) {
      best = known;
    }
  }
  return best ? MODEL_PRICING[best] : null;
}

export interface TokenCounts {
  model: string;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
}

/** USD cost of one usage row. null when the model isn't in the table. */
export function costOf(row: TokenCounts): number | null {
  const price = priceFor(row.model);
  if (!price) return null;
  const cached = Math.min(row.cachedTokens, row.promptTokens);
  const fresh = row.promptTokens - cached;
  return (
    (fresh * price.input + cached * price.cachedInput + row.completionTokens * price.output) / 1_000_000
  );
}

/** Sum of costs; `unpriced` counts rows whose model has no entry. */
export function totalCost(rows: TokenCounts[]): { usd: number; unpriced: number } {
  let usd = 0;
  let unpriced = 0;
  for (const row of rows) {
    const cost = costOf(row);
    if (cost === null) unpriced += 1;
    else usd += cost;
  }
  return { usd, unpriced };
}

/**
 * Money for tables. Sub-cent amounts are REAL at these token volumes, so they
 * are shown with enough precision to be readable rather than rounded to "$0"
 * (which reads as "tracking is broken"):
 *   $0        exact zero — no usage recorded
 *   $0.000018 below a hundredth of a cent
 *   $0.0042   sub-cent
 *   $1.27 / $1,284.50
 */
export function formatUsd(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.0001) return `$${value.toFixed(6)}`;
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1000) return `$${value.toFixed(2)}`;
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

/** Compact token counts: 812 / 24.3K / 5.1M */
export function formatTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}K`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}
