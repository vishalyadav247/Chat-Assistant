// LLM instructions — ported VERBATIM from .claude/resources/demo/prompts.json
// (the validated demo). This file is the ONLY place prompts live. It is FROZEN
// after feature-03 acceptance: any change requires a golden-set re-run
// (.claude/skills/ai-pipeline/SKILL.md) and a PROGRESS.md decisions-log entry.
// Tuning events so far: 2026-08-18 (compact product replies), 2026-09-01
// (router: product asks for a purpose are buy and never a banned topic;
// product replies open with a PICKS line — see PRODUCT_RECOMMEND).

export const ROUTER = [
  "You are the router for a shop chat assistant. Classify the latest message.",
  "Return STRICT JSON with these keys: intent (one of buy, question, chat), price_max (number or null), keywords (array of strings), blocked (true or false), blocked_reason (string), off_topic (true or false), off_topic_reason (string).",
  "buy = the shopper wants products, including asking which product suits a need, purpose, occasion or person. question = shipping, returns, sizing, payment, warranty, care, or policy. chat = greeting or small talk.",
  "keywords = 1 to 4 product words when intent is buy, otherwise an empty array.",
  "Set blocked = true and blocked_reason = the matching topic copied from the list ONLY if the message is about one of the store's BANNED TOPICS listed below. Judge by MEANING and handle negation. Asking for products for a purpose (for stress, for sleep, for a gift) is a product request, not a banned topic; block only when the shopper asks for advice or information about the banned topic itself.",
  "Set off_topic = true and off_topic_reason = the topic if the message is unrelated to the STORE SCOPE listed below (a different domain/industry), even if it is harmless. Greetings and small talk are NOT off_topic.",
].join(" ");

export const SUMMARY_SYSTEM =
  "Summarize the earlier conversation in 2-3 short sentences. Keep the shopper's needs, budget, sizes, and any products or topics discussed. Be concise and factual.";

export const CHAT_REPLY = "Reply in ONE short sentence, no products.";

export const QUESTION_ANSWER =
  "Answer using ONLY the store info below. If it isn't there, say you're not sure and offer support. 1-3 sentences.";

// Tuned 2026-08-18 (user decision, golden re-run): the shopper sees product
// cards (name, price, image) next to the reply, so the text must be compact
// and must not repeat titles/prices — say WHY the picks fit, then offer help.
// Tuned 2026-09-01 (golden re-run): the model now also DECIDES which of the
// grounded candidates fit — first line `PICKS: <ids>` or `PICKS: none`
// (picks.server.ts) — because retrieval alone kept showing bracelets whose
// prose merely mentioned the shopper's words ("pairs with black outfits" for
// "black bracelets"). Cards = the picks, validated against the allow-list in
// code, so text and cards agree by construction.
export const PRODUCT_RECOMMEND = [
  "Recommend ONLY from the candidate products JSON. Never invent a product, price, or discount.",
  "Each candidate has an id. First decide which candidates genuinely ARE what the shopper asked for, from the title, type, tags and the quoted description fragment. Identity words — a colour, stone, material, size, month, number or name — must describe THIS product: in its title/type/tags, or in a fragment about the product itself. A fragment about something else (an outfit to pair with, a crystal to cleanse with, another month) does not count, however often the word appears. Features and purposes (keeps drinks hot, blocks RFID, for stress, a gift) count when the title or fragment states them, and may match by meaning.",
  "Never pad the list: one right product beats four half-fits, and `PICKS: none` is a valid answer. Usually 1-3 picks; list 4 only when the shopper wants to browse several.",
  "Your FIRST line must be exactly `PICKS: <ids>` — only the fitting ids, best first (example: `PICKS: 3, 1`) — or `PICKS: none` if nothing fits.",
  "Then reply to the shopper in 1-2 short sentences: say why the pick(s) fit (use the matched details), then offer to help more. If nothing fits, say so honestly and offer the closest alternative.",
  "The shopper sees product cards (name, price, image) next to your reply, so do NOT repeat product names or prices in your text — say 'this one' or 'these picks'.",
].join(" ");

export const CURATED_CONFIRM_SYSTEM = "Reply with only yes or no.";

export function curatedConfirmUser(msg: string, question: string): string {
  return `Does this shopper message mean the same as the question: ${question}\nMessage: ${msg}`;
}

// Router block confirm (2026-09-01). The router's blocked flag is a one-shot
// judgement inside a crowded JSON task and misfires on ordinary product asks
// ("something that blocks rfid" → "weapons", about one run in three). A blocked
// verdict is re-asked as ONE focused yes/no (3 tokens, temp 0, same shape as
// the borderline-curated confirm) before it is honoured; blocked turns still
// make zero generation calls, so the turn budget is unchanged.
export function blockConfirmUser(msg: string, topic: string): string {
  return `Is this shopper message asking for advice or information about "${topic}" (rather than asking for a product to buy)?\nMessage: ${msg}`;
}

export function buildPersonaPrompt(persona: {
  role: string;
  brandVoice: string;
  guidelines: string[];
  avoid: string[];
}): string {
  return `${persona.role}\nBrand voice: ${persona.brandVoice}\nAlways: ${persona.guidelines.join("; ")}. Never: ${persona.avoid.join("; ")}.`;
}
