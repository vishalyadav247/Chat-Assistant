/* Spec 23 — AI pipeline & learning hardening regression suite (PH-*).
 *
 * Run (PowerShell):  npx tsx scripts/qa/pipeline-hardening.test.ts
 * Needs: dev Postgres up + migrated. No dev server. No LLM spend: the app's
 * LLM singleton is swapped for a deterministic fake (the CapturingProvider's
 * `inner` seam) BEFORE any pipeline code runs; the single optional live check
 * uses its own provider instance and only runs when OPENAI_API_KEY is set.
 *
 * Shopify Admin GraphQL is stubbed at the fetch layer (the shopify-api node
 * adapter captures globalThis.fetch at import, so the stub is installed first)
 * against a throwaway offline Session row — nothing leaves the machine.
 *
 * Everything lives on a throwaway shop `qa-ph-<ts>.myshopify.com`, removed with
 * cleanupShop in `finally`. No queue worker is ever started: a send-only
 * pg-boss client is installed for the one path that enqueues (handover notify),
 * and the weekly recrawl sweep is driven through a fake boss object.
 *
 * Every case runs under a timeout, so a hung await is a FAIL, not a stall.
 * A FAIL marked "DEFECT" is a real product defect found by this suite — the
 * assertion encodes the spec's Accept line and must not be weakened to pass.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

// This suite asserts the router + lanes engine (spec 23). Since spec 24 the AI
// agent is the default; pin the pipeline so these cases keep testing it.
process.env.AI_AGENT_MODE = "pipeline";

for (const line of readFileSync(join(process.cwd(), ".env"), "utf-8").split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (match && !line.trim().startsWith("#") && process.env[match[1]] === undefined) {
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}
process.env.SHOPIFY_APP_URL ||= "http://localhost:3000";
process.env.SHOPIFY_API_KEY ||= "placeholder-pipeline-hardening";
process.env.SHOPIFY_API_SECRET ||= "placeholder-pipeline-hardening";
process.env.SCOPES ||= "read_products";

const TS = Date.now();
const DOMAIN = `qa-ph-${TS}.myshopify.com`;
const DOMAIN_B = `qa-ph-${TS}-b.myshopify.com`;
const FAKE_HOST = "203.0.113.7"; // TEST-NET-3: public per the SSRF guard, never routed

// ── fetch stub (must precede every app import) ───────────────────────────────
type GqlHandler = (query: string, variables: Record<string, unknown>) => unknown;
const stub = {
  gql: null as GqlHandler | null,
  pages: new Map<string, string | Error>(),
};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname === DOMAIN || url.hostname === DOMAIN_B) {
    const raw = typeof init?.body === "string" ? init.body : "{}";
    const body = JSON.parse(raw) as { query?: string; variables?: Record<string, unknown> };
    const data = stub.gql ? stub.gql(body.query ?? "", body.variables ?? {}) : { data: {} };
    return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.hostname === FAKE_HOST) {
    const page = stub.pages.get(url.pathname);
    if (page instanceof Error || page === undefined) throw new TypeError("fetch failed (qa stub: host unreachable)");
    return new Response(page, { status: 200, headers: { "Content-Type": "text/html" } });
  }
  return realFetch(input, init);
}) as typeof fetch;

// ── reporting ────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
let skipped = 0;
const failures: string[] = [];
const skips: string[] = [];
function ok(id: string, name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  PASS ${id} ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    failures.push(`${id} ${name}`);
    console.error(`  FAIL ${id} ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function skip(id: string, reason: string): void {
  skipped++;
  skips.push(`${id}: ${reason}`);
  console.log(`  SKIP ${id} — ${reason}`);
}
async function kase(id: string, fn: () => Promise<void>, timeoutMs = 60_000): Promise<void> {
  console.log(`\n[${id}]`);
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      fn(),
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } catch (error) {
    ok(id, "case completed without throwing", false, error instanceof Error ? error.stack?.split("\n").slice(0, 3).join(" | ") : String(error));
  } finally {
    clearTimeout(timer);
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf-8");

// ── vectors ──────────────────────────────────────────────────────────────────
const DIM = 1536;
function basis(i: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[i] = 1;
  return v;
}
/** Unit vector whose cosine with basis(a) is exactly s. */
function mix(s: number, a: number, b: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[a] = s;
  v[b] = Math.sqrt(1 - s * s);
  return v;
}

// ── fake LLM provider ────────────────────────────────────────────────────────
interface ChatMsg { role: string; content: string }
interface RecordedCall { kind: "chat" | "stream" | "embed"; purpose: string; system: string; user: string; texts?: string[] }
const fake = {
  calls: [] as RecordedCall[],
  /** [needle (case-insensitive substring), vector] — first match wins; else pseudo. */
  tags: [] as Array<[string, number[]]>,
  embedFailNeedle: "qa-embed-fail",
  embedDelayMs: 0,
  embedGate: null as Promise<void> | null,
  router: (_msg: string): string => JSON.stringify({ intent: "chat", keywords: [], price_max: null, blocked: false, blocked_reason: "", off_topic: false, off_topic_reason: "" }),
  detailConfirm: (_user: string): string => "no",
  curatedConfirm: (_user: string): string => "no",
  summary: (_user: string): string => "summary",
  stream: (_messages: ChatMsg[]): string[] => ["Happy to help!"],
  pseudo: null as null | ((t: string) => number[]),
  vectorFor(text: string): number[] {
    const lower = text.toLowerCase();
    for (const [needle, vector] of this.tags) if (lower.includes(needle.toLowerCase())) return vector;
    return this.pseudo!(text);
  },
  lastUser(messages: ChatMsg[]): string {
    return [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  },
  async chat(messages: ChatMsg[], ctx: { purpose: string }): Promise<string> {
    const system = messages[0]?.role === "system" ? messages[0].content : "";
    const user = this.lastUser(messages);
    this.calls.push({ kind: "chat", purpose: ctx.purpose, system, user });
    if (system.startsWith("You are the router")) return this.router(user);
    if (user.includes("Products already shown to this shopper")) return this.detailConfirm(user);
    if (user.includes("Does this shopper message mean the same as the question")) return this.curatedConfirm(user);
    if (ctx.purpose === "summary") return this.summary(user);
    return "no";
  },
  chatStream(messages: ChatMsg[], ctx: { purpose: string }): AsyncIterable<string> {
    const system = messages[0]?.role === "system" ? messages[0].content : "";
    const user = this.lastUser(messages);
    this.calls.push({ kind: "stream", purpose: ctx.purpose, system, user });
    const tokens = this.stream(messages);
    return (async function* () {
      for (const t of tokens) yield t;
    })();
  },
  async embed(text: string): Promise<number[]> {
    return (await this.embedBatch([text]))[0];
  },
  async embedBatch(texts: string[]): Promise<number[][]> {
    this.calls.push({ kind: "embed", purpose: "embedding", system: "", user: "", texts });
    if (this.embedGate) await this.embedGate;
    if (this.embedDelayMs) await sleep(this.embedDelayMs);
    if (texts.some((t) => t.toLowerCase().includes(this.embedFailNeedle))) throw new Error("qa fake: embedding API failure");
    return texts.map((t) => this.vectorFor(t));
  },
  async moderate(): Promise<string[]> {
    return [];
  },
};

async function main(): Promise<void> {
  const db = (await import("../../app/db.server")).default;
  const { getLlmProvider } = await import("../../app/lib/llm/index.server");
  const emb = await import("../../app/lib/embeddings/embedding.server");
  fake.pseudo = emb.pseudoEmbedding;
  const capturing = getLlmProvider() as unknown as { inner: unknown };
  if (!("inner" in capturing)) throw new Error("LLM seam changed: CapturingProvider.inner not found — refusing to run (would hit the real API)");
  capturing.inner = fake;

  // Send-only pg-boss (TEST-CASES.md "Tests must never become job workers").
  const { PgBoss } = await import("pg-boss");
  const sender = new PgBoss({ connectionString: process.env.DATABASE_URL!, supervise: false, schedule: false });
  await sender.start();
  (global as unknown as { pgBossGlobal?: unknown }).pgBossGlobal = { boss: sender, started: Promise.resolve() };

  const { cleanupShop } = await import("../../app/lib/jobs/handlers.server");
  const startedAt = new Date();
  for (const d of [DOMAIN, DOMAIN_B]) {
    await cleanupShop(d).catch(() => undefined);
    await db.shop.deleteMany({ where: { domain: d } });
  }
  const shop = await db.shop.create({ data: { domain: DOMAIN, name: "QA pipeline hardening" } });
  const shopId = shop.id;
  // Offline session so unauthenticated.admin() works against the fetch stub.
  await db.session.create({
    data: { id: `offline_${DOMAIN}`, shop: DOMAIN, state: "", isOnline: false, scope: process.env.SCOPES, accessToken: "shpat_qa_ph_fake" },
  });

  const setVector = async (table: "knowledge" | "products" | "curated_answers", id: string, v: number[]) => {
    const { Prisma } = await import("@prisma/client");
    await db.$executeRaw(Prisma.sql`UPDATE ${Prisma.raw(`"${table}"`)} SET "embedding" = ${emb.toSqlVector(v)}::vector WHERE "id" = ${id} AND "shopId" = ${shopId}`);
  };
  const waitForLog = async (event: string, forShop: string, ms = 3000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const row = await db.appLog.findFirst({ where: { event, shopId: forShop, occurredAt: { gte: startedAt } }, orderBy: { occurredAt: "desc" } });
      if (row) return row;
      await sleep(100);
    }
    return null;
  };

  try {
    const helpers = { setVector, waitForLog };
    await phase1(db, shopId, helpers);
    const shopB = await db.shop.create({ data: { domain: DOMAIN_B, name: "QA pipeline hardening B" } });
    await db.session.create({
      data: { id: `offline_${DOMAIN_B}`, shop: DOMAIN_B, state: "", isOnline: false, scope: process.env.SCOPES, accessToken: "shpat_qa_ph_fake" },
    });
    await phase2to4(db, shopId, shopB.id, helpers);
  } finally {
    await sleep(600); // fire-and-forget log/usage/trace writes
    for (const d of [DOMAIN, DOMAIN_B]) {
      await cleanupShop(d).catch((error: unknown) => console.error("cleanup failed", error));
      await db.shop.deleteMany({ where: { domain: d } }).catch(() => undefined);
    }
    // reportNullEmbeddings (PH-4.5) logs for every shop; drop rows this run produced.
    await db.appLog.deleteMany({ where: { event: "null_embeddings", occurredAt: { gte: startedAt } } }).catch(() => undefined);
    await sender.stop({ graceful: false }).catch(() => undefined);
    (global as unknown as { pgBossGlobal?: unknown }).pgBossGlobal = undefined;
  }
}

