/* QA: the standalone web surface (/web/* auth pages + the /app/* pages the
 * ChatConvert web shell renders) end-to-end over real HTTP.
 *
 *   Run: PRISMA_CLIENT_ENGINE_TYPE=binary npx tsx scripts/qa/ui-web.test.ts
 *   Needs: the dev server on http://localhost:3000 (BASE_URL to override) and
 *          the dev Postgres up + seeded.
 *
 * What it proves, per the QA brief:
 *   1. every web page actually RENDERS (200 + its real heading + the controls
 *      it promises), never an error boundary and never an empty shell;
 *   2. the role matrix is enforced server-side by direct URL, not just hidden
 *      in the nav;
 *   3. login / lockout / forgot / reset / invite / handoff behave, including
 *      replay, expiry and wrong-shop tokens;
 *   4. every /web mutation refuses a cross-site Origin;
 *   5. a member of two shops gets a picker and cannot reach the other shop's
 *      data by tampering with an id;
 *   6. a static UI review of app/routes/web*.tsx (raw anchors, labels,
 *      accessible button text, empty/error states).
 *
 * Every fixture is tagged `qa-uiweb` and removed in the finally block, which
 * also disconnects the shared app/db.server singleton — without that the
 * process hangs forever. No secret is ever printed.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

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
// The Shopify library 410s anything isbot() flags — every probe must look like
// a browser or the sweep measures the bot guard instead of the app.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const TAG = "qa-uiweb";
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
  setCookie: string[];
  contentType: string;
}

async function probe(
  path: string,
  init: {
    method?: string;
    cookie?: string;
    body?: BodyInit;
    headers?: Record<string, string>;
    /** null = send no Origin at all; a string = send that Origin. */
    origin?: string | null;
    signal?: AbortSignal;
  } = {},
): Promise<Probe> {
  const headers: Record<string, string> = { "user-agent": UA, ...(init.headers ?? {}) };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.origin !== null) headers.origin = init.origin ?? BASE;
  const res = await fetch(BASE + path, {
    method: init.method ?? "GET",
    headers,
    body: init.body,
    redirect: "manual",
    signal: init.signal,
  });
  return {
    status: res.status,
    location: res.headers.get("location"),
    body: await res.text(),
    contentType: res.headers.get("content-type") ?? "",
    setCookie: typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [],
  };
}

// ── HTML helpers ────────────────────────────────────────────────────────────

/** Strip <script>/<style> so markers can't match dev-server payloads. */
function visible(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");
}

/** React Router's default boundary + common crash text. */
const ERROR_MARKERS = [
  "Unexpected Server Error",
  "Application Error",
  "💿 Hey developer",
  "Cannot read properties of",
  "is not a function",
  "Internal Server Error",
];

function boundaryHit(html: string): string | null {
  const v = visible(html);
  for (const marker of ERROR_MARKERS) if (v.includes(marker)) return marker;
  // A bare stack trace leaking into the document is a boundary too.
  if (/<pre[^>]*>\s*(Error|TypeError|ReferenceError):/i.test(v)) return "stack trace";
  return null;
}

/** Any <main> present must have real content (the "200 but blank" failure). */
function emptyMainHit(html: string): boolean {
  const mains = visible(html).match(/<main\b[^>]*>([\s\S]*?)<\/main>/gi) ?? [];
  return mains.some((m) => m.replace(/<[^>]+>/g, "").replace(/&\w+;/g, "").trim().length === 0);
}

/** The web shell's content region — what the page itself rendered. */
function shellContent(html: string): string | null {
  const idx = html.indexOf('<div class="ccws-content">');
  if (idx === -1) return null;
  return html.slice(idx + '<div class="ccws-content">'.length);
}

