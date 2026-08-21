/* QA: routing / guard-order sweep across all three surfaces (embedded admin,
 * web, platform) plus the app proxy and webhooks.
 *
 *   Run: npx tsx scripts/qa/routing.test.ts
 *   Needs: the dev server on http://localhost:3000 (BASE_URL to override) and
 *          the dev Postgres up.
 *
 * Everything it creates is deleted again in the finally block, and the shared
 * app/db.server singleton is disconnected there too — without that the process
 * hangs forever.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Load .env manually (tsx does not) BEFORE importing app modules.
for (const line of readFileSync(join(process.cwd(), ".env"), "utf-8").split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (match && !line.trim().startsWith("#") && process.env[match[1]] === undefined) {
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}

// app/lib/access.server.ts pulls in app/shopify.server.ts, which refuses to
// initialise without the CLI-injected app credentials. Nothing here talks to
// Shopify — placeholders keep the import graph loadable outside `npm run dev`.
process.env.SHOPIFY_API_KEY ||= "qa-placeholder-key";
process.env.SHOPIFY_API_SECRET ||= "qa-placeholder-secret";
process.env.SHOPIFY_APP_URL ||= process.env.BASE_URL ?? "http://localhost:3000";
process.env.SCOPES ||= "read_products";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
// The Shopify library 410s anything isbot() flags, so every probe must look
// like a browser or the whole sweep measures the bot guard instead of auth.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const ROUTES_DIR = join(process.cwd(), "app", "routes");

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

interface Probe {
  status: number;
  location: string | null;
  body: string;
  headers: Headers;
}

async function probe(
  path: string,
  init: { method?: string; cookie?: string; body?: BodyInit; headers?: Record<string, string> } = {},
): Promise<Probe> {
  const headers: Record<string, string> = { "user-agent": UA, ...(init.headers ?? {}) };
  if (init.cookie) headers.cookie = init.cookie;
  const res = await fetch(BASE + path, {
    method: init.method ?? "GET",
    headers,
    body: init.body,
    redirect: "manual",
  });
  const body = await res.text();
  return { status: res.status, location: res.headers.get("location"), body, headers: res.headers };
}

/** A 2xx that is really the App Bridge session-token bounce page, not app data. */
function isBouncePage(p: Probe): boolean {
  return p.status === 200 && p.body.includes("app-bridge.js") && !p.body.includes('"surface"');
}

/** Anything that is NOT "here is your data": redirect, 4xx, or the bounce page. */
function isBlocked(p: Probe): boolean {
  if (p.status >= 300 && p.status < 400) return true;
  if (p.status >= 400) return true;
  return isBouncePage(p);
}

// ── Route inventory ─────────────────────────────────────────────────────────

const APP_ROUTES = [
  "app.tsx",
  "app._index.tsx",
  "app.account.tsx",
  "app.ai-agent.tsx",
  "app.ai-agent.instructions.tsx",
  "app.ai-agent.review.tsx",
  "app.ai-agent.test.tsx",
  "app.ai-agent.training.tsx",
  "app.analytics.tsx",
  "app.billing-callback.tsx",
  "app.browse-data.tsx",
  "app.chatbox.tsx",
  "app.contacts.tsx",
  "app.curated-answers.tsx",
  "app.inbox.tsx",
  "app.inbox-events.tsx",
  "app.plan-usage.tsx",
  "app.proactive-chat.tsx",
  "app.push-subscription.tsx",
  "app.settings.tsx",
  "app.web-handoff.tsx",
];
const WEB_ROUTES = [
  "web.tsx",
  "web._index.tsx",
  "web.forgot.tsx",
  "web.handoff.tsx",
  "web.invite.$token.tsx",
  "web.login.tsx",
  "web.logout.tsx",
  "web.reset.$token.tsx",
];
const PLATFORM_ROUTES = [
  "platform.tsx",
  "platform._index.tsx",
  "platform.admins.tsx",
  "platform.ai.tsx",
  "platform.login.tsx",
  "platform.logout.tsx",
  "platform.logs.tsx",
  "platform.plans.tsx",
  "platform.promo-codes.tsx",
  "platform.settings.tsx",
  "platform.usage._index.tsx",
  "platform.usage.$shopId.tsx",
];
const PROXY_PATHS = [
  "/proxy/ping",
  "/proxy/widget-config",
  "/proxy/history",
  "/proxy/messages",
  "/proxy/faq-search",
  "/proxy/chat",
  "/proxy/event",
  "/proxy/handover-form",
  "/proxy/order-track",
  "/proxy/prechat",
  "/proxy/survey",
];
const PROXY_LOADER_ONLY = new Set([
  "/proxy/ping",
  "/proxy/widget-config",
  "/proxy/history",
  "/proxy/messages",
  "/proxy/faq-search",
]);
const WEBHOOK_PATHS = [
  "/webhooks/app/scopes_update",
  "/webhooks/app/uninstalled",
  "/webhooks/app-subscriptions",
  "/webhooks/collections",
  "/webhooks/compliance",
  "/webhooks/discounts",
  "/webhooks/metafield-definitions",
  "/webhooks/products",
];

