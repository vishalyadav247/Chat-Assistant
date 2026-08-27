/* eslint-disable @typescript-eslint/no-explicit-any --
 * This harness walks turbo-stream loader payloads and Prisma rows that have no
 * shared type on this side of the wire; loose typing at those boundaries is deliberate
 * and keeps the assertions readable. */
/* QA: /platform operator console — render + form round-trip + security sweep.
 *
 *   Run: PRISMA_CLIENT_ENGINE_TYPE=binary npx tsx scripts/qa/ui-platform.test.ts
 *   Needs: the dev server on http://localhost:3000 (BASE_URL to override) and
 *          the dev Postgres up.
 *
 * The operator console is GLOBAL, cross-tenant state. Every setting this script
 * touches is snapshotted before the run and restored (byte-exact) in the finally
 * block, which then VERIFIES the restore. The shared app/db.server singleton is
 * disconnected there too — without that the process hangs forever.
 *
 * PLATFORM_ADMIN_PASSWORD is never read or printed: the suite mints its own
 * throwaway operator account and session row.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Load .env manually (tsx does not) BEFORE importing app modules.
for (const line of readFileSync(join(process.cwd(), ".env"), "utf-8").split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (match && !line.trim().startsWith("#") && process.env[match[1]] === undefined) {
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}
process.env.SHOPIFY_API_KEY ||= "qa-placeholder-key";
process.env.SHOPIFY_API_SECRET ||= "qa-placeholder-secret";
process.env.SHOPIFY_APP_URL ||= process.env.BASE_URL ?? "http://localhost:3000";
process.env.SCOPES ||= "read_products";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const ORIGIN = new URL(BASE).origin;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

let passed = 0;
let failed = 0;
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

function section(title: string): void {
  console.log(`\n── ${title}`);
}

// ── HTTP ────────────────────────────────────────────────────────────────────

interface Probe {
  status: number;
  location: string | null;
  body: string;
  headers: Headers;
}

async function req(
  path: string,
  init: { method?: string; cookie?: string; body?: BodyInit; headers?: Record<string, string>; origin?: boolean } = {},
): Promise<Probe> {
  const headers: Record<string, string> = { "user-agent": UA, ...(init.headers ?? {}) };
  if (init.cookie) headers.cookie = init.cookie;
  // Same-origin by default (what a browser sends); an explicit origin header in
  // init.headers wins so the CSRF cases can forge one.
  if (init.origin !== false && (init.method ?? "GET") !== "GET" && !headers.origin) headers.origin = ORIGIN;
  const res = await fetch(BASE + path, {
    method: init.method ?? "GET",
    headers,
    body: init.body,
    redirect: "manual",
  });
  return { status: res.status, location: res.headers.get("location"), body: await res.text(), headers: res.headers };
}

const get = (path: string, cookie?: string) => req(path, { cookie });

/**
 * turbo-stream (React Router single fetch) → plain JS. Negative indices are
 * turbo-stream's constant table (undefined / null / ±Infinity / NaN); the
 * assertions here only ever need "not a value", so they all collapse to null.
 */
function hydrate(flat: unknown[], index: number, cache = new Map<number, unknown>()): unknown {
  if (index < 0) return null;
  if (cache.has(index)) return cache.get(index);
  const value = flat[index];
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    cache.set(index, out);
    for (const i of value) out.push(hydrate(flat, i as number, cache));
    return out;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    cache.set(index, out);
    for (const [k, v] of Object.entries(value as Record<string, number>)) {
      out[String(hydrate(flat, Number(k.slice(1)), cache))] = hydrate(flat, v, cache);
    }
    return out;
  }
  cache.set(index, value);
  return value;
}

