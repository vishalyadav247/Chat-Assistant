/* The dev-shop curated-answer QA fixtures (spec 09), shared by
 * seed-curated.ts (creates them), scripts/eval-golden.ts (parks the published
 * ones for a run) and preflight.ts (checks they are in their intended state).
 *
 * Fixtures are identified by QUESTION on the dev shop — never by a marker in
 * the talking points. The curated path serves talking points verbatim with
 * zero generation, so the old "[qa-fixture]" suffix reached shoppers (QA-T3),
 * and "republish every tagged draft" also published the draft-on-purpose
 * fixture below. LEGACY_FIXTURE_TAG only exists to clean rows seeded before.
 */

export const DEV_SHOP_DOMAIN = "dev-shop.myshopify.com";
export const LEGACY_FIXTURE_TAG = "[qa-fixture]";


export interface CuratedFixture {
  question: string;
  synonyms: string[];
  products: string[]; // product titles, resolved to shopifyProductId
  talkingPoints: string;
  status: "draft" | "published";
  priority: "low" | "normal" | "high";
}

export const CURATED_FIXTURES: CuratedFixture[] = [
  {
    question: "what is your return policy",
    synonyms: ["how do I return something", "can I send it back", "CAN I SEND IT BACK"],
    products: [],
    talkingPoints: "30 days from delivery.\nItems must be unworn with tags attached.\nRefunds land 5-7 business days after we receive the parcel.",
    status: "published",
    priority: "high",
  },
  {
    question: "how long does shipping take",
    synonyms: ["delivery time", "when will my order arrive", "shipping speed"],
    products: [],
    talkingPoints: "Standard 3-5 business days.\nExpress 1-2 business days.\nCut-off is 2pm local time.",
    status: "published",
    priority: "high",
  },
  {
    // NEAR_MISS pair A1 — deliberately close to "how long does shipping take"
    // but about cost, not time. Should NOT be returned for a timing question.
    question: "how much does shipping cost",
    synonyms: ["shipping fee", "delivery charge", "is shipping free"],
    products: [],
    talkingPoints: "Free over $50.\nFlat $5.95 below that.\nExpress is $12.95.",
    status: "published",
    priority: "normal",
  },
  {
    question: "do you ship internationally",
    synonyms: ["overseas delivery", "international orders", "do you ship outside the US"],
    products: [],
    talkingPoints: "We ship to 40 countries.\nDuties are calculated at checkout.\nInternational delivery is 7-14 business days.",
    status: "published",
    priority: "normal",
  },
  {
    question: "what payment methods do you accept",
    synonyms: ["can I pay with paypal", "do you take apple pay", "payment options"],
    products: [],
    talkingPoints: "All major cards, PayPal, Apple Pay, Google Pay and Shop Pay.\nWe do not accept cheques or bank transfer.",
    status: "published",
    priority: "normal",
  },
  {
    question: "how do I track my order",
    synonyms: ["where is my package", "order status", "tracking number"],
    products: [],
    talkingPoints: "A tracking link is emailed when the parcel ships.\nYou can also use the Track order screen in this chat.",
    status: "published",
    priority: "high",
  },
  {
    question: "what size should I order",
    synonyms: ["sizing help", "size guide", "do your clothes run small"],
    products: ["Cotton Crew T-Shirt", "Down Puffer Jacket"],
    talkingPoints: "Our fit is true to size.\nBetween sizes: size up for outerwear, down for tees.\n<b>Full size chart</b> is linked on every product page.",
    status: "published",
    priority: "normal",
  },
  {
    question: "what do you have for cold weather",
    synonyms: ["winter gear", "warm clothing", "something for the snow"],
    products: ["Fleece Beanie", "Chunky Knit Scarf", "Down Puffer Jacket"],
    talkingPoints: "Layer the beanie and scarf with the puffer.\nThe puffer is rated to -15C.",
    status: "published",
    priority: "normal",
  },
  {
    // NEAR_MISS pair B1 — sits near the seeded "what should I buy for winter".
    // Both are winter intents; the matcher must pick ONE deterministically
    // rather than flip-flopping between them run to run.
    question: "what should I wear when it rains",
    synonyms: ["rain gear", "waterproof options", "wet weather"],
    products: ["Waterproof Rain Jacket", "Compact Travel Umbrella"],
    talkingPoints: "The rain jacket is fully seam-sealed.\nThe umbrella folds to 24cm and fits a bag.",
    status: "published",
    priority: "normal",
  },
  {
    question: "do you offer gift wrapping",
    synonyms: ["gift wrap", "can you wrap it", "gift packaging"],
    products: [],
    talkingPoints: "Gift wrap is $4.50 per item.\nAdd a free handwritten note at checkout.",
    status: "published",
    priority: "low",
  },
  {
    question: "can I change or cancel my order",
    synonyms: ["cancel order", "change my address", "edit my order"],
    products: [],
    talkingPoints: "We can change anything within 60 minutes of ordering.\nAfter that the warehouse has picked it and you'll need to return it.",
    status: "published",
    priority: "high",
  },
  {
    question: "do you have a loyalty program",
    synonyms: ["rewards points", "membership discount", "loyalty scheme"],
    products: [],
    talkingPoints: "Earn 1 point per dollar.\n100 points = $5 off.\nPoints never expire.",
    status: "published",
    priority: "low",
  },
  {
    // Draft on purpose — must NEVER match at runtime (published-only filter).
    question: "when is your black friday sale",
    synonyms: ["holiday sale", "next discount event"],
    products: [],
    talkingPoints: "Not announced yet. Draft answer, should not be served.",
    status: "draft",
    priority: "normal",
  },
  {
    // HTML + script body in talking points — proves sanitizeTalkingPoints
    // strips tags AND drops script/style bodies rather than keeping inner text.
    question: "are your products ethically made",
    synonyms: ["sustainability", "where are your products made", "ethical sourcing"],
    products: [],
    talkingPoints:
      "<p>All factories are audited annually.</p>\n<script>alert('xss')</script>\n<b>Organic cotton</b> where the fabric allows.",
    status: "published",
    priority: "normal",
  },
];

export const PUBLISHED_FIXTURE_QUESTIONS = CURATED_FIXTURES.filter((f) => f.status === "published").map((f) => f.question);
export const DRAFT_FIXTURE_QUESTIONS = CURATED_FIXTURES.filter((f) => f.status === "draft").map((f) => f.question);

/** Remove the legacy marker line from talking points (idempotent). */
export function stripLegacyTag(talkingPoints: string): string {
  return talkingPoints
    .split("\n")
    .filter((line) => line.trim() !== LEGACY_FIXTURE_TAG)
    .join("\n")
    .split(LEGACY_FIXTURE_TAG)
    .join("")
    .trimEnd();
}
