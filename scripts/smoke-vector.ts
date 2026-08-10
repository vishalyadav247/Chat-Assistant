/* Foundation smoke test (spec 01 acceptance #3). Run after seeding:
 *   npm run smoke
 * Verifies: pgvector extension + HNSW query path, generated tsvector keyword
 * search, hybrid merge, and curated matching — all shop-scoped.
 * With OPENAI_API_KEY: also asserts semantic quality (gloves for "warm hands").
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const DEV_SHOP_DOMAIN = "dev-shop.myshopify.com";

async function main() {
  const shop = await db.shop.findUnique({ where: { domain: DEV_SHOP_DOMAIN } });
  if (!shop) throw new Error(`seed first: shop ${DEV_SHOP_DOMAIN} not found (npx prisma db seed)`);
  const shopId = shop.id;

  const [{ extversion }] = await db.$queryRaw<[{ extversion: string }]>`
    SELECT extversion FROM pg_extension WHERE extname = 'vector'`;
  console.log(`pgvector ${extversion} ✔`);

  // Guard against the Prisma-drops-custom-indexes failure mode (see scrub-migration.ts).
  const REQUIRED_INDEXES = [
    "products_embedding_hnsw",
    "knowledge_embedding_hnsw",
    "curated_answers_embedding_hnsw",
    "recommendations_embedding_hnsw",
    "products_search_text_gin",
  ];
  const indexRows = await db.$queryRaw<{ indexname: string }[]>`
    SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`;
  const present = new Set(indexRows.map((r) => r.indexname));
  for (const required of REQUIRED_INDEXES) {
    if (!present.has(required)) {
      throw new Error(
        `index "${required}" missing — a migration dropped it (use npm run migrate:new, see scripts/scrub-migration.ts)`,
      );
    }
  }
  console.log(`custom indexes ✔ (${REQUIRED_INDEXES.length} present)`);

  const hasKey = Boolean(process.env.OPENAI_API_KEY);
  const query = "keep my hands warm under 30 dollars";
  let queryEmbedding: number[];
  if (hasKey) {
    const { embedText } = await import("../app/lib/embeddings/embedding.server");
    queryEmbedding = await embedText(query);
  } else {
    const { pseudoEmbedding } = await import("../app/lib/embeddings/embedding.server");
    queryEmbedding = pseudoEmbedding(query);
  }

  // Hybrid search
  const { hybridProductSearch } = await import("../app/lib/search/product-search.server");
  const candidates = await hybridProductSearch({
    shopId,
    queryEmbedding,
    keywords: ["gloves", "warm"],
    priceMax: 30,
    minMeaningScore: hasKey ? 0.3 : -1, // pseudo vectors have no meaning — disable the gate offline
  });
  if (candidates.length === 0) throw new Error("hybrid search returned nothing");
  for (const c of candidates) {
    if (c.price > 30) throw new Error(`price filter leaked: ${c.title} at ${c.price}`);
    if (c.stock <= 0) throw new Error(`stock filter leaked: ${c.title}`);
  }
  console.log(`hybrid search ✔ (${candidates.length} candidates, top: ${candidates[0].title})`);
  if (hasKey && !candidates.some((c) => /glove/i.test(c.title))) {
    throw new Error("semantic quality: expected gloves in candidates for 'warm hands'");
  }

  // Keyword path (generated tsvector + GIN)
  const kwOnly = await hybridProductSearch({
    shopId,
    queryEmbedding,
    keywords: ["waterproof", "jacket"],
    minMeaningScore: 2, // vector gate impossible → keyword-only
  });
  if (!kwOnly.some((c) => /jacket|boot/i.test(c.title))) {
    throw new Error("keyword search found no waterproof items");
  }
  console.log(`keyword search ✔ (${kwOnly.map((c) => c.title).join(", ")})`);

  // Browse-cheapest fallback
  const { browseCheapestInBudget } = await import("../app/lib/search/product-search.server");
  const browse = await browseCheapestInBudget(shopId, 15);
  if (browse.length === 0 || browse[0].price > 15) throw new Error("browse fallback broken");
  console.log(`browse fallback ✔ (cheapest: ${browse[0].title} at ${browse[0].price})`);

  // Curated match round-trip
  let curatedQuery: number[];
  if (hasKey) {
    const { embedText } = await import("../app/lib/embeddings/embedding.server");
    curatedQuery = await embedText("what are your best sellers");
  } else {
    const { pseudoEmbedding } = await import("../app/lib/embeddings/embedding.server");
    curatedQuery = pseudoEmbedding("what are your best sellers best sellers top products most popular what sells the most");
  }
  const { curatedMatch } = await import("../app/lib/search/curated-match.server");
  const match = await curatedMatch(shopId, curatedQuery);
  if (!match) throw new Error("curated match returned nothing");
  console.log(`curated match ✔ ("${match.question}" score=${match.score.toFixed(3)})`);
  if (hasKey && match.score < 0.8) {
    throw new Error(`curated score ${match.score} below direct-match threshold for an exact question`);
  }

  // RAG knowledge search
  let ragQuery: number[];
  if (hasKey) {
    const { embedText } = await import("../app/lib/embeddings/embedding.server");
    ragQuery = await embedText("do you ship to Canada?");
  } else {
    const { pseudoEmbedding } = await import("../app/lib/embeddings/embedding.server");
    ragQuery = pseudoEmbedding("Shipping — international. We ship worldwide, including Canada, the UK, the EU and Australia. International delivery takes 7-14 business days; import duties may apply.");
  }
  const { knowledgeSearch } = await import("../app/lib/search/knowledge-search.server");
  const hits = await knowledgeSearch(shopId, ragQuery, 3);
  if (hits.length === 0) throw new Error("knowledge search returned nothing");
  console.log(`knowledge search ✔ (top: ${hits[0].topic})`);
  if (hasKey && !hits.some((h) => /international/i.test(h.topic))) {
    throw new Error("semantic quality: expected international shipping doc for Canada question");
  }

  console.log("\nSMOKE PASS ✔ — foundation search stack works");
}

main()
  .catch((error) => {
    console.error("\nSMOKE FAIL ✖", error.message ?? error);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
