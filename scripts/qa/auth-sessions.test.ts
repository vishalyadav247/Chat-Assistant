/* QA: sessions, authentication, authorization and cookies across the three
 * surfaces (Shopify admin, /web team app, /platform operator console).
 *
 *   Run: npx tsx scripts/qa/auth-sessions.test.ts
 *   Needs: the dev server on http://localhost:3000 (BASE_URL to override) and
 *          the dev Postgres up.
 *
 * Adversarial by design: every case tries to BREAK a guard. Fixtures are
 * tagged and removed in the finally block, which also disconnects the shared
 * app/db.server singleton — without that the process hangs forever.
 *
 * No secret is ever printed: the fixture password is random per run and only
 * ever referenced by variable.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";

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
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const TAG = "qa-auth";
const DAY = 24 * 60 * 60 * 1000;

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

function req(cookie?: string, url = `${BASE}/web/login`): Request {
  const headers = new Headers({ "user-agent": UA });
  if (cookie) headers.set("cookie", cookie);
  return new Request(url, { headers });
}

interface Probe {
  status: number;
  location: string | null;
  body: string;
  setCookie: string[];
}
async function probe(
  path: string,
  init: {
    method?: string;
    cookie?: string;
    body?: BodyInit;
    headers?: Record<string, string>;
    origin?: string | null;
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
  });
  return {
    status: res.status,
    location: res.headers.get("location"),
    body: await res.text(),
    setCookie: typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [],
  };
}

function cookieAttr(setCookies: string[], name: string): string | null {
  return setCookies.find((c) => c.startsWith(`${name}=`)) ?? null;
}

/** Poll a predicate — the sliding-expiry bump is fire-and-forget. */
async function eventually(check: () => Promise<boolean>, ms = 3000): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    if (await check()) return true;
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function main(): Promise<void> {
  const db = (await import("../../app/db.server")).default;
  const { can, hasShopifySignals } = await import("../../app/lib/access.server");
  const { safeNext } = await import("../../app/lib/team/safe-next");
  const { sameOrigin } = await import("../../app/lib/team/same-origin.server");
  const { hashPassword, verifyPassword } = await import("../../app/lib/team/password.server");
  const {
    createWebSession,
    readWebSession,
    destroyWebSession,
    revokeMemberSessions,
    sessionCookieHeaders,
    clearSessionCookieHeaders,
  } = await import("../../app/lib/team/web-session.server");
  const { mintToken, findToken, consumeToken, purgeExpiredTokens } = await import(
    "../../app/lib/team/tokens.server"
  );
  const {
    verifyLogin,
    setMemberStatus,
    removeMember,
    resetPassword,
    setPassword,
    mintHandoffToken,
    consumeHandoffToken,
    acceptInvite,
    peekInvite,
  } = await import("../../app/lib/team/team.server");
  const {
    createPlatformSession,
    readPlatformSession,
    revokeAdminSessions,
    purgeExpiredPlatformSessions,
    platformSafeNext,
    destroyPlatformSession,
  } = await import("../../app/lib/platform/platform-auth.server");

  try {
    const res = await fetch(`${BASE}/web/login`, { headers: { "user-agent": UA } });
    if (!res.ok) throw new Error(`status ${res.status}`);
  } catch (error) {
    // Never let an unreachable server look like a clean run — record a real
    // failure so the exit code is non-zero and the gap is visible.
    ok(`dev server reachable at ${BASE}`, false, `run \`npm run dev\` first — HTTP coverage NOT executed (${String(error)})`);
    return;
  }

  // ── Fixtures ──────────────────────────────────────────────────────────────
  // Shop A: an installed shop that has a live offline Shopify session, so
  // pages needing the Admin API work. Shop B: any other installed shop — the
  // cross-tenant victim.
  const offline = await db.session.findFirst({ where: { isOnline: false }, select: { shop: true } });
  const shopA =
    (offline ? await db.shop.findUnique({ where: { domain: offline.shop } }) : null) ??
    (await db.shop.findFirst({ where: { uninstalledAt: null } }));
  const shopB = await db.shop.findFirst({ where: { uninstalledAt: null, id: { not: shopA?.id ?? "" } } });
  if (!shopA || !shopB) {
    ok("two installed shops available for tenancy tests", false, "seed the dev DB first");
    return;
  }

  const stamp = Date.now();
  const secret = `${randomBytes(18).toString("base64url")}Aa1!`; // never printed
  const memberIds: string[] = [];
  const mk = async (
    shopId: string,
    role: "owner" | "admin" | "agent",
    label: string,
    withPassword: boolean,
  ) => {
    const m = await db.teamMember.create({
      data: {
        shopId,
        email: `${TAG}-${label}-${stamp}@example.invalid`,
        name: `QA ${label}`,
        role,
        status: "active",
        passwordHash: withPassword ? await hashPassword(secret) : null,
      },
    });
    memberIds.push(m.id);
    return m;
  };

  // A throwaway operator account. NEVER reuse the real one: revokeAdminSessions
  // is global-per-admin and would sign the actual operator out everywhere.
  const qaPlatformAdmin = await db.platformAdmin.create({
    data: {
      email: `${TAG}-operator-${stamp}@example.invalid`,
      name: "QA operator",
      passwordHash: await hashPassword(secret),
    },
  });

  const aAdmin = await mk(shopA.id, "admin", "a-admin", true);
  const aAgent = await mk(shopA.id, "agent", "a-agent", false);
  const bAdmin = await mk(shopB.id, "admin", "b-admin", false);

  // A conversation + contact that belong to shop B and must stay invisible.
  const victimConv = await db.conversation.create({
    data: { shopId: shopB.id, sessionId: `${TAG}-victim-${stamp}`, status: "open", unread: true },
  });
  const victimContact = await db.contact.create({
    data: { shopId: shopB.id, name: `${TAG} victim`, email: `${TAG}-victim-${stamp}@example.invalid`, type: "lead" },
  });
  await db.message.create({
    data: { conversationId: victimConv.id, shopId: shopB.id, role: "in", author: "shopper", content: `${TAG}-secret-marker` },
  });

  try {
    // ══ 1. Authorization matrix (can()) ═══════════════════════════════════════
    section("1. Authorization matrix — can(role, surface, permission)");
    const ALL = [
      "dashboard",
      "inbox",
      "contacts",
      "chatbox",
      "ai_agent",
      "proactive",
      "curated",
      "analytics",
      "plan",
      "settings",
    ] as const;
    ok(
      "agent → inbox + contacts ONLY (web)",
      ALL.every((p) => can("agent", "web", p) === (p === "inbox" || p === "contacts")),
    );
    ok(
      "agent → inbox + contacts ONLY (admin surface too)",
      ALL.every((p) => can("agent", "admin", p) === (p === "inbox" || p === "contacts")),
    );
    ok("admin → everything except billing_manage on web", ALL.every((p) => can("admin", "web", p)) && !can("admin", "web", "billing_manage"));
    ok("owner → same as admin on web", ALL.every((p) => can("owner", "web", p) === can("admin", "web", p)) && !can("owner", "web", "billing_manage"));
    ok(
      "billing_manage → admin surface only, for every role",
      (["owner", "admin", "agent"] as const).every((r) => can(r, "admin", "billing_manage") === true && can(r, "web", "billing_manage") === false),
    );

    // ══ 2. TeamSession lifecycle ══════════════════════════════════════════════
    section("2. TeamSession — 30-day sliding TTL, expiry, revocation");
    {
      const { rawToken } = await createWebSession({ request: req(), shopId: shopA.id, memberId: aAdmin.id });
      const row = await db.teamSession.findFirst({ where: { memberId: aAdmin.id, kind: "session" } });
      ok("createWebSession stores sha256(token), never the raw token", row !== null && row.tokenHash === createHash("sha256").update(rawToken).digest("hex"));
      ok("raw token is NOT stored anywhere in the row", row !== null && JSON.stringify(row).includes(rawToken) === false);
      const ttlDays = row ? Math.round((row.expiresAt.getTime() - Date.now()) / DAY) : 0;
      ok("TTL is 30 days", ttlDays === 30, `${ttlDays}d`);

      const session = await readWebSession(req(`cc_web_session=${rawToken}`));
      ok("readWebSession resolves the member + shop", session?.member.id === aAdmin.id && session?.shopId === shopA.id);

      // Fresh lastSeenAt → must NOT write (renew at most once per day).
      const beforeExp = row!.expiresAt.getTime();
      await readWebSession(req(`cc_web_session=${rawToken}`));
      await new Promise((r) => setTimeout(r, 300));
      const same = await db.teamSession.findUnique({ where: { id: row!.id } });
      ok("sliding renewal is throttled to once per day", same!.expiresAt.getTime() === beforeExp);

      // lastSeenAt older than a day → renews.
      await db.teamSession.update({
        where: { id: row!.id },
        data: { lastSeenAt: new Date(Date.now() - 2 * DAY), expiresAt: new Date(Date.now() + 10 * DAY) },
      });
      await readWebSession(req(`cc_web_session=${rawToken}`));
      const renewed = await eventually(async () => {
        const r = await db.teamSession.findUnique({ where: { id: row!.id } });
        return !!r && r.expiresAt.getTime() - Date.now() > 29 * DAY;
      });
      ok("a session older than a day slides back to 30 days", renewed);

      // Expired → rejected AND the row is cleaned up on read.
      await db.teamSession.update({ where: { id: row!.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const dead = await readWebSession(req(`cc_web_session=${rawToken}`));
      ok("an expired session is rejected", dead === null);
      ok("an expired session row is deleted on read", (await db.teamSession.findUnique({ where: { id: row!.id } })) === null);

      // Tampered / unknown token.
      ok("an unknown token is rejected", (await readWebSession(req("cc_web_session=not-a-real-token"))) === null);
      ok("an absurdly long token is rejected without a DB hit", (await readWebSession(req(`cc_web_session=${"x".repeat(500)}`))) === null);
      ok("no cookie → no session", (await readWebSession(req())) === null);
    }

    {
      // revokeMemberSessions, with and without an exception.
      const a = await createWebSession({ request: req(), shopId: shopA.id, memberId: aAdmin.id });
      const b = await createWebSession({ request: req(), shopId: shopA.id, memberId: aAdmin.id });
      const keep = (await readWebSession(req(`cc_web_session=${a.rawToken}`)))!.sessionId;
      await revokeMemberSessions(shopA.id, aAdmin.id, keep);
      ok("revokeMemberSessions(except) keeps the current session", (await readWebSession(req(`cc_web_session=${a.rawToken}`))) !== null);
      ok("revokeMemberSessions(except) kills the others", (await readWebSession(req(`cc_web_session=${b.rawToken}`))) === null);
      await revokeMemberSessions(shopA.id, aAdmin.id);
      ok("revokeMemberSessions() kills every session", (await readWebSession(req(`cc_web_session=${a.rawToken}`))) === null);
      ok("revokeMemberSessions is shop-scoped", (await db.teamSession.count({ where: { memberId: aAdmin.id, kind: "session" } })) === 0);
    }

    {
      // A disabled member's live cookie must stop working immediately.
      const s = await createWebSession({ request: req(), shopId: shopA.id, memberId: aAgent.id });
      await db.pushSubscription.create({
        data: { shopId: shopA.id, memberId: aAgent.id, endpoint: `https://example.invalid/${TAG}-${stamp}`, p256dh: "x", auth: "y" },
      });
      await setMemberStatus(shopA.id, aAgent.id, "disabled");
      ok("disabling a member revokes their sessions", (await db.teamSession.count({ where: { memberId: aAgent.id, kind: "session" } })) === 0);
      ok("disabling a member deletes their push subscriptions", (await db.pushSubscription.count({ where: { memberId: aAgent.id } })) === 0);
      ok("a disabled member's cookie no longer resolves", (await readWebSession(req(`cc_web_session=${s.rawToken}`))) === null);
      await setMemberStatus(shopA.id, aAgent.id, "active");
      // …and even without the revoke, status is re-checked on every read.
      const s2 = await createWebSession({ request: req(), shopId: shopA.id, memberId: aAgent.id });
      await db.teamMember.update({ where: { id: aAgent.id }, data: { status: "disabled" } });
      ok("status is re-checked on every read (not just at revoke time)", (await readWebSession(req(`cc_web_session=${s2.rawToken}`))) === null);
      await db.teamMember.update({ where: { id: aAgent.id }, data: { status: "active" } });
      await db.teamSession.deleteMany({ where: { memberId: aAgent.id } });
    }

    {
      // destroyWebSession + the cookie-clearing headers.
      const s = await createWebSession({ request: req(), shopId: shopA.id, memberId: aAdmin.id });
      const headers = await destroyWebSession(req(`cc_web_session=${s.rawToken}`));
      ok("destroyWebSession deletes the row", (await readWebSession(req(`cc_web_session=${s.rawToken}`))) === null);
      const cleared = headers.get("set-cookie") ?? "";
      ok("destroyWebSession clears the cookie (Max-Age=0, HttpOnly)", /cc_web_session=;/.test(cleared) && /Max-Age=0/.test(cleared) && /HttpOnly/.test(cleared), cleared);
      ok("clearing does NOT drop the cc_surface marker", !cleared.includes("cc_surface"), cleared);
    }

    // ══ 3. Password change semantics ══════════════════════════════════════════
    section("3. Password change revokes the right sessions");
    {
      const a = await createWebSession({ request: req(), shopId: shopA.id, memberId: aAdmin.id });
      const b = await createWebSession({ request: req(), shopId: shopA.id, memberId: aAdmin.id });
      const keep = (await readWebSession(req(`cc_web_session=${a.rawToken}`)))!.sessionId;
      const next = `${randomBytes(18).toString("base64url")}Bb2!`;
      const result = await setPassword(shopA.id, aAdmin.id, next, keep);
      ok("setPassword succeeds", result.ok === true, result.error ?? "");
      ok("setPassword keeps the caller's session", (await readWebSession(req(`cc_web_session=${a.rawToken}`))) !== null);
      ok("setPassword revokes every OTHER session", (await readWebSession(req(`cc_web_session=${b.rawToken}`))) === null);
      // Restore the fixture password for the login tests below.
      await db.teamMember.update({ where: { id: aAdmin.id }, data: { passwordHash: await hashPassword(secret) } });
      await db.teamSession.deleteMany({ where: { memberId: aAdmin.id } });
    }
    {
      // A reset-link flow: no session is "current", so every session dies.
      const a = await createWebSession({ request: req(), shopId: shopA.id, memberId: aAdmin.id });
      const b = await createWebSession({ request: req(), shopId: shopA.id, memberId: aAdmin.id });
      const raw = await mintToken({ shopId: shopA.id, memberId: aAdmin.id, kind: "reset", ttlMs: 60 * 60 * 1000 });
      const next = `${randomBytes(18).toString("base64url")}Cc3!`;
      const out = await resetPassword(raw, next);
      ok("resetPassword succeeds with a live token", out.ok === true);
      ok("resetPassword revokes ALL sessions", (await readWebSession(req(`cc_web_session=${a.rawToken}`))) === null && (await readWebSession(req(`cc_web_session=${b.rawToken}`))) === null);
      ok("the new password verifies, the old one does not", (await verifyPassword(next, (await db.teamMember.findUnique({ where: { id: aAdmin.id } }))!.passwordHash)) && !(await verifyPassword(secret, (await db.teamMember.findUnique({ where: { id: aAdmin.id } }))!.passwordHash)));
      await db.teamMember.update({ where: { id: aAdmin.id }, data: { passwordHash: await hashPassword(secret) } });
    }

    // ══ 4. One-time tokens really are one-time ════════════════════════════════
    section("4. One-time tokens — TTL + replay");
    {
      const handoff = await mintHandoffToken(shopA.id, aAdmin.id, UA);
      const hRow = await db.teamSession.findFirst({ where: { tokenHash: createHash("sha256").update(handoff).digest("hex") } });
      const hMin = hRow ? Math.round((hRow.expiresAt.getTime() - Date.now()) / 60000) : -1;
      ok("handoff token TTL is 2 minutes", hMin === 2, `${hMin}min`);
      ok("handoff consumes once", (await consumeHandoffToken(handoff)) !== null);
      ok("handoff REPLAY fails", (await consumeHandoffToken(handoff)) === null);

      const reset = await mintToken({ shopId: shopA.id, memberId: aAdmin.id, kind: "reset", ttlMs: 60 * 60 * 1000 });
      const rRow = await db.teamSession.findFirst({ where: { tokenHash: createHash("sha256").update(reset).digest("hex") } });
      const rMin = rRow ? Math.round((rRow.expiresAt.getTime() - Date.now()) / 60000) : -1;
      ok("reset token TTL is 1 hour", rMin === 60, `${rMin}min`);
      ok("a reset token is NOT accepted as a session cookie", (await readWebSession(req(`cc_web_session=${reset}`))) === null);
      ok("a reset token is NOT accepted as an invite", (await consumeToken(reset, "invite")) === null);
      const pw = `${randomBytes(18).toString("base64url")}Dd4!`;
      ok("resetPassword consumes it", (await resetPassword(reset, pw)).ok === true);
      ok("reset REPLAY fails", (await resetPassword(reset, pw)).ok === false);
      await db.teamMember.update({ where: { id: aAdmin.id }, data: { passwordHash: await hashPassword(secret) } });

      // Invite: 7 days, single use, and it must not activate a live account.
      const invitee = await db.teamMember.create({
        data: { shopId: shopA.id, email: `${TAG}-invitee-${stamp}@example.invalid`, name: "QA invitee", role: "agent", status: "invited" },
      });
      memberIds.push(invitee.id);
      const invite = await mintToken({ shopId: shopA.id, memberId: invitee.id, kind: "invite", ttlMs: 7 * DAY });
      const iRow = await db.teamSession.findFirst({ where: { tokenHash: createHash("sha256").update(invite).digest("hex") } });
      const iDays = iRow ? Math.round((iRow.expiresAt.getTime() - Date.now()) / DAY) : -1;
      ok("invite token TTL is 7 days", iDays === 7, `${iDays}d`);
      ok("peekInvite resolves before use", (await peekInvite(invite)) !== null);
      const invitePw = `${randomBytes(18).toString("base64url")}Ee5!`;
      ok("acceptInvite consumes it", (await acceptInvite({ raw: invite, name: "QA invitee", password: invitePw })).ok === true);
      ok("invite REPLAY fails", (await acceptInvite({ raw: invite, name: "QA invitee", password: invitePw })).ok === false);
      ok("peekInvite after use returns null", (await peekInvite(invite)) === null);

      // An expired token is rejected and swept on read.
      const stale = await mintToken({ shopId: shopA.id, memberId: aAdmin.id, kind: "reset", ttlMs: 1000 });
      const staleHash = createHash("sha256").update(stale).digest("hex");
      await db.teamSession.updateMany({ where: { tokenHash: staleHash }, data: { expiresAt: new Date(Date.now() - 1000) } });
      ok("an expired one-time token is rejected", (await findToken(stale, "reset")) === null);
      ok("an expired one-time token row is deleted on read", (await db.teamSession.count({ where: { tokenHash: staleHash } })) === 0);
    }

    // ══ 5. Stale-row cleanup ══════════════════════════════════════════════════
    section("5. Expired rows are actually pruned (no unbounded growth)");
    {
      const ghost = await mintToken({ shopId: shopA.id, memberId: aAdmin.id, kind: "session", ttlMs: 1000 });
      const ghostHash = createHash("sha256").update(ghost).digest("hex");
      await db.teamSession.updateMany({ where: { tokenHash: ghostHash }, data: { expiresAt: new Date(Date.now() - DAY) } });
      const purged = await purgeExpiredTokens();
      ok("purgeExpiredTokens() removes expired team_sessions", purged >= 1 && (await db.teamSession.count({ where: { tokenHash: ghostHash } })) === 0, `${purged} row(s)`);
      ok("team_sessions purge is wired into the nightly retention job", readFileSync(join(process.cwd(), "app", "lib", "jobs", "handlers.server.ts"), "utf-8").includes("purgeExpiredTokens"));

      const rawGhost = randomBytes(32).toString("base64url");
      const gRow = await db.platformSession.create({
        data: { tokenHash: createHash("sha256").update(rawGhost).digest("hex"), adminId: qaPlatformAdmin.id, expiresAt: new Date(Date.now() - DAY), userAgent: TAG },
      });
      const n = await purgeExpiredPlatformSessions();
      ok("purgeExpiredPlatformSessions() removes expired platform_sessions", n >= 1 && (await db.platformSession.count({ where: { id: gRow.id } })) === 0, `${n} row(s)`);
      const handlers = readFileSync(join(process.cwd(), "app", "lib", "jobs", "handlers.server.ts"), "utf-8");
      // Either the helper above, or the equivalent inline sweep — both prune.
      ok(
        "platform_sessions purge is wired into the nightly retention job",
        handlers.includes("purgeExpiredPlatformSessions") ||
          /platformSession[\s\S]{0,120}deleteMany\(\{\s*where:\s*\{\s*expiresAt:\s*\{\s*lt:/.test(handlers),
        "add it next to purgeExpiredTokens in the retentionPurge worker",
      );
      ok("team_sessions has no expired backlog right now", (await db.teamSession.count({ where: { expiresAt: { lt: new Date() } } })) === 0);
      ok("platform_sessions has no expired backlog right now", (await db.platformSession.count({ where: { expiresAt: { lt: new Date() } } })) === 0);
    }

    // ══ 6. PlatformSession lifecycle ══════════════════════════════════════════
    section("6. PlatformSession — 7-day sliding TTL, revocation");
    const platformAdmin = qaPlatformAdmin;
    {
      const headers = await createPlatformSession(req(), platformAdmin.id);
      const setCookie = headers.get("set-cookie") ?? "";
      const raw = decodeURIComponent(setCookie.split(";")[0].split("=").slice(1).join("="));
      const row = await db.platformSession.findUnique({ where: { tokenHash: createHash("sha256").update(raw).digest("hex") } });
      const days = row ? Math.round((row.expiresAt.getTime() - Date.now()) / DAY) : -1;
      ok("platform TTL is 7 days", days === 7, `${days}d`);
      ok("readPlatformSession resolves the admin", (await readPlatformSession(req(`cc_platform=${raw}`)))?.admin.id === platformAdmin.id);

      const before = row!.expiresAt.getTime();
      await readPlatformSession(req(`cc_platform=${raw}`));
      await new Promise((r) => setTimeout(r, 300));
      ok("platform renewal is throttled to once per day", (await db.platformSession.findUnique({ where: { id: row!.id } }))!.expiresAt.getTime() === before);

      await db.platformSession.update({ where: { id: row!.id }, data: { lastSeenAt: new Date(Date.now() - 2 * DAY), expiresAt: new Date(Date.now() + 2 * DAY) } });
      await readPlatformSession(req(`cc_platform=${raw}`));
      ok(
        "a platform session older than a day slides back to 7 days",
        await eventually(async () => {
          const r = await db.platformSession.findUnique({ where: { id: row!.id } });
          return !!r && r.expiresAt.getTime() - Date.now() > 6 * DAY;
        }),
      );

      await db.platformSession.update({ where: { id: row!.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      ok("an expired platform session is rejected", (await readPlatformSession(req(`cc_platform=${raw}`))) === null);
      ok("an expired platform session row is deleted on read", (await db.platformSession.findUnique({ where: { id: row!.id } })) === null);
      ok("an unknown platform token is rejected", (await readPlatformSession(req("cc_platform=nope"))) === null);
      ok("an over-long platform token is rejected", (await readPlatformSession(req(`cc_platform=${"x".repeat(500)}`))) === null);

      // revokeAdminSessions — what /platform/admins reset-password relies on.
      const h1 = await createPlatformSession(req(), platformAdmin.id);
      const h2 = await createPlatformSession(req(), platformAdmin.id);
      const t1 = decodeURIComponent((h1.get("set-cookie") ?? "").split(";")[0].split("=").slice(1).join("="));
      const t2 = decodeURIComponent((h2.get("set-cookie") ?? "").split(";")[0].split("=").slice(1).join("="));
      const keepId = (await readPlatformSession(req(`cc_platform=${t1}`)))!.sessionId;
      await revokeAdminSessions(platformAdmin.id, keepId);
      ok("revokeAdminSessions(except) keeps the caller", (await readPlatformSession(req(`cc_platform=${t1}`))) !== null);
      ok("revokeAdminSessions(except) kills the rest", (await readPlatformSession(req(`cc_platform=${t2}`))) === null);
      const routeSrc = readFileSync(join(process.cwd(), "app", "routes", "platform.admins.tsx"), "utf-8");
      ok(
        "the password-change action revokes every OTHER session, keeping the caller",
        /revokeAdminSessions\(\s*me\.id\s*,\s*session\.sessionId\s*\)/.test(routeSrc),
      );
      ok(
        "the password-change action re-checks the current password first",
        /intent === "password"[\s\S]{0,600}verifyPassword[\s\S]{0,400}revokeAdminSessions/.test(routeSrc),
      );
      ok(
        "removing an admin cascades their sessions (schema onDelete: Cascade)",
        /model PlatformSession[\s\S]{0,600}onDelete:\s*Cascade/.test(readFileSync(join(process.cwd(), "prisma", "schema.prisma"), "utf-8")),
      );
      await destroyPlatformSession(req(`cc_platform=${t1}`));
      ok("destroyPlatformSession removes the row", (await readPlatformSession(req(`cc_platform=${t1}`))) === null);
      await db.platformSession.deleteMany({ where: { adminId: qaPlatformAdmin.id } });
    }

    // ══ 7. Shopify session storage ════════════════════════════════════════════
    section("7. Shopify sessions table (PrismaSessionStorage)");
    {
      const { sessionStorage } = await import("../../app/shopify.server");
      const { Session } = await import("@shopify/shopify-api");
      const fakeShop = `${TAG}-storage-${stamp}.myshopify.com`;
      const s = new Session({
        id: `offline_${fakeShop}`,
        shop: fakeShop,
        state: "qa",
        isOnline: false,
        accessToken: "shpat_qa_fake_token",
        scope: "read_products",
      });
      ok("storeSession writes a row", (await sessionStorage.storeSession(s)) === true && (await db.session.count({ where: { shop: fakeShop } })) === 1);
      const loaded = await sessionStorage.loadSession(`offline_${fakeShop}`);
      ok("loadSession reads it back", loaded?.shop === fakeShop);
      // What webhooks.app.uninstalled does.
      await db.session.deleteMany({ where: { shop: fakeShop } });
      ok("uninstall-style deleteMany removes it", (await sessionStorage.loadSession(`offline_${fakeShop}`)) === undefined);
      const uninstallSrc = readFileSync(join(process.cwd(), "app", "routes", "webhooks.app.uninstalled.tsx"), "utf-8");
      ok("the app/uninstalled webhook deletes session rows", /db\.session\.deleteMany\(\s*\{\s*where:\s*\{\s*shop\s*\}/.test(uninstallSrc));
      const jobsSrc = readFileSync(join(process.cwd(), "app", "lib", "jobs", "handlers.server.ts"), "utf-8");
      ok("the day-7 purge deletes session rows as a backstop", jobsSrc.includes("db.session.deleteMany"));
    }

    // ══ 8. Multi-tenancy — request forgery, not inspection ════════════════════
    section("8. Multi-tenancy — shop A member cannot touch shop B data");
    {
      const s = await createWebSession({ request: req(), shopId: shopA.id, memberId: aAdmin.id });
      const jar = `cc_web_session=${s.rawToken}; cc_surface=web`;

      const deep = await probe(`/app/inbox?c=${victimConv.id}`, { cookie: jar });
      ok("GET /app/inbox?c=<shop B id> does not render shop B's conversation", deep.status === 200 && !deep.body.includes(victimConv.id) && !deep.body.includes(`${TAG}-secret-marker`), String(deep.status));

      for (const intent of ["delete", "block", "resolve", "read", "star"]) {
        await probe("/app/inbox", { cookie: jar, method: "POST", body: new URLSearchParams({ intent, conversationId: victimConv.id, starred: "1" }) });
      }
      const survivor = await db.conversation.findUnique({ where: { id: victimConv.id } });
      ok(
        "cross-tenant inbox mutations are no-ops",
        survivor !== null && survivor.blocked === false && survivor.status === "open" && survivor.starred === false && survivor.unread === true,
        survivor ? `blocked=${survivor.blocked} status=${survivor.status} starred=${survivor.starred} unread=${survivor.unread}` : "deleted!",
      );

      const msgBefore = await db.message.count({ where: { conversationId: victimConv.id } });
      await probe("/app/inbox", { cookie: jar, method: "POST", body: new URLSearchParams({ intent: "send", conversationId: victimConv.id, content: `${TAG}-injected` }) });
      ok("cross-tenant agent reply is rejected", (await db.message.count({ where: { conversationId: victimConv.id } })) === msgBefore);

      const detail = await probe("/app/contacts", { cookie: jar, method: "POST", body: new URLSearchParams({ intent: "detail", id: victimContact.id }) });
      ok("cross-tenant contact detail returns nothing", !detail.body.includes(`${TAG}-victim-${stamp}@example.invalid`), String(detail.status));

      const del = await probe("/app/contacts", { cookie: jar, method: "POST", body: new URLSearchParams({ intent: "delete", id: victimContact.id }) });
      ok("cross-tenant contact delete is a no-op", (await db.contact.count({ where: { id: victimContact.id } })) === 1, String(del.status));

      // A member of shop B must not inherit shop A's session either.
      const sb = await createWebSession({ request: req(), shopId: shopB.id, memberId: bAdmin.id });
      const bSession = await readWebSession(req(`cc_web_session=${sb.rawToken}`));
      ok("a shop B cookie resolves to shop B only", bSession?.shopId === shopB.id && bSession.shopId !== shopA.id);
      // Splicing shop A's id into the request must change nothing.
      const forged = await probe(`/app/inbox?shopId=${shopA.id}`, { cookie: `cc_web_session=${sb.rawToken}; cc_surface=web` });
      ok("a client-supplied shopId is ignored", forged.status === 200 || forged.status === 403, String(forged.status));
      await db.teamSession.deleteMany({ where: { memberId: { in: [aAdmin.id, bAdmin.id] } } });
    }

    // ══ 9. Login hardening ════════════════════════════════════════════════════
    section("9. Login hardening — enumeration, lockout, rate limit, CSRF, redirects");
    {
      // Anti-enumeration: identical message, and the unknown-email path burns a
      // dummy scrypt hash so it is not measurably faster.
      const t0 = Date.now();
      const unknown = await verifyLogin(`${TAG}-nobody-${stamp}@example.invalid`, secret);
      const unknownMs = Date.now() - t0;
      const t1 = Date.now();
      const wrong = await verifyLogin(aAdmin.email, "definitely-not-the-password");
      const wrongMs = Date.now() - t1;
      ok("unknown email and wrong password give the SAME message", !unknown.ok && !wrong.ok && unknown.error === wrong.error, unknown.ok ? "" : unknown.error);
      ok("the message is generic", !unknown.ok && unknown.error === "Incorrect email or password.");
      ok("the unknown-email path burns a comparable hash", unknownMs > 20 && unknownMs > wrongMs * 0.4, `unknown ${unknownMs}ms vs wrong ${wrongMs}ms`);
      await db.teamMember.update({ where: { id: aAdmin.id }, data: { failedLogins: 0, lockedUntil: null } });
    }
    {
      // 5 failures → 15-minute lock, and the lock blocks the CORRECT password.
      const target = await mk(shopA.id, "agent", `lock-${stamp}`, true);
      for (let i = 0; i < 4; i++) await verifyLogin(target.email, "wrong-password");
      const after4 = await db.teamMember.findUnique({ where: { id: target.id } });
      ok("failures accumulate on the member row", after4?.failedLogins === 4, `failedLogins=${after4?.failedLogins}`);
      ok("4 failures do NOT lock", after4?.lockedUntil === null);
      await verifyLogin(target.email, "wrong-password");
      const locked = await db.teamMember.findUnique({ where: { id: target.id } });
      const lockMin = locked?.lockedUntil ? Math.round((locked.lockedUntil.getTime() - Date.now()) / 60000) : -1;
      ok("the 5th failure locks the account", locked?.lockedUntil !== null, `lockedUntil=${locked?.lockedUntil?.toISOString() ?? "null"}`);
      ok("the lock lasts 15 minutes", lockMin === 15, `${lockMin}min`);
      const duringLock = await verifyLogin(target.email, secret);
      ok("the CORRECT password is refused while locked", duringLock.ok === false);
      ok("the lock message is still generic (no lockout oracle)", !duringLock.ok && duringLock.error === "Incorrect email or password.");
      await db.teamMember.update({ where: { id: target.id }, data: { failedLogins: 0, lockedUntil: null } });
      const afterUnlock = await verifyLogin(target.email, secret);
      ok("a correct login works once the lock clears", afterUnlock.ok === true);
      ok("a successful login resets the failure counter", (await db.teamMember.findUnique({ where: { id: target.id } }))?.failedLogins === 0);
    }
    {
      // In-memory limiter: 20 attempts per (ip, email) per 10 minutes.
      const { allowAttempt, clearAttempts, clientKey } = await import("../../app/lib/team/login-limiter.server");
      const key = clientKey(new Request(`${BASE}/web/login`, { headers: { "x-forwarded-for": "203.0.113.9" } }), `${TAG}-${stamp}`);
      let allowed = 0;
      for (let i = 0; i < 25; i++) if (allowAttempt(key)) allowed++;
      ok("the in-memory limiter caps a client at 20 attempts", allowed === 20, `${allowed} allowed`);
      clearAttempts(key);
      ok("clearAttempts resets the bucket (successful login)", allowAttempt(key) === true);
      clearAttempts(key);
      ok("the limiter keys on the client IP", clientKey(new Request(BASE, { headers: { "x-forwarded-for": "198.51.100.1, 10.0.0.1" } }), "e").startsWith("198.51.100.1:"));
    }
    {
      // sameOrigin CSRF guard.
      const same = new Request(`${BASE}/web/login`, { method: "POST", headers: { origin: BASE, host: "localhost:3000" } });
      const cross = new Request(`${BASE}/web/login`, { method: "POST", headers: { origin: "https://evil.example", host: "localhost:3000" } });
      const none = new Request(`${BASE}/web/login`, { method: "POST", headers: { host: "localhost:3000" } });
      const referer = new Request(`${BASE}/web/login`, { method: "POST", headers: { referer: "https://evil.example/x", host: "localhost:3000" } });
      ok("sameOrigin accepts a same-origin submission", sameOrigin(same) === true);
      ok("sameOrigin rejects a cross-origin Origin", sameOrigin(cross) === false);
      ok("sameOrigin rejects a cross-origin Referer", sameOrigin(referer) === false);
      ok("sameOrigin allows a header-less client (documented trade-off)", sameOrigin(none) === true);

      const blocked = await probe("/web/login", {
        method: "POST",
        origin: "https://evil.example",
        body: new URLSearchParams({ email: aAdmin.email, password: secret, next: "/app/inbox" }),
      });
      ok("cross-origin POST /web/login is refused (no session cookie issued)", !blocked.setCookie.some((c) => c.startsWith("cc_web_session=") && !/Max-Age=0/.test(c)), blocked.setCookie.join(" | ") || "(no set-cookie)");
      // In dev the Vite middleware already 400s a foreign-Origin POST, so the
      // action never runs; in a production build the sameOrigin() guard above
      // renders the banner. Either outcome is a refusal.
      ok(
        "cross-origin POST /web/login is refused (banner or hard 4xx)",
        blocked.body.includes("Request blocked") || (blocked.status >= 400 && blocked.status < 500),
        String(blocked.status),
      );

      // …and every other cookie-mutating web action is guarded too.
      const srcs = ["web.login.tsx", "web.invite.$token.tsx", "web.reset.$token.tsx", "web.logout.tsx", "web.forgot.tsx", "platform.login.tsx", "platform.logout.tsx"];
      for (const f of srcs) {
        ok(`${f} calls sameOrigin()`, readFileSync(join(process.cwd(), "app", "routes", f), "utf-8").includes("sameOrigin("));
      }
    }
    {
      // safeNext / platformSafeNext open-redirect protection.
      const evil = [
        "https://evil.com",
        "http://evil.com",
        "//evil.com",
        "///evil.com",
        "/\\evil.com",
        "\\\\evil.com",
        "javascript:alert(1)",
        "//evil.com/app/inbox",
        "/web/login",
        "",
        null,
      ];
      for (const value of evil) {
        ok(`safeNext rejects ${JSON.stringify(value)}`, safeNext(value) === "/app/inbox", safeNext(value));
      }
      ok("safeNext keeps a real in-app path", safeNext("/app/settings?tab=team") === "/app/settings?tab=team");
      for (const value of ["https://evil.com", "//evil.com", "/\\evil.com", "/app/inbox", "javascript:x"]) {
        ok(`platformSafeNext rejects ${JSON.stringify(value)}`, platformSafeNext(value) === "/platform", platformSafeNext(value));
      }
      ok("platformSafeNext keeps a real platform path", platformSafeNext("/platform/usage?range=90d") === "/platform/usage?range=90d");
    }

    // ══ 10. Cookies ═══════════════════════════════════════════════════════════
    section("10. Cookies — attributes from real Set-Cookie headers");
    {
      // Live login through HTTP: the exact headers a browser receives.
      const login = await probe("/web/login", {
        method: "POST",
        body: new URLSearchParams({ email: aAdmin.email, password: secret, next: "/app/inbox" }),
      });
      const sess = cookieAttr(login.setCookie, "cc_web_session");
      const surf = cookieAttr(login.setCookie, "cc_surface");
      ok("login issues cc_web_session", sess !== null, login.setCookie.join(" | ") || `status ${login.status}`);
      ok("login issues cc_surface", surf !== null);
      if (sess) {
        ok("cc_web_session is HttpOnly", /HttpOnly/.test(sess), sess);
        ok("cc_web_session is SameSite=Lax", /SameSite=Lax/.test(sess), sess);
        ok("cc_web_session is Path=/", /Path=\//.test(sess), sess);
        ok("cc_web_session Max-Age is 30 days", /Max-Age=2592000\b/.test(sess), sess);
        ok("cc_web_session has no Secure over plain http dev", !/Secure/.test(sess), sess);
      }
      if (surf) {
        ok("cc_surface is deliberately NOT HttpOnly", !/HttpOnly/.test(surf), surf);
        ok("cc_surface is SameSite=Lax", /SameSite=Lax/.test(surf), surf);
        ok("cc_surface Max-Age is 365 days", /Max-Age=31536000\b/.test(surf), surf);
        ok("cc_surface carries no session value", /cc_surface=web(;|$)/.test(surf), surf);
      }
      ok("cc_web_session is the ONLY non-HttpOnly exception", login.setCookie.filter((c) => !/HttpOnly/.test(c)).every((c) => c.startsWith("cc_surface=")), login.setCookie.join(" | "));

      // Logout clears it.
      const rawFromLogin = sess ? decodeURIComponent(sess.split(";")[0].split("=").slice(1).join("=")) : "";
      const out = await probe("/web/logout", { method: "POST", cookie: `cc_web_session=${rawFromLogin}`, body: new URLSearchParams({}) });
      const cleared = cookieAttr(out.setCookie, "cc_web_session");
      ok("logout sends cc_web_session with Max-Age=0", cleared !== null && /Max-Age=0/.test(cleared), cleared ?? "(none)");
      ok("logout keeps HttpOnly on the clearing cookie", cleared !== null && /HttpOnly/.test(cleared));
      await db.teamSession.deleteMany({ where: { memberId: aAdmin.id } });
    }
    {
      // Production build must force Secure even behind a proto-stripping proxy.
      const prev = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = "production";
        const h = sessionCookieHeaders(req(), "token-value");
        const all = typeof h.getSetCookie === "function" ? h.getSetCookie() : [];
        ok("production: cc_web_session is Secure", /Secure/.test(cookieAttr(all, "cc_web_session") ?? ""), cookieAttr(all, "cc_web_session") ?? "");
        ok("production: cc_surface is Secure", /Secure/.test(cookieAttr(all, "cc_surface") ?? ""), cookieAttr(all, "cc_surface") ?? "");
        const cl = clearSessionCookieHeaders(req()).get("set-cookie") ?? "";
        ok("production: the clearing cookie is Secure too", /Secure/.test(cl), cl);
        {
          const ph = await createPlatformSession(req(), platformAdmin.id);
          const pc = ph.get("set-cookie") ?? "";
          ok("production: cc_platform is Secure + HttpOnly + SameSite=Lax + Path=/", /Secure/.test(pc) && /HttpOnly/.test(pc) && /SameSite=Lax/.test(pc) && /Path=\//.test(pc), pc);
          ok("production: cc_platform Max-Age is 7 days", /Max-Age=604800\b/.test(pc), pc);
          const rawP = decodeURIComponent(pc.split(";")[0].split("=").slice(1).join("="));
          await destroyPlatformSession(req(`cc_platform=${rawP}`));
        }
      } finally {
        if (prev === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = prev;
      }
    }
    {
      // Admin iframe isolation. SameSite=Lax means a browser never attaches the
      // cookie to the cross-site request the Shopify admin iframe makes; and
      // even if it somehow did, Shopify signals take priority in the seam.
      const h = sessionCookieHeaders(req(), "token-value");
      const all = typeof h.getSetCookie === "function" ? h.getSetCookie() : [];
      ok("no web cookie is SameSite=None (would be sent inside the admin iframe)", all.every((c) => !/SameSite=None/i.test(c)), all.join(" | "));
      ok("every web cookie is explicitly SameSite=Lax", all.every((c) => /SameSite=Lax/.test(c)));
      ok("hasShopifySignals: id_token", hasShopifySignals(new Request(`${BASE}/app?id_token=x`)));
      ok("hasShopifySignals: embedded", hasShopifySignals(new Request(`${BASE}/app?embedded=1`)));
      ok("hasShopifySignals: host", hasShopifySignals(new Request(`${BASE}/app?host=x`)));
      ok("hasShopifySignals: shop", hasShopifySignals(new Request(`${BASE}/app?shop=x.myshopify.com`)));
      ok("hasShopifySignals: Bearer token", hasShopifySignals(new Request(`${BASE}/app`, { headers: { authorization: "Bearer abc" } })));
      ok("hasShopifySignals: plain web request has none", !hasShopifySignals(new Request(`${BASE}/app/inbox`)));

      const s = await createWebSession({ request: req(), shopId: shopA.id, memberId: aAdmin.id });
      const withSignals = await probe(`/app/inbox?embedded=1&shop=${shopA.domain}`, { cookie: `cc_web_session=${s.rawToken}; cc_surface=web` });
      ok(
        "a request carrying Shopify signals is NOT served from the web cookie",
        withSignals.body.includes("app-bridge.js") || withSignals.status >= 300,
        `${withSignals.status}`,
      );
      await db.teamSession.deleteMany({ where: { memberId: aAdmin.id } });
    }
    {
      // The platform cookie must not be readable by script and must not leak
      // into merchant surfaces as an authorisation.
      const platformSrc = readFileSync(join(process.cwd(), "app", "lib", "platform", "platform-auth.server.ts"), "utf-8");
      ok("cc_platform is always HttpOnly (no conditional)", /"HttpOnly",/.test(platformSrc));
      ok("cc_platform is always SameSite=Lax", /"SameSite=Lax",/.test(platformSrc));
    }

    // ══ 11. Member removal ════════════════════════════════════════════════════
    section("11. Removing a member tears everything down");
    {
      const doomed = await mk(shopA.id, "agent", `doomed-${stamp}`, true);
      const s = await createWebSession({ request: req(), shopId: shopA.id, memberId: doomed.id });
      await db.pushSubscription.create({
        data: { shopId: shopA.id, memberId: doomed.id, endpoint: `https://example.invalid/${TAG}-doomed-${stamp}`, p256dh: "x", auth: "y" },
      });
      await mintToken({ shopId: shopA.id, memberId: doomed.id, kind: "invite", ttlMs: DAY });
      ok("removeMember succeeds", (await removeMember(shopA.id, doomed.id)) === true);
      ok("removeMember kills the session", (await readWebSession(req(`cc_web_session=${s.rawToken}`))) === null);
      ok("removeMember deletes every token row", (await db.teamSession.count({ where: { memberId: doomed.id } })) === 0);
      ok("removeMember deletes push subscriptions", (await db.pushSubscription.count({ where: { memberId: doomed.id } })) === 0);
      ok("removeMember is shop-scoped", (await removeMember(shopB.id, aAdmin.id)) === false && (await db.teamMember.count({ where: { id: aAdmin.id } })) === 1);
    }
  } finally {
    // ── Cleanup ─────────────────────────────────────────────────────────────
    await db.message.deleteMany({ where: { conversationId: victimConv.id } }).catch(() => undefined);
    await db.conversation.delete({ where: { id: victimConv.id } }).catch(() => undefined);
    await db.contact.deleteMany({ where: { id: victimContact.id } }).catch(() => undefined);
    await db.teamSession.deleteMany({ where: { memberId: { in: memberIds } } }).catch(() => undefined);
    await db.pushSubscription.deleteMany({ where: { memberId: { in: memberIds } } }).catch(() => undefined);
    await db.teamMember.deleteMany({ where: { id: { in: memberIds } } }).catch(() => undefined);
    await db.teamMember.deleteMany({ where: { email: { startsWith: `${TAG}-` } } }).catch(() => undefined);
    await db.platformSession.deleteMany({ where: { adminId: qaPlatformAdmin.id } }).catch(() => undefined);
    await db.platformAdmin.delete({ where: { id: qaPlatformAdmin.id } }).catch(() => undefined);
    await db.session.deleteMany({ where: { shop: { startsWith: `${TAG}-` } } }).catch(() => undefined);
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
