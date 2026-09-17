/* eslint-disable @typescript-eslint/no-explicit-any -- QA harness: route
 * payloads, stub pg-boss calls and Prisma JSON columns are probed structurally. */
/* QA fix plan gap suite (QA-FIX-PLAN-2026-09-14) — case IDs QF-<finding>-<n>.
 *
 * Run: npx tsx scripts/qa/qa-fixes.test.ts   (PowerShell; PRISMA_CLIENT_ENGINE_TYPE=binary)
 * Needs: dev Postgres up + migrated. The HTTP cases (QF-C1-*) also need the dev
 * server on http://localhost:3000 and SKIP clearly when it is unreachable.
 *
 * Covers only what the existing suites do not (see TEST-CASES / features
 * "QA fixes" + "QA-T2 coverage", routing, ui-admin, verify-compliance,
 * subscription-webhook, install-lifecycle, human-mode, eval-golden).
 *
 * Safety:
 *  - NEVER a pg-boss worker: a stub is installed as the pg-boss singleton before
 *    any app import, so every enqueue() is recorded in memory and nothing is
 *    sent — the dev server's worker never sees a job from this suite.
 *  - Throwaway shops `qa-qf-<ts>-{a,b}.myshopify.com`, removed in finally.
 *  - The global rows it touches (app_secrets `admin:turn-tracing`,
 *    `admin:runtime`) are snapshotted and restored byte-identical in finally.
 *  - No LLM calls: storefront turns run on AI-off shops (human mode) and the
 *    Test AI cap path, both zero-generation.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { qaFetch, waitForServer } from "./http";

// Load .env manually (tsx does not) BEFORE importing app modules.
for (const line of readFileSync(join(process.cwd(), ".env"), "utf-8").split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (match && !line.trim().startsWith("#") && process.env[match[1]] === undefined) {
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}
process.env.SHOPIFY_API_KEY ||= "qa-placeholder-key";
process.env.SHOPIFY_API_SECRET ||= "qa-placeholder-secret";
process.env.SHOPIFY_APP_URL ||= "http://localhost:3000";
process.env.SCOPES ||= "read_products";

// Route modules for the embedded dashboard / Training import CSS (Vite-only).
// Resolve any stylesheet import to an empty module so their actions can be
// called in-process.
register(
  "data:text/javascript;base64," +
    Buffer.from(
      `export async function resolve(s, c, n) {
        if (/\\.css(\\?.*)?$/.test(s) || /\\?url$/.test(s)) return { url: ${JSON.stringify(pathToFileURL(join(process.cwd(), "app/db.server.ts")).href)}, shortCircuit: true };
        return n(s, c);
      }
      export async function load(u, c, n) {
        if (u === "file:///C:/qa-css-stub.mjs") return { format: "module", source: 'export default "";', shortCircuit: true };
        return n(u, c);
      }`,
    ).toString("base64"),
);

const ROOT = process.cwd();
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const ORIGIN = new URL(BASE).origin;
const SECRET = process.env.SHOPIFY_API_SECRET!;
const TS = Date.now();
const DOMAIN_A = `qa-qf-${TS}-a.myshopify.com`;
const DOMAIN_B = `qa-qf-${TS}-b.myshopify.com`;
const TRACING_KEY = "admin:turn-tracing";
const RUNTIME_KEY = "admin:runtime";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

let passed = 0;
let failed = 0;
let skipped = 0;
const failures: string[] = [];

function ok(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  PASS ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function skip(name: string, why: string): void {
  skipped++;
  console.log(`  SKIP ${name} — ${why}`);
}
function section(title: string): void {
  console.log(`\n── ${title}`);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const src = (rel: string) => readFileSync(join(ROOT, rel), "utf-8");

// ── pg-boss stub (send-only, in memory) ─────────────────────────────────────
interface Sent {
  name: string;
  data: any;
  options: any;
}
const sent: Sent[] = [];
const stubQueue = {
  mode: "ok" as "ok" | "null" | "throw",
  async send(name: string, data: any, options?: any) {
    if (stubQueue.mode === "throw") throw new Error("qa: queue unavailable");
    sent.push({ name, data, options });
    return stubQueue.mode === "null" ? null : `qa-job-${sent.length}`;
  },
  async createQueue() {},
  async work() {},
  async schedule() {},
  async stop() {},
  on() {},
};
(globalThis as any).pgBossGlobal = { boss: stubQueue, started: Promise.resolve() };

/** Run a loader/action; a thrown Response becomes the result. */
async function call(fn: (args: any) => unknown, request: Request, params: Record<string, string> = {}) {
  try {
    const value = await fn({ request, params, context: {} });
    return { thrown: false, value: value as any, status: value instanceof Response ? value.status : 200 };
  } catch (error) {
    if (error instanceof Response) return { thrown: true, value: error as any, status: error.status };
    return { thrown: true, value: error as any, status: 500 };
  }
}

