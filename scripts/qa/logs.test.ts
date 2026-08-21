/* QA — platform logging & observability, spec 21 (2026-08-21).
 *
 *   npx tsx scripts/qa/logs.test.ts
 *
 * Complements `npm run logs:check` (which covers the write seam's happy path)
 * by exercising the parts the acceptance harness does not: the fire-and-forget
 * path, the console mirror, message-column redaction, attribution fallbacks,
 * purge of uninstalled shops, the whole /platform/logs READ layer (filters,
 * bounded scan, row cap, "(removed store)"), and the unauthenticated 302.
 *
 * Everything it creates is prefixed `qa_logs_` / `qa-logs-*.myshopify.com` and
 * deleted in the finally block. It touches no other shop's rows.
 */
import { readFileSync } from "node:fs";

// tsx does not load .env — hydrate process.env before any app import.
try {
  const envFile = readFileSync(new URL("../../.env", import.meta.url), "utf8");
  for (const line of envFile.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (match && !line.trim().startsWith("#") && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
} catch {
  /* rely on ambient environment */
}
// handlers.server pulls in shopify.server, which refuses to construct without these.
process.env.SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY || "qa-key";
process.env.SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET || "qa-secret";
process.env.SHOPIFY_APP_URL = process.env.SHOPIFY_APP_URL || "https://example.com";

const LIVE_DOMAIN = "qa-logs-live.myshopify.com";
const GONE_DOMAIN = "qa-logs-removed.myshopify.com";
const UNINSTALLED_DOMAIN = "qa-logs-uninstalled.myshopify.com";
const EVENT_PREFIX = "qa_logs_";

let passed = 0;
let failed = 0;
function ok(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function section(title: string): void {
  console.log(`\n${title}`);
}

/** Poll until a fire-and-forget write lands (or give up). */
async function waitFor<T>(fn: () => Promise<T | null>, ms = 3000): Promise<T | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function main(): Promise<void> {
  const { default: db } = await import("../../app/db.server");
  const log = await import("../../app/lib/log.server");
  const { logSync, logError, logWarn, resetLogRateLimit } = log;
  const { APP_LOG_RETENTION_DAYS, purgeAppLogs } = await import(
    "../../app/lib/jobs/handlers.server"
  );
  const reports = await import("../../app/lib/platform/logs-report.server");
  const { ROW_LIMIT, LOG_RANGE_HOURS } = await import("../../app/lib/platform/logs-shared");

  /** Delete only what this script created. */
  async function scrub(): Promise<void> {
    await db.appLog.deleteMany({ where: { event: { startsWith: EVENT_PREFIX } } });
    for (const domain of [LIVE_DOMAIN, GONE_DOMAIN, UNINSTALLED_DOMAIN]) {
      const shop = await db.shop.findUnique({ where: { domain }, select: { id: true } });
      if (!shop) continue;
      await db.appLog.deleteMany({ where: { shopId: shop.id } });
      await db.shop.delete({ where: { id: shop.id } });
    }
    // The cap notice this script provokes is written under a fixed event code.
    await db.appLog.deleteMany({
      where: { event: "log_rate_capped", context: { path: ["suppressedEvent"], string_starts_with: EVENT_PREFIX } },
    });
  }

  await scrub();
  resetLogRateLimit();

  const shop = await db.shop.create({ data: { domain: LIVE_DOMAIN, name: "QA Logs Live" } });
  const shopId = shop.id;

  try {
    // ────────────────────────────────────────────────────────────────────────
    section("1. levels — the seam records failures only (the volume ceiling)");
    const seam = readFileSync(new URL("../../app/lib/log.server.ts", import.meta.url), "utf8");
    ok(
      'LogLevel is exactly "error" | "warn"',
      /export type LogLevel = "error" \| "warn";/.test(seam),
    );
    ok("no info level exists", !/export function logInfo/.test(seam));
    ok("no debug level exists", !/export function logDebug/.test(seam));
    ok(
      "the only exported writers are logError / logWarn / logSync",
      (seam.match(/^export (async )?function log/gm) ?? []).length === 3,
    );

    // ────────────────────────────────────────────────────────────────────────
    section("2. fire-and-forget writes land, and mirror to the console");
    const mirrored: string[] = [];
    const realError = console.error;
    const realWarn = console.warn;
    console.error = (...args: unknown[]) => mirrored.push(`error:${String(args[0])}`);
    console.warn = (...args: unknown[]) => mirrored.push(`warn:${String(args[0])}`);
    let sync = false;
    try {
      logError(`${EVENT_PREFIX}fire`, new Error("async boom"), { shopId });
      logWarn(`${EVENT_PREFIX}fire_warn`, "degraded", { shopId });
      sync = true;
    } finally {
      console.error = realError;
      console.warn = realWarn;
    }
    ok("logError returns synchronously (never awaited)", sync);
    ok("console mirror fired for the error", mirrored.includes(`error:${EVENT_PREFIX}fire`));
    ok("console mirror fired for the warning", mirrored.includes(`warn:${EVENT_PREFIX}fire_warn`));
    const landed = await waitFor(() =>
      db.appLog.findFirst({ where: { event: `${EVENT_PREFIX}fire` } }),
    );
    ok("the fire-and-forget row reached Postgres", landed !== null);
    ok("it is attributed to the shop", landed?.shopId === shopId);

    section("3. a logging failure never throws into the caller");
    let threw = false;
    try {
      // 200 KB event code + a self-referencing context: whatever the seam does
      // with this, it must not propagate.
      const cyclic: Record<string, unknown> = { shopId };
      cyclic.self = cyclic;
      await logSync("error", `${EVENT_PREFIX}${"x".repeat(200)}`, cyclic, cyclic);
    } catch {
      threw = true;
    }
    ok("an abusive call does not throw", !threw);
    const longEvent = await db.appLog.findFirst({
      where: { event: { startsWith: `${EVENT_PREFIX}xxx` } },
      select: { event: true },
    });
    ok("the event code is truncated to 120 chars", (longEvent?.event.length ?? 0) <= 120,
      String(longEvent?.event.length));

    // ────────────────────────────────────────────────────────────────────────
    section("4. attribution — shopId, shopDomain, and a detail bag");
    await logSync("warn", `${EVENT_PREFIX}by_domain`, "x", { shopDomain: LIVE_DOMAIN });
    const byDomain = await db.appLog.findFirst({ where: { event: `${EVENT_PREFIX}by_domain` } });
    ok("shopDomain resolves to the shopId", byDomain?.shopId === shopId);

    await logSync("warn", `${EVENT_PREFIX}by_detail`, { shopId, open: 2 });
    const byDetail = await db.appLog.findFirst({ where: { event: `${EVENT_PREFIX}by_detail` } });
    ok(
      "a shopId inside the DETAIL bag still attributes the row",
      byDetail?.shopId === shopId,
      String(byDetail?.shopId),
    );

    await logSync("error", `${EVENT_PREFIX}systemwide`, new Error("scheduler down"));
    const systemwide = await db.appLog.findFirst({ where: { event: `${EVENT_PREFIX}systemwide` } });
    ok("a shop-less failure stays system-wide (null shopId)", systemwide?.shopId === null);

    await logSync("warn", `${EVENT_PREFIX}nodomain`, "x", { shopDomain: "not-installed.myshopify.com" });
    const unknownDomain = await db.appLog.findFirst({ where: { event: `${EVENT_PREFIX}nodomain` } });
    ok("an unknown domain writes a system-wide row, not a fake shopId", unknownDomain?.shopId === null);

    // ────────────────────────────────────────────────────────────────────────
    section("5. PII / credential redaction across the whole denylist");
    const SECRET = "shpat_qa_supersecret_value";
    const SHOPPER = "my email is shopper@example.com, refund order 1234";
    const denied = {
      message: SHOPPER, messages: [SHOPPER], text: SHOPPER, body: SHOPPER, content: SHOPPER,
      reply: SHOPPER, answer: SHOPPER, question: SHOPPER, prompt: SHOPPER, input: SHOPPER,
      email: "shopper@example.com", phone: "+15551234567", firstName: "Ada", lastName: "Lovelace",
      name: "Ada Lovelace", customer: "gid://customer/9", address: "1 Main St",
      token: SECRET, accessToken: SECRET, password: SECRET, secret: SECRET,
      apiKey: SECRET, api_key: SECRET, authorization: `Bearer ${SECRET}`,
      cookie: `s=${SECRET}`, sessionId: SECRET,
    };
    await logSync("error", `${EVENT_PREFIX}pii`, new Error("nope"), {
      shopId, ...denied, orderId: "gid://order/1", attempt: 3,
    });
    const pii = await db.appLog.findFirst({ where: { event: `${EVENT_PREFIX}pii` } });
    const piiCtx = (pii?.context ?? {}) as Record<string, unknown>;
    let redactedAll = true;
    for (const key of Object.keys(denied)) {
      if (piiCtx[key] !== "[redacted]") {
        redactedAll = false;
        console.error(`    (not redacted: ${key} = ${JSON.stringify(piiCtx[key])})`);
      }
    }
    ok(`all ${Object.keys(denied).length} denylisted keys redacted`, redactedAll);
    ok("benign keys survive", piiCtx.orderId === "gid://order/1" && piiCtx.attempt === 3);
    const piiRow = JSON.stringify(pii);
    ok("no credential material anywhere in the row", !piiRow.includes(SECRET));
    ok("no shopper text anywhere in the row", !piiRow.includes("refund order 1234"));

    section("6. redaction covers the MESSAGE column, not just context");
    await logSync("error", `${EVENT_PREFIX}msgpii`, {
      shopId, email: "shopper@example.com", accessToken: SECRET, orderId: "gid://order/7",
    });
    const msgPii = await db.appLog.findFirst({ where: { event: `${EVENT_PREFIX}msgpii` } });
    ok("email is not in the message column", !(msgPii?.message ?? "").includes("shopper@example.com"),
      msgPii?.message?.slice(0, 60));
    ok("token is not in the message column", !(msgPii?.message ?? "").includes(SECRET));
    ok("benign detail still readable in the message", (msgPii?.message ?? "").includes("gid://order/7"));

    section("7. nested objects are redacted too, and depth is bounded");
    await logSync("error", `${EVENT_PREFIX}nested`, undefined, {
      shopId,
      payload: { customer: { email: "deep@example.com" }, sku: "ABC-1" },
      deep: { a: { b: { c: { d: "too far" } } } },
    });
    const nested = await db.appLog.findFirst({ where: { event: `${EVENT_PREFIX}nested` } });
    const nestedJson = JSON.stringify(nested?.context ?? {});
    ok("a nested PII key is redacted", !nestedJson.includes("deep@example.com"), nestedJson.slice(0, 90));
    ok("a nested benign key survives", nestedJson.includes("ABC-1"));
    ok("recursion is bounded", nestedJson.includes("[deep]"));

    section("8. oversized context is truncated, not stored whole");
    await logSync("error", `${EVENT_PREFIX}big`, "too much", {
      shopId, blob: "x".repeat(50_000), marker: "kept",
    });
    const big = await db.appLog.findFirst({ where: { event: `${EVENT_PREFIX}big` } });
    const bigLen = JSON.stringify(big?.context ?? {}).length;
    ok("context stayed well under the 2 KB ceiling + overhead", bigLen < 3000, `${bigLen} bytes`);
    ok("the message column is capped at 1000 chars", (big?.message.length ?? 0) <= 1000);

    // ────────────────────────────────────────────────────────────────────────
    section("9. rate cap — 50 rows + exactly one cap notice, per event, per hour");
    resetLogRateLimit();
    for (let i = 0; i < 51; i += 1) {
      await logSync("error", `${EVENT_PREFIX}storm`, new Error(`burst ${i}`), { shopId });
    }
    ok(
      "exactly 50 rows written",
      (await db.appLog.count({ where: { event: `${EVENT_PREFIX}storm` } })) === 50,
    );
    const notices = await db.appLog.findMany({ where: { event: "log_rate_capped", shopId } });
    ok("exactly one cap notice", notices.length === 1, String(notices.length));
    ok(
      "the notice names the suppressed event",
      (notices[0]?.context as Record<string, unknown> | null)?.suppressedEvent ===
        `${EVENT_PREFIX}storm`,
    );
    for (let i = 0; i < 30; i += 1) {
      await logSync("error", `${EVENT_PREFIX}storm`, new Error("more"), { shopId });
    }
    ok(
      "the rest of the window adds nothing",
      (await db.appLog.count({ where: { event: `${EVENT_PREFIX}storm` } })) === 50,
    );
    ok(
      "a DIFFERENT event is unaffected by the cap",
      await logSync("warn", `${EVENT_PREFIX}other`, "fine", { shopId })
        .then(() => db.appLog.count({ where: { event: `${EVENT_PREFIX}other` } }))
        .then((n) => n === 1),
    );
    ok(
      "the cap is documented as PER PROCESS (N instances => 50N rows/hour)",
      /PER PROCESS/.test(seam) && /50·N|50N|50 ?\* ?N/.test(seam),
    );

    // ────────────────────────────────────────────────────────────────────────
    section("10. retention purge — 14 days, and rows of uninstalled shops");
    const aged = await db.appLog.create({
      data: { shopId, level: "error", event: `${EVENT_PREFIX}ancient`, message: "old" },
    });
    await db.appLog.update({
      where: { id: aged.id },
      data: { occurredAt: new Date(Date.now() - (APP_LOG_RETENTION_DAYS + 1) * 86_400_000) },
    });
    const edge = await db.appLog.create({
      data: { shopId, level: "error", event: `${EVENT_PREFIX}edge`, message: "just inside" },
    });
    await db.appLog.update({
      where: { id: edge.id },
      data: { occurredAt: new Date(Date.now() - (APP_LOG_RETENTION_DAYS - 1) * 86_400_000) },
    });

    const goneShop = await db.shop.create({
      data: { domain: UNINSTALLED_DOMAIN, name: "QA Uninstalled", uninstalledAt: new Date() },
    });
    await db.appLog.create({
      data: {
        shopId: goneShop.id, level: "error", event: `${EVENT_PREFIX}orphan`,
        message: "written microseconds after the purge",
      },
    });

    await purgeAppLogs();
    ok(
      "a row past the retention window is deleted",
      (await db.appLog.count({ where: { event: `${EVENT_PREFIX}ancient` } })) === 0,
    );
    ok(
      "a row inside the window is kept",
      (await db.appLog.count({ where: { event: `${EVENT_PREFIX}edge` } })) === 1,
    );
    ok(
      "a fresh row belonging to an UNINSTALLED shop is deleted",
      (await db.appLog.count({ where: { event: `${EVENT_PREFIX}orphan` } })) === 0,
    );
    ok(
      "rows of installed shops are untouched",
      (await db.appLog.count({ where: { event: `${EVENT_PREFIX}pii` } })) === 1,
    );
    ok(`retention window is ${APP_LOG_RETENTION_DAYS} days as specced`, APP_LOG_RETENTION_DAYS === 14);

    // ────────────────────────────────────────────────────────────────────────
    section("11. read layer — filters, labels, and the purged-store case");
    const removedShop = await db.shop.create({ data: { domain: GONE_DOMAIN, name: "QA Removed" } });
    await db.appLog.create({
      data: { shopId: removedShop.id, level: "error", event: `${EVENT_PREFIX}removed`, message: "orphan row" },
    });
    await db.shop.delete({ where: { id: removedShop.id } }); // row outlives its shop

    const base = { hours: 24 as const, level: null, event: null, shopId: null };
    const all = await reports.logsOverview(base);
    ok("the overview reads across every tenant", all.rows.length > 0);
    ok(
      "an orphaned row is labelled (removed store), not crashed on",
      all.rows.some((r) => r.event === `${EVENT_PREFIX}removed` && r.shopLabel === "(removed store)"),
    );
    ok(
      "the live shop is labelled by name",
      all.rows.some((r) => r.shopId === shopId && r.shopLabel === "QA Logs Live"),
    );
    ok("event dropdown options are populated", all.eventOptions.includes(`${EVENT_PREFIX}pii`));
    ok("store dropdown options are populated", all.shopOptions.some((s) => s.id === shopId));
    ok("context is serialised for the expandable cell", all.rows.some((r) => r.context !== null));

    const errorsOnly = await reports.logsOverview({ ...base, level: "error" });
    ok("level filter returns only errors", errorsOnly.rows.every((r) => r.level === "error"));
    const warnOnly = await reports.logsOverview({ ...base, level: "warn" });
    ok("level filter returns only warnings", warnOnly.rows.every((r) => r.level === "warn"));

    const byEvent = await reports.logsOverview({ ...base, event: `${EVENT_PREFIX}storm` });
    ok(
      "event filter narrows to one code",
      byEvent.rows.length === 50 && byEvent.rows.every((r) => r.event === `${EVENT_PREFIX}storm`),
      `${byEvent.rows.length} rows`,
    );
    // topEvents is computed from the bounded scan over the WHOLE window, not
    // from the narrowed `rows` — so it also contains whatever the running app
    // logged (e.g. notify_enqueue_failed). Asserting the fixture's storm is
    // globally #1 made this test depend on how noisy the dev server happened to
    // be. Assert what the ranking actually promises instead: the storm is
    // ranked, carries its true count, and outranks every other fixture event.
    const stormRank = byEvent.topEvents.findIndex((e) => e.event === `${EVENT_PREFIX}storm`);
    ok("top-events ranks the storm", stormRank >= 0, `rank ${stormRank}`);
    const otherFixtureRank = byEvent.topEvents.findIndex(
      (e) => e.event.startsWith(EVENT_PREFIX) && e.event !== `${EVENT_PREFIX}storm`,
    );
    ok(
      "the storm outranks every other fixture event",
      stormRank >= 0 && (otherFixtureRank === -1 || stormRank < otherFixtureRank),
      `storm ${stormRank} vs other ${otherFixtureRank}`,
    );
    ok(
      "top-events carries the storm's true count",
      byEvent.topEvents[stormRank]?.count === 50,
      String(byEvent.topEvents[stormRank]?.count),
    );
    ok(
      "top-events counts stores affected",
      (byEvent.topEvents.find((e) => e.event === `${EVENT_PREFIX}storm`)?.shops ?? 0) === 1,
    );

    const byShop = await reports.logsOverview({ ...base, shopId });
    ok("store filter narrows to one tenant", byShop.rows.every((r) => r.shopId === shopId));
    ok("stat tiles count the window", byShop.errors + byShop.warnings > 0);

    ok(
      "an out-of-range hours value falls back to 24",
      reports.normalizeHours("99999") === 24 && reports.normalizeHours(null) === 24,
    );
    ok(
      "every offered range parses",
      LOG_RANGE_HOURS.every((h) => reports.normalizeHours(String(h)) === h),
    );
    ok(
      "an injected level value is rejected",
      reports.normalizeLevel("'; DROP TABLE app_logs; --") === null &&
        reports.normalizeLevel("info") === null,
    );

    section("12. the store filter is validated against the shop table");
    ok("a real shop id resolves", (await reports.resolveShopFilter(shopId)) === shopId);
    ok("a bogus shop id is dropped", (await reports.resolveShopFilter("not-a-shop-id")) === null);
    const strict = await reports.resolveShopFilterStrict("not-a-shop-id");
    ok(
      "and is reported so the page can warn instead of silently showing every store",
      strict.shopId === null && strict.unknownShop === "not-a-shop-id",
    );

    section("13. the read layer is bounded (row cap + aggregate scan cap)");
    await db.appLog.createMany({
      data: Array.from({ length: 5001 }, (_, i) => ({
        shopId,
        level: i % 2 === 0 ? "error" : "warn",
        event: `${EVENT_PREFIX}flood`,
        message: `flood ${i}`,
      })),
    });
    const flooded = await reports.logsOverview({ ...base, event: `${EVENT_PREFIX}flood` });
    ok(
      `the detail table is capped at ${ROW_LIMIT} rows`,
      flooded.rows.length === ROW_LIMIT,
      String(flooded.rows.length),
    );
    ok("and says so", flooded.truncatedRows === true);
    ok("the aggregate scan is bounded", flooded.truncatedAggregate === true);
    ok(
      "the bounded aggregate never over-counts",
      flooded.errors + flooded.warnings === 5000,
      String(flooded.errors + flooded.warnings),
    );
    ok(
      "rows come back newest first",
      flooded.rows.every(
        (r, i) => i === 0 || new Date(flooded.rows[i - 1].occurredAt) >= new Date(r.occurredAt),
      ),
    );
    await db.appLog.deleteMany({ where: { event: `${EVENT_PREFIX}flood` } });

    // ────────────────────────────────────────────────────────────────────────
    section("14. /platform/logs requires an operator session");
    const route = await import("../../app/routes/platform.logs");
    let status = 0;
    let location = "";
    try {
      const url = "https://example.com/platform/logs?hours=168&level=error";
      // Only `request` is read by this loader; the rest of the framework's
      // args object is irrelevant here.
      await route.loader({
        request: new Request(url),
        params: {},
        context: {},
        url: new URL(url),
        pattern: "/platform/logs",
      } as unknown as Parameters<typeof route.loader>[0]);
    } catch (thrown) {
      if (thrown instanceof Response) {
        status = thrown.status;
        location = thrown.headers.get("location") ?? "";
      }
    }
    ok("an unauthenticated request is redirected", status === 302, String(status));
    ok("…to the platform login", location.startsWith("/platform/login"), location);
    ok("…preserving the deep link", location.includes(encodeURIComponent("/platform/logs")), location);

    section("15. compliance — app_logs is in the uninstall purge inventory");
    const handlers = readFileSync(
      new URL("../../app/lib/jobs/handlers.server.ts", import.meta.url),
      "utf8",
    );
    ok("cleanupShop deletes app_logs", /db\.appLog\.deleteMany\(\{ where: \{ shopId \} \}\)/.test(handlers));
    ok('countShopRows asserts "app_logs"', /\["app_logs", await db\.appLog\.count\(where\)\]/.test(handlers));
    ok(
      "the nightly retention job calls purgeAppLogs()",
      /await purgeAppLogs\(\)\.catch/.test(handlers),
    );

    section("16. no console.error / console.warn bypasses the seam (acceptance #2)");
    // A bypassed call site is invisible at /platform/logs — the whole point of
    // the seam. Walked in-process so the check is shell-independent.
    const { readdirSync } = await import("node:fs");
    const appRoot = new URL("../../app/", import.meta.url);
    const bypasses: string[] = [];
    const walk = (dir: URL, rel: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const childRel = `${rel}${entry.name}`;
        if (entry.isDirectory()) {
          if (childRel === "lib/ui") continue; // client-side helpers, exempt by spec
          walk(new URL(`${entry.name}/`, dir), `${childRel}/`);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        if (childRel === "lib/log.server.ts") continue; // the seam's own mirror
        const source = readFileSync(new URL(entry.name, dir), "utf8");
        if (/console\.(error|warn)\(/.test(source)) bypasses.push(childRel);
      }
    };
    walk(appRoot, "");
    ok("zero bypassing call sites", bypasses.length === 0, bypasses.join(", ").slice(0, 200));
  } finally {
    await scrub();
    await db.$disconnect();
  }

  console.log(`\n${failed === 0 ? "ALL CHECKS PASSED" : `${failed} CHECK(S) FAILED`} (${passed} passed)`);
}

main()
  .catch((error) => {
    console.error(error);
    failed += 1;
  })
  .finally(() => {
    // The shopify/runtime-config modules keep background DB work in flight and
    // would hold the event loop open forever. Exit explicitly.
    process.exit(failed === 0 ? 0 : 1);
  });
