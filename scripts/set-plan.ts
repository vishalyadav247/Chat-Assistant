/* Dev utility: set a shop's plan tier.
 *   npx tsx scripts/set-plan.ts                      → plus, dev shop only
 *   npx tsx scripts/set-plan.ts pro                  → pro,  dev shop only
 *   npx tsx scripts/set-plan.ts pro my.myshopify.com → pro,  that shop
 *   npx tsx scripts/set-plan.ts pro --all            → pro,  EVERY shop
 *
 * Defaults to a single shop on purpose (QA D-27): the previous version ran an
 * unfiltered updateMany, so it silently repointed the throwaway fixture shops
 * other test scripts create mid-run and made their assertions fail in confusing
 * ways. --all keeps the old behaviour when you really do want the whole DB.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const VALID = ["free", "basic", "pro", "plus"];
const DEFAULT_DOMAIN = "dev-shop.myshopify.com";

async function main() {
  const args = process.argv.slice(2);
  const all = args.includes("--all");
  const positional = args.filter((a) => !a.startsWith("--"));
  const plan = positional[0] || "plus";
  const domain = positional[1] || DEFAULT_DOMAIN;

  if (!VALID.includes(plan)) throw new Error(`plan must be one of: ${VALID.join(", ")}`);

  const where = all ? {} : { domain };
  const before = await db.shop.findMany({ where, select: { domain: true, plan: true } });
  if (before.length === 0) {
    throw new Error(
      all ? "no shops in this database" : `no shop with domain ${domain} (pass a domain, or --all)`,
    );
  }
  console.log("before:", before);

  const result = await db.shop.updateMany({ where, data: { plan } });
  console.log(
    `updated ${result.count} shop(s) to plan=${plan}${all ? " (ALL shops)" : ` — ${domain}`}`,
  );
}

main()
  .catch((error) => {
    console.error(error?.message ?? error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
