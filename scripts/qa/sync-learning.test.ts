/* eslint-disable @typescript-eslint/no-explicit-any -- QA harness: tool results,
 * stubbed Admin GraphQL nodes and pg-boss calls are probed structurally. */
/* DATA SYNC → AI LEARNING chain (SL-*).
 *
 * Run (PowerShell):  npx tsx scripts/qa/sync-learning.test.ts
 * Needs: dev Postgres up + migrated. No dev server. No LLM spend.
 *
 * What this proves, per Shopify data type: sync (full sync or signed webhook →
 * enqueued job → the REAL job handler) → DB rows → embeddings / description
 * passages / knowledge chunks → what the AI AGENT's TOOLS actually return
 * (search_products, get_product(product, question), show_products,
 * search_store_info, get_discounts) — and that every update, delete and switch
 * propagates to the tool results.
 *
 * The tools are not exported from agent.server.ts, so every tool call is driven
 * through the real agent loop (runPipeline, AI_AGENT_MODE=tools, isTest): the
 * app's LLM singleton is swapped for a scripted fake (CapturingProvider.inner)
 * whose first round issues the scripted tool calls and whose second round
 * captures the tool results the app hands back.
 *
 * Determinism:
 *  - Embeddings are fake: text containing a registered needle ("zq…") maps to a
 *    fixed vector (sum of matched needles, normalised); anything else gets the
 *    app's pseudoEmbedding. Cosines are exact where a threshold is asserted.
 *  - Shopify Admin GraphQL is stubbed at the fetch layer for the two throwaway
 *    shop domains (installed BEFORE any app import); URL knowledge sources are
 *    served from a TEST-NET-2 host that is never routed.
 *  - Webhooks are real signed requests into the real route actions.
 *
 * Safety: never a pg-boss worker — an in-memory stub is the pg-boss singleton,
 * enqueue() is captured, and captured jobs are run through the handler
 * functions registerHandlers() registers on that stub. Throwaway shops
 * `qa-sl-<ts>-a/-b.myshopify.com`, removed with cleanupShop in finally. Every
 * case runs under a timeout.
 *
 * A FAIL marked "DEFECT-CHECK" encodes a spec/product rule the code does not
 * meet — it must stay failing until the product is fixed.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

for (const line of readFileSync(join(process.cwd(), ".env"), "utf-8").split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (match && !line.trim().startsWith("#") && process.env[match[1]] === undefined) {
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}
// This suite asserts the AI AGENT's tools (spec 24) — pin the engine.
process.env.AI_AGENT_MODE = "tools";
process.env.SHOPIFY_APP_URL ||= "http://localhost:3000";
process.env.SHOPIFY_API_KEY ||= "qa-placeholder-key";
process.env.SHOPIFY_API_SECRET ||= "qa-placeholder-secret";
process.env.SCOPES ||= "read_products";
// Embedding writes are gated on a configured key; the provider is faked, so a
// placeholder never reaches OpenAI (the seam check below refuses to run otherwise).
process.env.OPENAI_API_KEY ||= "sk-qa-sync-learning-placeholder";

const TS = Date.now();
const DOMAIN_A = `qa-sl-${TS}-a.myshopify.com`;
const DOMAIN_B = `qa-sl-${TS}-b.myshopify.com`;
const SECRET = process.env.SHOPIFY_API_SECRET!;
const FAKE_HOST = "198.51.100.23"; // TEST-NET-2: public per the SSRF guard, never routed

// ── Shopify Admin GraphQL + crawl stub (must precede every app import) ──────
interface ShopStub {
  products: any[];
  defs: { product: any[]; variant: any[] };
  collections: any[];
  members: Record<string, string[]>;
  discounts: any[];
  pages: any[];
  articles: any[];
}
const emptyStub = (): ShopStub => ({ products: [], defs: { product: [], variant: [] }, collections: [], members: {}, discounts: [], pages: [], articles: [] });
const stubs: Record<string, ShopStub> = { [DOMAIN_A]: emptyStub(), [DOMAIN_B]: emptyStub() };
const crawl = new Map<string, string | Error>();
const page = (nodes: unknown[]) => ({ pageInfo: { hasNextPage: false, endCursor: null }, nodes });

/** When set, a products page larger than this is rejected like Shopify's 1,000-point query cost limit. */
let productPageCostLimit: number | null = null;
/** Number of product page calls to answer with Shopify's THROTTLED error (rate limit). */
let throttleProductPages = 0;
/** Number of collection-sync calls (list or membership) answered with THROTTLED. */
let throttleCollectionCalls = 0;
/** When set, the collections list is paged this many at a time (cursor = offset). */
let collectionPageSize: number | null = null;
const productPageSizes: number[] = [];

function gql(domain: string, query: string, vars: Record<string, any>): unknown {
  const s = stubs[domain];
  if (query.includes("CatalogSyncProducts(")) productPageSizes.push(Number(vars.first));
  if (query.includes("CatalogSyncProducts(") && throttleProductPages > 0) {
    throttleProductPages--;
    return { errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] };
  }
  if (query.includes("CatalogSyncProducts(") && productPageCostLimit !== null && Number(vars.first) > productPageCostLimit) {
    return { errors: [{ message: "Query cost is 1190, which exceeds the single query max cost limit (1000).\n\nSee https://shopify.dev/docs/api/usage/rate-limits" }] };
  }
  if (query.includes("CatalogSyncProductMetafields")) {
    const p = s.products.find((n) => n.id === vars.id);
    return { data: { product: p ? { metafields: p.metafields, variants: { nodes: p.variants.nodes.map((v: any) => ({ title: v.title, metafields: v.metafields })) } } : null } };
  }
  if (query.includes("CatalogSyncProductIds")) return { data: { products: page(s.products.map((p: any) => ({ id: p.id }))) } };
  if (query.includes("CatalogSyncProducts")) {
    // Paged when the caller asks for fewer products than the stub holds, so
    // continuation chunks (cursor handoff) can be exercised.
    const first = Number(vars.first) || s.products.length;
    const from = vars.cursor ? Number(vars.cursor) : 0;
    const slice = s.products.slice(from, from + first);
    const next = from + first;
    const hasNext = next < s.products.length;
    return { data: { products: { pageInfo: { hasNextPage: hasNext, endCursor: hasNext ? String(next) : null }, nodes: slice } } };
  }
  if (query.includes("MetafieldDefinitions")) return { data: { metafieldDefinitions: page(vars.ownerType === "PRODUCT" ? s.defs.product : s.defs.variant) } };
  if ((query.includes("CatalogSyncCollectionProducts") || query.includes("CatalogSyncCollections(")) && throttleCollectionCalls > 0) {
    throttleCollectionCalls--;
    return { errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] };
  }
  if (query.includes("CatalogSyncCollections(") && collectionPageSize !== null) {
    const from = vars.cursor ? Number(vars.cursor) : 0;
    const next = from + collectionPageSize;
    const hasNext = next < s.collections.length;
    return { data: { collections: { pageInfo: { hasNextPage: hasNext, endCursor: hasNext ? String(next) : null }, nodes: s.collections.slice(from, next) } } };
  }
  if (query.includes("CatalogSyncCollectionProducts")) return { data: { collection: { products: page((s.members[vars.id] ?? []).map((id) => ({ id }))) } } };
  if (query.includes("CatalogSyncCollections")) return { data: { collections: page(s.collections) } };
  if (query.includes("CatalogSyncDiscountNode")) return { data: { discountNode: s.discounts.find((d) => d.id === vars.id) ?? null } };
  if (query.includes("CatalogSyncDiscounts")) return { data: { discountNodes: page(s.discounts) } };
  if (query.includes("ContentSyncPages")) return { data: { pages: page(s.pages) } };
  if (query.includes("ContentSyncArticles")) return { data: { articles: page(s.articles) } };
  if (query.includes("KnowledgeShopPolicies")) return { data: { shop: { shopPolicies: [] } } };
  return { data: {} };
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (stubs[url.hostname]) {
    const raw = typeof init?.body === "string" ? init.body : "{}";
    const body = JSON.parse(raw) as { query?: string; variables?: Record<string, unknown> };
    return new Response(JSON.stringify(gql(url.hostname, body.query ?? "", body.variables ?? {})), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.hostname === FAKE_HOST) {
    const html = crawl.get(url.pathname);
    if (html instanceof Error || html === undefined) throw new TypeError("fetch failed (qa stub: host unreachable)");
    return new Response(html, { status: 200, headers: { "Content-Type": "text/html" } });
  }
  return realFetch(input, init);
}) as typeof fetch;

// ── pg-boss stub: captures sends AND the handlers registerHandlers() installs ─
type JobFn = (jobs: Array<{ data: any }>) => Promise<void>;
const jobHandlers = new Map<string, JobFn>();
const sentJobs: Array<{ name: string; data: any }> = [];
const stubBoss = {
  async send(name: string, data: any) {
    sentJobs.push({ name, data });
    return `qa-sl-job-${sentJobs.length}`;
  },
  async createQueue() {},
  async work(name: string, ...rest: unknown[]) {
    jobHandlers.set(name, rest[rest.length - 1] as JobFn);
  },
  async schedule() {},
  async stop() {},
  on() {},
};
(globalThis as any).pgBossGlobal = { boss: stubBoss, started: Promise.resolve() };

/** Run every captured job through its real handler (FIFO, including jobs the handlers enqueue). */
async function drainJobs(filter?: (name: string) => boolean): Promise<string[]> {
  const ran: string[] = [];
  for (let guard = 0; guard < 200; guard++) {
    const index = sentJobs.findIndex((j) => !filter || filter(j.name));
    if (index < 0) break;
    const [job] = sentJobs.splice(index, 1);
    const handler = jobHandlers.get(job.name);
    if (!handler) throw new Error(`no handler registered for job ${job.name}`);
    await handler([{ data: job.data }]);
    ran.push(job.name);
  }
  return ran;
}