/** hrefs of the web shell's rail nav, in order. */
function navHrefs(html: string): string[] {
  const nav = html.match(/<nav class="ccws-nav">([\s\S]*?)<\/nav>/);
  if (!nav) return [];
  return [...nav[1].matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
}

function renders(name: string, p: Probe, markers: string[], scope: "shell" | "page" = "page"): void {
  const hit = boundaryHit(p.body);
  const body = scope === "shell" ? shellContent(p.body) : p.body;
  if (p.status !== 200) {
    ok(name, false, `HTTP ${p.status}${p.location ? ` → ${p.location}` : ""}`);
    return;
  }
  if (hit) {
    ok(name, false, `error boundary: "${hit}"`);
    return;
  }
  if (emptyMainHit(p.body)) {
    ok(name, false, "empty <main>");
    return;
  }
  if (scope === "shell" && (body === null || visible(body).replace(/<[^>]+>/g, "").trim().length < 20)) {
    ok(name, false, "web shell rendered an empty content region");
    return;
  }
  const missing = markers.filter((m) => !(body ?? "").includes(m));
  ok(name, missing.length === 0, missing.length ? `missing ${JSON.stringify(missing)}` : `${p.body.length}B`);
}

// ── The pages the web nav exposes (app/routes/app.tsx NAV) ──────────────────

type Perm =
  | "dashboard"
  | "inbox"
  | "contacts"
  | "chatbox"
  | "ai_agent"
  | "proactive"
  | "curated"
  | "analytics"
  | "plan"
  | "settings";

interface WebPage {
  path: string;
  label: string;
  permission: Perm;
  /** Real heading/landmark text that must be in the rendered HTML. */
  heading: string[];
  /** Interactive controls the page promises. */
  controls: string[];
  /** At least one of these must render (list rows OR the empty state). */
  anyOf?: string[];
}

const WEB_PAGES: WebPage[] = [
  {
    path: "/app",
    label: "Dashboard",
    permission: "dashboard",
    heading: ['<s-section heading="Overview"', '<s-section heading="Setup checklist"'],
    controls: ['<s-select label="Date range"', "<s-button"],
  },
  {
    path: "/app/inbox",
    label: "Inbox",
    permission: "inbox",
    heading: ['class="cin-grid"', 'class="cin-fil-title"'],
    controls: [
      'class="cin-composer"', // message composer
      'class="cin-comp-input"',
      'class="cin-send"', // reply/send button
      'class="cin-assign-select"', // assignment control
      'class="cin-resolve"',
      'class="cin-lsearch"',
      'aria-label="Conversation actions"',
    ],
  },
  {
    path: "/app/contacts",
    label: "Contacts",
    permission: "contacts",
    heading: ["<s-heading>Contacts", '<s-section heading="Overview"'],
    controls: ['<s-search-field label="Search by name or email"', 'icon="export"', 'accessibilityLabel="Next page"'],
    // Either a populated list or the empty state — never a blank table.
    anyOf: ['accessibilityLabel="Edit contact"', 'emptyMessage="No contacts match your search."'],
  },
  {
    path: "/app/chatbox",
    label: "Chatbox",
    permission: "chatbox",
    heading: ["<s-heading>Chatbox", '<s-section heading="Chatbox header"'],
    controls: ['<s-text-field label="Name"', '<s-switch label="Chat status"', "<s-heading>Preview"],
  },
  {
    path: "/app/ai-agent",
    label: "AI Agent",
    permission: "ai_agent",
    heading: ["<s-heading>AI Agent", '<s-section heading="Set up your AI agent"'],
    controls: ["<s-heading>Training data", "<s-heading>Instructions", "<s-heading>Test AI"],
  },
  {
    path: "/app/proactive-chat",
    label: "Proactive Chat",
    permission: "proactive",
    heading: ["<s-heading>Proactive Chat", '<s-section heading="Campaigns"'],
    controls: ['<s-button variant="primary"', 'accessibilityLabel="Search"'],
  },
  {
    path: "/app/curated-answers",
    label: "Curated Answers",
    permission: "curated",
    heading: ["<s-heading>Curated Answers", '<s-section heading="Your curated answers"'],
    controls: ['<s-button variant="primary"', '<s-select label="Items per page"'],
  },
  {
    path: "/app/analytics",
    label: "Analytics",
    permission: "analytics",
    heading: ["<s-heading>Analytics", '<s-section heading="Top questions"'],
    controls: ['<s-select label="Date range"', '<s-select label="Chart range"'],
  },
  {
    path: "/app/plan-usage",
    label: "Plan & Usage",
    permission: "plan",
    heading: ["<s-heading>Plan &amp; Usage", '<s-section heading="Your plan"'],
    controls: ['<s-text-field label="Discount code"', "<s-button"],
  },
  {
    path: "/app/settings",
    label: "Settings",
    permission: "settings",
    heading: ["<s-heading>Settings", '<s-section heading="Team members"'],
    controls: ['icon="person-add"', '<s-search-field label="Search team members"', '<s-select label="Store time zone"'],
  },
];

/** Reachable from the shell (avatar + rail footer) for every role. */
const ACCOUNT_PAGE = {
  path: "/app/account",
  heading: ["<s-heading>Account", '<s-section heading="Profile"'],
  controls: [
    '<s-text-field label="Name"',
    '<s-password-field label="New password"',
    '<s-password-field label="Confirm new password"',
    '<s-section heading="Sessions"',
  ],
};

async function main(): Promise<void> {
  const db = (await import("../../app/db.server")).default;
  const { can } = await import("../../app/lib/access.server");
  const { hashPassword } = await import("../../app/lib/team/password.server");
  const { mintToken, findToken, hashToken } = await import("../../app/lib/team/tokens.server");
  const { readWebSession } = await import("../../app/lib/team/web-session.server");
  const { mintHandoffToken, requestPasswordReset } = await import("../../app/lib/team/team.server");

  try {
    const res = await fetch(`${BASE}/web/login`, { headers: { "user-agent": UA } });
    if (!res.ok) throw new Error(`status ${res.status}`);
  } catch (error) {
    // Never let an unreachable server look like a clean run.
    ok(
      `dev server reachable at ${BASE}`,
      false,
      `run \`npm run dev\` first — HTTP coverage NOT executed (${String(error)})`,
    );
    return;
  }

  // ── Fixtures ──────────────────────────────────────────────────────────────
  // Shop A must have a live offline Shopify session (pages that call
  // access.getAdmin() need one) AND real conversations, or the inbox renders
  // its empty state and the control assertions measure nothing. Ranked
  // deterministically so the suite doesn't drift between runs.
  const offlineDomains = new Set(
    (await db.session.findMany({ where: { isOnline: false }, select: { shop: true } })).map((s) => s.shop),
  );
  const installed = await db.shop.findMany({ where: { uninstalledAt: null }, select: { id: true, domain: true } });
  const ranked = await Promise.all(
    installed.map(async (s) => ({
      ...s,
      hasAdmin: offlineDomains.has(s.domain),
      convs: await db.conversation.count({ where: { shopId: s.id, isTest: false } }),
    })),
  );
  ranked.sort(
    (a, b) => Number(b.hasAdmin) - Number(a.hasAdmin) || b.convs - a.convs || a.id.localeCompare(b.id),
  );
  const shopA = ranked[0];
  const shopB = ranked.find((s) => s.id !== shopA?.id);
  if (!shopA || !shopB) {
    ok("two installed shops available", false, "seed the dev DB first");
    return;
  }
  ok(
    "fixture shop A has an Admin API session and conversations",
    shopA.hasAdmin && shopA.convs > 0,
    `${shopA.domain} admin=${shopA.hasAdmin} convs=${shopA.convs}`,
  );
  // A shop whose offline Shopify session is missing — used to prove the
  // "session-less shop" behaviour of the pages that call getAdmin().
  const shopNoAdmin = ranked.find((s) => !s.hasAdmin) ?? null;

  const stamp = Date.now();
  const secret = `${randomBytes(18).toString("base64url")}Aa1!`; // never printed
  const memberIds: string[] = [];
  const mk = async (
    shopId: string,
    role: "owner" | "admin" | "agent",
    label: string,
    opts: { password?: boolean; email?: string; status?: "invited" | "active" } = {},
  ) => {
    const m = await db.teamMember.create({
      data: {
        shopId,
        email: opts.email ?? `${TAG}-${label}-${stamp}@example.invalid`,
        name: `QA ${label}`,
        role,
        status: opts.status ?? "active",
        passwordHash: opts.password ? await hashPassword(secret) : null,
      },
    });
    memberIds.push(m.id);
    return m;
  };

  const owner = await mk(shopA.id, "owner", "owner", { password: true });
  const admin = await mk(shopA.id, "admin", "admin", { password: true });
  const agent = await mk(shopA.id, "agent", "agent", { password: true });
  const lockTarget = await mk(shopA.id, "agent", "lock", { password: true });
  const dualEmail = `${TAG}-dual-${stamp}@example.invalid`;
  const dualA = await mk(shopA.id, "admin", "dual-a", { password: true, email: dualEmail });
  const dualB = await mk(shopB.id, "agent", "dual-b", { password: true, email: dualEmail });

  // Shop B data that a shop-A session must never see or touch.
  const victimConv = await db.conversation.create({
    data: { shopId: shopB.id, sessionId: `${TAG}-victim-${stamp}`, status: "open", unread: true },
  });
  await db.message.create({
    data: {
      conversationId: victimConv.id,
      shopId: shopB.id,
      role: "in",
      author: "shopper",
      content: `${TAG}-secret-marker-${stamp}`,
    },
  });

  // The mirror fixture in shop A, so the tenancy probe works both ways.
  const homeConv = await db.conversation.create({
    data: { shopId: shopA.id, sessionId: `${TAG}-home-${stamp}`, status: "open", unread: true },
  });
  await db.message.create({
    data: {
      conversationId: homeConv.id,
      shopId: shopA.id,
      role: "in",
      author: "shopper",
      content: `${TAG}-home-marker-${stamp}`,
    },
  });

  const cookieFor = async (memberId: string, shopId: string): Promise<string> => {
    const raw = await mintToken({ shopId, memberId, kind: "session", ttlMs: 3_600_000 });
    return `cc_web_session=${raw}; cc_surface=web`;
  };

  const roleCookies: Record<"owner" | "admin" | "agent", string> = {
    owner: await cookieFor(owner.id, shopA.id),
    admin: await cookieFor(admin.id, shopA.id),
    agent: await cookieFor(agent.id, shopA.id),
  };

  try {
    // ══ 1. Public /web pages render ═════════════════════════════════════════
    section("1. Public /web pages render (signed out)");
    {
      const p = await probe("/web");
      ok("/web (signed out) → /web/login", p.status === 302 && (p.location ?? "").endsWith("/web/login"), `${p.status} ${p.location}`);
    }
    {
      const p = await probe("/web/login");
      renders("/web/login renders the sign-in card", p, [
        '<h1 class="ccwa-title">Sign in</h1>',
        '<form method="post" action="/web/login"',
        '<s-email-field label="Email"',
        '<s-password-field label="Password"',
        "<s-button type=\"submit\"",
        'href="/web/forgot"',
      ]);
    }
    {
      const p = await probe("/web/forgot");
      renders("/web/forgot renders the reset-request form", p, [
        '<h1 class="ccwa-title">Reset your password</h1>',
        '<form method="post" action="/web/forgot"',
        '<s-email-field label="Email"',
        'href="/web/login"',
      ]);
    }
    {
      const p = await probe("/web/reset/not-a-real-token");
      renders("/web/reset/:bad renders the friendly invalid-link page", p, [
        "Reset link not valid",
        'href="/web/forgot"',
      ]);
    }
    {
      const raw = await mintToken({ shopId: shopA.id, memberId: admin.id, kind: "reset", ttlMs: 600_000 });
      const p = await probe(`/web/reset/${raw}`);
      renders("/web/reset/:valid renders the set-password form", p, [
        "Set a new password",
        '<s-password-field label="New password"',
        '<s-password-field label="Confirm password"',
        '<form method="post"',
      ]);
      await db.teamSession.deleteMany({ where: { tokenHash: hashToken(raw) } });
    }
    {
      const p = await probe("/web/invite/not-a-real-token");
      renders("/web/invite/:bad renders the friendly invalid-link page", p, ["Invitation not valid", 'href="/web/login"']);
    }
    {
      const invited = await mk(shopB.id, "agent", "invitee-render", { status: "invited" });
      const raw = await mintToken({ shopId: shopB.id, memberId: invited.id, kind: "invite", ttlMs: 600_000 });
      const p = await probe(`/web/invite/${raw}`);
      renders("/web/invite/:valid renders the join form", p, [
        '<s-text-field label="Your name"',
        '<s-password-field label="Password"',
        '<s-password-field label="Confirm password"',
        '<form method="post"',
      ]);
      ok(
        "/web/invite/:valid names the store being joined",
        /<h1 class="ccwa-title">Join [^<]+<\/h1>/.test(p.body),
        (p.body.match(/<h1 class="ccwa-title">[^<]*<\/h1>/) ?? [""])[0],
      );
      await db.teamSession.deleteMany({ where: { tokenHash: hashToken(raw) } });
    }
    {
      const p = await probe("/web/handoff");
      renders("/web/handoff (no token) renders the expired-link page", p, [
        "This link has expired",
        'href="/web/login"',
      ]);
    }
    {
      const p = await probe("/web/logout");
      ok("GET /web/logout without a cookie → /web/login", p.status === 302 && (p.location ?? "").endsWith("/web/login"), `${p.status} ${p.location}`);
    }
    {
      const p = await probe("/web/logout", { cookie: roleCookies.admin });
      renders("GET /web/logout renders the confirm page", p, [
        "Sign out of ChatConvert?",
        '<form method="post"',
        "<button",
      ]);
      ok("GET /web/logout uses a real <main> landmark", p.body.includes("<main"), "");
    }
    // Non-embeddable + no-store on every public web page.
    {
      const res = await fetch(`${BASE}/web/login`, { headers: { "user-agent": UA } });
      const csp = res.headers.get("content-security-policy") ?? "";
      const xfo = res.headers.get("x-frame-options") ?? "";
      ok(
        "/web/* sets frame-ancestors 'none' + X-Frame-Options",
        csp.includes("frame-ancestors 'none'") && xfo.toUpperCase() === "DENY",
        `${csp} | ${xfo}`,
      );
    }

    // ══ 2. Every web page renders for a permitted role ══════════════════════
    section("2. Web shell pages render with their real controls (admin session)");
    for (const page of WEB_PAGES) {
      const p = await probe(page.path, { cookie: roleCookies.admin });
      renders(`${page.path} renders (${page.label})`, p, page.heading, "shell");
      if (p.status === 200 && !boundaryHit(p.body)) {
        const content = shellContent(p.body) ?? "";
        const missing = page.controls.filter((c) => !content.includes(c));
        ok(`${page.path} exposes its promised controls`, missing.length === 0, missing.length ? `missing ${JSON.stringify(missing)}` : "");
        if (page.anyOf) {
          const hit = page.anyOf.some((c) => content.includes(c));
          ok(
            `${page.path} renders either list rows or an explicit empty state`,
            hit,
            hit ? "" : `none of ${JSON.stringify(page.anyOf)}`,
          );
        }
      } else {
        ok(`${page.path} exposes its promised controls`, false, "page did not render");
      }
    }
    {
      const p = await probe(ACCOUNT_PAGE.path, { cookie: roleCookies.admin });
      renders("/app/account renders (web-surface only)", p, ACCOUNT_PAGE.heading, "shell");
      const content = shellContent(p.body) ?? "";
      const missing = ACCOUNT_PAGE.controls.filter((c) => !content.includes(c));
      ok("/app/account exposes its promised controls", missing.length === 0, missing.length ? `missing ${JSON.stringify(missing)}` : "");
    }
    // Accessible names on the raw (non-Polaris) form controls each page
    // renders. Polaris <s-*-field> carries its own label; a bare
    // <input>/<textarea>/<select> needs aria-label/aria-labelledby/title.
    for (const page of [...WEB_PAGES, ACCOUNT_PAGE]) {
      const p = await probe(page.path, { cookie: roleCookies.admin });
      if (p.status !== 200) continue;
      const content = visible(shellContent(p.body) ?? "");
      const controls = content.match(/<(?:input|textarea|select)\b[^>]*>/g) ?? [];
      const nameless = controls.filter(
        (c) =>
          !/type="(hidden|submit|button)"/.test(c) &&
          !/aria-label=|aria-labelledby=|\btitle=/.test(c) &&
          !/\bid="/.test(c),
      );
      ok(
        `${page.path}: every raw form control has an accessible name`,
        nameless.length === 0,
        nameless.length ? nameless.map((c) => c.slice(0, 90)).join(" ") : `${controls.length} control(s)`,
      );
    }

    // The shell chrome itself.
    {
      const p = await probe("/app/inbox", { cookie: roleCookies.admin });
      ok("web shell renders the rail, top bar and sign-out form", ['class="ccws-shell"', 'class="ccws-topbar"', 'class="ccws-rail"', 'action="/web/logout"'].every((m) => p.body.includes(m)));
      ok("web shell links to the account page", p.body.includes('href="/app/account"'));
      ok("web shell never loads App Bridge on the web surface", !p.body.includes("app-bridge.js"), "");
    }

    // ══ 3. Role matrix: nav visibility + direct URL + actions ═══════════════
    section("3. Role authorization — nav, direct URL, actions");
    for (const role of ["owner", "admin", "agent"] as const) {
      const cookie = roleCookies[role];
      const expected = WEB_PAGES.filter((p) => can(role, "web", p.permission)).map((p) => p.path);
      const p = await probe("/app/inbox", { cookie });
      const hrefs = navHrefs(p.body);
      ok(
        `${role}: nav shows exactly the permitted entries`,
        JSON.stringify(hrefs) === JSON.stringify(expected),
        `got ${JSON.stringify(hrefs)}`,
      );
      const hidden = WEB_PAGES.filter((x) => !can(role, "web", x.permission)).map((x) => x.path);
      ok(`${role}: nav hides ${hidden.length} entr${hidden.length === 1 ? "y" : "ies"}`, hidden.every((h) => !hrefs.includes(h)));

      for (const page of WEB_PAGES) {
        const allowed = can(role, "web", page.permission);
        const r = await probe(page.path, { cookie });
        if (allowed) {
          ok(`${role} CAN open ${page.path}`, r.status === 200 && !boundaryHit(r.body), `${r.status}${boundaryHit(r.body) ?? ""}`);
        } else {
          ok(`${role} is REFUSED ${page.path} by direct URL`, r.status === 403, String(r.status));
        }
      }
      // /app/account is role-independent (every member has an account).
      const acct = await probe("/app/account", { cookie });
      ok(`${role} CAN open /app/account`, acct.status === 200 && !boundaryHit(acct.body), String(acct.status));
    }
    // Actions, not just pages.
    {
      const r = await probe("/app/settings", {
        cookie: roleCookies.agent,
        method: "POST",
        body: new URLSearchParams({ intent: "invite", name: "x", email: "x@example.invalid", role: "agent" }),
      });
      ok("agent POST /app/settings (invite a member) → 403", r.status === 403, String(r.status));
    }
    {
      const r = await probe("/app/curated-answers", {
        cookie: roleCookies.agent,
        method: "POST",
        body: new URLSearchParams({ intent: "create" }),
      });
      ok("agent POST /app/curated-answers → 403", r.status === 403, String(r.status));
    }
    {
      const r = await probe("/app/browse-data?kind=products", { cookie: roleCookies.agent });
      ok("agent GET /app/browse-data (ai_agent) → 403", r.status === 403, String(r.status));
    }
    {
      // billing_manage is admin-surface only for EVERY role, owner included.
      for (const role of ["owner", "admin"] as const) {
        const r = await probe("/app/plan-usage", {
          cookie: roleCookies[role],
          method: "POST",
          body: new URLSearchParams({ intent: "subscribe", planId: "basic", interval: "monthly" }),
        });
        ok(`web ${role} CANNOT run a billing mutation → 403`, r.status === 403, String(r.status));
      }
    }
    {
      const r = await probe("/app/web-handoff", { cookie: roleCookies.owner, method: "POST", body: new URLSearchParams({}) });
      ok("a web session cannot mint an admin→web handoff → 403", r.status === 403, String(r.status));
    }
    {
      // The inbox SSE feed is POST-only (App Bridge patches fetch, not ES).
      // It streams — abort it as soon as the headers prove out.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      try {
        const r = await fetch(`${BASE}/app/inbox-events`, {
          method: "POST",
          headers: { "user-agent": UA, cookie: roleCookies.agent, origin: BASE },
          signal: controller.signal,
        });
        ok(
          "agent CAN open the inbox SSE feed (POST)",
          r.status === 200 && (r.headers.get("content-type") ?? "").includes("text/event-stream"),
          `${r.status} ${r.headers.get("content-type")}`,
        );
        controller.abort();
      } catch (error) {
        ok("agent CAN open the inbox SSE feed (POST)", false, String(error));
      } finally {
        clearTimeout(timer);
      }
      const wrongMethod = await probe("/app/inbox-events");
      ok("GET on the POST-only SSE route fails cleanly (405, not 500)", wrongMethod.status === 405, String(wrongMethod.status));
    }
    {
      // A member whose shop lacks an offline Shopify session: the pages that
      // call access.getAdmin() must degrade, not hard-500 the web surface.
      if (!shopNoAdmin) {
        ok("(skipped) no session-less shop in the dev DB to probe", true, "every installed shop has an offline session");
      } else {
        const orphan = await mk(shopNoAdmin.id, "admin", "no-admin-session", {});
        const cookie = await cookieFor(orphan.id, shopNoAdmin.id);
        for (const path of ["/app", "/app/contacts", "/app/inbox", "/app/settings"]) {
          const r = await probe(path, { cookie });
          ok(
            `${path} does not hard-500 for a shop with no Shopify session`,
            r.status === 200 && !boundaryHit(r.body),
            `${r.status} ${boundaryHit(r.body) ?? ""} (${shopNoAdmin.domain})`,
          );
        }
      }
    }

    // ══ 4. Login ════════════════════════════════════════════════════════════
    section("4. Login — success, failure, anti-enumeration, lockout");
    {
      const p = await probe("/web/login", {
        method: "POST",
        body: new URLSearchParams({ email: admin.email, password: secret, next: "/app/settings" }),
      });
      const jar = p.setCookie.join(" | ");
      ok("correct password → 302 to next", p.status === 302 && p.location === "/app/settings", `${p.status} ${p.location}`);
      ok("correct password → cc_web_session + cc_surface cookies", /cc_web_session=[^;]+;/.test(jar) && /cc_surface=web/.test(jar), jar.slice(0, 160));
      ok("cc_web_session is HttpOnly + SameSite=Lax", /cc_web_session=[^;]+;[^|]*HttpOnly/.test(jar) && /cc_web_session=[^;]+;[^|]*SameSite=Lax/.test(jar));
      const raw = decodeURIComponent((jar.match(/cc_web_session=([^;]+)/) ?? ["", ""])[1]);
      const row = await db.teamSession.findFirst({ where: { tokenHash: hashToken(raw), kind: "session" } });
      ok("correct password → a TeamSession row for the right member+shop", row?.memberId === admin.id && row?.shopId === shopA.id);
      if (row) await db.teamSession.delete({ where: { id: row.id } }).catch(() => undefined);
    }
    {
      const before = await db.teamSession.count({ where: { memberId: lockTarget.id, kind: "session" } });
      const p = await probe("/web/login", {
        method: "POST",
        body: new URLSearchParams({ email: lockTarget.email, password: "definitely-wrong", next: "/app/inbox" }),
      });
      const after = await db.teamSession.count({ where: { memberId: lockTarget.id, kind: "session" } });
      ok("wrong password → no redirect, no session", p.status === 200 && after === before, `${p.status}, ${before}→${after}`);
      ok("wrong password → generic error, no enumeration", visible(p.body).includes("Incorrect email or password."), "");
      ok("wrong password → no Set-Cookie", !p.setCookie.join(" ").includes("cc_web_session="), "");
      const m = await db.teamMember.findUnique({ where: { id: lockTarget.id } });
      ok("wrong password increments the lockout counter", (m?.failedLogins ?? 0) === 1, `failedLogins=${m?.failedLogins}`);
    }
    {
      const unknown = await probe("/web/login", {
        method: "POST",
        body: new URLSearchParams({ email: `${TAG}-nobody-${stamp}@example.invalid`, password: "whatever", next: "/app/inbox" }),
      });
      ok(
        "unknown account gives the SAME generic error as a wrong password",
        unknown.status === 200 && visible(unknown.body).includes("Incorrect email or password."),
        String(unknown.status),
      );
    }
    {
      // 5 failures total → locked for 15 minutes (1 already burned above).
      for (let i = 0; i < 4; i++) {
        await probe("/web/login", {
          method: "POST",
          body: new URLSearchParams({ email: lockTarget.email, password: "definitely-wrong", next: "/app/inbox" }),
        });
      }
      const m = await db.teamMember.findUnique({ where: { id: lockTarget.id } });
      ok("5 failures → lockedUntil set (~15 min)", Boolean(m?.lockedUntil) && (m!.lockedUntil!.getTime() - Date.now()) > 13 * 60_000, `lockedUntil=${m?.lockedUntil?.toISOString()}`);
      const p = await probe("/web/login", {
        method: "POST",
        body: new URLSearchParams({ email: lockTarget.email, password: secret, next: "/app/inbox" }),
      });
      ok(
        "the CORRECT password is still refused while locked",
        p.status === 200 && visible(p.body).includes("Incorrect email or password.") && !p.setCookie.join(" ").includes("cc_web_session="),
        String(p.status),
      );
      // Counters clear once the lock expires.
      await db.teamMember.update({ where: { id: lockTarget.id }, data: { lockedUntil: new Date(Date.now() - 1000) } });
      const after = await probe("/web/login", {
        method: "POST",
        body: new URLSearchParams({ email: lockTarget.email, password: secret, next: "/app/inbox" }),
      });
      ok("after the lock expires the correct password works again", after.status === 302, `${after.status} ${after.location}`);
      await db.teamSession.deleteMany({ where: { memberId: lockTarget.id } });
    }
    {
      const p = await probe("/web/login?next=%2Fapp%2Fsettings", { cookie: roleCookies.admin });
      ok("/web/login while signed in → next", p.status === 302 && p.location === "/app/settings", `${p.status} ${p.location}`);
    }

    // ══ 5. Forgot / reset ═══════════════════════════════════════════════════
    section("5. Forgot / reset — issue, single use, expiry, wrong shop");
    {
      const before = await db.teamSession.count({ where: { memberId: admin.id, kind: "reset" } });
      const p = await probe("/web/forgot", { method: "POST", body: new URLSearchParams({ email: admin.email }) });
      const after = await db.teamSession.count({ where: { memberId: admin.id, kind: "reset" } });
      ok("POST /web/forgot issues exactly one reset token", after === before + 1 || after === 1, `${before}→${after}`);
      ok("POST /web/forgot answers identically (no enumeration)", p.status === 200 && visible(p.body).includes("If that email belongs to a team member"), String(p.status));
      const unknown = await probe("/web/forgot", {
        method: "POST",
        body: new URLSearchParams({ email: `${TAG}-nobody-${stamp}@example.invalid` }),
      });
      ok("unknown email gets the same answer", unknown.status === 200 && visible(unknown.body).includes("If that email belongs to a team member"));
    }
    {
      // A live session that the reset must kill.
      const doomed = await mintToken({ shopId: shopA.id, memberId: admin.id, kind: "session", ttlMs: 600_000 });
      const { links } = await requestPasswordReset(admin.email);
      const link = links.find((l) => l.url.includes("/web/reset/"));
      const token = link ? link.url.split("/web/reset/")[1] : "";
      ok("requestPasswordReset returns a /web/reset/<token> link", Boolean(token));
      const next = `${randomBytes(18).toString("base64url")}Bb2!`;
      const p = await probe(`/web/reset/${token}`, {
        method: "POST",
        body: new URLSearchParams({ password: next, confirm: next }),
      });
      ok("valid reset → 302 /web/login?reset=1", p.status === 302 && (p.location ?? "").includes("/web/login?reset=1"), `${p.status} ${p.location}`);
      ok("reset kills every existing session", (await readWebSession(new Request(`${BASE}/web/login`, { headers: { cookie: `cc_web_session=${doomed}` } }))) === null);
      const replay = await probe(`/web/reset/${token}`, {
        method: "POST",
        body: new URLSearchParams({ password: next, confirm: next }),
      });
      ok("a reset token is single-use (replay refused)", replay.status === 200 && visible(replay.body).includes("invalid"), `${replay.status}`);
      // Sign in again with the new password so later cases still work.
      const login = await probe("/web/login", {
        method: "POST",
        body: new URLSearchParams({ email: admin.email, password: next, next: "/app/inbox" }),
      });
      ok("the new password works", login.status === 302, String(login.status));
      await db.teamSession.deleteMany({ where: { memberId: admin.id, kind: "session" } });
      roleCookies.admin = await cookieFor(admin.id, shopA.id);
    }
    {
      const raw = await mintToken({ shopId: shopA.id, memberId: admin.id, kind: "reset", ttlMs: 600_000 });
      await db.teamSession.updateMany({ where: { tokenHash: hashToken(raw) }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const page = await probe(`/web/reset/${raw}`);
      ok("an expired reset token renders the invalid-link page", page.status === 200 && visible(page.body).includes("Reset link not valid"), String(page.status));
      const pw = `${randomBytes(18).toString("base64url")}Cc3!`;
      const p = await probe(`/web/reset/${raw}`, { method: "POST", body: new URLSearchParams({ password: pw, confirm: pw }) });
      ok("an expired reset token cannot set a password", p.status === 200 && !p.setCookie.join(" ").includes("cc_web_session="), String(p.status));
    }
    {
      // Wrong-shop: the shop-B twin's token must only ever touch the shop-B row.
      const beforeA = (await db.teamMember.findUnique({ where: { id: dualA.id } }))!.passwordHash;
      const raw = await mintToken({ shopId: shopB.id, memberId: dualB.id, kind: "reset", ttlMs: 600_000 });
      const pw = `${randomBytes(18).toString("base64url")}Dd4!`;
      const p = await probe(`/web/reset/${raw}`, { method: "POST", body: new URLSearchParams({ password: pw, confirm: pw }) });
      const afterA = (await db.teamMember.findUnique({ where: { id: dualA.id } }))!.passwordHash;
      const afterB = (await db.teamMember.findUnique({ where: { id: dualB.id } }))!.passwordHash;
      ok("a shop-B reset token changes ONLY the shop-B member", p.status === 302 && afterA === beforeA && afterB !== null, `${p.status}`);
      // Restore the shared password so the multi-shop picker case still works.
      await db.teamMember.update({ where: { id: dualB.id }, data: { passwordHash: await hashPassword(secret) } });
      await db.teamSession.deleteMany({ where: { memberId: dualB.id } });
    }
    {
      const pw = `${randomBytes(18).toString("base64url")}Ee5!`;
      const p = await probe("/web/reset/not-a-real-token", { method: "POST", body: new URLSearchParams({ password: pw, confirm: pw }) });
      ok("a forged reset token is refused", p.status === 200 && !p.setCookie.join(" ").includes("cc_web_session="), String(p.status));
    }

    // ══ 6. Invite ═══════════════════════════════════════════════════════════
    section("6. Invite — role granted, single use, expiry, wrong shop");
    {
      const invitee = await mk(shopA.id, "agent", "invitee", { status: "invited" });
      const raw = await mintToken({ shopId: shopA.id, memberId: invitee.id, kind: "invite", ttlMs: 600_000 });
      const pw = `${randomBytes(18).toString("base64url")}Ff6!`;
      const p = await probe(`/web/invite/${raw}`, {
        method: "POST",
        body: new URLSearchParams({ name: "QA Invited", password: pw, confirm: pw }),
      });
      ok("accepting an invite → 302 /app/inbox", p.status === 302 && (p.location ?? "").endsWith("/app/inbox"), `${p.status} ${p.location}`);
      const row = await db.teamMember.findUnique({ where: { id: invitee.id } });
      ok("the member is activated with the INVITED role (not escalated)", row?.status === "active" && row?.role === "agent", `${row?.status}/${row?.role}`);
      const jarRaw = decodeURIComponent((p.setCookie.join(" | ").match(/cc_web_session=([^;]+)/) ?? ["", ""])[1]);
      const session = jarRaw ? await readWebSession(new Request(`${BASE}/app/inbox`, { headers: { cookie: `cc_web_session=${jarRaw}` } })) : null;
      ok("acceptance signs the member in to the INVITING shop", session?.member.id === invitee.id && session?.shopId === shopA.id);
      // The new agent really is limited to the agent nav.
      if (jarRaw) {
        const shell = await probe("/app/inbox", { cookie: `cc_web_session=${jarRaw}; cc_surface=web` });
        ok("the freshly invited agent sees only the agent nav", JSON.stringify(navHrefs(shell.body)) === JSON.stringify(["/app/inbox", "/app/contacts"]), JSON.stringify(navHrefs(shell.body)));
      }
      const replay = await probe(`/web/invite/${raw}`, {
        method: "POST",
        body: new URLSearchParams({ name: "QA Replay", password: pw, confirm: pw }),
      });
      ok("an invite token is single-use (replay refused)", replay.status === 200 && !replay.setCookie.join(" ").includes("cc_web_session="), String(replay.status));
    }
    {
      const invitee = await mk(shopA.id, "admin", "invitee-exp", { status: "invited" });
      const raw = await mintToken({ shopId: shopA.id, memberId: invitee.id, kind: "invite", ttlMs: 600_000 });
      await db.teamSession.updateMany({ where: { tokenHash: hashToken(raw) }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const page = await probe(`/web/invite/${raw}`);
      ok("an expired invite renders the invalid-link page", page.status === 200 && visible(page.body).includes("Invitation not valid"), String(page.status));
      const pw = `${randomBytes(18).toString("base64url")}Gg7!`;
      const p = await probe(`/web/invite/${raw}`, { method: "POST", body: new URLSearchParams({ name: "x", password: pw, confirm: pw }) });
      const row = await db.teamMember.findUnique({ where: { id: invitee.id } });
      ok("an expired invite cannot activate the member", row?.status === "invited" && !p.setCookie.join(" ").includes("cc_web_session="), `${row?.status}`);
    }
    {
      // A shop-B invite must land the caller in shop B, never shop A.
      const invitee = await mk(shopB.id, "agent", "invitee-b", { status: "invited" });
      const raw = await mintToken({ shopId: shopB.id, memberId: invitee.id, kind: "invite", ttlMs: 600_000 });
      const pw = `${randomBytes(18).toString("base64url")}Hh8!`;
      const p = await probe(`/web/invite/${raw}`, { method: "POST", body: new URLSearchParams({ name: "QA B", password: pw, confirm: pw }) });
      const jarRaw = decodeURIComponent((p.setCookie.join(" | ").match(/cc_web_session=([^;]+)/) ?? ["", ""])[1]);
      const session = jarRaw ? await readWebSession(new Request(`${BASE}/app/inbox`, { headers: { cookie: `cc_web_session=${jarRaw}` } })) : null;
      ok("a shop-B invite yields a shop-B session only", session?.shopId === shopB.id && session?.member.id === invitee.id, `${session?.shopId}`);
    }
    {
      const pw = `${randomBytes(18).toString("base64url")}Ii9!`;
      const p = await probe("/web/invite/not-a-real-token", { method: "POST", body: new URLSearchParams({ name: "x", password: pw, confirm: pw }) });
      ok("a forged invite token is refused", p.status === 200 && !p.setCookie.join(" ").includes("cc_web_session="), String(p.status));
    }
    {
      // An invite token must not be usable on the reset route and vice versa.
      const invitee = await mk(shopA.id, "agent", "invitee-kind", { status: "invited" });
      const raw = await mintToken({ shopId: shopA.id, memberId: invitee.id, kind: "invite", ttlMs: 600_000 });
      const page = await probe(`/web/reset/${raw}`);
      ok("an invite token is NOT accepted by /web/reset", visible(page.body).includes("Reset link not valid"), "");
      const resetRaw = await mintToken({ shopId: shopA.id, memberId: invitee.id, kind: "reset", ttlMs: 600_000 });
      const invitePage = await probe(`/web/invite/${resetRaw}`);
      ok("a reset token is NOT accepted by /web/invite", visible(invitePage.body).includes("Invitation not valid"), "");
    }

    // ══ 7. Handoff ══════════════════════════════════════════════════════════
    section("7. /web/handoff — admin→web single-use sign-in");
    {
      const raw = await mintHandoffToken(shopA.id, owner.id, UA);
      const p = await probe(`/web/handoff?t=${encodeURIComponent(raw)}`);
      ok("a valid handoff token → 302 /app/inbox", p.status === 302 && (p.location ?? "").endsWith("/app/inbox"), `${p.status} ${p.location}`);
      const jarRaw = decodeURIComponent((p.setCookie.join(" | ").match(/cc_web_session=([^;]+)/) ?? ["", ""])[1]);
      const session = jarRaw ? await readWebSession(new Request(`${BASE}/app/inbox`, { headers: { cookie: `cc_web_session=${jarRaw}` } })) : null;
      ok("handoff signs in as the RIGHT member of the RIGHT shop", session?.member.id === owner.id && session?.shopId === shopA.id, `${session?.member.id} @ ${session?.shopId}`);
      const replay = await probe(`/web/handoff?t=${encodeURIComponent(raw)}`);
      ok("a replayed handoff token is refused", replay.status === 200 && visible(replay.body).includes("This link has expired"), String(replay.status));
      ok("a replayed handoff sets no cookie", !replay.setCookie.join(" ").includes("cc_web_session="));
    }
    {
      const raw = await mintHandoffToken(shopA.id, owner.id, UA);
      await db.teamSession.updateMany({ where: { tokenHash: hashToken(raw) }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const p = await probe(`/web/handoff?t=${encodeURIComponent(raw)}`);
      ok("an expired handoff token is refused", p.status === 200 && !p.setCookie.join(" ").includes("cc_web_session="), String(p.status));
      ok("the expired handoff row is deleted on read", (await db.teamSession.count({ where: { tokenHash: hashToken(raw) } })) === 0);
    }
    {
      const p = await probe(`/web/handoff?t=${encodeURIComponent(randomBytes(32).toString("base64url"))}`);
      ok("a forged handoff token is refused", p.status === 200 && visible(p.body).includes("This link has expired"), String(p.status));
    }
    {
      // Kind confusion: a live session cookie value replayed as a handoff.
      const sessionRaw = (roleCookies.admin.match(/cc_web_session=([^;]+)/) ?? ["", ""])[1];
      const p = await probe(`/web/handoff?t=${encodeURIComponent(sessionRaw)}`);
      ok("a session token is NOT accepted as a handoff token", p.status === 200 && !p.setCookie.join(" ").includes("cc_web_session="), String(p.status));
      ok("the replay attempt did not consume the live session", (await db.teamSession.count({ where: { tokenHash: hashToken(sessionRaw), kind: "session" } })) === 1);
    }
    {
      // A shop-B handoff must never open shop A.
      const raw = await mintHandoffToken(shopB.id, dualB.id, UA);
      const p = await probe(`/web/handoff?t=${encodeURIComponent(raw)}`);
      const jarRaw = decodeURIComponent((p.setCookie.join(" | ").match(/cc_web_session=([^;]+)/) ?? ["", ""])[1]);
      const session = jarRaw ? await readWebSession(new Request(`${BASE}/app/inbox`, { headers: { cookie: `cc_web_session=${jarRaw}` } })) : null;
      ok("a shop-B handoff yields a shop-B session only", session?.shopId === shopB.id, `${session?.shopId}`);
      await db.teamSession.deleteMany({ where: { memberId: dualB.id, kind: "session" } });
    }

    // ══ 8. CSRF ═════════════════════════════════════════════════════════════
    section("8. CSRF — every /web mutation refuses a foreign Origin/Referer");
    const EVIL = "https://evil.example";
    // The Vite dev server rejects a cross-origin POST itself (400 Bad Request)
    // before the app runs, which would mask app/lib/team/same-origin.server.ts.
    // Referer-only probes reach the route, so they prove the APP's guard; the
    // Origin probes below prove the request is refused either way.
    const evilRef = { origin: null as string | null, headers: { referer: `${EVIL}/attack` } };
    {
      const before = await db.teamSession.count({ where: { memberId: agent.id, kind: "session" } });
      const p = await probe("/web/logout", { cookie: roleCookies.agent, method: "POST", body: new URLSearchParams({}), origin: EVIL });
      const mid = await db.teamSession.count({ where: { memberId: agent.id, kind: "session" } });
      ok(
        "cross-site (Origin) POST /web/logout does NOT sign the user out",
        mid === before && !p.setCookie.join(" ").includes("cc_web_session=;"),
        `${before}→${mid}, ${p.status}`,
      );
      const r = await probe("/web/logout", { cookie: roleCookies.agent, method: "POST", body: new URLSearchParams({}), ...evilRef });
      const after = await db.teamSession.count({ where: { memberId: agent.id, kind: "session" } });
      ok(
        "cross-site (Referer) POST /web/logout is refused by the app's own guard",
        after === before && r.status === 302 && (r.location ?? "").endsWith("/web/login") && !r.setCookie.join(" ").includes("cc_web_session=;"),
        `${before}→${after}, ${r.status} ${r.location}`,
      );
    }
    {
      const p = await probe("/web/login", {
        method: "POST",
        body: new URLSearchParams({ email: admin.email, password: secret, next: "/app/inbox" }),
        origin: EVIL,
      });
      ok(
        "cross-site (Origin) POST /web/login mints no session",
        !p.setCookie.join(" ").includes("cc_web_session="),
        String(p.status),
      );
      const r = await probe("/web/login", {
        method: "POST",
        body: new URLSearchParams({ email: admin.email, password: secret, next: "/app/inbox" }),
        ...evilRef,
      });
      ok(
        "cross-site (Referer) POST /web/login is refused by the app's own guard",
        r.status === 200 && !r.setCookie.join(" ").includes("cc_web_session=") && visible(r.body).includes("Request blocked"),
        String(r.status),
      );
    }
    {
      const before = await db.teamSession.count({ where: { memberId: owner.id, kind: "reset" } });
      const p = await probe("/web/forgot", { method: "POST", body: new URLSearchParams({ email: owner.email }), origin: EVIL });
      const mid = await db.teamSession.count({ where: { memberId: owner.id, kind: "reset" } });
      ok("cross-site (Origin) POST /web/forgot mints no reset token", mid === before, `${before}→${mid}, ${p.status}`);
      const r = await probe("/web/forgot", { method: "POST", body: new URLSearchParams({ email: owner.email }), ...evilRef });
      const after = await db.teamSession.count({ where: { memberId: owner.id, kind: "reset" } });
      ok(
        "cross-site (Referer) POST /web/forgot mints no token and answers identically",
        after === before && r.status === 200 && visible(r.body).includes("If that email belongs to a team member"),
        `${before}→${after}, ${r.status}`,
      );
    }
    {
      const raw = await mintToken({ shopId: shopA.id, memberId: owner.id, kind: "reset", ttlMs: 600_000 });
      const beforeHash = (await db.teamMember.findUnique({ where: { id: owner.id } }))!.passwordHash;
      const pw = `${randomBytes(18).toString("base64url")}Jj0!`;
      const p = await probe(`/web/reset/${raw}`, { method: "POST", body: new URLSearchParams({ password: pw, confirm: pw }), origin: EVIL });
      const midHash = (await db.teamMember.findUnique({ where: { id: owner.id } }))!.passwordHash;
      ok("cross-site (Origin) POST /web/reset does not change the password", midHash === beforeHash, String(p.status));
      const r = await probe(`/web/reset/${raw}`, { method: "POST", body: new URLSearchParams({ password: pw, confirm: pw }), ...evilRef });
      const afterHash = (await db.teamMember.findUnique({ where: { id: owner.id } }))!.passwordHash;
      ok(
        "cross-site (Referer) POST /web/reset is refused by the app's own guard",
        afterHash === beforeHash && visible(r.body).includes("Request blocked"),
        String(r.status),
      );
      ok("the reset token survives a blocked cross-site attempt", (await findToken(raw, "reset")) !== null);
      await db.teamSession.deleteMany({ where: { tokenHash: hashToken(raw) } });
    }
    {
      const invitee = await mk(shopA.id, "agent", "invitee-csrf", { status: "invited" });
      const raw = await mintToken({ shopId: shopA.id, memberId: invitee.id, kind: "invite", ttlMs: 600_000 });
      const pw = `${randomBytes(18).toString("base64url")}Kk1!`;
      const p = await probe(`/web/invite/${raw}`, { method: "POST", body: new URLSearchParams({ name: "x", password: pw, confirm: pw }), origin: EVIL });
      const mid = await db.teamMember.findUnique({ where: { id: invitee.id } });
      ok("cross-site (Origin) POST /web/invite does not activate the member", mid?.status === "invited", `${mid?.status} ${p.status}`);
      const r = await probe(`/web/invite/${raw}`, { method: "POST", body: new URLSearchParams({ name: "x", password: pw, confirm: pw }), ...evilRef });
      const row = await db.teamMember.findUnique({ where: { id: invitee.id } });
      ok(
        "cross-site (Referer) POST /web/invite is refused by the app's own guard",
        row?.status === "invited" && visible(r.body).includes("Request blocked"),
        `${row?.status} ${r.status}`,
      );
    }
    {
      // GET must never mutate (a cross-site <img> logout).
      const before = await db.teamSession.count({ where: { memberId: agent.id, kind: "session" } });
      await probe("/web/logout", { cookie: roleCookies.agent, origin: EVIL });
      const after = await db.teamSession.count({ where: { memberId: agent.id, kind: "session" } });
      ok("GET /web/logout never destroys a session", after === before, `${before}→${after}`);
    }

    // ══ 9. Multi-shop ═══════════════════════════════════════════════════════
    section("9. Multi-shop — store picker + id tampering");
    {
      const p = await probe("/web/login", {
        method: "POST",
        body: new URLSearchParams({ email: dualEmail, password: secret, next: "/app/inbox" }),
      });
      ok("a two-shop member gets a store picker, not a session", p.status === 200 && !p.setCookie.join(" ").includes("cc_web_session="), String(p.status));
      ok("the picker names both stores", visible(p.body).includes("Choose a store") && (p.body.match(/name="shopId" value="/g) ?? []).length === 2, `${(p.body.match(/name="shopId" value="/g) ?? []).length} option(s)`);
      ok("the picker shows the per-store role", visible(p.body).includes("ccwa-pickRole"), "");
    }
    {
      const p = await probe("/web/login", {
        method: "POST",
        body: new URLSearchParams({ email: dualEmail, password: secret, shopId: shopB.id, next: "/app/inbox" }),
      });
      const jarRaw = decodeURIComponent((p.setCookie.join(" | ").match(/cc_web_session=([^;]+)/) ?? ["", ""])[1]);
      const session = jarRaw ? await readWebSession(new Request(`${BASE}/app/inbox`, { headers: { cookie: `cc_web_session=${jarRaw}` } })) : null;
      ok("choosing a store signs in to THAT store", p.status === 302 && session?.shopId === shopB.id && session?.member.id === dualB.id, `${p.status} ${session?.shopId}`);

      const bCookie = `cc_web_session=${jarRaw}; cc_surface=web`;
      // The shop-B member is an agent there — the role travels with the shop.
      const shell = await probe("/app/inbox", { cookie: bCookie });
      ok("the role used is the chosen shop's role (agent), not the other shop's admin", JSON.stringify(navHrefs(shell.body)) === JSON.stringify(["/app/inbox", "/app/contacts"]), JSON.stringify(navHrefs(shell.body)));

      // Tamper: ask shop A's session for shop B's conversation, and vice versa.
      const aRead = await probe(`/app/inbox?c=${victimConv.id}`, { cookie: roleCookies.admin });
      ok(
        "a shop-A session cannot read a shop-B conversation by id",
        aRead.status === 200 && !aRead.body.includes(`${TAG}-secret-marker-${stamp}`),
        String(aRead.status),
      );
      const bRead = await probe(`/app/inbox?c=${victimConv.id}`, { cookie: bCookie });
      ok("the owning shop's session CAN read it (the probe is meaningful)", bRead.status === 200 && bRead.body.includes(`${TAG}-secret-marker-${stamp}`), String(bRead.status));

      // Tamper: mutate the other shop's conversation.
      const beforeMsgs = await db.message.count({ where: { conversationId: victimConv.id } });
      const send = await probe("/app/inbox", {
        cookie: roleCookies.admin,
        method: "POST",
        body: new URLSearchParams({ intent: "send", conversationId: victimConv.id, content: `${TAG}-injected` }),
      });
      const afterMsgs = await db.message.count({ where: { conversationId: victimConv.id } });
      ok("a shop-A session cannot post into a shop-B conversation", afterMsgs === beforeMsgs, `${beforeMsgs}→${afterMsgs} (HTTP ${send.status})`);

      const del = await probe("/app/inbox", {
        cookie: roleCookies.admin,
        method: "POST",
        body: new URLSearchParams({ intent: "delete", conversationId: victimConv.id }),
      });
      ok("a shop-A session cannot delete a shop-B conversation", (await db.conversation.count({ where: { id: victimConv.id } })) === 1, `HTTP ${del.status}`);

      const assign = await probe("/app/inbox", {
        cookie: bCookie,
        method: "POST",
        body: new URLSearchParams({ intent: "assign", conversationId: victimConv.id, assigneeId: admin.id }),
      });
      const conv = await db.conversation.findUnique({ where: { id: victimConv.id } });
      ok("a conversation cannot be assigned to another shop's member", conv?.assigneeId !== admin.id, `assigneeId=${conv?.assigneeId} (HTTP ${assign.status})`);

      // And the mirror image: shop B must not see shop A's thread either.
      const mine = await probe(`/app/inbox?c=${homeConv.id}`, { cookie: roleCookies.admin });
      ok("the shop-A session CAN read its own thread (the probe is meaningful)", mine.status === 200 && mine.body.includes(`${TAG}-home-marker-${stamp}`), String(mine.status));
      const theirs = await probe(`/app/inbox?c=${homeConv.id}`, { cookie: bCookie });
      ok(
        "a shop-B session cannot read a shop-A conversation by id",
        theirs.status === 200 && !theirs.body.includes(`${TAG}-home-marker-${stamp}`),
        String(theirs.status),
      );

      await db.teamSession.deleteMany({ where: { memberId: dualB.id, kind: "session" } });
    }
    {
      // A session cookie whose shop was uninstalled must be bounced, not served.
      const p = await probe("/app/inbox", { cookie: "cc_web_session=this-token-does-not-exist; cc_surface=web" });
      ok(
        "an unknown web cookie bounces to /web/login and is cleared",
        p.status === 302 && (p.location ?? "").startsWith("/web/login?next=") && p.setCookie.join(" ").includes("cc_web_session=;"),
        `${p.status} ${p.location}`,
      );
    }

    // ══ 10. Static UI review of app/routes/web*.tsx ══════════════════════════
    section("10. Static UI review — app/routes/web*.tsx");
    const webRouteFiles = readdirSync(ROUTES_DIR).filter((f) => /^web(\.|_)/.test(f) && f.endsWith(".tsx") && !f.startsWith("webhooks"));
    ok("the web surface exposes the 8 documented routes", webRouteFiles.length === 8, webRouteFiles.join(", "));
    for (const file of webRouteFiles) {
      const src = readFileSync(join(ROUTES_DIR, file), "utf-8");
      const lines = src.split(/\r?\n/);

      // (a) no raw <a href> for internal navigation
      const rawAnchors = lines
        .map((l, i) => ({ l, n: i + 1 }))
        .filter(({ l }) => /<a\s[^>]*href=["']\/(?!\/)/.test(l));
      ok(
        `${file}: no raw <a href> for internal nav`,
        rawAnchors.length === 0,
        rawAnchors.map((a) => `line ${a.n}`).join(", "),
      );

      // (b) forms submit through react-router <Form method="post">
      const forms = [...src.matchAll(/<Form\b[^>]*>/g)].map((m) => m[0]);
      ok(
        `${file}: every <Form> declares method="post"`,
        forms.every((f) => /method="post"/.test(f)),
        forms.length ? `${forms.length} form(s)` : "no forms",
      );
      ok(`${file}: no raw <form> element (bypasses the router)`, !/<form\s/.test(src), "");

      // (c) every input has a label
      const fields = [...src.matchAll(/<s-(?:text|email|password|number|search)-field\b[\s\S]*?\/?>/g)].map((m) => m[0]);
      ok(
        `${file}: every input field has a label`,
        fields.every((f) => /\blabel=/.test(f)),
        fields.length ? `${fields.length} field(s)` : "no fields",
      );

      // (d) buttons have accessible text — a {expr} child counts as text
      // (it renders the shop name etc.); only truly nameless icon-only
      // buttons are a defect.
      const buttons = [...src.matchAll(/<(?:s-)?button\b[^>]*>([\s\S]*?)<\/(?:s-)?button>/g)];
      const nameless = buttons.filter(
        ([whole, inner]) =>
          !/accessibilityLabel=|aria-label=/.test(whole) &&
          inner
            .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
            .replace(/\{[^{}]*\}/g, "x")
            .replace(/<[^>]+>/g, "")
            .trim().length === 0,
      );
      ok(`${file}: every button has accessible text`, nameless.length === 0, `${nameless.length} nameless of ${buttons.length}`);

      // (e) an ACTION that can return an error must render that error state.
      // (web.logout's action only ever redirects, and web.handoff has no
      // action at all — its "expired" state comes from the loader.)
      const actionSrc = src.includes("export const action")
        ? src.slice(src.indexOf("export const action"), src.indexOf("export default") === -1 ? undefined : src.indexOf("export default"))
        : "";
      const returnsError = /return\s*\{[^}]*\berror\b/.test(actionSrc) || /return\s*\{\s*ok:\s*false/.test(actionSrc);
      if (returnsError) {
        ok(
          `${file}: renders the action's error state`,
          /actionData\?\.error/.test(src) && /tone="critical"/.test(src),
          "",
        );
      }
      // (f) a form that stays on the page must show a busy/loading state.
      if (forms.length > 0 && /useActionData/.test(src)) {
        ok(`${file}: form has a busy/loading state`, /useNavigation\(\)/.test(src) && /loading=\{|disabled=\{/.test(src), "");
      }
      // (g) token pages must render an invalid-token state
      if (/\$token/.test(file)) {
        ok(`${file}: renders an invalid/expired-token state`, /valid: false|!data\.valid/.test(src), "");
      }
    }
    {
      // The layout must set the non-embeddable headers for every child.
      const layout = readFileSync(join(ROUTES_DIR, "web.tsx"), "utf-8");
      ok(
        "web.tsx sets frame-ancestors/X-Frame-Options/no-store/Referrer-Policy",
        ["frame-ancestors 'none'", "X-Frame-Options", "no-store", "Referrer-Policy"].every((h) => layout.includes(h)),
      );
      ok("web.tsx never turns on App Bridge (embedded={false})", /embedded=\{false\}/.test(layout));
    }
  } finally {
    // ── Cleanup: fixtures only, never pre-existing rows ─────────────────────
    for (const conv of [victimConv, homeConv]) {
      await db.message.deleteMany({ where: { conversationId: conv.id } }).catch(() => undefined);
      await db.conversation.delete({ where: { id: conv.id } }).catch(() => undefined);
    }
    const all = await db.teamMember.findMany({ where: { email: { startsWith: `${TAG}-` } }, select: { id: true } });
    const ids = [...new Set([...memberIds, ...all.map((m) => m.id)])];
    await db.teamSession.deleteMany({ where: { memberId: { in: ids } } }).catch(() => undefined);
    await db.pushSubscription.deleteMany({ where: { memberId: { in: ids } } }).catch(() => undefined);
    await db.teamMember.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
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
    // closing handles and aborts with a libuv assertion on Windows).
    process.exitCode = failed === 0 ? 0 : 1;
    setTimeout(() => process.exit(failed === 0 ? 0 : 1), 5000).unref();
  });
