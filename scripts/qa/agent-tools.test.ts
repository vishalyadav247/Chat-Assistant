/* Spec 24 + 25 — AI agent (tools mode) deterministic regression suite (AT-*).
 *
 * Run (PowerShell):  npx tsx scripts/qa/agent-tools.test.ts
 * Needs: dev Postgres up + migrated. No dev server. No LLM spend: the app's LLM
 * singleton is swapped for a SCRIPTED fake (the CapturingProvider's `inner`
 * seam) before any pipeline code runs. The fake plays the model: per shopper
 * message it issues a planned sequence of tool calls / final text, one step per
 * agent round, and records every prompt, tool list, embedding and moderation
 * call so the suite asserts on frames, DB rows and captured prompts.
 *
 * The one optional LIVE check (AT-L1) uses its own OpenAiProvider instance and
 * only runs when OPENAI_API_KEY is set; it is labelled LIVE and is not part of
 * the deterministic contract.
 *
 * Everything lives on throwaway shops `qa-at-<ts>-<x>.myshopify.com`, removed
 * with cleanupShop in `finally`. No queue worker is ever started and nothing is
 * sent to the real pg-boss: a recording fake boss is installed (the dev
 * server's worker must never pick up this suite's jobs). Shopify is never
 * called: the only auth path (AT-8.1) uses a locally signed session token
 * against an offline Session row, and every fetch to a throwaway shop host is
 * answered by a stub.
 *
 * Every case runs under a timeout, so a hung await is a FAIL, not a stall.
 * A FAIL marked DEFECT is a real product defect: the assertion encodes the spec
 * and must not be weakened to pass.
 */
import { createHmac, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, AgentMessage, ChatOptions, ToolDefinition } from "../../app/lib/llm/types";
import type { PipelineFrame, ProductCard } from "../../app/lib/pipeline/index.server";