// ── reporting ───────────────────────────────────────────────────────────────
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
    failures.push(`${id} ${name}${detail ? ` — ${detail}` : ""}`);
    console.error(`  FAIL ${id} ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function skip(id: string, reason: string): void {
  skipped++;
  skips.push(`${id}: ${reason}`);
  console.log(`  SKIP ${id} — ${reason}`);
}
async function kase(id: string, fn: () => Promise<void>, timeoutMs = 90_000): Promise<void> {
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

// ── vectors ─────────────────────────────────────────────────────────────────
const DIM = 1536;
let nextDim = 20;
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
const tags: Array<[string, number[]]> = [];
/** Register a needle with its own orthogonal direction; returns that dimension. */
function needle(word: string): number {
  const d = nextDim++;
  tags.push([word.toLowerCase(), basis(d)]);
  return d;
}
function needleVec(word: string, vector: number[]): void {
  tags.push([word.toLowerCase(), vector]);
}

// ── fake LLM provider (scripted agent) ──────────────────────────────────────
interface Call { name: string; args: unknown }
const fake = {
  pseudo: null as null | ((t: string) => number[]),
  embedLog: [] as string[][],
  script: [] as Call[],
  round0: null as null | { messages: any[]; tools: string[] },
  captured: [] as Array<{ name: string; result: any }>,
  vectorFor(text: string): number[] {
    const lower = text.toLowerCase();
    const hit = tags.filter(([w]) => lower.includes(w)).map(([, v]) => v);
    if (hit.length === 0) return this.pseudo!(text);
    const sum = new Array<number>(DIM).fill(0);
    for (const v of hit) for (let i = 0; i < DIM; i++) sum[i] += v[i];
    const norm = Math.sqrt(sum.reduce((s, x) => s + x * x, 0)) || 1;
    return sum.map((x) => x / norm);
  },
  async chat(): Promise<string> {
    return "no";
  },
  chatStream(): AsyncIterable<string> {
    return (async function* () {
      yield "ok";
    })();
  },
  async *agentStream(messages: any[], tools: Array<{ name: string }>): AsyncIterable<any> {
    const last = messages[messages.length - 1];
    if (last?.role !== "tool") {
      fake.round0 = { messages: [...messages], tools: tools.map((t) => t.name) };
      const calls = fake.script.map((c, i) => ({ id: `call_${i}`, name: c.name, arguments: JSON.stringify(c.args) }));
      if (calls.length > 0 && tools.length > 0) {
        yield { type: "tool_calls", calls };
        return;
      }
      yield { type: "text", text: "Hello." };
      return;
    }
    let a = messages.length - 1;
    while (a >= 0 && messages[a].role !== "assistant") a--;
    const names = new Map<string, string>((messages[a]?.toolCalls ?? []).map((c: any) => [c.id, c.name]));
    for (const m of messages.slice(a + 1)) {
      if (m.role !== "tool") continue;
      let parsed: any;
      try {
        parsed = JSON.parse(m.content);
      } catch {
        parsed = m.content;
      }
      fake.captured.push({ name: names.get(m.toolCallId) ?? "?", result: parsed });
    }
    yield { type: "text", text: "Done." };
  },
  async embed(text: string): Promise<number[]> {
    return (await this.embedBatch([text]))[0];
  },
  async embedBatch(texts: string[]): Promise<number[][]> {
    this.embedLog.push(texts);
    return texts.map((t) => this.vectorFor(t));
  },
  async moderate(): Promise<string[]> {
    return [];
  },
};

// ── fixtures ────────────────────────────────────────────────────────────────
const FILLER = ["gentle", "polished", "beads", "strung", "on", "stretch", "cord", "for", "daily", "wear", "and", "easy", "layering", "with", "a", "soft", "natural", "finish", "made", "in", "small", "batches", "by", "our", "studio", "team"];
/** One ~720-char sentence — long enough that each becomes its own passage. */
function para(lead: string, word = "", len = 720): string {
  let s = `${lead}${word ? ` ${word}` : ""}`;
  let i = lead.length;
  while (s.length < len) s += ` ${FILLER[i++ % FILLER.length]}`;
  return `${s}.`;
}
const BOILER = para("Every order ships in a recycled gift box with a care card", "zqboiler");
const gid = (n: number) => `gid://shopify/Product/${n}`;

function productNode(o: {
  n: number; title: string; description: string; status?: string; published?: boolean; stock?: number;
  variants?: Array<{ title: string; available: boolean }>; metafields?: any[]; tags?: string[]; type?: string; price?: string;
}): any {
  const variants = o.variants ?? [{ title: "Default Title", available: (o.stock ?? 5) > 0 }];
  return {
    id: gid(o.n), title: o.title, description: o.description, productType: o.type ?? "Accessory", vendor: "QA SL", tags: o.tags ?? [],
    status: o.status ?? "ACTIVE", handle: o.title.toLowerCase().replace(/[^a-z0-9]+/g, "-"), onlineStoreUrl: null,
    publishedAt: o.published === false ? null : "2026-01-01T00:00:00Z", featuredMedia: null,
    priceRangeV2: { minVariantPrice: { amount: o.price ?? "25.0" } }, totalInventory: o.stock ?? 5,
    variants: { nodes: variants.map((v, i) => ({ id: `gid://shopify/ProductVariant/${o.n}${String(i).padStart(2, "0")}`, title: v.title, price: o.price ?? "25.0", availableForSale: v.available, metafields: { nodes: [] } })) },
    metafields: { nodes: o.metafields ?? [] },
  };
}

type Db = Awaited<typeof import("../../app/db.server")>["default"];

async function main(): Promise<void> {
  const db: Db = (await import("../../app/db.server")).default;
  const { getLlmProvider } = await import("../../app/lib/llm/index.server");
  const emb = await import("../../app/lib/embeddings/embedding.server");
  fake.pseudo = emb.pseudoEmbedding;
  const capturing = getLlmProvider() as unknown as { inner: unknown };
  if (!("inner" in capturing)) throw new Error("LLM seam changed: CapturingProvider.inner not found — refusing to run (would hit the real API)");
  capturing.inner = fake;

  const handlersMod = await import("../../app/lib/jobs/handlers.server");
  const { JOBS, cleanupShop, countShopRows } = handlersMod;
  await handlersMod.registerHandlers(stubBoss as any);

  const { runPipeline } = await import("../../app/lib/pipeline/index.server");
  const { invalidateShopConfig } = await import("../../app/lib/config/shop-config.server");
  const { shopSettingsSchema } = await import("../../app/lib/settings/schemas");
  const { loadShopSettings } = await import("../../app/lib/settings/save.server");
  const catalog = await import("../../app/lib/ingestion/catalog-sync.server");
  const content = await import("../../app/lib/ingestion/content-sync.server");
  const ingest = await import("../../app/lib/ingestion/knowledge-ingest.server");
  const sources = await import("../../app/lib/ingestion/sources.server");
  const passagesMod = await import("../../app/lib/ingestion/product-passages.server");
  const { hashText } = await import("../../app/lib/ingestion/metafields.server");
  const { hybridProductSearch } = await import("../../app/lib/search/product-search.server");
  const { getQuota } = await import("../../app/lib/billing/plans.server");
  const { saveFaq, ensureDefaultCategory } = await import("../../app/lib/faq/faq.server");
  const productsRoute = await import("../../app/routes/webhooks.products");
  const collectionsRoute = await import("../../app/routes/webhooks.collections");
  const discountsRoute = await import("../../app/routes/webhooks.discounts");

  for (const d of [DOMAIN_A, DOMAIN_B]) {
    await cleanupShop(d).catch(() => undefined);
    await db.shop.deleteMany({ where: { domain: d } });
  }
  const shopA = await db.shop.create({ data: { domain: DOMAIN_A, name: "QA sync learning A", plan: "plus", currency: "USD" } });
  const shopB = await db.shop.create({ data: { domain: DOMAIN_B, name: "QA sync learning B", plan: "free", currency: "USD" } });
  const A = shopA.id;
  const B = shopB.id;
  for (const d of [DOMAIN_A, DOMAIN_B]) {
    await db.session.create({ data: { id: `offline_${d}`, shop: d, state: "", isOnline: false, scope: process.env.SCOPES, accessToken: "shpat_qa_sl_fake" } });
  }
  const startedAt = new Date();
  console.log(`throwaway shops ${DOMAIN_A} / ${DOMAIN_B}`);

  // ── helpers ──────────────────────────────────────────────────────────────
  let sessionN = 0;
  interface Turn { results: Array<{ name: string; result: any }>; cards: string[]; outcome: string; tools: string[]; round0: any[] }
  /** One agent turn whose model issues `calls`; returns what the app's tools returned. */
  async function turn(shopId: string, message: string, calls: Call[]): Promise<Turn> {
    fake.script = calls;
    fake.captured = [];
    fake.round0 = null;
    const out: Turn = { results: [], cards: [], outcome: "", tools: [], round0: [] };
    for await (const f of runPipeline({ shopId, sessionId: `qa-sl-${TS}-${++sessionN}`, message, isTest: true })) {
      if (f.type === "cards") out.cards = f.cards.map((c) => c.title);
      if (f.type === "done") out.outcome = f.outcome;
    }
    out.results = fake.captured;
    // Re-read through a cast: the `fake.round0 = null` above narrows the property to null for TS.
    const round0 = fake.round0 as { messages: any[]; tools: string[] } | null;
    out.tools = round0?.tools ?? [];
    out.round0 = round0?.messages ?? [];
    fake.script = [];
    return out;
  }
  const one = async (shopId: string, message: string, name: string, args: unknown) => {
    const t = await turn(shopId, message, [{ name, args }]);
    return { ...t, r: t.results.find((x) => x.name === name)?.result };
  };
  const titles = (r: any): string[] => (r?.results ?? []).map((x: any) => x.title);
  const infoTexts = (r: any): string[] => (r?.results ?? []).map((x: any) => `${x.source}|${x.topic}|${x.text}`);
  const setSettings = async (shopId: string, patch: (s: any) => any) => {
    const current = await loadShopSettings(shopId);
    const settings = shopSettingsSchema.parse(patch(structuredClone(current)));
    await db.shopSettings.upsert({ where: { shopId }, update: { settings: settings as object }, create: { shopId, settings: settings as object } });
    invalidateShopConfig(shopId);
  };
  const setLearn = (shopId: string, kind: string, on: boolean) => setSettings(shopId, (s) => ({ ...s, learn: { ...s.learn, [kind]: on } }));
  const webhook = async (route: { action: (args: any) => Promise<unknown> }, topic: string, domain: string, payload: unknown) => {
    const body = JSON.stringify(payload);
    const request = new Request("http://localhost:3000/webhooks/qa", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shopify-topic": topic,
        "x-shopify-hmac-sha256": createHmac("sha256", SECRET).update(body, "utf8").digest("base64"),
        "x-shopify-shop-domain": domain,
        "x-shopify-api-version": "2026-07",
        "x-shopify-webhook-id": `qa-sl-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      },
      body,
    });
    let status = 0;
    try {
      const res = await route.action({ request, params: {}, context: {} });
      status = res instanceof Response ? res.status : 200;
    } catch (error) {
      status = error instanceof Response ? error.status : 500;
      if (!(error instanceof Response)) console.error("  webhook threw", error);
    }
    const queued = sentJobs.map((j) => j.name);
    const ran = await drainJobs();
    return { status, queued, ran };
  };
  const passagesOf = async (shopifyProductId: string, shopId = A) => {
    const p = await db.product.findFirst({ where: { shopId, shopifyProductId }, select: { id: true } });
    if (!p) return [];
    return db.productPassage.findMany({ where: { shopId, productId: p.id }, orderBy: { position: "asc" }, select: { id: true, body: true, position: true, sourceHash: true, bodyHash: true } });
  };

  // ── needles ──────────────────────────────────────────────────────────────
  const H = needle("zqhormone");
  needleVec("zqq60h", mix(0.6, H, nextDim++));
  needleVec("zqq50h", mix(0.5, H, nextDim++));
  for (const w of ["zqopening", "zqcare", "zqboiler", "zqtidefact", "zqbeaconfact", "zqhiddenfact", "zqsoldfact", "zqprunefact", "zqmaterial", "zqcandle", "zqchimefact", "zqchimenew", "zqsleep", "zqbonly", "zqbchunk", "zqbpage", "zqmanual", "zqcsvone", "zqcsvtwo", "zqfile", "zqurl", "zqurlnew", "zqoffurl", "zqpage1", "zqpage1b", "zqpagedraft", "zqarticle", "zqabout", "zqaboutnew", "zqfaq"]) needle(w);

  // ── shop A catalogue ─────────────────────────────────────────────────────
  const SIZES = Array.from({ length: 12 }, (_, i) => ({ title: `${6 + i}mm`, available: i !== 11 }));
  const MOON_DESC = [
    para("Moonglow note zero opens the story", "zqopening"),
    para("Moonglow note one"),
    para("Moonglow note two"),
    BOILER,
    para("Moonglow note four"),
    para("Moonglow note five says it may support hormonal balance", "zqhormone"),
    para("Moonglow note six covers care", "zqcare"),
  ].join(" ");
  const lanternDesc = (name: string, word: string) => [para(`${name} note one`), para(`${name} note two`, word), para(`${name} note three`)].join(" ");
  stubs[DOMAIN_A].defs = {
    product: [
      { namespace: "custom", key: "material", name: "Material", type: { name: "single_line_text_field" } },
      { namespace: "custom", key: "internal_code", name: "Internal code", type: { name: "single_line_text_field" } },
    ],
    variant: [],
  };
  await db.productMetafieldDefinition.create({ data: { shopId: A, ownerType: "product", namespace: "custom", key: "material", name: "Material", type: "single_line_text_field", hasDefinition: true, enabled: true } });
  stubs[DOMAIN_A].products = [
    productNode({
      n: 7101, title: "Moonglow Crystal Bracelet", description: MOON_DESC, tags: ["moonstone", "bracelet"], type: "Bracelet", variants: SIZES,
      metafields: [
        { namespace: "custom", key: "material", type: "single_line_text_field", value: "Moonstone zqmaterial", definition: { id: "d1" } },
        { namespace: "custom", key: "internal_code", type: "single_line_text_field", value: "zqinternal-42", definition: { id: "d2" } },
        { namespace: "legacy", key: "nodef", type: "single_line_text_field", value: "zqnodef", definition: null },
      ],
    }),
    productNode({ n: 7102, title: "Rivermint Short Candle", description: "A small hand poured candle with zqcandle notes & a cotton wick.", type: "Candle" }),
    productNode({ n: 7103, title: "Tidepool Bracelet", description: [para("Tidepool bracelet note one"), BOILER, para("Tidepool bracelet note three", "zqtidefact")].join(" "), type: "Bracelet" }),
    productNode({ n: 7104, title: "Beacon Lantern", description: [para("Beacon lantern note one"), BOILER, para("Beacon lantern note three", "zqbeaconfact")].join(" "), type: "Lantern", tags: ["lantern"] }),
    productNode({ n: 7105, title: "Archived Lantern", description: lanternDesc("Archived lantern", "zqhiddenfact"), status: "ARCHIVED", type: "Lantern", tags: ["lantern"] }),
    productNode({ n: 7106, title: "Draft Lantern", description: lanternDesc("Draft lantern", "zqhiddenfact"), status: "DRAFT", type: "Lantern", tags: ["lantern"] }),
    productNode({ n: 7107, title: "Hidden Lantern", description: lanternDesc("Hidden lantern", "zqhiddenfact"), published: false, type: "Lantern", tags: ["lantern"] }),
    productNode({ n: 7108, title: "Soldout Lantern", description: lanternDesc("Soldout lantern", "zqsoldfact"), stock: 0, variants: [{ title: "Default Title", available: false }], type: "Lantern", tags: ["lantern"] }),
    productNode({ n: 7109, title: "Learnoff Lantern", description: lanternDesc("Learnoff lantern", "zqhiddenfact"), type: "Lantern", tags: ["lantern"] }),
    productNode({ n: 7110, title: "Prunable Lamp", description: lanternDesc("Prunable lamp", "zqprunefact"), type: "Lamp" }),
  ];
  const HIDDEN = ["Archived Lantern", "Draft Lantern", "Hidden Lantern", "Learnoff Lantern"];

  try {
    // ═══ 1. PRODUCTS ═════════════════════════════════════════════════════════
    await kase("SL-PR-1 full sync → rows + embedding text", async () => {
      fake.embedLog = [];
      await catalog.fullCatalogSync(DOMAIN_A);
      const moon = await db.product.findFirst({ where: { shopId: A, shopifyProductId: gid(7101) } });
      const count = await db.product.count({ where: { shopId: A } });
      ok("SL-PR-1a", "full sync mirrors all 10 products", count === 10, `count=${count}`);
      const variants = (moon?.variants as any[]) ?? [];
      ok("SL-PR-1b", "12 variants stored (≥10, not truncated), sold-out flag kept", variants.length === 12 && variants[11]?.available === false, `variants=${variants.length}`);
      ok("SL-PR-1c", "enabled metafield rendered into metafieldText; disabled + definition-less are not", moon?.metafieldText.includes("Material: Moonstone zqmaterial") === true && !moon.metafieldText.includes("zqinternal") && !moon.metafieldText.includes("zqnodef"), JSON.stringify(moon?.metafieldText));
      const stored = (moon?.metafields as any[]) ?? [];
      ok("SL-PR-1d", "metafield without a definition is dropped from stored metafields", stored.length === 2 && !stored.some((m) => m.value === "zqnodef"), `stored=${stored.map((m) => m.key).join(",")}`);
      const text = emb.productEmbeddingText({ ...moon!, metafieldText: moon!.metafieldText });
      ok("SL-PR-1e", "embedding text = title · options (12 sizes) · metafields · description ≤2,000", text.startsWith("Moonglow Crystal Bracelet") && text.includes(`Options: ${SIZES.map((s) => s.title).join(", ")}`) && text.includes("Material: Moonstone zqmaterial") && !text.includes("zqhormone"), text.slice(0, 140));
      ok("SL-PR-1f", "contentHash is the hash of that canonical text", moon?.contentHash === hashText(text));
      ok("SL-PR-1g", "that exact text was sent to the embedding model", fake.embedLog.flat().includes(text));
      const withVec = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "products" WHERE "shopId" = ${A} AND "embedding" IS NOT NULL`;
      ok("SL-PR-1h", "every synced product has a vector", Number(withVec[0]?.n) === 10, `embedded=${withVec[0]?.n}`);
      await db.product.updateMany({ where: { shopId: A, shopifyProductId: gid(7109) }, data: { learnEnabled: false } });
    });

    await kase("SL-PR-1q query cost limit → smaller pages, sync still completes", async () => {
      // Production 2026-09-08…15: every product sync failed with "Query cost is
      // 1190, which exceeds the single query max cost limit (1000)".
      productPageCostLimit = 20;
      productPageSizes.length = 0;
      try {
        await catalog.fullCatalogSync(DOMAIN_A);
      } finally {
        productPageCostLimit = null;
      }
      const state = await db.syncState.findUnique({ where: { shopId: A } });
      ok("SL-PR-1qa", "the first page asks for at most 50 products", productPageSizes[0] <= 50, `sizes=${productPageSizes.join(",")}`);
      ok("SL-PR-1qb", "a cost-limit error halves the page size until it fits", productPageSizes.includes(12) && productPageSizes.at(-1)! <= 20, `sizes=${productPageSizes.join(",")}`);
      ok("SL-PR-1qc", "the sync completes (status idle, all products kept)", state?.status === "idle" && (await db.product.count({ where: { shopId: A } })) === 10, `status=${state?.status} error=${state?.errorMessage}`);
    });

    await kase("SL-PR-1r rate limit → waits and retries, sync still completes", async () => {
      throttleProductPages = 2;
      const startedAt = Date.now();
      try {
        await catalog.fullCatalogSync(DOMAIN_A);
      } finally {
        throttleProductPages = 0;
      }
      const state = await db.syncState.findUnique({ where: { shopId: A } });
      ok("SL-PR-1ra", "two THROTTLED answers are waited out and the sync completes", state?.status === "idle" && (await db.product.count({ where: { shopId: A } })) === 10, `status=${state?.status} error=${state?.errorMessage}`);
      ok("SL-PR-1rb", "it actually slowed down (backoff before each retry)", Date.now() - startedAt >= 5_000, `${Date.now() - startedAt}ms`);
      const waited = await catalog.waitForQueryBudget({ cost: { requestedQueryCost: 600, throttleStatus: { currentlyAvailable: 100, restoreRate: 1000 } } });
      const none = await catalog.waitForQueryBudget({ cost: { requestedQueryCost: 600, throttleStatus: { currentlyAvailable: 900, restoreRate: 50 } } });
      ok("SL-PR-1rc", "a short points bucket waits for the refill; a full one does not wait", waited >= 500 && waited < 2_000 && none === 0, `waited=${waited} none=${none}`);
    }, 120_000);

    await kase("SL-PR-1s a big catalogue syncs in resumable chunks (10k-safe)", async () => {
      // The queue kills a job after 15 minutes; a run that is out of time must
      // hand its cursor to a continuation job instead of being restarted.
      const queued: any[] = [];
      const realSend = (global as any).pgBossGlobal.boss.send;
      (global as any).pgBossGlobal.boss.send = async (name: string, data: any, opts: any) => {
        queued.push({ name, data });
        return realSend(name, data, opts);
      };
      productPageCostLimit = 5; // forces 5-product pages, so 10 products need several
      try {
        await catalog.fullCatalogSync(DOMAIN_A, { budgetMs: 0 });
        const first = queued.find((j) => j.name === "catalog-sync");
        ok("SL-PR-1sa", "a run out of time queues a continuation with its cursor", Boolean(first?.data?.cursor) && first.data.processed > 0, JSON.stringify(first?.data));
        // Drain the continuations the way the worker would.
        let guard = 0;
        while (queued.some((j) => j.name === "catalog-sync") && guard++ < 50) {
          const job = queued.find((j) => j.name === "catalog-sync");
          queued.splice(queued.indexOf(job), 1);
          await catalog.fullCatalogSync(DOMAIN_A, { cursor: job.data.cursor, processed: job.data.processed, chunk: job.data.chunk, budgetMs: 0 });
        }
        const state = await db.syncState.findUnique({ where: { shopId: A } });
        ok("SL-PR-1sb", "the chunks finish the catalogue: every product stored, status idle", (await db.product.count({ where: { shopId: A } })) === 10 && state?.status === "idle" && state.productCount === 10, `count=${await db.product.count({ where: { shopId: A } })} status=${state?.status} productCount=${state?.productCount}`);
      } finally {
        (global as any).pgBossGlobal.boss.send = realSend;
        productPageCostLimit = null;
        // The continuations this case queued must not leak into later cases.
        for (let i = sentJobs.length - 1; i >= 0; i--) if (sentJobs[i].name === "catalog-sync") sentJobs.splice(i, 1);
      }
    }, 120_000);

    await kase("SL-PR-2 search_products / get_product / show_products reflect the sync", async () => {
      const s = await one(A, "show me moonglow bracelets", "search_products", { query: "moonglow bracelet" });
      ok("SL-PR-2a", "search_products returns the synced product", titles(s.r).includes("Moonglow Crystal Bracelet"), JSON.stringify(titles(s.r)));
      const g = await one(A, "tell me about the moonglow", "get_product", { product: "Moonglow Crystal Bracelet" });
      ok("SL-PR-2b", "get_product: price, 12 variants with the sold-out one marked", g.r?.price && g.r.variants?.length === 12 && g.r.variants.includes("17mm (sold out)"), JSON.stringify(g.r?.variants));
      ok("SL-PR-2c", "get_product: specifications carry the enabled metafield only", /Material: Moonstone zqmaterial/.test(g.r?.specifications ?? "") && !/zqinternal/.test(g.r?.specifications ?? ""), g.r?.specifications);
      ok("SL-PR-2d", "get_product by numeric id resolves the same product", (await one(A, "moonglow details", "get_product", { product: "7101" })).r?.title === "Moonglow Crystal Bracelet");
      ok("SL-PR-2e", "a product looked up for a fresh shopper is carded", g.cards.includes("Moonglow Crystal Bracelet"), JSON.stringify(g.cards));
      const short = await one(A, "about the candle", "get_product", { product: "Rivermint Short Candle", question: "what does it smell like" });
      ok("SL-PR-2f", "full-sync description reaches get_product verbatim (entity-free, whole when short)", short.r?.description === "A small hand poured candle with zqcandle notes & a cotton wick." && !("description_relevant" in (short.r ?? {})), JSON.stringify(short.r?.description));
    });

    await kase("SL-PR-3 archived / draft / unpublished / learn-off / out-of-stock never returned or carded", async () => {
      const s = await one(A, "do you have lanterns", "search_products", { query: "lantern" });
      ok("SL-PR-3a", "search_products 'lantern' returns only the showable in-stock lantern", JSON.stringify(titles(s.r)) === JSON.stringify(["Beacon Lantern"]), JSON.stringify(titles(s.r)));
      for (const t of [...HIDDEN]) {
        const g = await one(A, "sl product question", "get_product", { product: t });
        const matches = (g.r?.closest_matches ?? []).map((m: any) => m.title);
        ok(`SL-PR-3b.${t.split(" ")[0]}`, `get_product("${t}") never returns its details`, g.r?.title !== t && !matches.includes(t) && !g.cards.includes(t), JSON.stringify({ title: g.r?.title, matches, cards: g.cards }));
      }
      const show = await one(A, "show them", "show_products", { products: [...HIDDEN, "Soldout Lantern", "Beacon Lantern"] });
      ok("SL-PR-3c", "show_products cards only the showable, purchasable product", JSON.stringify(show.cards) === JSON.stringify(["Beacon Lantern"]) && (show.r?.not_shown ?? []).length === 5, JSON.stringify({ cards: show.cards, r: show.r }));
      const sold = await one(A, "is it in stock", "get_product", { product: "Soldout Lantern" });
      ok("SL-PR-3d", "out-of-stock product: get_product says available=false and it is never carded", sold.r?.available === false && sold.cards.length === 0, JSON.stringify({ available: sold.r?.available, cards: sold.cards }));
      const info = await one(A, "sl facts zqhiddenfact", "search_store_info", { question: "what is zqhiddenfact" });
      ok("SL-PR-3e", "search_store_info never quotes a hidden product's description passage", !infoTexts(info.r).some((x) => /zqhiddenfact/.test(x)), JSON.stringify(infoTexts(info.r)).slice(0, 200));
    });

    await kase("SL-PR-4 master Learn products OFF removes the data type from the agent", async () => {
      await setLearn(A, "products", false);
      const t = await turn(A, "tell me about moonglow zqhormone", [
        { name: "get_product", args: { product: "Moonglow Crystal Bracelet" } },
        { name: "search_store_info", args: { question: "does moonglow help zqhormone" } },
      ]);
      ok("SL-PR-4a", "product tools are not offered to the model", !t.tools.includes("search_products") && !t.tools.includes("get_product") && !t.tools.includes("show_products") && t.tools.includes("search_store_info"), JSON.stringify(t.tools));
      const g = t.results.find((x) => x.name === "get_product")?.result;
      ok("SL-PR-4b", "a forced get_product call is refused", typeof g?.error === "string" && !g.title, JSON.stringify(g));
      const info = t.results.find((x) => x.name === "search_store_info")?.result;
      ok("SL-PR-4c", "search_store_info returns no product-description passages", !infoTexts(info).some((x) => x.startsWith("product description")), JSON.stringify(infoTexts(info)).slice(0, 160));
      ok("SL-PR-4d", "no product card", t.cards.length === 0, JSON.stringify(t.cards));
      await setLearn(A, "products", true);
      const back = await one(A, "moonglow again", "search_products", { query: "moonglow bracelet" });
      ok("SL-PR-4e", "switching it back ON restores search", titles(back.r).includes("Moonglow Crystal Bracelet"));
    });

    await kase("SL-PR-5 full sync prunes a product deleted in Shopify (missed webhook) → tools + passages", async () => {
      ok("SL-PR-5a", "precondition: prunable product has passages", (await passagesOf(gid(7110))).length > 0);
      const pid = (await db.product.findFirst({ where: { shopId: A, shopifyProductId: gid(7110) }, select: { id: true } }))!.id;
      stubs[DOMAIN_A].products = stubs[DOMAIN_A].products.filter((p) => p.id !== gid(7110));
      await catalog.fullCatalogSync(DOMAIN_A);
      ok("SL-PR-5b", "pruned product row gone", (await db.product.count({ where: { shopId: A, shopifyProductId: gid(7110) } })) === 0);
      ok("SL-PR-5c", "its passages are gone with it", (await db.productPassage.count({ where: { shopId: A, productId: pid } })) === 0);
      const g = await one(A, "sl lamp question", "get_product", { product: "Prunable Lamp" });
      ok("SL-PR-5d", "get_product no longer finds it", g.r?.title !== "Prunable Lamp", JSON.stringify(g.r).slice(0, 160));
    });

    // ═══ 1b. PRODUCT WEBHOOKS (signed request → route → enqueue → job handler) ═
    const CHIME_BODY = `<p>Rose &amp; Oud&nbsp;scented chime.</p><p>${[para("Harbor chime note one"), para("Harbor chime note two", "zqchimefact")].join("</p><p>")}</p>`;
    const chimePayload = (over: Record<string, unknown> = {}) => ({
      id: 7120, admin_graphql_api_id: gid(7120), title: "Harbor Wind Chime", body_html: CHIME_BODY, product_type: "Decor", vendor: "QA SL",
      tags: "chime, decor", status: "active", handle: "harbor-wind-chime", published_at: "2026-01-01T00:00:00Z",
      variants: [{ id: 712001, title: "Default Title", price: "40.00", inventory_quantity: 3, inventory_management: "shopify" }],
      ...over,
    });
    await kase("SL-WH-1 products/create webhook → search_products / get_product", async () => {
      const w = await webhook(productsRoute, "products/create", DOMAIN_A, chimePayload());
      ok("SL-WH-1a", "signed products/create → 200, only enqueues product-upsert, the job handler runs it", w.status === 200 && JSON.stringify(w.queued) === JSON.stringify([JOBS.productUpsert]) && w.ran.includes(JOBS.productUpsert), JSON.stringify(w));
      const s = await one(A, "wind chimes please", "search_products", { query: "wind chime" });
      ok("SL-WH-1b", "search_products returns the webhook-created product", titles(s.r).includes("Harbor Wind Chime"), JSON.stringify(titles(s.r)));
      const g = await one(A, "is the harbor chime scented zqchimefact", "get_product", { product: "Harbor Wind Chime", question: "zqchimefact" });
      const all = JSON.stringify(g.r ?? {});
      ok("SL-WH-1c", "HTML entities decoded in what get_product returns", all.includes("Rose & Oud scented chime") && !/&amp;|&nbsp;/.test(all), String(g.r?.description_overview ?? g.r?.description).slice(0, 80));
      ok("SL-WH-1d", "webhook path builds passages for a long description", (await passagesOf(gid(7120))).length >= 2);
      ok("SL-WH-1e", "get_product answers from the passage matching the question", (g.r?.description_relevant ?? []).some((p: string) => p.includes("zqchimefact")), JSON.stringify(g.r?.description_relevant ?? null).slice(0, 120));
    });

    await kase("SL-WH-2 products/update webhook → title/description/status changes propagate", async () => {
      const before = await passagesOf(gid(7120));
      const newBody = `<p>Rose &amp; Oud&nbsp;scented chime.</p><p>${[para("Harbor chime note one"), para("Harbor chime note two now covers restful sleep", "zqchimenew")].join("</p><p>")}</p>`;
      const w = await webhook(productsRoute, "products/update", DOMAIN_A, chimePayload({ title: "Harbor Bell Chime", body_html: newBody }));
      ok("SL-WH-2a", "products/update → product-upsert job ran", w.status === 200 && w.ran.includes(JOBS.productUpsert), JSON.stringify(w));
      const after = await passagesOf(gid(7120));
      ok("SL-WH-2b", "description edit rebuilt passages: none stale, new text present", !after.some((p) => p.body.includes("zqchimefact")) && after.some((p) => p.body.includes("zqchimenew")) && !after.some((p) => before.some((b) => b.id === p.id)), `before=${before.length} after=${after.length}`);
      const oldTitle = await one(A, "sl chime q", "get_product", { product: "Harbor Wind Chime" });
      const renamed = await one(A, "harbor bell chime", "get_product", { product: "Harbor Bell Chime", question: "zqchimefact" });
      ok("SL-WH-2c", "renamed title resolves; old stale passage never returned", renamed.r?.title === "Harbor Bell Chime" && !JSON.stringify(renamed.r).includes("zqchimefact") && oldTitle.r?.title !== "Harbor Wind Chime", JSON.stringify({ old: oldTitle.r?.title, now: renamed.r?.title }));
      await webhook(productsRoute, "products/update", DOMAIN_A, chimePayload({ title: "Harbor Bell Chime", body_html: newBody, status: "draft" }));
      const s = await one(A, "wind chimes please", "search_products", { query: "bell chime" });
      ok("SL-WH-2d", "update to draft → gone from search_products", !titles(s.r).includes("Harbor Bell Chime"), JSON.stringify(titles(s.r)));
      await webhook(productsRoute, "products/update", DOMAIN_A, chimePayload({ title: "Harbor Bell Chime", body_html: newBody, published_at: null }));
      const s2 = await one(A, "wind chimes please", "search_products", { query: "bell chime" });
      ok("SL-WH-2e", "active but unpublished (published_at null) → still not returned", !titles(s2.r).includes("Harbor Bell Chime"), JSON.stringify(titles(s2.r)));
      await webhook(productsRoute, "products/update", DOMAIN_A, chimePayload({ title: "Harbor Bell Chime", body_html: newBody }));
      const s3 = await one(A, "wind chimes please", "search_products", { query: "bell chime" });
      ok("SL-WH-2f", "republished active → back in search_products", titles(s3.r).includes("Harbor Bell Chime"), JSON.stringify(titles(s3.r)));
      await webhook(productsRoute, "products/update", DOMAIN_A, chimePayload({ title: "Harbor Bell Chime", body_html: newBody, variants: [{ id: 712001, title: "Default Title", price: "40.00", inventory_quantity: 0, inventory_management: "shopify", inventory_policy: "deny" }] }));
      const s4 = await one(A, "wind chimes please", "search_products", { query: "bell chime" });
      ok("SL-WH-2g", "sold out via webhook → excluded from search_products", !titles(s4.r).includes("Harbor Bell Chime"), JSON.stringify(titles(s4.r)));
      await webhook(productsRoute, "products/update", DOMAIN_A, chimePayload({ title: "Harbor Bell Chime", body_html: "<p>Short now.</p>" }));
      const shortG = await one(A, "harbor bell chime", "get_product", { product: "Harbor Bell Chime", question: "zqchimenew" });
      ok("SL-WH-2h", "description shrunk below 1,200 → passages dropped, whole description returned", (await passagesOf(gid(7120))).length === 0 && shortG.r?.description === "Short now." && !("description_relevant" in (shortG.r ?? {})), JSON.stringify(shortG.r?.description));
    });

    await kase("SL-WH-3 products/delete webhook → gone from every tool; passages removed", async () => {
      await webhook(productsRoute, "products/update", DOMAIN_A, chimePayload({ title: "Harbor Bell Chime" }));
      const pid = (await db.product.findFirst({ where: { shopId: A, shopifyProductId: gid(7120) }, select: { id: true } }))!.id;
      ok("SL-WH-3a", "precondition: passages present", (await db.productPassage.count({ where: { shopId: A, productId: pid } })) > 0);
      const w = await webhook(productsRoute, "products/delete", DOMAIN_A, { id: 7120, admin_graphql_api_id: gid(7120) });
      ok("SL-WH-3b", "products/delete → only enqueues product-delete; handler ran", w.status === 200 && JSON.stringify(w.queued) === JSON.stringify([JOBS.productDelete]) && w.ran.includes(JOBS.productDelete), JSON.stringify(w));
      ok("SL-WH-3c", "row and passages removed", (await db.product.count({ where: { shopId: A, shopifyProductId: gid(7120) } })) === 0 && (await db.productPassage.count({ where: { shopId: A, productId: pid } })) === 0);
      const s = await one(A, "wind chimes please", "search_products", { query: "bell chime" });
      const g = await one(A, "sl chime q", "get_product", { product: "Harbor Bell Chime" });
      const info = await one(A, "sl q zqchimefact", "search_store_info", { question: "zqchimefact" });
      ok("SL-WH-3d", "search_products / get_product / search_store_info no longer return it", !titles(s.r).includes("Harbor Bell Chime") && g.r?.title !== "Harbor Bell Chime" && !infoTexts(info.r).some((x) => x.includes("Harbor")), JSON.stringify({ s: titles(s.r), g: g.r?.title }));
    });

    // ═══ 2. DESCRIPTION PASSAGES (spec 25) ════════════════════════════════════
    await kase("SL-PA-1 passages built at sync for ≥1,200 chars only", async () => {
      const moon = await passagesOf(gid(7101));
      ok("SL-PA-1a", "long description → 7 sentence-grouped passages, in order", moon.length === 7 && moon.every((p, i) => p.position === i), `passages=${moon.length}`);
      ok("SL-PA-1b", "each passage ≤ ~800 chars target (no passage over 1,200)", moon.every((p) => p.body.length <= 1200), moon.map((p) => p.body.length).join(","));
      const moonRow = await db.product.findFirst({ where: { shopId: A, shopifyProductId: gid(7101) }, select: { description: true } });
      ok("SL-PA-1c", "sourceHash = hash of the normalised description", moon.every((p) => p.sourceHash === hashText(moonRow!.description.replace(/\s+/g, " ").trim())));
      ok("SL-PA-1d", "short description (<1,200) → no passages", (await passagesOf(gid(7102))).length === 0);
      const edge = "Edge case sentence. ".repeat(59) + "Edge"; // 1,184 chars
      ok("SL-PA-1e", "boundary: 1,199 chars → none; 1,200 → built", passagesMod.descriptionPassages(edge.padEnd(1199, "x")).length === 0 && passagesMod.descriptionPassages(edge.padEnd(1200, "x")).length > 0);
      fake.embedLog = [];
      const ids = moon.map((p) => p.id).join();
      await catalog.fullCatalogSync(DOMAIN_A);
      ok("SL-PA-1f", "re-sync of unchanged catalogue: zero embedding calls, passages untouched", fake.embedLog.length === 0 && (await passagesOf(gid(7101))).map((p) => p.id).join() === ids, `embed batches=${fake.embedLog.length}`);
      const rows = await countShopRows(A, DOMAIN_A);
      ok("SL-PA-1g", "countShopRows reports product_passages for the live shop", (rows.find((r) => r.table === "product_passages")?.count ?? 0) > 0, JSON.stringify(rows.find((r) => r.table === "product_passages")));
    });

    await kase("SL-PA-2 get_product(product, question) → overview + top-3 passages", async () => {
      const g = await one(A, "does the moonglow bracelet help with zqhormone", "get_product", { product: "Moonglow Crystal Bracelet", question: "zqhormone" });
      const rel: string[] = g.r?.description_relevant ?? [];
      ok("SL-PA-2a", "returns description_overview + ≤3 description_relevant + note, not the whole description", typeof g.r?.description_overview === "string" && rel.length === 3 && typeof g.r?.description_note === "string" && !("description" in (g.r ?? {})), JSON.stringify(Object.keys(g.r ?? {})));
      ok("SL-PA-2b", "the passage answering the question (past char 3,000) is included", rel.some((p) => p.includes("zqhormone")));
      const positions = rel.map((body) => MOON_DESC.indexOf(body.slice(0, 60)));
      ok("SL-PA-2c", "relevant passages are in description order", positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1])), positions.join(","));
      ok("SL-PA-2d", "overview is the description's opening and excludes the deep fact", g.r?.description_overview.includes("zqopening") && !g.r.description_overview.includes("zqhormone") && g.r.description_overview.length <= 601, `len=${g.r?.description_overview?.length}`);
      const care = await one(A, "how do I care for the moonglow", "get_product", { product: "Moonglow Crystal Bracelet", question: "zqcare" });
      ok("SL-PA-2e", "a different question returns its own passage", (care.r?.description_relevant ?? []).some((p: string) => p.includes("zqcare")));
      const noQ = await one(A, "moonglow zqhormone", "get_product", { product: "Moonglow Crystal Bracelet" });
      ok("SL-PA-2f", "no question → ranked by the shopper's own words", (noQ.r?.description_relevant ?? []).some((p: string) => p.includes("zqhormone")));
    });

    await kase("SL-PA-3 search_products carries description_about_shoppers_question only ≥ 0.55", async () => {
      const findMoon = (r: any) => (r?.results ?? []).find((x: any) => x.title === "Moonglow Crystal Bracelet");
      const full = await one(A, "does the moonglow bracelet help with zqhormone", "search_products", { query: "moonglow bracelet" });
      ok("SL-PA-3a", "score 1.0 → passage attached", String(findMoon(full.r)?.description_about_shoppers_question ?? "").includes("zqhormone"), JSON.stringify(findMoon(full.r)).slice(0, 200));
      const s60 = await one(A, "does the moonglow bracelet help zqq60h", "search_products", { query: "moonglow bracelet" });
      ok("SL-PA-3b", "score 0.60 → attached", String(findMoon(s60.r)?.description_about_shoppers_question ?? "").includes("zqhormone"));
      const s50 = await one(A, "does the moonglow bracelet help zqq50h", "search_products", { query: "moonglow bracelet" });
      ok("SL-PA-3c", "score 0.50 → not attached", findMoon(s50.r) && !("description_about_shoppers_question" in findMoon(s50.r)), JSON.stringify(findMoon(s50.r) ? Object.keys(findMoon(s50.r)) : null));
      const same = "moonglow bracelet zqhormone";
      const eq = await one(A, same, "search_products", { query: same });
      ok("SL-PA-3d", "model query == shopper message → no extra field", findMoon(eq.r) && !("description_about_shoppers_question" in findMoon(eq.r)));
      const lane = await one(A, "sl meaning question", "search_products", { query: "zqtidefact" });
      const tide = (lane.r?.results ?? []).find((x: any) => x.title === "Tidepool Bracelet");
      ok("SL-PA-3e", "passage lane: a deep fact finds its product and the snippet quotes the matching description", !!tide && /matching description: .*zqtidefact/.test(tide.details), JSON.stringify(tide).slice(0, 200));
    });

    await kase("SL-PA-4 search_store_info returns 'product description' passages (showable, non-boilerplate)", async () => {
      const info = await one(A, "does moonglow help zqhormone", "search_store_info", { question: "does it help zqhormone" });
      const hit = (info.r?.results ?? []).find((x: any) => x.source === "product description");
      ok("SL-PA-4a", "product question through store info reaches the product's own passage", hit?.topic === "Moonglow Crystal Bracelet" && hit.text.includes("zqhormone"), JSON.stringify(hit).slice(0, 160));
      const boiler = await one(A, "sl shipping zqboiler", "search_store_info", { question: "zqboiler" });
      ok("SL-PA-4b", "a passage repeated across ≥3 products (boilerplate) is excluded", !infoTexts(boiler.r).some((x) => x.startsWith("product description")), JSON.stringify(infoTexts(boiler.r)).slice(0, 160));
      const sold = await one(A, "sl facts zqsoldfact", "search_store_info", { question: "zqsoldfact" });
      ok("SL-PA-4c", "DEFECT-CHECK: an out-of-stock product's passage is not served while excludeOutOfStock is on (spec 25 invariant: passages join back to showable products incl. stock filters)", !infoTexts(sold.r).some((x) => /zqsoldfact/.test(x)), `${JSON.stringify(infoTexts(sold.r)).slice(0, 120)} (searchProductPassages filters learn/status/published but not stock)`);
    });

    await kase("SL-PA-5 passage lane is agent-only", async () => {
      const vec = fake.vectorFor("zqhormone");
      const base = { shopId: A, queryEmbedding: vec, keywords: [], message: "", priceMax: null, minMeaningScore: 0.3, excludeOutOfStock: true, limit: 8 };
      const without = await hybridProductSearch(base);
      const withP = await hybridProductSearch({ ...base, usePassages: true });
      ok("SL-PA-5a", "without usePassages the deep fact does not surface the product (pipeline behaviour)", !without.some((c) => c.title === "Moonglow Crystal Bracelet"), JSON.stringify(without.map((c) => c.title)));
      ok("SL-PA-5b", "with usePassages it does, carrying the passage", withP.some((c) => c.title === "Moonglow Crystal Bracelet" && (c.passage ?? "").includes("zqhormone")));
      ok("SL-PA-5c", "the rollback pipeline (index.server.ts) never enables the passage lane; only agent search_products does", !/usePassages/.test(src("app/lib/pipeline/index.server.ts")) && (src("app/lib/pipeline/agent.server.ts").match(/usePassages: true/g) ?? []).length === 1);
    });

    // ═══ 2b. BACKFILL SCRIPT ══════════════════════════════════════════════════
    await kase("SL-BF-1 backfill --shop idempotent, --force rebuilds", async () => {
      const tideRow = await db.product.findFirst({ where: { shopId: A, shopifyProductId: gid(7103) }, select: { id: true } });
      await db.productPassage.deleteMany({ where: { shopId: A, productId: tideRow!.id } }); // a product synced before passages existed
      const total = async () => db.productPassage.count({ where: { shopId: A } });
      const snapshot = async () => (await db.productPassage.findMany({ where: { shopId: A }, select: { id: true }, orderBy: { id: "asc" } })).map((p) => p.id).join();
      const scriptUrl = pathToFileURL(join(process.cwd(), "scripts/backfill-product-passages.ts")).href;
      const run = async (args: string[], tag: string): Promise<{ code: number | undefined; log: string }> => {
        const argv = process.argv;
        const exit = process.exit;
        const log = console.log;
        const lines: string[] = [];
        let resolveExit!: (code: number | undefined) => void;
        const exited = new Promise<number | undefined>((r) => { resolveExit = r; });
        process.argv = [argv[0], "backfill-product-passages.ts", ...args];
        (process as any).exit = (code?: number) => { resolveExit(code); };
        console.log = (...parts: unknown[]) => { lines.push(parts.join(" ")); };
        try {
          await import(`${scriptUrl}?qa-sl=${tag}`);
          const code = await Promise.race([exited, sleep(60_000).then(() => -1)]);
          return { code, log: lines.join("\n") };
        } finally {
          process.argv = argv;
          process.exit = exit;
          console.log = log;
        }
      };
      let first: { code: number | undefined; log: string };
      try {
        first = await run(["--shop", DOMAIN_A], "1");
      } catch (error) {
        skip("SL-BF-1", `backfill script could not be loaded in-process: ${String(error).slice(0, 120)}`);
        return;
      }
      const afterFirst = await total();
      ok("SL-BF-1a", "--shop builds passages for a product that had none", first.code === 0 && (await passagesOf(gid(7103))).length === 3, `exit=${first.code} tide=${(await passagesOf(gid(7103))).length} log=${first.log.slice(0, 120)}`);
      const ids = await snapshot();
      fake.embedLog = [];
      const second = await run(["--shop", DOMAIN_A], "2");
      ok("SL-BF-1b", "second --shop run is idempotent: no embeddings, same passage rows", second.code === 0 && fake.embedLog.length === 0 && (await snapshot()) === ids && (await total()) === afterFirst, `exit=${second.code} embeds=${fake.embedLog.length}`);
      const forced = await run(["--shop", DOMAIN_A, "--force"], "3");
      const after = await snapshot();
      ok("SL-BF-1c", "--force deletes and rebuilds every passage (new rows, same count)", forced.code === 0 && (await total()) === afterFirst && after.split(",").every((id) => !ids.split(",").includes(id)), `exit=${forced.code} count=${await total()} log=${forced.log.split("\n")[0]}`);
      const g = await one(A, "does the moonglow bracelet help with zqhormone", "get_product", { product: "Moonglow Crystal Bracelet", question: "zqhormone" });
      ok("SL-BF-1d", "tools keep answering from the rebuilt passages", (g.r?.description_relevant ?? []).some((p: string) => p.includes("zqhormone")));
    }, 180_000);

    // ═══ 3a. COLLECTIONS ═════════════════════════════════════════════════════
    const COL = "gid://shopify/Collection/7301";
    await kase("SL-CO-1 collections webhook → upsert + membership → search_store_info; delete", async () => {
      stubs[DOMAIN_A].members[COL] = [gid(7101), gid(7103)];
      const w = await webhook(collectionsRoute, "collections/create", DOMAIN_A, { id: 7301, admin_graphql_api_id: COL, title: "Moon Rituals Collection", body_html: "<p>Calm stones</p>" });
      ok("SL-CO-1a", "signed collections/create → 200, only enqueues collection-upsert; handler ran", w.status === 200 && JSON.stringify(w.queued) === JSON.stringify([JOBS.collectionUpsert]) && w.ran.includes(JOBS.collectionUpsert), JSON.stringify(w));
      const members = await db.collectionProduct.findMany({ where: { shopId: A, collectionId: COL }, select: { shopifyProductId: true } });
      ok("SL-CO-1b", "membership mirrored from the Admin API", members.length === 2, `members=${members.length}`);
      const fresh = await one(A, "what collections do you have", "search_store_info", { question: "What collections do you have?" });
      // 2026-09-16 (owner): new collections are learned by default, like products, pages and articles.
      ok("SL-CO-1c", "a new collection arrives learned and is listed straight away", (fresh.r?.collections ?? []).includes("Moon Rituals Collection"), JSON.stringify(fresh.r?.collections));
      stubs[DOMAIN_A].members[COL] = [gid(7101)];
      await webhook(collectionsRoute, "collections/update", DOMAIN_A, { id: 7301, admin_graphql_api_id: COL, title: "Moon Rites Collection", body_html: "" });
      const info2 = await one(A, "what collections do you have", "search_store_info", { question: "What collections do you have?" });
      ok("SL-CO-1d", "update: renamed title served (learn choice kept), old title gone, membership refreshed", (info2.r?.collections ?? []).includes("Moon Rites Collection") && !(info2.r?.collections ?? []).includes("Moon Rituals Collection") && (await db.collectionProduct.count({ where: { shopId: A, collectionId: COL } })) === 1, JSON.stringify(info2.r?.collections));
      await db.collection.updateMany({ where: { shopId: A, shopifyCollectionId: COL }, data: { learnEnabled: false } });
      const off = await one(A, "what collections do you have", "search_store_info", { question: "What collections do you have?" });
      ok("SL-CO-1e", "per-row learn off → not listed", !(off.r?.collections ?? []).includes("Moon Rites Collection"));
      await db.collection.updateMany({ where: { shopId: A, shopifyCollectionId: COL }, data: { learnEnabled: true } });
      await setLearn(A, "collections", false);
      const master = await one(A, "what collections do you have", "search_store_info", { question: "What collections do you have?" });
      ok("SL-CO-1f", "master Learn collections off → no collections at all", (master.r?.collections ?? []).length === 0);
      await setLearn(A, "collections", true);
      const del = await webhook(collectionsRoute, "collections/delete", DOMAIN_A, { id: 7301, admin_graphql_api_id: COL });
      const gone = await one(A, "what collections do you have", "search_store_info", { question: "What collections do you have?" });
      ok("SL-CO-1g", "collections/delete → job ran; row + membership gone; not listed", del.ran.includes(JOBS.collectionDelete) && (await db.collectionProduct.count({ where: { shopId: A, collectionId: COL } })) === 0 && !(gone.r?.collections ?? []).some((c: string) => c.startsWith("Moon Rit")), JSON.stringify(gone.r?.collections));
    });

    await kase("SL-CO-2 full collection sync on a busy install: rate limits, chunks, learn default, prune", async () => {
      const col = (n: number) => ({ id: `gid://shopify/Collection/74${n}`, title: `Sync Collection ${n}`, description: "", productsCount: { count: 1 }, ruleSet: null });
      stubs[DOMAIN_A].collections = [col(1), col(2), col(3), col(4), col(5)];
      for (const c of stubs[DOMAIN_A].collections) stubs[DOMAIN_A].members[c.id] = [gid(7101)];
      await db.collection.create({ data: { shopId: A, shopifyCollectionId: "gid://shopify/Collection/7499", title: "Deleted in Shopify" } });
      await db.collection.create({ data: { shopId: A, shopifyCollectionId: col(1).id, title: "Kept choice", learnEnabled: false } });
      await new Promise((r) => setTimeout(r, 20)); // pre-existing rows are older than the run

      const queued: any[] = [];
      const realSend = (global as any).pgBossGlobal.boss.send;
      // Captured only — the loop below runs them, and they must not reach the
      // shared stub queue a later webhook case inspects.
      (global as any).pgBossGlobal.boss.send = async (name: string, data: any) => {
        queued.push({ name, data });
        return "qa-captured";
      };
      throttleCollectionCalls = 2;
      collectionPageSize = 2;
      try {
        await catalog.fullCollectionSync(DOMAIN_A, { budgetMs: 0 });
        const first = queued.find((j) => j.name === "collection-sync");
        ok("SL-CO-2a", "THROTTLED answers are waited out; an out-of-time run queues a continuation with its cursor", throttleCollectionCalls === 0 && Boolean(first?.data?.cursor) && Boolean(first?.data?.runStartedAt), JSON.stringify(first?.data));
        let guard = 0;
        while (queued.some((j) => j.name === "collection-sync") && guard++ < 20) {
          const job = queued.find((j) => j.name === "collection-sync");
          queued.splice(queued.indexOf(job), 1);
          const { shopDomain, ...resume } = job.data;
          await catalog.fullCollectionSync(shopDomain, { ...resume, budgetMs: 0 });
        }
      } finally {
        (global as any).pgBossGlobal.boss.send = realSend;
        throttleCollectionCalls = 0;
        collectionPageSize = null;
      }
      const rows = await db.collection.findMany({ where: { shopId: A, shopifyCollectionId: { startsWith: "gid://shopify/Collection/74" } }, select: { shopifyCollectionId: true, learnEnabled: true } });
      const state = await db.syncState.findUnique({ where: { shopId: A } });
      ok("SL-CO-2b", "every collection synced across the chunks, sync stamped", rows.length === 5 && Boolean(state?.collectionSyncAt), `rows=${rows.length}`);
      ok("SL-CO-2c", "new collections are learned; an existing row keeps the merchant's choice", rows.filter((r) => r.shopifyCollectionId !== col(1).id).every((r) => r.learnEnabled) && rows.find((r) => r.shopifyCollectionId === col(1).id)?.learnEnabled === false);
      ok("SL-CO-2d", "a collection no longer in Shopify is pruned after the last chunk", (await db.collection.count({ where: { shopId: A, shopifyCollectionId: "gid://shopify/Collection/7499" } })) === 0);
      await db.collection.deleteMany({ where: { shopId: A, shopifyCollectionId: { startsWith: "gid://shopify/Collection/74" } } });
      await db.collectionProduct.deleteMany({ where: { shopId: A, collectionId: { startsWith: "gid://shopify/Collection/74" } } });
      stubs[DOMAIN_A].collections = [];
    }, 120_000);

    // ═══ 3b. DISCOUNTS ═══════════════════════════════════════════════════════
    const disc = (n: number, o: { title: string; code?: string; status?: string; startsAt?: string | null; endsAt?: string | null; auto?: boolean }) => ({
      id: `gid://shopify/Discount${o.auto ? "Automatic" : "Code"}Node/${n}`,
      discount: {
        __typename: o.auto ? "DiscountAutomaticBasic" : "DiscountCodeBasic", title: o.title, summary: `${o.title} summary`, status: o.status ?? "ACTIVE",
        startsAt: o.startsAt ?? null, endsAt: o.endsAt ?? null, discountClasses: ["ORDER"], asyncUsageCount: 0,
        ...(o.auto ? {} : { codes: { nodes: [{ code: o.code }] } }),
      },
    });
    const DAY = 86_400_000;
    await kase("SL-DI-1 discount full sync → get_discounts (active, dated, gated)", async () => {
      stubs[DOMAIN_A].discounts = [
        disc(8101, { title: "Spring sale", code: "SPRING15" }),
        disc(8102, { title: "Free gift", auto: true }),
        disc(8103, { title: "Old promo", code: "OLDPROMO", endsAt: new Date(Date.now() - DAY).toISOString() }),
        disc(8104, { title: "Future promo", code: "FUTURE20", startsAt: new Date(Date.now() + 5 * DAY).toISOString() }),
        disc(8105, { title: "Expired status", code: "EXPSTATUS", status: "EXPIRED" }),
      ];
      await catalog.fullDiscountSync(DOMAIN_A);
      const g = await one(A, "any discount codes", "get_discounts", {});
      const text = String(g.r?.discounts ?? "");
      ok("SL-DI-1a", "active code discount quoted with its code", text.includes("SPRING15"), text.slice(0, 200));
      ok("SL-DI-1b", "automatic discount says no code needed", /Free gift.*applies automatically/.test(text));
      ok("SL-DI-1c", "past endsAt, future startsAt and non-active status are never quoted", !/OLDPROMO|FUTURE20|EXPSTATUS/.test(text));
      await db.discount.updateMany({ where: { shopId: A, shopifyDiscountId: disc(8101, { title: "" }).id }, data: { learnEnabled: false } });
      const rowOff = await one(A, "any discount codes", "get_discounts", {});
      ok("SL-DI-1d", "per-row learn off → code not quoted", !String(rowOff.r?.discounts).includes("SPRING15"));
      await db.discount.updateMany({ where: { shopId: A, shopifyDiscountId: disc(8101, { title: "" }).id }, data: { learnEnabled: true } });
      await setLearn(A, "discounts", false);
      const off = await one(A, "any discount codes", "get_discounts", {});
      ok("SL-DI-1e", "master Learn discounts off → tool not offered; forced call refused, no code", !off.tools.includes("get_discounts") && typeof off.r?.error === "string" && !JSON.stringify(off.r).includes("SPRING15"), JSON.stringify({ tools: off.tools, r: off.r }));
      await setLearn(A, "discounts", true);
    });

    await kase("SL-DI-2 discounts webhook create / update-to-expired / delete → get_discounts", async () => {
      const node = disc(8110, { title: "Webhook deal", code: "HOOK25" });
      stubs[DOMAIN_A].discounts.push(node);
      const w = await webhook(discountsRoute, "discounts/create", DOMAIN_A, { admin_graphql_api_id: node.id, title: "Webhook deal", status: "ACTIVE" });
      ok("SL-DI-2a", "signed discounts/create → 200, only enqueues discount-upsert; handler ran", w.status === 200 && JSON.stringify(w.queued) === JSON.stringify([JOBS.discountUpsert]) && w.ran.includes(JOBS.discountUpsert), JSON.stringify(w));
      const g = await one(A, "any discount codes", "get_discounts", {});
      ok("SL-DI-2b", "new discount quoted with the code refetched from the Admin API", String(g.r?.discounts).includes("HOOK25"), String(g.r?.discounts).slice(0, 200));
      node.discount.endsAt = new Date(Date.now() - 60_000).toISOString();
      await webhook(discountsRoute, "discounts/update", DOMAIN_A, { admin_graphql_api_id: node.id, title: "Webhook deal", status: "EXPIRED" });
      const exp = await one(A, "any discount codes", "get_discounts", {});
      ok("SL-DI-2c", "update to expired → no longer quoted", !String(exp.r?.discounts).includes("HOOK25"));
      node.discount.endsAt = null;
      await webhook(discountsRoute, "discounts/update", DOMAIN_A, { admin_graphql_api_id: node.id, title: "Webhook deal", status: "ACTIVE" });
      stubs[DOMAIN_A].discounts = stubs[DOMAIN_A].discounts.filter((n) => n.id !== node.id); // deleted in Shopify
      const d = await webhook(discountsRoute, "discounts/delete", DOMAIN_A, { admin_graphql_api_id: node.id });
      const del = await one(A, "any discount codes", "get_discounts", {});
      ok("SL-DI-2d", "discounts/delete → job ran; code gone", d.ran.includes(JOBS.discountDelete) && !String(del.r?.discounts).includes("HOOK25"));
    });

    await kase("SL-DI-3 missed delete webhook → Sync converges", async () => {
      const pre = await one(A, "any discount codes", "get_discounts", {});
      ok("SL-DI-3a", "precondition: SPRING15 quoted", String(pre.r?.discounts).includes("SPRING15"));
      stubs[DOMAIN_A].discounts = stubs[DOMAIN_A].discounts.filter((n) => !n.id.endsWith("/8101")); // SPRING15 deleted in Shopify; webhook lost
      await catalog.fullDiscountSync(DOMAIN_A);
      const g = await one(A, "any discount codes", "get_discounts", {});
      const still = String(g.r?.discounts).includes("SPRING15");
      ok("SL-DI-3b", "DEFECT-CHECK: a discount deleted in Shopify is no longer quoted after the tab's Sync (spec 02: Sync heals a lost webhook)", !still, `SPRING15 still quoted=${still}; row present=${(await db.discount.count({ where: { shopId: A, shopifyDiscountId: { endsWith: "/8101" } } })) > 0} (fullDiscountSync upserts but never prunes unseen rows, unlike products/collections)`);
    });

    // ═══ 4. PAGES & BLOGS ════════════════════════════════════════════════════
    const PAGE1 = "gid://shopify/Page/7401";
    const PAGE2 = "gid://shopify/Page/7402";
    const ART1 = "gid://shopify/Article/7501";
    const pageNode = (id: string, title: string, body: string, isPublished = true, updatedAt = "2026-09-01T00:00:00Z") => ({ id, title, handle: title.toLowerCase().replace(/\s+/g, "-"), body, isPublished, updatedAt });
    await kase("SL-PG-1 pages & blogs sync → bridge chunks → search_store_info; edits and learn switches", async () => {
      stubs[DOMAIN_A].pages = [pageNode(PAGE1, "Workshop visits", "<p>Visit our workshop on Saturdays zqpage1.</p>"), pageNode(PAGE2, "Unreleased page", "<p>Secret launch zqpagedraft.</p>", false)];
      stubs[DOMAIN_A].articles = [{ ...pageNode(ART1, "Caring for moonstone", "<p>Rinse gently zqarticle.</p>"), summary: null, tags: [], author: { name: "QA" }, blog: { id: "gid://shopify/Blog/1", title: "Care guides" } }];
      const pr = await content.fullPageSync(DOMAIN_A);
      const ar = await content.fullArticleSync(DOMAIN_A);
      const bridgeIds = (await db.dataSource.findMany({ where: { shopId: A, type: { in: ["store_pages", "blog_articles"] } }, select: { id: true } })).map((s) => s.id);
      const bridgeChunks = await db.knowledge.count({ where: { shopId: A, dataSourceId: { in: bridgeIds } } });
      ok("SL-PG-1a", "sync mirrors pages + articles and rebuilds the bridges (draft page excluded)", pr?.synced === 2 && ar?.synced === 1 && bridgeChunks === 2, `pages=${pr?.synced} articles=${ar?.synced} chunks=${bridgeChunks}`);
      const p = await one(A, "can I visit your workshop zqpage1", "search_store_info", { question: "Can I visit the workshop?" });
      ok("SL-PG-1b", "search_store_info returns the page chunk", infoTexts(p.r).some((x) => x.includes("zqpage1")), JSON.stringify(infoTexts(p.r)).slice(0, 160));
      const a = await one(A, "how to rinse moonstone zqarticle", "search_store_info", { question: "How do I rinse moonstone?" });
      ok("SL-PG-1c", "search_store_info returns the article chunk with its blog name", infoTexts(a.r).some((x) => x.includes("Caring for moonstone (Care guides)") && x.includes("zqarticle")));
      const d = await one(A, "secret launch zqpagedraft", "search_store_info", { question: "Is there a secret launch?" });
      ok("SL-PG-1d", "an unpublished page arrives learn-off and is never served", !infoTexts(d.r).some((x) => x.includes("zqpagedraft")));
      stubs[DOMAIN_A].pages[0] = pageNode(PAGE1, "Workshop visits", "<p>Visit our workshop on Sundays zqpage1b.</p>", true, "2026-09-10T00:00:00Z");
      await content.fullPageSync(DOMAIN_A);
      const e = await one(A, "workshop zqpage1 zqpage1b", "search_store_info", { question: "When is the workshop open?" });
      ok("SL-PG-1e", "page edit → new text served, old text gone", infoTexts(e.r).some((x) => x.includes("zqpage1b")) && !infoTexts(e.r).some((x) => /zqpage1(?!b)/.test(x)), JSON.stringify(infoTexts(e.r)).slice(0, 160));
      await setLearn(A, "pages", false);
      await content.rebuildContentBridge(A, "pages"); // the Training route's queued path → captured job
      const ran = await drainJobs();
      const off = await one(A, "workshop zqpage1b", "search_store_info", { question: "When is the workshop open?" });
      ok("SL-PG-1f", "master Learn pages off → queued bridge rebuild (knowledge-ingest job) → not served", ran.includes("knowledge-ingest") && !infoTexts(off.r).some((x) => x.includes("zqpage1b")), JSON.stringify(ran));
      await setLearn(A, "pages", true);
      await content.rebuildContentBridge(A, "pages", { inline: true });
      await setLearn(A, "blogs", false);
      await content.rebuildContentBridge(A, "blogs", { inline: true });
      const boff = await one(A, "rinse zqarticle", "search_store_info", { question: "How do I rinse moonstone?" });
      ok("SL-PG-1g", "master Learn blogs off → article not served", !infoTexts(boff.r).some((x) => x.includes("zqarticle")));
      await setLearn(A, "blogs", true);
      await content.rebuildContentBridge(A, "blogs", { inline: true });
    });

    await kase("SL-PG-2 per-page learn-off survives prune + re-create (tool level)", async () => {
      await db.storePage.updateMany({ where: { shopId: A, shopifyPageId: PAGE1 }, data: { learnEnabled: false } });
      await content.rebuildContentBridge(A, "pages", { inline: true });
      const off = await one(A, "workshop zqpage1b", "search_store_info", { question: "When is the workshop open?" });
      ok("SL-PG-2a", "per-page learn off → not served", !infoTexts(off.r).some((x) => x.includes("zqpage1b")));
      const kept = stubs[DOMAIN_A].pages;
      stubs[DOMAIN_A].pages = kept.filter((n) => n.id !== PAGE1);
      await content.fullPageSync(DOMAIN_A);
      stubs[DOMAIN_A].pages = [pageNode(PAGE1, "Workshop visits", "<p>Visit our workshop on Sundays zqpage1b.</p>", true, "2026-09-12T00:00:00Z"), ...stubs[DOMAIN_A].pages];
      await content.fullPageSync(DOMAIN_A);
      const back = await one(A, "workshop zqpage1b", "search_store_info", { question: "When is the workshop open?" });
      ok("SL-PG-2b", "deleted then re-created in Shopify → still learn-off, still not served", !infoTexts(back.r).some((x) => x.includes("zqpage1b")) && (await db.storePage.findFirst({ where: { shopId: A, shopifyPageId: PAGE1 } }))?.learnEnabled === false);
    });

    await kase("SL-PG-3 plan cap (pages_synced on Free) limits what the agent can read", async () => {
      const cap = getQuota("free", "pages_synced");
      const pagesB = Array.from({ length: cap + 2 }, (_, i) => {
        const word = `zqcappage${i}x`;
        needle(word);
        // newest first, like the real query
        return pageNode(`gid://shopify/Page/76${String(i).padStart(2, "0")}`, `Cap page ${i}`, `<p>Cap page body ${word}.</p>`, true, new Date(Date.UTC(2026, 8, 1) - i * DAY).toISOString());
      });
      stubs[DOMAIN_B].pages = pagesB;
      const r = await content.fullPageSync(DOMAIN_B);
      ok("SL-PG-3a", `Free plan: sync stops at the cap (${cap}) and flags capped`, r?.synced === cap && r.capped === true && (await db.storePage.count({ where: { shopId: B } })) === cap, JSON.stringify(r));
      const newest = await one(B, "sl cap question zqcappage0x", "search_store_info", { question: "zqcappage0x" });
      const beyond = await one(B, `sl cap question zqcappage${cap + 1}x`, "search_store_info", { question: `zqcappage${cap + 1}x` });
      ok("SL-PG-3b", "the newest page is served; a page beyond the cap is not", infoTexts(newest.r).some((x) => x.includes("zqcappage0x")) && !infoTexts(beyond.r).some((x) => x.includes(`zqcappage${cap + 1}x`)), JSON.stringify({ n: infoTexts(newest.r).length, b: infoTexts(beyond.r) }).slice(0, 160));
    });

    // ═══ 5. KNOWLEDGE SOURCES ════════════════════════════════════════════════
    await kase("SL-KS-1 manual / csv / file / url sources → ingest → search_store_info", async () => {
      const manual = await db.dataSource.create({ data: { shopId: A, type: "manual", name: "Gift wrap", status: "pending", metadata: { question: "Do you gift wrap?", answer: "Yes, free gift wrap zqmanual." } } });
      await ingest.ingestSource(A, manual.id);
      const csv = await db.dataSource.create({ data: { shopId: A, type: "csv", name: "Legacy CSV", status: "pending", metadata: { rows: [{ question: "Resize?", answer: "Free resizing zqcsvone." }, { question: "Engrave?", answer: "Engraving zqcsvtwo." }, { question: "", answer: "dropped" }] } } });
      await ingest.ingestSource(A, csv.id);
      const file = await sources.createSource(A, { type: "file", name: "warranty.txt", title: "Warranty terms", mime: "text/plain", bytes: Buffer.from("Warranty: two years on every bracelet zqfile.") });
      crawl.set("/care", "<html><head><title>Care guide | QA</title></head><body><main><p>Store bracelets dry zqurl.</p></main></body></html>");
      const url = await sources.createSource(A, { type: "url", url: `http://${FAKE_HOST}/care`, reCrawlWeekly: true, status: "active" });
      const queued = sentJobs.map((j) => j.name);
      const ran = await drainJobs();
      ok("SL-KS-1a", "file + url sources enqueue knowledge-ingest; the job handler ingests them", queued.filter((n) => n === "knowledge-ingest").length === 2 && ran.filter((n) => n === "knowledge-ingest").length === 2, JSON.stringify({ queued, ran }));
      const rows = await db.dataSource.findMany({ where: { shopId: A, id: { in: [manual.id, csv.id, file.id, url.id] } }, select: { type: true, status: true, chunkCount: true } });
      ok("SL-KS-1b", "all four active with chunks (csv: 2 valid rows)", rows.every((s) => s.status === "active" && s.chunkCount > 0) && rows.find((s) => s.type === "csv")?.chunkCount === 2, JSON.stringify(rows));
      for (const [word, label] of [["zqmanual", "manual"], ["zqcsvone", "csv row 1"], ["zqcsvtwo", "csv row 2"], ["zqfile", "file"], ["zqurl", "url"]] as const) {
        const r = await one(A, `sl knowledge question ${word}`, "search_store_info", { question: `question about ${word}` });
        ok(`SL-KS-1c.${label.replace(/\s/g, "")}`, `${label} source served by search_store_info as store info`, infoTexts(r.r).some((x) => x.startsWith("store info") && x.includes(word)), JSON.stringify(infoTexts(r.r)).slice(0, 160));
      }
      (globalThis as any).__slUrlId = url.id;
    });

    await kase("SL-KS-2 inactive never served (rebuild, failed recrawl); enabled keeps last good chunks", async () => {
      const urlId = (globalThis as any).__slUrlId as string;
      crawl.set("/off", "<html><head><title>Old promo</title></head><body><p>Expired promo zqoffurl.</p></body></html>");
      const off = await sources.createSource(A, { type: "url", url: `http://${FAKE_HOST}/off`, reCrawlWeekly: true, status: "active" });
      await drainJobs();
      const on = await one(A, "sl promo zqoffurl", "search_store_info", { question: "zqoffurl" });
      ok("SL-KS-2a", "precondition: source served while active", infoTexts(on.r).some((x) => x.includes("zqoffurl")));
      const meta = ((await db.dataSource.findFirst({ where: { id: off.id, shopId: A } }))?.metadata ?? {}) as object;
      await db.dataSource.updateMany({ where: { id: off.id, shopId: A }, data: { status: "inactive", metadata: { ...meta, desiredStatus: "inactive" } } }); // Training route's switch
      const t1 = await one(A, "sl promo zqoffurl", "search_store_info", { question: "zqoffurl" });
      ok("SL-KS-2b", "switched inactive → not served", !infoTexts(t1.r).some((x) => x.includes("zqoffurl")));
      await sources.resyncSource(A, off.id);
      const rebuilt = await drainJobs();
      const t2 = await one(A, "sl promo zqoffurl", "search_store_info", { question: "zqoffurl" });
      ok("SL-KS-2c", "queued rebuild of an inactive source → still inactive, not served", rebuilt.includes("knowledge-ingest") && (await db.dataSource.findFirst({ where: { id: off.id } }))?.status === "inactive" && !infoTexts(t2.r).some((x) => x.includes("zqoffurl")));
      crawl.set("/off", new Error("down"));
      await ingest.ingestSource(A, off.id).catch(() => undefined);
      const t3 = await one(A, "sl promo zqoffurl", "search_store_info", { question: "zqoffurl" });
      ok("SL-KS-2d", "failed recrawl of an inactive source → still not served", !infoTexts(t3.r).some((x) => x.includes("zqoffurl")), `status=${(await db.dataSource.findFirst({ where: { id: off.id } }))?.status}`);

      crawl.set("/care", new Error("down"));
      await ingest.ingestSource(A, urlId).catch(() => undefined);
      const errRow = await db.dataSource.findFirst({ where: { id: urlId, shopId: A } });
      const t4 = await one(A, "sl care zqurl", "search_store_info", { question: "zqurl" });
      ok("SL-KS-2e", "enabled source whose recrawl fails → status error, last good chunk still served", errRow?.status === "error" && infoTexts(t4.r).some((x) => x.includes("zqurl")), `status=${errRow?.status}`);
      await sources.resyncSource(A, urlId); // pending, queued
      const pendingRow = await db.dataSource.findFirst({ where: { id: urlId, shopId: A } });
      const t5 = await one(A, "sl care zqurl", "search_store_info", { question: "zqurl" });
      ok("SL-KS-2f", "while the rebuild is pending → last good chunk still served", pendingRow?.status === "pending" && infoTexts(t5.r).some((x) => x.includes("zqurl")), `status=${pendingRow?.status}`);
      crawl.set("/care", "<html><head><title>Care guide | QA</title></head><body><p>Store bracelets in a pouch zqurlnew.</p></body></html>");
      await drainJobs();
      const t6 = await one(A, "sl care zqurl zqurlnew", "search_store_info", { question: "How to store bracelets?" });
      ok("SL-KS-2g", "recrawl succeeds → new text replaces the old", infoTexts(t6.r).some((x) => x.includes("zqurlnew")) && !infoTexts(t6.r).some((x) => /zqurl(?!new)/.test(x)), JSON.stringify(infoTexts(t6.r)).slice(0, 160));
      await sources.deleteSource(A, urlId);
      const t7 = await one(A, "sl care zqurlnew", "search_store_info", { question: "zqurlnew" });
      ok("SL-KS-2h", "deleted source → not served, no orphan chunks", !infoTexts(t7.r).some((x) => x.includes("zqurlnew")) && (await db.knowledge.count({ where: { shopId: A, dataSourceId: urlId } })) === 0);
    });

    // ═══ 6. STORE INFO / FAQ BRIDGES + PRELOAD ═══════════════════════════════
    await kase("SL-SI-1 store info + FAQ bridges → search_store_info", async () => {
      await setSettings(A, (s) => ({ ...s, storeInfo: { ...s.storeInfo, name: "Quill QA", about: "We are a small studio in Vesterholm zqabout." } }));
      await ingest.syncStoreInfoKnowledge(A);
      const r = await one(A, "who are you zqabout", "search_store_info", { question: "Who are you?" });
      ok("SL-SI-1a", "store info served under 'About <store name>'", infoTexts(r.r).some((x) => x.includes("About Quill QA") && x.includes("zqabout")), JSON.stringify(infoTexts(r.r)).slice(0, 160));
      await setSettings(A, (s) => ({ ...s, storeInfo: { ...s.storeInfo, about: "We moved to Larkspur zqaboutnew." } }));
      await ingest.syncStoreInfoKnowledge(A);
      const r2 = await one(A, "where are you zqabout zqaboutnew", "search_store_info", { question: "Where are you based?" });
      ok("SL-SI-1b", "edited store info replaces the old text", infoTexts(r2.r).some((x) => x.includes("zqaboutnew")) && !infoTexts(r2.r).some((x) => /zqabout(?!new)/.test(x)));
      const categoryId = await ensureDefaultCategory(A);
      const faqId = await saveFaq(A, { question: "Do you engrave?", answerHtml: "<p>Yes, hand engraving zqfaq.</p>", status: "published", categoryId });
      const f = await one(A, "do you engrave zqfaq", "search_store_info", { question: "Do you engrave?" });
      ok("SL-SI-1c", "published FAQ served", infoTexts(f.r).some((x) => x.includes("zqfaq")));
      await saveFaq(A, { id: faqId, question: "Do you engrave?", answerHtml: "<p>Yes, hand engraving zqfaq.</p>", status: "draft", categoryId });
      const f2 = await one(A, "do you engrave zqfaq", "search_store_info", { question: "Do you engrave?" });
      ok("SL-SI-1d", "FAQ back to draft → not served", !infoTexts(f2.r).some((x) => x.includes("zqfaq")));
    });

    await kase("SL-SI-2 store-info preload: ≥ 0.45, top 2", async () => {
      const Q = nextDim++;
      needleVec("zqpreq", basis(Q));
      needleVec("zqpre70", mix(0.7, Q, nextDim++));
      needleVec("zqpre60", mix(0.6, Q, nextDim++));
      needleVec("zqpre50", mix(0.5, Q, nextDim++));
      const L = nextDim++;
      needleVec("zqlowq", basis(L));
      needleVec("zqlow44", mix(0.44, L, nextDim++));
      const Hd = nextDim++;
      needleVec("zqhiq", basis(Hd));
      needleVec("zqhi46", mix(0.46, Hd, nextDim++));
      const mk = async (q: string, answer: string) => {
        const s = await db.dataSource.create({ data: { shopId: A, type: "manual", name: q, status: "pending", metadata: { question: q, answer } } });
        await ingest.ingestSource(A, s.id);
      };
      await mk("Topic seventy", "Seventy answer zqpre70 about delivery windows.");
      await mk("Topic sixty", "Sixty answer zqpre60 about parcel lockers.");
      await mk("Topic fifty", "Fifty answer zqpre50 about courier choice.");
      await mk("Topic low", "Low answer zqlow44 about wrapping paper.");
      await mk("Topic high", "High answer zqhi46 about loyalty points.");
      const preload = (t: Turn): string[] => {
        const m = t.round0.find((x: any) => x.role === "system" && String(x.content).startsWith("Possibly related store information"));
        if (!m) return [];
        return (JSON.parse(String(m.content).slice(String(m.content).indexOf("\n") + 1)) as Array<{ topic: string }>).map((x) => x.topic);
      };
      const t1 = await turn(A, "sl preload question zqpreq", [{ name: "search_store_info", args: { question: "zqpreq" } }]);
      ok("SL-SI-2a", "three matches ≥ 0.45 → exactly the top 2 preloaded before the first model round", JSON.stringify(preload(t1)) === JSON.stringify(["Topic seventy", "Topic sixty"]), JSON.stringify(preload(t1)));
      const t2 = await turn(A, "sl preload question zqlowq", [{ name: "search_store_info", args: { question: "zqlowq" } }]);
      const lowRes = t2.results.find((x) => x.name === "search_store_info")?.result;
      ok("SL-SI-2b", "best match 0.44 → nothing preloaded, but search_store_info still returns it (≥ minMeaningScore)", preload(t2).length === 0 && infoTexts(lowRes).some((x) => x.includes("zqlow44")), JSON.stringify({ pre: preload(t2), res: infoTexts(lowRes).length }));
      const t3 = await turn(A, "sl preload question zqhiq", []);
      ok("SL-SI-2c", "best match 0.46 → preloaded (one topic)", JSON.stringify(preload(t3)) === JSON.stringify(["Topic high"]), JSON.stringify(preload(t3)));
      ok("SL-SI-2d", "preload constants are the canonical ones", /STORE_INFO_PRELOAD_SCORE = 0\.45;/.test(src("app/lib/pipeline/agent.server.ts")) && /STORE_INFO_PRELOAD_HITS = 2;/.test(src("app/lib/pipeline/agent.server.ts")));
    });

    // ═══ 7. TENANCY ══════════════════════════════════════════════════════════
    await kase("SL-TN-1 shop B's products / passages / chunks / discounts / collections never reach shop A's tools", async () => {
      stubs[DOMAIN_B].products = [
        productNode({ n: 7901, title: "Nebula Bonly Bracelet", description: [para("Nebula note one"), para("Nebula note two", "zqbonly"), para("Nebula note three")].join(" "), type: "Bracelet" }),
        productNode({ n: 7902, title: "Moonglow Crystal Bracelet", description: [para("B moonglow note one"), para("B moonglow note two", "zqbonly")].join(" "), type: "Bracelet" }),
      ];
      await catalog.fullCatalogSync(DOMAIN_B);
      const bKnow = await db.dataSource.create({ data: { shopId: B, type: "manual", name: "B only", status: "pending", metadata: { question: "B returns?", answer: "Shop B only answer zqbchunk." } } });
      await ingest.ingestSource(B, bKnow.id);
      stubs[DOMAIN_B].pages = [pageNode("gid://shopify/Page/7990", "B page", "<p>B page body zqbpage.</p>")];
      await content.fullPageSync(DOMAIN_B);
      await db.discount.create({ data: { shopId: B, shopifyDiscountId: "gid://shopify/DiscountCodeNode/7999", title: "B deal", code: "BONLY10", status: "active", method: "code" } });
      await db.collection.create({ data: { shopId: B, shopifyCollectionId: "gid://shopify/Collection/7999", title: "Bonly Collection" } });
      ok("SL-TN-1a", "precondition: shop B has passages and chunks", (await db.productPassage.count({ where: { shopId: B } })) > 0 && (await db.knowledge.count({ where: { shopId: B } })) > 0);
      const bSelf = await one(B, "sl b question zqbonly zqbchunk zqbpage", "search_store_info", { question: "zqbonly zqbchunk zqbpage" });
      ok("SL-TN-1b", "positive control: shop B's own tools see its data", infoTexts(bSelf.r).some((x) => x.includes("zqbchunk")) && infoTexts(bSelf.r).some((x) => x.includes("zqbonly")), JSON.stringify(infoTexts(bSelf.r)).slice(0, 160));
      const s = await one(A, "nebula bracelet", "search_products", { query: "nebula bonly bracelet zqbonly" });
      ok("SL-TN-1c", "search_products on A never returns B's product", !titles(s.r).includes("Nebula Bonly Bracelet") && !(s.r?.results ?? []).some((x: any) => x.id === "7901" || x.id === "7902" || String(x.description_about_shoppers_question ?? "").includes("zqbonly")), JSON.stringify(titles(s.r)));
      const g = await one(A, "sl tenancy question", "get_product", { product: "7901" });
      const gTitle = await one(A, "does moonglow help zqbonly", "get_product", { product: "Moonglow Crystal Bracelet", question: "zqbonly" });
      ok("SL-TN-1d", "get_product on A: B's id not resolvable; same-title product resolves to A's row with A's passages only", g.r?.title !== "Nebula Bonly Bracelet" && gTitle.r?.id === "7101" && !JSON.stringify(gTitle.r).includes("zqbonly"), JSON.stringify({ g: g.r?.title ?? g.r?.not_found, id: gTitle.r?.id }));
      const info = await one(A, "sl tenancy zqbonly zqbchunk zqbpage", "search_store_info", { question: "zqbonly zqbchunk zqbpage" });
      ok("SL-TN-1e", "search_store_info on A: no B passages, chunks, pages or collections", !JSON.stringify(info.r).match(/zqbonly|zqbchunk|zqbpage|Bonly Collection/), JSON.stringify(info.r).slice(0, 200));
      const d = await one(A, "any codes", "get_discounts", {});
      ok("SL-TN-1f", "get_discounts on A never quotes B's code", !String(d.r?.discounts).includes("BONLY10"));
      const show = await one(A, "show it", "show_products", { products: ["Nebula Bonly Bracelet", "7901"] });
      ok("SL-TN-1g", "show_products on A cannot card B's product", show.cards.length === 0, JSON.stringify(show.cards));
    });
  } finally {
    await sleep(800); // fire-and-forget log / usage / trace writes
    for (const [domain, shopId] of [[DOMAIN_A, A], [DOMAIN_B, B]] as const) {
      const before = await countShopRows(shopId, domain).catch(() => []);
      await cleanupShop(domain).catch((error: unknown) => console.error("cleanup failed", error));
      const left = await countShopRows(shopId, domain).catch(() => [{ table: "count failed", count: -1 }]);
      const core = ["products", "product_passages", "knowledge", "data_sources", "collections", "discounts", "store_pages", "blog_articles"];
      ok(
        `SL-PURGE-${domain === DOMAIN_A ? "A" : "B"}`,
        "cleanupShop removes products, passages, chunks, sources, collections, discounts, pages",
        (before.find((r) => r.table === "product_passages")?.count ?? 0) > 0 && !left.some((r) => core.includes(r.table)),
        `before passages=${before.find((r) => r.table === "product_passages")?.count ?? 0} left=${JSON.stringify(left)}`,
      );
      await db.redactLog.deleteMany({ where: { shopId } }).catch(() => undefined);
      await db.shop.deleteMany({ where: { id: shopId } }).catch(() => undefined);
    }
    await db.appLog.deleteMany({ where: { event: { in: ["catalog_unknown_shop", "content_sync_unknown_shop"] }, occurredAt: { gte: startedAt } } }).catch(() => undefined);
    (globalThis as any).pgBossGlobal = undefined;
  }
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
