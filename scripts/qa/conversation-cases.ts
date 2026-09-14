/* Multi-turn conversation cases for scripts/qa/conversations.test.ts.
 *
 * Every case is a REAL conversation a shopper had on jgw-check.myshopify.com
 * (2026-09-14 review), replayed turn by turn. Expectations describe what a good
 * sales assistant does — NOT what the pipeline did at the time — and assert only
 * what the shopper sees (reply text, cards, handover), never internal lane names,
 * so the same cases measure the current pipeline and any redesign of it.
 *
 * Product facts used below were read from the catalogue on 2026-09-14:
 *   Black Obsidian Bracelet For Evil Eye Protection — ₹1,499, tags For Her/For Him, "unisex"
 *   Pyrite Bracelet For Money Attraction…            — ₹1,499, For Her/For Him, "unisex"
 *   Self-Charging Abundance Bracelet for Ruling No - 9 — ₹1,199, For Him, "unisex"
 *   Howlite Bracelet For Anti-Stress & Calming Energy — ₹1,499
 *   Amethyst Bracelet for Calming Mind & Peace        — ₹1,499
 *   Active discounts include sk10 (10% off), sk20, off5, freeship, Buy 1 Get 1.
 * If the catalogue changes, update the facts here, not the runner.
 *
 * `tag` separates what the pipeline controls ("pipeline") from what depends on
 * the merchant's own configuration ("data" — e.g. which products a rule pins).
 */

export interface TurnExpect {
  /** At least one card title matches. */
  cardsInclude?: RegExp;
  /** Every card title matches (zero cards also passes — pair with cardsInclude to require one). */
  cardsOnly?: RegExp;
  /** No card title matches. */
  cardsExclude?: RegExp;
  /** The reply shows no cards. */
  noCards?: boolean;
  replyIncludes?: RegExp;
  replyExcludes?: RegExp;
  /** Not the "I'm not sure — leave your email" / clarify dead end. */
  notFallback?: boolean;
  /** Not refused as a banned topic. */
  notBlocked?: boolean;
  /** No handover frame this turn. */
  noHandover?: boolean;
  /** Plain-English rubric for the LLM judge (skipped with --no-judge). */
  judge?: string;
}

export interface ConversationTurn {
  shopper: string;
  expect?: TurnExpect;
}

export interface ConversationCase {
  id: string;
  /** Where the conversation came from. */
  source: string;
  tag: "pipeline" | "data";
  turns: ConversationTurn[];
}

const OBSIDIAN = /Black Obsidian/i;