for (const line of readFileSync(join(process.cwd(), ".env"), "utf-8").split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (match && !line.trim().startsWith("#") && process.env[match[1]] === undefined) {
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}
// The suite asserts the CODE defaults (spec 24: unset = tools, no pin), so the
// engine switches are removed from this process whatever .env / the shell say.
const ENV_AGENT_MODE = process.env.AI_AGENT_MODE;
const ENV_AGENT_MODEL = process.env.AGENT_MODEL;
delete process.env.AI_AGENT_MODE;
delete process.env.AGENT_MODEL;
delete process.env.AI_AGENT_SHOPS;
process.env.SHOPIFY_APP_URL ||= "http://localhost:3000";
process.env.SHOPIFY_API_KEY ||= "placeholder-agent-tools";
process.env.SHOPIFY_API_SECRET ||= "placeholder-agent-tools";
process.env.SCOPES ||= "read_products";

const TS = Date.now();
const dom = (suffix: string) => `qa-at-${TS}-${suffix}.myshopify.com`;
const DOMAIN_A = dom("a");
const DOMAIN_B = dom("b");
const BOOT_NO_ROW = dom("c");
const BOOT_NO_PERSONA = dom("d");
const BOOT_NO_SYNC = dom("e");
const BOOT_HEALTHY = dom("f");
const PURGE_SHOP = dom("h");
const ALL_DOMAINS = [DOMAIN_A, DOMAIN_B, BOOT_NO_ROW, BOOT_NO_PERSONA, BOOT_NO_SYNC, BOOT_HEALTHY, PURGE_SHOP];

// ── fetch stub (must precede every app import) ───────────────────────────────
let allowOpenAi = false;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (ALL_DOMAINS.includes(url.hostname)) {
    return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (/openai\.com$/i.test(url.hostname) && !allowOpenAi) {
    throw new TypeError("qa stub: OpenAI is not reachable from the deterministic suite");
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
    ok(id, "case completed without throwing", false, error instanceof Error ? error.stack?.split("\n").slice(0, 4).join(" | ") : String(error));
  } finally {
    clearTimeout(timer);
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf-8");
const short = (value: unknown, n = 160) => {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return (s ?? "").length > n ? `${(s ?? "").slice(0, n)}…` : (s ?? "");
};

// ── vectors ──────────────────────────────────────────────────────────────────
const DIM = 1536;
function vec(parts: Record<number, number>): number[] {
  const v = new Array<number>(DIM).fill(0);
  for (const [i, x] of Object.entries(parts)) v[Number(i)] = x;
  return v;
}
const basis = (i: number) => vec({ [i]: 1 });
/** Unit vector whose cosine with basis(a) is exactly s. */
const mix = (s: number, a: number, b: number) => vec({ [a]: s, [b]: Math.sqrt(1 - s * s) });

// ── scripted fake model ──────────────────────────────────────────────────────
interface AgentReq {
  shopId: string;
  /** The shopper message this turn answers (last user message of the prompt). */
  message: string;
  round: number;
  messages: AgentMessage[];
  tools: string[];
  toolDefs: ToolDefinition[];
  model: string | undefined;
}
type StepFn = (req: AgentReq) => AgentEvent[] | Promise<AgentEvent[]>;
type Step = AgentEvent[] | StepFn | { events?: AgentEvent[]; delayMs?: number; throwAfter?: boolean };
interface ChatCall { shopId: string; purpose: string; system: string; user: string }

const routeJson = (intent: "buy" | "question" | "chat") =>
  JSON.stringify({ intent, keywords: [], price_max: null, blocked: false, blocked_reason: "", off_topic: false, off_topic_reason: "" });

const fake = {
  agentReqs: [] as AgentReq[],
  chats: [] as ChatCall[],
  embeds: [] as Array<{ shopId: string; texts: string[] }>,
  moderations: [] as Array<{ shopId: string; text: string }>,
  /** shopper message → one step per agent round. No plan → "Happy to help!". */
  plans: new Map<string, Step[]>(),
  /** [needle (case-insensitive substring), vector] — first match wins; else pseudo. */
  tags: [] as Array<[string, number[]]>,
  pseudo: null as null | ((t: string) => number[]),
  vectorFor(text: string): number[] {
    const lower = text.toLowerCase();
    for (const [needle, vector] of this.tags) if (lower.includes(needle.toLowerCase())) return vector;
    return this.pseudo!(text);
  },
  async chat(messages: Array<{ role: string; content: string }>, ctx: { shopId: string; purpose: string }): Promise<string> {
    const system = messages[0]?.role === "system" ? messages[0].content : "";
    const user = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    this.chats.push({ shopId: ctx.shopId, purpose: ctx.purpose, system, user });
    if (system.startsWith("You are the router")) return routeJson("chat");
    if (ctx.purpose === "summary") return "summary";
    // Pre-agent turn checks (QA3-A7): "unrelated task" only where a case asks for it.
    if (system.startsWith("Answer both questions")) return user.includes("qa-unrelated") ? "Q1=no Q2=yes" : "Q1=no Q2=no";
    return "no";
  },
  chatStream(messages: Array<{ role: string; content: string }>, ctx: { shopId: string; purpose: string }): AsyncIterable<string> {
    const system = messages[0]?.role === "system" ? messages[0].content : "";
    const user = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    this.chats.push({ shopId: ctx.shopId, purpose: ctx.purpose, system, user });
    return (async function* () {
      yield "Happy to help!";
    })();
  },
  agentStream(messages: AgentMessage[], tools: ToolDefinition[], ctx: { shopId: string }, options?: ChatOptions): AsyncIterable<AgentEvent> {
    const snapshot = JSON.parse(JSON.stringify(messages)) as AgentMessage[];
    let lastUser = -1;
    snapshot.forEach((m, i) => {
      if (m.role === "user") lastUser = i;
    });
    const message = lastUser >= 0 ? (snapshot[lastUser].content as string) : "";
    const round = snapshot.slice(lastUser + 1).filter((m) => m.role === "assistant").length;
    const req: AgentReq = {
      shopId: ctx.shopId,
      message,
      round,
      messages: snapshot,
      tools: tools.map((t) => t.name),
      toolDefs: JSON.parse(JSON.stringify(tools)) as ToolDefinition[],
      model: options?.model,
    };
    this.agentReqs.push(req);
    const step = this.plans.get(message)?.[round];
    return (async function* () {
      if (step === undefined) {
        yield { type: "text", text: "Happy to help!" } as AgentEvent;
        return;
      }
      if (typeof step === "function") {
        for (const e of await step(req)) yield e;
        return;
      }
      if (Array.isArray(step)) {
        for (const e of step) yield e;
        return;
      }
      if (step.delayMs) await sleep(step.delayMs);
      for (const e of step.events ?? []) yield e;
      if (step.throwAfter) throw new Error("qa fake: model stream failed");
    })();
  },
  async embed(text: string, ctx: { shopId: string }): Promise<number[]> {
    return (await this.embedBatch([text], ctx))[0];
  },
  async embedBatch(texts: string[], ctx: { shopId: string }): Promise<number[][]> {
    this.embeds.push({ shopId: ctx.shopId, texts });
    return texts.map((t) => this.vectorFor(t));
  },
  async moderate(text: string, ctx: { shopId: string }): Promise<string[]> {
    this.moderations.push({ shopId: ctx.shopId, text });
    return text.includes("qa-moderate-me") ? ["harassment"] : [];
  },
};

let callSeq = 0;
const say = (text: string): AgentEvent => ({ type: "text", text });
const call = (...calls: Array<[string, Record<string, unknown>]>): AgentEvent => ({
  type: "tool_calls",
  calls: calls.map(([name, args]) => ({ id: `call_${++callSeq}`, name, arguments: JSON.stringify(args) })),
});

interface ToolEntry { name: string; args: Record<string, unknown>; result: Record<string, unknown> | null; raw: string }
/** Tool calls and their results, as the model saw them in the last round of a turn. */
function toolLog(req: AgentReq | undefined): ToolEntry[] {
  if (!req) return [];
  let lastUser = -1;
  req.messages.forEach((m, i) => {
    if (m.role === "user") lastUser = i;
  });
  const entries = new Map<string, ToolEntry>();
  const order: string[] = [];
  for (const m of req.messages.slice(lastUser + 1)) {
    if (m.role === "assistant" && m.toolCalls) {
      for (const c of m.toolCalls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(c.arguments) as Record<string, unknown>;
        } catch {
          /* raw */
        }
        entries.set(c.id, { name: c.name, args, result: null, raw: "" });
        order.push(c.id);
      }
    }
    if (m.role === "tool") {
      const e = entries.get(m.toolCallId);
      if (e) {
        e.raw = m.content;
        try {
          e.result = JSON.parse(m.content) as Record<string, unknown>;
        } catch {
          e.result = null;
        }
      }
    }
  }
  return order.map((id) => entries.get(id)!);
}

// ── fake pg-boss (records, never delivers) ───────────────────────────────────
const bossSent: Array<{ name: string; data: Record<string, unknown> }> = [];
const fakeBoss = {
  send: async (name: string, data: Record<string, unknown>) => {
    bossSent.push({ name, data });
    return randomUUID();
  },
  on: () => undefined,
};

// ── session token for the embedded-admin auth path (AT-8.1) ─────────────────
function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function sessionToken(shop: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: `https://${shop}/admin`,
      dest: `https://${shop}`,
      aud: process.env.SHOPIFY_API_KEY,
      sub: "4242",
      exp: now + 300,
      nbf: now - 10,
      iat: now - 10,
      jti: randomUUID(),
      sid: randomUUID(),
    }),
  );
  const signature = b64url(createHmac("sha256", process.env.SHOPIFY_API_SECRET ?? "").update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${signature}`;
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full));
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
async function main(): Promise<void> {
  const db = (await import("../../app/db.server")).default;
  const { getLlmProvider } = await import("../../app/lib/llm/index.server");
  const emb = await import("../../app/lib/embeddings/embedding.server");
  fake.pseudo = emb.pseudoEmbedding;
  const capturing = getLlmProvider() as unknown as { inner: unknown };
  if (!("inner" in capturing)) throw new Error("LLM seam changed: CapturingProvider.inner not found — refusing to run (would hit the real API)");
  capturing.inner = fake;
  (global as unknown as { pgBossGlobal?: unknown }).pgBossGlobal = { boss: fakeBoss, started: Promise.resolve() };

  const { cleanupShop } = await import("../../app/lib/jobs/handlers.server");
  const { hasFeature, getQuota } = await import("../../app/lib/billing/plans.server");
  const startedAt = new Date();
  for (const d of ALL_DOMAINS) {
    await cleanupShop(d).catch(() => undefined);
    await db.shop.deleteMany({ where: { domain: d } });
  }

  const planWithTracking = ["plus", "pro", "basic"].find((p) => hasFeature(p, "order_tracking")) ?? null;
  const shopA = await db.shop.create({ data: { domain: DOMAIN_A, name: "QA Agent A", currency: "EUR", plan: planWithTracking ?? "free" } });
  const shopB = await db.shop.create({ data: { domain: DOMAIN_B, name: "QA Agent B", currency: "USD", plan: "free" } });

  try {
    await run(db, shopA.id, shopB.id, { planWithTracking, hasFeature, getQuota, startedAt });
  } finally {
    await sleep(900); // fire-and-forget log / usage / trace writes
    for (const d of ALL_DOMAINS) {
      await cleanupShop(d).catch((error: unknown) => console.error("cleanup failed", error));
      await db.shop.deleteMany({ where: { domain: d } }).catch(() => undefined);
    }
    (global as unknown as { pgBossGlobal?: unknown }).pgBossGlobal = undefined;
  }
}

type Db = Awaited<typeof import("../../app/db.server")>["default"];
interface Ctx {
  planWithTracking: string | null;
  hasFeature: (plan: string, feature: "order_tracking") => boolean;
  getQuota: (plan: string, dim: "conversations") => number;
  startedAt: Date;
}

async function run(db: Db, A: string, B: string, ctx: Ctx): Promise<void> {
  const { Prisma } = await import("@prisma/client");
  const emb = await import("../../app/lib/embeddings/embedding.server");
  const { runPipeline } = await import("../../app/lib/pipeline/index.server");
  const { createTrace } = await import("../../app/lib/pipeline/trace.server");
  const { observeTurn, TurnCollector } = await import("../../app/lib/pipeline/turn-capture.server");
  const { invalidateShopConfig } = await import("../../app/lib/config/shop-config.server");
  const { canned, recommendationBanner } = await import("../../app/lib/pipeline/canned.server");
  const { env } = await import("../../app/lib/env.server");
  const { agentModeEnabled } = await import("../../app/lib/pipeline/agent.server");
  const { formatMoney } = await import("../../app/lib/format/money");
  const { DEFAULT_PERSONA } = await import("../../app/lib/ai-defaults");
  const { AGENT_SYSTEM } = await import("../../app/lib/pipeline/prompts");

  // ── fixtures ───────────────────────────────────────────────────────────────
  const setVector = async (table: "products" | "knowledge" | "curated_answers", id: string, shopId: string, v: number[]) => {
    await db.$executeRaw(Prisma.sql`UPDATE ${Prisma.raw(`"${table}"`)} SET "embedding" = ${emb.toSqlVector(v)}::vector WHERE "id" = ${id} AND "shopId" = ${shopId}`);
  };
  const gid = (n: number) => `gid://shopify/Product/${n}`;
  const mkProduct = async (shopId: string, n: number, title: string, extra: Record<string, unknown> = {}, v?: number[]) => {
    const row = await db.product.create({
      data: {
        shopId,
        shopifyProductId: gid(n),
        title,
        description: `${title} — a QA fixture product.`,
        price: 20,
        stock: 5,
        handle: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        imageUrl: `https://cdn.qa-at.test/${n}.jpg`,
        variants: [{ id: `gid://shopify/ProductVariant/${n}1`, title: "Default Title", available: true }],
        ...extra,
      },
    });
    if (v) await setVector("products", row.id, shopId, v);
    return row;
  };
  const mkPassage = async (shopId: string, productId: string, position: number, body: string, v: number[]) => {
    await db.$executeRaw(Prisma.sql`
      INSERT INTO "product_passages" ("id", "shopId", "productId", "position", "body", "bodyHash", "sourceHash", "embedding")
      VALUES (${randomUUID()}, ${shopId}, ${productId}, ${position}, ${body}, ${`qa-${randomUUID()}`}, ${"qa-source"}, ${emb.toSqlVector(v)}::vector)
    `);
  };

  // Shop A (EUR, plan with order tracking)
  const aurora = await mkProduct(A, 7001001, "Aurora Lamp", { price: 49.5, imageUrl: "https://cdn.qa-at.test/aurora.jpg", handle: "aurora-lamp" }, basis(300));
  await mkProduct(A, 7001002, "Borealis Lamp", { price: 30 });
  await mkProduct(A, 7001003, "Comet Lamp");
  await mkProduct(A, 7001004, "Dusk Lamp");
  await mkProduct(A, 7001005, "Ember Lamp");
  await mkProduct(A, 7001006, "Archived Lamp", { status: "archived" });
  await mkProduct(A, 7001007, "Draft Lamp", { status: "draft" });
  await mkProduct(A, 7001008, "Hidden Lamp", { publishedOnline: false });
  await mkProduct(A, 7001009, "Unlearned Lamp", { learnEnabled: false });
  await mkProduct(A, 7001010, "Sold Out Lamp", { stock: 0, variants: [{ id: "gid://shopify/ProductVariant/70010101", title: "Default Title", available: false }] });
  await mkProduct(A, 7001011, "Shade Companion");
  await mkProduct(A, 7001012, "Bulb Pack");
  await db.crossSellPair.create({ data: { shopId: A, productId: gid(7001001), companionIds: [gid(7001011), gid(7001012)] } });
  const glacierDescription = `QA-GLACIER-OVERVIEW The Glacier Mug is a double-walled ceramic mug. ${"It keeps coffee warm on slow mornings. ".repeat(40)}`;
  const glacier = await mkProduct(A, 7001020, "Glacier Mug", { description: glacierDescription, price: 18 }, basis(316));
  const frost = await mkProduct(A, 7001021, "Frost Cup", { price: 12 }, mix(0.95, 316, 318));
  const snow = await mkProduct(A, 7001022, "Snow Bowl", { price: 15 }, mix(0.9, 316, 319));
  const P = {
    overview: "QA-PASSAGE-OVERVIEW Glacier Mug overview paragraph.",
    gift: "QA-PASSAGE-GIFT It arrives in a gift box.",
    dishwasher: "QA-PASSAGE-DISHWASHER The mug is dishwasher safe on the top rack.",
    microwave: "QA-PASSAGE-MICROWAVE It is microwave safe for reheating.",
    origin: "QA-PASSAGE-ORIGIN Hand-made in Portugal.",
    warranty: "QA-PASSAGE-WARRANTY Two-year warranty against cracks.",
  };
  await mkPassage(A, glacier.id, 0, P.overview, basis(312));
  await mkPassage(A, glacier.id, 1, P.gift, vec({ 310: 0.3, 311: Math.sqrt(1 - 0.09) }));
  await mkPassage(A, glacier.id, 2, P.dishwasher, basis(310));
  await mkPassage(A, glacier.id, 3, P.microwave, vec({ 310: 0.8, 313: 0.6 }));
  await mkPassage(A, glacier.id, 4, P.origin, vec({ 310: -0.2, 314: Math.sqrt(0.96) }));
  await mkPassage(A, glacier.id, 5, P.warranty, vec({ 310: -0.5, 315: Math.sqrt(0.75) }));
  await mkPassage(A, frost.id, 0, "QA-PASSAGE-FROST-054 Frost cup care text.", mix(0.54, 310, 401));
  await mkPassage(A, snow.id, 0, "QA-PASSAGE-SNOW-056 Snow bowl care text.", mix(0.56, 310, 402));
  await db.guardrails.create({ data: { shopId: A, bannedTopics: ["gambling", "medical advice", "competitor pricing"], fallbackMessage: "", minMeaningScore: 0.3 } });
  await db.discount.create({ data: { shopId: A, shopifyDiscountId: "gid://shopify/DiscountCodeNode/9001", title: "QA Spring", summary: "20% off lamps", code: "QAAT20", status: "active" } });
  const preloadHigh = await db.knowledge.create({ data: { shopId: A, topic: "Returns", body: "QA-PRELOAD-HIGH Returns are accepted within 30 days." } });
  await setVector("knowledge", preloadHigh.id, A, mix(0.5, 360, 361));
  const preloadLow = await db.knowledge.create({ data: { shopId: A, topic: "Loyalty", body: "QA-PRELOAD-LOW Loyalty points expire yearly." } });
  await setVector("knowledge", preloadLow.id, A, mix(0.44, 362, 363));

  // Shop B (USD, free): one product shares a title with shop A.
  await mkProduct(B, 8002001, "Aurora Lamp", { price: 999, imageUrl: "https://cdn.qa-at.test/b-aurora.jpg" }, basis(300));
  await mkProduct(B, 8002002, "Bravo Kettle", { price: 45 });
  await mkProduct(B, 8002003, "Zephyr Fan", { price: 60 });

  fake.tags.push(
    ["qa-tenancy", basis(300)],
    ["qa-q-dishwasher", basis(310)],
    ["qa-shopper-dishwasher", basis(310)],
    ["qa-same-query", basis(310)],
    ["qa-origin-msg", basis(314)],
    ["qa-search-mugs", basis(316)],
    ["qa-intent-topic", basis(320)],
    ["qa-curated-serve", basis(330)],
    ["qa-curated-border", mix(0.7, 330, 331)],
    ["qa-rec-trigger", basis(340)],
    ["competitor pricing", basis(350)],
    ["qa-offers", basis(350)],
    ["qa-preload-hit", basis(360)],
    ["qa-preload-miss", basis(362)],
  );
  invalidateShopConfig(A);
  invalidateShopConfig(B);

  let sessionSeq = 0;
  const newSession = () => `qa-at-s${++sessionSeq}-${TS}`;
  type Frame = PipelineFrame;
  interface TurnOpts { session?: string; conversationId?: string; pageContext?: unknown; isTest?: boolean; capture?: InstanceType<typeof TurnCollector>; keepUsage?: boolean }
  const turn = async (shopId: string, message: string, plan?: Step[], opts: TurnOpts = {}) => {
    if (plan) fake.plans.set(message, plan);
    if (!opts.keepUsage) await db.planUsage.deleteMany({ where: { shopId } });
    const trace = createTrace(true);
    const starts = { agent: fake.agentReqs.length, chat: fake.chats.length, embed: fake.embeds.length, mod: fake.moderations.length };
    const session = opts.session ?? newSession();
    const source = runPipeline({ shopId, sessionId: session, conversationId: opts.conversationId, message, pageContext: opts.pageContext, isTest: opts.isTest }, trace);
    const stream = opts.capture ? observeTurn({ shopId, shopperText: message, frames: source, trace, collector: opts.capture }) : source;
    const frames: Frame[] = [];
    for await (const f of stream) frames.push(f);
    const done = frames.find((f): f is Extract<Frame, { type: "done" }> => f.type === "done");
    const agent = fake.agentReqs.slice(starts.agent).filter((r) => r.shopId === shopId && r.message === message.slice(0, 2000).trim());
    const chats = fake.chats.slice(starts.chat).filter((c) => c.shopId === shopId);
    const embeds = fake.embeds.slice(starts.embed).filter((e) => e.shopId === shopId);
    return {
      frames,
      session,
      outcome: done?.outcome ?? "",
      conversationId: done?.conversationId ?? "",
      text: frames.map((f) => (f.type === "message" || f.type === "token" ? f.text : "")).join(""),
      cards: frames.filter((f): f is Extract<Frame, { type: "cards" }> => f.type === "cards").flatMap((f) => f.cards),
      actions: frames.filter((f): f is Extract<Frame, { type: "actions" }> => f.type === "actions").flatMap((f) => f.actions),
      handover: frames.filter((f): f is Extract<Frame, { type: "handover" }> => f.type === "handover"),
      agent,
      tools: toolLog(agent[agent.length - 1]),
      chats,
      embeds,
      embedTexts: embeds.flatMap((e) => e.texts),
      moderations: fake.moderations.slice(starts.mod).filter((m) => m.shopId === shopId),
      generation: agent.length + chats.filter((c) => c.purpose !== "summary").length,
      steps: trace.steps(),
    };
  };
  type Turn = Awaited<ReturnType<typeof turn>>;
  const system = (t: Turn) => (t.agent[0]?.messages[0]?.content as string | undefined) ?? "";
  const prompt = (t: Turn) => JSON.stringify(t.agent[0]?.messages ?? []);
  const results = (t: Turn, name: string) => t.tools.filter((e) => e.name === name);
  const lastOut = (conversationId: string) =>
    db.message.findFirst({ where: { shopId: A, conversationId, role: "out" }, orderBy: { createdAt: "desc" } });
  const fallbackText = canned("fallback", null);
  const setSettings = async (shopId: string, settings: Record<string, unknown> | null) => {
    await db.shopSettings.deleteMany({ where: { shopId } });
    if (settings) await db.shopSettings.create({ data: { shopId, settings: settings as never } });
    invalidateShopConfig(shopId);
  };
  const setWidget = async (shopId: string, settings: Record<string, unknown> | null) => {
    await db.widgetSettings.deleteMany({ where: { shopId } });
    if (settings) await db.widgetSettings.create({ data: { shopId, settings: settings as never } });
    invalidateShopConfig(shopId);
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // AT-1 — engine switch and model resolution
  // ═══════════════════════════════════════════════════════════════════════════
  await kase("AT-1.1", async () => {
    const e = env();
    ok("AT-1.1a", "AI_AGENT_MODE unset → parsed default is `tools`", e.AI_AGENT_MODE === "tools", `.env had ${ENV_AGENT_MODE ?? "(unset)"}; AGENT_MODEL in .env: ${ENV_AGENT_MODEL ?? "(unset)"}`);
    ok("AT-1.1b", "agentModeEnabled() is true by default", agentModeEnabled());
    const t = await turn(A, `qa-mode-default hello ${TS}`);
    const routerCalls = (x: Turn) => x.chats.filter((c) => c.system.startsWith("You are the router")).length;
    ok("AT-1.1c", "default turn runs the agent loop and never the router", t.agent.length >= 1 && routerCalls(t) === 0, `agentRounds=${t.agent.length} router=${routerCalls(t)} outcome=${t.outcome}`);
    e.AI_AGENT_MODE = "pipeline";
    try {
      const p = await turn(A, `qa-mode-pipeline hello ${TS}`);
      ok("AT-1.1d", "AI_AGENT_MODE=pipeline → router + lanes, zero agent rounds", p.agent.length === 0 && routerCalls(p) >= 1, `agentRounds=${p.agent.length} router=${routerCalls(p)} outcome=${p.outcome}`);
    } finally {
      e.AI_AGENT_MODE = "tools";
    }
    process.env.AI_AGENT_SHOPS = "some-other-store.myshopify.com";
    try {
      const s = await turn(A, `qa-mode-allowlist hello ${TS}`);
      ok("AT-1.1e", "AI_AGENT_SHOPS naming another store does not take this shop off the agent (allowlist removed 2026-09-15)", s.agent.length >= 1);
    } finally {
      delete process.env.AI_AGENT_SHOPS;
    }
    const readers = filesUnder(join(process.cwd(), "app")).filter((f) => readFileSync(f, "utf-8").includes("AI_AGENT_SHOPS"));
    ok("AT-1.1f", "no app code reads AI_AGENT_SHOPS (engine is global, spec 24)", readers.length === 0, readers.join(", "));
  });

  await kase("AT-1.2", async () => {
    const e = env();
    const unpinned = await turn(A, `qa-model-unpinned hi ${TS}`);
    ok("AT-1.2a", "AGENT_MODEL blank → agent rounds pass no model pin (provider resolves)", unpinned.agent.length > 0 && unpinned.agent.every((r) => r.model === undefined), JSON.stringify(unpinned.agent.map((r) => r.model)));
    e.AGENT_MODEL = "qa-pinned-model";
    try {
      const pinned = await turn(A, `qa-model-pinned hi ${TS}`);
      ok("AT-1.2b", "AGENT_MODEL set → every agent round is pinned to it", pinned.agent.length > 0 && pinned.agent.every((r) => r.model === "qa-pinned-model"), JSON.stringify(pinned.agent.map((r) => r.model)));
    } finally {
      e.AGENT_MODEL = "";
    }
    ok("AT-1.2c", "CHAT_MODEL code default is gpt-4.1-mini", /CHAT_MODEL: z\.string\(\)\.default\("gpt-4\.1-mini"\)/.test(src("app/lib/env.server.ts")));

    // Provider chain: options.model (AGENT_MODEL pin) → /admin dashboard model → CHAT_MODEL.
    const { OpenAiProvider } = await import("../../app/lib/llm/openai.server");
    const { runtimeConfig } = await import("../../app/lib/admin/runtime-config.server");
    const { AI_SECRET_KEY } = await import("../../app/lib/admin/admin-settings.server");
    const models: string[] = [];
    const provider = new OpenAiProvider();
    (provider as unknown as { cached: unknown }).cached = {
      key: runtimeConfig().openaiApiKey,
      client: {
        chat: {
          completions: {
            create: async (body: { model: string }) => {
              models.push(body.model);
              return {
                controller: { abort: () => undefined },
                async *[Symbol.asyncIterator]() {
                  yield { choices: [{ delta: { content: "ok" } }] };
                  yield { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } };
                },
              };
            },
          },
        },
      },
    };
    const resolve = async (model?: string) => {
      for await (const ev of provider.agentStream([{ role: "user", content: "hi" }], [], { shopId: "", purpose: "reply" }, { model })) void ev;
      return models[models.length - 1];
    };
    const delegate = (db as unknown as { appSecret: { findUnique: (args: { where: { key: string } }) => Promise<unknown> } }).appSecret;
    const original = delegate.findUnique;
    let adminModel: string | null = "qa-admin-model";
    const patched = async (args: { where: { key: string } }) =>
      args?.where?.key === AI_SECRET_KEY
        ? adminModel === null
          ? null
          : { key: AI_SECRET_KEY, value: JSON.stringify({ chatModel: adminModel, temperature: null, maxTokens: null }) }
        : original.call(delegate, args);
    try {
      delegate.findUnique = patched;
    } catch {
      /* proxy refused the patch */
    }
    const patchedOk = (db as unknown as { appSecret: { findUnique: unknown } }).appSecret.findUnique === patched;
    const realNow = Date.now;
    let shift = 0;
    Date.now = () => realNow() + shift;
    try {
      if (!patchedOk) {
        skip("AT-1.2d-f", "Prisma delegate could not be patched to simulate a dashboard model without writing global operator config");
      } else {
        shift = 60 * 60_000; // expire the 30 s overrides cache
        ok("AT-1.2d", "AGENT_MODEL pin beats the /admin dashboard model", (await resolve("qa-pinned-model")) === "qa-pinned-model", models.slice(-1)[0]);
        ok("AT-1.2e", "no pin → the /admin dashboard model", (await resolve(undefined)) === "qa-admin-model", models.slice(-1)[0]);
        adminModel = null;
        shift = 2 * 60 * 60_000;
        ok("AT-1.2f", "no pin, no dashboard model → CHAT_MODEL", (await resolve(undefined)) === e.CHAT_MODEL, `${models.slice(-1)[0]} vs CHAT_MODEL=${e.CHAT_MODEL}`);
      }
    } finally {
      delegate.findUnique = original;
      shift = 3 * 60 * 60_000;
      await resolve(undefined).catch(() => undefined); // reload the real overrides into the cache
      Date.now = realNow;
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // AT-2 — grounding (spec 24 acceptance: code-enforced)
  // ═══════════════════════════════════════════════════════════════════════════
  const notShowable = ["Archived Lamp", "Draft Lamp", "Hidden Lamp", "Unlearned Lamp", "Zephyr Fan", "Bravo Kettle"];
  await kase("AT-2.1", async () => {
    const msg = `qa-ground-get tell me about item x ${TS}`;
    const t = await turn(A, msg, [
      [call(["get_product", { product: "8002003" }], ["get_product", { product: gid(8002003) }], ["get_product", { product: "Archived Lamp" }], ["get_product", { product: "Draft Lamp" }])],
      [call(["get_product", { product: "Hidden Lamp" }], ["get_product", { product: "Unlearned Lamp" }], ["get_product", { product: "7009999" }], ["get_product", { product: "Totally Invented Hyperlamp 9000" }])],
      [say("I couldn't find that one.")],
    ]);
    const gets = results(t, "get_product");
    ok("AT-2.1a", "8 get_product calls for foreign / archived / draft / unpublished / learn-off / missing / invented refs all executed", gets.length === 8 && gets.every((g) => g.result !== null), `n=${gets.length}`);
    ok("AT-2.1b", "none of them returned a product record", gets.every((g) => g.result && !("id" in g.result) && !("price" in g.result)), gets.map((g) => short(g.result, 60)).join(" | "));
    const blob = JSON.stringify(gets.map((g) => (g.result as { closest_matches?: unknown } | null)?.closest_matches ?? []));
    ok("AT-2.1c", "closest-match suggestions never name another shop's or a non-showable product", notShowable.every((title) => !blob.includes(title)) && !blob.includes("8002003"), short(blob, 240));
    ok("AT-2.1d", "no card frame and no saved card", t.cards.length === 0 && !(await lastOut(t.conversationId))?.productCards, `cards=${t.cards.length}`);
  });

  await kase("AT-2.2", async () => {
    const msg = `qa-ground-show show me those ${TS}`;
    const bad = ["8002003", gid(8002003), "Zephyr Fan", "Archived Lamp", "Draft Lamp", "Hidden Lamp", "Unlearned Lamp", "7009999"];
    const t = await turn(A, msg, [
      [call(["show_products", { products: bad }])],
      [call(["show_products", { products: ["Totally Invented Hyperlamp 9000", "Sold Out Lamp"] }])],
      [say("Here you go.")],
    ]);
    const shows = results(t, "show_products");
    const first = shows[0]?.result as { shown?: string[]; not_shown?: string[] } | null;
    const second = shows[1]?.result as { shown?: string[]; not_shown?: string[] } | null;
    ok("AT-2.2a", "show_products with 8 non-showable / foreign / missing refs shows nothing and reports them all", (first?.shown ?? ["x"]).length === 0 && (first?.not_shown ?? []).length === bad.length, short(first));
    ok("AT-2.2b", "a hallucinated title and an out-of-stock product are not carded", (second?.shown ?? ["x"]).length === 0 && (second?.not_shown ?? []).length === 2, short(second));
    ok("AT-2.2c", "no cards frame reaches the shopper", t.cards.length === 0);
  });

  await kase("AT-2.3", async () => {
    const msg = `qa-ground-cards which lamps ${TS}`;
    const t = await turn(A, msg, [
      [call(["show_products", { products: ["aurora lamp", "7001002"] }])],
      [say("The Aurora Lamp is only €1 today, see https://evil.example.com/deal and https://" + DOMAIN_A + "/products/aurora-lamp")],
    ]);
    const [c1, c2] = t.cards;
    ok("AT-2.3a", "cards resolve by case-insensitive title and by bare numeric id", t.cards.length === 2 && c1?.shopifyProductId === gid(7001001) && c2?.shopifyProductId === gid(7001002), JSON.stringify(t.cards.map((c) => c.shopifyProductId)));
    ok("AT-2.3b", "card fields come from the DB row, not the model (title casing, price, image, handle, variant)", c1?.title === "Aurora Lamp" && c1.price === 49.5 && c1.imageUrl === "https://cdn.qa-at.test/aurora.jpg" && c1.handle === "aurora-lamp" && c1.variantId === "70010011" && c1.variantGid === "gid://shopify/ProductVariant/70010011", JSON.stringify(c1));
    ok("AT-2.3c", "no cross-sell companions without a search this turn", !t.cards.some((c) => c.title === "Shade Companion" || c.title === "Bulb Pack"));
    const saved = (await lastOut(t.conversationId))?.productCards as unknown as ProductCard[] | null;
    ok("AT-2.3d", "saved message carries the same DB-built cards", Array.isArray(saved) && saved.length === 2 && saved[0].price === 49.5);
    ok("AT-2.3e", "LinkGuard strips the off-site URL, keeps the shop's own domain", !t.text.includes("evil.example.com") && t.text.includes(`https://${DOMAIN_A}/products/aurora-lamp`), short(t.text, 200));
  });

  await kase("AT-2.4", async () => {
    const msg = `qa-ground-cap show all lamps ${TS}`;
    const six = ["Aurora Lamp", "Borealis Lamp", "Comet Lamp", "Dusk Lamp", "Ember Lamp", "Glacier Mug"];
    // The four lamps are looked up first, so the weak-pick filter (QA3-A8) keeps
    // them whatever tier the fake vectors give them in the search.
    const t = await turn(A, msg, [
      [call(["get_product", { product: six[0] }], ["get_product", { product: six[1] }], ["get_product", { product: six[2] }], ["get_product", { product: six[3] }])],
      [call(["search_products", { query: "lamps" }])],
      [call(["show_products", { products: six }])],
      [say("Some picks.")],
    ]);
    ok("AT-2.4a", "show_products with 6 valid titles renders at most 4 cards, in the model's order", t.cards.length === 4 && t.cards.map((c) => c.title).join(",") === six.slice(0, 4).join(","), t.cards.map((c) => c.title).join(","));
    ok("AT-2.4b", "4 picks after a search get no cross-sell companions (hard cap 4)", !t.cards.some((c) => c.title === "Shade Companion"));
    const toolDef = t.agent[0]?.toolDefs.find((d) => d.name === "show_products");
    ok("AT-2.4c", "show_products schema advertises maxItems 4", JSON.stringify(toolDef?.parameters ?? {}).includes('"maxItems":4'));
    // Weak-pick filter: with a strong match among the picks, the search's
    // "possible" matches are left out and reported back to the model.
    const w = await turn(A, `qa-ground-weak lamps ${TS}`, [[call(["search_products", { query: "lamps" }])], [call(["show_products", { products: six.slice(0, 5) }])], [say("Some picks.")]]);
    const search = results(w, "search_products")[0]?.result as { results?: Array<{ title: string; match: string }> } | undefined;
    const best = (search?.results ?? []).filter((r) => r.match === "best").map((r) => r.title);
    const possible = (search?.results ?? []).filter((r) => r.match === "possible").map((r) => r.title);
    const shown = w.cards.map((c) => c.title).filter((x) => six.includes(x));
    const show = results(w, "show_products")[0]?.result as { left_out?: string[] } | undefined;
    ok(
      "AT-2.4d",
      "strong + weak picks → only the strong ones become cards; the weak ones are reported as left_out",
      best.length === 0 || (shown.every((x) => !possible.includes(x)) && possible.filter((x) => six.slice(0, 5).includes(x)).every((x) => show?.left_out?.includes(x))),
      `best=${best.join(",")} possible=${possible.join(",")} shown=${shown.join(",")} left_out=${show?.left_out?.join(",")}`,
    );
  });

  await kase("AT-2.5", async () => {
    const withSearch = await turn(A, `qa-xsell-search a lamp please ${TS}`, [[call(["search_products", { query: "lamp" }])], [call(["show_products", { products: ["Aurora Lamp"] }])], [say("This one.")]]);
    ok("AT-2.5a", "fresh search + 1 pick → merchant cross-sell companions appended", withSearch.cards.map((c) => c.title).join(",") === "Aurora Lamp,Shade Companion,Bulb Pack", withSearch.cards.map((c) => c.title).join(","));
    const three = await turn(A, `qa-xsell-three three lamps ${TS}`, [
      [call(["get_product", { product: "Aurora Lamp" }], ["get_product", { product: "Borealis Lamp" }], ["get_product", { product: "Comet Lamp" }], ["search_products", { query: "lamp" }])],
      [call(["show_products", { products: ["Aurora Lamp", "Borealis Lamp", "Comet Lamp"] }])],
      [say("These.")],
    ]);
    ok("AT-2.5b", "3 picks + 2 companions is capped at 4 cards total", three.cards.length === 4 && three.cards[3].title === "Shade Companion", three.cards.map((c) => c.title).join(","));
    const noSearch = await turn(A, `qa-xsell-detail about the aurora ${TS}`, [[call(["get_product", { product: "Aurora Lamp" }])], [call(["show_products", { products: ["Aurora Lamp"] }])], [say("It's lovely.")]]);
    ok("AT-2.5c", "an answer about one product (no search) gets no companions", noSearch.cards.map((c) => c.title).join(",") === "Aurora Lamp", noSearch.cards.map((c) => c.title).join(","));
    await setSettings(A, { recommendationRules: { excludeOutOfStock: true, crossSellEnabled: false } });
    try {
      const off = await turn(A, `qa-xsell-off a lamp please ${TS}`, [[call(["search_products", { query: "lamp" }])], [call(["show_products", { products: ["Aurora Lamp"] }])], [say("This one.")]]);
      ok("AT-2.5d", "crossSellEnabled OFF → no companions even under a search", off.cards.map((c) => c.title).join(",") === "Aurora Lamp", off.cards.map((c) => c.title).join(","));
    } finally {
      await setSettings(A, null);
    }
  });

  await kase("AT-2.6", async () => {
    const session = newSession();
    const first = await turn(A, `qa-autocard do you have the comet ${TS}`, [[call(["get_product", { product: "Comet Lamp" }])], [say("Yes, we do.")]], { session });
    ok("AT-2.6a", "a product looked up but not yet on screen comes with its card (code-enforced)", first.cards.map((c) => c.title).join(",") === "Comet Lamp", first.cards.map((c) => c.title).join(","));
    const follow = await turn(A, `qa-autocard-follow is it bright ${TS}`, [[call(["get_product", { product: "Comet Lamp" }])], [say("It is bright.")]], { session, conversationId: first.conversationId });
    ok("AT-2.6b", "a follow-up about the product already on screen gets no repeat card", follow.cards.length === 0, follow.cards.map((c) => c.title).join(","));
  });

  await kase("AT-2.7", async () => {
    const t = await turn(A, `qa-currency price of the aurora ${TS}`, [[call(["get_product", { product: "Aurora Lamp" }], ["search_products", { query: "aurora lamp" }])], [say("Here.")]]);
    const g = results(t, "get_product")[0]?.result as { price?: string; id?: string } | null;
    const s = results(t, "search_products")[0]?.result as { results?: Array<{ id: string; price: string }> } | null;
    const eur = formatMoney(49.5, "EUR");
    ok("AT-2.7a", "get_product price is formatted in the shop currency (EUR)", g?.price === eur && g?.id === "7001001", `${g?.price} vs ${eur}`);
    ok("AT-2.7b", "search_products prices are in the shop currency", (s?.results ?? []).some((r) => r.id === "7001001" && r.price === eur), short(s?.results?.slice(0, 2)));
    ok("AT-2.7c", "system prompt states the currency", system(t).includes("Prices are in EUR."));
    const b = await turn(B, `qa-currency-b price of the aurora ${TS}`, [[call(["get_product", { product: "Aurora Lamp" }])], [say("Here.")]]);
    const gb = results(b, "get_product")[0]?.result as { price?: string; id?: string } | null;
    ok("AT-2.7d", "same title in shop B resolves to B's own row and currency (tenancy)", gb?.id === "8002001" && gb?.price === formatMoney(999, "USD") && b.cards[0]?.price === 999, short(gb));
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // AT-3 — tool gates
  // ═══════════════════════════════════════════════════════════════════════════
  await kase("AT-3.1", async () => {
    await setSettings(A, { learn: { products: false, collections: true, discounts: true, pages: true, blogs: true } });
    try {
      const t = await turn(A, `qa-gate-products show me a lamp ${TS}`, [
        [call(["search_products", { query: "lamp" }], ["get_product", { product: "Aurora Lamp" }], ["show_products", { products: ["Aurora Lamp"] }])],
        [say("Sorry.")],
      ]);
      const offered = t.agent[0]?.tools ?? [];
      ok("AT-3.1a", "Learn products OFF → no product tools offered", !offered.some((n) => ["search_products", "get_product", "show_products"].includes(n)) && offered.includes("search_store_info"), offered.join(","));
      ok("AT-3.1b", "product tools called anyway refuse with an error", ["search_products", "get_product", "show_products"].every((n) => typeof results(t, n)[0]?.result?.error === "string"), t.tools.map((e) => short(e.result, 50)).join(" | "));
      ok("AT-3.1c", "no cards and no product data in the tool results", t.cards.length === 0 && !t.tools.some((e) => e.raw.includes("49.5") || e.raw.includes("7001001")));
    } finally {
      await setSettings(A, null);
    }
  });

  await kase("AT-3.2", async () => {
    const on = await turn(A, `qa-gate-disc-on any codes ${TS}`, [[call(["get_discounts", {}])], [say("Use QAAT20.")]]);
    ok("AT-3.2a", "Learn discounts ON → get_discounts offered and returns the active code", (on.agent[0]?.tools ?? []).includes("get_discounts") && (results(on, "get_discounts")[0]?.raw ?? "").includes("QAAT20"), short(results(on, "get_discounts")[0]?.raw));
    await setSettings(A, { learn: { products: true, collections: true, discounts: false, pages: true, blogs: true } });
    try {
      const off = await turn(A, `qa-gate-disc-off any codes ${TS}`, [[call(["get_discounts", {}])], [say("No info.")]]);
      const r = results(off, "get_discounts")[0];
      ok("AT-3.2b", "Learn discounts OFF → get_discounts not offered", !(off.agent[0]?.tools ?? []).includes("get_discounts"), (off.agent[0]?.tools ?? []).join(","));
      ok("AT-3.2c", "…and refuses when called anyway, leaking no code", typeof r?.result?.error === "string" && !(r?.raw ?? "").includes("QAAT20"), short(r?.raw));
    } finally {
      await setSettings(A, null);
    }
  });

  await kase("AT-3.3", async () => {
    const enumOf = (t: Turn) => {
      const def = t.agent[0]?.toolDefs.find((d) => d.name === "offer_button");
      return ((def?.parameters as { properties?: { button?: { enum?: string[] } } } | undefined)?.properties?.button?.enum ?? null);
    };
    if (!ctx.planWithTracking) {
      skip("AT-3.3a-c", "no plan in the live plan matrix includes order_tracking");
    } else {
      await setWidget(A, { orderTracking: true, faqs: false, contactMethods: { enabled: false, items: [] } });
      try {
        const t = await turn(A, `qa-gate-button where do I check ${TS}`, [
          [call(["offer_button", { button: "contact_team" }], ["offer_button", { button: "browse_faq" }])],
          [call(["offer_button", { button: "track_order" }])],
          [say("Use the button below.")],
        ]);
        ok("AT-3.3a", "offer_button enum lists only the screens this shop enabled", JSON.stringify(enumOf(t)) === JSON.stringify(["track_order"]), JSON.stringify(enumOf(t)));
        const btn = results(t, "offer_button");
        ok("AT-3.3b", "disabled buttons are refused", typeof btn[0]?.result?.error === "string" && typeof btn[1]?.result?.error === "string");
        ok("AT-3.3c", "the enabled button reaches the shopper with the code-owned label", t.actions.length === 1 && t.actions[0].key === "track_order" && t.actions[0].label === "Track my order", JSON.stringify(t.actions));
      } finally {
        await setWidget(A, null);
      }
    }
    if (ctx.hasFeature("free", "order_tracking")) {
      skip("AT-3.3d-f", "the free plan includes order_tracking in the live plan matrix — cannot exercise the plan gate");
      return;
    }
    const free = await turn(B, `qa-gate-button-free track please ${TS}`, [[call(["offer_button", { button: "track_order" }])], [say("Sorry.")]]);
    ok("AT-3.3d", "free plan: track_order is not offered even with the widget switch on (plan gate)", !(enumOf(free) ?? []).includes("track_order") && (enumOf(free) ?? []).includes("browse_faq"), JSON.stringify(enumOf(free)));
    ok("AT-3.3e", "free plan: track_order called anyway is refused, no action frame", typeof results(free, "offer_button")[0]?.result?.error === "string" && free.actions.length === 0);
    await setWidget(B, { orderTracking: true, faqs: false, contactMethods: { enabled: false, items: [] } });
    try {
      const none = await turn(B, `qa-gate-button-none help ${TS}`, [[call(["offer_button", { button: "browse_faq" }])], [say("Sorry.")]]);
      ok("AT-3.3f", "no enabled screens → offer_button not offered; a call is refused", !(none.agent[0]?.tools ?? []).includes("offer_button") && typeof results(none, "offer_button")[0]?.result?.error === "string" && none.actions.length === 0);
    } finally {
      await setWidget(B, null);
    }
  });

  await kase("AT-3.4", async () => {
    const q1 = `qa-cannot-first what is the warranty on gift cards ${TS}`;
    const t1 = await turn(A, q1, [[call(["cannot_answer", { question: q1 }])], [say("I'm not sure.")]]);
    const r1 = results(t1, "cannot_answer")[0]?.result;
    ok("AT-3.4a", "cannot_answer before any lookup (and no preload) is refused", typeof r1?.error === "string" && /look it up first/i.test(String(r1?.error)), short(r1));
    ok("AT-3.4b", "…so no unresolved question is logged and no form is offered", (await db.unresolvedQuestion.count({ where: { shopId: A, question: q1.trim() } })) === 0 && t1.handover.length === 0 && t1.outcome !== "fell_back", `outcome=${t1.outcome}`);
    const q2 = `qa-cannot-after what is the warranty on vouchers ${TS}`;
    const t2 = await turn(A, q2, [[call(["search_store_info", { question: "warranty on vouchers" }])], [call(["cannot_answer", { question: q2 }])], [say("I'm not sure — the team can follow up.")]]);
    const row = await db.unresolvedQuestion.findFirst({ where: { shopId: A, question: q2.trim() } });
    ok("AT-3.4c", "after a lookup, cannot_answer is accepted", results(t2, "cannot_answer")[0]?.result?.ok === true);
    ok("AT-3.4d", "…logs the unresolved question (reason fell_back) and offers the leave-message form", !!row && row.reason === "fell_back" && t2.handover.some((h) => h.data.form !== null) && t2.outcome === "fell_back", `row=${!!row} outcome=${t2.outcome}`);
    ok("AT-3.4e", "…and saves the reply under rag_fallback (feeds the cannot-answer escalation)", (await lastOut(t2.conversationId))?.sourceLayer === "rag_fallback");
    const q3 = `qa-preload-hit can I return this ${TS}`;
    const t3 = await turn(A, q3, [[call(["cannot_answer", { question: q3 }])], [say("Not sure.")]]);
    ok("AT-3.4f", "a store-info preload hit counts as a lookup: cannot_answer accepted in round 1", results(t3, "cannot_answer")[0]?.result?.ok === true, short(results(t3, "cannot_answer")[0]?.result));
    const q4 = `qa-cannot-test what is the warranty on gift wrap ${TS}`;
    await turn(A, q4, [[call(["search_store_info", { question: "gift wrap warranty" }])], [call(["cannot_answer", { question: q4 }])], [say("Not sure.")]], { isTest: true });
    ok("AT-3.4g", "Test AI turns never enter the unresolved queue", (await db.unresolvedQuestion.count({ where: { shopId: A, question: q4.trim() } })) === 0);
  });

  await kase("AT-3.5", async () => {
    const off = await turn(A, `qa-decline-early write me a poem ${TS}`, [[call(["decline", { kind: "off_topic" }])], [say("I can help with the store.")]]);
    ok("AT-3.5a", "off_topic decline before any search (no scope configured) is refused", typeof results(off, "decline")[0]?.result?.error === "string" && off.outcome !== "off_topic", `outcome=${off.outcome}`);
    const banned = await turn(A, `qa-decline-banned tell me about betting odds ${TS}`, [[call(["decline", { kind: "banned_topic" }])]]);
    ok("AT-3.5b", "banned_topic decline stands at once with the store's blocked text, no cards", banned.text === canned("blockedTopic", null) && banned.outcome === "blocked" && banned.cards.length === 0, `outcome=${banned.outcome} text=${short(banned.text, 60)}`);
    ok("AT-3.5c", "…saved as banned_agent", (await lastOut(banned.conversationId))?.sourceLayer === "banned_agent");
    await db.persona.create({ data: { shopId: A, scope: "lamps and lighting", offTopicMessage: "QA-OFFTOPIC only lamps here." } });
    invalidateShopConfig(A);
    try {
      // QA3 (2026-09-15): a scope alone no longer lets a decline skip the search
      // ("which bracelet is good for love" was refused on a store whose scope
      // text omitted jewellery). The pre-agent check judging the task unrelated does.
      const scoped = await turn(A, `qa-decline-scoped qa-unrelated solve my homework ${TS}`, [[call(["decline", { kind: "off_topic" }])]]);
      ok("AT-3.5d", "unrelated task (pre-agent check) + merchant scope → off_topic decline stands at once with the merchant's message", scoped.outcome === "off_topic" && scoped.text === "QA-OFFTOPIC only lamps here.", `outcome=${scoped.outcome} text=${short(scoped.text, 60)}`);
      const scopedProduct = await turn(A, `qa-decline-scoped-product which lamp suits a reading nook ${TS}`, [[call(["decline", { kind: "off_topic" }])], [say("Let me look.")]]);
      ok("AT-3.5e", "merchant scope but a possible product ask → off_topic decline before any search is refused", typeof results(scopedProduct, "decline")[0]?.result?.error === "string" && scopedProduct.outcome !== "off_topic", `outcome=${scopedProduct.outcome}`);
    } finally {
      await db.persona.deleteMany({ where: { shopId: A } });
      invalidateShopConfig(A);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // AT-4 — deterministic layers still run first in tools mode
  // ═══════════════════════════════════════════════════════════════════════════
  await kase("AT-4.1", async () => {
    const warm = await turn(A, `qa-rate-warm hi ${TS}`);
    const before = await db.message.count({ where: { shopId: A, conversationId: warm.conversationId } });
    const buckets = (global as unknown as { rateBuckets?: Map<string, { tokens: number; at: number }> }).rateBuckets;
    buckets?.set(`${A}:${warm.session}`, { tokens: 0, at: Date.now() });
    const t = await turn(A, `qa-rate-limited hi again ${TS}`, undefined, { session: warm.session, conversationId: warm.conversationId });
    ok("AT-4.1a", "empty bucket → rate_limited with the busy text", t.outcome === "rate_limited" && t.text === canned("busy", null), `outcome=${t.outcome}`);
    ok("AT-4.1b", "the client's conversationId is not echoed (\"\")", t.conversationId === "", JSON.stringify(t.conversationId));
    ok("AT-4.1c", "zero model, embedding and moderation calls; nothing stored", t.generation === 0 && t.embeds.length === 0 && t.moderations.length === 0 && (await db.message.count({ where: { shopId: A, conversationId: warm.conversationId } })) === before);
    buckets?.delete(`${A}:${warm.session}`);
  });

  await kase("AT-4.2", async () => {
    const session = newSession();
    const convo = await db.conversation.create({ data: { shopId: A, sessionId: session, blocked: true } });
    const t = await turn(A, `qa-blocked-visitor hello ${TS}`, undefined, { session, conversationId: convo.id });
    ok("AT-4.2a", "blocked visitor → visitor_blocked, chat-closed text", t.outcome === "visitor_blocked" && t.text === canned("chatClosed", null), `outcome=${t.outcome}`);
    ok("AT-4.2b", "zero calls, no message stored", t.generation === 0 && t.embeds.length === 0 && (await db.message.count({ where: { shopId: A, conversationId: convo.id } })) === 0);
  });

  await kase("AT-4.3", async () => {
    const session = newSession();
    const convo = await db.conversation.create({ data: { shopId: A, sessionId: session, mode: "human" } });
    const t = await turn(A, `qa-human-mode hello ${TS}`, undefined, { session, conversationId: convo.id });
    ok("AT-4.3a", "human mode → AI dormant (human_mode), zero calls", t.outcome === "human_mode" && t.generation === 0 && t.embeds.length === 0, `outcome=${t.outcome}`);
    ok("AT-4.3b", "the shopper message is still stored for the team", (await db.message.count({ where: { shopId: A, conversationId: convo.id, role: "in" } })) === 1);
  });

  await kase("AT-4.4", async () => {
    await db.shop.update({ where: { id: A }, data: { aiEnabled: false } });
    invalidateShopConfig(A);
    try {
      const live = await turn(A, `qa-ai-off hello ${TS}`);
      ok("AT-4.4a", "AI off (storefront) → human support mode, zero calls", live.outcome === "human_mode" && live.generation === 0 && live.embeds.length === 0, `outcome=${live.outcome}`);
      const test = await turn(A, `qa-ai-off-test hello ${TS}`, undefined, { isTest: true });
      ok("AT-4.4b", "AI off (Test AI) → ai_unavailable + cap text + leave-message form, zero calls", test.outcome === "ai_unavailable" && test.text === canned("cap", null) && test.handover.some((h) => h.data.form !== null) && test.generation === 0, `outcome=${test.outcome}`);
    } finally {
      await db.shop.update({ where: { id: A }, data: { aiEnabled: true } });
      invalidateShopConfig(A);
    }
    const quota = ctx.getQuota("free", "conversations");
    if (quota >= Number.MAX_SAFE_INTEGER) {
      skip("AT-4.4c", "free plan has no conversation cap in the live plan matrix");
      return;
    }
    const { currentPeriodStart } = await import("../../app/lib/billing/usage.server");
    await db.planUsage.deleteMany({ where: { shopId: B } });
    await db.planUsage.create({ data: { shopId: B, periodStart: currentPeriodStart(), conversationCount: quota + 1000 } });
    try {
      const capped = await turn(B, `qa-usage-cap hello ${TS}`, undefined, { keepUsage: true });
      ok("AT-4.4c", "usage cap reached → ai_unavailable + form, zero model calls", capped.outcome === "ai_unavailable" && capped.handover.length > 0 && capped.generation === 0 && capped.embeds.length === 0, `outcome=${capped.outcome}`);
    } finally {
      await db.planUsage.deleteMany({ where: { shopId: B } });
    }
  });

  await kase("AT-4.5", async () => {
    const t = await turn(A, `qa-explicit can I talk to a human please ${TS}`);
    ok("AT-4.5a", "explicit ask → handover before embedding, zero calls", t.outcome === "handover" && t.handover.length === 1 && t.generation === 0 && t.embeds.length === 0, `outcome=${t.outcome} embeds=${t.embeds.length}`);
    await db.handoverConfig.create({ data: { shopId: A, config: { intentRules: [{ topic: "qa-intent-topic payment dispute" }] } } });
    invalidateShopConfig(A);
    try {
      const r = await turn(A, `qa-intent-topic I want to dispute a charge ${TS}`);
      ok("AT-4.5b", "handover intent rule at threshold → handover, zero generation calls", r.outcome === "handover" && r.generation === 0, `outcome=${r.outcome} gen=${r.generation}`);
    } finally {
      await db.handoverConfig.deleteMany({ where: { shopId: A } });
      invalidateShopConfig(A);
    }
  });

  await kase("AT-4.6", async () => {
    const g = await turn(A, `qa-kw any gambling tips for tonight ${TS}`);
    ok("AT-4.6a", "banned topic phrase → blocked before embedding (banned_keyword), zero calls", g.outcome === "blocked" && g.text === canned("blockedTopic", null) && g.generation === 0 && g.embeds.length === 0 && (await lastOut(g.conversationId))?.sourceLayer === "banned_keyword", `outcome=${g.outcome}`);
    const plural = await turn(A, `qa-kw-phrase I need some medical advices ${TS}`);
    ok("AT-4.6b", "whole-phrase scan is plural tolerant (\"medical advices\")", plural.outcome === "blocked" && plural.generation === 0, `outcome=${plural.outcome}`);
    const word = await turn(A, `qa-kw-word is this lamp medical-grade steel ${TS}`);
    ok("AT-4.6c", "a single word of a topic (\"medical-grade\") is not blocked in agent mode", word.outcome !== "blocked" && word.agent.length >= 1, `outcome=${word.outcome}`);
    const m = await turn(A, `qa-moderate-me you are useless ${TS}`);
    ok("AT-4.6d", "moderation flag → blocked (banned_moderation), zero agent rounds", m.outcome === "blocked" && m.agent.length === 0 && (await lastOut(m.conversationId))?.sourceLayer === "banned_moderation", `outcome=${m.outcome}`);
  });

  await kase("AT-4.7", async () => {
    const ca = await db.curatedAnswer.create({ data: { shopId: A, question: "Do you gift wrap?", synonyms: ["qa giftwrap please"], talkingPoints: "QA-CURATED Yes, free gift wrap.", status: "published" } });
    await setVector("curated_answers", ca.id, A, basis(330));
    try {
      const serve = await turn(A, `qa-curated-serve gift wrap ${TS}`);
      ok("AT-4.7a", "curated answer at the serve threshold → served verbatim, zero generation calls", serve.outcome === "curated" && serve.text === "QA-CURATED Yes, free gift wrap." && serve.generation === 0, `outcome=${serve.outcome}`);
      const syn = await turn(A, `hello, qa giftwrap please ${TS}`);
      ok("AT-4.7b", "synonym hit → curated served, zero generation calls", syn.outcome === "curated" && syn.generation === 0, `outcome=${syn.outcome}`);
      const border = await turn(A, `qa-curated-border wrapping options ${TS}`);
      ok("AT-4.7c", "borderline (0.70) curated is left to the agent — no yes/no confirm call", border.outcome !== "curated" && border.agent.length >= 1 && !border.chats.some((c) => c.user.includes("Does this shopper message mean the same")), `outcome=${border.outcome}`);
    } finally {
      await db.curatedAnswer.deleteMany({ where: { shopId: A, id: ca.id } });
    }
    const rec = await db.recommendation.create({ data: { shopId: A, title: "QA Bestsellers", triggerQuestions: ["qa-rec-trigger best lamps"], productIds: [gid(7001001), gid(7001002)], status: "active" } });
    try {
      const r = await turn(A, `qa-rec-trigger what sells best ${TS}`);
      ok("AT-4.7d", "recommendation rule at threshold → banner + rule cards, zero generation calls", r.outcome === "recommendation" && r.text === recommendationBanner("QA Bestsellers", null) && r.cards.length === 2 && r.generation === 0, `outcome=${r.outcome} cards=${r.cards.length}`);
    } finally {
      await db.recommendation.deleteMany({ where: { shopId: A, id: rec.id } });
    }
  });

  await kase("AT-4.8", async () => {
    if (!ctx.planWithTracking) {
      skip("AT-4.8a-b", "no plan includes order_tracking");
    } else {
      const t = await turn(A, `where is my order #10045 ${TS}`);
      ok("AT-4.8a", "order-status question → canned text + Track order button, zero generation calls", t.outcome === "order_status" && t.actions.some((a) => a.key === "track_order") && t.generation === 0, `outcome=${t.outcome}`);
      const sale = await turn(A, `can I order 100 lamps for my shop ${TS}`);
      ok("AT-4.8b", "\"order 100 lamps\" is a sale, not an order-status question", sale.outcome !== "order_status" && sale.agent.length >= 1, `outcome=${sale.outcome}`);
    }
    if (ctx.hasFeature("free", "order_tracking")) {
      skip("AT-4.8c", "free plan includes order_tracking");
      return;
    }
    const b = await turn(B, `where is my order #10046 ${TS}`);
    ok("AT-4.8c", "order tracking plan-gated off → no deterministic Track order reply", b.outcome !== "order_status" && b.actions.length === 0, `outcome=${b.outcome}`);
  });

  await kase("AT-4.9", async () => {
    const msg = `qa-offers any offers running right now ${TS}`;
    const t = await turn(A, msg, [[call(["get_discounts", {}])], [say("Yes — use QAAT20.")]]);
    ok("AT-4.9a", "agent mode: a discount ask scoring 1.0 against \"competitor pricing\" is NOT blocked (meaning scan off)", t.outcome !== "blocked" && t.agent.length >= 1 && (results(t, "get_discounts")[0]?.raw ?? "").includes("QAAT20"), `outcome=${t.outcome}`);
    ok("AT-4.9b", "trace records the meaning scan as skipped in agent mode", t.steps.some((s) => s.layer === "guardrail_meaning" && s.status === "skip"));
    const e = env();
    e.AI_AGENT_MODE = "pipeline";
    try {
      const p = await turn(A, `qa-offers any offers running today ${TS}`);
      ok("AT-4.9c", "precondition: the same ask IS blocked by the meaning scan in pipeline mode", p.outcome === "blocked", `outcome=${p.outcome}`);
    } finally {
      e.AI_AGENT_MODE = "tools";
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // AT-5 — budget
  // ═══════════════════════════════════════════════════════════════════════════
  await kase("AT-5.1", async () => {
    const msg = `qa-budget-loop keep searching ${TS}`;
    const plan: Step[] = Array.from({ length: 6 }, (_, i) => [call(["search_products", { query: `qa-loop-query-${i}` }])]);
    const t = await turn(A, msg, plan);
    ok("AT-5.1a", "a model that never stops calling tools is cut off at 5 rounds", t.agent.length === 5, `rounds=${t.agent.length}`);
    ok("AT-5.1b", "the 5th round offers no tools", (t.agent[4]?.tools.length ?? -1) === 0 && t.agent.slice(0, 4).every((r) => r.tools.length > 0));
    const loopEmbeds = t.embedTexts.filter((x) => x.includes("qa-loop-query"));
    ok("AT-5.1c", "exactly one embedding per executed search call (4), none for the ignored 5th", loopEmbeds.length === 4 && new Set(loopEmbeds).size === 4 && !loopEmbeds.some((x) => x.includes("qa-loop-query-4")), JSON.stringify(loopEmbeds));
    ok("AT-5.1d", "the shopper still gets a sane reply (fallback + leave-message form)", t.text === fallbackText && t.handover.some((h) => h.data.form !== null), short(t.text, 80));
  });

  await kase("AT-5.2", async () => {
    const msg = `qa-budget-burst look everything up ${TS}`;
    const t = await turn(A, msg, [
      [call(...Array.from({ length: 5 }, (_, i): [string, Record<string, unknown>] => ["search_store_info", { question: `qa-many-q${i} shipping?` }]))],
      [say("Done.")],
    ]);
    const infos = results(t, "search_store_info");
    ok("AT-5.2a", "5 calls in one round → 5 tool replies, the 5th refused", infos.length === 5 && /too many tool calls/i.test(String(infos[4]?.result?.error)) && infos.slice(0, 4).every((e) => !e.result?.error), infos.map((e) => short(e.result, 40)).join(" | "));
    const qEmbeds = t.embedTexts.filter((x) => x.includes("qa-many-q"));
    ok("AT-5.2b", "only 4 executed (one embedding each, none for q4)", qEmbeds.length === 4 && !qEmbeds.some((x) => x.includes("qa-many-q4")), JSON.stringify(qEmbeds));
  });

  await kase("AT-5.3", async () => {
    const q = `qa-budget-empty hmm ${TS}`;
    const t = await turn(A, q, [[]]);
    ok("AT-5.3a", "empty model output → fallback text, never a silent turn", t.text === fallbackText, short(t.text, 80));
    ok("AT-5.3b", "…logged as unresolved with the leave-message form", (await db.unresolvedQuestion.count({ where: { shopId: A, question: q.trim() } })) === 1 && t.handover.some((h) => h.data.form !== null));
    const half = `qa-budget-throw-half checking ${TS}`;
    const h = await turn(A, half, [{ events: [say("Let me check")], throwAfter: true }]);
    // QA3-A5 (2026-09-15): a round that may call tools is held until it ends, so
    // a half-written sentence from a failed round never reaches the shopper.
    ok("AT-5.3c", "stream fails after partial text → partial text NOT shown, fallback shown, form offered", !h.text.includes("Let me check") && h.text.includes(fallbackText) && h.handover.length > 0 && h.outcome === "fell_back", `outcome=${h.outcome} text=${short(h.text, 80)}`);
    const none = `qa-budget-throw-none checking ${TS}`;
    const n = await turn(A, none, [{ throwAfter: true }]);
    ok("AT-5.3d", "stream fails before any text → fallback + unresolved", n.text === fallbackText && (await db.unresolvedQuestion.count({ where: { shopId: A, question: none.trim() } })) === 1, short(n.text, 80));
  });

  await kase("AT-5.4", async () => {
    const t = await turn(A, `qa-budget-slow slow tools ${TS}`, [{ delayMs: 15_300, events: [call(["search_store_info", { question: "slow?" }])] }, [say("Answer.")]]);
    ok("AT-5.4a", "past the 15 s turn budget the next round offers no tools (answer round)", t.agent.length === 2 && (t.agent[1]?.tools.length ?? -1) === 0 && t.text === "Answer.", `rounds=${t.agent.length} tools=${t.agent[1]?.tools.length}`);
  }, 60_000);

  // ═══════════════════════════════════════════════════════════════════════════
  // AT-6 — context
  // ═══════════════════════════════════════════════════════════════════════════
  await kase("AT-6.1", async () => {
    const session = newSession();
    const convo = await db.conversation.create({ data: { shopId: A, sessionId: session, summary: "QA-SUMMARY shopper wants a warm lamp under 60." } });
    const base = Date.now() - 60_000;
    await db.message.create({ data: { shopId: A, conversationId: convo.id, role: "in", author: "shopper", content: "qa-hist show me lamps", createdAt: new Date(base) } });
    await db.message.create({
      data: {
        shopId: A, conversationId: convo.id, role: "out", author: "ai", content: "Here are two lamps.", sourceLayer: "buy", createdAt: new Date(base + 1000),
        productCards: [{ shopifyProductId: gid(7001001), title: "Aurora Lamp" }, { shopifyProductId: gid(7001002), title: "Borealis Lamp" }],
        intent: { agent: true, tools: ["search_products"], facts: ["Aurora Lamp: €49.50, available"] },
      },
    });
    const msg = `qa-hist-follow is the first one dimmable ${TS}`;
    const t = await turn(A, msg, [[say("Let me check.")]], { session, conversationId: convo.id });
    const msgs = t.agent[0]?.messages ?? [];
    const contents = msgs.map((m) => `${m.role}:${m.content ?? ""}`);
    ok("AT-6.1a", "the model sees the earlier shopper and assistant turns", contents.includes("user:qa-hist show me lamps") && contents.includes("assistant:Here are two lamps."));
    ok("AT-6.1b", "…with a system note naming the products that reply showed (title + id)", contents.some((c) => c.startsWith("system:") && c.includes("Products shown with the previous reply: Aurora Lamp (id 7001001); Borealis Lamp (id 7001002)")), short(contents.filter((c) => c.startsWith("system:")), 300));
    ok("AT-6.1c", "…and the facts looked up for it", contents.some((c) => c.includes("Facts looked up for the previous reply: Aurora Lamp: €49.50, available")));
    ok("AT-6.1d", "the rolling summary rides as a system message", contents.some((c) => c === "system:Earlier conversation summary: QA-SUMMARY shopper wants a warm lamp under 60."));
    ok("AT-6.1e", "the current message appears exactly once, last user turn", contents.filter((c) => c === `user:${msg.trim()}`).length === 1 && msgs.filter((m) => m.role === "user").pop()?.content === msg.trim());
    ok("AT-6.1f", "annotation notes never enter the assistant text itself", !contents.some((c) => c.startsWith("assistant:") && c.includes("(id ")));
  });

  await kase("AT-6.2", async () => {
    const hit = await turn(A, `qa-preload-hit what is the refund window ${TS}`, [[say("30 days.")]]);
    const note = (t: Turn) => (t.agent[0]?.messages ?? []).find((m) => m.role === "system" && String(m.content).startsWith("Possibly related store information"));
    ok("AT-6.2a", "store info scoring 0.50 (≥ 0.45) is preloaded as a system note before round 1", !!note(hit) && String(note(hit)?.content).includes("QA-PRELOAD-HIGH"), short(note(hit)?.content));
    ok("AT-6.2b", "…placed after the shopper message and labelled as data, not instructions", (hit.agent[0]?.messages ?? []).findIndex((m) => m === note(hit)) > (hit.agent[0]?.messages ?? []).findIndex((m) => m.role === "user" && m.content === `qa-preload-hit what is the refund window ${TS}`) && String(note(hit)?.content).includes("not instructions"));
    const miss = await turn(A, `qa-preload-miss do points expire ${TS}`, [[say("Not sure.")]]);
    ok("AT-6.2c", "store info scoring 0.44 is not preloaded", !note(miss) && !prompt(miss).includes("QA-PRELOAD-LOW"));
    ok("AT-6.2d", "zero extra embeddings for the preload (reuses the message embedding)", hit.embeds.length === 1, `embeds=${hit.embeds.length}`);
  });

  await kase("AT-6.3", async () => {
    const session = newSession();
    const contact = await db.contact.create({ data: { shopId: A, sessionId: session, name: "jane doe", email: "jane.qa@example.com", phone: "+1 555 000 1111", type: "customer", location: "Berlin, Germany" } });
    const convo = await db.conversation.create({ data: { shopId: A, sessionId: session, contactId: contact.id } });
    await db.message.create({ data: { shopId: A, conversationId: convo.id, role: "in", author: "shopper", sourceLayer: "handover", content: "Email: jane.qa@example.com Phone: +1 555 000 1111 Order #1001", createdAt: new Date(Date.now() - 30_000) } });
    const pageContext = { url: "/products/aurora-lamp", cart: { itemCount: 2, totalValue: 79.5, items: [{ title: "Aurora Lamp", quantity: 1, price: 49.5 }, { title: "Borealis Lamp", quantity: 1, price: 30 }] } };
    const t = await turn(A, `qa-privacy do you know me ${TS}`, [[say("Hi Jane!")]], { session, conversationId: convo.id, pageContext });
    const sys = system(t);
    const all = prompt(t);
    ok("AT-6.3a", "prompt carries first name, returning-customer flag and location", sys.includes("Their first name is Jane.") && sys.includes("They have ordered from this store before.") && sys.includes("They are in Berlin, Germany."), short(sys.slice(sys.indexOf("SHOPPER")), 240));
    ok("AT-6.3b", "prompt carries the current product page and the cart", sys.includes('product page for "aurora-lamp"') && sys.includes("Their cart holds 2 items (Aurora Lamp, Borealis Lamp)"));
    ok("AT-6.3c", "prompt never contains the email, phone or last name", !all.includes("jane.qa@example.com") && !all.includes("555 000 1111") && !/\bdoe\b/i.test(all));
    ok("AT-6.3d", "the leave-message submission is replaced by a placeholder in history", all.includes("[The shopper left their contact details for the store team.]") && !all.includes("Order #1001"));
  });

  await kase("AT-6.4", async () => {
    await db.persona.create({ data: { shopId: A, role: "QA-ROLE You are Lampy.", brandVoice: "QA-VOICE warm", behaviours: "QA-BEHAVIOUR mention free returns", scope: "QA-SCOPE lamps and lighting", defaultLanguage: "es", autoDetectLanguage: false } });
    invalidateShopConfig(A);
    try {
      const t = await turn(A, `qa-policy hello ${TS}`, [[say("Hola.")]]);
      const sys = system(t);
      ok("AT-6.4a", "persona role, brand voice and behaviours lead the system prompt", sys.startsWith("QA-ROLE You are Lampy.") && sys.includes("Brand voice: QA-VOICE warm") && sys.includes("QA-BEHAVIOUR mention free returns"));
      ok("AT-6.4b", "AGENT_SYSTEM and the store context are composed in", sys.includes(AGENT_SYSTEM) && sys.includes("Store: QA Agent A."));
      ok("AT-6.4c", "banned topics are composed into the agent policy", sys.includes("The store does not allow advice or information on these topics: gambling, medical advice, competitor pricing."));
      ok("AT-6.4d", "the merchant scope is composed into the agent policy", sys.includes("This store is about: QA-SCOPE lamps and lighting."));
      ok("AT-6.4e", "fixed language → explicit reply-language rule", sys.includes("Reply ONLY in Spanish, no matter which language the shopper writes in."));
      await db.persona.updateMany({ where: { shopId: A }, data: { scope: "", autoDetectLanguage: true, role: "", brandVoice: "" } });
      invalidateShopConfig(A);
      const t2 = await turn(A, `qa-policy-2 hello ${TS}`, [[say("Hi.")]]);
      const sys2 = system(t2);
      ok("AT-6.4f", "no scope → the generic stay-on-this-store line", sys2.includes("Stay focused on this store") && !sys2.includes("This store is about:"));
      ok("AT-6.4g", "auto-detect → reply in the language of the latest message", sys2.includes("Always reply in the language of the shopper's LATEST message"));
      ok("AT-6.4h", "blank role / brand voice fall back to the install defaults", sys2.startsWith(DEFAULT_PERSONA.role) && sys2.includes(`Brand voice: ${DEFAULT_PERSONA.brandVoice}`));
    } finally {
      await db.persona.deleteMany({ where: { shopId: A } });
      invalidateShopConfig(A);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // AT-7 — description passages in the agent (spec 25)
  // ═══════════════════════════════════════════════════════════════════════════
  await kase("AT-7.1", async () => {
    const t = await turn(A, `qa-mug-question tell me about the glacier mug ${TS}`, [[call(["get_product", { product: "Glacier Mug", question: "qa-q-dishwasher can it go in the dishwasher" }])], [say("Yes.")]]);
    const r = results(t, "get_product")[0]?.result as { description_relevant?: string[]; description_overview?: string; description?: string } | null;
    ok("AT-7.1a", "get_product(product, question) returns the 3 passages most similar to the question, in description order", JSON.stringify(r?.description_relevant) === JSON.stringify([P.gift, P.dishwasher, P.microwave]), short(r?.description_relevant, 200));
    ok("AT-7.1b", "…plus a short overview, and never the full description", typeof r?.description_overview === "string" && r.description_overview.startsWith("QA-GLACIER-OVERVIEW") && r.description_overview.length <= 600 && r?.description === undefined, `overview=${r?.description_overview?.length}`);
    ok("AT-7.1c", "a question different from the shopper's words costs exactly one extra embedding", t.embedTexts.filter((x) => x.includes("qa-q-dishwasher")).length === 1);
    const t2 = await turn(A, `qa-origin-msg where is the glacier mug made ${TS}`, [[call(["get_product", { product: "Glacier Mug" }])], [say("Portugal.")]]);
    const r2 = results(t2, "get_product")[0]?.result as { description_relevant?: string[] } | null;
    ok("AT-7.1d", "no question → passages ranked by the shopper's own message, no extra embedding", (r2?.description_relevant ?? []).includes(P.origin) && t2.embeds.length === 1, `embeds=${t2.embeds.length} ${short(r2?.description_relevant)}`);
    const t3 = await turn(A, `qa-short-desc tell me about aurora ${TS}`, [[call(["get_product", { product: "Aurora Lamp", question: "qa-q-dishwasher is it washable" }])], [say("It's a lamp.")]]);
    const r3 = results(t3, "get_product")[0]?.result as { description?: string; description_relevant?: unknown } | null;
    ok("AT-7.1e", "a product without passages returns its whole description", r3?.description === "Aurora Lamp — a QA fixture product." && r3?.description_relevant === undefined, short(r3));
    void aurora;
  });

  await kase("AT-7.2", async () => {
    const t = await turn(A, `qa-shopper-dishwasher is the glacier mug dishwasher safe ${TS}`, [[call(["search_products", { query: "qa-search-mugs" }])], [say("Yes.")]]);
    const r = results(t, "search_products")[0]?.result as { results?: Array<{ title: string; description_about_shoppers_question?: string }> } | null;
    const byTitle = new Map((r?.results ?? []).map((x) => [x.title, x]));
    ok("AT-7.2a", "search results found the mug fixtures (precondition)", byTitle.has("Glacier Mug") && byTitle.has("Frost Cup") && byTitle.has("Snow Bowl"), [...byTitle.keys()].join(","));
    ok("AT-7.2b", "passage matching the SHOPPER's words rides on the result (1.00)", byTitle.get("Glacier Mug")?.description_about_shoppers_question === P.dishwasher);
    ok("AT-7.2c", "threshold 0.55: a 0.56 passage is attached", byTitle.get("Snow Bowl")?.description_about_shoppers_question?.includes("QA-PASSAGE-SNOW-056") === true);
    ok("AT-7.2d", "threshold 0.55: a 0.54 passage is not", byTitle.has("Frost Cup") && byTitle.get("Frost Cup")?.description_about_shoppers_question === undefined);
    ok("AT-7.2e", "no extra embedding for the shopper passage (one per search call)", t.embedTexts.filter((x) => x.includes("qa-search-mugs")).length === 1 && t.embeds.length === 2, `embeds=${t.embeds.length}`);
    const same = `qa-same-query glacier`;
    const s = await turn(A, same, [[call(["search_products", { query: same }])], [say("Here.")]]);
    const rs = results(s, "search_products")[0]?.result as { results?: Array<{ title: string; description_about_shoppers_question?: string }> } | null;
    ok("AT-7.2f", "query identical to the shopper message → found via the passage lane, no shopper-passage field", (rs?.results ?? []).some((x) => x.title === "Glacier Mug") && (rs?.results ?? []).every((x) => x.description_about_shoppers_question === undefined), short(rs?.results?.map((x) => x.title)));
    const info = await turn(A, `qa-store-info-mug a question ${TS}`, [[call(["search_store_info", { question: "qa-q-dishwasher does the mug survive a dishwasher" }])], [say("Yes.")]]);
    const ri = results(info, "search_store_info")[0]?.result as { results?: Array<{ source: string; topic: string; text: string }> } | null;
    ok("AT-7.2g", "search_store_info also returns matching product-description passages", (ri?.results ?? []).some((x) => x.source === "product description" && x.topic === "Glacier Mug" && x.text === P.dishwasher), short(ri?.results));
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // AT-8 — changes made in the same session
  // ═══════════════════════════════════════════════════════════════════════════
  await kase("AT-8.1", async () => {
    const { requireShopAccess } = await import("../../app/lib/access.server");
    const { JOBS } = await import("../../app/lib/jobs/handlers.server");
    const g = global as unknown as { bootstrappedShops?: Set<string> };
    const expires = new Date(Date.now() + 24 * 3600_000);
    for (const d of [BOOT_NO_ROW, BOOT_NO_PERSONA, BOOT_NO_SYNC, BOOT_HEALTHY]) {
      await db.session.create({ data: { id: `offline_${d}`, shop: d, state: "", isOnline: false, scope: process.env.SCOPES, accessToken: "shpat_qa_at_fake", expires } });
    }
    const noPersona = await db.shop.create({ data: { domain: BOOT_NO_PERSONA } });
    const noSync = await db.shop.create({ data: { domain: BOOT_NO_SYNC } });
    await db.persona.create({ data: { shopId: noSync.id } });
    await db.syncState.create({ data: { shopId: noSync.id, collectionSyncAt: new Date() } });
    const healthy = await db.shop.create({ data: { domain: BOOT_HEALTHY } });
    await db.persona.create({ data: { shopId: healthy.id } });
    await db.syncState.create({ data: { shopId: healthy.id, productSyncAt: new Date(), pageSyncAt: new Date(), articleSyncAt: new Date() } });

    const open = async (domain: string) => {
      const request = new Request("http://localhost:3000/app", { headers: { Authorization: `Bearer ${sessionToken(domain)}` } });
      try {
        return { access: await requireShopAccess(request), error: null as string | null };
      } catch (error) {
        return { access: null, error: error instanceof Response ? `Response ${error.status}` : String(error) };
      }
    };
    const catalogJobs = (domain: string) => bossSent.filter((s) => s.name === JOBS.catalogSync && s.data.shopDomain === domain).length;

    const first = await open(BOOT_NO_ROW);
    if (!first.access) {
      skip("AT-8.1", `the embedded-admin auth path rejected a locally signed session token (${first.error}) — ensureShopBootstrapped is not exported, so it cannot be reached without app changes`);
      return;
    }
    const rowC = await db.shop.findUnique({ where: { domain: BOOT_NO_ROW } });
    ok("AT-8.1a", "no shop row → opening the app creates the row, seeds defaults and queues the first sync", !!rowC && first.access.shopId === rowC.id && (await db.persona.count({ where: { shopId: rowC.id } })) === 1 && (await db.guardrails.count({ where: { shopId: rowC.id } })) === 1 && catalogJobs(BOOT_NO_ROW) === 1, `jobs=${catalogJobs(BOOT_NO_ROW)}`);
    await open(BOOT_NO_ROW);
    ok("AT-8.1b", "a second open in the same process does not bootstrap again", catalogJobs(BOOT_NO_ROW) === 1, `jobs=${catalogJobs(BOOT_NO_ROW)}`);
    g.bootstrappedShops?.delete(rowC!.id);
    await open(BOOT_NO_ROW);
    ok("AT-8.1c", "re-running the bootstrap (new process, still never synced) is idempotent: 1 persona, 1 guardrails, 2 seeded recommendations", (await db.persona.count({ where: { shopId: rowC!.id } })) === 1 && (await db.guardrails.count({ where: { shopId: rowC!.id } })) === 1 && (await db.recommendation.count({ where: { shopId: rowC!.id } })) === 2, `jobs=${catalogJobs(BOOT_NO_ROW)}`);
    const d = await open(BOOT_NO_PERSONA);
    ok("AT-8.1d", "row without persona → bootstrapped (persona seeded, sync queued)", d.access?.shopId === noPersona.id && (await db.persona.count({ where: { shopId: noPersona.id } })) === 1 && catalogJobs(BOOT_NO_PERSONA) === 1);
    const e = await open(BOOT_NO_SYNC);
    ok("AT-8.1e", "row + persona but products never synced (sync_states row from another sync) → first product sync queued", e.access?.shopId === noSync.id && catalogJobs(BOOT_NO_SYNC) === 1 && (await db.guardrails.count({ where: { shopId: noSync.id } })) === 1);
    const sentBefore = bossSent.length;
    const f = await open(BOOT_HEALTHY);
    ok("AT-8.1f", "a healthy shop is never bootstrapped (no jobs, no seeded rows)", f.access?.shopId === healthy.id && bossSent.length === sentBefore && (await db.guardrails.count({ where: { shopId: healthy.id } })) === 0 && (await db.recommendation.count({ where: { shopId: healthy.id } })) === 0, `sent=${bossSent.length - sentBefore}`);
  });

  await kase("AT-8.2", async () => {
    const { logAudit, logWarn } = await import("../../app/lib/log.server");
    const auditEvent = `qa_at_audit_${TS}`;
    const warnEvent = `qa_at_warn_${TS}`;
    const by = "qa-operator@example.com";
    const mute = { warn: console.warn, error: console.error };
    console.warn = () => undefined;
    console.error = () => undefined;
    try {
      for (let i = 0; i < 55; i++) logAudit(auditEvent, by, `qa audit ${i}`, { shopId: A });
      for (let i = 0; i < 55; i++) logWarn(warnEvent, `qa warn ${i}`, { shopId: A });
    } finally {
      console.warn = mute.warn;
      console.error = mute.error;
    }
    const counts = async () => ({
      audit: await db.appLog.count({ where: { shopId: A, event: auditEvent } }),
      warn: await db.appLog.count({ where: { shopId: A, event: warnEvent } }),
      capped: await db.appLog.count({ where: { shopId: A, event: "log_rate_capped", occurredAt: { gte: ctx.startedAt } } }),
    });
    let c = await counts();
    for (let i = 0; i < 40 && (c.audit < 55 || c.warn < 50 || c.capped < 1); i++) {
      await sleep(100);
      c = await counts();
    }
    await sleep(400);
    c = await counts();
    ok("AT-8.2a", "logAudit is never rate-capped (55 rows past the 50/hour cap)", c.audit === 55, JSON.stringify(c));
    const rows = await db.appLog.findMany({ where: { shopId: A, event: auditEvent }, select: { context: true, level: true } });
    ok("AT-8.2b", "every audit row keeps `by` (the operator identity, unscrubbed)", rows.length > 0 && rows.every((r) => (r.context as { by?: string } | null)?.by === by), short(rows[0]?.context));
    ok("AT-8.2c", "ordinary events are still capped at 50/hour with one log_rate_capped notice", c.warn === 50 && c.capped === 1, JSON.stringify(c));
    const debugSrc = src("app/routes/admin.debug._index.tsx") + src("app/routes/admin.debug.$shopId.$conversationId.tsx");
    const auditCalls = debugSrc.match(/logAudit\(\s*"[a-z_]+",\s*session\.admin\.email/g) ?? [];
    ok("AT-8.2d", "the 5 Admin → Debug access rows use logAudit with the operator's email as `by`", auditCalls.length === 5 && !/logWarn\(\s*"turn_trac/.test(debugSrc), `logAudit calls=${auditCalls.length}`);
  });

  await kase("AT-8.3", async () => {
    const { recordLlmUsageSync, recordLlmUsage } = await import("../../app/lib/llm/usage.server");
    const model = `qa-at-usage-${TS}`;
    await Promise.all(Array.from({ length: 30 }, (_, i) => recordLlmUsageSync({ shopId: B, model, purpose: "reply", promptTokens: i + 1, cachedTokens: 1, completionTokens: 2 })));
    const rows = await db.llmUsageDaily.findMany({ where: { shopId: B, model } });
    ok("AT-8.3a", "30 parallel usage records → one row with exact totals (atomic upsert)", rows.length === 1 && rows[0].calls === 30 && rows[0].promptTokens === 465 && rows[0].cachedTokens === 30 && rows[0].completionTokens === 60, JSON.stringify(rows.map((r) => ({ c: r.calls, p: r.promptTokens, k: r.cachedTokens, o: r.completionTokens }))));

    const purge = await db.shop.create({ data: { domain: PURGE_SHOP, name: "QA purge" } });
    const product = await db.product.create({ data: { shopId: purge.id, shopifyProductId: gid(9009001), title: "Purge Mug" } });
    await mkPassage(purge.id, product.id, 0, "QA purge passage", basis(500));
    await recordLlmUsageSync({ shopId: purge.id, model, purpose: "embedding", promptTokens: 5 });
    const { cleanupShop, countShopRows } = await import("../../app/lib/jobs/handlers.server");
    await cleanupShop(PURGE_SHOP);
    for (let i = 0; i < 10; i++) recordLlmUsage({ shopId: purge.id, model, purpose: "reply", promptTokens: 3 });
    await recordLlmUsageSync({ shopId: purge.id, model, purpose: "summary", promptTokens: 3 });
    await sleep(500);
    ok("AT-8.3b", "usage recorded after the purge (uninstalled shop) writes nothing — no leftover llm_usage_daily row", (await db.llmUsageDaily.count({ where: { shopId: purge.id } })) === 0);
    ok("AT-8.3c", "cleanupShop removes product_passages", (await db.productPassage.count({ where: { shopId: purge.id } })) === 0);
    const leftovers = await countShopRows(purge.id, PURGE_SHOP);
    ok("AT-8.3d", "countShopRows reports nothing left (product_passages included in its table list)", leftovers.length === 0 && /\["product_passages", await db\.productPassage\.count\(where\)\]/.test(src("app/lib/jobs/handlers.server.ts")), JSON.stringify(leftovers));
    await db.llmUsageDaily.deleteMany({ where: { shopId: B, model } });
  });

  await kase("AT-8.4", async () => {
    const collector = new TurnCollector();
    const msg = `qa-capture show me a lamp ${TS}`;
    const t = await turn(A, msg, [[call(["search_products", { query: "lamp" }])], [say("Here you go.")]], { capture: collector });
    // The pre-agent turn check (purpose router) is captured too; rounds are the reply calls.
    const rounds = collector.calls.filter((c) => c.purpose === "reply");
    ok("AT-8.4a", "Debug capture records every agent round (2) plus the pre-agent check", rounds.length === 2 && collector.calls.length === 3, `calls=${collector.calls.length} rounds=${rounds.length}`);
    ok("AT-8.4b", "round 1 response records the tool call", rounds[0]?.response.includes('[tool calls] search_products({"query":"lamp"})') === true, short(rounds[0]?.response));
    ok("AT-8.4c", "round 2 prompt records the tool call and its result", (rounds[1]?.messages ?? []).some((m) => m.content.startsWith("[tool result call_")) && (rounds[1]?.messages ?? []).some((m) => m.content.includes("[tool calls] search_products")));
    let row = null as null | { payload: unknown; outcome: string };
    for (let i = 0; i < 40 && !row; i++) {
      row = await db.turnTrace.findFirst({ where: { shopId: A, conversationId: t.conversationId }, select: { payload: true, outcome: true } });
      if (!row) await sleep(100);
    }
    const payload = (row?.payload ?? {}) as { llmCalls?: unknown[]; steps?: Array<{ layer: string }> };
    ok("AT-8.4d", "the recorded turn is saved with its LLM calls and agent_tool steps", !!row && (payload.llmCalls ?? []).length === 3 && (payload.steps ?? []).some((s) => s.layer === "agent_tool") && row.outcome === t.outcome, `row=${!!row} outcome=${row?.outcome}`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // AT-9 — tenancy under concurrency
  // ═══════════════════════════════════════════════════════════════════════════
  await kase("AT-9.1", async () => {
    const jitter = () => Math.floor(Math.random() * 40);
    const planFor = (): Step[] => [
      (req) => sleep(jitter()).then(() => [call(["search_products", { query: "qa-tenancy lamp" }], ["get_product", { product: "Aurora Lamp" }])]).then((x) => { void req; return x; }),
      () => sleep(jitter()).then(() => [call(["show_products", { products: ["Aurora Lamp"] }])]),
      () => sleep(jitter()).then(() => [say("Here it is.")]),
    ];
    const runs: Array<Promise<{ shop: "A" | "B"; t: Turn; collector: InstanceType<typeof TurnCollector> }>> = [];
    for (let i = 0; i < 4; i++) {
      for (const shop of ["A", "B"] as const) {
        const collector = new TurnCollector();
        const shopId = shop === "A" ? A : B;
        runs.push(turn(shopId, `qa-tenancy-${shop}-${i} the aurora please ${TS}`, planFor(), { capture: collector }).then((t) => ({ shop, t, collector })));
      }
    }
    const done = await Promise.all(runs);
    const eur = formatMoney(49.5, "EUR");
    const usd = formatMoney(999, "USD");
    let resultsOk = true;
    let cardsOk = true;
    let promptsOk = true;
    const notes: string[] = [];
    for (const { shop, t, collector } of done) {
      const raw = t.tools.map((e) => e.raw).join(" ");
      const good = shop === "A"
        ? raw.includes("7001001") && raw.includes(eur) && !raw.includes("8002001") && !raw.includes(usd) && !raw.includes("Zephyr") && !raw.includes("Bravo")
        : raw.includes("8002001") && raw.includes(usd) && !raw.includes("7001001") && !raw.includes(eur) && !raw.includes("Borealis") && !raw.includes("Comet");
      if (!good) { resultsOk = false; notes.push(`${shop} tools: ${short(raw, 120)}`); }
      const card = t.cards[0];
      if (!card || t.cards.length > 4 || card.shopifyProductId !== (shop === "A" ? gid(7001001) : gid(8002001)) || card.price !== (shop === "A" ? 49.5 : 999)) {
        cardsOk = false;
        notes.push(`${shop} cards: ${short(t.cards)}`);
      }
      const captured = JSON.stringify(collector.calls);
      const mine = shop === "A" ? "Store: QA Agent A." : "Store: QA Agent B.";
      const theirs = shop === "A" ? "QA Agent B" : "QA Agent A";
      if (collector.calls.filter((c) => c.purpose === "reply").length !== 3 || !captured.includes(mine) || captured.includes(theirs)) {
        promptsOk = false;
        notes.push(`${shop} capture: calls=${collector.calls.length}`);
      }
    }
    ok("AT-9.1a", "8 interleaved agent turns across two shops: every tool result is the turn's own shop", resultsOk, notes.join(" || "));
    ok("AT-9.1b", "every card is the turn's own shop's row (same title, different id/price)", cardsOk, notes.join(" || "));
    ok("AT-9.1c", "Debug-captured prompts never cross turns or shops", promptsOk, notes.join(" || "));
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // AT-L1 — LIVE smoke (optional, real model, not part of the deterministic contract)
  // ═══════════════════════════════════════════════════════════════════════════
  await kase("AT-L1", async () => {
    if (!process.env.OPENAI_API_KEY) {
      skip("AT-L1", "OPENAI_API_KEY not set — live agent smoke skipped");
      return;
    }
    const { OpenAiProvider } = await import("../../app/lib/llm/openai.server");
    allowOpenAi = true;
    try {
      const live = new OpenAiProvider();
      const getProduct: ToolDefinition = {
        name: "get_product",
        description: "Details of one product: price, availability, variants, materials, specifications and the parts of its description that answer the shopper's question. Use it for any question about a specific product.",
        parameters: { type: "object", properties: { product: { type: "string" }, question: { type: "string" } }, required: ["product"], additionalProperties: false },
      };
      const messages: AgentMessage[] = [
        { role: "system", content: `${AGENT_SYSTEM}\n\nStore: QA Live. Prices are in USD.` },
        { role: "user", content: "show me a lamp for my desk" },
        { role: "assistant", content: "This one would suit a desk nicely." },
        { role: "system", content: "Products shown with the previous reply: Aurora Lamp (id 7001001)." },
        { role: "user", content: "is it waterproof?" },
      ];
      const events: AgentEvent[] = [];
      for await (const ev of live.agentStream(messages, [getProduct], { shopId: "", purpose: "reply" }, { temperature: 0.3, maxTokens: 200 })) events.push(ev);
      const calls = events.flatMap((e) => (e.type === "tool_calls" ? e.calls : []));
      const text = events.map((e) => (e.type === "text" ? e.text : "")).join("");
      ok("AT-L1", "LIVE: a product follow-up (\"is it waterproof?\") triggers get_product instead of an unlooked-up answer (known open issue on gpt-4.1-mini)", calls.some((c) => c.name === "get_product" && /aurora|7001001/i.test(c.arguments)), calls.length ? JSON.stringify(calls) : `no tool call; text="${short(text, 120)}"`);
    } finally {
      allowOpenAi = false;
    }
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
