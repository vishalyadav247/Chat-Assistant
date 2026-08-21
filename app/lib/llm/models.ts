// The chat models the platform console offers (spec 19). Client-safe: pure
// data, imported by the settings UI and by the compatibility check script.
//
// Every entry here MUST be request-compatible with app/lib/llm/openai.server.ts
// and priced in app/lib/platform/llm-pricing.ts, so picking any of them from
// the dropdown works with no code change. Reasoning models (o-series, gpt-5)
// are deliberately absent: the provider can now talk to them, but they reject
// sampling params, cost up to ~13x more on output, and are markedly slower —
// a poor fit for a streaming storefront chat widget.
//
// Imports below are pure (no DB, no SDK) so this file stays client-safe.

import { isReasoningModel } from "./model-compat";
import { priceFor } from "../platform/llm-pricing";

export interface ChatModelOption {
  id: string;
  label: string;
  /** Shown under the picker so the cost trade-off is visible at the point of choice. */
  note: string;
}

export const CHAT_MODEL_OPTIONS: ChatModelOption[] = [
  { id: "gpt-4o-mini", label: "gpt-4o-mini", note: "Current default. Cheapest, and the only model verified 16/16 on the golden set." },
  { id: "gpt-4.1-nano", label: "gpt-4.1-nano", note: "Cheaper than 4o-mini on input; smallest of the 4.1 family." },
  { id: "gpt-4.1-mini", label: "gpt-4.1-mini", note: "~2.7x the cost of 4o-mini. Scored 15/16 — misroutes one follow-up (decisions log)." },
  { id: "gpt-4o", label: "gpt-4o", note: "Stronger, ~17x the output cost of 4o-mini." },
  { id: "gpt-4.1", label: "gpt-4.1", note: "Strongest of the family, ~13x the output cost of 4o-mini." },
];

export const CHAT_MODEL_IDS = CHAT_MODEL_OPTIONS.map((m) => m.id);

// ── "Custom…" model ids ─────────────────────────────────────────────────────
// The free-text field at /platform/ai used to accept ANY string, so a typo or
// a pasted sentence became every tenant's chat model and only showed up as a
// 400 in the widget (and as "unpriced" rows in /platform/usage). Two gates,
// both pure so the route and the check script share them:
//   chatModelError()   — refuse to save (it cannot be a model id)
//   chatModelWarning() — save, but say plainly what will be off

/** OpenAI model ids: alphanumeric plus `. _ - :`, no spaces. */
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{1,99}$/;

/** Hard validation. Non-null = refuse the save. */
export function chatModelError(id: string): string | null {
  const value = id.trim();
  if (value === "") return null; // blank = "use the environment default"
  if (!MODEL_ID.test(value)) {
    return "Model id may only contain letters, numbers and . _ - : (no spaces), 2–100 characters.";
  }
  return null;
}

/**
 * Soft validation. Non-null = save it, but surface this. Kept separate from
 * the hard gate because OpenAI ships model ids faster than this repo does —
 * blocking an unknown id would make the escape hatch useless.
 */
export function chatModelWarning(id: string): string | null {
  const value = id.trim();
  if (value === "" || CHAT_MODEL_IDS.includes(value)) return null;
  const notes: string[] = [];
  if (priceFor(value) === null) {
    notes.push(
      `"${value}" is not in the price table, so its usage will show as unpriced (0 cost) on the Usage page until llm-pricing.ts is updated`,
    );
  }
  if (isReasoningModel(value)) {
    notes.push(
      `"${value}" is a reasoning model: sampling params are dropped, replies are slower, and part of every completion budget is spent on hidden reasoning — not recommended for a streaming storefront widget`,
    );
  }
  if (notes.length === 0) {
    notes.push(`"${value}" is not one of the verified models — run \`npm run eval:golden\` before leaving it live`);
  }
  return `${notes.join(". ")}.`;
}
