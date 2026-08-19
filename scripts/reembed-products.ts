/* Re-embed every product whose stored contentHash no longer matches the
 * current productEmbeddingText() formula (e.g. after the 2026-08-17 change to
 * include type/vendor/tags + full description, or 2026-08-19 metafieldText). Uses the rows already in the
 * DB — no Shopify call — so it works without a live app session.
 *   npx tsx scripts/reembed-products.ts            # all shops
 *   npx tsx scripts/reembed-products.ts my.myshopify.com
 * Needs OPENAI_API_KEY. Run from PowerShell on Windows (binary engine).
 */
import { createHash } from "node:crypto";
import { PrismaClient, Prisma } from "@prisma/client";

const db = new PrismaClient();
const domainArg = process.argv[2];

async function main() {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY required");
  const { productEmbeddingText, embedTexts, toSqlVector } = await import(
    "../app/lib/embeddings/embedding.server"
  );
  const shops = await db.shop.findMany({
    where: domainArg ? { domain: domainArg } : { uninstalledAt: null },
    select: { id: true, domain: true },
  });
  for (const shop of shops) {
    const products = await db.product.findMany({
      where: { shopId: shop.id },
      select: {
        id: true, title: true, description: true, productType: true, vendor: true, tags: true,
        metafieldText: true, contentHash: true,
      },
    });
    const stale = products
      .map((p) => ({ id: p.id, text: productEmbeddingText(p), stored: p.contentHash }))
      .map((p) => ({ ...p, hash: createHash("sha256").update(p.text).digest("hex").slice(0, 32) }))
      .filter((p) => p.hash !== p.stored);
    console.log(`${shop.domain}: ${products.length} products, ${stale.length} to re-embed`);
    if (stale.length === 0) continue;
    const vectors = await embedTexts(stale.map((p) => p.text));
    for (let i = 0; i < stale.length; i++) {
      await db.$executeRaw(Prisma.sql`
        UPDATE "products" SET "embedding" = ${toSqlVector(vectors[i])}::vector, "contentHash" = ${stale[i].hash}
        WHERE "id" = ${stale[i].id} AND "shopId" = ${shop.id}
      `);
    }
    console.log(`${shop.domain}: re-embedded ${stale.length}`);
  }
}

main()
  .catch((error) => {
    console.error("reembed failed:", error);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
