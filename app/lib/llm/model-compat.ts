// OpenAI request-dialect compatibility (spec 19). Pure functions, no DB and no
// SDK — so the provider, the platform UI and the check script can all use them.
//
// OpenAI speaks two dialects and sending the wrong one is a hard 400:
//   - standard chat models (gpt-4o*, gpt-4.1*): `temperature` + `max_tokens`
//   - reasoning models (o1/o3/o4*, gpt-5*): sampling params are REJECTED, and
//     `max_tokens` must be sent as `max_completion_tokens`
// (verified against OpenAI + Azure documentation, 2026-08-20).
//
// GUARANTEE (user requirement 2026-08-20): for the gpt-4 family samplingParams
// returns EXACTLY what the app sent before this layer existed — same keys, same
// values — so behaviour on gpt-4o-mini and friends is unchanged.
// `scripts/model-compat-check.ts` asserts that.

const REASONING_MODEL = /^(o\d|gpt-5)/i;

// `response_format: {type:"json_object"}` is rejected by the first o-series
// preview models. Everything else the app can reach (gpt-4o*, gpt-4.1*, o1,
// o3*, o4*, gpt-5*) accepts it.
const NO_JSON_MODE = /^o1-(preview|mini)/i;

/**
 * Extra completion budget granted to reasoning models (QA 2026-08-21).
 *
 * `max_completion_tokens` bounds hidden reasoning tokens AND visible output.
 * The router asks for ~160 tokens of strict JSON; a reasoning model can burn
 * all 160 on reasoning, return `content: ""` with
 * `finish_reason: "length"`, and the router then silently falls back to the
 * chat lane for every shopper turn. Sending the raw per-call budget to a
 * reasoning model is therefore not "the same request" — it is a broken one.
 *
 * The reserve is added, not substituted, so the caller's intent still scales
 * the visible answer. It costs nothing unless the tokens are actually
 * produced (this is a ceiling, not a purchase).
 */
export const REASONING_RESERVE_TOKENS = 1500;

export function isReasoningModel(model: string): boolean {
  return REASONING_MODEL.test(model.trim());
}

/** False only for models that 400 on `response_format: {type:"json_object"}`. */
export function supportsJsonObject(model: string): boolean {
  return !NO_JSON_MODE.test(model.trim());
}

export function samplingParams(
  model: string,
  temperature: number,
  maxTokens: number,
): Record<string, number> {
  if (isReasoningModel(model)) {
    // Reasoning models fix temperature/top_p internally; sending them errors.
    return { max_completion_tokens: maxTokens + REASONING_RESERVE_TOKENS };
  }
  return { temperature, max_tokens: maxTokens };
}