/** Every /app/* page that renders (resource routes excluded). */
const APP_PAGES: Array<{ path: string; permission: string }> = [
  { path: "/app", permission: "dashboard" },
  { path: "/app/inbox", permission: "inbox" },
  { path: "/app/contacts", permission: "contacts" },
  { path: "/app/chatbox", permission: "chatbox" },
  { path: "/app/ai-agent", permission: "ai_agent" },
  { path: "/app/ai-agent/instructions", permission: "ai_agent" },
  { path: "/app/ai-agent/review", permission: "ai_agent" },
  { path: "/app/ai-agent/test", permission: "ai_agent" },
  { path: "/app/ai-agent/training", permission: "ai_agent" },
  { path: "/app/proactive-chat", permission: "proactive" },
  { path: "/app/curated-answers", permission: "curated" },
  { path: "/app/analytics", permission: "analytics" },
  { path: "/app/plan-usage", permission: "plan" },
  { path: "/app/settings", permission: "settings" },
];

const TAG = "qa-routing";

async function main(): Promise<void> {
  const db = (await import("../../app/db.server")).default;
  const { can } = await import("../../app/lib/access.server");
  const { mintToken } = await import("../../app/lib/team/tokens.server");

  // Reachability gate — everything below is HTTP.
  try {
    const res = await fetch(`${BASE}/web/login`, { headers: { "user-agent": UA } });
    if (!res.ok) throw new Error(`status ${res.status}`);
  } catch (error) {
    // Never let an unreachable server look like a clean run — record a real
    // failure so the exit code is non-zero and the gap is visible.
    ok(`dev server reachable at ${BASE}`, false, `run \`npm run dev\` first — HTTP coverage NOT executed (${String(error)})`);
    return;
  }

  // ── Section 1: route files exist ──────────────────────────────────────────
  section("1. Route inventory (files resolve)");
  const groups: Array<[string, string[]]> = [
    ["app.*", APP_ROUTES],
    ["web.*", WEB_ROUTES],
    ["platform.*", PLATFORM_ROUTES],
    ["proxy.*", PROXY_PATHS.map((p) => `proxy.${p.split("/")[2]}.tsx`)],
    ["webhooks.*", WEBHOOK_PATHS.map((p) => `webhooks.${p.replace("/webhooks/", "").replace(/\//g, ".")}.tsx`)],
  ];
  for (const [label, files] of groups) {
    const missing = files.filter((f) => !existsSync(join(ROUTES_DIR, f)));
    ok(`${label} route modules present (${files.length})`, missing.length === 0, missing.join(", "));
  }
  ok("auth.$ present", existsSync(join(ROUTES_DIR, "auth.$.tsx")));
  // /auth/login (the template's .myshopify.com shop-domain form) was removed
  // for App Store req 2.3.1. It must be GONE — no route, no `login` export, no
  // redirect_urls entry, and nothing anywhere that asks for a shop domain.
  {
    const toml = readFileSync(join(process.cwd(), "shopify.app.toml"), "utf-8");
    ok("auth.login route directory is gone", !existsSync(join(ROUTES_DIR, "auth.login")));
    ok(
      "shopify.server.ts no longer exports `login`",
      !/^\s*export\s+const\s+login\s*=/m.test(readFileSync(join(process.cwd(), "app", "shopify.server.ts"), "utf-8")),
    );
    ok("/auth/login is no longer a declared redirect_url", !toml.includes("/auth/login"));
    // No surviving route may render a shop-domain input (req 2.3.1).
    const offenders: string[] = [];
    for (const file of readdirSync(ROUTES_DIR, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(".tsx")) continue;
      const src = readFileSync(join(ROUTES_DIR, file.name), "utf-8");
      if (/name=["']shop["']|myshopify\.com["']?\s*\/?>/.test(src) && /<(input|s-text-field|s-email-field)/i.test(src)) {
        offenders.push(file.name);
      }
    }
    ok("no route renders a shop-domain input", offenders.length === 0, offenders.join(", "));

    const p = await probe("/auth/login?shop=dev-shop.myshopify.com");
    ok("/auth/login does not serve a page", p.status !== 200, String(p.status));
    ok(
      "/auth/login 404s rather than 500s",
      p.status === 404,
      `${p.status} — ${p.body.slice(0, 160).replace(/\s+/g, " ")}`,
    );

    // Every declared OAuth redirect URL must have a route behind it.
    const start = toml.indexOf("redirect_urls = [");
    const block = start === -1 ? "" : toml.slice(start, toml.indexOf("]", start));
    for (const m of block.matchAll(/"https?:\/\/[^"/]+(\/[^"]*)"/g)) {
      const r = await probe(m[1]);
      ok(`declared redirect_url ${m[1]} resolves`, r.status !== 404, `${r.status} — no route for this path`);
    }
  }
  ok("api.test-chat + _index present", existsSync(join(ROUTES_DIR, "api.test-chat.tsx")) && existsSync(join(ROUTES_DIR, "_index", "route.tsx")));

  // ── Section 2: NAV integrity ──────────────────────────────────────────────
  section("2. NAV integrity (app/routes/app.tsx)");
  const appLayout = readFileSync(join(ROUTES_DIR, "app.tsx"), "utf-8");
  const navBlock = appLayout.slice(appLayout.indexOf("const NAV"), appLayout.indexOf("];", appLayout.indexOf("const NAV")));
  const navEntries = [...navBlock.matchAll(/href:\s*"([^"]+)"[\s\S]*?permission:\s*"([^"]+)"/g)].map((m) => ({
    href: m[1],
    permission: m[2],
  }));
  ok("NAV parsed", navEntries.length === 10, `${navEntries.length} entries`);
  for (const entry of navEntries) {
    const file = entry.href === "/app" ? "app._index.tsx" : `${entry.href.slice(1).replace(/\//g, ".")}.tsx`;
    ok(`NAV ${entry.href} → ${file}`, existsSync(join(ROUTES_DIR, file)));
  }
  // Nav filtering must equal the can() matrix, not a hand-maintained list.
  for (const role of ["owner", "admin", "agent"] as const) {
    const visible = navEntries.filter((e) => can(role, "web", e.permission as never)).map((e) => e.href);
    const expected =
      role === "agent"
        ? ["/app/inbox", "/app/contacts"]
        : navEntries.map((e) => e.href);
    ok(
      `nav filter matches can() for ${role}`,
      JSON.stringify(visible) === JSON.stringify(expected),
      visible.join(","),
    );
  }
  ok(
    "billing_manage is admin-surface only, for every role",
    (["owner", "admin", "agent"] as const).every((r) => can(r, "admin", "billing_manage") && !can(r, "web", "billing_manage")),
  );

  // ── Section 3: unauthenticated sweep ──────────────────────────────────────
  section("3. Unauthenticated requests leak nothing");
  for (const page of APP_PAGES) {
    const p = await probe(page.path);
    ok(`GET ${page.path} blocked when signed out`, isBlocked(p), `${p.status}${isBouncePage(p) ? " bounce" : ""}`);
  }
  for (const path of ["/app/browse-data", "/app/billing-callback"]) {
    const p = await probe(path);
    ok(`GET ${path} blocked when signed out`, isBlocked(p), String(p.status));
  }
  for (const path of ["/app/inbox-events", "/app/push-subscription", "/app/web-handoff", "/api/test-chat"]) {
    const p = await probe(path, { method: "POST", body: new URLSearchParams({ x: "1" }) });
    ok(`POST ${path} blocked when signed out`, isBlocked(p), String(p.status));
  }

  section("3b. Public routes still render");
  for (const [path, expected] of [
    ["/", 200],
    ["/web/login", 200],
    ["/web/forgot", 200],
    ["/web/handoff", 200],
    ["/web/invite/not-a-real-token", 200],
    ["/web/reset/not-a-real-token", 200],
    ["/platform/login", 200],
  ] as Array<[string, number]>) {
    const p = await probe(path);
    ok(`GET ${path} → ${expected}`, p.status === expected, String(p.status));
  }

  // ── Section 4: redirect targets ───────────────────────────────────────────
  section("4. Redirect targets");
  {
    const p = await probe("/web");
    ok("/web (signed out) → /web/login", p.status === 302 && (p.location ?? "").endsWith("/web/login"), `${p.status} ${p.location}`);
  }
  {
    // The marketing page is load-bearing: Shopify bounces merchants through it
    // with ?shop=… on the way into the embedded app.
    const p = await probe("/?shop=dev-shop.myshopify.com&host=abc");
    ok("/?shop=… → /app?shop=…", p.status === 302 && (p.location ?? "").startsWith("/app?shop="), `${p.status} ${p.location}`);
  }
  {
    const p = await probe("/platform");
    ok("/platform (signed out) → /platform/login", p.status === 302 && (p.location ?? "").includes("/platform/login"), `${p.status} ${p.location}`);
  }
  for (const path of ["/platform/admins", "/platform/ai", "/platform/logs", "/platform/plans", "/platform/promo-codes", "/platform/settings", "/platform/usage", "/platform/usage/abc123"]) {
    const p = await probe(path);
    ok(
      `${path} (signed out) → /platform/login?next=`,
      p.status === 302 && (p.location ?? "").includes(`/platform/login?next=${encodeURIComponent(path)}`),
      `${p.status} ${p.location}`,
    );
  }
  {
    // /platform?tab=… : the guard preserves the query string on the bounce.
    const p = await probe("/platform/usage?range=90d");
    const loc = p.location ?? "";
    ok(
      "/platform deep link keeps its query on the auth bounce",
      loc.includes(encodeURIComponent("/platform/usage?range=90d")),
      loc,
    );
  }

  section("4b. Web-surface bounce keeps deep links");
  for (const [path, expectNext] of [
    ["/app/inbox?c=conv_123", "/app/inbox?c=conv_123"],
    ["/app/settings?tab=team", "/app/settings?tab=team"],
    ["/app/analytics?range=30d", "/app/analytics?range=30d"],
  ] as Array<[string, string]>) {
    const p = await probe(path, { cookie: "cc_surface=web" });
    ok(
      `surface marker: ${path} → /web/login?next=${expectNext}`,
      p.status === 302 && (p.location ?? "") === `/web/login?next=${encodeURIComponent(expectNext)}`,
      `${p.status} ${p.location}`,
    );
  }
  {
    const p = await probe("/app/analytics", { cookie: "cc_web_session=this-token-does-not-exist" });
    const setCookie = p.headers.get("set-cookie") ?? "";
    ok(
      "stale cc_web_session → /web/login and the cookie is cleared",
      p.status === 302 && (p.location ?? "").startsWith("/web/login?next=") && /cc_web_session=;/.test(setCookie) && /Max-Age=0/.test(setCookie),
      `${p.status} ${p.location} | ${setCookie}`,
    );
  }

  // ── Section 4c: document security headers ─────────────────────────────────
  section("4c. Security headers on document responses (app/entry.server.tsx)");
  {
    // Structural guarantees first, so this holds even without a live server.
    const entry = readFileSync(join(process.cwd(), "app", "entry.server.tsx"), "utf-8");
    ok(
      "nosniff is set unconditionally, before any branch",
      /responseHeaders\.set\("X-Content-Type-Options",\s*"nosniff"\)/.test(entry) &&
        entry.indexOf('X-Content-Type-Options') < entry.indexOf("frame-ancestors"),
    );
    ok(
      "/platform is in the frame-ancestors 'none' branch (not just /web)",
      /platformPage\s*=\s*pathname === "\/platform" \|\| pathname\.startsWith\("\/platform\/"\)/.test(entry) &&
        /if \(webAuthPage \|\| platformPage/.test(entry),
      "a ?shop= param would otherwise let the operator console be framed",
    );
    ok("the deny branch also sets Cache-Control: no-store", /frame-ancestors 'none'[\s\S]{0,400}Cache-Control",\s*"no-store"/.test(entry));
    ok("the deny branch sets Referrer-Policy: no-referrer for token-bearing URLs", /Referrer-Policy",\s*"no-referrer"/.test(entry));
    ok("/app documents get Cache-Control: no-store", /pathname === "\/app" \|\| pathname\.startsWith\("\/app\/"\)[\s\S]{0,300}Cache-Control",\s*"no-store"/.test(entry));
  }
  {
    // …then the same guarantees from real response headers.
    const cases: Array<[string, string]> = [
      ["/", "marketing"],
      ["/web/login", "web"],
      ["/web/forgot", "web"],
      ["/platform/login", "platform"],
      ["/app/inbox", "app"],
    ];
    for (const [path, kind] of cases) {
      const p = await probe(path);
      ok(`${path}: X-Content-Type-Options: nosniff`, p.headers.get("x-content-type-options") === "nosniff", p.headers.get("x-content-type-options") ?? "(missing)");
      if (kind === "web" || kind === "platform") {
        ok(`${path}: CSP frame-ancestors 'none'`, (p.headers.get("content-security-policy") ?? "").includes("frame-ancestors 'none'"), p.headers.get("content-security-policy") ?? "(missing)");
        ok(`${path}: X-Frame-Options: DENY`, p.headers.get("x-frame-options") === "DENY", p.headers.get("x-frame-options") ?? "(missing)");
        ok(`${path}: Cache-Control: no-store`, (p.headers.get("cache-control") ?? "").includes("no-store"), p.headers.get("cache-control") ?? "(missing)");
        ok(`${path}: Referrer-Policy: no-referrer`, p.headers.get("referrer-policy") === "no-referrer", p.headers.get("referrer-policy") ?? "(missing)");
      }
      if (kind === "app") {
        ok(`${path}: Cache-Control: no-store (shopper PII)`, (p.headers.get("cache-control") ?? "").includes("no-store"), p.headers.get("cache-control") ?? "(missing)");
      }
    }
    // The regression the /platform branch fixes: a ?shop= param must NOT make
    // the operator console framable by that shop.
    for (const path of ["/platform/login?shop=dev-shop.myshopify.com", "/web/login?shop=dev-shop.myshopify.com"]) {
      const p = await probe(path);
      const csp = p.headers.get("content-security-policy") ?? "";
      ok(`${path}: still frame-ancestors 'none' despite ?shop=`, csp.includes("frame-ancestors 'none'") && !csp.includes("myshopify.com"), csp || "(missing)");
      ok(`${path}: still X-Frame-Options: DENY despite ?shop=`, p.headers.get("x-frame-options") === "DENY", p.headers.get("x-frame-options") ?? "(missing)");
    }
    // A web-surface member browsing /app/* (no Shopify signals) is also
    // un-framable — that path keys off the session cookie, not the pathname.
    {
      const p = await probe("/app/inbox", { cookie: "cc_web_session=not-a-real-token" });
      ok(
        "/app/* with a web cookie and no Shopify signals is un-framable",
        (p.headers.get("content-security-policy") ?? "").includes("frame-ancestors 'none'") || p.status === 302,
        `${p.status} ${p.headers.get("content-security-policy") ?? "(no csp)"}`,
      );
    }
  }

  // ── Section 5: resource routes reject the wrong method ────────────────────
  section("5. Resource routes reject the wrong method");
  for (const [method, path] of [
    ["GET", "/app/inbox-events"],
    ["GET", "/app/push-subscription"],
    ["GET", "/app/web-handoff"],
    ["POST", "/app/browse-data"],
  ] as Array<[string, string]>) {
    const p = await probe(path, { method });
    ok(`${method} ${path} → 405`, p.status === 405, String(p.status));
  }
  {
    const p = await probe("/api/test-chat");
    ok("GET /api/test-chat rejected (no loader)", p.status === 400 || p.status === 405, String(p.status));
  }
  for (const path of PROXY_PATHS) {
    const wrong = PROXY_LOADER_ONLY.has(path) ? "POST" : "GET";
    const p = await probe(path, { method: wrong });
    ok(`${wrong} ${path} rejected`, p.status === 400 || p.status === 405, String(p.status));
  }

  // ── Section 6: logout is POST-only ────────────────────────────────────────
  section("6. Logout CSRF guard (GET must not sign out)");
  {
    const p = await probe("/web/logout", { cookie: "cc_web_session=some-token; cc_surface=web" });
    const setCookie = p.headers.get("set-cookie") ?? "";
    ok(
      "GET /web/logout does not clear the session cookie",
      !/cc_web_session=;/.test(setCookie),
      `${p.status} | set-cookie: ${setCookie || "(none)"}`,
    );
    ok("GET /web/logout renders a confirm page (200) for a cookie holder", p.status === 200, String(p.status));
  }
  {
    const p = await probe("/web/logout");
    ok("GET /web/logout without a cookie → /web/login", p.status === 302 && (p.location ?? "").endsWith("/web/login"), `${p.status} ${p.location}`);
  }
  {
    const p = await probe("/platform/logout", { cookie: "cc_platform=some-token" });
    const setCookie = p.headers.get("set-cookie") ?? "";
    ok(
      "GET /platform/logout does not clear the platform cookie",
      p.status === 302 && !/cc_platform=;/.test(setCookie),
      `${p.status} | set-cookie: ${setCookie || "(none)"}`,
    );
  }

  // ── Section 7: proxy signature ────────────────────────────────────────────
  section("7. App proxy rejects unsigned / badly signed requests");
  for (const path of PROXY_PATHS) {
    const isLoader = PROXY_LOADER_ONLY.has(path);
    const bare = await probe(path, isLoader ? {} : { method: "POST", body: JSON.stringify({}), headers: { "content-type": "application/json" } });
    ok(`${path} without a signature rejected`, bare.status >= 400, String(bare.status));
    const q = "?shop=dev-shop.myshopify.com&logged_in_customer_id=&path_prefix=%2Fapps%2Fccwidget&timestamp=1700000000&signature=deadbeef";
    const forged = await probe(path + q, isLoader ? {} : { method: "POST", body: JSON.stringify({}), headers: { "content-type": "application/json" } });
    ok(`${path} with a forged signature rejected`, forged.status >= 400, String(forged.status));
  }

  // ── Section 8: webhook HMAC ───────────────────────────────────────────────
  section("8. Webhooks reject a bad HMAC before any handler code");
  for (const path of WEBHOOK_PATHS) {
    const p = await probe(path, {
      method: "POST",
      body: JSON.stringify({ id: 1 }),
      headers: {
        "content-type": "application/json",
        "x-shopify-topic": "app/uninstalled",
        "x-shopify-shop-domain": "dev-shop.myshopify.com",
        "x-shopify-hmac-sha256": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        "x-shopify-api-version": "2026-07",
        "x-shopify-webhook-id": "qa-routing-fake",
      },
    });
    ok(`${path} invalid HMAC → 401`, p.status === 401, String(p.status));
    const noHmac = await probe(path, { method: "POST", body: JSON.stringify({ id: 1 }), headers: { "content-type": "application/json" } });
    ok(`${path} missing HMAC rejected`, noHmac.status >= 400, String(noHmac.status));
    // …and the HMAC check is the FIRST thing the action does, so nothing can
    // run ahead of it.
    const file = `webhooks.${path.replace("/webhooks/", "").replace(/\//g, ".")}.tsx`;
    const src = readFileSync(join(ROUTES_DIR, file), "utf-8");
    const actionBody = src.slice(src.indexOf("export const action"));
    const firstAwait = actionBody.indexOf("await ");
    ok(
      `${file}: authenticate.webhook is the first await in the action`,
      firstAwait !== -1 && actionBody.slice(firstAwait, firstAwait + 60).includes("authenticate.webhook"),
      actionBody.slice(firstAwait, firstAwait + 60).replace(/\s+/g, " "),
    );
  }

  // ── Section 9: authenticated routing (web surface) ────────────────────────
  section("9. Authenticated web surface — role gates by direct URL");

  // A shop with a live offline Shopify session, so pages that need the Admin
  // API (contacts) work; falls back to any shop when there is none.
  const offline = await db.session.findFirst({ where: { isOnline: false }, select: { shop: true } });
  const hostShop = offline
    ? await db.shop.findUnique({ where: { domain: offline.shop } })
    : await db.shop.findFirst({ where: { uninstalledAt: null } });
  if (!hostShop) {
    ok("fixture shop available", false, "no installed shop in the dev DB");
  } else {
    const created: string[] = [];
    const cookieFor = async (role: "owner" | "admin" | "agent"): Promise<string> => {
      const member = await db.teamMember.create({
        data: {
          shopId: hostShop.id,
          email: `${TAG}-${role}-${Date.now()}@example.invalid`,
          name: `QA ${role}`,
          role,
          status: "active",
        },
      });
      created.push(member.id);
      const raw = await mintToken({ shopId: hostShop.id, memberId: member.id, kind: "session", ttlMs: 3_600_000 });
      return `cc_web_session=${raw}; cc_surface=web`;
    };

    try {
      const agentCookie = await cookieFor("agent");
      const adminCookie = await cookieFor("admin");

      for (const page of APP_PAGES) {
        const allowed = can("agent", "web", page.permission as never);
        const p = await probe(page.path, { cookie: agentCookie });
        if (allowed) {
          ok(`agent CAN reach ${page.path}`, p.status === 200, String(p.status));
        } else {
          ok(`agent CANNOT reach ${page.path} (direct URL)`, p.status === 403, String(p.status));
        }
      }
      // Resource routes obey the same matrix, not just pages.
      {
        const p = await probe("/app/browse-data?kind=products", { cookie: agentCookie });
        ok("agent CANNOT reach /app/browse-data (ai_agent permission)", p.status === 403, String(p.status));
      }
      {
        const p = await probe("/api/test-chat", {
          cookie: agentCookie,
          method: "POST",
          body: JSON.stringify({ message: "hi" }),
          headers: { "content-type": "application/json" },
        });
        ok("agent CANNOT reach /api/test-chat (ai_agent permission)", p.status === 403, String(p.status));
      }
      // The agent must not get past the gate with a POST either.
      for (const path of ["/app/settings", "/app/analytics", "/app/plan-usage"]) {
        const p = await probe(path, {
          cookie: agentCookie,
          method: "POST",
          body: new URLSearchParams({ intent: "save" }),
        });
        ok(`agent POST ${path} → 403`, p.status === 403, String(p.status));
      }

      for (const page of APP_PAGES) {
        const p = await probe(page.path, { cookie: adminCookie });
        ok(`admin CAN reach ${page.path}`, p.status === 200, String(p.status));
      }

      // billing_manage: admin surface only — the web admin must be refused.
      {
        const p = await probe("/app/plan-usage", {
          cookie: adminCookie,
          method: "POST",
          body: new URLSearchParams({ intent: "select", planId: "basic" }),
        });
        ok("web admin CANNOT run a billing mutation (billing_manage)", p.status === 403, String(p.status));
      }
      // Admin-surface-only resource route.
      {
        const p = await probe("/app/web-handoff", { cookie: adminCookie, method: "POST", body: new URLSearchParams({}) });
        ok("web session CANNOT mint an admin→web handoff", p.status === 403, String(p.status));
      }
      // Web-surface-only resource route reached from a web session: allowed.
      {
        const p = await probe("/app/push-subscription", {
          cookie: adminCookie,
          method: "POST",
          body: JSON.stringify({ endpoint: "", p256dh: "", auth: "" }),
          headers: { "content-type": "application/json" },
        });
        ok("web session reaches /app/push-subscription (not 403)", p.status !== 403, String(p.status));
      }
      // Signed-in /web must land on the inbox, and /web/login must not loop.
      {
        const p = await probe("/web", { cookie: adminCookie });
        ok("/web (signed in) → /app/inbox", p.status === 302 && (p.location ?? "").endsWith("/app/inbox"), `${p.status} ${p.location}`);
      }
      {
        const p = await probe("/web/login?next=%2Fapp%2Fsettings", { cookie: adminCookie });
        ok("/web/login (signed in) → next", p.status === 302 && (p.location ?? "") === "/app/settings", `${p.status} ${p.location}`);
      }
      {
        const p = await probe("/web/login?next=https%3A%2F%2Fevil.example", { cookie: adminCookie });
        ok("/web/login?next=<external> falls back to /app/inbox", p.status === 302 && (p.location ?? "") === "/app/inbox", `${p.status} ${p.location}`);
      }
      // Shopify signals win over the cookie — the admin iframe path is never
      // served from a web session.
      {
        const p = await probe(`/app/inbox?embedded=1&shop=${hostShop.domain}`, { cookie: adminCookie });
        ok(
          "Shopify signals bypass the web cookie (admin path taken)",
          isBouncePage(p) || p.status >= 300,
          `${p.status}`,
        );
      }
    } finally {
      await db.teamSession.deleteMany({ where: { memberId: { in: created } } });
      await db.pushSubscription.deleteMany({ where: { memberId: { in: created } } });
      await db.teamMember.deleteMany({ where: { id: { in: created } } });
    }
  }

  // ── Section 10: authenticated platform routing ────────────────────────────
  section("10. Authenticated platform surface");
  {
    const { createHash, randomBytes } = await import("node:crypto");
    const { hashPassword } = await import("../../app/lib/team/password.server");
    // A throwaway operator account — never touch the real one's sessions.
    const admin = await db.platformAdmin.create({
      data: {
        email: `${TAG}-operator-${Date.now()}@example.invalid`,
        name: "QA routing operator",
        passwordHash: await hashPassword(randomBytes(18).toString("base64url")),
      },
    });
    const raw = randomBytes(32).toString("base64url");
    const row = await db.platformSession.create({
      data: {
        tokenHash: createHash("sha256").update(raw).digest("hex"),
        adminId: admin.id,
        expiresAt: new Date(Date.now() + 3_600_000),
        userAgent: TAG,
      },
    });
    try {
      const cookie = `cc_platform=${raw}`;
      for (const path of ["/platform", "/platform/admins", "/platform/ai", "/platform/logs", "/platform/plans", "/platform/promo-codes", "/platform/settings", "/platform/usage"]) {
        const p = await probe(path, { cookie });
        ok(`signed-in GET ${path} → 200`, p.status === 200, String(p.status));
      }
      {
        const p = await probe("/platform/login", { cookie });
        ok("/platform/login (signed in) → /platform", p.status === 302 && (p.location ?? "") === "/platform", `${p.status} ${p.location}`);
      }
      {
        const p = await probe("/platform/login?next=https%3A%2F%2Fevil.example", { cookie });
        ok("/platform/login?next=<external> falls back to /platform", p.status === 302 && (p.location ?? "") === "/platform", `${p.status} ${p.location}`);
      }
      // A platform cookie must not unlock a merchant surface.
      {
        const p = await probe("/app/inbox", { cookie });
        ok("platform cookie does NOT open /app/inbox", isBlocked(p), String(p.status));
      }
      // A merchant web cookie must not unlock the platform surface (covered by
      // the signed-out sweep above, re-asserted with a bogus platform value).
      {
        const p = await probe("/platform/settings", { cookie: "cc_platform=not-a-real-token" });
        ok("bogus platform cookie → /platform/login", p.status === 302 && (p.location ?? "").includes("/platform/login"), `${p.status} ${p.location}`);
      }
      // POST-only logout, and it really clears the cookie.
      {
        const p = await probe("/platform/logout", { cookie, method: "POST", body: new URLSearchParams({}) });
        const setCookie = p.headers.get("set-cookie") ?? "";
        ok(
          "POST /platform/logout clears the cookie and redirects",
          p.status === 302 && /cc_platform=;?/.test(setCookie) && /Max-Age=0/.test(setCookie),
          `${p.status} ${setCookie}`,
        );
        const gone = await db.platformSession.findUnique({ where: { id: row.id } });
        ok("POST /platform/logout deletes the platform_sessions row", gone === null);
      }
    } finally {
      await db.platformSession.deleteMany({ where: { adminId: admin.id } }).catch(() => undefined);
      await db.platformAdmin.delete({ where: { id: admin.id } }).catch(() => undefined);
    }
  }

  // ── Section 11: web logout end-to-end ─────────────────────────────────────
  section("11. Web logout end-to-end");
  if (hostShop) {
    const member = await db.teamMember.create({
      data: { shopId: hostShop.id, email: `${TAG}-logout-${Date.now()}@example.invalid`, name: "QA logout", role: "admin", status: "active" },
    });
    try {
      const raw = await mintToken({ shopId: hostShop.id, memberId: member.id, kind: "session", ttlMs: 3_600_000 });
      const cookie = `cc_web_session=${raw}; cc_surface=web`;
      const before = await db.teamSession.count({ where: { memberId: member.id, kind: "session" } });
      const getLogout = await probe("/web/logout", { cookie });
      const stillThere = await db.teamSession.count({ where: { memberId: member.id, kind: "session" } });
      ok("GET /web/logout leaves the session row intact", before === 1 && stillThere === 1, `${before} → ${stillThere}`);
      ok("GET /web/logout renders the confirm page", getLogout.status === 200);

      const postLogout = await probe("/web/logout", { cookie, method: "POST", body: new URLSearchParams({}) });
      const after = await db.teamSession.count({ where: { memberId: member.id, kind: "session" } });
      const setCookie = postLogout.headers.get("set-cookie") ?? "";
      ok("POST /web/logout deletes the session row", after === 0, `${stillThere} → ${after}`);
      ok(
        "POST /web/logout clears cc_web_session (Max-Age=0)",
        postLogout.status === 302 && /cc_web_session=;/.test(setCookie) && /Max-Age=0/.test(setCookie),
        `${postLogout.status} ${setCookie}`,
      );
      ok("POST /web/logout → /web/login", (postLogout.location ?? "").endsWith("/web/login"), postLogout.location ?? "");
    } finally {
      await db.teamSession.deleteMany({ where: { memberId: member.id } });
      await db.teamMember.delete({ where: { id: member.id } }).catch(() => undefined);
    }
  }
}

main()
  .catch((error) => {
    failed++;
    failures.push(`unhandled: ${String(error)}`);
    console.error(error);
  })
  .finally(async () => {
    // Disconnect the shared singleton or tsx never exits.
    const db = (await import("../../app/db.server")).default;
    await db.$disconnect().catch(() => undefined);
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failures.length) {
      console.log("\nFailures:");
      for (const f of failures) console.log(`  - ${f}`);
    }
    // Let the loop drain on its own (process.exit() here races Prisma's
    // closing handles and aborts with a libuv assertion on Windows). The
    // unref'd timer is the backstop for a genuine handle leak: it only fires
    // if something else is still keeping the process alive.
    process.exitCode = failed === 0 ? 0 : 1;
    setTimeout(() => process.exit(failed === 0 ? 0 : 1), 5000).unref();
  });
