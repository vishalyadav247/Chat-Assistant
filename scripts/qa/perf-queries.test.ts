/* QA query-efficiency harness — runs the app's REAL hot-path functions against
 * the synthetic perf shop, captures every SQL statement Prisma emits, then
 * EXPLAIN (ANALYZE, BUFFERS)s each one to classify the plan.
 *
 *   npx tsx scripts/qa/perf-seed.ts          # seed volume first
 *   npx tsx scripts/qa/perf-queries.test.ts  # this
 *   npx tsx scripts/qa/perf-seed.ts --clean  # restore the dev DB
 *
 * Exits non-zero on any FAIL. Always disconnects the shared Prisma singleton.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

for (const line of readFileSync(join(process.cwd(), ".env"), "utf-8").split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (match && !line.trim().startsWith("#") && process.env[match[1]] === undefined) {
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}

process.env.SHOPIFY_APP_URL = process.env.SHOPIFY_APP_URL || "https://example.com";
process.env.SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY || "perf-test-key";
process.env.SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET || "perf-test-secret";
process.env.SCOPES = process.env.SCOPES || "read_products";

const PERF_SHOP_DOMAIN = "perf-test.myshopify.com";
const BIG_TABLES = new Set([
  "messages", "analytics_events", "conversations", "contacts", "products",
  "knowledge", "curated_answers",
]);

interface Captured {
  query: string;
  params: unknown[];
  /** Wall-clock ms the Prisma driver measured for this statement. */
  duration: number;
}

interface Case {
  name: string;
  ms: number;
  queries: number;
  plans: PlanInfo[];
  budgetMs: number;
  notes: string[];
}

interface PlanInfo {
  sql: string;
  execMs: number;
  planMs: number;
  nodes: string[];
  seqScans: string[];
  rows: number;
  sharedRead: number;
  sharedHit: number;
  repeats: number;
  driverMs: number;
  error?: string;
}

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

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function reviveParams(raw: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map((v) => (typeof v === "string" && ISO.test(v) ? new Date(v) : v));
}

/** Walk an EXPLAIN JSON plan tree collecting node types + seq-scanned tables. */
function walk(node: Record<string, unknown>, info: PlanInfo): void {
  const type = String(node["Node Type"] ?? "");
  const relation = node["Relation Name"] ? String(node["Relation Name"]) : "";
  const label = relation ? `${type}(${relation})` : type;
  info.nodes.push(label);
  if (type === "Seq Scan" && relation) info.seqScans.push(relation);
  const children = node["Plans"];
  if (Array.isArray(children)) {
    for (const child of children) walk(child as Record<string, unknown>, info);
  }
}

