import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { redirect } from "react-router";
import db from "../../db.server";
import { env } from "../env.server";
import { hashPassword, passwordProblem, verifyPassword } from "../team/password.server";
import { parseCookies } from "../team/web-session.server";

// Admin auth (spec 19). Operator accounts for the company running the
// app — cross-tenant BY DESIGN, never shop-scoped. Session = opaque token in an
// HttpOnly cookie (Path=/ — see cookie() for why not /admin; merchant
// routes simply ignore it), sha256-hashed in platform_sessions.

export const ADMIN_COOKIE = "cc_admin";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, sliding
const RENEW_AFTER_MS = 24 * 60 * 60 * 1000; // extend at most once a day

export interface AdminUser {
  id: string;
  email: string;
  name: string;
}

export interface AdminSessionInfo {
  sessionId: string;
  admin: AdminUser;
}

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function isSecure(request: Request): boolean {
  const proto = request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.replace(":", "");
  return proto === "https";
}

function cookie(value: string, maxAgeSeconds: number, secure: boolean): string {
  const parts = [
    `${ADMIN_COOKIE}=${encodeURIComponent(value)}`,
    // Path=/ (not /admin): React Router's client navigations fetch
    // "/admin.data", which a /admin-scoped cookie does NOT match under
    // RFC 6265 path rules (next char is "." not "/") — the overview tab's data
    // request would arrive signed-out. Merchant routes simply ignore it.
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    "SameSite=Lax",
    "HttpOnly",
  ];
  // Force Secure in production even if a proxy strips x-forwarded-proto.
  if (secure || process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

/** Only /admin-relative paths as post-login destinations (no open redirects). */
export function adminSafeNext(value: string | null | undefined, fallback = "/admin"): string {
  if (!value) return fallback;
  if (!value.startsWith("/admin") || value.startsWith("//") || value.includes("\\")) return fallback;
  return value;
}

export async function createAdminSession(request: Request, adminId: string): Promise<Headers> {
  const raw = randomBytes(32).toString("base64url");
  await db.adminSession.create({
    data: {
      tokenHash: hashToken(raw),
      adminId,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      userAgent: request.headers.get("user-agent")?.slice(0, 300) ?? null,
    },
  });
  const headers = new Headers();
  headers.append("Set-Cookie", cookie(raw, SESSION_TTL_MS / 1000, isSecure(request)));
  return headers;
}

/** Resolve the admin session from the cookie. null = missing/invalid/expired. */
export async function readAdminSession(request: Request): Promise<AdminSessionInfo | null> {
  const raw = parseCookies(request.headers.get("cookie"))[ADMIN_COOKIE];
  if (!raw || raw.length > 200) return null;
  // The environment is reconciled BEFORE the cookie is trusted: if
  // ADMIN_EMAIL/PASSWORD changed, this deletes root's sessions — including,
  // possibly, the one about to be looked up — so a browser holding a cookie
  // issued under the old password is signed out on its very next request.
  // Invited accounts are unaffected and keep working even with no .env pair.
  await adminIdentity();
  const row = await db.adminSession.findUnique({
    where: { tokenHash: hashToken(raw) },
    include: { admin: { select: { id: true, email: true, name: true } } },
  });
  if (!row) return null;
  if (row.expiresAt.getTime() <= Date.now()) {
    await db.adminSession.delete({ where: { id: row.id } }).catch(() => undefined);
    return null;
  }
  // Sliding expiry: bump at most once a day to keep writes cheap.
  if (Date.now() - row.lastSeenAt.getTime() > RENEW_AFTER_MS) {
    db.adminSession
      .update({
        where: { id: row.id },
        data: { lastSeenAt: new Date(), expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
      })
      .catch(() => undefined);
  }
  return { sessionId: row.id, admin: row.admin };
}

/** Guard for every authed /admin loader AND action. */
export async function requireAdminUser(request: Request): Promise<AdminSessionInfo> {
  const session = await readAdminSession(request);
  if (!session) {
    const url = new URL(request.url);
    // Keep the query string so a deep link (?range=90d, ?tab=…) survives the
    // bounce. React Router data requests arrive as "/admin.data?_routes=…";
    // strip both so the member lands on the page, not the loader URL.
    const pathname = url.pathname.replace(/\.data$/, "");
    const search = url.search && !url.search.includes("_routes=") ? url.search : "";
    const next = adminSafeNext(pathname + search);
    throw redirect(`/admin/login${next === "/admin" ? "" : `?next=${encodeURIComponent(next)}`}`);
  }
  return session;
}

export async function destroyAdminSession(request: Request): Promise<Headers> {
  const raw = parseCookies(request.headers.get("cookie"))[ADMIN_COOKIE];
  if (raw) {
    await db.adminSession.deleteMany({ where: { tokenHash: hashToken(raw) } });
  }
  const headers = new Headers();
  headers.append("Set-Cookie", cookie("", 0, isSecure(request)));
  return headers;
}

/**
 * Delete expired operator sessions. Nothing else ever removes them: a row only
 * disappears on explicit logout or an admin reset, and readAdminSession only
 * deletes the one row it happens to look up — so a browser that is simply
 * closed leaves its row behind forever. Called from the nightly retention job
 * (jobs/handlers.server.ts) alongside purgeExpiredTokens().
 */
export async function purgeExpiredAdminSessions(): Promise<number> {
  const result = await db.adminSession.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return result.count;
}

/** Kill every session of an admin except (optionally) the current one. */
export async function revokeAdminSessions(adminId: string, exceptSessionId?: string): Promise<void> {
  await db.adminSession.deleteMany({
    where: { adminId, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
  });
}

// ── Two kinds of operator ──────────────────────────────────────────────────
//
// ROOT: ADMIN_EMAIL + ADMIN_PASSWORD in the server's .env. Always valid, never
// removable, and its password is never stored — verifyAdminLogin compares
// against the environment directly. Its platform_admins row is a MIRROR kept
// only so sessions have something to point at and the lockout counters have
// somewhere to live; `passwordHash` stays EMPTY, which is also how the row is
// recognised as env-managed.
//
// INVITED: rows created at /admin/access with a real scrypt hash. They sign in
// normally and can be removed from the panel.
//
// Why root exists at all: before 2026-09-03 every account was a row and the env
// pair was a one-time bootstrap, so production kept accepting a password that
// was nowhere in its .env — the row had outlived the variable that created it.
// Root inverts that: a fingerprint of the pair lives in app_secrets, and the
// moment it stops matching (a .env edit + restart), root's sessions are dropped
// and any stale env-managed row goes with them. Invited accounts are untouched
// by that — they are their own credentials, not a copy of the environment.
const CREDENTIAL_KEY = "admin:credentials";
const RECONCILE_TTL_MS = 30_000;
const MAX_FAILED_LOGINS = 5;
const LOCK_MS = 15 * 60 * 1000;
/** An env-managed row carries no hash — that is what makes it root. */
const ROOT_HASH = "";

/** Constant-time compare via fixed-length digests (inputs have unequal lengths). */
function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

interface EnvCredentials {
  email: string;
  password: string;
  fingerprint: string;
}

/**
 * Keyed with the app secret so a stolen database dump alone cannot be brute-
 * forced back into the password — the attacker would need the server's
 * SHOPIFY_API_SECRET as well.
 */
function fingerprint(email: string, password: string): string {
  const material = process.env.SHOPIFY_API_SECRET || process.env.DATABASE_URL || "chatconvert";
  return createHmac("sha256", material).update(`${email} ${password}`).digest("hex");
}

/** The configured pair, or null when either half is blank (root disabled). */
function envCredentials(): EnvCredentials | null {
  const e = env();
  const email = (process.env.ADMIN_EMAIL ?? e.ADMIN_EMAIL).trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD ?? e.ADMIN_PASSWORD;
  if (!email || !password) return null;
  return { email, password, fingerprint: fingerprint(email, password) };
}

/** true while the server has an ADMIN_EMAIL / ADMIN_PASSWORD pair to check against. */
export function adminLoginConfigured(): boolean {
  return envCredentials() !== null;
}

/** The root email, lower-cased — "" when the pair is not configured. */
export function rootAdminEmail(): string {
  return envCredentials()?.email ?? "";
}

let syncedFingerprint: string | null = null;
let syncedAt = 0;
let syncedAdmin: AdminUser | null = null;
let syncing: Promise<AdminUser | null> | null = null;

/**
 * Make the root row agree with the environment and return it. null = no
 * credentials configured (invited accounts still work; root simply does not
 * exist on that server).
 *
 * Cached for 30s per process. The environment cannot change under a running
 * process anyway — a .env edit needs a restart — so the check is a formality
 * that keeps the extra query off the hot path.
 */
export async function adminIdentity(): Promise<AdminUser | null> {
  const creds = envCredentials();
  if (!creds) {
    // Fail closed for root, but destroy nothing: a deploy that forgot the
    // variables should lock root out, not wipe the operator table.
    syncedFingerprint = null;
    syncedAdmin = null;
    return null;
  }
  if (syncedAdmin && syncedFingerprint === creds.fingerprint && Date.now() - syncedAt < RECONCILE_TTL_MS) {
    return syncedAdmin;
  }
  if (!syncing) {
    syncing = (async () => {
      const stored = await db.appSecret.findUnique({ where: { key: CREDENTIAL_KEY } });
      const changed = stored?.value !== creds.fingerprint;
      const admin = await db.$transaction(async (tx) => {
        if (changed) {
          // Every env-managed row other than this email is a leftover of an
          // older .env — it has no hash, so it can never sign in; delete it (and
          // its sessions, by cascade). Invited accounts are deliberately spared.
          await tx.adminUser.deleteMany({
            where: { passwordHash: ROOT_HASH, email: { not: creds.email } },
          });
        }
        const row = await tx.adminUser.upsert({
          where: { email: creds.email },
          update: {},
          create: { email: creds.email, name: "Admin", passwordHash: ROOT_HASH },
          select: { id: true, email: true, name: true },
        });
        if (changed) {
          // Root's own sessions were issued against the OLD pair — including
          // this request's. Drop them so the old password stops working
          // everywhere the moment the new one takes effect.
          await tx.adminSession.deleteMany({ where: { adminId: row.id } });
          await tx.appSecret.upsert({
            where: { key: CREDENTIAL_KEY },
            update: { value: creds.fingerprint },
            create: { key: CREDENTIAL_KEY, value: creds.fingerprint },
          });
        }
        return row;
      });
      syncedAdmin = admin;
      syncedFingerprint = creds.fingerprint;
      syncedAt = Date.now();
      if (changed) {
        console.log(`[admin] .env credentials changed — root sessions signed out (${admin.email})`);
      }
      return admin;
    })().finally(() => {
      syncing = null;
    });
  }
  return syncing;
}

/** Shared lockout bookkeeping — the in-memory limiter in the login route
 *  resets with the process, this does not. */
async function bumpFailure(adminId: string, failedLogins: number): Promise<void> {
  await db.adminUser
    .update({
      where: { id: adminId },
      data:
        failedLogins + 1 >= MAX_FAILED_LOGINS
          ? { failedLogins: 0, lockedUntil: new Date(Date.now() + LOCK_MS) }
          : { failedLogins: failedLogins + 1 },
    })
    .catch(() => undefined);
}

async function clearFailures(admin: { id: string; failedLogins: number; lockedUntil: Date | null }): Promise<void> {
  if (admin.failedLogins === 0 && !admin.lockedUntil) return;
  await db.adminUser
    .update({ where: { id: admin.id }, data: { failedLogins: 0, lockedUntil: null } })
    .catch(() => undefined);
}

export async function verifyAdminLogin(
  email: string,
  password: string,
): Promise<{ ok: true; admin: AdminUser } | { ok: false; error: string }> {
  const normalized = email.trim().toLowerCase();
  const invalid = { ok: false as const, error: "Incorrect email or password." };
  const creds = envCredentials();
  if (!normalized || !password) return invalid;

  // Root must be materialised before the lookup, otherwise the very first
  // sign-in on a fresh database finds no row.
  const root = await adminIdentity();
  const row = await db.adminUser.findUnique({ where: { email: normalized } });
  if (!row) {
    // Burn comparable time so a missing account is not distinguishable.
    await verifyPassword(password, "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
    return invalid;
  }
  if (row.lockedUntil && row.lockedUntil.getTime() > Date.now()) {
    // Enforced server-side, reported with the generic message so a locked
    // account cannot be told apart from an unknown email.
    return invalid;
  }

  const isRoot = Boolean(root && row.id === root.id);
  const accepted = isRoot
    ? // Root's password is the environment's, compared constant-time. A root row
      // whose .env pair has since been removed cannot sign in at all.
      Boolean(creds) && safeEqual(normalized, creds!.email) && safeEqual(password, creds!.password)
    : // An empty hash would otherwise be a passwordless login; verifyPassword
      // rejects it, but be explicit.
      row.passwordHash !== ROOT_HASH && (await verifyPassword(password, row.passwordHash));

  if (!accepted) {
    await bumpFailure(row.id, row.failedLogins);
    return invalid;
  }
  await clearFailures(row);
  return { ok: true, admin: { id: row.id, email: row.email, name: row.name } };
}

// ── Operator accounts (created at /admin/access) ───────────────────────────

export interface AdminAccount {
  id: string;
  email: string;
  name: string;
  isRoot: boolean;
  createdAt: string;
  sessions: number;
}

/** Every operator, root first. Never returns a hash. */
export async function listAdmins(): Promise<AdminAccount[]> {
  const root = await adminIdentity();
  const rows = await db.adminUser.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      email: true,
      name: true,
      createdAt: true,
      _count: { select: { sessions: true } },
    },
  });
  return rows
    .map((r) => ({
      id: r.id,
      email: r.email,
      name: r.name,
      isRoot: r.id === root?.id,
      createdAt: r.createdAt.toISOString().slice(0, 10),
      sessions: r._count.sessions,
    }))
    .sort((a, b) => Number(b.isRoot) - Number(a.isRoot));
}

export async function createAdmin(
  name: string,
  email: string,
  password: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const cleanName = name.trim();
  const cleanEmail = email.trim().toLowerCase();
  if (!cleanName) return { ok: false, error: "Name is required." };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail)) return { ok: false, error: "Enter a valid email." };
  const problem = passwordProblem(password);
  if (problem) return { ok: false, error: problem };
  if (cleanEmail === rootAdminEmail()) {
    return { ok: false, error: "That email is the .env admin — its password is set in .env, not here." };
  }
  if (await db.adminUser.findUnique({ where: { email: cleanEmail } })) {
    return { ok: false, error: "An admin with that email already exists." };
  }
  await db.adminUser.create({
    data: { name: cleanName, email: cleanEmail, passwordHash: await hashPassword(password) },
  });
  return { ok: true };
}

