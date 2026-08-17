/* Seed a dev shop from the demo data in .claude/resources/demo/data-sources/.
 * Real embeddings when OPENAI_API_KEY is set; deterministic pseudo-embeddings
 * otherwise (offline-capable — pseudo vectors are NOT semantically meaningful,
 * so vector-quality assertions need a real key; structure works either way).
 * Run: npx prisma db seed
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient, Prisma } from "@prisma/client";

const db = new PrismaClient();
const DATA_DIR = join(process.cwd(), ".claude", "resources", "demo", "data-sources");
const DEV_SHOP_DOMAIN = "dev-shop.myshopify.com";

function load<T>(file: string): T {
  return JSON.parse(readFileSync(join(DATA_DIR, file), "utf-8")) as T;
}

async function embed(texts: string[]): Promise<number[][]> {
  if (process.env.OPENAI_API_KEY) {
    const { embedTexts } = await import("../app/lib/embeddings/embedding.server");
    return embedTexts(texts);
  }
  const { pseudoEmbedding } = await import("../app/lib/embeddings/embedding.server");
  console.log("(no OPENAI_API_KEY — using deterministic pseudo-embeddings)");
  return texts.map(pseudoEmbedding);
}

function toSqlVector(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

async function main() {
  const shop = await db.shop.upsert({
    where: { domain: DEV_SHOP_DOMAIN },
    update: { uninstalledAt: null },
    create: { domain: DEV_SHOP_DOMAIN, name: "Aura & Stone (dev)", currency: "USD", timezone: "America/New_York" },
  });
  const shopId = shop.id;
  console.log(`shop: ${DEV_SHOP_DOMAIN} (${shopId})`);

  // ── persona + guardrails ──────────────────────────────────────────────────
  const persona = load<Record<string, unknown>>("persona.json");
  await db.persona.upsert({
    where: { shopId },
    update: {},
    create: {
      shopId,
      role: String(persona.role ?? ""),
      communicationStyle: String(persona.communicationStyle ?? "friendly").toLowerCase(),
      brandVoice: String(persona.brandVoice ?? ""),
      behaviours: String(persona.behaviours ?? ""),
      guidelines: (persona.guidelines as string[]) ?? [],
      avoid: (persona.avoid as string[]) ?? [],
      scope: String(persona.scope ?? ""),
      offTopicMessage: String(persona.offTopicMessage ?? ""),
      defaultLanguage: String(persona.defaultLanguage ?? "en"),
      languages: (persona.languages as string[]) ?? ["en"],
      autoDetectLanguage: Boolean(persona.autoDetectLanguage),
      welcomeMessage: String(persona.welcomeMessage ?? ""),
    },
  });

  const guardrails = load<Record<string, unknown>>("guardrails.json");
  await db.guardrails.upsert({
    where: { shopId },
    update: {},
    create: {
      shopId,
      answerOnlyFromKnowledge: Boolean(guardrails.answerOnlyFromKnowledge),
      bannedTopics: (guardrails.bannedTopics as string[]) ?? [],
      fallbackMessage: String(guardrails.fallbackMessage ?? ""),
      minMeaningScore: Number(guardrails.minMeaningScore ?? 0.3),
      curatedMatchThreshold: Number(guardrails.curatedMatchThreshold ?? 0.8),
      curatedBorderline: Number(guardrails.curatedBorderline ?? 0.65),
      bannedMatchThreshold: Number(guardrails.bannedMatchThreshold ?? 0.35),
    },
  });
  console.log("persona + guardrails seeded");

  // ── products ──────────────────────────────────────────────────────────────
  interface DemoProduct { title: string; type: string; price: number; stock: number; description: string }
  const products = load<DemoProduct[]>("products.json");
  // Same text formula as catalog sync (productEmbeddingText) so seed == production.
  const { productEmbeddingText } = await import("../app/lib/embeddings/embedding.server");
  const productVectors = await embed(
    products.map((p) => productEmbeddingText({ title: p.title, productType: p.type, description: p.description })),
  );
  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    const row = await db.product.upsert({
      where: { shopId_shopifyProductId: { shopId, shopifyProductId: `gid://seed/Product/${i + 1}` } },
      update: { title: p.title, description: p.description, productType: p.type, price: p.price, stock: p.stock },
      create: {
        shopId,
        shopifyProductId: `gid://seed/Product/${i + 1}`,
        title: p.title,
        description: p.description,
        productType: p.type,
        price: p.price,
        stock: p.stock,
        handle: p.title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      },
    });
    await db.$executeRaw(Prisma.sql`
      UPDATE "products" SET "embedding" = ${toSqlVector(productVectors[i])}::vector
      WHERE "id" = ${row.id} AND "shopId" = ${shopId}
    `);
  }
  console.log(`${products.length} products seeded + embedded`);

  // ── knowledge ─────────────────────────────────────────────────────────────
  interface DemoDoc { topic: string; body: string }
  const knowledge = load<DemoDoc[]>("knowledge.json");
  const source = await db.dataSource.create({
    data: { shopId, type: "manual", name: "Demo policies & FAQ", status: "active", chunkCount: knowledge.length, lastSyncedAt: new Date() },
  });
  await db.knowledge.deleteMany({ where: { shopId } });
  const knowledgeVectors = await embed(knowledge.map((d) => `${d.topic}. ${d.body}`));
  for (let i = 0; i < knowledge.length; i++) {
    const row = await db.knowledge.create({
      data: { shopId, dataSourceId: source.id, topic: knowledge[i].topic, body: knowledge[i].body },
    });
    await db.$executeRaw(Prisma.sql`
      UPDATE "knowledge" SET "embedding" = ${toSqlVector(knowledgeVectors[i])}::vector
      WHERE "id" = ${row.id} AND "shopId" = ${shopId}
    `);
  }
  console.log(`${knowledge.length} knowledge docs seeded + embedded`);

  // ── curated answers ───────────────────────────────────────────────────────
  interface DemoCurated { question: string; synonyms: string[]; products: string[]; talkingPoints: string; status: string; priority: string }
  const curated = load<DemoCurated[]>("curated_answers.json");
  await db.curatedAnswer.deleteMany({ where: { shopId } });
  const curatedVectors = await embed(curated.map((c) => `${c.question} ${c.synonyms.join(" ")}`));
  for (let i = 0; i < curated.length; i++) {
    const c = curated[i];
    // Demo references products by title; resolve to seeded shopify ids.
    const rows = await db.product.findMany({ where: { shopId, title: { in: c.products } }, select: { shopifyProductId: true } });
    const row = await db.curatedAnswer.create({
      data: {
        shopId,
        question: c.question,
        synonyms: c.synonyms,
        productIds: rows.map((r) => r.shopifyProductId),
        talkingPoints: c.talkingPoints,
        status: c.status.toLowerCase(),
        priority: c.priority.toLowerCase(),
      },
    });
    await db.$executeRaw(Prisma.sql`
      UPDATE "curated_answers" SET "embedding" = ${toSqlVector(curatedVectors[i])}::vector
      WHERE "id" = ${row.id} AND "shopId" = ${shopId}
    `);
  }
  console.log(`${curated.length} curated answers seeded + embedded`);

  // ── app recommendations (install seeds these for real shops; spec 08) ─────
  await db.recommendation.deleteMany({ where: { shopId } });
  const topProducts = await db.product.findMany({
    where: { shopId, stock: { gt: 0 } },
    orderBy: { price: "desc" },
    take: 3,
    select: { shopifyProductId: true },
  });
  const recs = [
    {
      title: "Best sellers",
      triggerQuestions: ["What are your best sellers?", "Show me your top products"],
    },
    { title: "New arrivals", triggerQuestions: ["Any new items?", "What's new?"] },
  ];
  const recVectors = await embed(recs.map((r) => r.triggerQuestions.join(" ")));
  for (let i = 0; i < recs.length; i++) {
    const row = await db.recommendation.create({
      data: {
        shopId,
        title: recs[i].title,
        triggerQuestions: recs[i].triggerQuestions,
        productIds: topProducts.map((p) => p.shopifyProductId),
        status: "active",
      },
    });
    await db.$executeRaw(Prisma.sql`
      UPDATE "recommendations" SET "embedding" = ${toSqlVector(recVectors[i])}::vector
      WHERE "id" = ${row.id} AND "shopId" = ${shopId}
    `);
  }
  console.log(`${recs.length} app recommendations seeded + embedded`);

  console.log("seed complete ✔");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
