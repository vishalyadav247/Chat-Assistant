import db from "../../db.server";
import { requireShopId } from "../tenancy.server";
import { findToken, hashToken, mintToken } from "./tokens.server";

// Web-surface sessions (spec 18): opaque token in an HttpOnly first-party
// cookie → TeamSession row (kind "session") → member + shop. This lookup is
// the 4th trusted source of shop identity (see tenancy.server.ts).

export const SESSION_COOKIE = "cc_web_session";
/** Long-lived marker: "this browser uses the web surface". Lets an expired
 *  session land on /web/login instead of Shopify's shop-domain login. */
export const SURFACE_COOKIE = "cc_surface";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, sliding
const RENEW_AFTER_MS = 24 * 60 * 60 * 1000; // extend at most once a day

export interface WebSessionMember {
  id: string;
  shopId: string;
  email: string;
  name: string;
  role: "owner" | "admin" | "agent";
  status: string;
  notifyPrefs: unknown;
  passwordHash: string | null;
}

export interface WebSession {
  sessionId: string;
  member: WebSessionMember;
  shopId: string;
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function isSecure(request: Request): boolean {
  // Force Secure in production even if a proxy strips x-forwarded-proto
  // (mirrors platform-auth.server.ts).
  if (process.env.NODE_ENV === "production") return true;
  const proto = request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.replace(":", "");
  return proto === "https";
}

function cookie(name: string, value: string, opts: { maxAge: number; secure: boolean; httpOnly: boolean }): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${opts.maxAge}`,
    "SameSite=Lax",
  ];
  if (opts.httpOnly) parts.push("HttpOnly");
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

/** Set-Cookie headers for a freshly created session. */
export function sessionCookieHeaders(request: Request, rawToken: string): Headers {
  const secure = isSecure(request);
  const headers = new Headers();
  headers.append("Set-Cookie", cookie(SESSION_COOKIE, rawToken, { maxAge: SESSION_TTL_MS / 1000, secure, httpOnly: true }));
  headers.append("Set-Cookie", cookie(SURFACE_COOKIE, "web", { maxAge: 365 * 24 * 60 * 60, secure, httpOnly: false }));
  return headers;
}

/** Set-Cookie headers that clear the session (keeps the surface marker). */
export function clearSessionCookieHeaders(request: Request): Headers {
  const headers = new Headers();
  headers.append("Set-Cookie", cookie(SESSION_COOKIE, "", { maxAge: 0, secure: isSecure(request), httpOnly: true }));
  return headers;
}

export async function createWebSession(args: {
  request: Request;
  shopId: string;
  memberId: string;
}): Promise<{ rawToken: string; headers: Headers }> {
  requireShopId(args.shopId);
  const rawToken = await mintToken({
    shopId: args.shopId,
    memberId: args.memberId,
    kind: "session",
    ttlMs: SESSION_TTL_MS,
    userAgent: args.request.headers.get("user-agent"),
  });
  return { rawToken, headers: sessionCookieHeaders(args.request, rawToken) };
}

export function hasWebCookie(request: Request): boolean {
  return Boolean(parseCookies(request.headers.get("cookie"))[SESSION_COOKIE]);
}

export function hasSurfaceMarker(request: Request): boolean {
  return parseCookies(request.headers.get("cookie"))[SURFACE_COOKIE] === "web";
}

/** Resolve the web session from the cookie. null = no/invalid/expired cookie. */
export async function readWebSession(request: Request): Promise<WebSession | null> {
  const raw = parseCookies(request.headers.get("cookie"))[SESSION_COOKIE];
  if (!raw) return null;
  const row = await findToken(raw, "session");
  if (!row) return null;
  const member = await db.teamMember.findFirst({
    where: { id: row.memberId, shopId: row.shopId },
    select: {
      id: true,
      shopId: true,
      email: true,
      name: true,
      role: true,
      status: true,
      notifyPrefs: true,
      passwordHash: true,
    },
  });
  if (!member || member.status !== "active") return null;
  const role = member.role === "owner" || member.role === "admin" ? member.role : "agent";

  // Sliding expiry: bump at most once a day to keep writes cheap.
  if (Date.now() - row.lastSeenAt.getTime() > RENEW_AFTER_MS) {
    db.teamSession
      .update({
        where: { id: row.id },
        data: { lastSeenAt: new Date(), expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
      })
      .catch(() => undefined);
  }

  return { sessionId: row.id, shopId: row.shopId, member: { ...member, role } };
}

export async function destroyWebSession(request: Request): Promise<Headers> {
  const raw = parseCookies(request.headers.get("cookie"))[SESSION_COOKIE];
  if (raw) {
    await db.teamSession.deleteMany({ where: { tokenHash: hashToken(raw), kind: "session" } });
  }
  return clearSessionCookieHeaders(request);
}

/** Kill every web session of a member (remove / disable / password change). */
export async function revokeMemberSessions(shopId: string, memberId: string, exceptSessionId?: string): Promise<void> {
  requireShopId(shopId);
  await db.teamSession.deleteMany({
    where: { shopId, memberId, kind: "session", ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
  });
}
