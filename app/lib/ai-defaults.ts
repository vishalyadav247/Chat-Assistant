// Default AI instructions (spec 24). Pure data — imported by install.server.ts
// (seeded once per shop at install) AND by the runtime (used when a field is
// blank or no row exists), so every store starts from the same generic,
// category-neutral instructions and the merchant refines them in
// Instructions → General. Store info is deliberately NOT defaulted: it is
// facts about one store and must come from the merchant.

/** Matches the "Friendly" preset in Instructions → General, so the chip shows selected. */
export const DEFAULT_BRAND_VOICE =
  "Warm, approachable, and enthusiastic tone. Use light-hearted greetings, conversational language, and occasionally emojis to make the customer feel welcome and at ease.";

export const DEFAULT_PERSONA = {
  role: "You are a friendly shopping assistant for this store. You help shoppers find the right products and answer their questions about products, orders and store policies.",
  communicationStyle: "friendly",
  brandVoice: DEFAULT_BRAND_VOICE,
  // Same section headings as the Behaviours placeholder, so the merchant edits
  // a familiar shape. Kept generic: no category, number of cards or policy.
  behaviours: [
    "ROLE:",
    "- Help shoppers find products that fit their needs and answer questions about the store.",
    "",
    "GUIDELINES:",
    "- Understand what the shopper needs before recommending; ask one short question if the request is vague.",
    "- Give a short, honest reason why a product fits.",
    "- When the shopper asks about prices or deals, mention current offers.",
    "- Stay on the shopper's question and keep answers short.",
    "",
    "AVOID:",
    "- Pressuring the shopper to buy.",
    "- Guessing — say when information is not available.",
  ].join("\n"),
  welcomeMessage: "Hi {{customer_name}} 👋 What can I help you find today?",
} as const;

export const DEFAULT_GUARDRAILS = {
  answerOnlyFromKnowledge: true,
  bannedTopics: ["medical advice", "legal advice", "competitor pricing"],
  // Empty on purpose: a blank fallback serves the built-in message translated
  // into the shop's language (canned.server.ts). A merchant-written one wins.
  fallbackMessage: "",
};

/** The English fallback every install before spec 24 stored. Treated as "not
 *  customised" so those shops also get the translated built-in (QA2-A3). */
export const LEGACY_INSTALL_FALLBACK =
  "I'm not sure about that one — leave your email and our team will get back to you.";

/** A persona with blank role / brand voice filled from the defaults. Behaviours
 *  are only defaulted when there is no persona at all — a merchant who cleared
 *  the box meant it. */
export function withPersonaDefaults<
  T extends { role: string; brandVoice: string; behaviours: string },
>(persona: T | null): { role: string; brandVoice: string; behaviours: string } {
  if (!persona) {
    return { role: DEFAULT_PERSONA.role, brandVoice: DEFAULT_PERSONA.brandVoice, behaviours: DEFAULT_PERSONA.behaviours };
  }
  return {
    role: persona.role.trim() || DEFAULT_PERSONA.role,
    brandVoice: persona.brandVoice.trim() || DEFAULT_PERSONA.brandVoice,
    behaviours: persona.behaviours,
  };
}

/** The merchant's fallback text, or "" when it was never customised. */
export function customFallbackMessage(stored: string | null | undefined): string {
  const text = (stored ?? "").trim();
  return text === LEGACY_INSTALL_FALLBACK ? "" : text;
}