function webhookRequest(topic: string, shopDomain: string, payload: unknown): Request {
  const body = JSON.stringify(payload);
  return new Request(`${BASE}/webhooks/qa`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-shopify-topic": topic,
      "x-shopify-hmac-sha256": createHmac("sha256", SECRET).update(body, "utf8").digest("base64"),
      "x-shopify-shop-domain": shopDomain,
      "x-shopify-api-version": "2026-07",
      "x-shopify-webhook-id": `qa-qf-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    },
    body,
  });
}

function proxyChatRequest(shopDomain: string, body: Record<string, unknown>): Request {
  const params: Record<string, string> = {
    logged_in_customer_id: "",
    path_prefix: "/apps/ccwidget",
    shop: shopDomain,
    timestamp: String(Math.floor(Date.now() / 1000)),
  };
  const canonical = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("");
  const signature = createHmac("sha256", SECRET).update(canonical, "utf8").digest("hex");
  return new Request(`${BASE}/proxy/chat?${new URLSearchParams({ ...params, signature })}`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": UA },
    body: JSON.stringify(body),
  });
}

/** Drain an SSE response into frames. */
async function frames(res: Response): Promise<any[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .map((chunk) => chunk.replace(/^data: /, "").trim())
    .filter(Boolean)
    .map((json) => {
      try {
        return JSON.parse(json);
      } catch {
        return { type: "unparsed", json };
      }
    });
}

async function main(): Promise<void> {
  const db = (await import("../../app/db.server")).default;
  const tracing = await import("../../app/lib/admin/turn-tracing.server");
  const { cleanupShop, registerHandlers, JOBS } = await import("../../app/lib/jobs/handlers.server");
  const { resetLogRateLimit } = await import("../../app/lib/log.server");

  // ── snapshots of global rows ──────────────────────────────────────────────
  const priorTracing = await db.appSecret.findUnique({ where: { key: TRACING_KEY } });
  const priorRuntime = await db.appSecret.findUnique({ where: { key: RUNTIME_KEY } });
  const priorEnv = { NODE_ENV: process.env.NODE_ENV, ALLOW: process.env.ALLOW_TURN_TRACING };

  // ── sweep leftovers of a killed earlier run (prefix-scoped) ──────────────
  for (const stale of await db.shop.findMany({ where: { domain: { startsWith: "qa-qf-" } }, select: { id: true, domain: true } })) {
    await cleanupShop(stale.domain).catch(() => undefined);
    await db.turnTrace.deleteMany({ where: { shopId: stale.id } });
    await db.appLog.deleteMany({ where: { shopId: stale.id } });
    await db.redactLog.deleteMany({ where: { shopId: stale.id } });
    await db.session.deleteMany({ where: { shop: stale.domain } });
    await db.shop.deleteMany({ where: { id: stale.id } });
  }
  await db.adminUser.deleteMany({ where: { email: { startsWith: "qa-qf-" } } });

  // ── fixtures ──────────────────────────────────────────────────────────────
  const shopA = await db.shop.create({ data: { domain: DOMAIN_A, name: "QA qf A", aiEnabled: false } });
  const shopB = await db.shop.create({ data: { domain: DOMAIN_B, name: "QA qf B", aiEnabled: false } });
  const A = shopA.id;
  const B = shopB.id;
  for (const domain of [DOMAIN_A, DOMAIN_B]) {
    await db.session.create({
      data: { id: `offline_${domain}`, shop: domain, state: "qa", isOnline: false, accessToken: "qa-not-a-token", scope: "read_products" },
    });
  }
  const adminIds: string[] = [];
  const mkAdmin = async (role: "owner" | "admin") => {
    const { hashPassword } = await import("../../app/lib/team/password.server");
    const admin = await db.adminUser.create({
      data: {
        email: `qa-qf-${TS}-${role}@example.invalid`,
        name: `QA qf ${role}`,
        passwordHash: await hashPassword(randomBytes(18).toString("base64url")),
        role,
      },
    });
    adminIds.push(admin.id);
    const raw = randomBytes(32).toString("base64url");
    await db.adminSession.create({
      data: {
        tokenHash: createHash("sha256").update(raw).digest("hex"),
        adminId: admin.id,
        expiresAt: new Date(Date.now() + 3_600_000),
        userAgent: "qa-qf",
      },
    });
    return { admin, cookie: `cc_admin=${raw}` };
  };

  try {
    await c3Debug({ db, tracing, A, B, mkAdmin, resetLogRateLimit });
    await s1AndProxy({ db, tracing, A, B });
    await c4Compliance({ db, A, registerHandlers, JOBS });
    await c5Subscription({ db, A, registerHandlers, JOBS });
    await u1Sync({ db, A, JOBS });
    await p4Install({ db, A });
    await aiFixes({ db, A, B });
    await staticChecks();
    await c1Http();
  } finally {
    // Global rows back, byte-identical.
    for (const [key, prior] of [[TRACING_KEY, priorTracing], [RUNTIME_KEY, priorRuntime]] as const) {
      if (prior) {
        await db.appSecret.upsert({ where: { key }, create: { key, value: prior.value }, update: { value: prior.value } });
      } else {
        await db.appSecret.deleteMany({ where: { key } });
      }
    }
    tracing.resetTurnTracingCache();
    (process.env as any).NODE_ENV = priorEnv.NODE_ENV;
    if (priorEnv.ALLOW === undefined) delete process.env.ALLOW_TURN_TRACING;
    else process.env.ALLOW_TURN_TRACING = priorEnv.ALLOW;

    await sleep(800); // fire-and-forget trace/log writes land before the purge
    for (const domain of [DOMAIN_A, DOMAIN_B]) await cleanupShop(domain).catch(() => undefined);
    await db.turnTrace.deleteMany({ where: { shopId: { in: [A, B] } } });
    await db.appLog.deleteMany({ where: { shopId: { in: [A, B] } } });
    // System-wide Debug audit rows written by this run (their `by` is scrubbed,
    // so they are identified by event + time window + no shop).
    await db.appLog
      .deleteMany({
        where: {
          shopId: null,
          event: { in: ["turn_tracing_started", "turn_tracing_stopped", "turn_trace_list_viewed", "log_rate_capped"] },
          occurredAt: { gte: new Date(TS) },
        },
      })
      .catch(() => undefined);
    await db.redactLog.deleteMany({ where: { shopId: { in: [A, B] } } });
    await db.session.deleteMany({ where: { shop: { in: [DOMAIN_A, DOMAIN_B] } } });
    await db.shop.deleteMany({ where: { id: { in: [A, B] } } });
    await db.adminUser.deleteMany({ where: { id: { in: adminIds } } });
    const leftovers =
      (await db.shop.count({ where: { id: { in: [A, B] } } })) +
      (await db.turnTrace.count({ where: { shopId: { in: [A, B] } } })) +
      (await db.adminUser.count({ where: { email: { startsWith: "qa-qf-" } } }));
    const tracingNow = await db.appSecret.findUnique({ where: { key: TRACING_KEY } });
    const runtimeNow = await db.appSecret.findUnique({ where: { key: RUNTIME_KEY } });
    ok(
      "QF-CLEANUP fixtures removed; tracing + runtime rows restored byte-identical",
      leftovers === 0 &&
        (tracingNow?.value ?? null) === (priorTracing?.value ?? null) &&
        (runtimeNow?.value ?? null) === (priorRuntime?.value ?? null),
      `leftovers=${leftovers}`,
    );
  }
}

// ── QA-C2 / QA-C3: Debug routes, recording controls, access log ─────────────
async function c3Debug(ctx: any): Promise<void> {
  const { db, tracing, A, B, mkAdmin, resetLogRateLimit } = ctx;
  section("QA-C2 / QA-C3 — Debug routes, recording controls, access log");
  const list = await import("../../app/routes/admin.debug._index");
  const detail = await import("../../app/routes/admin.debug.$shopId.$conversationId");
  const owner = await mkAdmin("owner");
  const plain = await mkAdmin("admin");

  const get = (cookie: string, path = "/admin/debug") => new Request(`${BASE}${path}`, { headers: { cookie, "user-agent": UA } });
  const post = (cookie: string, form: Record<string, string | string[]>, origin = ORIGIN) => {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) for (const one of Array.isArray(v) ? v : [v]) body.append(k, one);
    return new Request(`${BASE}/admin/debug`, {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded", "user-agent": UA },
      body: body.toString(),
    });
  };
  const readState = async () => {
    const row = await db.appSecret.findUnique({ where: { key: "admin:turn-tracing" } });
    return row?.value ?? null;
  };

  // Conversations + traces: the SAME conversationId under two stores (QA-S1).
  const convA = await db.conversation.create({ data: { shopId: A, sessionId: `qa-qf-${TS}-dbg-a` } });
  const sharedId = convA.id;
  await db.turnTrace.create({ data: { shopId: A, conversationId: sharedId, shopperText: "A real turn", replyText: "", outcome: "chat", payload: {} } });
  await db.turnTrace.create({ data: { shopId: B, conversationId: sharedId, shopperText: "PLANTED under B", replyText: "", outcome: "chat", payload: {} } });

  // Non-owner: 403 on list, detail and action; nothing changes.
  {
    const before = await readState();
    const l = await call(list.loader, get(plain.cookie));
    const d = await call(detail.loader, get(plain.cookie, `/admin/debug/${A}/${sharedId}`), { shopId: A, conversationId: sharedId });
    const a = await call(list.action, post(plain.cookie, { intent: "start-recording", shopId: A, hours: "1" }));
    const c = await call(list.action, post(plain.cookie, { intent: "clear-recordings" }));
    ok("QF-C3-1 non-owner admin: Debug list loader → 403", l.thrown && l.status === 403, String(l.status));
    ok("QF-C3-2 non-owner admin: Debug detail loader → 403 (no turns returned)", d.thrown && d.status === 403, String(d.status));
    ok(
      "QF-C3-3 non-owner admin: start-recording and clear-recordings actions → 403, state and traces untouched",
      a.status === 403 && c.status === 403 && (await readState()) === before &&
        (await db.turnTrace.count({ where: { conversationId: sharedId } })) === 2,
      `${a.status}/${c.status}`,
    );
  }

  // QA-C2 behavioural: cross-origin owner POST refused; same-origin works.
  {
    const cross = await call(list.action, post(owner.cookie, { intent: "clear-recordings" }, "https://evil.example"));
    ok(
      "QF-C2-1 owner cross-origin POST clear-recordings → ok:false and no trace deleted",
      cross.value?.ok === false && (await db.turnTrace.count({ where: { conversationId: sharedId } })) === 2,
      JSON.stringify(cross.value),
    );
    const crossStart = await call(list.action, post(owner.cookie, { intent: "start-recording", shopId: A, hours: "1" }, "https://evil.example"));
    tracing.resetTurnTracingCache();
    ok(
      "QF-C2-2 owner cross-origin POST start-recording → ok:false and store not recorded",
      crossStart.value?.ok === false && !(await tracing.isTracingShop(A)),
      JSON.stringify(crossStart.value),
    );
  }

  // Start via the real action (same-origin owner).
  {
    resetLogRateLimit();
    const started = await call(list.action, post(owner.cookie, { intent: "start-recording", shopId: A, hours: "4" }));
    tracing.resetTurnTracingCache();
    const state = JSON.parse((await readState()) ?? "{}");
    const hoursLeft = (Date.parse(state.until) - Date.now()) / 3_600_000;
    ok(
      "QF-C3-4 same-origin owner start-recording: allowlist = [A], until ≈ now + 4 h, A recorded and B not",
      started.value?.ok === true && JSON.stringify(state.shopIds) === JSON.stringify([A]) &&
        hoursLeft > 3.9 && hoursLeft <= 4.01 && (await tracing.isTracingShop(A)) && !(await tracing.isTracingShop(B)),
      `ok=${started.value?.ok} shops=${JSON.stringify(state.shopIds)} hours=${hoursLeft.toFixed(3)}`,
    );
    await sleep(1200);
    const log = await db.appLog.findFirst({
      where: { event: "turn_tracing_started", occurredAt: { gte: new Date(Date.now() - 60_000) } },
      orderBy: { occurredAt: "desc" },
    });
    const logCtx = (log?.context ?? {}) as any;
    ok(
      "QF-C3-5 the start is logged with shopIds + until (plan step 4)",
      Boolean(log) && Array.isArray(logCtx.shopIds) && logCtx.shopIds.includes(A) && typeof logCtx.until === "string",
      JSON.stringify(logCtx),
    );
    const bad = await call(list.action, post(owner.cookie, { intent: "start-recording", shopId: A, hours: "7" }));
    tracing.resetTurnTracingCache();
    const badState = JSON.parse((await readState()) ?? "{}");
    const badHours = (Date.parse(badState.until) - Date.now()) / 3_600_000;
    ok(
      "QF-C3-6 an off-menu duration (7 h) falls back to the 4 h default (only 1/4/24 h allowed)",
      bad.value?.ok === true && badHours > 3.9 && badHours <= 4.01,
      `hours=${badHours.toFixed(3)}`,
    );
    await db.shop.update({ where: { id: B }, data: { uninstalledAt: new Date() } });
    const refused = await call(list.action, post(owner.cookie, { intent: "start-recording", shopId: B, hours: "1" }));
    await db.shop.update({ where: { id: B }, data: { uninstalledAt: null } });
    const none = await call(list.action, post(owner.cookie, { intent: "start-recording", hours: "1" }));
    ok(
      "QF-C3-7 start-recording refuses an uninstalled store and an empty store list",
      refused.value?.ok === false && none.value?.ok === false,
      `${refused.value?.error} | ${none.value?.error}`,
    );
    // leave A recording (from the 7 h → 4 h call) for the next checks
    await call(list.action, post(owner.cookie, { intent: "start-recording", shopId: A, hours: "1" }));
  }

  // Detail: store-scoped rows + exactly one access-log row per view.
  {
    resetLogRateLimit();
    const since = new Date();
    const d = await call(detail.loader, get(owner.cookie, `/admin/debug/${A}/${sharedId}`), { shopId: A, conversationId: sharedId });
    const turns = d.value?.turns ?? [];
    ok(
      "QF-S1-3 detail /A/<id> returns only store A's turns and A's domain, never a row planted under B",
      !d.thrown && turns.length === 1 && turns[0].shopperText === "A real turn" && d.value.shopDomain === DOMAIN_A,
      `turns=${turns.map((t: any) => t.shopperText).join("|")} domain=${d.value?.shopDomain}`,
    );
    let rows: any[] = [];
    for (let i = 0; i < 10; i++) {
      await sleep(300);
      rows = await db.appLog.findMany({ where: { event: "turn_trace_viewed", shopId: A, occurredAt: { gte: since } } });
      if (rows.length > 0) break;
    }
    await sleep(500);
    rows = await db.appLog.findMany({ where: { event: "turn_trace_viewed", shopId: A, occurredAt: { gte: since } } });
    const c = (rows[0]?.context ?? {}) as any;
    ok(
      "QF-C3-8 one detail view writes exactly ONE turn_trace_viewed row (shopId, conversationId, turns)",
      rows.length === 1 && rows[0].shopId === A && c.conversationId === sharedId && c.turns === 1,
      `rows=${rows.length} ctx=${JSON.stringify(c)}`,
    );
    ok(
      "QF-C3-9 the access-log row identifies WHO viewed (by = the owner's account, not a redacted placeholder)",
      typeof c.by === "string" && c.by.toLowerCase() === owner.admin.email.toLowerCase(),
      `by=${JSON.stringify(c.by)}`,
    );

    // "every view is logged": 51 views inside one hour
    resetLogRateLimit();
    const burstSince = new Date();
    for (let i = 0; i < 51; i++) {
      await call(detail.loader, get(owner.cookie, `/admin/debug/${A}/${sharedId}`), { shopId: A, conversationId: sharedId });
    }
    let burst = 0;
    for (let i = 0; i < 10; i++) {
      await sleep(400);
      const n = await db.appLog.count({ where: { event: "turn_trace_viewed", shopId: A, occurredAt: { gte: burstSince } } });
      if (n === burst && n > 0) break;
      burst = n;
    }
    ok(
      "QF-C3-10 every detail view is logged — 51 views in an hour write 51 access rows (no rate cap on the audit trail)",
      burst === 51,
      `rows=${burst}`,
    );
    resetLogRateLimit();
  }

  // List: grouped per store.
  {
    const l = await call(list.loader, get(owner.cookie));
    const rows = (l.value?.conversations ?? []).filter((r: any) => r.conversationId === sharedId);
    ok(
      "QF-S1-4 Debug list keeps the same conversationId under two stores as TWO rows (grouped by store)",
      !l.thrown && rows.length === 2 && new Set(rows.map((r: any) => r.shopId)).size === 2,
      `rows=${rows.length}`,
    );
  }

  // "Stop now" written by ANOTHER process is effective within the 5 s cache.
  {
    tracing.resetTurnTracingCache();
    const primed = await tracing.isTracingShop(A);
    await db.appSecret.update({
      where: { key: "admin:turn-tracing" },
      data: { value: JSON.stringify({ shopIds: [], until: null, startedBy: null }) },
    });
    const immediately = await tracing.isTracingShop(A);
    await sleep(5_300);
    const after = await tracing.isTracingShop(A);
    ok(
      "QF-C3-11 a stop written by another process is honoured within ≤5 s (cached read, then fresh)",
      primed && !after,
      `primed=${primed} immediately=${immediately} after5.3s=${after}`,
    );
  }

  // Fail closed on an unreadable state.
  {
    const until = new Date(Date.now() + 3_600_000).toISOString();
    await db.appSecret.update({ where: { key: "admin:turn-tracing" }, data: { value: `{"shopIds":["${A}"],"until":"${until}"` } });
    tracing.resetTurnTracingCache();
    const corrupt = await tracing.isTracingShop(A);
    await db.appSecret.update({ where: { key: "admin:turn-tracing" }, data: { value: JSON.stringify({ shopIds: [A], until: "not-a-date", startedBy: null }) } });
    tracing.resetTurnTracingCache();
    const badDate = await tracing.isTracingShop(A);
    const delegate = db.appSecret as any;
    const original = delegate.findUnique;
    let patched = false;
    let dbDown = true;
    try {
      delegate.findUnique = () => Promise.reject(new Error("qa: database unavailable"));
      patched = (db.appSecret as any).findUnique !== original;
      await db.appSecret.update({ where: { key: "admin:turn-tracing" }, data: { value: JSON.stringify({ shopIds: [A], until, startedBy: null }) } });
      tracing.resetTurnTracingCache();
      dbDown = await tracing.isTracingShop(A);
    } finally {
      delegate.findUnique = original;
    }
    ok("QF-C3-12 fail closed: corrupt JSON state → not recording", !corrupt);
    ok("QF-C3-13 fail closed: unparseable `until` → not recording", !badDate);
    if (patched) ok("QF-C3-14 fail closed: state read throws (DB down) → not recording", !dbDown);
    else skip("QF-C3-14 fail closed on DB error", "Prisma delegate could not be patched in-process");
    await db.appSecret.update({ where: { key: "admin:turn-tracing" }, data: { value: JSON.stringify({ shopIds: [], until: null, startedBy: null }) } });
    tracing.resetTurnTracingCache();
  }

  // Legacy global runtime flag reads OFF.
  {
    const rc = await import("../../app/lib/admin/runtime-config.server");
    const prior = await db.appSecret.findUnique({ where: { key: rc.RUNTIME_SECRET_KEY } });
    const base = prior ? JSON.parse(prior.value) : {};
    await db.appSecret.upsert({
      where: { key: rc.RUNTIME_SECRET_KEY },
      create: { key: rc.RUNTIME_SECRET_KEY, value: JSON.stringify({ ...base, turnTracingEnabled: true }) },
      update: { value: JSON.stringify({ ...base, turnTracingEnabled: true }) },
    });
    try {
      await rc.loadRuntimeConfig();
      tracing.resetTurnTracingCache();
      const stored = rc.storedRuntimeConfig() as any;
      ok(
        "QF-C3-15 legacy runtime `turnTracingEnabled: true` is ignored: no store recorded, key stripped on parse",
        !(await tracing.isTracingShop(A)) && !(await tracing.isTracingShop(B)) && stored.turnTracingEnabled === undefined,
      );
    } finally {
      if (prior) await db.appSecret.update({ where: { key: rc.RUNTIME_SECRET_KEY }, data: { value: prior.value } });
      else await db.appSecret.deleteMany({ where: { key: rc.RUNTIME_SECRET_KEY } });
      await rc.loadRuntimeConfig();
    }
  }

  // stop-recording action works for the owner.
  {
    await call(list.action, post(owner.cookie, { intent: "start-recording", shopId: A, hours: "1" }));
    const stop = await call(list.action, post(owner.cookie, { intent: "stop-recording" }));
    tracing.resetTurnTracingCache();
    ok("QF-C3-16 owner Stop now (same-origin) → recording off at once in this process", stop.value?.ok === true && !(await tracing.isTracingShop(A)));
  }

  // Nav hides Debug for non-owners (not a boundary, but the plan's step 3).
  {
    const shell = src("app/components/admin/AdminShell.tsx");
    const layout = src("app/routes/admin.tsx");
    ok(
      "QF-C3-17 Debug nav item is owner-only and the layout computes isOwner server-side",
      /href: "\/admin\/debug"[^}]*ownerOnly: true/.test(shell) && /!item\.ownerOnly \|\| layout\?\.isOwner/.test(shell) && /isOwner: session \? isOwnerAdmin\(session\)/.test(layout),
    );
    const mig = readdirSync(join(ROOT, "prisma/migrations")).find((d) => d.startsWith("20260914100000_qa_fixes_admin_role_data_request"));
    const sql = mig ? src(`prisma/migrations/${mig}/migration.sql`) : "";
    ok(
      "QF-C3-18 migration adds platform_admins.role (default admin) and backfills the OLDEST admin as owner",
      /"role" TEXT NOT NULL DEFAULT 'admin'/.test(sql) && /SET "role" = 'owner'[\s\S]*ORDER BY "createdAt" ASC LIMIT 1/.test(sql),
    );
  }

  await db.turnTrace.deleteMany({ where: { conversationId: sharedId, shopId: { in: [A, B] } } });
  await db.conversation.deleteMany({ where: { id: sharedId, shopId: A } });
}

// ── QA-C3 end-to-end through the storefront route + QA-S1 ───────────────────
async function s1AndProxy(ctx: any): Promise<void> {
  const { db, tracing, A, B } = ctx;
  section("QA-C3 / QA-S1 — recording through the real /proxy/chat route");
  const route = await import("../../app/routes/proxy.chat");
  const setState = async (value: object) => {
    await db.appSecret.upsert({
      where: { key: "admin:turn-tracing" },
      create: { key: "admin:turn-tracing", value: JSON.stringify(value) },
      update: { value: JSON.stringify(value) },
    });
    tracing.resetTurnTracingCache();
  };
  const turn = async (domain: string, extra: Record<string, unknown> = {}) => {
    const sessionId = `qa-qf-${Math.random().toString(36).slice(2, 12)}`;
    const res = await call(route.action, proxyChatRequest(domain, { sessionId, message: "hello, anyone there?", ...extra }));
    const f = res.value instanceof Response ? await frames(res.value) : [];
    await sleep(700); // trace save is fire-and-forget after the stream
    const done = f.find((x) => x.type === "done");
    return { status: res.status, done, sessionId };
  };
  const count = (shopId: string) => db.turnTrace.count({ where: { shopId } });
  const hour = () => new Date(Date.now() + 3_600_000).toISOString();

  // off → nothing
  await setState({ shopIds: [], until: null, startedBy: null });
  const off = await turn(DOMAIN_A);
  ok(
    "QF-C3-19 recording OFF: a real storefront turn writes no trace",
    off.status === 200 && off.done?.outcome === "human_mode" && (await count(A)) === 0,
    `status=${off.status} outcome=${off.done?.outcome} traces=${await count(A)}`,
  );

  // A allowlisted → only A
  await setState({ shopIds: [A], until: hour(), startedBy: "qa" });
  const a1 = await turn(DOMAIN_A);
  const b1 = await turn(DOMAIN_B);
  const aRows = await db.turnTrace.findMany({ where: { shopId: A } });
  ok(
    "QF-C3-20 allowlisted store A: A's turn is recorded (with its conversation), store B's turn is not",
    aRows.length === 1 && aRows[0].conversationId === a1.done?.conversationId && (await count(B)) === 0 && b1.done?.outcome === "human_mode",
    `A=${aRows.length} B=${await count(B)}`,
  );

  // expired window → nothing new
  await setState({ shopIds: [A], until: new Date(Date.now() - 1000).toISOString(), startedBy: "qa" });
  await turn(DOMAIN_A);
  ok("QF-C3-21 expired `until`: no new trace for the once-allowlisted store", (await count(A)) === 1, `A=${await count(A)}`);

  // production without ALLOW_TURN_TRACING → nothing new, even with an open window
  await setState({ shopIds: [A], until: hour(), startedBy: "qa" });
  const envBefore = { NODE_ENV: process.env.NODE_ENV, ALLOW: process.env.ALLOW_TURN_TRACING };
  (process.env as any).NODE_ENV = "production";
  delete process.env.ALLOW_TURN_TRACING;
  let prodStatus = 0;
  try {
    prodStatus = (await turn(DOMAIN_A)).status;
  } finally {
    (process.env as any).NODE_ENV = envBefore.NODE_ENV;
    if (envBefore.ALLOW === undefined) delete process.env.ALLOW_TURN_TRACING;
    else process.env.ALLOW_TURN_TRACING = envBefore.ALLOW;
  }
  ok("QF-C3-22 NODE_ENV=production without ALLOW_TURN_TRACING: open window, still no trace", prodStatus === 200 && (await count(A)) === 1, `A=${await count(A)}`);
  (process.env as any).NODE_ENV = "production";
  process.env.ALLOW_TURN_TRACING = "true";
  try {
    await turn(DOMAIN_A);
  } finally {
    (process.env as any).NODE_ENV = envBefore.NODE_ENV;
    if (envBefore.ALLOW === undefined) delete process.env.ALLOW_TURN_TRACING;
    else process.env.ALLOW_TURN_TRACING = envBefore.ALLOW;
  }
  ok("QF-C3-23 production WITH ALLOW_TURN_TRACING=true records again (the lock is the env flag)", (await count(A)) === 2, `A=${await count(A)}`);

  // QA-S1: rate-limited turn with a foreign conversationId, recording on
  {
    const foreign = await db.conversation.create({ data: { shopId: B, sessionId: `qa-qf-${TS}-foreign` } });
    const sessionId = `qa-qf-rl-${TS}`;
    (globalThis as any).rateBuckets ??= new Map();
    (globalThis as any).rateBuckets.set(`${A}:${sessionId}`, { tokens: 0, at: Date.now() });
    const res = await call(route.action, proxyChatRequest(DOMAIN_A, { sessionId, conversationId: foreign.id, message: "spam" }));
    const f = res.value instanceof Response ? await frames(res.value) : [];
    (globalThis as any).rateBuckets.delete(`${A}:${sessionId}`);
    await sleep(700);
    const done = f.find((x) => x.type === "done");
    const planted = await db.turnTrace.count({ where: { conversationId: foreign.id } });
    ok(
      "QF-S1-2 storefront rate-limited turn carrying store B's conversationId: done id is \"\" and NO trace lands under that id",
      done?.outcome === "rate_limited" && done?.conversationId === "" && planted === 0,
      `done=${JSON.stringify(done)} planted=${planted}`,
    );
    await db.conversation.deleteMany({ where: { id: foreign.id, shopId: B } });
  }
  const widget = src("extensions/chat-widget/assets/chat-widget.js");
  ok(
    "QF-S1-1 widget keeps its current conversation when a done frame carries an empty id",
    /if \(frame\.conversationId\) \{\s*state\.conversationId = frame\.conversationId;/.test(widget),
  );

  // QA-C4(b): uninstalled shop, conversation still present (day 0–7 grace)
  {
    const { observeTurn, TurnCollector } = await import("../../app/lib/pipeline/turn-capture.server");
    const { createTrace } = await import("../../app/lib/pipeline/trace.server");
    const convo = await db.conversation.create({ data: { shopId: A, sessionId: `qa-qf-${TS}-uninst` } });
    await db.shop.update({ where: { id: A }, data: { uninstalledAt: new Date() } });
    try {
      const gen = (async function* () {
        yield { type: "message", text: "hi" } as any;
        yield { type: "done", outcome: "chat", conversationId: convo.id } as any;
      })();
      for await (const _f of observeTurn({ shopId: A, shopperText: "late", frames: gen, trace: createTrace(true), collector: new TurnCollector() })) {
        // drain
      }
      await sleep(600);
      ok(
        "QF-C4-1 a turn finishing after uninstall (conversation still present) writes no trace",
        (await db.turnTrace.count({ where: { shopId: A, conversationId: convo.id } })) === 0,
      );
    } finally {
      await db.shop.update({ where: { id: A }, data: { uninstalledAt: null } });
      await db.conversation.deleteMany({ where: { id: convo.id, shopId: A } });
    }
  }
  await setState({ shopIds: [], until: null, startedBy: null });
  await db.turnTrace.deleteMany({ where: { shopId: { in: [A, B] } } });
}

// ── QA-C4: data_request identity, phone matching, export exclusion ─────────
async function c4Compliance(ctx: any): Promise<void> {
  const { db, A, registerHandlers, JOBS } = ctx;
  section("QA-C4 — customers/data_request identity + phone matching");
  const compliance = await import("../../app/routes/webhooks.compliance");
  const { buildDataRequestExport } = await import("../../app/lib/compliance/data-request.server");
  const { customerIdForms, contactMatchWhere } = await import("../../app/lib/compliance/customer-match.server");

  const handlers = new Map<string, any>();
  await registerHandlers({
    createQueue: async () => undefined,
    work: async (name: string, a: any, b?: any) => handlers.set(name, typeof a === "function" ? a : b),
    schedule: async () => undefined,
    send: async () => undefined,
  } as never);
  const redact = handlers.get(JOBS.customerRedact);

  const seed = async (label: string, data: Record<string, unknown>) => {
    const contact = await db.contact.create({ data: { shopId: A, type: "customer", name: label, ...data } });
    const convo = await db.conversation.create({ data: { shopId: A, sessionId: `qa-qf-${TS}-${label}`, contactId: contact.id } });
    await db.message.create({ data: { shopId: A, conversationId: convo.id, role: "in", author: "shopper", content: `SECRET-${label}-${TS}` } });
    await db.turnTrace.create({ data: { shopId: A, conversationId: convo.id, shopperText: `TRACEONLY-${label}-${TS}`, payload: {} } });
    return { contact, convo };
  };
  const phone = await seed("phone", { phone: "+15550001111" });
  const idOnly = await seed("idonly", { shopifyCustomerId: "gid://shopify/Customer/777001" });
  const other = await seed("other", { email: `qa-qf-other-${TS}@example.com`, phone: "+15559990000" });

  const deliver = (payload: unknown) => call(compliance.action, webhookRequest("customers/data_request", DOMAIN_A, payload));

  // id-only request stored + deduped
  const r1 = await deliver({ shop_domain: DOMAIN_A, customer: { id: 777001, email: null, phone: null } });
  const r1b = await deliver({ shop_domain: DOMAIN_A, customer: { id: 777001, email: null, phone: null } });
  const idRows = await db.dataRequest.findMany({ where: { shopId: A, shopifyCustomerId: "777001" } });
  ok(
    "QF-C4-2 data_request with only a customer id is stored (id kept) and a redelivery does not duplicate it",
    r1.status === 200 && r1b.status === 200 && idRows.length === 1 && idRows[0].customerEmail === "",
    `rows=${idRows.length}`,
  );
  if (idRows[0]) {
    const exp = JSON.stringify(await buildDataRequestExport(A, idRows[0].id));
    ok("QF-C4-3 id-only export (numeric id vs stored GID) contains that contact's transcript only", exp.includes(`SECRET-idonly-${TS}`) && !exp.includes(`SECRET-other-${TS}`) && !exp.includes(`SECRET-phone-${TS}`));
  }

  // phone-only request
  await deliver({ shop_domain: DOMAIN_A, customer: { phone: "+15550001111" } });
  await deliver({ shop_domain: DOMAIN_A, customer: { phone: "+15550001111" } });
  const phoneRows = await db.dataRequest.findMany({ where: { shopId: A, customerPhone: "+15550001111" } });
  ok("QF-C4-4 phone-only data_request is stored with customerPhone and deduped", phoneRows.length === 1, `rows=${phoneRows.length}`);
  if (phoneRows[0]) {
    const exportData = await buildDataRequestExport(A, phoneRows[0].id);
    const exp = JSON.stringify(exportData);
    ok(
      "QF-C4-5 phone-matched export: exactly the phone contact, its transcript, no other customer",
      exportData.contacts.length === 1 && exp.includes(`SECRET-phone-${TS}`) && !exp.includes(`SECRET-other-${TS}`) && !exp.includes(`SECRET-idonly-${TS}`),
      `contacts=${exportData.contacts.length}`,
    );
    ok("QF-C4-6 export excludes Debug turn recordings (owner decision D-2)", !exp.includes(`TRACEONLY-phone-${TS}`));
  }

  // empty identity → nothing stored
  const beforeEmpty = await db.dataRequest.count({ where: { shopId: A } });
  await deliver({ shop_domain: DOMAIN_A, customer: { email: "", phone: "" } });
  ok("QF-C4-7 data_request with no email, id or phone stores nothing", (await db.dataRequest.count({ where: { shopId: A } })) === beforeEmpty);

  // redact by phone only
  {
    await redact([{ data: { shopDomain: DOMAIN_A, customerPhone: "+15550001111" } }]);
    ok(
      "QF-C4-8 customers/redact by phone erases the phone contact, its messages and its Debug traces",
      (await db.contact.count({ where: { shopId: A, id: phone.contact.id } })) === 0 &&
        (await db.message.count({ where: { shopId: A, conversationId: phone.convo.id } })) === 0 &&
        (await db.turnTrace.count({ where: { shopId: A, conversationId: phone.convo.id } })) === 0,
    );
    ok(
      "QF-C4-9 phone redact leaves other customers intact and scrubs the phone data request",
      (await db.contact.count({ where: { shopId: A, id: { in: [other.contact.id, idOnly.contact.id] } } })) === 2 &&
        (await db.dataRequest.count({ where: { shopId: A, customerPhone: "+15550001111" } })) === 0,
    );
  }

  // full redact payload scrubs every identifier on a matching request
  {
    const email = `qa-qf-full-${TS}@example.com`;
    await db.contact.create({ data: { shopId: A, type: "customer", email } });
    await deliver({ shop_domain: DOMAIN_A, customer: { id: 888002, email, phone: "+15550002222" } });
    await redact([{ data: { shopDomain: DOMAIN_A, customerEmail: email, customerId: "888002", customerPhone: "+15550002222" } }]);
    const leftovers = await db.dataRequest.count({
      where: { shopId: A, OR: [{ customerEmail: email }, { shopifyCustomerId: "888002" }, { customerPhone: "+15550002222" }] },
    });
    ok("QF-C4-10 redact with email+id+phone scrubs email, customer id AND phone from the data request", leftovers === 0, `leftovers=${leftovers}`);
  }

  // CUSTOMERS_REDACT webhook passes the phone to the job
  {
    sent.length = 0;
    const r = await call(compliance.action, webhookRequest("customers/redact", DOMAIN_A, { shop_domain: DOMAIN_A, customer: { id: 1, email: "x@example.com", phone: "+15550003333" } }));
    const job = sent.find((s) => s.name === JOBS.customerRedact);
    ok("QF-C4-11 customers/redact webhook enqueues (only) with email, id AND phone", r.status === 200 && job?.data?.customerPhone === "+15550003333" && job?.data?.customerId === "1", JSON.stringify(job?.data));
  }

  // shared matcher
  ok(
    "QF-C4-12 customerIdForms maps numeric ↔ GID both ways; non-numeric ids stay as-is",
    JSON.stringify(customerIdForms(123)) === JSON.stringify(["123", "gid://shopify/Customer/123"]) &&
      JSON.stringify(customerIdForms("gid://shopify/Customer/123")) === JSON.stringify(["123", "gid://shopify/Customer/123"]) &&
      JSON.stringify(customerIdForms("abc")) === JSON.stringify(["abc"]) && customerIdForms(null).length === 0,
  );
  const where = contactMatchWhere(A, { email: "e@x.com", customerId: "5", phone: "+1" }) as any;
  ok("QF-C4-13 contactMatchWhere is shop-scoped and ORs email / id forms / phone", where?.shopId === A && where.OR.length === 3);
  const handlersSrc = src("app/lib/jobs/handlers.server.ts");
  const exportSrc = src("app/lib/compliance/data-request.server.ts");
  ok(
    "QF-C4-14 redact job AND export both use the one shared contactMatchWhere (no drift)",
    /contactMatchWhere\(shopId,/.test(handlersSrc) && /contactMatchWhere\(shopId,/.test(exportSrc) && !/where:\s*\{\s*shopId,\s*email\s*\}/.test(exportSrc),
  );
}

// ── QA-C5: subscription webhook enqueue-only, serial per shop ──────────────
async function c5Subscription(ctx: any): Promise<void> {
  const { db, A, registerHandlers, JOBS } = ctx;
  section("QA-C5 — app_subscriptions/update enqueue-only + per-shop serial job");
  const route = await import("../../app/routes/webhooks.app-subscriptions");
  sent.length = 0;
  const before = await db.shop.findUnique({ where: { id: A }, select: { plan: true, planStatus: true, subscriptionId: true } });
  const payload = { app_subscription: { admin_graphql_api_id: "gid://shopify/AppSubscription/424242", name: "ChatConvert Pro", status: "ACTIVE" } };
  const started = Date.now();
  const r = await call(route.action, webhookRequest("app_subscriptions/update", DOMAIN_A, payload));
  const ms = Date.now() - started;
  const after = await db.shop.findUnique({ where: { id: A }, select: { plan: true, planStatus: true, subscriptionId: true } });
  const job = sent.find((s) => s.name === JOBS.subscriptionReconcile);
  ok(
    "QF-C5-1 signed webhook → 200, one subscription-reconcile job with shopDomain + payload, grouped by shop domain",
    r.status === 200 && sent.length === 1 && job?.data?.shopDomain === DOMAIN_A && job?.data?.payload?.app_subscription?.status === "ACTIVE" && job?.options?.group?.id === DOMAIN_A,
    `status=${r.status} sent=${sent.length} opts=${JSON.stringify(job?.options)} ${ms}ms`,
  );
  ok("QF-C5-2 the route changes nothing inline (plan/status/subscription untouched until the job runs)", JSON.stringify(before) === JSON.stringify(after));

  const works = new Map<string, { opts: any; fn: any }>();
  await registerHandlers({
    createQueue: async () => undefined,
    work: async (name: string, a: any, b?: any) => works.set(name, typeof a === "function" ? { opts: undefined, fn: a } : { opts: a, fn: b }),
    schedule: async () => undefined,
    send: async () => undefined,
  } as never);
  const reg = works.get(JOBS.subscriptionReconcile);
  ok("QF-C5-3 subscription-reconcile worker registered with groupConcurrency 1 (serial per shop)", reg?.opts?.groupConcurrency === 1, JSON.stringify(reg?.opts));
  let threw = false;
  try {
    await reg?.fn([{ data: { shopDomain: DOMAIN_A, payload: { app_subscription: { admin_graphql_api_id: "gid://shopify/AppSubscription/1", status: "CANCELLED" } } } }]);
  } catch {
    threw = true;
  }
  const afterJob = await db.shop.findUnique({ where: { id: A }, select: { plan: true } });
  ok("QF-C5-4 the registered job body runs reconcileSubscription (CANCELLED for a non-current sub → no downgrade)", Boolean(reg?.fn) && !threw && afterJob?.plan === before?.plan);
  const pgbossTypes = readFileSync(join(ROOT, "node_modules/pg-boss/dist/types.d.ts"), "utf-8");
  ok("QF-C5-5 pg-boss installed version really supports `group` on send and `groupConcurrency` on work", /group\?: GroupOptions/.test(pgbossTypes) && /groupConcurrency\?: number \| GroupConcurrencyConfig/.test(pgbossTypes));
}

// ── QA-U1 / QA-S2: dashboard + Training sync actions ─────────────────────
async function u1Sync(ctx: any): Promise<void> {
  const { db, A, JOBS } = ctx;
  section("QA-U1 / QA-S2 — sync actions (throttle keys, error handling, permission)");
  const { mintToken } = await import("../../app/lib/team/tokens.server");
  let dashboard: any;
  let training: any;
  try {
    dashboard = await import("../../app/routes/app._index");
    training = await import("../../app/routes/app.ai-agent.training");
  } catch (error) {
    skip("QF-U1-*, QF-S2-*", `route modules not importable in-process: ${(error as Error).message.slice(0, 120)}`);
    return;
  }
  const member = async (role: string) => {
    const m = await db.teamMember.create({ data: { shopId: A, email: `qa-qf-${role}-${TS}@example.invalid`, name: role, role, status: "active" } });
    const raw = await mintToken({ shopId: A, memberId: m.id, kind: "session", ttlMs: 3_600_000 });
    return `cc_web_session=${raw}; cc_surface=web`;
  };
  const form = (cookie: string, path: string, fields: Record<string, string>) =>
    new Request(`${BASE}${path}`, {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded", "user-agent": UA },
      body: new URLSearchParams(fields).toString(),
    });
  const owner = await member("owner");
  const admin = await member("admin");
  const agent = await member("agent");
  const expected = [JOBS.catalogSync, JOBS.collectionSync, JOBS.discountSync, JOBS.pageSync, JOBS.articleSync];

  stubQueue.mode = "ok";
  sent.length = 0;
  const first = await call(dashboard.action, form(owner, "/web", { intent: "sync-all" }));
  const keysOk = expected.every((name: string) =>
    sent.some((s) => s.name === name && s.data?.shopDomain === DOMAIN_A && s.options?.singletonKey === `${DOMAIN_A}:${name}` && s.options?.singletonSeconds === 60),
  );
  ok(
    "QF-U1-1 dashboard sync-all queues the five sources once each, every send keyed `${shop}:${job}` for 60 s",
    first.value?.ok === true && typeof first.value?.startedAt === "string" && sent.length === 5 && keysOk,
    `sent=${sent.map((s) => s.name).join(",")}`,
  );
  stubQueue.mode = "null";
  const repeat = await call(dashboard.action, form(owner, "/web", { intent: "sync-all" }));
  ok("QF-U1-2 a throttled repeat (pg-boss returns null) is ok:true with NO startedAt (no fake 'Syncing…')", repeat.value?.ok === true && repeat.value?.startedAt === null, JSON.stringify(repeat.value));
  stubQueue.mode = "throw";
  const broken = await call(dashboard.action, form(owner, "/web", { intent: "sync-all" }));
  ok("QF-U1-3 queue failure → ok:false returned (error toast), never a thrown 500", !broken.thrown && broken.value?.ok === false, `thrown=${broken.thrown} ${JSON.stringify(broken.value)}`);

  stubQueue.mode = "ok";
  sent.length = 0;
  const intents: Array<[string, string]> = [
    ["sync-products", JOBS.catalogSync],
    ["sync-collections", JOBS.collectionSync],
    ["sync-pages", JOBS.pageSync],
    ["sync-blogs", JOBS.articleSync],
    ["sync-discounts", JOBS.discountSync],
  ];
  for (const [intent] of intents) await call(training.action, form(owner, "/web/ai-agent/training", { intent }));
  ok(
    "QF-U1-4 every Training sync button uses the same per-store+job throttle key",
    intents.every(([, job]) => sent.some((s) => s.name === job && s.options?.singletonKey === `${DOMAIN_A}:${job}`)),
    `sent=${sent.map((s) => `${s.name}:${s.options?.singletonKey}`).join(",")}`,
  );
  stubQueue.mode = "throw";
  const tBroken = await call(training.action, form(owner, "/web/ai-agent/training", { intent: "sync-products" }));
  ok("QF-U1-5 Training sync with the queue down → ok:false with an error message, no 500", !tBroken.thrown && tBroken.value?.ok === false && Boolean(tBroken.value?.error), JSON.stringify(tBroken.value));
  stubQueue.mode = "ok";

  sent.length = 0;
  const byAgent = await call(dashboard.action, form(agent, "/web", { intent: "sync-all" }));
  const aiByAgent = await call(dashboard.action, form(agent, "/web", { intent: "enable-ai" }));
  ok(
    "QF-S2-1 agent: dashboard sync-all / enable-ai refused (403) and nothing queued or written",
    byAgent.status === 403 && aiByAgent.status === 403 && sent.length === 0 && (await db.shop.findUnique({ where: { id: A } }))?.aiEnabled === false,
    `${byAgent.status}/${aiByAgent.status} sent=${sent.length}`,
  );
  const byAdmin = await call(dashboard.action, form(admin, "/web", { intent: "sync-all" }));
  ok("QF-S2-2 team admin (has ai_agent): sync-all allowed", byAdmin.value?.ok === true && sent.length === 5, JSON.stringify(byAdmin.value));
  sent.length = 0;
}

// ── QA-P4: existing stores keep their retention ─────────────────────────────
async function p4Install(ctx: any): Promise<void> {
  const { db, A } = ctx;
  section("QA-P4 — 90-day default only for NEW installs");
  const { onShopAuthenticated, NEW_INSTALL_RETENTION_DAYS } = await import("../../app/lib/install.server");
  const { shopSettingsSchema } = await import("../../app/lib/settings/schemas");
  const settings = JSON.parse(JSON.stringify(shopSettingsSchema.parse({ retentionDays: 0 })));
  await db.shopSettings.upsert({ where: { shopId: A }, create: { shopId: A, settings }, update: { settings } });
  const before = JSON.stringify((await db.shopSettings.findUnique({ where: { shopId: A } }))?.settings);
  sent.length = 0;
  await onShopAuthenticated(DOMAIN_A);
  const after = JSON.stringify((await db.shopSettings.findUnique({ where: { shopId: A } }))?.settings);
  ok("QF-P4-1 re-auth of an existing store on 'Keep forever' (retentionDays 0) leaves its settings byte-identical", before === after && NEW_INSTALL_RETENTION_DAYS === 90, `${before === after}`);
  await db.shop.update({ where: { id: A }, data: { uninstalledAt: new Date() } });
  await onShopAuthenticated(DOMAIN_A);
  const reinstalled = JSON.stringify((await db.shopSettings.findUnique({ where: { shopId: A } }))?.settings);
  ok("QF-P4-2 reinstall inside the grace window keeps the stored retention choice", reinstalled === before);
  await db.shop.update({ where: { id: A }, data: { uninstalledAt: null, aiEnabled: false } });
  sent.length = 0;
}

// ── QA-A3…A6 deterministic parts + QA-U5 ───────────────────────────────────
async function aiFixes(ctx: any): Promise<void> {
  const { db, A, B } = ctx;
  section("QA-A3…A6 — deterministic parts of the tuning event");
  const { namedProductsForAvailability } = await import("../../app/lib/pipeline/detail.server");
  const mk = (shopId: string, title: string, data: Record<string, unknown> = {}) =>
    db.product.create({ data: { shopId, shopifyProductId: `gid://shopify/Product/${Math.floor(Math.random() * 1e12)}`, title, handle: title.toLowerCase().replace(/\s+/g, "-"), stock: 0, ...data } });
  await mk(A, "Mulberry Silk Pillowcase");
  await mk(A, "Draft Moon Lamp", { status: "draft" });
  await mk(A, "Hidden Star Mug", { publishedOnline: false });
  await mk(A, "Quiet Owl Print", { learnEnabled: false });
  await mk(B, "Cobalt Glass Vase");
  const named = await namedProductsForAvailability(A, "is the Mulberry Silk Pillowcase in stock?");
  ok("QF-A4-1 availability words + a showable product's full title → that product (for the detail lane)", named?.length === 1 && named[0].title === "Mulberry Silk Pillowcase", JSON.stringify(named?.map((p: any) => p.title)));
  ok("QF-A4-2 the same title with no availability words → no diversion", (await namedProductsForAvailability(A, "tell me about the Mulberry Silk Pillowcase")) === null);
  ok(
    "QF-A4-3 draft, unpublished and learn-off products are never 'named' (SHOWABLE_PRODUCT)",
    (await namedProductsForAvailability(A, "is the Draft Moon Lamp in stock?")) === null &&
      (await namedProductsForAvailability(A, "is the Hidden Star Mug available?")) === null &&
      (await namedProductsForAvailability(A, "is the Quiet Owl Print sold out?")) === null,
  );
  ok("QF-A4-4 another store's product title is not found for this store (tenancy)", (await namedProductsForAvailability(A, "is the Cobalt Glass Vase in stock?")) === null);

  const indexSrc = src("app/lib/pipeline/index.server.ts");
  const reMatch = indexSrc.match(/const ORDER_STATUS_RE =\s*\/(.+)\/([a-z]*);/);
  if (!reMatch) {
    ok("QF-A5-1 ORDER_STATUS_RE found in index.server.ts", false);
  } else {
    const re = new RegExp(reMatch[1], reMatch[2]);
    const hits = ["where is my order #1234?", "where's my package", "can you track my order", "order status please", "has my order shipped?", "order #10045"];
    ok("QF-A5-1 order-status phrasing is recognised", hits.every((m) => re.test(m)), hits.filter((m) => !re.test(m)).join(" | "));
    const misses = ["can I order 100 bracelets for my shop?", "I'd like to order 250 pieces wholesale", "what order should I wear these in?", "do you take custom orders?"];
    ok(
      "QF-A5-2 buying/wholesale questions are NOT treated as order status (no Track-order hijack)",
      misses.every((m) => !re.test(m)),
      `false positives: ${misses.filter((m) => re.test(m)).join(" | ")}`,
    );
  }
  ok(
    "QF-A5-3 a curated answer at the SERVE threshold still wins over the order-status shortcut; tracking must be effective",
    /orderActions\.length > 0 &&\s*ORDER_STATUS_RE\.test\(message\) &&\s*!\(curated && curated\.score >= curatedThreshold\)/.test(indexSrc),
  );

  const { canned } = await import("../../app/lib/pipeline/canned.server");
  const langs = ["en", "hi", "es", "fr", "de"];
  const emailWords = /e-?mail|correo|ईमेल/i;
  ok(
    "QF-A6-1 blocked-topic reply asks for no email in any of the 5 languages",
    langs.every((l) => !emailWords.test(canned("blockedTopic", { defaultLanguage: l, autoDetectLanguage: false }))),
  );
  {
    const { runPipeline } = await import("../../app/lib/pipeline/index.server");
    const f: any[] = [];
    for await (const frame of runPipeline({ shopId: A, sessionId: `test-qa-qf-cap-${TS}`, message: "hello", isTest: true })) f.push(frame);
    const text = f.filter((x) => x.type === "message" || x.type === "token").map((x) => x.text).join("");
    const done = f.find((x) => x.type === "done");
    const asksEmail = emailWords.test(text);
    const hasForm = f.some((x) => x.type === "handover");
    ok(
      "QF-A6-2 AI-unavailable (cap / AI off in Test AI) reply never asks for an email unless a form is attached",
      done?.outcome === "ai_unavailable" && (!asksEmail || hasForm),
      `outcome=${done?.outcome} text="${text}" form=${hasForm}`,
    );
  }

  const prompts = src("app/lib/pipeline/prompts.ts");
  ok(
    "QF-A3-1 ROUTER marks creative / general-assistant tasks off_topic; the pipeline honours it only with a store scope",
    /Creative writing \(poems, stories/.test(prompts) && /routed\.off_topic && scopeConfigured/.test(indexSrc) && /scopeConfigured = Boolean\(config\.persona\?\.scope\?\.trim\(\)\)/.test(indexSrc),
  );
  {
    const { saveGeneralInstructions } = await import("../../app/lib/instructions/save.server");
    const base = { role: "QA", communicationStyle: "friendly", brandVoice: "", behaviours: "", defaultLanguage: "en", autoDetectLanguage: false, bannedTopics: [], fallbackMessage: "" };
    await saveGeneralInstructions(A, { ...base, scope: "  crystal jewellery  ", offTopicMessage: " Only crystals here. " });
    const p1 = await db.persona.findUnique({ where: { shopId: A } });
    await saveGeneralInstructions(A, base);
    const p2 = await db.persona.findUnique({ where: { shopId: A } });
    ok(
      "QF-A3-2 Instructions → General saves Store scope + Off-topic message (trimmed); a save without them keeps them",
      p1?.scope === "crystal jewellery" && p1?.offTopicMessage === "Only crystals here." && p2?.scope === "crystal jewellery" && p2?.offTopicMessage === "Only crystals here.",
      `${p1?.scope}|${p1?.offTopicMessage}|${p2?.scope}`,
    );
    const tab = src("app/components/InstructionsGeneralTab.tsx");
    ok("QF-A3-3 the General tab renders Store scope + Off-topic message fields", /Store scope/.test(tab) && /Off-topic message/.test(tab));
  }

  const golden = src("scripts/eval-golden.ts");
  ok(
    "QF-GOLD-1 golden has every plan case: poem→off_topic, hi→chat, Mulberry→detail+no alternatives, order→track_order, anxiety→no email, black bracelets text grounding, A2 head-warmer follow-up",
    /"write me a poem about the ocean", expectOutcome: \["off_topic"\]/.test(golden) &&
      /input: "hi", expectOutcome: \["chat"\]/.test(golden) &&
      /Mulberry Silk Pillowcase in stock\?",\s*expectOutcome: \["detail"\],[\s\S]{0,200}rejectInText/.test(golden) &&
      /"where is my order #1234\?", expectOutcome: \["order_status"\], expectAction: "track_order"/.test(golden) &&
      /cure my anxiety\?",\s*expectOutcome: \["blocked"\],\s*rejectInText: \/email\/i/.test(golden) &&
      /"show me black bracelets"[^\n]*groundedText: true/.test(golden) &&
      /something warm for my head under \$20/.test(golden),
  );
}

// ── static/source checks: U5, U6, P1–P3, T3, policy ────────────────────────
async function staticChecks(): Promise<void> {
  section("QA-U5 / QA-U6 / QA-P1…P3 / policy — source + config checks");
  const testChat = src("app/routes/api.test-chat.tsx");
  ok("QF-U5-1 /api/test-chat builds no trace and streams the pipeline frames only", !/createTrace|withTrace|type: "trace"/.test(testChat) && /sseResponse\(frames, request\.signal\)/.test(testChat));
  const yielders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.(ts|tsx)$/.test(entry.name) && /yield \{ type: "trace"/.test(src(rel))) yielders.push(rel);
    }
  };
  walk("app");
  ok("QF-U5-2 nothing in app/ yields a trace frame any more", yielders.length === 0, yielders.join(", "));
  const handlers = src("app/lib/jobs/handlers.server.ts");
  const retention = handlers.slice(handlers.indexOf("await purgeTurnTraces().catch"), handlers.indexOf("JOBS.uninstallPurge") > 0 ? handlers.indexOf("JOBS.uninstallPurge") : undefined);
  ok("QF-U6-1 retention loop has no per-shop trace cutoff by retentionDays (dead branch removed)", !/turnTrace\.deleteMany\(\{\s*where:\s*\{\s*shopId: row\.shopId,\s*createdAt/.test(retention));

  const size = gzipSync(readFileSync(join(ROOT, "extensions/chat-widget/assets/chat-widget.js"))).length;
  const sizeScript = src("scripts/check-widget-size.ts");
  ok("QF-P1-1 widget size script warns above 27 KB; chat-widget.js is under the 30 KB budget", /WARN_BYTES = 27 \* 1024/.test(sizeScript) && size <= 30 * 1024, `${(size / 1024).toFixed(2)} KB gzip`);
  const audit = src("scripts/qa/APP-STORE-REVIEW.md");
  const quoted = [...audit.matchAll(/chat-widget\.js \*\*(\d+\.\d+) KB gzip\*\*/g)].map((m) => Number(m[1]));
  ok(
    "QF-P1-2 APP-STORE-REVIEW quotes the current widget size (within 0.5 KB of the measured gzip)",
    quoted.length > 0 && quoted.every((kb) => Math.abs(kb - size / 1024) <= 0.5),
    `doc=${quoted.join(",")} measured=${(size / 1024).toFixed(2)}`,
  );

  const scopesOf = (text: string) => (text.match(/^scopes\s*=\s*"([^"]*)"/m)?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean).sort();
  const prod = src("shopify.app.toml");
  let devToml = "";
  try {
    devToml = src("shopify.app.dev.toml");
  } catch {
    /* gitignored, may be absent */
  }
  const prodScopes = scopesOf(prod);
  ok("QF-P2-1 shopify.app.toml: read_online_store_pages removed, read_content kept (Page/Blog/Article accept either — shopify.dev 2026-07)", !prodScopes.includes("read_online_store_pages") && prodScopes.includes("read_content"), prodScopes.join(","));
  ok("QF-P2-2 no empty `[events] api_version = \"unstable\"` block", !/\[events\][\s\S]{0,40}unstable/.test(prod));
  if (devToml) ok("QF-P2-3 shopify.app.dev.toml requests the same scopes", JSON.stringify(scopesOf(devToml)) === JSON.stringify(prodScopes), scopesOf(devToml).join(","));
  else skip("QF-P2-3 dev toml scopes", "shopify.app.dev.toml not present");
  ok("QF-P2-4 every requested scope has a one-line justification above [access_scopes]", prodScopes.every((s) => new RegExp(`^#\\s+${s}\\s`, "m").test(prod)), prodScopes.filter((s) => !new RegExp(`^#\\s+${s}\\s`, "m").test(prod)).join(","));
  const deployment = src("DEPLOYMENT.md");
  const deployScopes = (deployment.match(/^SCOPES=(.*)$/m)?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean).sort();
  ok(
    "QF-P2-5 DEPLOYMENT.md production SCOPES matches shopify.app.toml verbatim (its own rule; app/shopify.server reads SCOPES)",
    JSON.stringify(deployScopes) === JSON.stringify(prodScopes),
    `docs=${deployScopes.join(",")} toml=${prodScopes.join(",")}`,
  );
  const scopeUsers = ["app/lib/ingestion/fetchers.server.ts", "app/lib/ingestion/content-sync.server.ts", "app/lib/ingestion/sources.server.ts"]
    .map((f) => { try { return src(f); } catch { return ""; } })
    .join("\n");
  ok("QF-P2-6 no app code queries online-store navigation/menus (would need another online-store scope)", !/\bmenus?\s*\(|onlineStore\s*\{|urlRedirects/.test(scopeUsers));

  const p3Files = ["app/routes/app.curated-answers.tsx", "app/components/AnalyticsTopQuestions.tsx", "app/components/ProactiveTemplatePicker.tsx"];
  ok(
    "QF-P3-1 internal plan-usage links use react-router Link, not <s-link href=\"/app/…\">",
    p3Files.every((f) => !/<s-link[^>]*href="\/app\//.test(src(f)) && /import[^;]*\bLink\b[^;]*from "react-router"/.test(src(f))),
    p3Files.filter((f) => /<s-link[^>]*href="\/app\//.test(src(f))).join(","),
  );
  const entry = src("app/entry.server.tsx");
  ok("QF-P3-2 entry.server sets nosniff, frame-deny for /admin, no-store for /app", /nosniff/i.test(entry) && /frame-ancestors 'none'|DENY/.test(entry) && /no-store/.test(entry));

  const policy = src("docs/privacy-policy-page.html");
  ok(
    "QF-D-1 privacy policy draft: 90-day default for new installs, diagnostic recordings ≤7 days + excluded from data requests, per-store owner-only logged access",
    /90 days/.test(policy) && /Diagnostic recordings/.test(policy) && /7 days/.test(policy) && /one named store/.test(policy) && /customers\/data_request/.test(policy),
  );
}

// ── QA-C1 over HTTP ─────────────────────────────────────────────────────────
async function c1Http(): Promise<void> {
  section("QA-C1 — no shop-domain entry anywhere (HTTP + loader)");
  const login = await import("../../app/routes/auth.login");
  const direct = await call(login.loader, new Request(`${BASE}/auth/login`));
  ok("QF-C1-1 /auth/login loader without ?shop= redirects to / (never calls login() to render a form)", direct.status === 302 && direct.value.headers.get("location") === "/", `${direct.status} ${direct.value?.headers?.get?.("location")}`);
  ok("QF-C1-2 auth.login exports no action and _index exports no action", !("action" in login) && !/export const action/.test(src("app/routes/_index/route.tsx")));

  const up = await waitForServer(`${BASE}/web/login`, { headers: { "user-agent": UA }, tries: 3 });
  if (!up.ok) {
    for (const id of ["QF-C1-3", "QF-C1-4", "QF-C1-5", "QF-C1-6"]) skip(id, `dev server unreachable at ${BASE} (${up.error})`);
    return;
  }
  const req = async (path: string, init: RequestInit = {}) => {
    const res = await qaFetch(BASE + path, { redirect: "manual", ...init, headers: { "user-agent": UA, ...(init.headers as any) } });
    return { status: res.status, location: res.headers.get("location") ?? "", body: await res.text() };
  };
  const home = await req("/");
  ok(
    "QF-C1-3 GET / has no text input, no myshopify placeholder and no 'Shop domain' label",
    home.status === 200 && !/<input/i.test(home.body) && !/placeholder="[^"]*myshopify/i.test(home.body) && !/Shop domain/i.test(home.body),
    String(home.status),
  );
  const formHeaders = { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN };
  const postHome = await req("/", { method: "POST", headers: formHeaders, body: "shop=qa-attacker.myshopify.com" });
  ok(
    "QF-C1-4 POST / with shop=… does not start an install (no redirect to Shopify, no form re-render)",
    !/oauth|admin\.shopify\.com|myshopify\.com\/admin/.test(postHome.location) && !/name="shop"/.test(postHome.body) && postHome.status !== 302,
    `${postHome.status} ${postHome.location}`,
  );
  const postLogin = await req("/auth/login", { method: "POST", headers: formHeaders, body: "shop=qa-attacker.myshopify.com" });
  ok(
    "QF-C1-5 POST /auth/login with shop=… is refused (405/4xx), no install redirect, no form",
    postLogin.status >= 400 && postLogin.status < 500 && !/oauth/.test(postLogin.location) && !/name="shop"/.test(postLogin.body),
    `${postLogin.status} ${postLogin.location}`,
  );
  const getLogin = await req("/auth/login");
  ok("QF-C1-6 GET /auth/login without ?shop= → 302 to /", getLogin.status === 302 && /^(\/|http:\/\/localhost:3000\/)$/.test(getLogin.location), `${getLogin.status} ${getLogin.location}`);
}

main()
  .catch((error) => {
    failed++;
    failures.push(`crash: ${error?.stack ?? error}`);
    console.error(error);
  })
  .finally(async () => {
    console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
    if (failures.length) console.log(`\nFailures:\n  - ${failures.join("\n  - ")}`);
    const db = (await import("../../app/db.server")).default;
    await db.$disconnect();
    process.exit(failed ? 1 : 0);
  });
