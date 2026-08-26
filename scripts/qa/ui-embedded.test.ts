/* QA: every embedded-admin page (/app/*) actually renders, and its
 * loader/action data path works.
 *
 *   Run: PRISMA_CLIENT_ENGINE_TYPE=binary npx tsx scripts/qa/ui-embedded.test.ts
 *   Needs: the dev server on http://localhost:3000 (BASE_URL to override) and
 *          the dev Postgres up.
 *
 * FIDELITY — read this before trusting a PASS.
 * ---------------------------------------------------------------------------
 * /app/* is dual-surface (spec 18, app/lib/access.server.ts): requireShopAccess
 * takes the Shopify-admin branch only when Shopify signals are present
 * (id_token / Authorization: Bearer / ?shop / ?host / ?embedded), and the web
 * branch when an opaque cc_web_session cookie is presented instead. Forging the
 * admin branch needs SHOPIFY_API_SECRET, which the Shopify CLI injects into the
 * dev server process and never writes to disk — so it is not reproducible from
 * a test script.
 *
 * This suite therefore drives the pages over REAL HTTP with a minted
 * cc_web_session cookie (the pattern scripts/qa/routing.test.ts and
 * auth-sessions.test.ts already use). That executes:
 *   - the real route module,
 *   - the real loader/action against the real dev DB,
 *   - the real server-side React render of the page component.
 * i.e. a missing loader key that the component destructures IS caught, because
 * the render happens for real and a throw becomes a 500.
 *
 * What it does NOT cover: `access.surface === "admin"` branches (three exist —
 * app.tsx's App Bridge branch, app.plan-usage's billingManageable, and the
 * billing_manage permission gate) and the live Admin GraphQL client. Those are
 * called out per-case below and in the final report.
 *
 * Everything it creates is tagged `qa-ui-embedded` and deleted in the finally
 * block, which also disconnects the shared app/db.server singleton — without
 * that the process hangs forever.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Load .env manually (tsx does not) BEFORE importing app modules.
for (const line of readFileSync(join(process.cwd(), ".env"), "utf-8").split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (match && !line.trim().startsWith("#") && process.env[match[1]] === undefined) {
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}
// app/lib/access.server.ts → app/shopify.server.ts refuses to initialise
// without the CLI-injected credentials. Nothing here talks to Shopify.
process.env.SHOPIFY_API_KEY ||= "qa-placeholder-key";
process.env.SHOPIFY_API_SECRET ||= "qa-placeholder-secret";
process.env.SHOPIFY_APP_URL ||= process.env.BASE_URL ?? "http://localhost:3000";
process.env.SCOPES ||= "read_products";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
// The Shopify library 410s anything isbot() flags, so every probe must look
// like a browser or the whole sweep measures the bot guard instead of the page.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const ROUTES_DIR = join(process.cwd(), "app", "routes");
const COMPONENTS_DIR = join(process.cwd(), "app", "components");
const TAG = "qa-ui-embedded";

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
function note(text: string): void {
  console.log(`  note ${text}`);
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
  init: {
    method?: string;
    cookie?: string;
    body?: BodyInit;
    headers?: Record<string, string>;
  } = {},
): Promise<Probe> {
  const headers: Record<string, string> = { "user-agent": UA, ...(init.headers ?? {}) };
  if (init.cookie) headers.cookie = init.cookie;
  const res = await fetch(BASE + path, {
    method: init.method ?? "GET",
    headers,
    body: init.body,
    redirect: "manual",
  });
  return {
    status: res.status,
    location: res.headers.get("location"),
    body: await res.text(),
    headers: res.headers,
  };
}

/** POST a form to a route. React Router runs the action, then re-renders. */
function postForm(path: string, fields: Record<string, string>, cookie: string): Promise<Probe> {
  return probe(path, {
    method: "POST",
    cookie,
    body: new URLSearchParams(fields),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
}

// ── Page inventory (the 16 /app/* pages) ────────────────────────────────────

interface Page {
  path: string;
  file: string;
  /** Extra query strings exercising alternative loader branches. */
  variants?: string[];
  /** Renders a page component (vs. a JSON-only resource route). */
  renders: boolean;
}

const PAGES: Page[] = [
  { path: "/app", file: "app._index.tsx", renders: true, variants: ["?range=30d", "?range=90d"] },
  { path: "/app/inbox", file: "app.inbox.tsx", renders: true, variants: ["?f=unread", "?f=resolved", "?c=does-not-exist"] },
  { path: "/app/contacts", file: "app.contacts.tsx", renders: true, variants: ["?type=lead", "?type=customer", "?type=anonymous"] },
  { path: "/app/chatbox", file: "app.chatbox.tsx", renders: true, variants: ["?tab=appearance"] },
  { path: "/app/ai-agent", file: "app.ai-agent.tsx", renders: true },
  { path: "/app/ai-agent/instructions", file: "app.ai-agent.instructions.tsx", renders: true },
  { path: "/app/ai-agent/review", file: "app.ai-agent.review.tsx", renders: true },
  { path: "/app/ai-agent/test", file: "app.ai-agent.test.tsx", renders: true },
  { path: "/app/ai-agent/training", file: "app.ai-agent.training.tsx", renders: true, variants: ["?tab=faq", "?tab=products", "?tab=knowledge"] },
  { path: "/app/proactive-chat", file: "app.proactive-chat.tsx", renders: true },
  { path: "/app/curated-answers", file: "app.curated-answers.tsx", renders: true },
  { path: "/app/analytics", file: "app.analytics.tsx", renders: true, variants: ["?range=30d&crange=90d", "?range=today"] },
  { path: "/app/plan-usage", file: "app.plan-usage.tsx", renders: true },
  { path: "/app/settings", file: "app.settings.tsx", renders: true, variants: ["?tab=team", "?tab=privacy", "?tab=chatbox"] },
  { path: "/app/account", file: "app.account.tsx", renders: true },
  { path: "/app/browse-data", file: "app.browse-data.tsx", renders: false, variants: ["?kind=collections", "?kind=products&q=a&page=2"] },
];

/** Resource routes under /app/* — same layout, no page component. */
const RESOURCE_ROUTES = ["app.inbox-events.tsx", "app.push-subscription.tsx", "app.web-handoff.tsx", "app.billing-callback.tsx"];

// ── Static-analysis helpers ─────────────────────────────────────────────────

function readRoute(file: string): string {
  return readFileSync(join(ROUTES_DIR, file), "utf-8");
}

/** Source of one top-level export (`export const loader = …` up to the next
 *  top-level `export`), or "" when absent. */
function exportBlock(src: string, name: string): string {
  const start = src.search(new RegExp(`^export (?:const|async function|function) ${name}\\b`, "m"));
  if (start === -1) return "";
  const rest = src.slice(start + 10);
  const next = rest.search(/^export /m);
  return next === -1 ? src.slice(start) : src.slice(start, start + 10 + next);
}

/** Top-level keys of the LAST `return {` object literal in a block. */
function returnedKeys(block: string): string[] {
  // The loader's OWN return sits one indent level inside the arrow body; a
  // `return {` deeper than that belongs to a nested closure (.map(), etc.).
  const top = block.search(/\n {2}return \{/);
  const idx = top === -1 ? block.lastIndexOf("return {") : top + 3;
  if (idx === -1) return [];
  let depth = 0;
  let i = idx + "return ".length;
  const start = i;
  for (; i < block.length; i++) {
    if (block[i] === "{") depth++;
    else if (block[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  const body = block.slice(start + 1, i);
  const segments: string[] = [];
  let d = 0;
  let lineStart = 0;
  for (let j = 0; j < body.length; j++) {
    const ch = body[j];
    if (ch === "{" || ch === "[" || ch === "(") d++;
    else if (ch === "}" || ch === "]" || ch === ")") d--;
    else if (ch === "," && d === 0) {
      segments.push(body.slice(lineStart, j));
      lineStart = j + 1;
    }
  }
  segments.push(body.slice(lineStart));
  const keys: string[] = [];
  for (const raw of segments) {
    // Strip comments, then take the identifier the segment starts with —
    // `key,` (shorthand) and `key: value` both land here.
    const seg = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*(?:\/\/[^\n]*\n)*/g, "")
      .trim();
    const m = seg.match(/^([A-Za-z_$][\w$]*)\s*(?::|$)/);
    if (m) keys.push(m[1]);
  }
  return [...new Set(keys)];
}

/** Every `db.<model>.<method>({ … })` call in a block, with its argument text. */
function dbCalls(block: string): Array<{ model: string; method: string; args: string }> {
  const out: Array<{ model: string; method: string; args: string }> = [];
  const re = /\bdb\.([A-Za-z$]+)\.([A-Za-z]+)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    const start = i;
    for (; i < block.length; i++) {
      if (block[i] === "(") depth++;
      else if (block[i] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push({ model: m[1], method: m[2], args: block.slice(start + 1, i) });
  }
  return out;
}

async function main(): Promise<void> {
  const db = (await import("../../app/db.server")).default;
  const { mintToken } = await import("../../app/lib/team/tokens.server");

  const createdMembers: string[] = [];
  const createdSessions: string[] = [];
  const createdConversations: string[] = [];
  const createdContacts: string[] = [];
  const createdCurated: string[] = [];
  const createdCampaigns: string[] = [];
  const createdQuestions: string[] = [];
  let planRestore: { id: string; plan: string } | null = null;

  try {
    // ── 0. Preflight ────────────────────────────────────────────────────────
    section("0. Preflight");
    try {
      const res = await fetch(`${BASE}/web/login`, { headers: { "user-agent": UA } });
      if (!res.ok) throw new Error(`status ${res.status}`);
      ok("dev server reachable", true, BASE);
    } catch (error) {
      ok("dev server reachable", false, `run \`npm run dev\` first — HTTP coverage NOT executed (${String(error)})`);
      return;
    }

    const shops = await db.shop.findMany({
      where: { uninstalledAt: null },
      select: { id: true, domain: true, plan: true },
    });
    const sessionShops = new Set(
      (await db.session.findMany({ where: { isOnline: false }, select: { shop: true } })).map((s) => s.shop),
    );
    const withCounts = await Promise.all(
      shops.map(async (s) => ({
        ...s,
        hasSession: sessionShops.has(s.domain),
        conversations: await db.conversation.count({ where: { shopId: s.id } }),
        configRows:
          (await db.persona.count({ where: { shopId: s.id } })) +
          (await db.widgetSettings.count({ where: { shopId: s.id } })) +
          (await db.shopSettings.count({ where: { shopId: s.id } })),
      })),
    );
    // Host = an installed shop with a live offline session (pages that hit the
    // Admin API need one on the web surface) and the most data.
    const host =
      withCounts.filter((s) => s.hasSession).sort((a, b) => b.conversations - a.conversations)[0] ??
      withCounts.sort((a, b) => b.conversations - a.conversations)[0];
    const other = withCounts.find((s) => s.id !== host.id);
    // Empty = fewest config rows / conversations (the "brand new shop" shape).
    const empty = withCounts
      .filter((s) => s.id !== host.id)
      .sort((a, b) => a.configRows - b.configRows || a.conversations - b.conversations)[0];

    ok("host fixture shop resolved", Boolean(host), host ? `${host.domain} (${host.conversations} conversations)` : "none");
    ok("second shop resolved for tenancy cases", Boolean(other), other?.domain ?? "none");
    ok("empty-state shop resolved", Boolean(empty), empty ? `${empty.domain} (${empty.configRows} config rows, ${empty.conversations} conversations)` : "none");
    if (!host || !other || !empty) return;
    if (!host.hasSession) {
      note(`${host.domain} has no offline Shopify session — /app, /app/contacts and /app/browse-data call access.getAdmin()`);
    }

    // An offline session so getAdmin() can build a client for the empty shop.
    // Without one, unauthenticated.admin() throws for an environmental reason
    // that has nothing to do with the page under test.
    if (!empty.hasSession) {
      const id = `offline_${empty.domain}`;
      await db.session.create({
        data: {
          id,
          shop: empty.domain,
          state: TAG,
          isOnline: false,
          scope: process.env.SCOPES,
          accessToken: `${TAG}-not-a-real-token`,
        },
      });
      createdSessions.push(id);
      note(`created a throwaway offline session for ${empty.domain} (deleted in finally)`);
    }

    const cookieFor = async (shopId: string, role: "owner" | "admin" = "owner"): Promise<string> => {
      const member = await db.teamMember.create({
        data: {
          shopId,
          email: `${TAG}-${role}-${randomUUID()}@example.invalid`,
          name: `QA ${role}`,
          role,
          status: "active",
        },
      });
      createdMembers.push(member.id);
      const raw = await mintToken({ shopId, memberId: member.id, kind: "session", ttlMs: 3_600_000 });
      return `cc_web_session=${raw}; cc_surface=web`;
    };

    const hostCookie = await cookieFor(host.id);
    const emptyCookie = await cookieFor(empty.id);

    // ── 1. Every page renders ───────────────────────────────────────────────
    section("1. Every /app/* page renders (real loader + real server render)");
    for (const page of PAGES) {
      const p = await probe(page.path, { cookie: hostCookie });
      const body = p.body;
      const rendered = page.renders
        ? body.includes("<s-page") || body.includes("<s-section")
        : body.length > 0;
      ok(
        `GET ${page.path} → 200`,
        p.status === 200,
        p.status === 200 ? "" : `${p.status} ${p.location ?? ""} ${body.slice(0, 240).replace(/\s+/g, " ")}`,
      );
      if (p.status === 200) {
        ok(`GET ${page.path} produced page markup`, rendered, rendered ? "" : `${body.length} bytes, no <s-page>/<s-section>`);
        ok(
          `GET ${page.path} did not fall back to the 403 "No access" boundary`,
          !body.includes("No access") || page.path === "/app/settings",
          "",
        );
      }
      for (const variant of page.variants ?? []) {
        const v = await probe(page.path + variant, { cookie: hostCookie });
        ok(`GET ${page.path}${variant} → 200`, v.status === 200, v.status === 200 ? "" : `${v.status} ${v.body.slice(0, 200).replace(/\s+/g, " ")}`);
      }
    }

    // ── 2. Loader payload shape ─────────────────────────────────────────────
    section("2. Loader payload contains every key the route declares");
    for (const page of PAGES) {
      const src = readRoute(page.file);
      const keys = returnedKeys(exportBlock(src, "loader"));
      if (keys.length === 0) {
        ok(`${page.file}: loader return keys parsed`, false, "could not parse the loader's return object");
        continue;
      }
      const dataPath = page.path === "/app" ? "/app._index.data" : `${page.path}.data`;
      let p = await probe(dataPath, { cookie: hostCookie });
      if (p.status !== 200) p = await probe(`${page.path}.data`, { cookie: hostCookie });
      if (p.status !== 200) {
        ok(`${page.path}.data returns the loader payload`, false, `${p.status} — single-fetch data endpoint not reachable, shape asserted by render only`);
        continue;
      }
      const missing = keys.filter((k) => !new RegExp(`"${k}"`).test(p.body));
      ok(
        `${page.path}: loader payload has all ${keys.length} declared keys`,
        missing.length === 0,
        missing.length ? `missing: ${missing.join(", ")}` : keys.join(", "),
      );
    }

    // ── 3. Tenancy: every DB query in a loader/action is shop-scoped ────────
    section("3. Every DB query in a /app/* loader or action is shop-scoped");
    {
      // A query is scoped when it filters on shopId, on the shop's own primary
      // key (id: shopId), or on the shop domain (the sessions table has no
      // shopId column).
      const SCOPED = /\bshopId\b|\bid:\s*shopId\b|\bshop:\s*shopDomain\b/;
      // Reached only through the member identity resolved from the session row.
      const MEMBER_SCOPED = new Set(["pushSubscription"]);
      for (const file of [...PAGES.map((p) => p.file), ...RESOURCE_ROUTES]) {
        const src = readRoute(file);
        const block = exportBlock(src, "loader") + "\n" + exportBlock(src, "action");
        const calls = dbCalls(block);
        // `db.x.count({ where })` reuses a `const where = { shopId, … }` built
        // earlier in the same block — resolve that before judging the call.
        const whereConstIsScoped = /const where(?::[^=]*)?\s*=\s*\{[\s\S]{0,600}?shopId/.test(block);
        const unscoped = calls.filter(
          (c) =>
            !SCOPED.test(c.args) &&
            !(MEMBER_SCOPED.has(c.model) && /memberId/.test(c.args)) &&
            !(/(^|[{,\s])where\s*[,}]/.test(c.args) && whereConstIsScoped),
        );
        ok(
          `${file}: all ${calls.length} db.* calls in loader/action are shop-scoped`,
          unscoped.length === 0,
          unscoped.map((c) => `db.${c.model}.${c.method}(${c.args.slice(0, 90).replace(/\s+/g, " ")})`).join(" | "),
        );
        ok(`${file}: no raw SQL in a loader/action`, !/db\.\$queryRaw|db\.\$executeRaw/.test(block), "");
      }
    }

    // ── 4. Plan gates degrade, never crash ──────────────────────────────────
    section("4. Pages render on plan=free AND plan=plus (gates degrade, never crash)");
    {
      const { planEnforcementMode } = await import("../../app/lib/billing/plans.server");
      note(`plan enforcement mode = ${planEnforcementMode()}`);
      planRestore = { id: host.id, plan: host.plan };
      for (const plan of ["free", "plus"] as const) {
        await db.shop.update({ where: { id: host.id }, data: { plan } });
        const { invalidateShopConfig } = await import("../../app/lib/config/shop-config.server");
        invalidateShopConfig(host.id);
        for (const page of PAGES) {
          const p = await probe(page.path, { cookie: hostCookie });
          ok(
            `plan=${plan}: GET ${page.path} → 200`,
            p.status === 200,
            p.status === 200 ? "" : `${p.status} ${p.body.slice(0, 200).replace(/\s+/g, " ")}`,
          );
        }
      }
      await db.shop.update({ where: { id: host.id }, data: { plan: host.plan } });
      planRestore = null;
    }

    // ── 5. Empty-state safety ───────────────────────────────────────────────
    section(`5. Empty-state safety — ${empty.domain} (${empty.configRows} default-config rows)`);
    for (const page of PAGES) {
      const p = await probe(page.path, { cookie: emptyCookie });
      ok(
        `empty shop: GET ${page.path} → 200`,
        p.status === 200,
        p.status === 200 ? "" : `${p.status} ${p.body.slice(0, 300).replace(/\s+/g, " ")}`,
      );
    }

    // ── 6. Actions ──────────────────────────────────────────────────────────
    section("6. Actions: valid input / invalid input / foreign-shop payload");

    // Fixtures in BOTH shops so a cross-tenant write has something to hit.
    const mkConversation = async (shopId: string) => {
      const row = await db.conversation.create({
        data: { shopId, sessionId: `${TAG}-${randomUUID()}`, status: "open", unread: true, isTest: true },
      });
      createdConversations.push(row.id);
      return row;
    };
    const mkContact = async (shopId: string) => {
      const row = await db.contact.create({
        data: { shopId, sessionId: `${TAG}-${randomUUID()}`, name: `${TAG} contact`, type: "anonymous" },
      });
      createdContacts.push(row.id);
      return row;
    };
    const hostConv = await mkConversation(host.id);
    const otherConv = await mkConversation(other.id);
    const hostContact = await mkContact(host.id);
    const otherContact = await mkContact(other.id);

    // Unknown / missing intent must never 500 on ANY action route.
    section("6a. Unknown and missing intent never crash");
    for (const page of PAGES) {
      const src = readRoute(page.file);
      if (!exportBlock(src, "action")) continue;
      // React Router sends a POST to /app to the LAYOUT route unless ?index is
      // present — the page's own fetcher adds it, so the harness must too.
      const target = page.path === "/app" ? "/app?index" : page.path;
      const unknown = await postForm(target, { intent: `${TAG}-not-a-real-intent` }, hostCookie);
      const missing = await postForm(target, {}, hostCookie);
      const good = (p: Probe) => p.status === 200 || p.status === 403 || (p.status >= 300 && p.status < 400);
      ok(`POST ${target} unknown intent handled`, good(unknown), String(unknown.status));
      ok(`POST ${target} missing intent handled`, good(missing), String(missing.status));
    }

    section("6b. Inbox actions (valid / invalid / foreign conversation)");
    {
      const before = await db.conversation.findUnique({ where: { id: otherConv.id } });
      const valid = await postForm("/app/inbox", { intent: "star", conversationId: hostConv.id, starred: "1" }, hostCookie);
      const starred = await db.conversation.findUnique({ where: { id: hostConv.id }, select: { starred: true } });
      ok("inbox star (valid) → 200 and the row is starred", valid.status === 200 && starred?.starred === true, `${valid.status} starred=${starred?.starred}`);

      const noId = await postForm("/app/inbox", { intent: "star", starred: "1" }, hostCookie);
      ok("inbox star without conversationId is refused, not a 500", noId.status === 200, String(noId.status));

      // Foreign conversation id + a forged shopId in the payload.
      for (const intent of ["star", "read", "resolve", "block", "delete", "assign"]) {
        await postForm(
          "/app/inbox",
          { intent, conversationId: otherConv.id, shopId: other.id, starred: "1", assigneeId: "" },
          hostCookie,
        );
      }
      const after = await db.conversation.findUnique({ where: { id: otherConv.id } });
      ok(
        "inbox actions cannot touch another shop's conversation",
        Boolean(after) &&
          after!.starred === before!.starred &&
          after!.status === before!.status &&
          after!.unread === before!.unread &&
          after!.blocked === before!.blocked &&
          after!.assigneeId === before!.assigneeId,
        after ? `starred=${after.starred} status=${after.status} unread=${after.unread} blocked=${after.blocked}` : "ROW DELETED",
      );
    }

    section("6c. Contacts actions (valid / invalid / foreign contact)");
    {
      const beforeName = otherContact.name;
      const valid = await postForm("/app/contacts", { intent: "detail", id: hostContact.id }, hostCookie);
      ok("contacts detail (valid) → 200", valid.status === 200, String(valid.status));
      const bogus = await postForm("/app/contacts", { intent: "detail", id: "not-a-real-id" }, hostCookie);
      ok("contacts detail with a bogus id is handled, not a 500", bogus.status === 200, String(bogus.status));
      const noEmail = await postForm("/app/contacts", { intent: "convert-lead", id: hostContact.id }, hostCookie);
      ok("contacts convert-lead without an email is refused, not a 500", noEmail.status === 200, String(noEmail.status));

      await postForm(
        "/app/contacts",
        { intent: "contact-save", id: otherContact.id, shopId: other.id, firstName: "Hijacked", lastName: "Row", email: `${TAG}@example.invalid` },
        hostCookie,
      );
      await postForm("/app/contacts", { intent: "contact-delete", id: otherContact.id, shopId: other.id }, hostCookie);
      const after = await db.contact.findUnique({ where: { id: otherContact.id } });
      ok(
        "contacts actions cannot edit or delete another shop's contact",
        Boolean(after) && after!.name === beforeName,
        after ? `name=${after.name}` : "ROW DELETED",
      );
    }

    section("6d. Curated answers (create → verify scoping → delete)");
    {
      const beforeOther = await db.curatedAnswer.count({ where: { shopId: other.id } });
      const payload = JSON.stringify({
        question: `${TAG} what is your return policy`,
        synonyms: [],
        productIds: [],
        talkingPoints: `${TAG} talking point`,
        status: "draft",
        priority: "normal",
      });
      const created = await postForm("/app/curated-answers", { intent: "save", payload }, hostCookie);
      const row = await db.curatedAnswer.findFirst({ where: { shopId: host.id, question: { contains: TAG } } });
      if (row) createdCurated.push(row.id);
      ok("curated save (valid) → 200 and the row lands on the caller's shop", created.status === 200 && Boolean(row), `${created.status} row=${Boolean(row)}`);
      const afterOther = await db.curatedAnswer.count({ where: { shopId: other.id } });
      ok("curated save did not write to the other shop", afterOther === beforeOther, `${beforeOther} → ${afterOther}`);

      const bad = await postForm("/app/curated-answers", { intent: "save", payload: "not json" }, hostCookie);
      ok("curated save with an unparseable payload is refused, not a 500", bad.status === 200, String(bad.status));

      // Foreign delete: an id from the other shop must not be removed.
      const foreign = await db.curatedAnswer.findFirst({ where: { shopId: other.id }, select: { id: true } });
      if (foreign) {
        await postForm("/app/curated-answers", { intent: "delete", id: foreign.id, shopId: other.id }, hostCookie);
        const still = await db.curatedAnswer.findUnique({ where: { id: foreign.id } });
        ok("curated delete cannot remove another shop's answer", Boolean(still), still ? "" : "ROW DELETED");
      } else {
        note("no curated answer in the other shop — foreign-delete case skipped");
      }

      if (row) {
        const del = await postForm("/app/curated-answers", { intent: "delete", id: row.id }, hostCookie);
        const gone = await db.curatedAnswer.findUnique({ where: { id: row.id } });
        ok("curated delete (valid) removes the caller's own answer", del.status === 200 && !gone, `${del.status} gone=${!gone}`);
      }
    }

    section("6e. Proactive campaigns (create → verify scoping → delete)");
    {
      // Build the settings blob from the app's own schema defaults so the case
      // tests the ROUTE, not my ability to hand-write a 40-field payload.
      const { campaignSettingsSchema } = await import("../../app/lib/settings/schemas");
      const payload = JSON.stringify({
        name: `${TAG} campaign`,
        templateType: "welcome",
        status: "inactive",
        settings: campaignSettingsSchema.parse({}),
      });
      const created = await postForm("/app/proactive-chat", { intent: "save", payload }, hostCookie);
      const row = await db.campaign.findFirst({ where: { shopId: host.id, name: { contains: TAG } } });
      if (row) createdCampaigns.push(row.id);
      ok(
        "campaign save (valid) → 200 and the row lands on the caller's shop",
        created.status === 200 && Boolean(row),
        `${created.status} row=${Boolean(row)}`,
      );
      const bad = await postForm("/app/proactive-chat", { intent: "save", payload: "{{{" }, hostCookie);
      ok("campaign save with an unparseable payload is refused, not a 500", bad.status === 200, String(bad.status));

      const foreign = await db.campaign.findFirst({ where: { shopId: other.id }, select: { id: true } });
      if (foreign) {
        await postForm("/app/proactive-chat", { intent: "delete", id: foreign.id, shopId: other.id }, hostCookie);
        const still = await db.campaign.findUnique({ where: { id: foreign.id } });
        ok("campaign delete cannot remove another shop's campaign", Boolean(still), still ? "" : "ROW DELETED");
      } else {
        note("no campaign in the other shop — foreign-delete case skipped");
      }
      if (row) {
        const del = await postForm("/app/proactive-chat", { intent: "delete", id: row.id }, hostCookie);
        ok("campaign delete (valid) → 200", del.status === 200, String(del.status));
      }
    }

    section("6f. Review queue, analytics export, settings, chatbox, account");
    {
      const q = await db.unresolvedQuestion.create({
        data: { shopId: host.id, question: `${TAG} unanswered question`, status: "pending", count: 1 },
      });
      createdQuestions.push(q.id);
      const dismissed = await postForm("/app/ai-agent/review", { intent: "dismiss", id: q.id }, hostCookie);
      const after = await db.unresolvedQuestion.findUnique({ where: { id: q.id }, select: { status: true } });
      ok("review dismiss (valid) → 200 and the row leaves `pending`", dismissed.status === 200 && after?.status !== "pending", `${dismissed.status} status=${after?.status}`);

      const foreignQ = await db.unresolvedQuestion.findFirst({ where: { shopId: other.id, status: "pending" }, select: { id: true, status: true } });
      if (foreignQ) {
        await postForm("/app/ai-agent/review", { intent: "dismiss", id: foreignQ.id, shopId: other.id }, hostCookie);
        const still = await db.unresolvedQuestion.findUnique({ where: { id: foreignQ.id }, select: { status: true } });
        ok("review dismiss cannot touch another shop's question", still?.status === foreignQ.status, `status=${still?.status}`);
      } else {
        note("no pending question in the other shop — foreign-dismiss case skipped");
      }

      const exported = await postForm("/app/analytics", { intent: "export-analytics", range: "30d" }, hostCookie);
      ok("analytics export-analytics (valid, read-only) → 200", exported.status === 200, String(exported.status));
      const exportedConv = await postForm("/app/analytics", { intent: "export-conversations" }, hostCookie);
      ok("analytics export-conversations (valid, read-only) → 200", exportedConv.status === 200, String(exportedConv.status));

      const badSettings = await postForm("/app/settings", { intent: "save-settings", payload: "not json" }, hostCookie);
      ok("settings save with an unparseable payload is refused, not a 500", badSettings.status === 200, String(badSettings.status));
      const emptySettings = await postForm("/app/settings", { intent: "save-settings", payload: "[]" }, hostCookie);
      ok("settings save with an empty slice list is refused, not a 500", emptySettings.status === 200, String(emptySettings.status));
      const badExport = await postForm("/app/settings", { intent: "download-data-request", id: "not-a-real-id" }, hostCookie);
      ok("settings download-data-request with a bogus id is refused, not a 500", badExport.status === 200, String(badExport.status));

      const badChatbox = await postForm("/app/chatbox", { intent: "save-appearance", payload: "not json" }, hostCookie);
      ok("chatbox save with an unparseable payload is refused, not a 500", badChatbox.status === 200, String(badChatbox.status));

      const badToggle = await postForm("/app/ai-agent", { intent: "toggle-ai", enabled: "not-a-boolean" }, hostCookie);
      ok("ai-agent toggle with a non-boolean is handled, not a 500", badToggle.status === 200, String(badToggle.status));

      const badInstructions = await postForm("/app/ai-agent/instructions", { intent: "save-general", payload: "{{{" }, hostCookie);
      ok("instructions save with an unparseable payload is refused, not a 500", badInstructions.status === 200, String(badInstructions.status));

      const badTraining = await postForm("/app/ai-agent/training", { intent: "faq-save", payload: "{{{" }, hostCookie);
      ok("training faq-save with an unparseable payload is refused, not a 500", badTraining.status === 200, String(badTraining.status));

      const account = await postForm("/app/account", { intent: "profile", name: `QA renamed ${TAG}` }, hostCookie);
      ok("account profile save (valid, own member row) → 200", account.status === 200, String(account.status));
      const accountNoName = await postForm("/app/account", { intent: "profile", name: "" }, hostCookie);
      ok("account profile save with an empty name is refused, not a 500", accountNoName.status === 200, String(accountNoName.status));

      // Billing mutations are admin-surface only — the web branch must refuse.
      const billing = await postForm("/app/plan-usage", { intent: "subscribe", plan: "plus", interval: "monthly" }, hostCookie);
      ok("plan-usage billing mutation is refused on the web surface (403)", billing.status === 403, String(billing.status));
      note("plan-usage's action is admin-surface only — it CANNOT be executed at this fidelity (needs SHOPIFY_API_SECRET to forge a session token)");
    }

    section("6g. Foreign shopId in the payload never reaches a query");
    {
      // Structural proof, on top of the behavioural cases above: no /app/*
      // loader or action may read a shop identity from client input.
      for (const file of [...PAGES.map((p) => p.file), ...RESOURCE_ROUTES]) {
        const src = readRoute(file);
        const block = exportBlock(src, "loader") + "\n" + exportBlock(src, "action");
        const offenders = [
          ...block.matchAll(/(?:formData|form|url\.searchParams|params)\.get\(\s*["'](shopId|shop|shopDomain)["']\s*\)/g),
        ].map((m) => m[0]);
        ok(`${file}: shop identity never read from client input`, offenders.length === 0, offenders.join(", "));
      }
    }

    // ── 7. Static component review ──────────────────────────────────────────
    section("7a. Embedded-app navigation rules (CLAUDE.md)");
    {
      const files = [...PAGES.map((p) => p.file), ...RESOURCE_ROUTES, "app.tsx"];
      for (const file of files) {
        const src = readRoute(file);
        const hasDataFn = /^export (?:const|async function|function) (?:loader|action)\b/m.test(src);
        if (hasDataFn) {
          ok(
            `${file}: exports headers via boundary.headers`,
            /export const headers[\s\S]{0,200}boundary\.headers/.test(src),
            "",
          );
        }
        const rendersPage = /^export default function/m.test(src);
        if (rendersPage) {
          ok(`${file}: exports an ErrorBoundary`, /^export function ErrorBoundary/m.test(src), "");
        } else if (hasDataFn) {
          // Resource route — the skill still asks for boundary.error on every
          // nested route with a loader/action.
          const has = /^export function ErrorBoundary/m.test(src);
          if (!has) note(`${file}: resource route (no component) with no ErrorBoundary`);
        }
        // Raw <a href="/internal"> breaks the embedded session.
        const rawAnchors = [...src.matchAll(/<a\s+[^>]*href=["'](?!https?:|mailto:|tel:)[^"']*["']/g)].map((m) => m[0]);
        ok(`${file}: no raw <a href> for internal navigation`, rawAnchors.length === 0, rawAnchors.join(" | "));
        // react-router's redirect must never be used inside /app/*.
        const badRedirect = /import\s*\{[^}]*\bredirect\b[^}]*\}\s*from\s*["']react-router["']/.test(src);
        ok(`${file}: does not import redirect from react-router`, !badRedirect, "");
        // Forms submit through useSubmit/useFetcher, never a bare <form action>.
        const bareForm = [...src.matchAll(/<form\s[^>]*\bmethod=["']post["']/gi)].map((m) => m[0]);
        ok(`${file}: no bare <form method=post>`, bareForm.length === 0, bareForm.join(" | "));
      }
    }

    section("7b. Polaris web components actually exist");
    {
      const ce = JSON.parse(
        readFileSync(join(process.cwd(), "node_modules", "@shopify", "polaris-types", "dist", "custom-elements.json"), "utf-8"),
      );
      const tags = new Set<string>();
      let iconUnion = "";
      const walk = (o: unknown): void => {
        if (!o || typeof o !== "object") return;
        if (Array.isArray(o)) return o.forEach(walk);
        const rec = o as Record<string, unknown>;
        if (typeof rec.tagName === "string") tags.add(rec.tagName);
        if (
          rec.name === "type" &&
          typeof (rec.type as { text?: string })?.text === "string" &&
          ((rec.type as { text: string }).text.match(/\|/g)?.length ?? 0) > 200
        ) {
          iconUnion = (rec.type as { text: string }).text;
        }
        for (const k in rec) walk(rec[k]);
      };
      walk(ce);
      // App Bridge contributes its own elements on top of Polaris.
      const APP_BRIDGE_TAGS = new Set(["s-app-nav", "s-app-window"]);
      const icons = new Set(iconUnion.split("|").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean));
      ok("Polaris custom-elements manifest parsed", tags.size > 40 && icons.size > 100, `${tags.size} elements, ${icons.size} icon names`);

      const scan: Array<[string, string]> = [];
      for (const file of [...PAGES.map((p) => p.file), ...RESOURCE_ROUTES, "app.tsx"]) {
        scan.push([`routes/${file}`, readRoute(file)]);
      }
      const walkDir = (dir: string): void => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, e.name);
          if (e.isDirectory()) walkDir(full);
          else if (e.name.endsWith(".tsx")) scan.push([full.slice(process.cwd().length + 1), readFileSync(full, "utf-8")]);
        }
      };
      if (existsSync(COMPONENTS_DIR)) walkDir(COMPONENTS_DIR);

      const unknownTags = new Map<string, string[]>();
      const unknownIcons = new Map<string, string[]>();
      for (const [name, src] of scan) {
        for (const m of src.matchAll(/<(s-[a-z0-9-]+)/g)) {
          if (!tags.has(m[1]) && !APP_BRIDGE_TAGS.has(m[1])) {
            unknownTags.set(m[1], [...(unknownTags.get(m[1]) ?? []), name]);
          }
        }
        // icon="…" only exists on Polaris elements; s-icon uses type="…".
        for (const m of src.matchAll(/\bicon=["']([a-z0-9-]+)["']/g)) {
          if (!icons.has(m[1])) unknownIcons.set(m[1], [...(unknownIcons.get(m[1]) ?? []), name]);
        }
        for (const m of src.matchAll(/<s-icon\b[^>]*?\btype=["']([a-z0-9-]+)["']/g)) {
          if (!icons.has(m[1])) unknownIcons.set(m[1], [...(unknownIcons.get(m[1]) ?? []), name]);
        }
      }
      ok(
        `no invented <s-*> element in ${scan.length} admin files`,
        unknownTags.size === 0,
        [...unknownTags].map(([t, f]) => `${t} (${[...new Set(f)].join(", ")})`).join(" | "),
      );
      ok(
        "no invented Polaris icon name",
        unknownIcons.size === 0,
        [...unknownIcons].map(([t, f]) => `${t} (${[...new Set(f)].slice(0, 3).join(", ")})`).join(" | "),
      );
    }

    section("7c. Accessibility: every field is labelled, every button has text");
    {
      const FIELDS = [
        "s-text-field", "s-text-area", "s-select", "s-search-field", "s-checkbox", "s-switch",
        "s-number-field", "s-email-field", "s-password-field", "s-color-field", "s-date-field",
        "s-money-field", "s-url-field",
      ];
      const scan: Array<[string, string]> = [];
      for (const file of [...PAGES.map((p) => p.file), "app.tsx"]) scan.push([`routes/${file}`, readRoute(file)]);
      const walkDir = (dir: string): void => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, e.name);
          if (e.isDirectory()) walkDir(full);
          else if (e.name.endsWith(".tsx")) scan.push([full.slice(process.cwd().length + 1), readFileSync(full, "utf-8")]);
        }
      };
      if (existsSync(COMPONENTS_DIR)) walkDir(COMPONENTS_DIR);

      const unlabelled: string[] = [];
      const rawInputs: string[] = [];
      const iconOnlyButtons: string[] = [];
      for (const [name, src] of scan) {
        for (const tag of FIELDS) {
          const re = new RegExp(`<${tag}\\b([\\s\\S]*?)(/>|>)`, "g");
          for (const m of src.matchAll(re)) {
            const attrs = m[1];
            if (!/\blabel[=\s]|\baccessibilityLabel[=\s]|\baria-label[=\s]|\bdetails=/.test(attrs)) {
              unlabelled.push(`${name}: <${tag}>`);
            }
          }
        }
        // <s-choice> takes its label from its CHILDREN (it has no `label`
        // attribute) — an empty, self-closing one is the unlabelled shape.
        for (const m of src.matchAll(/<s-choice\b([^>]*?)\/>/g)) {
          if (!/accessibilityLabel|aria-label/.test(m[1])) unlabelled.push(`${name}: self-closing <s-choice>`);
        }
        // Raw form controls in admin UI (the app is Polaris-only except for the
        // documented App Bridge ui-save-bar contract).
        for (const m of src.matchAll(/<(input|select|textarea)\b([\s\S]*?)(\/>|>)/g)) {
          if (/type=["'](hidden|file)["']/.test(m[2])) continue;
          if (!/\baria-label[=\s]|\bid=/.test(m[2])) rawInputs.push(`${name}: <${m[1]}>`);
        }
        // <s-button icon="x" /> with no children and no accessibilityLabel.
        for (const m of src.matchAll(/<s-button\b([^>]*?)\/>/g)) {
          if (/\bicon=/.test(m[1]) && !/accessibilityLabel|aria-label/.test(m[1])) {
            iconOnlyButtons.push(`${name}: ${m[0].slice(0, 90).replace(/\s+/g, " ")}`);
          }
        }
      }
      ok(
        `every Polaris field carries a label (${scan.length} files scanned)`,
        unlabelled.length === 0,
        `${unlabelled.length} unlabelled: ${[...new Set(unlabelled)].slice(0, 8).join(" | ")}`,
      );
      ok(
        "no unlabelled raw <input>/<select>/<textarea> in admin UI",
        rawInputs.length === 0,
        `${rawInputs.length}: ${[...new Set(rawInputs)].slice(0, 8).join(" | ")}`,
      );
      ok(
        "no self-closing icon-only <s-button> without an accessible name",
        iconOnlyButtons.length === 0,
        `${iconOnlyButtons.length}: ${[...new Set(iconOnlyButtons)].slice(0, 8).join(" | ")}`,
      );
    }

    section("7d. Loading / empty states for async surfaces");
    {
      for (const page of PAGES.filter((p) => p.renders)) {
        const src = readRoute(page.file);
        const usesAsync = /useFetcher|useSubmit|useNavigation|EventSource|fetch\(/.test(src);
        if (!usesAsync) continue;
        const hasLoading = /\.state\s*[!=]==?\s*["'](idle|submitting|loading)["']|s-spinner|loading=|AppLoading|isLoading|busy/.test(src);
        ok(`${page.file}: shows a pending state for its async work`, hasLoading, "");
      }
      // A page's lists usually live in the components it imports, so the empty
      // state has to be looked for across the page + its own components.
      const withImports = (file: string): string => {
        const src = readRoute(file);
        let all = src;
        for (const m of src.matchAll(/from\s+["']\.\.\/components\/([\w./-]+)["']/g)) {
          for (const ext of [".tsx", "/index.tsx", ".ts"]) {
            const full = join(COMPONENTS_DIR, m[1] + ext);
            if (existsSync(full)) {
              all += "\n" + readFileSync(full, "utf-8");
              break;
            }
          }
        }
        return all;
      };
      for (const page of PAGES.filter((p) => p.renders)) {
        const src = withImports(page.file);
        // Only pages that actually render a data-driven TABLE/LIST owe an
        // empty state. Optional affordance chips (ai-agent/test) and scalar
        // counters (account) are not lists and must not be flagged.
        const listy = /DataTable|<s-table\b|<s-unordered-list\b|<s-ordered-list\b/.test(src);
        if (!listy) continue;
        const hasEmpty = /EmptyState|length === 0|No results|no results|No .{0,30} yet/.test(src);
        ok(`${page.file}: has an empty state for its lists`, hasEmpty, "");
      }
    }
  } finally {
    const db = (await import("../../app/db.server")).default;
    try {
      if (planRestore) await db.shop.update({ where: { id: planRestore.id }, data: { plan: planRestore.plan } });
      if (createdQuestions.length) await db.unresolvedQuestion.deleteMany({ where: { id: { in: createdQuestions } } });
      if (createdCampaigns.length) await db.campaign.deleteMany({ where: { id: { in: createdCampaigns } } });
      if (createdCurated.length) await db.curatedAnswer.deleteMany({ where: { id: { in: createdCurated } } });
      await db.curatedAnswer.deleteMany({ where: { question: { contains: TAG } } });
      await db.campaign.deleteMany({ where: { name: { contains: TAG } } });
      if (createdConversations.length) {
        await db.message.deleteMany({ where: { conversationId: { in: createdConversations } } });
        await db.conversation.deleteMany({ where: { id: { in: createdConversations } } });
      }
      if (createdContacts.length) await db.contact.deleteMany({ where: { id: { in: createdContacts } } });
      // Tag-based, not id-based: a run killed part-way still gets swept by the
      // next one, so fixtures can never accumulate in the dev DB.
      await db.conversation.deleteMany({ where: { sessionId: { contains: TAG } } });
      await db.contact.deleteMany({ where: { sessionId: { contains: TAG } } });
      await db.unresolvedQuestion.deleteMany({ where: { question: { contains: TAG } } });
      const stale = await db.teamMember.findMany({ where: { email: { contains: TAG } }, select: { id: true } });
      const memberIds = [...new Set([...createdMembers, ...stale.map((m) => m.id)])];
      if (memberIds.length) {
        await db.teamSession.deleteMany({ where: { memberId: { in: memberIds } } });
        await db.pushSubscription.deleteMany({ where: { memberId: { in: memberIds } } });
        await db.teamMember.deleteMany({ where: { id: { in: memberIds } } });
      }
      await db.session.deleteMany({ where: { state: TAG } });
    } finally {
      await db.$disconnect();
    }
  }
}

main()
  .catch((error) => {
    failed++;
    failures.push(`harness crashed: ${String(error?.stack ?? error)}`);
    console.error(`  FAIL harness crashed — ${String(error?.stack ?? error)}`);
  })
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failures.length) {
      console.log("\nFailures:");
      for (const f of failures) console.log(`  - ${f}`);
    }
    process.exit(failed ? 1 : 0);
  });
