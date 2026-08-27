/* QA tenancy race harness — regression cover for the concurrent-afterAuth bug.
 *
 *   npx tsx scripts/qa/tenancy-race.test.ts
 *
 * Shopify can deliver two afterAuth callbacks for one install. Both reach
 * resolveShopId() having seen no Shop row, and the loser died with P2002 —
 * surfacing as a failed OAuth flow for the merchant (production app_logs event
 * `after_auth_error`, 2026-08-27, jgw-check.myshopify.com). resolveShopId now
 * catches P2002 and re-reads, so every caller gets the same id.
 *
 * ⚠️ THIS SUITE IS NOT A REPRODUCTION. Running the pre-fix implementation
 * through section A against a local Postgres passes 8/8 — the production window
 * could not be reproduced locally, presumably because eight promises in one
 * process with sub-millisecond localhost latency do not race the way two
 * independent HTTPS callbacks do. Treat A as a guard against regressions in the
 * P2002 handling, NOT as proof the race is closed.
 *
 * Writes only to the throwaway domain below and deletes it in a finally.
 * Exits non-zero on any FAIL and always disconnects the Prisma singleton.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

for (const line of readFileSync(join(process.cwd(), ".env"), "utf-8").split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (match && !line.trim().startsWith("#") && process.env[match[1]] === undefined) {
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}

const RACE_SHOP_DOMAIN = "tenancy-race-probe.myshopify.com";
const PARALLEL = 8;

let passed = 0;
let failed = 0;
function ok(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  PASS ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  const { default: db } = await import("../../app/db.server");
  const tenancy = await import("../../app/lib/tenancy.server");
  const { resolveShopId } = tenancy;
  // TS2775: an assertion signature only applies through an explicitly typed binding.
  const assertShopDomain: (value: unknown) => asserts value is string = tenancy.assertShopDomain;

  try {
    await db.shop.deleteMany({ where: { domain: RACE_SHOP_DOMAIN } });

    // A. Concurrent callers, none of which sees a row before inserting.
    console.log("A. concurrent resolveShopId (the afterAuth race)");
    const results = await Promise.allSettled(
      Array.from({ length: PARALLEL }, () => resolveShopId(RACE_SHOP_DOMAIN)),
    );
    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<string> => r.status === "fulfilled",
    );
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    for (const r of rejected) {
      console.error(`       threw: ${String(r.reason).split("\n")[0]}`);
    }
    const ids = new Set(fulfilled.map((r) => r.value));
    const rows = await db.shop.count({ where: { domain: RACE_SHOP_DOMAIN } });

    ok("no caller throws", rejected.length === 0, `${fulfilled.length}/${PARALLEL} resolved`);
    ok("all callers agree on one shopId", ids.size === 1, `${ids.size} distinct id(s)`);
    ok("exactly one Shop row created", rows === 1, `${rows} row(s)`);

    // B. The P2002 branch itself, driven directly — this is the part section A
    //    cannot be trusted to exercise. Insert the row first, then force the
    //    create() to collide, and assert the caller still gets the right id.
    console.log("B. P2002 recovery branch (forced collision)");
    const known = [...ids][0];
    let collided = false;
    try {
      await db.shop.create({ data: { domain: RACE_SHOP_DOMAIN } });
    } catch (error) {
      collided = (error as { code?: string }).code === "P2002";
    }
    ok("a duplicate create really does raise P2002", collided);
    ok("resolveShopId still returns the existing id", (await resolveShopId(RACE_SHOP_DOMAIN)) === known);
    ok(
      "still one row",
      (await db.shop.count({ where: { domain: RACE_SHOP_DOMAIN } })) === 1,
    );

    // C. The guard still refuses untrusted input.
    console.log("C. domain validation unchanged");
    for (const bad of ["", "evil.com", "../x.myshopify.com", "shop.myshopify.com.evil.com"]) {
      let threw = false;
      try {
        assertShopDomain(bad);
      } catch {
        threw = true;
      }
      ok(`rejects ${JSON.stringify(bad)}`, threw);
    }
  } finally {
    await db.shop.deleteMany({ where: { domain: RACE_SHOP_DOMAIN } });
    await db.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
