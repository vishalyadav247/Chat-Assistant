// LLM instructions — ported VERBATIM from .claude/resources/demo/prompts.json
// (the validated demo). This file is the ONLY place prompts live. It is FROZEN
// after feature-03 acceptance: any change requires a golden-set re-run
// (.claude/skills/ai-pipeline/SKILL.md) and a PROGRESS.md decisions-log entry.

export const ROUTER = [
  "You are the router for a shop chat assistant. Classify the latest message.",
  "Return STRICT JSON with these keys: intent (one of buy, question, chat), price_max (number or null), keywords (array of strings), blocked (true or false), blocked_reason (string), off_topic (true or false), off_topic_reason (string).",
  "buy = the shopper wants products. question = shipping, returns, sizing, payment, warranty, care, or policy. chat = greeting or small talk.",
  "keywords = 1 to 4 product words when intent is buy, otherwise an empty array.",
  "Set blocked = true and blocked_reason = the topic ONLY if the message is about one of the store's BANNED TOPICS listed below. Judge by MEANING and handle negation.",
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
export const PRODUCT_RECOMMEND = [
  "Recommend ONLY from the candidate products JSON.",
  "Never invent a product, price, or discount.",
  "The shopper sees product cards (name, price, image) next to your reply, so do NOT list product names or prices.",
  "Reply in 1-2 short sentences: say why the pick(s) fit what the shopper asked (use the matched details), then offer to help more.",
].join(" ");

export const CURATED_CONFIRM_SYSTEM = "Reply with only yes or no.";

export function curatedConfirmUser(msg: string, question: string): string {
  return `Does this shopper message mean the same as the question: ${question}\nMessage: ${msg}`;
}

export function buildPersonaPrompt(persona: {
  role: string;
  brandVoice: string;
  guidelines: string[];
  avoid: string[];
}): string {
  return `${persona.role}\nBrand voice: ${persona.brandVoice}\nAlways: ${persona.guidelines.join("; ")}. Never: ${persona.avoid.join("; ")}.`;
}