export const CONVERSATION_CASES: ConversationCase[] = [
  {
    id: "evil-eye-followups",
    source: "jgw-check 11:58 — follow-ups about the product on screen showed other products",
    tag: "pipeline",
    turns: [
      { shopper: "hi" },
      {
        shopper: "do you have evil eye protection bracelet",
        expect: { cardsInclude: OBSIDIAN },
      },
      {
        shopper: "when to wear this",
        expect: {
          cardsOnly: OBSIDIAN,
          notFallback: true,
          judge:
            "The shopper means the Black Obsidian evil-eye bracelet shown just before. The reply must be about THAT bracelet (when/how to wear it, or honestly say the details are not listed) and must not recommend or show other products.",
        },
      },
      {
        shopper: "tell me the prices of evil eye protection bracelet",
        expect: {
          cardsOnly: OBSIDIAN,
          replyIncludes: /1,?499/,
          replyExcludes: /pyrite|amber|amethyst|citrine/i,
          judge: "The reply must give the Black Obsidian Bracelet For Evil Eye Protection's price, ₹1,499, and must not quote prices of other products.",
        },
      },
      {
        shopper: "is it unisex",
        expect: {
          notFallback: true,
          replyIncludes: /unisex|men and women|both|him and her|anyone|everyone/i,
          judge: "The Black Obsidian bracelet is unisex (tagged For Her and For Him). The reply must say it suits both men and women.",
        },
      },
    ],
  },
  {
    id: "male-recommendations",
    source: "jgw-check 11:58 — 'for male' matched nothing and showed arbitrary bracelets",
    tag: "pipeline",
    turns: [
      {
        shopper: "show me some recomanded products for male",
        expect: {
          cardsExclude: /women'?s|lipstick|nail polish|kajal/i,
          judge:
            "The shopper is a man asking for recommendations. The cards and reply must be products suitable for men (unisex or men's items). The reply must not offer product types that are not shown.",
        },
      },
      {
        shopper: "tell me more about the blue bracelet",
        expect: {
          cardsOnly: /Blue Apatite/i,
          judge: "The reply must describe the Blue Apatite bracelet from the previous cards, and no other product.",
        },
      },
    ],
  },
  {
    id: "pyrite-gender",
    source: "jgw-check 11:22 — gender question about the product being discussed",
    tag: "pipeline",
    turns: [
      { shopper: "suggest me some trending bracelets", expect: { cardsInclude: /bracelet/i } },
      {
        shopper: "more details about pyrite bracelet",
        expect: {
          cardsOnly: /Pyrite Bracelet/i,
          judge: "The reply must describe the Pyrite Bracelet shown in the previous cards, and no other product.",
        },
      },
      {
        shopper: "is it for mens or women ?",
        expect: {
          notFallback: true,
          noHandover: true,
          replyIncludes: /unisex|both|men and women|him and her|anyone|everyone/i,
          judge: "The Pyrite Bracelet is unisex. The reply must say it suits both men and women.",
        },
      },
    ],
  },
  {
    id: "stress-then-ruling-9",
    source: "jgw-check 08:48 — wrong stress picks, wrong price, gender fallback, discounts blocked",
    tag: "pipeline",
    turns: [
      { shopper: "hi" },
      {
        shopper: "i need bracelet which helps reducing stress level",
        expect: {
          cardsInclude: /Howlite|Anti-Stress|Amethyst Bracelet for Calming/i,
          cardsExclude: /Ruling No/i,
          judge: "The cards must be bracelets meant for stress relief or calm (e.g. Howlite Anti-Stress, Amethyst Calming Mind). The reply must not name products that are not shown.",
        },
      },
      {
        shopper: "my ruling no. is 9 can you suggest me bracelet for that specifically",
        expect: {
          cardsInclude: /Ruling No - 9/i,
          cardsExclude: /Ruling No - [1-8]\b/i,
          replyExcludes: /\b(two|both|these two)\b/i,
        },
      },
      {
        shopper: "i need to know more about this item",
        expect: {
          cardsOnly: /Ruling No - 9/i,
          judge: "The reply must describe the Self-Charging Abundance Bracelet for Ruling No - 9 and no other product.",
        },
      },
      {
        shopper: "what is the price of this",
        expect: {
          cardsOnly: /Ruling No - 9/i,
          replyIncludes: /1,?199/,
          replyExcludes: /Ruling (?:No|Number)\.?\s*-?\s*[1-8]\b|1,?499/i,
          judge: "The reply must state the Ruling No - 9 bracelet's price, ₹1,199, and nothing about other products.",
        },
      },
      {
        shopper: "is it specifically for womens or even for mens ?",
        expect: {
          notFallback: true,
          replyIncludes: /unisex|both|men and women|him|men/i,
          judge: "The Ruling No - 9 bracelet is unisex (tagged For Him, described as unisex). The reply must say men can wear it.",
        },
      },
      {
        shopper: "size of the current bracelet",
        expect: {
          notFallback: true,
          replyIncludes: /\d(?:\.\d)?\s*(?:inch|in\b|")|size/i,
          // The store's own data disagrees: the variants are 6.5 / 7.5 / 8.5 in,
          // the description says "6.5, 7, and 7.5". Either is grounded.
          judge:
            "The reply must give the sizes of the Ruling No - 9 bracelet. Its variants are Female 6.5 in, Male 7.5 in, Extra Large 8.5 in (its description also says 6.5, 7 and 7.5) — either set is correct.",
        },
      },
      {
        shopper: "currently do you have any offer running",
        expect: {
          notBlocked: true,
          notFallback: true,
          replyIncludes: /sk10|sk20|off5|freeship|buy 1|% off|free shipping/i,
          judge: "The store has active discounts (e.g. code sk10 for 10% off, sk20, free shipping, Buy 1 Get 1). The reply must name at least one real current offer.",
        },
      },
      {
        shopper: "i am asking about the discount currently available on your store",
        expect: {
          notBlocked: true,
          replyIncludes: /sk10|sk20|off5|freeship|buy 1|% off|free shipping/i,
        },
      },
    ],
  },
  {
    id: "ruling-9-for-men",
    source: "jgw-check 10:56 — 'is this for men' answered about a women's amethyst bracelet",
    tag: "pipeline",
    turns: [
      { shopper: "hi" },
      {
        shopper: "my ruling no. is 9, i need bracelet for that",
        expect: { cardsInclude: /Ruling No - 9/i, cardsExclude: /Ruling No - [1-8]\b/i },
      },
      {
        shopper: "is this product for men ?",
        expect: {
          notFallback: true,
          cardsOnly: /Ruling No - 9/i,
          replyExcludes: /amethyst|women'?s bracelet/i,
          judge: "The shopper means the Ruling No - 9 bracelet just shown, which is unisex and tagged For Him. The reply must say yes, men can wear it, and must not talk about other products.",
        },
      },
      {
        shopper: "for man",
        expect: {
          cardsExclude: /face wash|hair wax|beard|lipstick|women'?s/i,
          judge: "The shopper confirms they are a man. Any products shown must be bracelets suitable for men; grooming products are not what they asked for.",
        },
      },
      { shopper: "bracelet for evil eye protection", expect: { cardsInclude: OBSIDIAN } },
      {
        shopper: "more details about this",
        expect: { cardsOnly: OBSIDIAN, judge: "The reply must describe the Black Obsidian bracelet and no other product." },
      },
      {
        shopper: "good time to wear this",
        expect: {
          cardsOnly: OBSIDIAN,
          replyExcludes: /citrine|amethyst|pyrite/i,
          judge: "The reply must be about when to wear the Black Obsidian bracelet (or honestly say it is not listed) and must not talk about other products.",
        },
      },
    ],
  },
  {
    id: "wear-this",
    source: "jgw-check 11:05 — 'how to wear this' fell back to leave-your-email",
    tag: "pipeline",
    turns: [
      { shopper: "i need bracelet for evil eye protection", expect: { cardsInclude: OBSIDIAN } },
      {
        shopper: "how to wear this",
        expect: {
          notFallback: true,
          cardsOnly: OBSIDIAN,
          judge: "The reply must be about wearing the Black Obsidian bracelet (from its product data, or honestly say it is not listed) and must not show other products.",
        },
      },
    ],
  },
  {
    id: "repeat-after-handover",
    source: "jgw-check 07:47 — the same question kept re-triggering the handover",
    tag: "pipeline",
    turns: [
      { shopper: "¿Cuál es su política de devoluciones?", expect: { replyIncludes: /devoluci|política|nuestr/i } },
      { shopper: "¿Cuál es su política de devoluciones?" },
      { shopper: "¿Cuál es su política de devoluciones?" },
      { shopper: "¿Cuál es su política de devoluciones?", expect: { noHandover: true } },
      { shopper: "¿Cuál es su política de devoluciones?", expect: { noHandover: true } },
    ],
  },
  {
    id: "not-carried",
    source: "jgw-check 07:48 — product the store does not sell",
    tag: "pipeline",
    turns: [
      {
        shopper: "Do you sell helicopters?",
        expect: {
          noCards: true,
          judge: "The store sells crystal bracelets and cosmetics, not helicopters. The reply must say plainly that the store does not carry them (optionally offering to help with what it does sell), without inventing products.",
        },
      },
    ],
  },
  {
    id: "best-sellers",
    source: "jgw-check 06:53 — the Best sellers rule pins cosmetics on a bracelet storefront",
    tag: "data",
    turns: [
      {
        shopper: "What are your best sellers?",
        expect: { cardsInclude: /bracelet/i, cardsExclude: /aranya|body wash|beard|exfoliant/i },
      },
    ],
  },
  {
    id: "return-policy",
    source: "jgw-check 07:47 — the only return-policy knowledge is 'check our policy page'",
    tag: "data",
    turns: [
      {
        shopper: "What is your return policy?",
        expect: {
          noHandover: true,
          judge: "The reply must state the store's actual return rules (e.g. a return window or conditions). Only pointing to 'the policy page' is a fail.",
        },
      },
    ],
  },
];