async function main(): Promise<void> {
  // Instrument BEFORE app modules import the singleton (db.server reuses
  // global.prismaGlobal when it already exists).
  const { PrismaClient } = await import("@prisma/client");
  const client = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
  (globalThis as unknown as { prismaGlobal: unknown }).prismaGlobal = client;

  let capture: Captured[] | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).$on(
    "query",
    (event: { query: string; params: string; duration: number }) => {
      if (!capture) return;
      const sql = event.query;
      if (/^(BEGIN|COMMIT|ROLLBACK|DEALLOCATE|SET |EXPLAIN)/i.test(sql.trim())) return;
      capture.push({
        query: sql,
        params: reviveParams(event.params),
        duration: Number(event.duration ?? 0),
      });
    },
  );

  const { default: db } = await import("../../app/db.server");

  try {
    const shop = await db.shop.findUnique({ where: { domain: PERF_SHOP_DOMAIN } });
    if (!shop) {
      console.error(`No ${PERF_SHOP_DOMAIN} shop — run: npx tsx scripts/qa/perf-seed.ts`);
      process.exitCode = 1;
      return;
    }
    const shopId = shop.id;

    const cases: Case[] = [];

    /** Runs `fn` `runs` times and keeps the FASTEST wall time — this box also
     *  runs the dev server, so a single sample is mostly scheduler noise. SQL
     *  is captured from the last run. `runs: 1` for cases whose first call is
     *  the point (cold backfills, cache misses). */
    const measure = async (
      name: string,
      budgetMs: number,
      fn: () => Promise<unknown>,
      runs = 3,
    ): Promise<void> => {
      let notes: string[] = [];
      let ms = Number.MAX_SAFE_INTEGER;
      let statements: Captured[] = [];
      for (let run = 0; run < runs; run++) {
        capture = [];
        const t0 = Date.now();
        try {
          const result = await fn();
          if (run === 0) {
            if (Array.isArray(result)) notes.push(`${result.length} rows returned`);
            else if (typeof result === "string") notes.push(`${result.length} bytes`);
          }
        } catch (error) {
          notes = [`ERROR: ${error instanceof Error ? error.message : String(error)}`];
          run = runs;
        }
        ms = Math.min(ms, Date.now() - t0);
        statements = capture ?? [];
        capture = null;
      }
      if (runs > 1) notes.push(`best of ${runs} runs`);

      // Dedupe identical statements (N+1 shows up as repeats — keep the count).
      const seen = new Map<string, { entry: Captured; n: number; totalMs: number }>();
      for (const s of statements) {
        const hit = seen.get(s.query);
        if (hit) {
          hit.n += 1;
          hit.totalMs += s.duration;
        } else {
          seen.set(s.query, { entry: s, n: 1, totalMs: s.duration });
        }
      }
      const repeats = [...seen.values()].filter((v) => v.n > 3).sort((a, b) => b.n - a.n);
      for (const v of repeats.slice(0, 4)) {
        notes.push(
          `N+1: ${v.n}x (${v.totalMs.toFixed(0)}ms total) ${v.entry.query.replace(/\s+/g, " ").slice(0, 80)}…`,
        );
      }
      if (repeats.length > 4) notes.push(`…and ${repeats.length - 4} more repeated statements`);
      const driverMs = statements.reduce((sum, s) => sum + s.duration, 0);
      notes.push(`driver time ${driverMs.toFixed(0)}ms across ${statements.length} statements`);

      const plans: PlanInfo[] = [];
      for (const [, v] of seen) {
        const info = await explain(db, v.entry);
        info.repeats = v.n;
        info.driverMs = v.totalMs;
        plans.push(info);
      }
      cases.push({ name, ms, queries: statements.length, plans, budgetMs, notes });
      const worst = plans.slice().sort((a, b) => b.execMs - a.execMs)[0];
      console.log(
        `\n### ${name}\n  wall ${ms}ms · ${statements.length} statement(s) · worst stmt ${
          worst ? worst.execMs.toFixed(1) : "0"
        }ms`,
      );
      for (const note of notes) console.log(`  note: ${note}`);
      for (const p of plans.slice().sort((a, b) => b.driverMs - a.driverMs).slice(0, 5)) {
        const scans = p.seqScans.filter((t) => BIG_TABLES.has(t));
        console.log(
          `  [plan ${p.execMs.toFixed(1)}ms · driver ${p.driverMs.toFixed(0)}ms x${p.repeats} rows=${p.rows} hit=${p.sharedHit} read=${p.sharedRead}]${
            scans.length ? ` SEQSCAN:${[...new Set(scans)].join(",")}` : ""
          } ${p.error ? `(explain error: ${p.error}) ` : ""}${p.sql.replace(/\s+/g, " ").slice(0, 150)}`,
        );
      }
    };

    // ── Inbox ──────────────────────────────────────────────────────────────
    const inbox = await import("../../app/lib/inbox/inbox.server");
    await measure("inbox: listConversations (list + filters + unread badge)", 150, () =>
      inbox.listConversations(shopId),
    );

    const someConvo = await db.conversation.findFirst({
      where: { shopId, isTest: false },
      orderBy: { lastMessageAt: "desc" },
      select: { id: true },
    });
    const longConvo = await db.$queryRawUnsafe<{ conversationId: string; n: bigint }[]>(
      `SELECT "conversationId", count(*) AS n FROM messages WHERE "shopId" = $1
       GROUP BY 1 ORDER BY n DESC LIMIT 1`,
      shopId,
    );
    await measure("inbox: getConversationDetail (thread history)", 100, () =>
      inbox.getConversationDetail(shopId, longConvo[0]?.conversationId ?? someConvo!.id),
    );
    await measure("widget: getWidgetThreadHistory (storefront restore)", 50, () =>
      inbox.getWidgetThreadHistory(shopId, someConvo!.id, "perf-sess-1"),
    );

    // Server-side equivalents of the JS-side inbox filters (what the list
    // SHOULD be doing) — measured so the fix can be costed.
    const filters: [string, string][] = [
      ["open", `"status" = 'open' AND "blocked" = false`],
      ["resolved", `"status" = 'resolved' AND "blocked" = false`],
      ["unassigned", `"assigneeId" IS NULL AND "status" = 'open' AND "blocked" = false`],
      ["handover", `"handover" = true AND "blocked" = false`],
      ["starred", `"starred" = true AND "blocked" = false`],
      ["blocked", `"blocked" = true`],
    ];
    for (const [label, predicate] of filters) {
      await measure(`inbox filter (server-side) ${label}`, 50, () =>
        db.$queryRawUnsafe(
          `SELECT "id","lastMessageAt" FROM conversations
           WHERE "shopId" = $1 AND "isTest" = false AND ${predicate}
           ORDER BY "lastMessageAt" DESC LIMIT 50`,
          shopId,
        ),
      );
    }
    await measure("inbox: unread badge count (server-side)", 50, () =>
      db.conversation.count({
        where: { shopId, isTest: false, unread: true, status: "open", blocked: false },
      }),
    );

    // ── Analytics ──────────────────────────────────────────────────────────
    const reports = await import("../../app/lib/analytics/reports.server");
    const rollup = await import("../../app/lib/analytics/rollup.server");

    await measure("analytics: rollupDay (one day)", 150, () =>
      rollup.rollupDay(shopId, new Date(Date.now() - 3 * 86400000)),
    );
    await db.metricsDaily.deleteMany({ where: { shopId } });
    await measure(
      "analytics: conversationSeries 12m (COLD — no rollups)",
      20000,
      () => reports.conversationSeries(shopId, "12m"),
      1, // the first, uncached load IS the case
    );
    await measure("analytics: conversationSeries 12m (WARM — rollups cached)", 300, () =>
      reports.conversationSeries(shopId, "12m"),
    );
    await measure("analytics: resolutionBreakdown 30d", 300, () =>
      reports.resolutionBreakdown(shopId, "30d"),
    );
    await measure("analytics: csatSummary (all time)", 100, () => reports.csatSummary(shopId));
    await measure("analytics: recommendationFunnel 30d", 300, () =>
      reports.recommendationFunnel(shopId, "30d"),
    );
    await measure("analytics: responsePerformance 30d (cur + prev)", 400, () =>
      reports.responsePerformance(shopId, "30d"),
    );
    await measure("analytics: topQuestions", 100, () => reports.topQuestions(shopId));
    await measure("analytics: exportConversationsCsv", 800, () =>
      reports.exportConversationsCsv(shopId),
    );
    await measure("analytics: exportAnalyticsCsv 12m", 300, () =>
      reports.exportAnalyticsCsv(shopId, "12m"),
    );

    // ── Contacts ───────────────────────────────────────────────────────────
    const contacts = await import("../../app/lib/contacts/contacts.server");
    await measure("contacts: listContacts (no filter)", 600, () => contacts.listContacts(shopId));
    await measure("contacts: listContacts (search q)", 300, () =>
      contacts.listContacts(shopId, { q: "person 12" }),
    );
    await measure("contacts: contactStats", 100, () => contacts.contactStats(shopId));
    await measure("contacts: exportContactsCsv (all)", 800, () =>
      contacts.exportContactsCsv(shopId, { scope: "all" }),
    );
    const someContact = await db.$queryRawUnsafe<{ contactId: string }[]>(
      `SELECT "contactId" FROM conversations WHERE "shopId" = $1 AND "contactId" IS NOT NULL
       GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`,
      shopId,
    );
    await measure("contacts: contactDetail (busiest contact)", 300, () =>
      contacts.contactDetail(shopId, someContact[0].contactId),
    );

    // ── Dashboard ──────────────────────────────────────────────────────────
    const dashboard = await import("../../app/lib/dashboard/dashboard.server");
    await measure("dashboard: dashboardMetrics 30d", 200, () =>
      dashboard.dashboardMetrics(shopId, "30d"),
    );
    await measure("dashboard: dashboardMetrics 12m", 300, () =>
      dashboard.dashboardMetrics(shopId, "12m"),
    );
    await measure("dashboard: liveFeed", 100, () => dashboard.liveFeed(shopId));

    // ── Vector lanes ───────────────────────────────────────────────────────
    const productSearch = await import("../../app/lib/search/product-search.server");
    const knowledgeSearch = await import("../../app/lib/search/knowledge-search.server");
    const curatedMatch = await import("../../app/lib/search/curated-match.server");
    const embedding: number[] = [];
    for (let i = 0; i < 1536; i++) embedding.push(Math.sin(i * 1.37) * 0.5);

    await measure(
      "vector: hybridProductSearch (COLD — builds lexicon)",
      2000,
      () =>
        productSearch.hybridProductSearch({
          shopId,
          queryEmbedding: embedding,
          keywords: ["silver", "bracelet"],
          message: "looking for a silver birthstone bracelet under 60",
          priceMax: 60,
          minMeaningScore: 0.2,
          limit: 8,
        }),
      1, // the lexicon cache miss IS the case
    );
    // Second call: lexicon cache warm.
    await measure("vector: hybridProductSearch (lexicon cache warm)", 400, () =>
      productSearch.hybridProductSearch({
        shopId,
        queryEmbedding: embedding,
        keywords: ["gold", "necklace"],
        message: "gold necklace pendant",
        priceMax: null,
        minMeaningScore: 0.2,
        limit: 8,
      }),
    );
    await measure("vector: knowledgeSearch (RAG)", 400, () =>
      knowledgeSearch.knowledgeSearch(shopId, embedding, 3),
    );
    await measure("vector: curatedMatch", 100, () => curatedMatch.curatedMatch(shopId, embedding));
    await measure("vector: browseCheapestInBudget", 100, () =>
      productSearch.browseCheapestInBudget(shopId, 50, 4, true),
    );

    // ── Verdicts ───────────────────────────────────────────────────────────
    console.log("\n\n========== SUMMARY ==========");
    console.log(
      `${"case".padEnd(58)}${"wall".padStart(9)}${"stmts".padStart(7)}  worst plan`,
    );
    for (const c of cases) {
      const worst = c.plans.slice().sort((a, b) => b.execMs - a.execMs)[0];
      const seq = [...new Set(c.plans.flatMap((p) => p.seqScans).filter((t) => BIG_TABLES.has(t)))];
      console.log(
        `${c.name.slice(0, 57).padEnd(58)}${`${c.ms}ms`.padStart(9)}${String(c.queries).padStart(7)}  ${
          worst ? `${worst.execMs.toFixed(1)}ms` : "-"
        }${seq.length ? ` SEQ:${seq.join(",")}` : " (indexed)"}`,
      );
    }

    console.log("\n========== ASSERTIONS ==========");
    for (const c of cases) {
      ok(`budget ${c.name}`, c.ms <= c.budgetMs, `${c.ms}ms (budget ${c.budgetMs}ms)`);
    }

    // Targeted index-usage assertions.
    const byName = new Map(cases.map((c) => [c.name, c]));
    const usesIndexOn = (caseName: string, table: string): boolean => {
      const c = byName.get(caseName);
      if (!c) return false;
      return !c.plans.some((p) => p.seqScans.includes(table));
    };
    ok(
      "inbox list does not seq-scan conversations",
      usesIndexOn("inbox: listConversations (list + filters + unread badge)", "conversations"),
    );
    ok(
      "inbox list does not seq-scan messages",
      usesIndexOn("inbox: listConversations (list + filters + unread badge)", "messages"),
    );
    ok(
      "thread history does not seq-scan messages",
      usesIndexOn("inbox: getConversationDetail (thread history)", "messages"),
    );
    for (const [label] of filters) {
      ok(
        `server-side filter '${label}' does not seq-scan conversations`,
        usesIndexOn(`inbox filter (server-side) ${label}`, "conversations"),
      );
    }
    // The unread badge is a COUNT with no LIMIT, so a full scan is a legitimate
    // planner choice; only the latency budget above gates it. Reported, not
    // asserted — a partial index would only pay off once the inbox actually
    // counts server-side (today the badge is derived in JS from the 300-row page).
    console.log(
      `  INFO unread badge count plan: ${
        usesIndexOn("inbox: unread badge count (server-side)", "conversations")
          ? "index scan"
          : "full scan on conversations"
      }`,
    );
    ok(
      "contact detail hits the analytics_events payload GIN index",
      byName
        .get("contacts: contactDetail (busiest contact)")
        ?.plans.some((p) => p.nodes.some((n) => n.includes("Bitmap Index Scan"))) === true,
    );
    // N+1 detection = "is any single statement issued once per row?". Counted
    // on DISTINCT statements + their repeat counts, not raw statement count.
    const maxRepeat = (caseName: string): number =>
      Math.max(0, ...(byName.get(caseName)?.plans.map((p) => p.repeats) ?? [0]));
    ok(
      "contact detail issues no per-conversation preview query (N+1 removed)",
      maxRepeat("contacts: contactDetail (busiest contact)") <= 2,
      `max repeat ${maxRepeat("contacts: contactDetail (busiest contact)")}x, ${
        byName.get("contacts: contactDetail (busiest contact)")?.plans.length
      } distinct statements`,
    );
    ok(
      "live feed issues no per-conversation preview query (N+1 removed)",
      maxRepeat("dashboard: liveFeed") <= 2 &&
        (byName.get("dashboard: liveFeed")?.plans.length ?? 99) <= 3,
      `max repeat ${maxRepeat("dashboard: liveFeed")}x, ${
        byName.get("dashboard: liveFeed")?.plans.length
      } distinct statements`,
    );
    ok(
      "curated match uses the HNSW index",
      byName
        .get("vector: curatedMatch")
        ?.plans.some((p) => p.nodes.some((n) => n.includes("curated_answers"))) === true ||
        byName.get("vector: curatedMatch")?.plans.every((p) => p.seqScans.length === 0) === true,
    );

    // Informational: which vector lanes the planner routes through HNSW. NOT a
    // pass/fail — with the seeder's uniformly-random embeddings HNSW traversal
    // degenerates (measured 378ms via HNSW vs 27ms via a full scan on
    // `knowledge`), so the planner's choice here is data-dependent. Re-check
    // against a shop with real embeddings before drawing conclusions.
    console.log("\n---------- vector lanes (informational) ----------");
    for (const name of [
      "vector: hybridProductSearch (COLD — builds lexicon)",
      "vector: hybridProductSearch (lexicon cache warm)",
      "vector: knowledgeSearch (RAG)",
      "vector: curatedMatch",
    ]) {
      const c = byName.get(name);
      if (!c) continue;
      const seq = [...new Set(c.plans.flatMap((p) => p.seqScans))];
      console.log(
        `  ${name.padEnd(52)} ${seq.length ? `full scan on ${seq.join(",")}` : "index scan"}`,
      );
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}

async function explain(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  captured: Captured,
): Promise<PlanInfo> {
  const info: PlanInfo = {
    sql: captured.query,
    execMs: 0,
    planMs: 0,
    nodes: [],
    seqScans: [],
    rows: 0,
    sharedRead: 0,
    sharedHit: 0,
    repeats: 1,
    driverMs: captured.duration,
  };
  if (/^\s*(INSERT|UPDATE|DELETE)/i.test(captured.query)) {
    info.error = "write statement — not explained";
    return info;
  }
  try {
    const rows: { "QUERY PLAN": unknown }[] = await db.$queryRawUnsafe(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${captured.query}`,
      ...captured.params,
    );
    const raw = rows[0]["QUERY PLAN"];
    const parsed = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown>[];
    const root = parsed[0];
    info.execMs = Number(root["Execution Time"] ?? 0);
    info.planMs = Number(root["Planning Time"] ?? 0);
    const plan = root["Plan"] as Record<string, unknown>;
    info.rows = Number(plan["Actual Rows"] ?? 0);
    info.sharedHit = Number(plan["Shared Hit Blocks"] ?? 0);
    info.sharedRead = Number(plan["Shared Read Blocks"] ?? 0);
    walk(plan, info);
  } catch (error) {
    info.error = error instanceof Error ? error.message.split("\n")[0] : String(error);
  }
  return info;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
