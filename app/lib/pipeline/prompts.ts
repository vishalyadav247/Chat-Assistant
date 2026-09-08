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
  "keywords = 1 to 4 product words when intent is buy, otherwise an empty array. Write keywords in English even when the message is in another language.",
  "Set blocked = true and blocked_reason = the matching topic copied from the list ONLY if the message is about one of the store's BANNED TOPICS listed below. Judge by MEANING and handle negation. Asking for products for a purpose (for stress, for sleep, for a gift) is a product request, not a banned topic; block only when the shopper asks for advice or information about the banned topic itself.",
  "Set off_topic = true and off_topic_reason = the topic if the message is unrelated to the STORE SCOPE listed below (a different domain/industry), even if it is harmless. Greetings and small talk are NOT off_topic.",
].join(" ");

export const SUMMARY_SYSTEM =
  "Summarize the earlier conversation in 2-3 short sentences. Keep the shopper's needs, budget, sizes, and any products or topics discussed. Be concise and factual.";

/**
 * The summarizer's user turn, folding the summary it produced last time into
 * the one it produces now.
 *
 * Tuning event 2026-09-04. Refreshes used to re-summarize only the messages
 * still inside the 50-row lookback, from scratch — so on a long thread the
 * opening (which is where the shopper says what they are actually shopping
 * for) fell out of the window and out of the summary at the same time, and the
 * agent quietly forgot it. Folding makes the summary cumulative: what it
 * already knew survives even after the messages that taught it are gone.
 */
export function summaryUser(prior: string, transcript: string): string {
  if (!prior.trim()) return transcript;
  return [
    "What you already knew about this conversation:",
    prior.trim(),
    "",
    "Newer messages:",
    transcript,
    "",
    "Write ONE updated summary covering both. Keep facts from the first part that the newer messages do not contradict — they came from messages you can no longer see.",
  ].join("\n");
}

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

// Product-detail lane (2026-09-07, production behaviour report). A shopper who
// asks about a product they were just shown must be told about THAT product —
// not handed a fresh set of recommendations. The lane is additive: it only runs
// when this conversation has already shown cards, so nothing that reaches
// PRODUCT_RECOMMEND today changes path.
export const DETAIL_CONFIRM_SYSTEM = "Reply with only yes or no.";

/**
 * The buy/detail boundary, drawn deliberately narrow.
 *
 * The first version asked only "is this about a product above, rather than a
 * request for different products?" — and the golden set caught what that lets
 * through: after "show me some jackets" → "under $100", the follow-up "the
 * waterproof one?" was classified as a detail question. It is not. The shopper
 * is CHOOSING among what they were shown, which is still browsing, and the buy
 * lane's tuned selection behaviour must keep it.
 *
 * So the yes case is facts about a settled product, and narrowing, comparing
 * and picking are all explicitly no. The lane exists for "what is it made of",
 * not for "which one".
 */
export function detailConfirmUser(msg: string, shownTitles: string[]): string {
  return [
    "Products already shown to this shopper:",
    shownTitles.map((t, i) => `${i + 1}. ${t}`).join("\n"),
    "",
    `Shopper's message: ${msg}`,
    "",
    "Answer yes ONLY if the shopper is asking for FACTS about one of the products",
    "above: what it is made of, its size or dimensions, what is included, how it",
    "works, care or cleaning, ingredients, compatibility, or its warranty.",
    "",
    "Answer no if the shopper is choosing between the products, narrowing by an",
    "attribute, asking to see one of them, asking for something different, cheaper",
    "or additional, or starting a new search. Those are all still browsing.",
  ].join("\n");
}

export const PRODUCT_DETAIL = [
  "The shopper is asking about a product they have already been shown. Answer about THAT product only.",
  "Use ONLY the product data below. Never invent a material, measurement, ingredient, certification, delivery time or discount. If the data does not say, say plainly that it is not listed and offer to check with the team.",
  "Your FIRST line must be exactly `DETAIL: <id>` — the one product you are answering about (example: `DETAIL: 2`). If you genuinely cannot tell which one they mean, use `DETAIL: none` and your reply must ask which one.",
  "Then answer in 1-4 short sentences. Lead with the specific thing they asked for. Add only the specifications that bear on their question — do not recite the whole record.",
  "Do NOT recommend, mention, compare or suggest any other product. The shopper did not ask to browse. Offering alternatives here reads as a sales pitch over an unanswered question.",
  "The shopper sees the product card next to your reply, so do not repeat its name or price.",
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

/** Human names for the persona language codes (spec 08 select — save.server LANGUAGES). */
const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  hi: "Hindi",
  es: "Spanish",
  fr: "French",
  de: "German",
};

// Reply language (spec 08, enforcement built 2026-09-03). The settings had
// existed since feature 08, but nothing at generation time read them — so the
// model followed the language of the (English) system prompt and store data
// and only mirrored a non-English shopper once enough foreign-language history
// accumulated. One line appended to the persona prompt for every generation
// lane fixes both the first message and mid-chat switches. Available on every
// plan (multi_language un-gated 2026-09-03, user decision).
export function languageInstruction(
  persona: { defaultLanguage: string; autoDetectLanguage: boolean } | null,
): string {
  if (!persona) return "";
  const fallback = LANGUAGE_NAMES[persona.defaultLanguage] ?? "English";
  if (persona.autoDetectLanguage) {
    return `Always reply in the language of the shopper's LATEST message — even when earlier messages, the store information or the product details are in a different language — and switch immediately when the shopper switches. If the language is unclear, reply in ${fallback}.`;
  }
  // "Reply in English." alone loses to the model's mirroring instinct when the
  // shopper writes another language — it must be explicit about that case.
  return `Reply ONLY in ${fallback}, no matter which language the shopper writes in.`;
}
