/* Verification for the operator log seam (spec 21 acceptance #3–#5).
 *   npx tsx scripts/logs-check.ts
 * Asserts, against the real dev DB:
 *   1. an Error logged with a shopId lands as one attributed row with a stack;
 *   2. shopDomain-only call sites are resolved to the right shopId;
 *   3. PII / credential keys in context are redacted, not stored;
 *   4. oversized context is truncated rather than written whole;
 *   5. 51 identical events in an hour produce 50 rows + one log_rate_capped;
 *   6. purgeAppLogs() removes rows past the retention window.
 * Uses a throwaway shop and deletes exactly what it created.
 */
import { readFileSync } from "node:fs";

// tsx does not load .env — hydrate process.env before any app import (ESM
// static imports hoist, so everything app-side is dynamically imported below).
try {
  const envFile = readFileSync(new URL("../.env", import.meta.url), "utf8");
  for (const line of envFile.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match && !(match[1] in process.env)) process.env[match[1]] = match[2];
  }
} catch {
  /* no .env — rely on ambient environment */
}
// handlers.server pulls in shopify.server, which refuses to construct without these.
process.env.SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY || "logs-check-key";
process.env.SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET || "logs-check-secret";
process.env.SHOPIFY_APP_URL = process.env.SHOPIFY_APP_URL || "https://example.com";

const DOMAIN = "logs-check.myshopify.com";

let failures = 0;
function check(label: string, condition: boolean, detail?: string) {
  console.log(`  ${condition ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures += 1;
}

async function main() {
  const { default: db } = await import("../app/db.server");
  const { logSync, resetLogRateLimit } = await import("../app/lib/log.server");
  const { APP_LOG_RETENTION_DAYS, purgeAppLogs } = await import("../app/lib/jobs/handlers.server");

  resetLogRateLimit();

  const stale = await db.shop.findUnique({ where: { domain: DOMAIN } });
  if (stale) {
    await db.appLog.deleteMany({ where: { shopId: stale.id } });
    await db.shop.delete({ where: { id: stale.id } });
  }
  const shop = await db.shop.create({ data: { domain: DOMAIN, name: "Logs Check" } });
  const shopId = shop.id;
  await db.appLog.deleteMany({ where: { event: { startsWith: "logs_check_" } } });

  // ── 1. attributed error with a stack ──────────────────────────────────────
  console.log("\n1. error attribution + stack capture");
  await logSync("error", "logs_check_boom", new Error("kaboom"), { shopId, attempt: 2 });
  const boom = await db.appLog.findFirst({ where: { event: "logs_check_boom" } });
  check("one row written", Boolean(boom));
  check("attributed to the shop", boom?.shopId === shopId);
  check("message carries the error", boom?.message === "Error: kaboom", boom?.message);
  const boomCtx = (boom?.context ?? {}) as Record<string, unknown>;
  check("stack captured", typeof boomCtx.stack === "string");
  check("caller context kept", boomCtx.attempt === 2);

  // ── 2. domain-only attribution ────────────────────────────────────────────
  console.log("\n2. shopDomain resolves to a shopId");
  await logSync("warn", "logs_check_domain", "degraded", { shopDomain: DOMAIN });
  const byDomain = await db.appLog.findFirst({ where: { event: "logs_check_domain" } });
  check("resolved without a shopId at the call site", byDomain?.shopId === shopId);

  // ── 3. PII / credential redaction ─────────────────────────────────────────
  console.log("\n3. PII and credentials are redacted");
  await logSync("error", "logs_check_pii", new Error("nope"), {
    shopId,
    email: "shopper@example.com",
    message: "I want a refund for order 1234",
    accessToken: "shpat_supersecret",
    orderId: "gid://order/1", // benign — must survive
  });
  const pii = await db.appLog.findFirst({ where: { event: "logs_check_pii" } });
  const piiCtx = (pii?.context ?? {}) as Record<string, unknown>;
  check("email redacted", piiCtx.email === "[redacted]");
  check("shopper message redacted", piiCtx.message === "[redacted]");
  check("access token redacted", piiCtx.accessToken === "[redacted]");
  check("benign key kept", piiCtx.orderId === "gid://order/1");
  const serialized = JSON.stringify(piiCtx);
  check("no secret material stored", !serialized.includes("shpat_supersecret"));
  check("no shopper text stored", !serialized.includes("refund for order"));

  // ── 4. size ceiling ───────────────────────────────────────────────────────
  console.log("\n4. oversized context is truncated");
  await logSync("error", "logs_check_big", "too much", {
    shopId,
    blob: "x".repeat(50_000),
    marker: "kept",
  });
  const big = await db.appLog.findFirst({ where: { event: "logs_check_big" } });
  const bigLen = JSON.stringify(big?.context ?? {}).length;
  check("context stayed under 3 KB", bigLen < 3000, `${bigLen} bytes`);

  // ── 5. rate cap ───────────────────────────────────────────────────────────
  console.log("\n5. rate cap holds at 50/hour per event");
  resetLogRateLimit();
  for (let i = 0; i < 51; i += 1) {
    await logSync("error", "logs_check_storm", new Error(`burst ${i}`), { shopId });
  }
  const stormed = await db.appLog.count({ where: { event: "logs_check_storm" } });
  const capNotice = await db.appLog.count({ where: { event: "log_rate_capped", shopId } });
  check("exactly 50 rows written", stormed === 50, String(stormed));
  check("one cap notice written", capNotice === 1, String(capNotice));

  // A further burst must add nothing but must still not throw.
  for (let i = 0; i < 25; i += 1) {
    await logSync("error", "logs_check_storm", new Error("more"), { shopId });
  }
  check(
    "suppressed burst added nothing",
    (await db.appLog.count({ where: { event: "logs_check_storm" } })) === 50,
  );

  // ── 6. retention purge ────────────────────────────────────────────────────
  console.log("\n6. purgeAppLogs drops rows past the window");
  const old = await db.appLog.create({
    data: { shopId, level: "error", event: "logs_check_ancient", message: "old" },
  });
  await db.appLog.update({
    where: { id: old.id },
    data: {
      occurredAt: new Date(Date.now() - (APP_LOG_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000),
    },
  });
  await purgeAppLogs();
  check(
    "aged row deleted",
    (await db.appLog.count({ where: { event: "logs_check_ancient" } })) === 0,
  );
  check(
    "fresh rows kept",
    (await db.appLog.count({ where: { event: "logs_check_boom" } })) === 1,
  );

  // ── cleanup ───────────────────────────────────────────────────────────────
  await db.appLog.deleteMany({ where: { shopId } });
  await db.shop.delete({ where: { id: shopId } });

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exitCode = 1;
  await db.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