type Db = Awaited<typeof import("../../app/db.server")>["default"];
interface Helpers {
  setVector: (table: "knowledge" | "products" | "curated_answers", id: string, v: number[]) => Promise<void>;
  waitForLog: (event: string, forShop: string, ms?: number) => Promise<{ context: unknown } | null>;
}

// ═════════════════════════════════════════════════════════════════════════════
// Phase 1 — reliability of what the AI knows
// ═════════════════════════════════════════════════════════════════════════════
async function phase1(db: Db, shopId: string, h: Helpers): Promise<void> {
  const emb = await import("../../app/lib/embeddings/embedding.server");
  void h;
  const { loadHistory } = await import("../../app/lib/pipeline/history.server");
  const { ingestSource } = await import("../../app/lib/ingestion/knowledge-ingest.server");
  const { knowledgeSearch } = await import("../../app/lib/search/knowledge-search.server");
  const jobs = await import("../../app/lib/ingestion/knowledge-jobs.server");
  const { recommendationMatch } = await import("../../app/lib/search/recommendation-match.server");

  // ── 1.1 rolling summary ────────────────────────────────────────────────────
  await kase("PH-1.1", async () => {
    const convo = await db.conversation.create({ data: { shopId, sessionId: `qa-ph-hist-${Date.now()}` } });
    const base = Date.now() - 3_600_000;
    let folds = 0;
    fake.summary = () => `summary fold ${++folds}`;
    const counts: number[] = [];
    let summaryAt50 = "";
    for (let n = 1; n <= 70; n++) {
      await db.message.create({
        data: { shopId, conversationId: convo.id, role: n % 2 ? "in" : "out", content: `message ${n}`, createdAt: new Date(base + n * 1000) },
      });
      await loadHistory(shopId, convo.id);
      const row = await db.conversation.findFirst({ where: { id: convo.id, shopId }, select: { summaryMessageCount: true, summary: true } });
      counts.push(row?.summaryMessageCount ?? -1);
      if (n === 50) summaryAt50 = row?.summary ?? "";
    }
    const final = await db.conversation.findFirst({ where: { id: convo.id, shopId }, select: { summaryMessageCount: true, summary: true } });
    ok("PH-1.1a", "summaryMessageCount advances past the old frozen 40", Math.max(...counts) > 40, `max=${Math.max(...counts)}`);
    ok("PH-1.1b", "after 70 messages the summary covers ≥56 of the 60 aged-out messages", (final?.summaryMessageCount ?? 0) >= 56, `count=${final?.summaryMessageCount}`);
    ok("PH-1.1c", "the summary text itself keeps refreshing after message 50", !!final?.summary && final.summary !== summaryAt50, `${summaryAt50} → ${final?.summary}`);
    ok("PH-1.1d", "the prior summary is folded into each refresh", fake.calls.some((c) => c.purpose === "summary" && c.user.includes("summary fold")));

    // A failed summarize must not wipe the prior summary nor mark messages done.
    fake.summary = () => { throw new Error("qa fake: summary outage"); };
    for (let n = 71; n <= 76; n++) {
      await db.message.create({ data: { shopId, conversationId: convo.id, role: n % 2 ? "in" : "out", content: `message ${n}`, createdAt: new Date(base + n * 1000) } });
    }
    const bundle = await loadHistory(shopId, convo.id);
    const after = await db.conversation.findFirst({ where: { id: convo.id, shopId }, select: { summaryMessageCount: true, summary: true } });
    ok("PH-1.1e", "failed summarize keeps the stored summary", after?.summary === final?.summary, String(after?.summary));
    ok("PH-1.1f", "failed summarize does not advance summaryMessageCount", after?.summaryMessageCount === final?.summaryMessageCount, `${final?.summaryMessageCount} → ${after?.summaryMessageCount}`);
    ok("PH-1.1g", "history still carries the prior summary to the model", bundle.routerHistory[0]?.content.includes(final?.summary ?? "∅") === true);
    fake.summary = () => "summary";
  });

  // ── 1.2 transient failure keeps serving; sweep retries ─────────────────────
  await kase("PH-1.2", async () => {
    fake.tags.push(["qa-policy-page", basis(10)], ["qa-inactive-page", basis(11)]);
    stub.pages.set("/policy", "<html><head><title>Returns policy | QA Brand</title></head><body><nav>Menu Home Shop Cart</nav><main><h1>qa-policy-page</h1><p>Returns accepted within 30 days of delivery for unworn items.</p></main><footer>Free shipping over $50 | Cookie settings</footer></body></html>");
    const source = await db.dataSource.create({ data: { shopId, type: "url", name: "QA policy", url: `http://${FAKE_HOST}/policy`, status: "pending", reCrawlWeekly: true } });
    await ingestSource(shopId, source.id);
    const good = await db.dataSource.findFirst({ where: { id: source.id, shopId } });
    const goodChunks = await db.knowledge.findMany({ where: { shopId, dataSourceId: source.id } });
    ok("PH-1.2a", "baseline ingest is active with chunks", good?.status === "active" && goodChunks.length > 0, `status=${good?.status} chunks=${goodChunks.length}`);
    ok("PH-3.7c", "crawled chunk text holds no nav/footer strings", goodChunks.every((c) => !/Menu Home|Cookie settings|Free shipping over/.test(c.body)), goodChunks.map((c) => c.body).join(" / ").slice(0, 160));
    ok("PH-3.7d", "crawled <title> trimmed at the first | separator", goodChunks.every((c) => c.topic === "Returns policy"), goodChunks[0]?.topic);

    // The page goes unreachable.
    stub.pages.set("/policy", new Error("down"));
    let threw = false;
    try { await ingestSource(shopId, source.id); } catch { threw = true; }
    const bad = await db.dataSource.findFirst({ where: { id: source.id, shopId } });
    const meta = (bad?.metadata ?? {}) as { error?: string; consecutiveFailures?: number; pagesUsed?: number };
    const kept = await db.knowledge.count({ where: { shopId, dataSourceId: source.id } });
    const hits = (await knowledgeSearch(shopId, basis(10), 3)).filter((x) => x.score > 0.9);
    ok("PH-1.2b", "failed re-ingest rethrows (job visibility)", threw);
    ok("PH-1.2c", "source row carries status=error + lastError", bad?.status === "error" && !!meta.error, `status=${bad?.status} error=${meta.error?.slice(0, 60)}`);
    ok("PH-1.2d", "previous chunks survive the failure", kept === goodChunks.length, `kept=${kept}`);
    ok("PH-1.2e", "knowledgeSearch still returns the stale chunks", hits.some((hit) => goodChunks.some((c) => c.id === hit.id)), `hits=${hits.length}`);
    ok("PH-1.2f", "consecutiveFailures counted; pagesUsed not zeroed when chunks were kept", meta.consecutiveFailures === 1 && meta.pagesUsed === 1, JSON.stringify({ f: meta.consecutiveFailures, p: meta.pagesUsed }));

    // First-ever failure: nothing to serve, meter zeroed.
    const fresh = await db.dataSource.create({ data: { shopId, type: "url", name: "QA dead", url: `http://${FAKE_HOST}/never`, status: "pending" } });
    await ingestSource(shopId, fresh.id).catch(() => undefined);
    const freshRow = await db.dataSource.findFirst({ where: { id: fresh.id, shopId } });
    ok("PH-1.2g", "first-ever failure: error, zero chunks, pagesUsed 0", freshRow?.status === "error" && (await db.knowledge.count({ where: { shopId, dataSourceId: fresh.id } })) === 0 && ((freshRow?.metadata ?? {}) as { pagesUsed?: number }).pagesUsed === 0);

    // FAQ bridge: a failed EMBED call keeps the last good FAQ chunks serving.
    fake.tags.push(["qa-faq-answer", basis(12)]);
    await db.faq.create({ data: { shopId, question: "Do you gift wrap?", answerHtml: "<p>qa-faq-answer: yes, free gift wrap.</p>", status: "published" } });
    const { syncFaqKnowledge } = await import("../../app/lib/ingestion/knowledge-ingest.server");
    const faqOk = await syncFaqKnowledge(shopId);
    await db.faq.create({ data: { shopId, question: "Broken embed?", answerHtml: "<p>qa-embed-fail marker</p>", status: "published" } });
    await syncFaqKnowledge(shopId).catch(() => undefined);
    const faqHits = (await knowledgeSearch(shopId, basis(12), 3)).filter((x) => x.score > 0.9);
    const faqSrc = await db.dataSource.findFirst({ where: { id: faqOk.sourceId, shopId } });
    ok("PH-1.2h", "failed FAQ embed → bridge flagged error, old FAQ chunk still retrievable", faqSrc?.status === "error" && faqHits.some((x) => x.body.includes("qa-faq-answer")), `status=${faqSrc?.status} hits=${faqHits.length}`);
    await db.faq.deleteMany({ where: { shopId, question: "Broken embed?" } });

    // Merchant off-switch: an INACTIVE source must never start serving because a re-crawl failed.
    stub.pages.set("/inactive", "<html><head><title>Old promo</title></head><body><p>qa-inactive-page: expired promo text the merchant switched off.</p></body></html>");
    const inactive = await db.dataSource.create({ data: { shopId, type: "url", name: "QA inactive", url: `http://${FAKE_HOST}/inactive`, status: "pending", metadata: { desiredStatus: "inactive" } } });
    await ingestSource(shopId, inactive.id);
    const inactiveBefore = (await knowledgeSearch(shopId, basis(11), 3)).filter((x) => x.score > 0.9);
    stub.pages.set("/inactive", new Error("down"));
    await ingestSource(shopId, inactive.id).catch(() => undefined);
    const inactiveAfter = (await knowledgeSearch(shopId, basis(11), 3)).filter((x) => x.score > 0.9);
    const inactiveRow = await db.dataSource.findFirst({ where: { id: inactive.id, shopId } });
    ok("PH-1.2i", "inactive source is not served after a successful ingest", inactiveBefore.length === 0, `hits=${inactiveBefore.length}`);
    ok("PH-1.2j", "DEFECT-CHECK: an inactive source whose re-crawl FAILS stays unserved", inactiveAfter.length === 0, `status=${inactiveRow?.status} hits=${inactiveAfter.length} (knowledge-ingest sets pending→error, search filter is status <> 'inactive')`);

    // Weekly sweep through a fake boss: error sources re-enqueued, capped.
    const capped = await db.dataSource.create({ data: { shopId, type: "manual", name: "QA capped", status: "error", metadata: { consecutiveFailures: jobs.MAX_ERROR_RETRIES } } });
    const handlers = new Map<string, (jobs: unknown[]) => Promise<void>>();
    const sent: Array<{ name: string; data: { sourceId: string } }> = [];
    const fakeBoss = {
      createQueue: async () => undefined,
      work: async (name: string, fn: (jobs: unknown[]) => Promise<void>) => { handlers.set(name, fn); },
      send: async (name: string, data: { sourceId: string }) => { sent.push({ name, data }); return "id"; },
    };
    await jobs.registerKnowledgeJobs(fakeBoss as unknown as Parameters<typeof jobs.registerKnowledgeJobs>[0]);
    await handlers.get(jobs.KNOWLEDGE_RECRAWL_JOB)!([]);
    const sentIds = sent.filter((s) => s.name === jobs.KNOWLEDGE_INGEST_JOB).map((s) => s.data.sourceId);
    ok("PH-1.2k", "next recrawl sweep enqueues the errored url source", sentIds.includes(source.id));
    ok("PH-1.2l", "…and the errored FAQ bridge (any type)", sentIds.includes(faqOk.sourceId));
    ok("PH-1.2m", `…but not a source at MAX_ERROR_RETRIES (${jobs.MAX_ERROR_RETRIES})`, !sentIds.includes(capped.id));
    ok("PH-1.2n", "each source enqueued once", sentIds.filter((id) => id === source.id).length === 1);
  });

  // ── 1.3 atomic, serialized rebuild ─────────────────────────────────────────
  await kase("PH-1.3", async () => {
    const rows = (tag: string) => Array.from({ length: 6 }, (_, i) => ({ question: `QA ${tag} question ${i}`, answer: `qa-csv-${tag} answer number ${i} with enough words to be a chunk.` }));
    const csv = await db.dataSource.create({ data: { shopId, type: "csv", name: "QA csv", status: "pending", metadata: { rows: rows("v1") } } });
    fake.embedDelayMs = 40;
    await Promise.all([ingestSource(shopId, csv.id), ingestSource(shopId, csv.id)]);
    fake.embedDelayMs = 0;
    const chunks = await db.knowledge.findMany({ where: { shopId, dataSourceId: csv.id }, select: { id: true, body: true } });
    const { Prisma } = await import("@prisma/client");
    const embedded = await db.$queryRaw<{ n: bigint }[]>(Prisma.sql`SELECT count(*)::bigint AS n FROM "knowledge" WHERE "shopId" = ${shopId} AND "dataSourceId" = ${csv.id} AND "embedding" IS NOT NULL`);
    ok("PH-1.3a", "two concurrent ingests → exactly one run's 6 chunks", chunks.length === 6, `chunks=${chunks.length}`);
    ok("PH-1.3b", "no duplicate chunk bodies", new Set(chunks.map((c) => c.body)).size === chunks.length);
    ok("PH-1.3c", "every chunk carries its embedding", Number(embedded[0]?.n ?? 0) === 6);
    const src = await db.dataSource.findFirst({ where: { id: csv.id, shopId } });
    ok("PH-1.3d", "chunkCount matches rows", src?.chunkCount === 6 && src.status === "active");

    // Mid-rebuild reader: hold the data_sources row lock so the swap transaction
    // blocks AFTER its delete+insert, then read from another connection.
    fake.tags.push(["qa-csv-v1", basis(13)], ["qa-csv-v2", basis(13)]);
    await ingestSource(shopId, csv.id); // re-embed v1 with the tagged vector
    const oldIds = new Set((await db.knowledge.findMany({ where: { shopId, dataSourceId: csv.id }, select: { id: true } })).map((r) => r.id));
    await db.dataSource.updateMany({ where: { id: csv.id, shopId }, data: { metadata: { rows: rows("v2") } } });
    let releaseEmbed!: () => void;
    fake.embedGate = new Promise<void>((r) => { releaseEmbed = r; });
    const ingest = ingestSource(shopId, csv.id);
    // wait until the pre-transaction `pending` write landed
    for (let i = 0; i < 100; i++) {
      if ((await db.dataSource.findFirst({ where: { id: csv.id, shopId } }))?.status === "pending") break;
      await sleep(50);
    }
    let releaseLock!: () => void;
    let lockedResolve!: () => void;
    const locked = new Promise<void>((r) => { lockedResolve = r; });
    const holder = db.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "data_sources" WHERE "id" = ${csv.id} AND "shopId" = ${shopId} FOR UPDATE`);
      lockedResolve();
      await new Promise<void>((r) => { releaseLock = r; });
    }, { timeout: 45_000, maxWait: 10_000 });
    await locked;
    fake.embedGate = null;
    releaseEmbed();
    let blocked = false;
    for (let i = 0; i < 100; i++) {
      const waiting = await db.$queryRaw<{ n: bigint }[]>(Prisma.sql`SELECT count(*)::bigint AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%data_sources%'`);
      if (Number(waiting[0]?.n ?? 0) > 0) { blocked = true; break; }
      await sleep(50);
    }
    const midRows = await db.knowledge.findMany({ where: { shopId, dataSourceId: csv.id }, select: { id: true, body: true } });
    const midHits = (await knowledgeSearch(shopId, basis(13), 3)).filter((x) => x.score > 0.9);
    releaseLock();
    await holder;
    await ingest;
    const newRows = await db.knowledge.findMany({ where: { shopId, dataSourceId: csv.id }, select: { id: true, body: true } });
    ok("PH-1.3e", "the swap transaction reached its final write and blocked (test precondition)", blocked);
    ok("PH-1.3f", "mid-rebuild reader sees the previous COMPLETE set", midRows.length === 6 && midRows.every((r) => oldIds.has(r.id)), `mid=${midRows.length}`);
    ok("PH-1.3g", "mid-rebuild retrieval still answers from the old set", midHits.length > 0 && midHits.every((x) => x.body.includes("qa-csv-v1")), midHits.map((x) => x.body.slice(0, 14)).join(","));
    ok("PH-1.3h", "after commit the new set replaced the old one", newRows.length === 6 && newRows.every((r) => r.body.includes("qa-csv-v2")));

    // Embed failure before the transaction leaves the old set untouched.
    await db.dataSource.updateMany({ where: { id: csv.id, shopId }, data: { metadata: { rows: [{ question: "x", answer: "qa-embed-fail row" }] } } });
    await ingestSource(shopId, csv.id).catch(() => undefined);
    ok("PH-1.3i", "a failed embed deletes nothing", (await db.knowledge.count({ where: { shopId, dataSourceId: csv.id } })) === 6);
  }, 90_000);

  // ── 1.4 recommendation cache ───────────────────────────────────────────────
  await kase("PH-1.4", async () => {
    const g = global as unknown as { recVectorCache?: Map<string, Map<string, number[][]>> };
    const trigger = "qa best sellers please";
    const rec = await db.recommendation.create({ data: { shopId, title: "QA best sellers", triggerQuestions: [trigger], productIds: ["gid://shopify/Product/1001"], status: "active" } });
    const q = emb.pseudoEmbedding(trigger);
    const first = await recommendationMatch(shopId, q);
    await db.recommendation.updateMany({ where: { id: rec.id, shopId }, data: { productIds: ["gid://shopify/Product/2002"], title: "QA best sellers v2" } });
    const embedsBefore = fake.calls.filter((c) => c.kind === "embed").length;
    const second = await recommendationMatch(shopId, q);
    const embedsAfter = fake.calls.filter((c) => c.kind === "embed").length;
    ok("PH-1.4a", "first match returns the original ids", first?.productIds[0] === "gid://shopify/Product/1001");
    ok("PH-1.4b", "edited productIds served immediately (same process, triggers unchanged)", second?.productIds[0] === "gid://shopify/Product/2002" && second?.title === "QA best sellers v2", JSON.stringify(second?.productIds));
    ok("PH-1.4c", "trigger vectors were cached (no re-embed on the id edit)", embedsAfter === embedsBefore);

    // Per-entry eviction: a foreign tenant's entry survives our refills.
    const cache = g.recVectorCache!;
    cache.set("qa-other-shop:fp", new Map([["x", [[1]]]]));
    await db.recommendation.updateMany({ where: { id: rec.id, shopId }, data: { triggerQuestions: [trigger, "qa top picks"] } });
    await recommendationMatch(shopId, q);
    const ours = [...cache.keys()].filter((k) => k.startsWith(`${shopId}:`));
    ok("PH-1.4d", "trigger edit replaces this shop's stale fingerprint (one entry)", ours.length === 1, `entries=${ours.length}`);
    ok("PH-1.4e", "another tenant's cache entry is untouched", cache.has("qa-other-shop:fp"));
    for (let i = 0; i < 510; i++) cache.set(`qa-filler-${i}:fp`, new Map());
    await db.recommendation.updateMany({ where: { id: rec.id, shopId }, data: { triggerQuestions: [trigger] } });
    await recommendationMatch(shopId, q);
    ok("PH-1.4f", "over 500 entries → oldest-first eviction, not a global clear", cache.size === 500 && cache.has(`qa-filler-509:fp`) && [...cache.keys()].some((k) => k.startsWith(`${shopId}:`)), `size=${cache.size}`);
    for (const k of [...cache.keys()]) if (k.startsWith("qa-")) cache.delete(k);
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Phases 2–4 — grounding, conversation quality, cost/observability
// ═════════════════════════════════════════════════════════════════════════════
const routeJson = (intent: "buy" | "question" | "chat", keywords: string[] = []) =>
  JSON.stringify({ intent, keywords, price_max: null, blocked: false, blocked_reason: "", off_topic: false, off_topic_reason: "" });

async function phase2to4(db: Db, shopId: string, shopBId: string, h: Helpers): Promise<void> {
  const { Prisma } = await import("@prisma/client");
  const emb = await import("../../app/lib/embeddings/embedding.server");
  const { runPipeline } = await import("../../app/lib/pipeline/index.server");
  type Frame = import("../../app/lib/pipeline/index.server").PipelineFrame;
  const { createTrace } = await import("../../app/lib/pipeline/trace.server");
  const { invalidateShopConfig, getShopConfig } = await import("../../app/lib/config/shop-config.server");
  const { canned, recommendationBanner } = await import("../../app/lib/pipeline/canned.server");
  const { hybridProductSearch } = await import("../../app/lib/search/product-search.server");
  const { knowledgeSearch } = await import("../../app/lib/search/knowledge-search.server");
  const { curatedMatch } = await import("../../app/lib/search/curated-match.server");
  const { shownProducts } = await import("../../app/lib/pipeline/detail.server");
  const H = await import("../../app/lib/pipeline/handover.server");
  const { handoverConfigSchema } = await import("../../app/lib/settings/schemas");
  const prompts = await import("../../app/lib/pipeline/prompts");
  const { htmlToText } = await import("../../app/lib/ingestion/fetchers.server");
  const { ingestSource } = await import("../../app/lib/ingestion/knowledge-ingest.server");

  const vec = async (table: string, id: string, forShop: string, v: number[]) => {
    await db.$executeRaw(Prisma.sql`UPDATE ${Prisma.raw(`"${table}"`)} SET "embedding" = ${emb.toSqlVector(v)}::vector WHERE "id" = ${id} AND "shopId" = ${forShop}`);
  };
  // The English fallback every pre-spec-24 install stored (new installs seed it
  // blank). Existing rows still carry it, so the suite keeps using it.
  const { LEGACY_INSTALL_FALLBACK: INSTALL_FALLBACK } = await import("../../app/lib/ai-defaults");

  // ── shared fixtures: catalogue (inserted BEFORE any search fills the lexicon cache) ──
  const mk = (n: number, title: string, description = "", extra: Record<string, unknown> = {}) =>
    db.product.create({ data: { shopId, shopifyProductId: `gid://shopify/Product/${n}`, title, description, stock: 5, price: 20, handle: `p${n}`, ...extra } });
  const rose = await mk(101, "Rose Quartz Bracelet", "A pink stone bracelet.");
  const ruling = await mk(102, "Ruling Planet Bracelet", "Astrology bracelet.");
  await mk(103, "Ankle Boots", "Leather boots.");
  await mk(104, "Brass Lantern", "Our lanterns glow warmly.");
  await mk(105, "Gant Leather Gloves", "Warm gloves.");
  await vec("products", rose.id, shopId, basis(100));
  await db.guardrails.create({ data: { shopId, bannedTopics: ["gambling"], fallbackMessage: INSTALL_FALLBACK, minMeaningScore: 0.3 } });
  await db.discount.create({ data: { shopId, shopifyDiscountId: "gid://shopify/DiscountCodeNode/1", title: "QA Summer", summary: "20% off", code: "QAPH20", status: "active" } });
  invalidateShopConfig(shopId);

  let sessionSeq = 0;
  const newSession = () => `qa-ph-s${++sessionSeq}-${Date.now()}`;
  const turn = async (message: string, session: string, conversationId?: string) => {
    const trace = createTrace(true);
    const start = fake.calls.length;
    const frames: Frame[] = [];
    for await (const f of runPipeline({ shopId, sessionId: session, conversationId, message }, trace)) frames.push(f);
    const done = frames.find((f): f is Extract<Frame, { type: "done" }> => f.type === "done");
    return {
      frames,
      outcome: done?.outcome ?? "",
      conversationId: done?.conversationId ?? "",
      text: frames.map((f) => (f.type === "message" || f.type === "token" ? f.text : "")).join(""),
      calls: fake.calls.slice(start),
      steps: trace.steps(),
    };
  };
  const replyPrompt = (calls: RecordedCall[]) => calls.filter((c) => c.kind === "stream" && c.purpose === "reply").map((c) => c.user).join("\n");
  const routes: Array<[string, string]> = [];
  fake.router = (user) => routes.find(([needle]) => user.includes(needle))?.[1] ?? routeJson("chat");

  // ── 2.1 sub-threshold chunks never ground the question lane ────────────────
  await kase("PH-2.1", async () => {
    fake.tags.push(["qa-disc", basis(40)]);
    const weak = await db.knowledge.create({ data: { shopId, topic: "Loyalty", body: "QA-WEAK-CHUNK loyalty points expire yearly." } });
    await vec("knowledge", weak.id, shopId, mix(0.2, 40, 41));
    routes.push(["qa-disc", routeJson("question")]);
    const t1 = await turn("qa-disc any discount codes right now?", newSession());
    const p1 = replyPrompt(t1.calls);
    ok("PH-2.1a", "discount-intent turn with only sub-threshold hits still gets discount facts", p1.includes("QAPH20"), `outcome=${t1.outcome}`);
    ok("PH-2.1b", "…and the sub-threshold chunk is NOT in the prompt", p1.length > 0 && !p1.includes("QA-WEAK-CHUNK"));
    const strong = await db.knowledge.create({ data: { shopId, topic: "Shipping", body: "QA-STRONG-CHUNK shipping is free over 50." } });
    await vec("knowledge", strong.id, shopId, mix(0.9, 40, 42));
    const p2 = replyPrompt((await turn("qa-disc any discount codes right now?", newSession())).calls);
    ok("PH-2.1c", "mixed hits: the strong chunk grounds, the weak one is filtered", p2.includes("QA-STRONG-CHUNK") && !p2.includes("QA-WEAK-CHUNK"));
  });

  // ── 2.2 rejected meaning/curated promise → the turn continues ──────────────
  await kase("PH-2.2", async () => {
    await db.guardrails.updateMany({ where: { shopId }, data: { bannedTopics: ["gambling", "qa-embed-fail topic"] } });
    invalidateShopConfig(shopId);
    fake.tags.unshift(["qa-dim-mismatch", new Array<number>(1535).fill(0.01)]); // toSqlVector throws in curatedMatch
    const t = await turn("qa-dim-mismatch hello there", newSession());
    ok("PH-2.2a", "both vector layers failed yet the pipeline reached the chat lane", t.outcome === "chat" && t.text.length > 0, `outcome=${t.outcome}`);
    ok("PH-2.2b", "meaning-scan failure logged", !!(await h.waitForLog("meaning_scan_error", shopId)));
    ok("PH-2.2c", "curated-match failure logged", !!(await h.waitForLog("curated_match_error", shopId)));
    fake.tags.shift();
    await db.guardrails.updateMany({ where: { shopId }, data: { bannedTopics: ["gambling"] } });
    invalidateShopConfig(shopId);
  });

  // ── 2.3 detail lane never re-cards archived/unpublished products ───────────
  await kase("PH-2.3", async () => {
    const convo = await db.conversation.create({ data: { shopId, sessionId: newSession() } });
    await db.message.create({ data: { shopId, conversationId: convo.id, role: "out", content: "these", sourceLayer: "buy", productCards: [{ shopifyProductId: ruling.shopifyProductId, title: ruling.title }] } });
    ok("PH-2.3a", "active product is recovered", (await shownProducts(shopId, convo.id)).length === 1);
    await db.product.updateMany({ where: { id: ruling.id, shopId }, data: { status: "archived" } });
    ok("PH-2.3b", "archived product is no longer a detail candidate", (await shownProducts(shopId, convo.id)).length === 0);
    await db.product.updateMany({ where: { id: ruling.id, shopId }, data: { status: "active", publishedOnline: false } });
    ok("PH-2.3c", "unpublished product is no longer a detail candidate", (await shownProducts(shopId, convo.id)).length === 0);
    await db.product.updateMany({ where: { id: ruling.id, shopId }, data: { publishedOnline: true } });
  });

  // ── 2.4 + B5 curated synonym lane ──────────────────────────────────────────
  await kase("PH-2.4", async () => {
    await db.curatedAnswer.create({ data: { shopId, question: "Is delivery free?", synonyms: ["free delivery", "envío gratis", "sale"], talkingPoints: "Yes.", status: "published" } });
    const hit = await curatedMatch(shopId, basis(70), "Do you offer FREE delivery??");
    ok("PH-2.4a", "NULL-embedding answer + matching synonym → curated hit at score 1", hit?.synonymHit === true && hit.score === 1, JSON.stringify(hit && { s: hit.score, q: hit.question }));
    const accent = await curatedMatch(shopId, basis(70), "¿Tienen envío gratis?");
    ok("PH-2.4b", "accented synonym matches on unicode normalization (B5)", accent?.synonymHit === true);
    const whole = await curatedMatch(shopId, basis(70), "wholesale prices please");
    ok("PH-2.4c", "synonyms match whole words only (\"sale\" ≠ \"wholesale\")", !whole?.synonymHit);
    const none = await curatedMatch(shopId, basis(70), "what time do you open");
    ok("PH-2.4d", "no synonym → the NULL-embedding row takes no part in the vector lane", !none || none.question !== "Is delivery free?", JSON.stringify(none?.question));
  });

  // ── 2.5 / 3.6 / 3.10 / 4.3 keyword lane ────────────────────────────────────
  const search = (keywords: string[], message: string) =>
    hybridProductSearch({ shopId, queryEmbedding: basis(200), keywords, message, minMeaningScore: 0.3 });
  const terms = (rows: Array<{ matchedTerms: string[] }>) => [...new Set(rows.flatMap((r) => r.matchedTerms))];

  await kase("PH-4.3", async () => {
    const g = global as unknown as { dfCacheStore?: Map<string, unknown> };
    g.dfCacheStore?.delete(shopId);
    const client = db as unknown as { $queryRaw: (...args: unknown[]) => unknown };
    const original = client.$queryRaw;
    let dfQueries = 0;
    let anyQueries = 0;
    client.$queryRaw = function (this: unknown, ...args: unknown[]) {
      anyQueries++;
      const q = args[0] as { sql?: string; strings?: string[] } | undefined;
      const text = q?.sql ?? q?.strings?.join("?") ?? "";
      if (/count\(\*\)::int AS n/.test(text)) dfQueries++;
      return (original as (...a: unknown[]) => unknown).apply(db, args);
    };
    try {
      const first = await search([], "gant leather gloves");
      const dfFirst = dfQueries;
      const second = await search([], "gant leather gloves");
      if (anyQueries === 0) {
        skip("PH-4.3a", "could not intercept $queryRaw on the Prisma client (proxy) — cache-state evidence only");
      } else {
        ok("PH-4.3a", "first query runs the DF scan", dfFirst >= 1, `df=${dfFirst}`);
        ok("PH-4.3b", "second identical query within TTL issues NO DF SQL", dfQueries === dfFirst, `df=${dfQueries}`);
      }
      ok("PH-4.3c", "ranking unchanged between cold and cached DF", JSON.stringify(first.map((r) => [r.id, r.coverage])) === JSON.stringify(second.map((r) => [r.id, r.coverage])));
      ok("PH-4.3d", "DF cache holds this shop's entry", g.dfCacheStore?.has(shopId) === true);
    } finally {
      client.$queryRaw = original;
    }
  });

  await kase("PH-2.5", async () => {
    const rows = await search(["rulling"], "rulling");
    ok("PH-2.5a", "router-echoed typo \"rulling\" is corrected into the keyword lane", terms(rows).includes("ruling") && rows.some((r) => r.id === ruling.id), JSON.stringify(terms(rows)));
    ok("PH-2.5b", "the raw typo does not re-enter the message tier", !terms(rows).includes("rulling"));
  });

  await kase("PH-3.6", async () => {
    const anklet = await search([], "anklet");
    ok("PH-3.6a", "DEFECT-CHECK: not-stocked common word \"anklet\" does not snap to \"ankle\"", !terms(anklet).includes("ankle"), `matched=${JSON.stringify(terms(anklet))} (trigram 0.625 ≥ 0.6 floor, runner-up far below; spec's dictionary stoplist was dropped)`);
    const lanterm = await search([], "lanterm");
    ok("PH-3.6b", "DEFECT-CHECK: a clear typo still corrects when singular+plural both exist (lantern/lanterns)", terms(lanterm).includes("lantern"), `matched=${JSON.stringify(terms(lanterm))} (0.600 vs 0.545 → margin 0.055 < 0.08)`);
    ok("PH-3.6c", "floor 0.6 + margin 0.08 present in code", /bestScore >= 0\.6 && bestScore - runnerUp >= 0\.08/.test(src("app/lib/search/product-search.server.ts")));
  });

  await kase("PH-3.10", async () => {
    const accented = await search([], "élégant");
    ok("PH-3.10a", "accented query yields no fragment terms (\"gant\"/\"l\")", !terms(accented).some((t) => t === "gant" || t === "l"), JSON.stringify(terms(accented)));
    const hindi = await search([], "नमस्ते bracelet");
    ok("PH-3.10b", "mixed-script query matches only whole words", terms(hindi).every((t) => t === "bracelet" || t === "नमस्ते" || t.includes("bracelet")) && terms(hindi).includes("bracelet"), JSON.stringify(terms(hindi)));
  });

  // ── 2.6 / 2.7 / 3.1 webhook vs full sync (shop B, Shopify stubbed) ─────────
  await kase("PH-2.6", async () => {
    const { upsertProductFromWebhook, fullCatalogSync } = await import("../../app/lib/ingestion/catalog-sync.server");
    const { applyMetafieldSelection, hashText } = await import("../../app/lib/ingestion/metafields.server");
    const decoded = "Salt & Pepper Mill — hand's best";
    const sizes = Array.from({ length: 14 }, (_, i) => `${6 + i}mm`);
    let fullSyncDescription = decoded;
    stub.gql = (query) => {
      if (query.includes("CatalogSyncProductMetafields")) return { data: { product: { metafields: { nodes: [] }, variants: { nodes: [] } } } };
      if (query.includes("CatalogSyncProducts")) {
        return { data: { products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{
          id: "gid://shopify/Product/9001", title: "QA Mill", description: fullSyncDescription, productType: "Kitchen", vendor: "QA", tags: ["salt", "pepper"],
          status: "ACTIVE", handle: "qa-mill", onlineStoreUrl: null, publishedAt: "2026-01-01T00:00:00Z", featuredMedia: null,
          priceRangeV2: { minVariantPrice: { amount: "10.0" } }, totalInventory: 5,
          variants: { nodes: sizes.map((t, i) => ({ id: `gid://shopify/ProductVariant/${i + 1}`, title: t, price: "10.0", availableForSale: true, metafields: { nodes: [] } })) },
          metafields: { nodes: [] },
        }] } } };
      }
      return { data: {} };
    };
    const payload = {
      admin_graphql_api_id: "gid://shopify/Product/9001", id: 9001, title: "QA Mill",
      body_html: "<p>Salt &amp; Pepper&nbsp;Mill — hand&#39;s best</p>", product_type: "Kitchen", vendor: "QA", tags: "salt, pepper",
      status: "active", handle: "qa-mill", published_at: "2026-01-01T00:00:00Z",
      variants: sizes.map((t, i) => ({ id: i + 1, title: t, price: "10.0", inventory_quantity: 1 })),
    };
    const embedCount = () => fake.calls.filter((c) => c.kind === "embed" && (c.texts ?? []).some((x) => x.startsWith("QA Mill"))).length;
    await upsertProductFromWebhook(DOMAIN_B, payload);
    const w = await db.product.findFirst({ where: { shopId: shopBId, shopifyProductId: "gid://shopify/Product/9001" } });
    ok("PH-2.6a", "webhook description has entities decoded", w?.description === decoded, JSON.stringify(w?.description));
    ok("PH-2.7a", "webhook stores all 14 variants", Array.isArray(w?.variants) && (w?.variants as unknown[]).length === 14);
    const e0 = embedCount();
    await fullCatalogSync(DOMAIN_B);
    const f = await db.product.findFirst({ where: { shopId: shopBId, shopifyProductId: "gid://shopify/Product/9001" } });
    ok("PH-2.6b", "full-sync description byte-identical to the webhook's", f?.description === w?.description);
    ok("PH-2.6c", "contentHash stable across webhook → full sync", !!w?.contentHash && f?.contentHash === w?.contentHash);
    ok("PH-2.6d", "no re-embed on the path alternation", embedCount() === e0, `embeds ${e0} → ${embedCount()}`);
    ok("PH-2.7b", "full sync stores all 14 variants", Array.isArray(f?.variants) && (f?.variants as unknown[]).length === 14);
    fullSyncDescription = "Salt & Pepper Mill — hand's best";
    await fullCatalogSync(DOMAIN_B);
    const nb = await db.product.findFirst({ where: { shopId: shopBId, shopifyProductId: "gid://shopify/Product/9001" } });
    ok("PH-2.6e", "even if Shopify's description keeps U+00A0, the hash does not flip", nb?.contentHash === w?.contentHash);
    await upsertProductFromWebhook(DOMAIN_B, payload);
    ok("PH-2.6f", "repeat webhook → no re-embed", embedCount() === e0);
    const applied = await applyMetafieldSelection(shopBId);
    ok("PH-2.7c", "applyMetafieldSelection agrees on the hash (variants selected) → 0 changed", applied.changed === 0, `changed=${applied.changed}`);
    const text = emb.productEmbeddingText({ title: "QA Mill", productType: "Kitchen", vendor: "QA", tags: ["salt", "pepper"], variants: nb?.variants, description: nb?.description, metafieldText: "" });
    ok("PH-2.7d", "embedding text carries the Options line", text.includes(`Options: ${sizes.join(", ")}`), text.slice(0, 120));
    ok("PH-2.7e", "stored hash == hash of the canonical formula", hashText(text) === nb?.contentHash);
    const cs = src("app/lib/ingestion/catalog-sync.server.ts");
    ok("PH-2.7f", "both sync queries fetch variants(first: 50), none at 10", (cs.match(/variants\(first: 50\)/g) ?? []).length === 2 && !/variants\(first: 10\)/.test(cs));
    ok("PH-2.7g", "re-embed script + metafield apply select variants", /tags: true, variants: true/.test(src("scripts/reembed-products.ts")) && /variants: true, metafields: true/.test(src("app/lib/ingestion/metafields.server.ts")));
    stub.gql = null;
  });

  await kase("PH-3.1", async () => {
    const long = "SEO prose ".repeat(700); // 7,000 chars
    const text = emb.productEmbeddingText({ title: "Obsidian Bracelet", productType: "Bracelet", vendor: "QA", tags: ["black"], variants: [{ title: "8mm" }, { title: "Default Title" }], metafieldText: "Material: Obsidian", description: long });
    const idx = (s: string) => text.indexOf(s);
    ok("PH-3.1a", "order: title · type · vendor · tags · options · metafields · description", idx("Obsidian Bracelet") === 0 && idx("Bracelet. QA") > 0 && idx("QA. black") > 0 && idx("Options: 8mm") > idx("black") && idx("Material: Obsidian") > idx("Options") && idx("SEO prose") > idx("Material"), text.slice(0, 90));
    ok("PH-3.1b", "description contribution capped at 2,000 chars; metafields survive the 8,000 cap", text.length - idx("SEO prose") <= 2000 && text.length < 8000);
    ok("PH-3.1c", "\"Default Title\" variants are not folded in", !text.includes("Default Title"));
    const golden = src("scripts/eval-golden.ts");
    ok("PH-3.1d", "SEO-prose traps stay in the golden set (black bracelets / selenite)", golden.includes("show me black bracelets") && golden.includes("selenite"));
  });

  // ── 3.2 / 3.9 blocked + localized deterministic strings ────────────────────
  await kase("PH-3.2", async () => {
    const t = await turn("any gambling tips for me", newSession());
    ok("PH-3.2a", "guardrail-blocked turn serves the blocked copy (English shop unchanged)", t.outcome === "blocked" && t.text === canned("blockedTopic", null), t.text);
    ok("PH-3.2b", "no dangling email promise and no form", !/email/i.test(t.text) && !t.frames.some((f) => f.type === "handover"));
    ok("PH-3.2c", "zero generation calls on a blocked turn", t.calls.filter((c) => c.kind !== "embed").length === 0, `calls=${t.calls.map((c) => c.purpose).join(",")}`);
  });

  await kase("PH-3.9", async () => {
    const keys = ["clarify", "fallback", "busy", "orderStatus", "blockedTopic", "cap", "humanWait", "picksOnly", "chatClosed", "offTopic"] as const;
    const langs = ["hi", "es", "fr", "de"];
    ok("PH-3.9a", "every canned string exists in en/hi/es/fr/de and differs from English", keys.every((k) => langs.every((l) => { const s = canned(k, { defaultLanguage: l, autoDetectLanguage: false }); return s.length > 0 && s !== canned(k, null); })));
    ok("PH-3.9b", "auto-detect ON and unknown languages stay English", keys.every((k) => canned(k, { defaultLanguage: "es", autoDetectLanguage: true }) === canned(k, null) && canned(k, { defaultLanguage: "xx", autoDetectLanguage: false }) === canned(k, null)));
    ok("PH-3.9c", "recommendation banner localized", recommendationBanner("Best", { defaultLanguage: "fr", autoDetectLanguage: false }) !== recommendationBanner("Best", null));
    await db.persona.create({ data: { shopId, defaultLanguage: "es", languages: ["es"], autoDetectLanguage: false } });
    invalidateShopConfig(shopId);
    const blocked = await turn("hablame de gambling", newSession());
    ok("PH-3.9d", "Spanish shop: blocked turn in Spanish", blocked.text === canned("blockedTopic", { defaultLanguage: "es" }), blocked.text);
    routes.push(["qa-unparseable", "not json at all"]);
    const clarify = await turn("qa-unparseable hola", newSession());
    ok("PH-3.9e", "Spanish shop: clarify in Spanish", clarify.outcome === "clarify" && clarify.text === canned("clarify", { defaultLanguage: "es" }), clarify.text);
    routes.push(["qa-nofacts", routeJson("question")]);
    const fb = await turn("qa-nofacts cual es la garantia", newSession());
    ok("PH-3.9f", "DEFECT-CHECK: Spanish shop with the INSTALL-default guardrails row gets the fallback in Spanish", fb.outcome.startsWith("fell_back") || fb.outcome === "handover" ? fb.text.startsWith(canned("fallback", { defaultLanguage: "es" })) : false, `outcome=${fb.outcome} text="${fb.text.slice(0, 70)}" (install.server.ts seeds an English fallbackMessage, which 'merchant text wins' then always serves)`);
    await db.persona.deleteMany({ where: { shopId } });
    invalidateShopConfig(shopId);
  });

  // ── 3.3 discount facts reach the buy lane ──────────────────────────────────
  await kase("PH-3.3", async () => {
    fake.tags.push(["qa-deals", basis(100)], ["qa-nodeal", basis(100)]);
    routes.push(["qa-deals", routeJson("buy", ["bracelet"])], ["qa-nodeal", routeJson("buy", ["bracelet"])]);
    fake.stream = () => ["PICKS: 1\n", "This one fits."];
    const t = await turn("qa-deals any deals on bracelets?", newSession());
    ok("PH-3.3a", "discount-worded buy turn: discount facts in the buy prompt", t.outcome.startsWith("buy") && replyPrompt(t.calls).includes("QAPH20"), `outcome=${t.outcome}`);
    const n = await turn("qa-nodeal show me bracelets", newSession());
    ok("PH-3.3b", "plain buy turn: no discount block", n.outcome.startsWith("buy") && !replyPrompt(n.calls).includes("QAPH20"));
    ok("PH-3.3c", "prompt rule for citing only listed codes still present", /never invent/i.test(prompts.PRODUCT_RECOMMEND) || /discount/i.test(src("app/lib/pipeline/index.server.ts")));
    fake.stream = () => ["Happy to help!"];
  });

  // ── 3.4 PICKS: none prompt contract (+ one live check) ─────────────────────
  await kase("PH-3.4", async () => {
    ok("PH-3.4a", "card claim is conditional on picks", prompts.PRODUCT_RECOMMEND.includes("After `PICKS: none` there are no cards, so do not name or describe any candidate"));
    ok("PH-3.4b", "none branch asks a redirect question; no \"closest alternative\"", /ask one short question/i.test(prompts.PRODUCT_RECOMMEND) && !/closest alternative/i.test(prompts.PRODUCT_RECOMMEND));
    ok("PH-3.4c", "golden set keeps the diamond-necklace trap", src("scripts/eval-golden.ts").includes("a fancy diamond necklace"));
    if (!process.env.OPENAI_API_KEY) {
      skip("PH-3.4d", "OPENAI_API_KEY not set — live PICKS: none check skipped");
      return;
    }
    const { OpenAiProvider } = await import("../../app/lib/llm/openai.server");
    const live = new OpenAiProvider();
    const reply = await live.chat(
      [
        { role: "system", content: `You are a helpful shop assistant.\n${prompts.PRODUCT_RECOMMEND}` },
        { role: "user", content: `Candidate products: ${JSON.stringify([{ id: 1, title: "Rose Quartz Bracelet", price: "$20", snippet: "pink stone bracelet" }, { id: 2, title: "Brass Lantern", price: "$30", snippet: "glows warmly" }])}\n\nShopper: a fancy diamond necklace` },
      ],
      { shopId: "", purpose: "reply" },
      { temperature: 0.3, maxTokens: 110 },
    );
    ok("PH-3.4d", "LIVE: PICKS: none and no candidate named in the prose", /^\s*\**PICKS:\**\s*none/i.test(reply) && !/rose quartz|lantern/i.test(reply.split("\n").slice(1).join(" ")), JSON.stringify(reply.slice(0, 140)));
  });

  // ── 3.5 handover heuristics ────────────────────────────────────────────────
  await kase("PH-3.5", async () => {
    const hsrc = src("scripts/qa/handover.test.ts");
    ok("PH-3.5a", "handover.test.ts covers pre-answer caps, enthusiastic caps, ??? and banned_keyword/meaning (reference)", ["pre-answer: nothing fires before the AI has replied", "enthusiastic caps do not trigger", "impatient ??? without negative words does not trigger", "keyword/meaning guardrail blocks count too", "typo-level rephrase still counts"].every((s) => hsrc.includes(s)));
    const sentiment = handoverConfigSchema.parse({ triggers: { negativeSentiment: { enabled: true } } });
    const convo = await db.conversation.create({ data: { shopId, sessionId: newSession() } });
    const detect = (message: string) => H.detectHandover({ shopId, conversationId: convo.id, message, queryEmbedding: null, handover: sentiment });
    ok("PH-3.5b", "all-caps FIRST message (even with a negative word) → no handover", (await detect("SHOW ME RED BRACELETS THIS IS TERRIBLE")) === null);
    await db.message.create({ data: { shopId, conversationId: convo.id, role: "out", content: "Here you go", sourceLayer: "buy" } });
    ok("PH-3.5c", "after an AI reply, caps + negative word → negative_sentiment", (await detect("THIS IS TERRIBLE AND BROKEN")) === "negative_sentiment");
    ok("PH-3.5d", "after an AI reply, enthusiastic caps alone → no handover", (await detect("SHOW ME RED BRACELETS PLEASE")) === null);

    // Pipeline level: 3 consecutive KEYWORD blocks.
    // Since the QA2-A7 fix the 3rd block itself hands over, so each check runs
    // on its own conversation (a handed-over thread no longer ends in 3 blocks).
    const s = newSession();
    const b1 = await turn("gambling odds today", s);
    await turn("tell me about gambling please", s, b1.conversationId);
    ok("PH-3.5e", "detectCannotAnswer counts banned_keyword turns (threshold 2 after two blocks)", await H.detectCannotAnswer(shopId, b1.conversationId, handoverConfigSchema.parse({ triggers: { cannotAnswer: { enabled: true, threshold: 2 } } })));
    const b3 = await turn("is gambling allowed here", s, b1.conversationId);
    ok("PH-3.5f", "DEFECT-CHECK: the 3rd consecutive keyword block triggers the cannot-answer handover (spec Accept)", b3.outcome === "handover" || b3.frames.some((f) => f.type === "handover"), `outcome=${b3.outcome} — finishBlocked never calls maybeEscalateCannotAnswer (router blocks behave the same)`);
    const s2 = newSession();
    const g1 = await turn("gambling odds today", s2);
    await turn("tell me about gambling please", s2, g1.conversationId);
    const c4 = await turn("qa-unparseable hmm", s2, g1.conversationId);
    ok("PH-3.5g", "banned + banned + clarify escalates on the clarify turn (count parity)", c4.outcome === "handover", `outcome=${c4.outcome}`);
    const embedsBefore = fake.calls.filter((c) => c.kind !== "stream").length;
    const rep = handoverConfigSchema.parse({ triggers: { repeatedQuestion: { enabled: true, threshold: 2 }, negativeSentiment: { enabled: true } } });
    await db.message.create({ data: { shopId, conversationId: convo.id, role: "in", content: "where is my refund" } });
    await db.message.create({ data: { shopId, conversationId: convo.id, role: "in", content: "where is my refundd" } });
    const repeatTrigger = await H.detectHandover({ shopId, conversationId: convo.id, message: "where is my refundd", queryEmbedding: null, handover: rep });
    ok("PH-3.5h", "cost budget: typo-level repeat fires with zero model/embedding calls", repeatTrigger === "repeated_question" && fake.calls.filter((c) => c.kind !== "stream").length === embedsBefore, `trigger=${repeatTrigger}`);
  });

  // ── 3.7 near-duplicate suppression + html chrome ───────────────────────────
  await kase("PH-3.7", async () => {
    const s1 = await db.dataSource.create({ data: { shopId, type: "manual", name: "QA dup 1", status: "active" } });
    const s2 = await db.dataSource.create({ data: { shopId, type: "faq", name: "QA dup 2", status: "active" } });
    const body = "Returns are accepted within thirty days of delivery for unworn items in original packaging with a receipt.";
    const rows: Array<[string, string | null, string, number[]]> = [
      ["a", s1.id, body, mix(0.95, 50, 51)],
      ["b", s2.id, body, mix(0.94, 50, 52)],
      ["c", s2.id, body.replace("thirty", "30"), mix(0.93, 50, 55)],
      ["d", s1.id, "Shipping takes three to five business days across the country with tracking included.", mix(0.9, 50, 53)],
      ["e", s1.id, "Gift cards never expire and can be used online or in any of our physical stores.", mix(0.85, 50, 54)],
    ];
    for (const [topic, ds, b, v] of rows) {
      const k = await db.knowledge.create({ data: { shopId, dataSourceId: ds, topic: `dup-${topic}`, body: b } });
      await vec("knowledge", k.id, shopId, v);
    }
    const hits = (await knowledgeSearch(shopId, basis(50), 3)).filter((x) => x.score > 0.5);
    ok("PH-3.7a", "identical + near-verbatim copies from different sources occupy ONE slot", hits.length === 3 && hits.filter((x) => x.body.startsWith("Returns")).length === 1 && hits[0].topic === "dup-a", hits.map((x) => x.topic).join(","));
    const html = htmlToText("<nav>Menu Home Shop</nav><header><h1>Size guide</h1></header><main><p>Rings run true to size.</p></main><aside>Cookie consent banner</aside><footer>© Brand | Free shipping</footer>");
    ok("PH-3.7b", "htmlToText drops nav/aside/footer content, keeps header", /Size guide/.test(html.text) && /Rings run/.test(html.text) && !/Menu|Cookie|Free shipping/.test(html.text), JSON.stringify(html.text));
    stub.pages.set("/t1", "<html><head><title>A | Brand</title></head><body><p>short title page body text.</p></body></html>");
    const { fetchPageText } = await import("../../app/lib/ingestion/fetchers.server");
    const p = await fetchPageText(`http://${FAKE_HOST}/t1`);
    ok("PH-3.7e", "a uselessly short first title segment keeps the full title", p.title === "A | Brand", p.title);
  });

  // ── 3.8 borderline curated confirm carries the previous turn ───────────────
  await kase("PH-3.8", async () => {
    const ca = await db.curatedAnswer.create({ data: { shopId, question: "What are your best sellers?", talkingPoints: "Our top picks.", status: "published" } });
    await vec("curated_answers", ca.id, shopId, mix(0.7, 80, 81));
    fake.tags.push(["qa-popular", basis(80)]);
    const s = newSession();
    const t1 = await turn("qa-first show me your bracelets", s);
    const t2 = await turn("qa-popular and the popular ones?", s, t1.conversationId);
    const confirm = t2.calls.find((c) => c.user.includes("Does this shopper message mean the same as the question"));
    ok("PH-3.8a", "borderline curated confirm was asked", !!confirm, `outcome=${t2.outcome}`);
    ok("PH-3.8b", "confirm includes the previous shopper turn", confirm?.user.includes("qa-first show me your bracelets") === true, confirm?.user.slice(0, 120));
    ok("PH-3.8c", "prior turn truncated to 200 chars; empty prior keeps the original format", prompts.curatedConfirmUser("m", "q", "x".repeat(500)).includes("x".repeat(200) + "\n") && !prompts.curatedConfirmUser("m", "q", "x".repeat(500)).includes("x".repeat(201)) && prompts.curatedConfirmUser("m", "q") === "Does this shopper message mean the same as the question: q\nMessage: m");
    await db.curatedAnswer.deleteMany({ where: { id: ca.id, shopId } });
  });

  // ── 4.1 intent-rule threshold from config ──────────────────────────────────
  await kase("PH-4.1", async () => {
    fake.tags.push(["qa cancel order", basis(20)]);
    const convo = await db.conversation.create({ data: { shopId, sessionId: newSession() } });
    const q = mix(0.7, 20, 21);
    const detect = (cfg: unknown) => H.detectHandover({ shopId, conversationId: convo.id, message: "", queryEmbedding: q, handover: handoverConfigSchema.parse(cfg) });
    ok("PH-4.1a", "default parse → intentRuleThreshold 0.5", handoverConfigSchema.parse({}).intentRuleThreshold === 0.5);
    ok("PH-4.1b", "score 0.7 fires at the 0.5 default", (await detect({ intentRules: [{ topic: "qa cancel order" }] })) === "intent_rule");
    ok("PH-4.1c", "score 0.7 does NOT fire when the config says 0.9", (await detect({ intentRules: [{ topic: "qa cancel order" }], intentRuleThreshold: 0.9 })) === null);
    ok("PH-4.1d", "out-of-range value falls back to 0.5", handoverConfigSchema.parse({ intentRuleThreshold: 7 }).intentRuleThreshold === 0.5);
    const { saveHandoverConfig } = await import("../../app/lib/instructions/save.server");
    await saveHandoverConfig(shopId, { intentRules: [{ topic: "qa cancel order" }], intentRuleThreshold: 0.9 });
    const cfg = await getShopConfig(shopId);
    ok("PH-4.1e", "threshold persists in the stored handover row and reaches the runtime config", cfg.handover.intentRuleThreshold === 0.9);
    await saveHandoverConfig(shopId, { intentRules: [{ topic: "qa cancel order" }] });
    const reset = (await getShopConfig(shopId)).handover.intentRuleThreshold;
    console.log(`  NOTE PH-4.1 a handover save whose payload omits intentRuleThreshold resets it to ${reset} (no UI field yet)`);
    await db.handoverConfig.deleteMany({ where: { shopId } });
    invalidateShopConfig(shopId);
  });

  // ── 4.2 detail-confirm pre-filter ──────────────────────────────────────────
  await kase("PH-4.2", async () => {
    const s = newSession();
    const convo = await db.conversation.create({ data: { shopId, sessionId: s } });
    await db.message.create({ data: { shopId, conversationId: convo.id, role: "out", content: "these", sourceLayer: "buy", productCards: [{ shopifyProductId: rose.shopifyProductId, title: rose.title }] } });
    const isConfirm = (c: RecordedCall) => c.user.includes("Products already shown to this shopper");
    const thanks = await turn("thanks!", s, convo.id);
    ok("PH-4.2a", "\"thanks!\" after cards makes no detail-confirm call", !thanks.calls.some(isConfirm) && thanks.outcome === "chat", `outcome=${thanks.outcome}`);
    ok("PH-4.2b", "trace records the skip", thanks.steps.some((st) => st.layer === "detail_confirm" && st.status === "skip"));
    fake.detailConfirm = (user) => (user.includes("8mm") ? "yes" : "no");
    fake.stream = (messages) => (messages[0]?.content.includes("DETAIL") ? ["DETAIL: 1\n", "It is listed without an 8mm option."] : ["Happy to help!"]);
    const mm = await turn("does it come in 8mm?", s, convo.id);
    ok("PH-4.2c", "\"does it come in 8mm?\" still pays the confirm and enters the detail lane", mm.calls.some(isConfirm) && mm.outcome === "detail", `outcome=${mm.outcome}`);
    const named = await turn("thanks for the rose quartz", s, convo.id);
    ok("PH-4.2d", "a shown title word keeps the confirm (when in doubt)", named.calls.some(isConfirm));
    fake.detailConfirm = () => "no";
    fake.stream = () => ["Happy to help!"];
  });

  // ── 4.4 key-less ingest is loud ────────────────────────────────────────────
  await kase("PH-4.4", async () => {
    const { env } = await import("../../app/lib/env.server");
    const { runtimeConfig, storedRuntimeConfig } = await import("../../app/lib/admin/runtime-config.server");
    if (storedRuntimeConfig().openaiApiKey) {
      skip("PH-4.4", "a dashboard-stored OpenAI key exists (admin:runtime) — cannot simulate key-less ingest without mutating global operator config");
      return;
    }
    const e = env() as { OPENAI_API_KEY: string };
    const saved = e.OPENAI_API_KEY;
    e.OPENAI_API_KEY = "";
    try {
      if (runtimeConfig().openaiApiKey) { skip("PH-4.4", "runtime key still present"); return; }
      const manual = await db.dataSource.create({ data: { shopId, type: "manual", name: "QA keyless", status: "pending", metadata: { question: "Keyless?", answer: "qa keyless answer" } } });
      await ingestSource(shopId, manual.id);
      const log = await h.waitForLog("embedding_skipped", shopId);
      ok("PH-4.4a", "embedding_skipped log line with the source id + chunk count", !!log && JSON.stringify(log.context ?? {}).includes(manual.id), JSON.stringify(log?.context ?? null));
      const event = await db.analyticsEvent.findFirst({ where: { shopId, type: "embedding_skipped" } });
      ok("PH-4.4b", "DEFECT-CHECK: analytics event embedding_skipped recorded (spec fix: mirror the product path log + recordEvent)", !!event);
      const row = await db.dataSource.findFirst({ where: { id: manual.id, shopId } });
      console.log(`  NOTE PH-4.4 key-less source ends status=${row?.status} with no visible flag (spec: acceptable with the event)`);
    } finally {
      e.OPENAI_API_KEY = saved;
    }
  });

  // ── 4.5 NULL-embedding telemetry ───────────────────────────────────────────
  await kase("PH-4.5", async () => {
    const { reportNullEmbeddings } = await import("../../app/lib/jobs/handlers.server");
    await reportNullEmbeddings();
    const log = await h.waitForLog("null_embeddings", shopId);
    const ctx = (log?.context ?? {}) as { products?: number; curatedAnswers?: number };
    ok("PH-4.5a", "shop with NULL-embedding rows → null_embeddings logged with counts", !!log && (ctx.products ?? 0) >= 1 && (ctx.curatedAnswers ?? 0) >= 1, JSON.stringify(ctx));
    ok("PH-4.5b", "fully embedded shop logs nothing", !(await h.waitForLog("null_embeddings", shopBId, 500)));
    ok("PH-4.5c", "wired into the nightly retention purge", /reportNullEmbeddings\(\)/.test(src("app/lib/jobs/handlers.server.ts")));
  });

  // ── 4.6 learn-off tombstones (shop B, Shopify stubbed) ─────────────────────
  await kase("PH-4.6", async () => {
    const { fullPageSync, fullArticleSync, ensureBridgeSource } = await import("../../app/lib/ingestion/content-sync.server");
    let pageIds: string[] = [];
    let articleIds: string[] = [];
    stub.gql = (query) => {
      if (query.includes("ContentSyncPages")) return { data: { pages: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: pageIds.map((id) => ({ id, title: `Page ${id.slice(-1)}`, handle: `p${id.slice(-1)}`, body: `<p>body ${id}</p>`, isPublished: true, updatedAt: "2026-09-01T00:00:00Z" })) } } };
      if (query.includes("ContentSyncArticles")) return { data: { articles: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: articleIds.map((id) => ({ id, title: `Art ${id.slice(-1)}`, handle: `a${id.slice(-1)}`, body: `<p>body ${id}</p>`, summary: null, tags: [], isPublished: true, updatedAt: "2026-09-01T00:00:00Z", author: null, blog: { id: "gid://shopify/Blog/1", title: "News" } })) } } };
      return { data: {} };
    };
    const P1 = "gid://shopify/Page/1";
    const P2 = "gid://shopify/Page/2";
    const learn = async (id: string) => (await db.storePage.findFirst({ where: { shopId: shopBId, shopifyPageId: id } }))?.learnEnabled;
    pageIds = [P1, P2];
    await fullPageSync(DOMAIN_B);
    await db.storePage.updateMany({ where: { shopId: shopBId, shopifyPageId: P2 }, data: { learnEnabled: false } });
    pageIds = [P1];
    const pr = await fullPageSync(DOMAIN_B);
    const bridgeId = await ensureBridgeSource(shopBId, "pages");
    const meta = (await db.dataSource.findFirst({ where: { id: bridgeId, shopId: shopBId } }))?.metadata as { learnDisabled?: string[] } | null;
    ok("PH-4.6a", "prune records the learn-off tombstone", pr?.pruned === 1 && (meta?.learnDisabled ?? []).includes(P2), JSON.stringify(meta));
    await ingestSource(shopBId, bridgeId).catch(() => undefined);
    const metaAfterIngest = (await db.dataSource.findFirst({ where: { id: bridgeId, shopId: shopBId } }))?.metadata as { learnDisabled?: string[] } | null;
    ok("PH-4.6b", "a bridge rebuild keeps the tombstone in metadata", (metaAfterIngest?.learnDisabled ?? []).includes(P2));
    pageIds = [P1, P2];
    await fullPageSync(DOMAIN_B);
    ok("PH-4.6c", "disable → prune → re-create → still disabled", (await learn(P2)) === false);
    pageIds = [P2];
    await fullPageSync(DOMAIN_B); // P1 pruned while ENABLED
    pageIds = [P1, P2];
    await fullPageSync(DOMAIN_B);
    ok("PH-4.6d", "a row pruned while enabled comes back enabled", (await learn(P1)) === true);
    const A1 = "gid://shopify/Article/1";
    articleIds = [A1];
    await fullArticleSync(DOMAIN_B);
    await db.blogArticle.updateMany({ where: { shopId: shopBId, shopifyArticleId: A1 }, data: { learnEnabled: false } });
    articleIds = [];
    await fullArticleSync(DOMAIN_B);
    articleIds = [A1];
    await fullArticleSync(DOMAIN_B);
    ok("PH-4.6e", "blog articles: disable → prune → re-create → still disabled", (await db.blogArticle.findFirst({ where: { shopId: shopBId, shopifyArticleId: A1 } }))?.learnEnabled === false);
    stub.gql = null;
  });

  // ── 4.7 aborted stream still meters ────────────────────────────────────────
  await kase("PH-4.7", async () => {
    const { OpenAiProvider } = await import("../../app/lib/llm/openai.server");
    const { runtimeConfig } = await import("../../app/lib/admin/runtime-config.server");
    let aborted = false;
    const mkStream = (failMidway: boolean) => ({
      controller: { abort: () => { aborted = true; } },
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { content: "Hello there, " } }] };
        if (failMidway) throw new Error("socket hang up");
        yield { choices: [{ delta: { content: "more text" } }] };
        yield { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } };
      },
    });
    const providerWith = (failMidway: boolean) => {
      const p = new OpenAiProvider();
      (p as unknown as { cached: unknown }).cached = { key: runtimeConfig().openaiApiKey, client: { chat: { completions: { create: async () => mkStream(failMidway) } } } };
      return p;
    };
    const usage = async (model: string) => {
      for (let i = 0; i < 30; i++) {
        const row = await db.llmUsageDaily.findFirst({ where: { shopId, model, purpose: "reply" } });
        if (row) return row;
        await sleep(100);
      }
      return null;
    };
    for await (const _t of providerWith(false).chatStream([{ role: "user", content: "x".repeat(40) }], { shopId, purpose: "reply" }, { model: "qa-ph-abort" })) break;
    const abortedRow = await usage("qa-ph-abort");
    ok("PH-4.7a", "early-exit consumer still records a usage row (estimate)", !!abortedRow && abortedRow.calls === 1 && abortedRow.completionTokens >= 1 && abortedRow.promptTokens >= 1, JSON.stringify(abortedRow && { c: abortedRow.calls, p: abortedRow.promptTokens, o: abortedRow.completionTokens }));
    ok("PH-4.7b", "the upstream stream is aborted", aborted);
    for await (const _t of providerWith(false).chatStream([{ role: "user", content: "hi" }], { shopId, purpose: "reply" }, { model: "qa-ph-full" })) void _t;
    const fullRow = await usage("qa-ph-full");
    ok("PH-4.7c", "fully consumed stream reports the exact usage once", fullRow?.calls === 1 && fullRow.promptTokens === 7 && fullRow.completionTokens === 3);
    try {
      for await (const _t of providerWith(true).chatStream([{ role: "user", content: "hi" }], { shopId, purpose: "reply" }, { model: "qa-ph-midfail" })) void _t;
    } catch { /* expected */ }
    ok("PH-4.7d", "mid-stream failure also records usage", (await usage("qa-ph-midfail"))?.calls === 1);
    console.log("  NOTE PH-4.7 estimated rows are not flagged as estimated (spec said \"flagged estimated\"; no column exists)");
  });

  // ── 4.8 empty-reply fallback + tenancy grep ────────────────────────────────
  await kase("PH-4.8", async () => {
    routes.push(["qa-actiononly", routeJson("chat")]);
    fake.stream = () => ["ACTION: none"];
    const chat = await turn("qa-actiononly hi", newSession());
    const saved = await db.message.findFirst({ where: { shopId, conversationId: chat.conversationId, role: "out" }, orderBy: { createdAt: "desc" } });
    ok("PH-4.8a", "chat lane: ACTION-only reply → canned fallback, never a silent empty turn", chat.text === canned("fallback", null) && !!saved?.content, `text="${chat.text}"`);
    fake.tags.push(["qa-qaction", basis(60)]);
    const k = await db.knowledge.create({ data: { shopId, topic: "Care", body: "QA-ACTION-CHUNK wipe with a soft cloth." } });
    await vec("knowledge", k.id, shopId, basis(60));
    routes.push(["qa-qaction", routeJson("question")]);
    const q = await turn("qa-qaction how do I clean it", newSession());
    ok("PH-4.8b", "question lane: ACTION-only reply → the merchant fallback", q.outcome === "question" && q.text === INSTALL_FALLBACK, `outcome=${q.outcome} text="${q.text.slice(0, 50)}"`);
    fake.stream = () => ["Happy to help!"];
    const bare = /\b(?:db|tx)\.\w+\.(?:update|delete)\(\s*\{\s*where:\s*\{\s*id:\s*[\w.]+\s*\}/;
    ok("PH-4.8c", "no bare pk update/delete in history.server.ts / index.server.ts", !bare.test(src("app/lib/pipeline/history.server.ts")) && !bare.test(src("app/lib/pipeline/index.server.ts")));
    ok("PH-4.8d", "streamAndLog backstops every lane", /if \(!full\.trim\(\)\) \{\s*full = args\.emptyReplyText \?\? canned\("fallback", args\.persona\);/.test(src("app/lib/pipeline/index.server.ts")));
  });
}

main()
  .catch((error) => {
    failed++;
    failures.push(`harness: ${error instanceof Error ? error.message : String(error)}`);
    console.error(error);
  })
  .finally(async () => {
    console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
    if (failures.length) console.log(`FAILED:\n  ${failures.join("\n  ")}`);
    if (skips.length) console.log(`SKIPPED:\n  ${skips.join("\n  ")}`);
    const db = (await import("../../app/db.server")).default;
    await db.$disconnect().catch(() => undefined);
    process.exit(failed ? 1 : 0);
  });

export { src, mix, skip };
