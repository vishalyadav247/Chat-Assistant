import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { redirect } from "react-router";
import db from "../../db.server";
import { env } from "../env.server";
import { verifyPassword, hashPassword } from "../team/password.server";
import { parseCookies } from "../team/web-session.server";

// Platform admin auth (spec 19). Operator accounts for the company running the
// app — cross-tenant BY DESIGN, never shop-scoped. Session = opaque token in an
// HttpOnly cookie (Path=/ — see cookie() for why not /platform; merchant
// routes simply ignore it), sha256-hashed in platform_sessions.

export const PLATFORM_COOKIE = "cc_platform";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, sliding
const RENEW_AFTER_MS = 24 * 60 * 60 * 1000; // extend at most once a day

export interface PlatformAdminUser {
  id: string;
  email: string;
  name: string;
}

export interface PlatformSessionInfo {
  sessionId: string;
  admin: PlatformAdminUser;
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
    `${PLATFORM_COOKIE}=${encodeURIComponent(value)}`,
    // Path=/ (not /platform): React Router's client navigations fetch
    // "/platform.data", which a /platform-scoped cookie does NOT match under
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

/** Only /platform-relative paths as post-login destinations (no open redirects). */
export function platformSafeNext(value: string | null | undefined, fallback = "/platform"): string {
  if (!value) return fallback;
  if (!value.startsWith("/platform") || value.startsWith("//") || value.includes("\\")) return fallback;
  return value;
}

export async function createPlatformSession(request: Request, adminId: string): Promise<Headers> {
  const raw = randomBytes(32).toString("base64url");
  await db.platformSession.create({
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

/** Resolve the platform session from the cookie. null = missing/invalid/expired. */
export async function readPlatformSession(request: Request): Promise<PlatformSessionInfo | null> {
  const raw = parseCookies(request.headers.get("cookie"))[PLATFORM_COOKIE];
  if (!raw || raw.length > 200) return null;
  const row = await db.platformSession.findUnique({
    where: { tokenHash: hashToken(raw) },
    include: { admin: { select: { id: true, email: true, name: true } } },
  });
  if (!row) return null;
  if (row.expiresAt.getTime() <= Date.now()) {
    await db.platformSession.delete({ where: { id: row.id } }).catch(() => undefined);
    return null;
  }
  // Sliding expiry: bump at most once a day to keep writes cheap.
  if (Date.now() - row.lastSeenAt.getTime() > RENEW_AFTER_MS) {
    db.platformSession
      .update({
        where: { id: row.id },
        data: { lastSeenAt: new Date(), expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
      })
      .catch(() => undefined);
  }
  return { sessionId: row.id, admin: row.admin };
}

/** Guard for every authed /platform loader AND action. */
export async function requirePlatformAdmin(request: Request): Promise<PlatformSessionInfo> {
  const session = await readPlatformSession(request);
  if (!session) {
    const url = new URL(request.url);
    // Keep the query string so a deep link (?range=90d, ?tab=…) survives the
    // bounce. React Router data requests arrive as "/platform.data?_routes=…";
    // strip both so the member lands on the page, not the loader URL.
    const pathname = url.pathname.replace(/\.data$/, "");
    const search = url.search && !url.search.includes("_routes=") ? url.search : "";
    const next = platformSafeNext(pathname + search);
    throw redirect(`/platform/login${next === "/platform" ? "" : `?next=${encodeURIComponent(next)}`}`);
  }
  return session;
}

export async function destroyPlatformSession(request: Request): Promise<Headers> {
  const raw = parseCookies(request.headers.get("cookie"))[PLATFORM_COOKIE];
  if (raw) {
    await db.platformSession.deleteMany({ where: { tokenHash: hashToken(raw) } });
  }
  const headers = new Headers();
  headers.append("Set-Cookie", cookie("", 0, isSecure(request)));
  return headers;
}

/**
 * Delete expired operator sessions. Nothing else ever removes them: a row only
 * disappears on explicit logout or an admin reset, and readPlatformSession only
 * deletes the one row it happens to look up — so a browser that is simply
 * closed leaves its row behind forever. Called from the nightly retention job
 * (jobs/handlers.server.ts) alongside purgeExpiredTokens().
 */
export async function purgeExpiredPlatformSessions(): Promise<number> {
  const result = await db.platformSession.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return result.count;
}

/** Kill every session of an admin except (optionally) the current one. */
export async function revokeAdminSessions(adminId: string, exceptSessionId?: string): Promise<void> {
  await db.platformSession.deleteMany({
    where: { adminId, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
  });
}

/**
 * First-run bootstrap: when NO admin exists and PLATFORM_ADMIN_EMAIL +
 * PLATFORM_ADMIN_PASSWORD are set, a login attempt with exactly those
 * credentials creates the account. The canonical path is
 * `npx tsx scripts/platform-admin.ts create <email> <name> <password>`.
 */
const MAX_FAILED_LOGINS = 5;
const LOCK_MS = 15 * 60 * 1000;

/** Constant-time compare via fixed-length digests (inputs have unequal lengths). */
function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

export async function verifyPlatformLogin(
  email: string,
  password: string,
): Promise<{ ok: true; admin: PlatformAdminUser } | { ok: false; error: string }> {
  const normalized = email.trim().toLowerCase();
  const invalid = { ok: false as const, error: "Incorrect email or password." };
  if (!normalized || !password) return invalid;

  let admin = await db.platformAdmin.findUnique({ where: { email: normalized } });

  if (!admin) {
    const count = await db.platformAdmin.count();
    const e = env();
    const bootEmail = (process.env.PLATFORM_ADMIN_EMAIL ?? e.PLATFORM_ADMIN_EMAIL).trim().toLowerCase();
    const bootPassword = process.env.PLATFORM_ADMIN_PASSWORD ?? e.PLATFORM_ADMIN_PASSWORD;
    if (count === 0 && bootEmail && bootPassword && safeEqual(normalized, bootEmail) && safeEqual(password, bootPassword)) {
      admin = await db.platformAdmin.create({
        data: { email: normalized, name: "Platform admin", passwordHash: await hashPassword(password) },
      });
      console.log(`[platform] bootstrap admin created for ${normalized} — unset PLATFORM_ADMIN_EMAIL/PASSWORD now`);
      return { ok: true, admin: { id: admin.id, email: admin.email, name: admin.name } };
    }
    // Burn comparable time so a missing account isn't distinguishable.
    await verifyPassword(password, "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
    return invalid;
  }

  const now = Date.now();
  if (admin.lockedUntil && admin.lockedUntil.getTime() > now) {
    // Lock is enforced server-side but reported with the generic message so a
    // locked account can't be told apart from an unknown email.
    await verifyPassword(password, "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
    return invalid;
  }

  if (!(await verifyPassword(password, admin.passwordHash))) {
    const failed = admin.failedLogins + 1;
    await db.platformAdmin
      .update({
        where: { id: admin.id },
        data:
          failed >= MAX_FAILED_LOGINS
            ? { failedLogins: 0, lockedUntil: new Date(now + LOCK_MS) }
            : { failedLogins: failed },
      })
      .catch(() => undefined);
    return invalid;
  }

  if (admin.failedLogins > 0 || admin.lockedUntil) {
    await db.platformAdmin
      .update({ where: { id: admin.id }, data: { failedLogins: 0, lockedUntil: null } })
      .catch(() => undefined);
  }
  return { ok: true, admin: { id: admin.id, email: admin.email, name: admin.name } };
}

/** true when no operator account exists yet (login page shows bootstrap help). */
export async function platformNeedsBootstrap(): Promise<boolean> {
  return (await db.platformAdmin.count()) === 0;
}
