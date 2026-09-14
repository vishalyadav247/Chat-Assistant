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

import {
  CURATED_FIXTURES,
  DEV_SHOP_DOMAIN,
  LEGACY_FIXTURE_TAG,
  stripLegacyTag,
} from "./curated-fixtures";

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
      where: {
        shopId: shop.id,
        OR: [
          { question: { in: CURATED_FIXTURES.map((f) => f.question) } },
          { talkingPoints: { contains: LEGACY_FIXTURE_TAG } },
        ],
      },
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

  for (const fx of CURATED_FIXTURES) {
    const existing = await db.curatedAnswer.findFirst({
      where: { shopId: shop.id, question: fx.question },
      select: { id: true, talkingPoints: true, status: true },
    });
    if (existing) {
      skipped++;
      // Rows seeded before QA-T3 carry the marker in shopper-visible text, and
      // an old preflight --fix may have published the draft-on-purpose one.
      // The embedding is built from the question, so neither needs a re-embed.
      const cleaned = stripLegacyTag(existing.talkingPoints);
      if (cleaned !== existing.talkingPoints || existing.status !== fx.status) {
        await db.curatedAnswer.update({
          where: { id: existing.id, shopId: shop.id },
          data: { talkingPoints: cleaned, status: fx.status },
        });
        console.log(`  FIX   ${fx.question} (marker removed / status back to ${fx.status})`);
      } else {
        console.log(`  SKIP  ${fx.question} (already present)`);
      }
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
      talkingPoints: fx.talkingPoints,
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
