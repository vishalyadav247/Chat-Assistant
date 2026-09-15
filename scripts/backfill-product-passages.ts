/* Build description passages (spec 25) for existing stores.
 *
 *   npm run passages:backfill -- --shop my-store.myshopify.com
 *   npm run passages:backfill -- --all
 *   npm run passages:backfill -- --all --force     (rebuild everything, e.g. after
 *                                                   switching EMBEDDING_MODEL)
 *
 * New and changed descriptions get passages at catalog sync automatically; this
 * covers stores whose products were synced before passages existed. Idempotent:
 * unchanged descriptions are skipped (source hash), so re-running costs nothing.
 * Run from PowerShell (Prisma's binary engine is blocked in the Git-Bash sandbox).
 */
import { PrismaClient } from "@prisma/client";

try {
  process.loadEnvFile(".env");
} catch {
  // no .env — use the ambient environment
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const BATCH = 50;

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const { syncProductPassages, PASSAGE_MIN_DESCRIPTION } = await import("../app/lib/ingestion/product-passages.server");
  const domain = flag("shop");
  const all = process.argv.includes("--all");
  const force = process.argv.includes("--force");
  if (!domain && !all) {
    console.error("Usage: npm run passages:backfill -- --shop <domain> | --all [--force]");
    process.exit(2);
  }
  const shops = await prisma.shop.findMany({
    where: { uninstalledAt: null, ...(domain ? { domain } : {}) },
    select: { id: true, domain: true },
  });
  if (shops.length === 0) {
    console.error(domain ? `No installed shop ${domain}` : "No installed shops");
    process.exit(2);
  }
  for (const shop of shops) {
    if (force) {
      const removed = await prisma.productPassage.deleteMany({ where: { shopId: shop.id } });
      console.log(`${shop.domain}: removed ${removed.count} passages (--force)`);
    }
    let cursor: string | undefined;
    let seen = 0;
    for (;;) {
      const products = await prisma.product.findMany({
        where: { shopId: shop.id },
        select: { id: true, title: true, description: true },
        orderBy: { id: "asc" },
        take: BATCH,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      if (products.length === 0) break;
      await syncProductPassages(shop.id, products.filter((p) => p.description.length >= PASSAGE_MIN_DESCRIPTION));
      seen += products.length;
      cursor = products[products.length - 1].id;
    }
    const passages = await prisma.productPassage.count({ where: { shopId: shop.id } });
    const withPassages = await prisma.productPassage.findMany({
      where: { shopId: shop.id },
      distinct: ["productId"],
      select: { productId: true },
    });
    console.log(`${shop.domain}: ${seen} products checked · ${withPassages.length} with passages · ${passages} passages`);
  }
  await prisma.$disconnect();
  const appDb = (await import("../app/db.server")).default;
  await appDb.$disconnect().catch(() => undefined);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
