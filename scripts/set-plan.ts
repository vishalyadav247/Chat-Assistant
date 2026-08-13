/* Dev utility: set every shop on the connected DB to a plan tier.
 *   npx tsx scripts/set-plan.ts          → plus (default)
 *   npx tsx scripts/set-plan.ts pro      → pro
 * Used while the plan matrix is provisional (enforcement "open") so all
 * plan-derived UI — quotas, CTAs, gates — reads as the chosen tier.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const VALID = ["free", "basic", "pro", "plus"];

async function main() {
  const plan = process.argv[2] || "plus";
  if (!VALID.includes(plan)) throw new Error(`plan must be one of: ${VALID.join(", ")}`);
  const before = await db.shop.findMany({ select: { domain: true, plan: true } });
  console.log("before:", before);
  const result = await db.shop.updateMany({ data: { plan } });
  console.log(`updated ${result.count} shop(s) to plan=${plan}`);
}

main().finally(() => db.$disconnect());