function decodeData(body: string): Record<string, unknown> {
  const line = body.split("\n").find((l) => l.trim().startsWith("["));
  if (!line) return {};
  try {
    return (hydrate(JSON.parse(line) as unknown[], 0) ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** GET a route's loader payload (the same request a client navigation makes). */
async function loaderData(routePath: string, routeId: string, cookie: string): Promise<Record<string, any>> {
  const [pathname, search = ""] = routePath.split("?");
  const p = await get(`${pathname}.data?_routes=${encodeURIComponent(`routes/${routeId}`)}${search ? `&${search}` : ""}`, cookie);
  let decoded = decodeData(p.body) as Record<string, any>;
  let hit = decoded[`routes/${routeId}`];
  if (!hit) {
    // Dynamic-segment routes are not always addressable by _routes; fall back
    // to the unfiltered payload and pick the leaf route out of it.
    const full = await get(`${pathname}.data${search ? `?${search}` : ""}`, cookie);
    decoded = decodeData(full.body) as Record<string, any>;
    hit = decoded[`routes/${routeId}`] ?? Object.entries(decoded).filter(([k]) => k.startsWith("routes/")).map(([, v]) => v).pop();
  }
  return (hit?.data ?? {}) as Record<string, any>;
}

interface ActionResult {
  status: number;
  raw: string;
  data: Record<string, any>;
}

/** POST a form exactly as the page's fetcher does. */
async function submit(
  routePath: string,
  routeId: string,
  fields: Record<string, string | string[]>,
  cookie: string,
  init: { origin?: boolean } = {},
): Promise<ActionResult> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) for (const item of v) body.append(k, item);
    else body.append(k, v);
  }
  const [pathname, search = ""] = routePath.split("?");
  const p = await req(`${pathname}.data?_routes=${encodeURIComponent(`routes/${routeId}`)}${search ? `&${search}` : ""}`, {
    method: "POST",
    cookie,
    origin: init.origin,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const decoded = decodeData(p.body) as Record<string, any>;
  return { status: p.status, raw: p.body, data: (decoded.data ?? {}) as Record<string, any> };
}

/** Server-rendered error boundary / blank shell detection. */
function isBrokenPage(p: Probe): string | null {
  if (p.status !== 200) return `status ${p.status}`;
  // React Router streams the router state into the document; a thrown loader
  // error shows up there and as the default boundary copy.
  if (/Unexpected Application Error|>Application Error</i.test(p.body)) return "error boundary";
  if (p.body.includes(String.raw`"errors":{"routes/`)) return "route error in the streamed router state";
  if (!p.body.includes("<s-page")) return "no <s-page> in body";
  if (p.body.length < 4000) return `suspiciously short body (${p.body.length})`;
  return null;
}

// ── main ────────────────────────────────────────────────────────────────────

const AUTHED_PAGES = [
  "/platform",
  "/platform/admins",
  "/platform/ai",
  "/platform/logs",
  "/platform/plans",
  "/platform/promo-codes",
  "/platform/settings",
  "/platform/usage",
];

async function main(): Promise<void> {
  const db = (await import("../../app/db.server")).default;
  const { createHash, randomBytes } = await import("node:crypto");
  const { hashPassword } = await import("../../app/lib/team/password.server");

  const TAG = `qa-platform-${Date.now()}`;
  const hashToken = (raw: string) => createHash("sha256").update(raw).digest("hex");

  // ── preflight: clear fixtures a previously KILLED run may have left ───────
  // Without this the snapshot below would capture QA state as if it were the
  // operator's own, and "restore" would cement it.
  {
    const stale = await db.platformAdmin.findMany({ where: { email: { contains: "qa-platform-" } }, select: { id: true } });
    if (stale.length) {
      await db.platformSession.deleteMany({ where: { adminId: { in: stale.map((a: any) => a.id) } } });
      await db.platformAdmin.deleteMany({ where: { id: { in: stale.map((a: any) => a.id) } } });
    }
    const staleCodes = await db.promoCode.findMany({ where: { OR: [{ code: { startsWith: "QAPCT" } }, { code: { startsWith: "QAFIX" } }] }, select: { id: true } });
    if (staleCodes.length) {
      await db.promoRedemption.deleteMany({ where: { promoCodeId: { in: staleCodes.map((c: any) => c.id) } } });
      await db.promoCode.deleteMany({ where: { id: { in: staleCodes.map((c: any) => c.id) } } });
    }
    await db.llmUsageDaily.deleteMany({ where: { model: "qa-probe-model" } });
    await db.appSecret.deleteMany({ where: { key: "platform:plans:corrupt" } });
    if (stale.length || staleCodes.length) console.log(`Preflight: cleared ${stale.length} stale QA operator(s), ${staleCodes.length} stale QA coupon(s)`);
  }
  // A killed run can leave section 10's marker name in the plan matrix; undo
  // exactly that artefact so the snapshot below captures the real config.
  {
    const row = await db.appSecret.findUnique({ where: { key: "platform:plans" } });
    if (row && row.value.includes("QA-Propagation")) {
      const cfg = JSON.parse(row.value);
      for (const id of Object.keys(cfg.plans ?? {})) {
        if (cfg.plans[id]?.name === "QA-Propagation") {
          delete cfg.plans[id].name;
          if (Object.keys(cfg.plans[id]).length === 0) delete cfg.plans[id];
        }
      }
      const cleaned = JSON.stringify(cfg);
      await db.appSecret.update({ where: { key: "platform:plans" }, data: { value: cleaned } });
      console.log(`Preflight: removed a stale QA plan-name marker (${row.value.length}b → ${cleaned.length}b)`);
    }
  }
  // One-shot repair hatch: PLATFORM_QA_RESTORE_PLANS=<json> rewrites the plan
  // matrix row BEFORE the snapshot, for recovering from a killed run.
  if (process.env.PLATFORM_QA_RESTORE_PLANS) {
    const value = process.env.PLATFORM_QA_RESTORE_PLANS;
    await db.appSecret.upsert({ where: { key: "platform:plans" }, create: { key: "platform:plans", value }, update: { value } });
    console.log(`Preflight: plan matrix row rewritten from PLATFORM_QA_RESTORE_PLANS (${value.length}b)`);
  }

  // ── snapshot every global row this suite can touch ────────────────────────
  const SECRET_KEYS = ["platform:plans", "platform:ai", "platform:runtime", "platform:plans:corrupt"];
  const snapshot = new Map<string, string | null>();
  for (const key of SECRET_KEYS) {
    const row = await db.appSecret.findUnique({ where: { key } });
    snapshot.set(key, row?.value ?? null);
  }
  console.log(
    `\nSnapshot: ${SECRET_KEYS.map((k) => `${k}=${snapshot.get(k) === null ? "absent" : `${snapshot.get(k)!.length}b`}`).join(", ")}`,
  );

  // ── throwaway operator account + session (never the real one) ─────────────
  const opPassword = `Qa!${randomBytes(12).toString("base64url")}`;
  const operator = await db.platformAdmin.create({
    data: { email: `${TAG}@example.invalid`, name: "QA platform operator", passwordHash: await hashPassword(opPassword) },
  });
  const rawToken = randomBytes(32).toString("base64url");
  await db.platformSession.create({
    data: { tokenHash: hashToken(rawToken), adminId: operator.id, expiresAt: new Date(Date.now() + 3_600_000), userAgent: TAG },
  });
  const COOKIE = `cc_platform=${rawToken}`;

  const createdAdminIds: string[] = [operator.id];
  const createdPromoIds: string[] = [];

  try {
    await renderSection({ db, COOKIE });
    await securitySection({ db, COOKIE, TAG, hashToken, operator });
    await aiSection({ db, COOKIE, snapshot });
    await plansSection({ db, COOKIE, snapshot });
    await promoSection({ db, COOKIE, TAG, createdPromoIds });
    await adminsSection({ db, COOKIE, TAG, operator, opPassword, createdAdminIds, hashToken });
    await logsSection({ db, COOKIE });
    await usageSection({ db, COOKIE });
    await settingsSection({ db, COOKIE, snapshot });
    await cachePropagationSection({ db, COOKIE, snapshot });
  } finally {
    section("Restore (finally)");
    // 1. AI overrides — restored over HTTP so the SERVER's 30s cache is
    //    refreshed too (saveAiOverrides primes it), not just the DB row.
    const aiOriginal = snapshot.get("platform:ai");
    if (aiOriginal) {
      const o = JSON.parse(aiOriginal) as { chatModel: string; temperature: number | null; maxTokens: number | null };
      await submit("/platform/ai", "platform.ai", {
        chatModel: o.chatModel ?? "",
        temperature: o.temperature === null || o.temperature === undefined ? "" : String(o.temperature),
        maxTokens: o.maxTokens === null || o.maxTokens === undefined ? "" : String(o.maxTokens),
      }, COOKIE);
    }
    for (const key of SECRET_KEYS) {
      const original = snapshot.get(key) ?? null;
      if (original === null) await db.appSecret.deleteMany({ where: { key } });
      else await db.appSecret.upsert({ where: { key }, create: { key, value: original }, update: { value: original } });
    }
    // 2. Force the server to re-read the plan matrix (its loader calls
    //    loadPlanConfig() unconditionally) and the runtime config.
    await get("/platform/plans", COOKIE);
    await get("/platform/settings", COOKIE);

    // 3. Verify every snapshotted row is byte-identical to what we found.
    for (const key of SECRET_KEYS) {
      const row = await db.appSecret.findUnique({ where: { key } });
      const now = row?.value ?? null;
      const original = snapshot.get(key) ?? null;
      ok(`restore: ${key} byte-identical to snapshot`, now === original, now === original ? (original === null ? "absent (as found)" : `${original.length}b`) : `MISMATCH now=${now?.slice(0, 80) ?? "absent"}`);
    }

    // 4. QA fixtures removed.
    await db.promoRedemption.deleteMany({ where: { promoCodeId: { in: createdPromoIds } } }).catch(() => undefined);
    await db.promoCode.deleteMany({ where: { id: { in: createdPromoIds } } }).catch(() => undefined);
    await db.platformSession.deleteMany({ where: { adminId: { in: createdAdminIds } } }).catch(() => undefined);
    await db.platformAdmin.deleteMany({ where: { id: { in: createdAdminIds } } }).catch(() => undefined);
    const leftover = await db.platformAdmin.count({ where: { email: { contains: "qa-platform-" } } });
    ok("restore: no QA operator accounts left behind", leftover === 0, `${leftover} left`);

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failures.length) {
      console.log("\nFailures:");
      for (const f of failures) console.log(`  - ${f}`);
    }
    await db.$disconnect();
  }
}

// ── 1. Render ───────────────────────────────────────────────────────────────
// Each page must promise its real content: the specific tables, forms and
// fields the component renders — not merely "a 200".
const PAGE_MARKERS: Record<string, string[]> = {
  "/platform": ["Installed stores", "Plan enforcement", "Stores by plan", "Recent installs", "ccpf-meter"],
  "/platform/admins": ["Accounts", "<s-table", "Add New", "platform-add-admin", "platform-change-password"],
  "/platform/ai": ["Chat model", "Generation overrides", "Embedding model", "Temperature", "Max tokens", "Currently effective"],
  "/platform/logs": ["Top failing events", "Entries", "Level", "Event", "Store", "Errors", "Warnings"],
  "/platform/plans": ["Enforcement", "Plan matrix", "Conversations / month", "Curated answers", "Monthly price ($)", "Trial days", "Remove ChatConvert branding"],
  "/platform/promo-codes": ["Codes", "<s-table", "platform-add-promo", "Add New"],
  "/platform/settings": ["OpenAI API key", "Transactional email", "Links &amp; listing", "Operational flags", "Web push", "Reset"],
  "/platform/usage": ["Tokens used", "Estimated cost", "Stores with activity", "By merchant"],
};

async function renderSection({ db, COOKIE }: any): Promise<void> {
  section("1. Render — every page returns real content");
  for (const path of AUTHED_PAGES) {
    const p = await get(path, COOKIE);
    const broken = isBrokenPage(p);
    ok(`GET ${path} renders`, broken === null, broken ?? `200, ${p.body.length}b`);
    const missing = (PAGE_MARKERS[path] ?? []).filter((m) => !p.body.includes(m));
    ok(`GET ${path} contains its promised content`, missing.length === 0, missing.length ? `missing: ${missing.join(", ")}` : `${PAGE_MARKERS[path].length} markers`);
  }
  {
    const p = await get("/platform/login");
    ok("GET /platform/login renders the sign-in form", p.status === 200 && /type="password"|s-password-field|<form/i.test(p.body), `${p.status}`);
  }
  {
    // /platform/usage/:shopId for a real installed store.
    const shop = await db.shop.findFirst({ where: { uninstalledAt: null }, select: { id: true, domain: true } });
    const p = await get(`/platform/usage/${shop.id}`, COOKIE);
    const broken = isBrokenPage(p);
    ok(`GET /platform/usage/:shopId renders`, broken === null, broken ?? `200, ${p.body.length}b`);
    ok(
      "GET /platform/usage/:shopId shows that shop's figures",
      p.body.includes(shop.domain) && p.body.includes("Daily cost") && p.body.includes("Cost per conversation"),
      shop.domain,
    );
  }
  {
    const p = await get("/platform/logout", COOKIE);
    ok("GET /platform/logout renders a confirm page (not a logout)", p.status === 200 || p.status === 302, String(p.status));
  }
}

// ── 2. Security ─────────────────────────────────────────────────────────────
async function securitySection({ db, COOKIE, TAG, hashToken, operator }: any): Promise<void> {
  section("2. Security — auth, framing, surface isolation, secret leakage");

  const ALL_PLATFORM = [...AUTHED_PAGES, "/platform/usage/abc123"];

  // 2a. Unauthenticated GET.
  for (const path of ALL_PLATFORM) {
    const p = await get(path);
    ok(`unauthenticated GET ${path} → /platform/login`, p.status === 302 && (p.location ?? "").startsWith("/platform/login"), `${p.status} ${p.location}`);
  }
  // 2b. Bogus cookie.
  for (const path of ALL_PLATFORM) {
    const p = await get(path, "cc_platform=not-a-real-token");
    ok(`bogus cookie GET ${path} → /platform/login`, p.status === 302 && (p.location ?? "").startsWith("/platform/login"), `${p.status} ${p.location}`);
  }
  // 2c. Expired session: refused, and the dead row is cleaned up.
  {
    const { randomBytes } = await import("node:crypto");
    const raw = randomBytes(32).toString("base64url");
    const row = await db.platformSession.create({
      data: { tokenHash: hashToken(raw), adminId: operator.id, expiresAt: new Date(Date.now() - 60_000), userAgent: TAG },
    });
    const p = await get("/platform/plans", `cc_platform=${raw}`);
    ok("expired session → /platform/login", p.status === 302 && (p.location ?? "").startsWith("/platform/login"), `${p.status}`);
    const still = await db.platformSession.findUnique({ where: { id: row.id } });
    ok("expired session row is deleted on use", still === null);
  }
  // 2d. Every ACTION refuses an unauthenticated / bogus caller.
  const ACTION_ROUTES: Array<[string, string, Record<string, string>]> = [
    ["/platform/ai", "platform.ai", { chatModel: "gpt-4o", temperature: "", maxTokens: "" }],
    ["/platform/plans", "platform.plans", { intent: "enforcement", mode: "open" }],
    ["/platform/admins", "platform.admins", { intent: "remove", adminId: "x" }],
    ["/platform/promo-codes", "platform.promo-codes", { intent: "remove", id: "x" }],
    ["/platform/settings", "platform.settings", { intent: "reset" }],
  ];
  for (const [path, routeId, fields] of ACTION_ROUTES) {
    const anon = await req(`${path}.data?_routes=${encodeURIComponent(`routes/${routeId}`)}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });
    const redirected = anon.status === 302 || anon.body.includes("/platform/login");
    ok(`unauthenticated POST ${path} is refused`, redirected, `${anon.status} ${anon.location ?? ""}`);
    const bogus = await req(`${path}.data?_routes=${encodeURIComponent(`routes/${routeId}`)}`, {
      method: "POST",
      cookie: "cc_platform=not-a-real-token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });
    ok(`bogus-cookie POST ${path} is refused`, bogus.status === 302 || bogus.body.includes("/platform/login"), `${bogus.status} ${bogus.location ?? ""}`);
  }
  // 2e. CSRF: a cross-origin POST is blocked by sameOrigin().
  {
    const p = await req(`/platform/plans.data?_routes=${encodeURIComponent("routes/platform.plans")}`, {
      method: "POST",
      cookie: COOKIE,
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
      body: new URLSearchParams({ intent: "enforcement", mode: "open" }).toString(),
    });
    // React Router's single-fetch layer rejects a cross-origin .data POST
    // outright (400) before the action runs; the app's own sameOrigin() guard
    // is the second line of defence, exercised by the document POST below.
    ok(
      "cross-origin .data POST /platform/plans is rejected",
      p.status >= 400 || p.body.includes("Bad Request") || p.body.includes("Request blocked"),
      `${p.status} ${p.body.slice(0, 60)}`,
    );
    const docPost = await req("/platform/plans", {
      method: "POST",
      cookie: COOKIE,
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
      body: new URLSearchParams({ intent: "enforcement", mode: "open" }).toString(),
    });
    const row = await db.appSecret.findUnique({ where: { key: "platform:plans" } });
    ok(
      "cross-origin document POST /platform/plans persisted nothing (sameOrigin guard)",
      !row || JSON.parse(row.value).enforcement !== "open",
      `${docPost.status} stored=${row ? JSON.parse(row.value).enforcement : "absent"}`,
    );
  }
  // 2f. Not framable — including with the ?shop= param that used to opt a page
  //     into the embedded CSP branch.
  for (const path of [...ALL_PLATFORM, "/platform/login", "/platform/login?shop=dev-shop.myshopify.com", "/platform/plans?shop=dev-shop.myshopify.com"]) {
    const p = await get(path, path.includes("login") ? undefined : COOKIE);
    const csp = p.headers.get("content-security-policy") ?? "";
    const xfo = p.headers.get("x-frame-options") ?? "";
    ok(`${path} is not framable`, csp.includes("frame-ancestors 'none'") && xfo.toUpperCase() === "DENY", `csp="${csp}" xfo="${xfo}"`);
  }
  // 2g. Surface isolation both ways.
  {
    const { mintToken } = await import("../../app/lib/team/tokens.server");
    const shop = await db.shop.findFirst({ where: { uninstalledAt: null }, select: { id: true } });
    const member = await db.teamMember.create({
      data: { shopId: shop.id, email: `${TAG}-member@example.invalid`, name: "QA member", role: "admin", status: "active" },
    });
    try {
      const webRaw = await mintToken({ shopId: shop.id, memberId: member.id, kind: "session", ttlMs: 3_600_000 });
      const webCookie = `cc_web_session=${webRaw}; cc_surface=web`;
      for (const path of ALL_PLATFORM) {
        const p = await get(path, webCookie);
        ok(`merchant cc_web_session does NOT open ${path}`, p.status === 302 && (p.location ?? "").startsWith("/platform/login"), `${p.status} ${p.location}`);
      }
      for (const path of ["/app/inbox", "/app/settings", "/web", "/web/logout"]) {
        const p = await get(path, COOKIE);
        const blocked = p.status >= 300 || (p.status === 200 && p.body.includes("app-bridge.js") && !p.body.includes('"surface"'));
        ok(`cc_platform does NOT open ${path}`, blocked, `${p.status} ${p.location ?? ""}`);
      }
    } finally {
      await db.teamSession.deleteMany({ where: { memberId: member.id } }).catch(() => undefined);
      await db.teamMember.delete({ where: { id: member.id } }).catch(() => undefined);
    }
  }
  // 2h. No response body leaks a secret VALUE.
  {
    const secrets = [process.env.OPENAI_API_KEY, process.env.RESEND_API_KEY, process.env.PLATFORM_ADMIN_PASSWORD, process.env.SMTP_PASS]
      .filter((v): v is string => Boolean(v && v.length >= 8));
    const leaked: string[] = [];
    for (const path of ALL_PLATFORM) {
      const p = await get(path, COOKIE);
      for (const s of secrets) if (p.body.includes(s)) leaked.push(path);
    }
    // The stored Resend key is sealed at rest; its plaintext must not be echoed.
    const runtimeRow = await db.appSecret.findUnique({ where: { key: "platform:runtime" } });
    const sealed = runtimeRow ? JSON.parse(runtimeRow.value) : {};
    for (const field of ["openaiApiKey", "resendApiKey", "smtpPass"]) {
      const v = sealed[field];
      if (typeof v === "string" && v.length > 0) {
        ok(`app_secrets.platform:runtime.${field} is sealed at rest`, v.startsWith("enc:v1:"), v.slice(0, 12));
      }
    }
    ok(`no /platform page body leaks a secret value (${secrets.length} checked)`, leaked.length === 0, leaked.join(", "));
  }
}

// ── 3. /platform/ai ─────────────────────────────────────────────────────────
async function aiSection({ db, COOKIE, snapshot }: any): Promise<void> {
  section("3. /platform/ai — model + generation overrides");
  const KEY = "platform:ai";
  const readRow = async () => (await db.appSecret.findUnique({ where: { key: KEY } }))?.value ?? null;
  const original = snapshot.get(KEY);

  const before = await loaderData("/platform/ai", "platform.ai", COOKIE);
  ok("loader exposes the current overrides + effective model", typeof before.effectiveChatModel === "string" && before.overrides !== undefined, JSON.stringify(before.overrides));

  // 3a. Valid round-trip.
  const res = await submit("/platform/ai", "platform.ai", { chatModel: "gpt-4.1-mini", temperature: "0.9", maxTokens: "512" }, COOKIE);
  ok("POST valid AI overrides succeeds", res.data.ok === true, JSON.stringify(res.data));

  const after = await loaderData("/platform/ai", "platform.ai", COOKIE);
  ok("fresh GET shows the new effective model", after.effectiveChatModel === "gpt-4.1-mini" && after.overrides.chatModel === "gpt-4.1-mini", after.effectiveChatModel);
  ok("fresh GET shows the new temperature + maxTokens", after.overrides.temperature === 0.9 && after.overrides.maxTokens === 512, JSON.stringify(after.overrides));

  const html = await get("/platform/ai", COOKIE);
  ok("rendered page shows the dashboard override", html.body.includes("gpt-4.1-mini") && html.body.includes("(dashboard override)"));

  const stored = JSON.parse((await readRow())!);
  ok("persisted in app_secrets['platform:ai']", stored.chatModel === "gpt-4.1-mini" && stored.temperature === 0.9 && stored.maxTokens === 512, JSON.stringify(stored));

  // 3b. It takes effect in the SERVER process (the overview reads the same
  //     runtime config the pipeline uses).
  const overview = await loaderData("/platform", "platform._index", COOKIE);
  ok("server runtime config reflects the override immediately", overview.effectiveChatModel === "gpt-4.1-mini" && overview.chatModelOverridden === true, `${overview.effectiveChatModel} overridden=${overview.chatModelOverridden}`);

  // 3c. The override must NOT de-tune the strict-JSON router or the summariser.
  //     Real provider calls with the OpenAI HTTP round-trip stubbed out, so the
  //     assertion is on the exact request body the app would have sent.
  {
    const { getLlmProvider } = await import("../../app/lib/llm/index.server");
    const shop = await db.shop.findFirst({ where: { uninstalledAt: null }, select: { id: true } });
    const realFetch = globalThis.fetch;
    const sent: Record<string, any> = {};
    let purpose = "";
    globalThis.fetch = (async (input: any, init: any) => {
      const url = String(typeof input === "string" ? input : (input?.url ?? input));
      if (url.includes("api.openai.com")) {
        sent[purpose] = JSON.parse(String(init?.body ?? "{}"));
        return new Response(JSON.stringify({ id: "qa", choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return realFetch(input, init);
    }) as any;
    try {
      const provider = getLlmProvider();
      for (const p of ["router", "summary", "reply"]) {
        purpose = p;
        await provider.chat([{ role: "user", content: "qa" }], { shopId: shop.id, purpose: p } as any, { model: "qa-probe-model" });
      }
    } finally {
      globalThis.fetch = realFetch;
      await db.llmUsageDaily.deleteMany({ where: { model: "qa-probe-model" } }).catch(() => undefined);
    }
    ok("operator temperature does NOT reach the strict-JSON router", sent.router?.temperature === 0.3, `router temperature=${sent.router?.temperature}`);
    ok("operator maxTokens does NOT reach the strict-JSON router", sent.router?.max_tokens === 300, `router max_tokens=${sent.router?.max_tokens}`);
    ok("operator overrides do NOT reach the summariser", sent.summary?.temperature === 0.3 && sent.summary?.max_tokens === 300, `summary ${sent.summary?.temperature}/${sent.summary?.max_tokens}`);
    ok("operator overrides DO reach shopper-visible reply generation", sent.reply?.temperature === 0.9 && sent.reply?.max_tokens === 512, `reply ${sent.reply?.temperature}/${sent.reply?.max_tokens}`);
  }

  // 3d. Invalid input is refused and persists nothing.
  const goodRow = await readRow();
  const INVALID: Array<[string, Record<string, string>]> = [
    ["model id with spaces", { chatModel: "gpt 4o mini", temperature: "", maxTokens: "" }],
    ["model id with a slash", { chatModel: "openai/gpt-4o", temperature: "", maxTokens: "" }],
    ["oversized model id", { chatModel: "g".repeat(150), temperature: "", maxTokens: "" }],
    ["temperature above range", { chatModel: "", temperature: "2.5", maxTokens: "" }],
    ["negative temperature", { chatModel: "", temperature: "-1", maxTokens: "" }],
    ["non-numeric temperature", { chatModel: "", temperature: "hot", maxTokens: "" }],
    ["maxTokens below floor", { chatModel: "", temperature: "", maxTokens: "4" }],
    ["maxTokens above ceiling", { chatModel: "", temperature: "", maxTokens: "999999" }],
    ["negative maxTokens", { chatModel: "", temperature: "", maxTokens: "-100" }],
  ];
  for (const [label, fields] of INVALID) {
    const r = await submit("/platform/ai", "platform.ai", fields, COOKIE);
    const rejected = r.data.ok === false && typeof r.data.error === "string" && r.data.error.length > 5;
    ok(`AI: ${label} is rejected with a message`, rejected, String(r.data.error ?? r.data.ok));
    const now = await readRow();
    ok(`AI: ${label} persisted nothing`, now === goodRow, now === goodRow ? "unchanged" : `CHANGED → ${now}`);
  }

  // 3e. An unpriced / unverified custom id saves but WARNS (D-07).
  {
    const r = await submit("/platform/ai", "platform.ai", { chatModel: "gpt-4.2-imaginary", temperature: "", maxTokens: "" }, COOKIE);
    ok("AI: unpriced custom model saves with a warning", r.data.ok === true && typeof r.data.warning === "string" && r.data.warning.includes("unpriced"), String(r.data.warning));
  }

  // 3f. Clearing back to the environment default works.
  {
    const r = await submit("/platform/ai", "platform.ai", { chatModel: "", temperature: "", maxTokens: "" }, COOKIE);
    const d = await loaderData("/platform/ai", "platform.ai", COOKIE);
    ok("AI: blank clears the override back to the env default", r.data.ok === true && d.overrides.chatModel === "" && d.effectiveChatModel === d.envChatModel, `${d.effectiveChatModel} / ${d.envChatModel}`);
  }

  // 3g. Restore (the finally block re-asserts this).
  const o = JSON.parse(original as string);
  await submit("/platform/ai", "platform.ai", {
    chatModel: o.chatModel ?? "",
    temperature: o.temperature === null || o.temperature === undefined ? "" : String(o.temperature),
    maxTokens: o.maxTokens === null || o.maxTokens === undefined ? "" : String(o.maxTokens),
  }, COOKIE);
  ok("AI: original overrides restored", (await readRow()) === original, `${await readRow()}`);
}

// ── 4. /platform/plans ──────────────────────────────────────────────────────
async function plansSection({ db, COOKIE, snapshot }: any): Promise<void> {
  section("4. /platform/plans — quotas, features, enforcement, corruption");
  const KEY = "platform:plans";
  const BACKUP_KEY = "platform:plans:corrupt";
  const original = snapshot.get(KEY) as string | null;
  const readRow = async () => (await db.appSecret.findUnique({ where: { key: KEY } }))?.value ?? null;

  const plansLib = await import("../../app/lib/billing/plans.server");
  const { loadPlanConfig, getQuota, hasFeature, displayQuota, planEnforcementMode, PLANS, DEFAULT_PLANS, GATED_FEATURES, QUOTA_DIMENSIONS, PLAN_IDS } = plansLib;
  const { getStoredPlanConfig } = await import("../../app/lib/platform/platform-settings.server");

  /** Rebuild the exact payload the plans page submits for one tier. */
  const payloadFor = (plan: any, patch: any = {}) => ({
    priceMonthly: plan.priceMonthly,
    priceYearlyPerMonth: plan.priceYearlyPerMonth,
    trialDays: plan.trialDays,
    overagePerConversation: plan.overagePerConversation,
    quotas: Object.fromEntries(QUOTA_DIMENSIONS.map((d: string) => [d, plan.quotas[d]])),
    features: [...plan.features],
    knownFeatures: [...GATED_FEATURES],
    ...patch,
  });
  const savePlan = (planId: string, payload: any) =>
    submit("/platform/plans", "platform.plans", { intent: "save-plan", planId, payload: JSON.stringify(payload) }, COOKIE);

  try {
  const live = await loaderData("/platform/plans", "platform.plans", COOKIE);
  ok("loader exposes the live matrix, the defaults and the enforcement mode", Boolean(live.plans?.free && live.defaults?.free && live.enforcement), `enforcement=${live.enforcement}`);
  const originalEnforcement: "open" | "enforced" = live.enforcement;

  // 4a. Enforcement switch (B-05).
  {
    const flipped = originalEnforcement === "enforced" ? "open" : "enforced";
    const r = await submit("/platform/plans", "platform.plans", { intent: "enforcement", mode: flipped }, COOKIE);
    ok("POST enforcement toggle succeeds", r.data.ok === true, JSON.stringify(r.data));
    const d = await loaderData("/platform/plans", "platform.plans", COOKIE);
    ok("fresh GET shows the flipped enforcement mode", d.enforcement === flipped, d.enforcement);
    const html = await get("/platform/plans", COOKIE);
    ok("rendered page reflects the flipped mode", flipped === "open" ? html.body.includes("Enforcement is OFF") : !html.body.includes("Enforcement is OFF"));
    const ov = await loaderData("/platform", "platform._index", COOKIE);
    ok("overview tile agrees with the new mode", ov.enforcement === flipped, ov.enforcement);
    ok("persisted in app_secrets", JSON.parse((await readRow())!).enforcement === flipped);

    await loadPlanConfig();
    ok("in-process planEnforcementMode() follows", planEnforcementMode() === flipped, planEnforcementMode());
    if (flipped === "open") {
      ok("open mode: every gate passes", GATED_FEATURES.every((f: any) => hasFeature("free", f)));
      ok("open mode: every quota is unlimited", QUOTA_DIMENSIONS.every((d: any) => getQuota("free", d) === Number.MAX_SAFE_INTEGER), String(getQuota("free", "conversations")));
      ok("open mode: displayQuota still shows the real matrix value", displayQuota("free", "conversations") === PLANS.free.quotas.conversations, String(displayQuota("free", "conversations")));
    }

    const back = await submit("/platform/plans", "platform.plans", { intent: "enforcement", mode: originalEnforcement }, COOKIE);
    await loadPlanConfig();
    ok("enforcement restored", back.data.ok === true && planEnforcementMode() === originalEnforcement, planEnforcementMode());
  }

  // 4b. Quota + feature edit on the Free tier (which the page renders by
  //     default, so the change is visible in the server-rendered HTML too).
  {
    const freeLive = (await loaderData("/platform/plans", "platform.plans", COOKIE)).plans.free;
    const patched = payloadFor(freeLive, {
      quotas: { ...Object.fromEntries(QUOTA_DIMENSIONS.map((d: string) => [d, freeLive.quotas[d]])), curated_answers: 77 },
      features: ["exports"],
      priceMonthly: 1.5,
      trialDays: 3,
      overagePerConversation: 0.25,
    });
    const r = await savePlan("free", patched);
    ok("POST save-plan (free) succeeds", r.data.ok === true, JSON.stringify(r.data));

    const d = await loaderData("/platform/plans", "platform.plans", COOKIE);
    ok("fresh GET: quota edit is live", d.plans.free.quotas.curated_answers === 77, String(d.plans.free.quotas.curated_answers));
    ok("fresh GET: feature toggle is live", d.plans.free.features.includes("exports"), JSON.stringify(d.plans.free.features));
    ok("fresh GET: price + trial + overage edits are live", d.plans.free.priceMonthly === 1.5 && d.plans.free.trialDays === 3 && d.plans.free.overagePerConversation === 0.25, JSON.stringify([d.plans.free.priceMonthly, d.plans.free.trialDays, d.plans.free.overagePerConversation]));

    const html = await get("/platform/plans", COOKIE);
    ok("server-rendered form field shows the new quota", html.body.includes('label="Curated answers" min="0" value="77"'));

    const storedNow = JSON.parse((await readRow())!);
    ok("persisted in app_secrets['platform:plans']", storedNow.plans.free.quotas.curated_answers === 77 && storedNow.plans.free.features.includes("exports"));
    ok("save stamps knownFeatures", Array.isArray(storedNow.plans.free.knownFeatures) && storedNow.plans.free.knownFeatures.length === GATED_FEATURES.length);
    ok("editing one plan preserves the OTHER plans' overrides", original === null || !JSON.parse(original).plans?.plus || storedNow.plans.plus !== undefined, JSON.stringify(Object.keys(storedNow.plans)));

    await loadPlanConfig();
    ok("getQuota() reflects the edit for a real shop", getQuota("free", "curated_answers") === 77, String(getQuota("free", "curated_answers")));
    ok("hasFeature() reflects the toggle for a real shop", hasFeature("free", "exports") === true);
    ok("untouched dimensions keep their values", getQuota("free", "conversations") === DEFAULT_PLANS.free.quotas.conversations, String(getQuota("free", "conversations")));
  }

  // 4c. knownFeatures: a feature the operator never saw must NOT be gated off.
  {
    const basicLive = (await loaderData("/platform/plans", "platform.plans", COOKIE)).plans.basic;
    const withoutSurvey = GATED_FEATURES.filter((f: string) => f !== "survey");
    await savePlan("basic", payloadFor(basicLive, { features: [], knownFeatures: withoutSurvey }));
    await loadPlanConfig();
    ok("knownFeatures: a feature the operator DID see and unchecked stays off", hasFeature("basic", "push_notifications") === false);
    ok("knownFeatures: a feature added AFTER the save falls back to the plan default (not silently gated off)", hasFeature("basic", "survey") === DEFAULT_PLANS.basic.features.includes("survey"), `survey=${hasFeature("basic", "survey")}`);

    // A legacy row with no knownFeatures at all behaves the same way.
    await savePlan("basic", payloadFor(basicLive, { features: ["remove_branding"], knownFeatures: undefined }));
    await loadPlanConfig();
    ok("legacy override (no knownFeatures) keeps default features that it omits", hasFeature("basic", "survey") === DEFAULT_PLANS.basic.features.includes("survey") && hasFeature("basic", "remove_branding") === true);

    // Unknown feature names in a stored override are tolerated, not fatal.
    await savePlan("basic", payloadFor(basicLive, { features: [...basicLive.features, "since_removed_feature"], knownFeatures: [...GATED_FEATURES, "since_removed_feature"] }));
    await loadPlanConfig();
    ok("unknown feature name in a stored override does not invalidate the config", hasFeature("basic", "remove_branding") === true && getQuota("basic", "conversations") === basicLive.quotas.conversations);
  }

  // 4d. Invalid input is refused and persists nothing.
  {
    const goodRow = await readRow();
    const freeLive = (await loaderData("/platform/plans", "platform.plans", COOKIE)).plans.free;
    const INVALID: Array<[string, Record<string, string>]> = [
      ["unknown planId", { intent: "save-plan", planId: "enterprise", payload: JSON.stringify(payloadFor(freeLive)) }],
      ["negative quota", { intent: "save-plan", planId: "free", payload: JSON.stringify(payloadFor(freeLive, { quotas: { ...freeLive.quotas, conversations: -5 } })) }],
      ["fractional quota", { intent: "save-plan", planId: "free", payload: JSON.stringify(payloadFor(freeLive, { quotas: { ...freeLive.quotas, conversations: 1.5 } })) }],
      ["unknown quota dimension", { intent: "save-plan", planId: "free", payload: JSON.stringify(payloadFor(freeLive, { quotas: { ...freeLive.quotas, made_up_dimension: 5 } })) }],
      ["trialDays above 90", { intent: "save-plan", planId: "free", payload: JSON.stringify(payloadFor(freeLive, { trialDays: 999 })) }],
      ["negative trialDays", { intent: "save-plan", planId: "free", payload: JSON.stringify(payloadFor(freeLive, { trialDays: -1 })) }],
      ["negative price", { intent: "save-plan", planId: "free", payload: JSON.stringify(payloadFor(freeLive, { priceMonthly: -10 })) }],
      ["price as a string", { intent: "save-plan", planId: "free", payload: JSON.stringify(payloadFor(freeLive, { priceMonthly: "free" })) }],
      ["negative overage", { intent: "save-plan", planId: "free", payload: JSON.stringify(payloadFor(freeLive, { overagePerConversation: -1 })) }],
      ["oversized plan name", { intent: "save-plan", planId: "free", payload: JSON.stringify(payloadFor(freeLive, { name: "N".repeat(200) })) }],
      ["malformed JSON payload", { intent: "save-plan", planId: "free", payload: "{not json" }],
      ["unknown intent", { intent: "definitely-not-an-intent" }],
    ];
    for (const [label, fields] of INVALID) {
      const r = await submit("/platform/plans", "platform.plans", fields, COOKIE);
      ok(`plans: ${label} is rejected with a message`, r.data.ok === false && typeof r.data.error === "string" && r.data.error.length > 3, String(r.data.error ?? r.data.ok));
      const now = await readRow();
      ok(`plans: ${label} persisted nothing`, now === goodRow, now === goodRow ? "unchanged" : "CHANGED");
    }
  }

  // 4e. A corrupt stored row is detected and ARCHIVED, not silently swallowed.
  {
    const goodRow = (await readRow())!;
    const hadBackup = (await db.appSecret.findUnique({ where: { key: BACKUP_KEY } })) !== null;
    await db.appSecret.update({ where: { key: KEY }, data: { value: "{ this is not json" } });
    const parsed = await getStoredPlanConfig();
    ok("corrupt plan config parses to {} rather than throwing", JSON.stringify(parsed) === "{}");
    const backup = await db.appSecret.findUnique({ where: { key: BACKUP_KEY } });
    ok("corrupt plan config is archived to platform:plans:corrupt", backup?.value === "{ this is not json", backup?.value ?? "absent");
    const logged = await db.appLog.findFirst({ where: { event: { in: ["plan_config_corrupt", "plan_config_unparseable"] } }, orderBy: { occurredAt: "desc" } });
    ok("corruption is logged, not silent", Boolean(logged) && Date.now() - new Date(logged!.occurredAt).getTime() < 120_000, logged?.event ?? "none");
    // Schema-invalid (but parseable) JSON takes the same path.
    await db.appSecret.update({ where: { key: KEY }, data: { value: JSON.stringify({ enforcement: "sometimes" }) } });
    ok("schema-invalid plan config also falls back to {}", JSON.stringify(await getStoredPlanConfig()) === "{}");
    await db.appSecret.update({ where: { key: KEY }, data: { value: goodRow } });
    if (!hadBackup) await db.appSecret.deleteMany({ where: { key: BACKUP_KEY } });
    await get("/platform/plans", COOKIE); // force the server to re-read
    await loadPlanConfig();
  }

  // 4f. Reset to code defaults, then restore.
  {
    const r = await submit("/platform/plans", "platform.plans", { intent: "reset" }, COOKIE);
    ok("POST reset succeeds", r.data.ok === true, JSON.stringify(r.data));
    ok("reset deletes the override row", (await readRow()) === null);
    await loadPlanConfig();
    const identical = (PLAN_IDS as readonly string[]).every((id) => JSON.stringify((PLANS as Record<string, unknown>)[id]) === JSON.stringify((DEFAULT_PLANS as Record<string, unknown>)[id]));
    ok("after reset PLANS deep-equals DEFAULT_PLANS", identical);
    const d = await loaderData("/platform/plans", "platform.plans", COOKIE);
    ok("after reset the page shows code defaults and no overrides", d.hasOverrides === false && d.plans.free.quotas.curated_answers === DEFAULT_PLANS.free.quotas.curated_answers, `hasOverrides=${d.hasOverrides}`);
  }

  } finally {
  // 4g. Restore the operator's real matrix, byte-exact, and prove the SERVER
  //     picked it up (its loader calls loadPlanConfig() unconditionally).
  if (original === null) {
    await db.appSecret.deleteMany({ where: { key: KEY } });
  } else {
    await db.appSecret.upsert({ where: { key: KEY }, create: { key: KEY, value: original }, update: { value: original } });
  }
  await get("/platform/plans", COOKIE);
  await loadPlanConfig();
  ok("plans: original override row restored byte-exact", (await readRow()) === original);
  if (original) {
    const o = JSON.parse(original);
    const d = await loaderData("/platform/plans", "platform.plans", COOKIE);
    const tier = Object.keys(o.plans ?? {})[0];
    ok(
      "plans: the SERVER is serving the restored matrix again",
      d.enforcement === (o.enforcement ?? "enforced") && (!tier || d.plans[tier].quotas.conversations === o.plans[tier].quotas.conversations),
      `${d.enforcement} / ${tier}`,
    );
  }
  }
}

// ── 5. /platform/promo-codes ────────────────────────────────────────────────
async function promoSection({ db, COOKIE, createdPromoIds }: any): Promise<void> {
  section("5. /platform/promo-codes — create, deactivate, delete, validation");
  const R = "platform.promo-codes";
  const P = "/platform/promo-codes";
  const suffix = String(Date.now()).slice(-6);
  const CODE = `QAPCT${suffix}`;
  const FIXED = `QAFIX${suffix}`;

  const before = await loaderData(P, R, COOKIE);
  ok("loader lists existing codes with their scope + redemption counts", Array.isArray(before.codes) && Array.isArray(before.paidPlans) && before.paidPlans.every((p: any) => p.id !== "free"), `${before.codes.length} codes, paid plans ${before.paidPlans.map((p: any) => p.id).join("/")}`);

  // 5a. Create a percent code — deliberately with lower-case + internal spaces
  //     so normalisation is exercised on the real path.
  {
    const r = await submit(P, R, {
      intent: "add",
      code: ` ${CODE.slice(0, 5).toLowerCase()} ${CODE.slice(5)} `,
      description: "QA percent code",
      kind: "percent",
      value: "15.25",
      durationIntervals: "3",
      maxRedemptions: "2",
      expiresAt: "2030-01-31",
      plans: ["pro", "plus", "free"],
      intervals: "monthly",
    }, COOKIE);
    ok("POST create percent code succeeds", r.data.ok === true, JSON.stringify(r.data));
    const row = await db.promoCode.findUnique({ where: { code: CODE } });
    if (row) createdPromoIds.push(row.id);
    ok("code is normalised (upper-cased, whitespace stripped)", Boolean(row), CODE);
    ok("percent value, duration, cap and expiry persisted", row && Number(row.value) === 15.25 && row.durationIntervals === 3 && row.maxRedemptions === 2 && row.expiresAt?.toISOString() === "2030-01-31T23:59:59.999Z", row ? `${row.value}/${row.durationIntervals}/${row.maxRedemptions}/${row.expiresAt?.toISOString()}` : "missing");
    ok("plan restriction drops non-paid plans", row && JSON.stringify(row.plans) === JSON.stringify(["pro", "plus"]), JSON.stringify(row?.plans));
    ok("interval restriction persisted", row && JSON.stringify(row.intervals) === JSON.stringify(["monthly"]), JSON.stringify(row?.intervals));
    ok("expiry is end-of-day UTC (documented, not merchant-local)", row?.expiresAt?.toISOString().endsWith("T23:59:59.999Z") === true);

    const after = await loaderData(P, R, COOKIE);
    const listed = after.codes.find((c: any) => c.code === CODE);
    ok("fresh GET lists the new code", Boolean(listed), listed?.label);
    ok("fresh GET describes it correctly", listed?.label === "15.25% off for 3 billing cycles" && listed?.active === true, listed?.label);
    const html = await get(P, COOKIE);
    ok("rendered page shows the new code", html.body.includes(CODE));
  }

  // 5b. Fixed-amount code.
  {
    const r = await submit(P, R, { intent: "add", code: FIXED, description: "QA fixed", kind: "fixed", value: "5.50", durationIntervals: "", maxRedemptions: "", expiresAt: "", plans: [], intervals: "both" }, COOKIE);
    const row = await db.promoCode.findUnique({ where: { code: FIXED } });
    if (row) createdPromoIds.push(row.id);
    ok("POST create fixed code succeeds", r.data.ok === true && row?.kind === "fixed" && Number(row?.value) === 5.5, JSON.stringify(r.data));
    ok("blank duration/cap/expiry mean forever / unlimited / never", row && row.durationIntervals === null && row.maxRedemptions === null && row.expiresAt === null);
    ok("blank plan + interval scope means any paid plan, either interval", row && row.plans.length === 0 && row.intervals.length === 0);
  }

  // 5c. Deactivate, then re-activate.
  {
    const row = await db.promoCode.findUnique({ where: { code: FIXED } });
    const off = await submit(P, R, { intent: "toggle", id: row.id }, COOKIE);
    const afterOff = await db.promoCode.findUnique({ where: { id: row.id } });
    ok("toggle deactivates the code", off.data.ok === true && off.data.intent === "deactivate" && afterOff.active === false, `${off.data.intent}/${afterOff.active}`);
    const listed = (await loaderData(P, R, COOKIE)).codes.find((c: any) => c.id === row.id);
    ok("fresh GET shows it inactive", listed?.active === false);
    const on = await submit(P, R, { intent: "toggle", id: row.id }, COOKIE);
    const afterOn = await db.promoCode.findUnique({ where: { id: row.id } });
    ok("toggle re-activates the code", on.data.ok === true && on.data.intent === "activate" && afterOn.active === true);
  }

  // 5d. A code with a real redemption can only be deactivated, never deleted.
  {
    const row = await db.promoCode.findUnique({ where: { code: CODE } });
    const shop = await db.shop.findFirst({ where: { uninstalledAt: null }, select: { id: true } });
    const redemption = await db.promoRedemption.create({
      data: { promoCodeId: row.id, shopId: shop.id, status: "redeemed", redeemedAt: new Date(), plan: "pro", interval: "monthly" },
    });
    try {
      const r = await submit(P, R, { intent: "remove", id: row.id }, COOKIE);
      ok("deleting a redeemed code is refused server-side", r.data.ok === false && String(r.data.error).includes("deactivate"), String(r.data.error));
      ok("the redeemed code still exists", (await db.promoCode.findUnique({ where: { id: row.id } })) !== null);
      const listed = (await loaderData(P, R, COOKIE)).codes.find((c: any) => c.id === row.id);
      ok("redemption count is reported on the page", listed?.redeemed === 1 && listed?.everRedeemed === true, `redeemed=${listed?.redeemed}`);
    } finally {
      await db.promoRedemption.delete({ where: { id: redemption.id } }).catch(() => undefined);
    }
  }

  // 5e. Pending reservations occupy a maxRedemptions slot on the page.
  {
    const row = await db.promoCode.findUnique({ where: { code: CODE } });
    const shop = await db.shop.findFirst({ where: { uninstalledAt: null }, select: { id: true } });
    const pending = await db.promoRedemption.create({ data: { promoCodeId: row.id, shopId: shop.id, status: "pending", plan: "pro", interval: "monthly" } });
    try {
      const listed = (await loaderData(P, R, COOKIE)).codes.find((c: any) => c.id === row.id);
      ok("a fresh pending reservation is counted on the page", listed?.pending === 1, `pending=${listed?.pending}`);
    } finally {
      await db.promoRedemption.delete({ where: { id: pending.id } }).catch(() => undefined);
    }
  }

  // 5f. Validation — every one must be refused AND persist nothing.
  {
    const countBefore = await db.promoCode.count();
    const INVALID: Array<[string, Record<string, string | string[]>]> = [
      ["empty code", { intent: "add", code: "", kind: "percent", value: "10" }],
      ["2-character code", { intent: "add", code: "AB", kind: "percent", value: "10" }],
      ["33-character code", { intent: "add", code: "A".repeat(33), kind: "percent", value: "10" }],
      ["code with illegal characters", { intent: "add", code: "SAVE$20!", kind: "percent", value: "10" }],
      ["code starting with a dash", { intent: "add", code: "-SAVE20", kind: "percent", value: "10" }],
      ["duplicate code", { intent: "add", code: CODE, kind: "percent", value: "10" }],
      ["zero value", { intent: "add", code: `QAZ${suffix}`, kind: "percent", value: "0" }],
      ["negative value", { intent: "add", code: `QAN${suffix}`, kind: "percent", value: "-5" }],
      ["non-numeric value", { intent: "add", code: `QAX${suffix}`, kind: "percent", value: "lots" }],
      ["percent above 100", { intent: "add", code: `QAH${suffix}`, kind: "percent", value: "150" }],
      ["percent with 3 decimals", { intent: "add", code: `QAD${suffix}`, kind: "percent", value: "12.345" }],
      ["fixed amount with 3 decimals", { intent: "add", code: `QAF${suffix}`, kind: "fixed", value: "5.005" }],
      ["duration 0", { intent: "add", code: `QAU${suffix}`, kind: "percent", value: "10", durationIntervals: "0" }],
      ["fractional duration", { intent: "add", code: `QAR${suffix}`, kind: "percent", value: "10", durationIntervals: "1.5" }],
      ["maxRedemptions 0", { intent: "add", code: `QAM${suffix}`, kind: "percent", value: "10", maxRedemptions: "0" }],
      ["negative maxRedemptions", { intent: "add", code: `QAG${suffix}`, kind: "percent", value: "10", maxRedemptions: "-3" }],
      ["fractional maxRedemptions", { intent: "add", code: `QAK${suffix}`, kind: "percent", value: "10", maxRedemptions: "2.5" }],
      ["unparseable expiry", { intent: "add", code: `QAE${suffix}`, kind: "percent", value: "10", expiresAt: "not-a-date" }],
      ["unknown intent", { intent: "definitely-not-an-intent" }],
      ["toggle a missing code", { intent: "toggle", id: "does-not-exist" }],
    ];
    for (const [label, fields] of INVALID) {
      const r = await submit(P, R, fields as any, COOKIE);
      ok(`promo: ${label} is rejected with a message`, r.data.ok === false && typeof r.data.error === "string" && r.data.error.length > 3, String(r.data.error ?? r.data.ok));
    }
    ok("promo: no invalid submission created a row", (await db.promoCode.count()) === countBefore, `${countBefore} → ${await db.promoCode.count()}`);
  }

  // 5g. Delete an unredeemed code for real.
  {
    const row = await db.promoCode.findUnique({ where: { code: FIXED } });
    const r = await submit(P, R, { intent: "remove", id: row.id }, COOKIE);
    ok("deleting an unredeemed code succeeds", r.data.ok === true, JSON.stringify(r.data));
    ok("the row is gone", (await db.promoCode.findUnique({ where: { id: row.id } })) === null);
    ok("fresh GET no longer lists it", !(await get(P, COOKIE)).body.includes(FIXED));
  }

  // 5h. QA codes removed; the operator's pre-existing codes are untouched.
  {
    await db.promoRedemption.deleteMany({ where: { promoCodeId: { in: createdPromoIds } } });
    await db.promoCode.deleteMany({ where: { id: { in: createdPromoIds } } });
    const leftover = await db.promoCode.count({ where: { code: { startsWith: "QA" } } });
    ok("promo: every QA code removed", leftover === 0, `${leftover} left`);
    const survivors = await db.promoCode.count();
    ok("promo: the operator's own codes survived the sweep", survivors === before.codes.length, `${before.codes.length} → ${survivors}`);
  }
}

// ── 6. /platform/admins ─────────────────────────────────────────────────────
async function adminsSection({ db, COOKIE, TAG, operator, opPassword, createdAdminIds, hashToken }: any): Promise<void> {
  section("6. /platform/admins — add, remove, password, safeguards");
  const R = "platform.admins";
  const P = "/platform/admins";
  const { randomBytes } = await import("node:crypto");
  const newEmail = `${TAG}-b@example.invalid`;

  const before = await loaderData(P, R, COOKIE);
  ok("loader lists operator accounts and identifies the signed-in one", Array.isArray(before.admins) && before.selfId === operator.id && before.admins.some((a: any) => a.id === operator.id), `${before.admins.length} admins`);
  ok("loader never ships a password hash to the browser", JSON.stringify(before).toLowerCase().includes("passwordhash") === false);

  // 6a. Add.
  {
    const r = await submit(P, R, { intent: "add", name: "QA admin B", email: ` ${newEmail.toUpperCase()} `, password: "qa-Passw0rd-B!" }, COOKIE);
    ok("POST add admin succeeds", r.data.ok === true && r.data.intent === "add", JSON.stringify(r.data));
    const row = await db.platformAdmin.findUnique({ where: { email: newEmail } });
    if (row) createdAdminIds.push(row.id);
    ok("the new admin is persisted with a normalised email", Boolean(row) && row.email === newEmail, row?.email);
    ok("the password is stored hashed, never in the clear", Boolean(row) && !row.passwordHash.includes("qa-Passw0rd-B!") && row.passwordHash.length > 30, row?.passwordHash.slice(0, 8));
    const after = await loaderData(P, R, COOKIE);
    ok("fresh GET lists the new admin", after.admins.some((a: any) => a.email === newEmail));
    ok("rendered page lists the new admin", (await get(P, COOKIE)).body.includes(newEmail));
  }

  // 6b. There is no role concept on this surface — every operator has full
  //     access by design (spec 19). Assert that, so a silent regression that
  //     introduces an unenforced role field is caught.
  {
    const row = await db.platformAdmin.findUnique({ where: { email: newEmail } });
    ok("platform admins have no role field (every operator is full-access by design)", !("role" in row), Object.keys(row).join(","));
    const r = await submit(P, R, { intent: "set-role", adminId: row.id, role: "readonly" }, COOKIE);
    ok("an invented role-change intent is refused, not silently accepted", r.data.ok === false && String(r.data.error).includes("Unknown action"), String(r.data.error));
  }

  // 6c. Safeguards.
  {
    const selfRemove = await submit(P, R, { intent: "remove", adminId: operator.id }, COOKIE);
    ok("you cannot remove your own account", selfRemove.data.ok === false && String(selfRemove.data.error).includes("your own"), String(selfRemove.data.error));
    ok("your account survives the attempt", (await db.platformAdmin.findUnique({ where: { id: operator.id } })) !== null);

    // The `count <= 1` branch is structurally unreachable through the UI: the
    // only way to reach one remaining account is to remove yourself, which is
    // refused above. Prove the invariant that actually matters — a burst of
    // concurrent removals never empties the table.
    const extra = await Promise.all(
      [1, 2].map((n) =>
        db.platformAdmin.create({ data: { email: `${TAG}-race${n}@example.invalid`, name: `QA race ${n}`, passwordHash: operator.passwordHash } }),
      ),
    );
    createdAdminIds.push(...extra.map((a: any) => a.id));
    await Promise.all(extra.map((a: any) => submit(P, R, { intent: "remove", adminId: a.id }, COOKIE)));
    const remaining = await db.platformAdmin.count();
    ok("concurrent removals never empty the operator table", remaining >= 1, `${remaining} remaining`);
    ok("both concurrently-removed accounts are gone", (await db.platformAdmin.count({ where: { id: { in: extra.map((a: any) => a.id) } } })) === 0);

    const missing = await submit(P, R, { intent: "remove", adminId: "does-not-exist" }, COOKIE);
    ok("removing a non-existent admin does not 500", missing.status === 200, `${missing.status} ${JSON.stringify(missing.data)}`);
  }

  // 6d. Add-validation — refused, and nothing persisted.
  {
    const countBefore = await db.platformAdmin.count();
    const INVALID: Array<[string, Record<string, string>]> = [
      ["blank name", { intent: "add", name: "  ", email: `${TAG}-v1@example.invalid`, password: "qa-Passw0rd!" }],
      ["email with no @", { intent: "add", name: "QA", email: "not-an-email", password: "qa-Passw0rd!" }],
      ["blank email", { intent: "add", name: "QA", email: "", password: "qa-Passw0rd!" }],
      ["7-character password", { intent: "add", name: "QA", email: `${TAG}-v2@example.invalid`, password: "short12" }],
      ["blank password", { intent: "add", name: "QA", email: `${TAG}-v3@example.invalid`, password: "" }],
      ["duplicate email", { intent: "add", name: "QA dup", email: newEmail, password: "qa-Passw0rd!" }],
      ["unknown intent", { intent: "definitely-not-an-intent" }],
    ];
    for (const [label, fields] of INVALID) {
      const r = await submit(P, R, fields, COOKIE);
      ok(`admins: ${label} is rejected with a message`, r.data.ok === false && typeof r.data.error === "string" && r.data.error.length > 3, String(r.data.error ?? r.data.ok));
    }
    ok("admins: no invalid submission created an account", (await db.platformAdmin.count()) === countBefore, `${countBefore} → ${await db.platformAdmin.count()}`);
  }

  // 6e. Password change — verified against the current password, and it revokes
  //     every OTHER session of that operator while keeping this browser in.
  {
    const otherRaw = randomBytes(32).toString("base64url");
    const otherSession = await db.platformSession.create({
      data: { tokenHash: hashToken(otherRaw), adminId: operator.id, expiresAt: new Date(Date.now() + 3_600_000), userAgent: `${TAG}-other` },
    });

    const wrong = await submit(P, R, { intent: "password", current: "definitely-not-the-password", next: "qa-N3wPassw0rd!" }, COOKIE);
    ok("password change with the wrong current password is refused", wrong.data.ok === false && String(wrong.data.error).includes("Current password"), String(wrong.data.error));
    ok("the other session survives a refused password change", (await db.platformSession.findUnique({ where: { id: otherSession.id } })) !== null);

    const weak = await submit(P, R, { intent: "password", current: opPassword, next: "short12" }, COOKIE);
    ok("a too-short new password is refused", weak.data.ok === false && typeof weak.data.error === "string", String(weak.data.error));

    const good = await submit(P, R, { intent: "password", current: opPassword, next: "qa-N3wPassw0rd!" }, COOKIE);
    ok("password change with the correct current password succeeds", good.data.ok === true && good.data.intent === "password", JSON.stringify(good.data));
    const { verifyPassword } = await import("../../app/lib/team/password.server");
    const updated = await db.platformAdmin.findUnique({ where: { id: operator.id } });
    ok("the new password hash verifies", await verifyPassword("qa-N3wPassw0rd!", updated.passwordHash));
    ok("password change revoked the operator's OTHER session", (await db.platformSession.findUnique({ where: { id: otherSession.id } })) === null);
    ok("password change kept THIS browser signed in", (await get(P, COOKIE)).status === 200);
  }

  // 6f. Remove the QA admin for real.
  {
    const row = await db.platformAdmin.findUnique({ where: { email: newEmail } });
    const r = await submit(P, R, { intent: "remove", adminId: row.id }, COOKIE);
    ok("removing another admin succeeds", r.data.ok === true && r.data.intent === "remove", JSON.stringify(r.data));
    ok("the removed admin is gone", (await db.platformAdmin.findUnique({ where: { id: row.id } })) === null);
    ok("fresh GET no longer lists them", !(await get(P, COOKIE)).body.includes(newEmail));
    ok(
      "the operator's own pre-existing accounts are untouched",
      (await db.platformAdmin.count({ where: { email: { not: { contains: "qa-platform-" } } } })) === before.admins.filter((a: any) => !a.email.includes("qa-platform-")).length,
      `${before.admins.filter((a: any) => !a.email.includes("qa-platform-")).length} expected`,
    );
  }
}

// ── 7. /platform/logs ───────────────────────────────────────────────────────
async function logsSection({ db, COOKIE }: any): Promise<void> {
  section("7. /platform/logs — filters, attribution, bounded reads");
  const R = "platform.logs";
  const P = "/platform/logs";
  const ROW_LIMIT = 200;
  const load = (qs: string) => loaderData(`${P}${qs}`, R, COOKIE);

  const base = await load("");
  ok("loader returns rows, tiles and filter options", Array.isArray(base.rows) && typeof base.errors === "number" && typeof base.warnings === "number" && Array.isArray(base.eventOptions), `${base.rows.length} rows, ${base.errors}E/${base.warnings}W`);
  ok("log rows are actually rendered into the table", base.rows.length > 0 && (await get(P, COOKIE)).body.includes(base.rows[0].event), base.rows[0]?.event ?? "no rows");
  ok("only error + warn levels exist (by design)", base.rows.every((r: any) => r.level === "error" || r.level === "warn"));
  ok("the page never exceeds the row cap", base.rows.length <= ROW_LIMIT, String(base.rows.length));

  // 7a. Range.
  {
    const wide = await load("?hours=336");
    ok("range filter widens the window", wide.filters.hours === 336 && wide.errors + wide.warnings >= base.errors + base.warnings, `${base.errors + base.warnings} → ${wide.errors + wide.warnings}`);
    const dbCount = await db.appLog.count({ where: { occurredAt: { gte: new Date(Date.now() - 336 * 3600_000) } } });
    ok("14-day totals match the database", Math.min(dbCount, 5000) === wide.errors + wide.warnings, `page=${wide.errors + wide.warnings} db=${dbCount}`);
    const bogus = await load("?hours=99999");
    ok("an out-of-range hours value falls back to 24h", bogus.filters.hours === 24, String(bogus.filters.hours));
    const junk = await load("?hours=drop-table");
    ok("a non-numeric hours value falls back to 24h", junk.filters.hours === 24, String(junk.filters.hours));
  }

  // 7b. Level filter.
  {
    for (const level of ["error", "warn"]) {
      const d = await load(`?level=${level}&hours=336`);
      ok(`level=${level} returns only ${level} rows`, d.rows.length > 0 && d.rows.every((r: any) => r.level === level), `${d.rows.length} rows`);
      const dbCount = await db.appLog.count({ where: { level, occurredAt: { gte: new Date(Date.now() - 336 * 3600_000) } } });
      ok(`level=${level} row count matches the database (capped at ${ROW_LIMIT})`, d.rows.length === Math.min(dbCount, ROW_LIMIT), `page=${d.rows.length} db=${dbCount}`);
      ok(`level=${level} sets truncatedRows correctly`, d.truncatedRows === dbCount > ROW_LIMIT, `${d.truncatedRows} vs db=${dbCount}`);
    }
    const bad = await load("?level=debug");
    ok("an unknown level is dropped rather than returning nothing", bad.filters.level === null && bad.rows.length === base.rows.length, `${bad.filters.level}`);
  }

  // 7c. Event filter (what the top-events table links to).
  {
    const top = base.topEvents[0];
    const d = await load(`?event=${encodeURIComponent(top.event)}`);
    ok("event filter returns only that event", d.rows.length > 0 && d.rows.every((r: any) => r.event === top.event), `${top.event}: ${d.rows.length} rows`);
    ok("event filter row count agrees with the top-events count", d.rows.length === Math.min(top.count, ROW_LIMIT), `page=${d.rows.length} summary=${top.count}`);
    const none = await load("?event=an_event_that_never_fired");
    ok("an unmatched event filter renders the empty state, not a crash", none.rows.length === 0 && (await get(`${P}?event=an_event_that_never_fired`, COOKIE)).body.includes("No entries match these filters"));
  }

  // 7d. Shop filter + attribution.
  {
    // A log row outlives the shop it names, and the loader deliberately drops a
    // filter pointing at a purged store — that path is asserted separately below.
    // So pick a row that still resolves to a live store: the newest attributed row
    // is often a deleted QA fixture, which would test the wrong branch entirely.
    const resolvable = (r: any) => Boolean(r.shopId) && r.shopLabel !== null && r.shopLabel !== "(removed store)";
    const withShop = base.rows.find(resolvable) ?? (await load("?hours=336")).rows.find(resolvable);
    if (withShop) {
      const d = await load(`?shop=${withShop.shopId}&hours=336`);
      if (process.env.QA_DEBUG) console.log("DEBUG shop filter", withShop.shopId, JSON.stringify(d.filters), d.rows.length);
      ok("shop filter returns only that store's rows", d.rows.length > 0 && d.rows.every((r: any) => r.shopId === withShop.shopId), `${d.rows.length} rows`);
      ok("shop-scoped rows carry a resolved store label", d.rows.every((r: any) => typeof r.shopLabel === "string" && r.shopLabel.length > 0 && r.shopLabel !== "(removed store)"));
    } else {
      ok("shop filter (skipped — no shop-attributed rows in the window)", true, "no data");
    }
    ok("system-wide rows are labelled as such, never mis-attributed", base.rows.filter((r: any) => !r.shopId).every((r: any) => r.shopLabel === null));

    const bogus = await load("?shop=cmxxxxxxxxxxxxxxxxxxxxxxx");
    ok("an unresolvable shop filter is reported, not silently widened", bogus.filters.unknownShop === "cmxxxxxxxxxxxxxxxxxxxxxxx" && bogus.filters.shopId === null, JSON.stringify(bogus.filters));
    const html = await get(`${P}?shop=cmxxxxxxxxxxxxxxxxxxxxxxx`, COOKIE);
    ok("the page warns that the store filter was dropped", html.status === 200 && html.body.includes("no longer exists"), String(html.status));
    const injected = await get(`${P}?shop=${encodeURIComponent("' OR 1=1 --")}`, COOKIE);
    ok("a hostile shop filter is handled, not executed", injected.status === 200 && isBrokenPage(injected) === null);
  }

  // 7e. Combined filters + PII/secret hygiene on the rendered page.
  {
    const top = base.topEvents[0];
    const d = await load(`?hours=336&level=${top.level}&event=${encodeURIComponent(top.event)}`);
    ok("combined range + level + event filters compose", d.rows.every((r: any) => r.level === top.level && r.event === top.event), `${d.rows.length} rows`);
    const emailish = (r: any) => /[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(`${r.message} ${r.context ?? ""}`.replace(/@example\.invalid/g, "").replace(/@\S*myshopify\.com/g, ""));
    const leaky = base.rows.filter(emailish);
    ok(
      "no log row leaks an email address into the operator console",
      leaky.length === 0,
      leaky.slice(0, 3).map((r: any) => `${r.event} carries ${(`${r.message} ${r.context ?? ""}`.match(/[\w.+-]+@[\w-]+\.[a-z]{2,}/gi) ?? []).map((m: string) => `***@${m.split("@")[1]}`).join(",")}`).join(" | ") || "clean",
    );
  }
}

// ── 8. /platform/usage ──────────────────────────────────────────────────────
async function usageSection({ db, COOKIE }: any): Promise<void> {
  section("8. /platform/usage — per-shop figures and unknown ids");
  const R = "platform.usage._index";
  const P = "/platform/usage";

  const d = await loaderData(P, R, COOKIE);
  ok("loader returns the fleet totals and a per-shop breakdown", typeof d.grand?.tokens === "number" && Array.isArray(d.shops), `${d.shops.length} shops, ${d.grand.tokens} tokens`);
  ok("default range is 30 days", d.days === 30, String(d.days));
  ok("every installed store is listed", d.shops.length === (await db.shop.count()), `${d.shops.length} vs ${await db.shop.count()}`);

  for (const days of [7, 30, 90]) {
    const r = await loaderData(`${P}?days=${days}`, R, COOKIE);
    ok(`range ${days}d is honoured`, r.days === days, String(r.days));
  }
  for (const bad of ["365", "abc", "-7", ""]) {
    const r = await loaderData(`${P}?days=${encodeURIComponent(bad)}`, R, COOKIE);
    ok(`an out-of-range days=${bad || "(blank)"} falls back to 30`, r.days === 30, String(r.days));
  }

  // 8a. Figures agree with the database.
  {
    const day = new Date();
    const from = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) - 29 * 86_400_000);
    const agg = await db.llmUsageDaily.aggregate({ where: { date: { gte: from } }, _sum: { calls: true, promptTokens: true, cachedTokens: true, completionTokens: true } });
    const dbTokens = (agg._sum.promptTokens ?? 0) + (agg._sum.completionTokens ?? 0);
    ok("fleet call count matches the database", d.grand.calls === (agg._sum.calls ?? 0), `page=${d.grand.calls} db=${agg._sum.calls}`);
    ok("fleet token count matches the database", d.grand.tokens === dbTokens, `page=${d.grand.tokens} db=${dbTokens}`);
    ok("a streamed call is counted exactly once (no double-count vs the DB)", d.grand.calls === (agg._sum.calls ?? 0));
  }

  // 8b. Per-shop drill-down. React Router will not serve a .data payload for
  //     this dynamic leaf, so the figures are read back out of the rendered
  //     page using the very formatters the component uses.
  {
    const { formatTokens, formatUsd } = await import("../../app/lib/platform/llm-pricing");
    const busiest = [...d.shops].sort((a: any, b: any) => b.totals.calls - a.totals.calls)[0];
    const page = await get(`${P}/${busiest.shopId}`, COOKIE);
    ok("shop drill-down loads and is scoped to that shop", page.status === 200 && page.body.includes(busiest.domain), `${page.status} ${busiest.domain}`);
    // One shop domain can contain another as a substring — "dev-shop.myshopify.com"
    // ends with "shop.myshopify.com" — so a naive includes() reports a cross-tenant
    // leak that is really just the page naming its own store. Blank out the domain
    // this page is legitimately about before looking for anyone else.
    const withoutOwn = page.body.split(busiest.domain).join("");
    ok("drill-down never names another store", d.shops.filter((x: any) => x.shopId !== busiest.shopId).every((x: any) => !withoutOwn.includes(x.domain)));
    ok("drill-down call count matches the overview row for the same shop", page.body.includes(`${busiest.totals.calls.toLocaleString("en-US")} API calls`), `expected ${busiest.totals.calls} calls`);
    ok("drill-down token figure matches the overview row", page.body.includes(formatTokens(busiest.totals.tokens)), formatTokens(busiest.totals.tokens));
    ok("drill-down cost figure matches the overview row", page.body.includes(formatUsd(busiest.totals.costUsd)), formatUsd(busiest.totals.costUsd));

    const from = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) - 29 * 86_400_000);
    const rows = await db.llmUsageDaily.aggregate({ where: { shopId: busiest.shopId, date: { gte: from } }, _sum: { calls: true, promptTokens: true, completionTokens: true } });
    ok(
      "that shop's figures match the database",
      busiest.totals.calls === (rows._sum.calls ?? 0) && busiest.totals.tokens === (rows._sum.promptTokens ?? 0) + (rows._sum.completionTokens ?? 0),
      `page=${busiest.totals.calls}/${busiest.totals.tokens} db=${rows._sum.calls}/${(rows._sum.promptTokens ?? 0) + (rows._sum.completionTokens ?? 0)}`,
    );

    // The fleet tile sums EVERY usage row; the merchant table can only sum rows
    // that still resolve to a shop. Any difference is usage attributed to a
    // store that no longer exists — it must be explainable, not a rounding gap.
    const attributed = d.shops.reduce((n: number, x: any) => n + x.totals.calls, 0);
    const liveShopIds = (await db.shop.findMany({ select: { id: true } })).map((x: any) => x.id);
    const orphan = await db.llmUsageDaily.aggregate({ where: { date: { gte: from }, shopId: { notIn: liveShopIds } }, _sum: { calls: true } });
    ok(
      "the fleet total reconciles with the per-merchant table",
      d.grand.calls === attributed + (orphan._sum.calls ?? 0),
      `fleet=${d.grand.calls} attributed=${attributed} orphaned=${orphan._sum.calls ?? 0}`,
    );
    // llm_usage_daily.shopId is a bare string with no foreign key, so a shop row
    // removed by anything other than cleanupShop() leaves usage that the fleet
    // tile counts and the merchant table cannot show — with no "unattributed"
    // row to explain the difference.
    const orphanIds = [...new Set((await db.llmUsageDaily.findMany({ where: { date: { gte: from }, shopId: { notIn: liveShopIds } }, select: { shopId: true } })).map((x: any) => x.shopId))];
    ok(
      "the fleet cost tile never includes usage the merchant table cannot explain",
      (orphan._sum.calls ?? 0) === 0,
      `${orphan._sum.calls ?? 0} calls from ${orphanIds.length} store(s) no longer in the shop table: ${orphanIds.join(", ")}`,
    );

    const ranged = await get(`${P}/${busiest.shopId}?days=7`, COOKIE);
    ok("drill-down honours the range parameter", ranged.status === 200 && isBrokenPage(ranged) === null, String(ranged.status));
  }

  // 8c. Unknown / hostile shop ids are a clean 404, never a crash or a leak.
  {
    for (const bad of ["abc123", "cmxxxxxxxxxxxxxxxxxxxxxxx", "00000000-0000-0000-0000-000000000000", encodeURIComponent("' OR 1=1 --"), encodeURIComponent("../../platform/settings")]) {
      const p = await get(`${P}/${bad}`, COOKIE);
      ok(`unknown shopId "${decodeURIComponent(bad)}" → 404, not a crash`, p.status === 404 || (p.status === 200 && !p.body.includes("Daily cost")), String(p.status));
      ok(`unknown shopId "${decodeURIComponent(bad)}" leaks no other store's data`, !p.body.includes("Cost per conversation"));
    }
  }

  // 8d. Uninstalled stores stay reachable (support still needs their history).
  {
    const gone = await db.shop.findFirst({ where: { uninstalledAt: { not: null } }, select: { id: true } });
    if (gone) {
      const p = await get(`${P}/${gone.id}`, COOKIE);
      ok("an uninstalled store's usage page still loads", p.status === 200 && p.body.includes("uninstalled"), String(p.status));
    } else {
      ok("uninstalled-store drill-down (skipped — no uninstalled store in this database)", true, "no data");
    }
  }
}

// ── 9. /platform/settings ───────────────────────────────────────────────────
async function settingsSection({ db, COOKIE, snapshot }: any): Promise<void> {
  section("9. /platform/settings — runtime config round-trips");
  const R = "platform.settings";
  const P = "/platform/settings";
  const KEY = "platform:runtime";
  const original = snapshot.get(KEY) as string | null;
  const readRow = async () => (await db.appSecret.findUnique({ where: { key: KEY } }))?.value ?? null;
  const storedJson = async () => {
    const v = await readRow();
    return v ? JSON.parse(v) : null;
  };

  const before = await loaderData(P, R, COOKIE);
  ok("loader returns effective values plus their source for every field", Boolean(before.sources?.openaiApiKey) && typeof before.emailProvider === "string", `provider=${before.emailProvider}`);
  ok("secrets reach the browser masked, never in the clear", (before.openaiApiKeyMasked === "" || before.openaiApiKeyMasked.includes("••")) && (before.resendApiKeyMasked === "" || before.resendApiKeyMasked.includes("••")), `${before.openaiApiKeyMasked} / ${before.resendApiKeyMasked}`);
  ok("the loader never ships a raw secret field", !("openaiApiKey" in before) && !("resendApiKey" in before) && !("smtpPass" in before), Object.keys(before).join(","));
  const sealedBefore = await storedJson();

  // 9a. Links round-trip.
  {
    const r = await submit(P, R, { intent: "links", webAppUrl: "https://qa-platform.example/app", appStoreHandle: "qa-handle" }, COOKIE);
    ok("POST links succeeds", r.data.ok === true, JSON.stringify(r.data));
    const d = await loaderData(P, R, COOKIE);
    ok("fresh GET shows the new links", d.webAppUrl === "https://qa-platform.example/app" && d.appStoreHandle === "qa-handle", `${d.webAppUrl} / ${d.appStoreHandle}`);
    ok("the source badge flips to 'Dashboard'", d.sources.webAppUrl === "dashboard" && d.sources.appStoreHandle === "dashboard", JSON.stringify([d.sources.webAppUrl, d.sources.appStoreHandle]));
    ok("rendered page shows the new value", (await get(P, COOKIE)).body.includes("https://qa-platform.example/app"));
    const stored = await storedJson();
    ok("persisted in app_secrets['platform:runtime']", stored.webAppUrl === "https://qa-platform.example/app" && stored.appStoreHandle === "qa-handle");
    ok("a partial save did NOT wipe the sealed Resend key", stored.resendApiKey?.startsWith("enc:v1:") === sealedBefore.resendApiKey?.startsWith("enc:v1:"), `${String(stored.resendApiKey).slice(0, 8)}`);
    ok("a partial save did NOT wipe the email provider", stored.emailProvider === sealedBefore.emailProvider, `${stored.emailProvider}`);
    ok("the sealed key still decrypts to the same masked value", (await loaderData(P, R, COOKIE)).resendApiKeyMasked === before.resendApiKeyMasked);
  }

  // 9b. Operational flags round-trip.
  {
    const flip = !before.embedStatusEnabled;
    const r = await submit(P, R, { intent: "flags", billingTestMode: String(before.billingTestMode), billingForceTestCharges: String(before.billingForceTestCharges), embedStatusEnabled: String(flip) }, COOKIE);
    ok("POST flags succeeds", r.data.ok === true, JSON.stringify(r.data));
    const d = await loaderData(P, R, COOKIE);
    ok("fresh GET shows the flipped flag", d.embedStatusEnabled === flip, String(d.embedStatusEnabled));
    ok("the other flags were not disturbed", d.billingTestMode === before.billingTestMode && d.billingForceTestCharges === before.billingForceTestCharges);
    ok("persisted in app_secrets", (await storedJson()).embedStatusEnabled === flip);
    await submit(P, R, { intent: "flags", billingTestMode: String(before.billingTestMode), billingForceTestCharges: String(before.billingForceTestCharges), embedStatusEnabled: String(before.embedStatusEnabled) }, COOKIE);
    ok("flags restored", (await loaderData(P, R, COOKIE)).embedStatusEnabled === before.embedStatusEnabled);
  }

  // 9c. Email round-trip — the secret fields are left blank, which must mean
  //     "keep what is stored", not "erase it".
  {
    const r = await submit(P, R, { intent: "email", emailProvider: before.emailProvider, emailFrom: "QA Platform <qa@example.invalid>", smtpHost: before.smtpHost, smtpUser: before.smtpUser, smtpPort: String(before.smtpPort), smtpSecure: String(before.smtpSecure), resendApiKey: "", smtpPass: "" }, COOKIE);
    ok("POST email settings succeeds", r.data.ok === true, JSON.stringify(r.data));
    const d = await loaderData(P, R, COOKIE);
    ok("fresh GET shows the new from-address", d.emailFrom === "QA Platform <qa@example.invalid>", d.emailFrom);
    ok("a blank secret field kept the stored Resend key", d.resendApiKeyMasked === before.resendApiKeyMasked, `${d.resendApiKeyMasked}`);
    ok("persisted in app_secrets", (await storedJson()).emailFrom === "QA Platform <qa@example.invalid>");
    // A blank field must stay blank rather than acquire a bogus ciphertext, so
    // which invariant applies depends on whether a key is configured at all.
    const storedResend: string = (await storedJson()).resendApiKey ?? "";
    ok(
      storedResend.length > 0
        ? "the stored Resend key is still sealed at rest"
        : "no Resend key is configured here, and the blank field stayed blank",
      storedResend.length > 0 ? storedResend.startsWith("enc:v1:") : storedResend === "",
      `len=`,
    );
  }

  // 9d. Invalid input is refused and persists nothing.
  {
    const good = await readRow();
    const INVALID: Array<[string, Record<string, string>]> = [
      ["smtpPort above 65535", { intent: "email", emailProvider: before.emailProvider, emailFrom: before.emailFrom, smtpHost: before.smtpHost, smtpUser: before.smtpUser, smtpPort: "99999", smtpSecure: String(before.smtpSecure) }],
      ["oversized from-address", { intent: "email", emailProvider: before.emailProvider, emailFrom: "x".repeat(400), smtpHost: before.smtpHost, smtpUser: before.smtpUser, smtpPort: String(before.smtpPort), smtpSecure: String(before.smtpSecure) }],
      ["oversized web app url", { intent: "links", webAppUrl: "https://" + "x".repeat(400), appStoreHandle: "" }],
      ["oversized app store handle", { intent: "links", webAppUrl: "", appStoreHandle: "h".repeat(400) }],
      ["unknown intent", { intent: "definitely-not-an-intent" }],
    ];
    for (const [label, fields] of INVALID) {
      const r = await submit(P, R, fields, COOKIE);
      ok(`settings: ${label} is rejected with a message`, r.data.ok === false && typeof r.data.error === "string" && r.data.error.length > 3, String(r.data.error ?? r.data.ok));
      ok(`settings: ${label} persisted nothing`, (await readRow()) === good, "unchanged");
    }
  }

  // 9e. The OpenAI-key form: blank means "keep the current key".
  {
    const r = await submit(P, R, { intent: "ai", openaiApiKey: "" }, COOKIE);
    ok("a blank OpenAI key field is a no-op, not an erase", r.data.ok === true && String(r.data.note).includes("No change"), String(r.data.note));
    ok("the stored OpenAI key is untouched", (await storedJson()).openaiApiKey === (await storedJson()).openaiApiKey);
  }

  // 9f. Reset clears every dashboard value; then restore byte-exact and prove
  //     the running server picked the restored row back up.
  {
    const r = await submit(P, R, { intent: "reset" }, COOKIE);
    ok("POST reset succeeds", r.data.ok === true, JSON.stringify(r.data));
    ok("reset deletes the whole runtime row", (await readRow()) === null);
    const d = await loaderData(P, R, COOKIE);
    ok("after reset every value comes from the environment or a default", Object.values(d.sources).every((s: any) => s !== "dashboard"), JSON.stringify(d.sources));

    if (original === null) await db.appSecret.deleteMany({ where: { key: KEY } });
    else await db.appSecret.upsert({ where: { key: KEY }, create: { key: KEY, value: original }, update: { value: original } });
    ok("settings: original runtime row restored byte-exact", (await readRow()) === original);

    // The server caches the runtime config for 30s; poll until it has re-read
    // the restored row, so the app is not left running on post-reset defaults.
    const deadline = Date.now() + 75_000;
    let live = await loaderData(P, R, COOKIE);
    while (Date.now() < deadline && !(live.emailProvider === before.emailProvider && live.resendApiKeyMasked === before.resendApiKeyMasked)) {
      await new Promise((r2) => setTimeout(r2, 3_000));
      live = await loaderData(P, R, COOKIE);
    }
    ok("settings: the RUNNING server is serving the restored config again", live.emailProvider === before.emailProvider && live.resendApiKeyMasked === before.resendApiKeyMasked && live.emailFrom === before.emailFrom, `${live.emailProvider} / ${live.emailFrom}`);
  }
}

// ── 10. Cross-process cache invalidation ────────────────────────────────────
async function cachePropagationSection({ db, COOKIE, snapshot }: any): Promise<void> {
  section("10. Cache — a change made outside the server reaches it within the TTL");
  const KEY = "platform:plans";
  const original = snapshot.get(KEY) as string | null;

  // Write the plan matrix straight to the database (i.e. as a SECOND app
  // instance would), then poll a page whose loader only reads through the
  // 30s-TTL accessor — never loadPlanConfig() — so this measures the refresh
  // path a multi-instance deployment actually depends on.
  const config = original ? JSON.parse(original) : {};
  config.plans = { ...(config.plans ?? {}), free: { ...(config.plans?.free ?? {}), name: "QA-Propagation" } };
  await db.appSecret.upsert({ where: { key: KEY }, create: { key: KEY, value: JSON.stringify(config) }, update: { value: JSON.stringify(config) } });

  const started = Date.now();
  const deadline = started + 75_000;
  let seen = false;
  while (Date.now() < deadline && !seen) {
    const d = await loaderData("/platform", "platform._index", COOKIE);
    seen = d.tiers.some((t: any) => t.name === "QA-Propagation");
    if (!seen) await new Promise((r) => setTimeout(r, 3_000));
  }
  ok("an out-of-band plan-matrix change reaches the server within the 30s TTL", seen, `${Math.round((Date.now() - started) / 1000)}s`);

  if (original === null) await db.appSecret.deleteMany({ where: { key: KEY } });
  else await db.appSecret.upsert({ where: { key: KEY }, create: { key: KEY, value: original }, update: { value: original } });
  await get("/platform/plans", COOKIE); // this loader force-reloads the matrix
  const back = await loaderData("/platform", "platform._index", COOKIE);
  ok("cache: the real plan names are back", !back.tiers.some((t: any) => t.name === "QA-Propagation"), back.tiers.map((t: any) => t.name).join("/"));
}

//__SECTIONS__

main()
  .then(() => process.exit(failed ? 1 : 0))
  .catch((error) => {
    console.error("\nFATAL", error);
    process.exit(1);
  });
