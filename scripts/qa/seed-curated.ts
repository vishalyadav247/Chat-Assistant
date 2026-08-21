/* QA fixture: adds dummy curated answers to the dev shop (spec 09).
 * Run: npx tsx scripts/qa/seed-curated.ts [--reset]
 *
 * Goes through the real saveCuratedAnswer() path so every row gets the same
 * validation, sanitisation, plan-cap check, embedding and analytics event a
 * merchant save would produce. OPENAI_API_KEY is required in practice: a
 * published answer whose embedding is NULL never matches at runtime (the
 * curated matcher filters `embedding IS NOT NULL`).
 *
 * The set is built to EXERCISE the matcher, not just fill the table:
 *   - near-miss pairs (see NEAR_MISS notes) sit either side of the 0.80
 *     curatedMatchThreshold / 0.65 borderline so threshold regressions show up
 *   - a mix of draft/published and low/normal/high priority
 *   - synonyms with duplicate casing to prove dedupeSynonyms()
 *   - talking points containing HTML to prove sanitizeTalkingPoints()
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Load .env manually (tsx does not) BEFORE importing app modules.
for (const line of readFileSync(join(process.cwd(), ".env"), "utf-8").split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (match && !line.trim().startsWith("#") && process.env[match[1]] === undefined) {
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}

const DEV_SHOP_DOMAIN = "dev-shop.myshopify.com";
const TAG = "[qa-fixture]"; // talking-point marker so --reset only removes ours

interface Fixture {
  question: string;
  synonyms: string[];
  products: string[]; // product titles, resolved to shopifyProductId
  talkingPoints: string;
  status: "draft" | "published";
  priority: "low" | "normal" | "high";
}

const FIXTURES: Fixture[] = [
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

async function main(): Promise<void> {
  const reset = process.argv.includes("--reset");
  const db = (await import("../../app/db.server")).default;
  const { saveCuratedAnswer } = await import("../../app/lib/curated/save.server");

  const shop = await db.shop.findUnique({
    where: { domain: DEV_SHOP_DOMAIN },
    select: { id: true, plan: true },
  });
  if (!shop) throw new Error(`Seed the dev shop first: ${DEV_SHOP_DOMAIN} not found`);

  if (reset) {
    const removed = await db.curatedAnswer.deleteMany({
      where: { shopId: shop.id, talkingPoints: { contains: TAG } },
    });
    console.log(`removed ${removed.count} previous qa fixtures`);
  }

  // Resolve product titles → shopifyProductId (opaque gids from the seed).
  const products = await db.product.findMany({
    where: { shopId: shop.id },
    select: { title: true, shopifyProductId: true },
  });
  const byTitle = new Map(products.map((p) => [p.title, p.shopifyProductId]));

  let created = 0;
  let skipped = 0;
  let failedCount = 0;
  const warnings: string[] = [];

  for (const fx of FIXTURES) {
    const existing = await db.curatedAnswer.findFirst({
      where: { shopId: shop.id, question: fx.question },
      select: { id: true },
    });
    if (existing) {
      skipped++;
      console.log(`  SKIP  ${fx.question} (already present)`);
      continue;
    }

    const productIds = fx.products
      .map((title) => byTitle.get(title))
      .filter((id): id is string => Boolean(id));
    if (productIds.length !== fx.products.length) {
      warnings.push(`${fx.question}: ${fx.products.length - productIds.length} product title(s) unresolved`);
    }

    const result = await saveCuratedAnswer(shop.id, {
      question: fx.question,
      synonyms: fx.synonyms,
      productIds,
      talkingPoints: `${fx.talkingPoints}\n${TAG}`,
      status: fx.status,
      priority: fx.priority,
    });

    if (!result.ok) {
      failedCount++;
      console.error(`  FAIL  ${fx.question} — ${result.error}${result.code ? ` [${result.code}]` : ""}`);
      continue;
    }
    created++;
    const note = result.warning === "embedding_failed" ? " (WARN embedding failed — will never match)" : "";
    console.log(`  OK    ${fx.question}${note}`);
    if (result.warning) warnings.push(`${fx.question}: embedding failed`);
  }

  const total = await db.curatedAnswer.count({ where: { shopId: shop.id } });
  const unembedded = await db.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT count(*)::bigint AS count FROM "curated_answers" WHERE "shopId" = $1 AND "embedding" IS NULL`,
    shop.id,
  );

  console.log(`\nplan=${shop.plan}  created=${created}  skipped=${skipped}  failed=${failedCount}`);
  console.log(`curated answers on ${DEV_SHOP_DOMAIN}: ${total} (${unembedded[0].count} without an embedding)`);
  for (const w of warnings) console.log(`  warn: ${w}`);

  if (failedCount > 0) {
    console.error("\nSEED FAIL");
    process.exitCode = 1;
  } else {
    console.log("\nSEED OK");
  }
}

main()
  .catch((error) => {
    console.error("\nSEED FAIL", error?.message ?? error);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Disconnect the shared app singleton too, or the open pool keeps Node's
    // event loop alive and the script never exits (same bug that wedged smoke).
    const appDb = (await import("../../app/db.server")).default;
    await appDb.$disconnect();
  });