export async function removeAdmin(
  adminId: string,
  callerId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (adminId === callerId) return { ok: false, error: "You can't remove your own account." };
  const root = await adminIdentity();
  if (root && adminId === root.id) {
    return { ok: false, error: "The .env admin can't be removed — clear ADMIN_EMAIL / ADMIN_PASSWORD instead." };
  }
  const row = await db.adminUser.findUnique({ where: { id: adminId }, select: { passwordHash: true } });
  if (!row) return { ok: true }; // already gone — removing twice is not an error
  if (row.passwordHash === ROOT_HASH) {
    return { ok: false, error: "That account is managed by .env." };
  }
  // Sessions cascade (schema onDelete: Cascade), so access ends immediately.
  await db.adminUser.delete({ where: { id: adminId } }).catch(() => undefined);
  return { ok: true };
}

/** Change an INVITED account's own password. Root's lives in .env. */
export async function changeAdminPassword(
  adminId: string,
  currentPassword: string,
  nextPassword: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const root = await adminIdentity();
  if (root && adminId === root.id) {
    return { ok: false, error: "This account signs in with ADMIN_PASSWORD from .env — change it there." };
  }
  const problem = passwordProblem(nextPassword);
  if (problem) return { ok: false, error: problem };
  const row = await db.adminUser.findUnique({ where: { id: adminId } });
  if (!row || row.passwordHash === ROOT_HASH || !(await verifyPassword(currentPassword, row.passwordHash))) {
    return { ok: false, error: "Current password is incorrect." };
  }
  await db.adminUser.update({
    where: { id: row.id },
    data: { passwordHash: await hashPassword(nextPassword) },
  });
  return { ok: true };
}

/** How many sessions the operator has open (shown on /admin/access). */
export async function countAdminSessions(adminId: string): Promise<number> {
  return db.adminSession.count({ where: { adminId, expiresAt: { gt: new Date() } } });
}
