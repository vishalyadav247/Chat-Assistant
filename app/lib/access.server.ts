import { redirect } from "react-router";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { authenticate, unauthenticated } from "../shopify.server";
import { resolveShopId } from "./tenancy.server";
import {
  clearSessionCookieHeaders,
  hasSurfaceMarker,
  hasWebCookie,
  readWebSession,
  type WebSessionMember,
} from "./team/web-session.server";
import type { MemberRole } from "./team/team.server";

// Dual-surface access seam (spec 18). Every /app/* loader/action calls
// requireShopAccess() instead of authenticate.admin() directly:
//
//   Shopify signals present (id_token / shop / host / embedded param, or an
//   Authorization: Bearer session token)   → authenticate.admin (unchanged)
//   valid web session cookie                → web surface (team member)
//   stale cookie or "uses web" marker        → /web/login?next=…
//   nothing                                 → authenticate.admin (OAuth bounce)
//
// shopId always comes from a trusted server-side record — the Shopify session
// or the TeamSession row behind an opaque HttpOnly cookie — never from client
// input. SameSite=Lax means the cookie is never sent inside the admin iframe.

export type Surface = "admin" | "web";

export type Permission =
  | "dashboard"
  | "inbox"
  | "contacts"
  | "chatbox"
  | "ai_agent"
  | "proactive"
  | "curated"
  | "analytics"
  | "plan"
  | "settings"
  | "billing_manage"; // admin surface only (Shopify Billing confirmation runs in admin)

const AGENT_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>(["inbox", "contacts"]);

export function can(role: MemberRole, surface: Surface, permission: Permission): boolean {
  if (permission === "billing_manage") return surface === "admin";
  if (role === "agent") return AGENT_PERMISSIONS.has(permission);
  return true;
}

export interface ShopAccess {
  surface: Surface;
  shopId: string;
  shopDomain: string;
  /** Team member on the web surface; null inside the Shopify admin. */
  member: WebSessionMember | null;
  /** Effective role: Shopify staff in the admin act as owner. */
  role: MemberRole;
  sessionId: string | null;
  /** Admin GraphQL client — live session in admin, offline token on web. */
  getAdmin: () => Promise<AdminApiContext>;
  /**
   * Same client, but `null` instead of a throw when one cannot be obtained.
   *
   * On the web surface `getAdmin()` resolves an OFFLINE Shopify session by shop
   * domain, and throws if the row is missing — which happens whenever the app's
   * session was purged but a team member still holds a valid web session. Any
   * page that calls the Admin API only opportunistically must use this, or that
   * throw becomes a hard 500 on a page that had no real need for Shopify at all.
   */
  getAdminOptional: () => Promise<AdminApiContext | null>;
}

/** Wrap a getAdmin so a missing/expired offline session degrades to `null`. */
function optional(get: () => Promise<AdminApiContext>): () => Promise<AdminApiContext | null> {
  return async () => {
    try {
      return await get();
    } catch {
      return null;
    }
  };
}

export function hasShopifySignals(request: Request): boolean {
  const auth = request.headers.get("authorization");
  if (auth && /^bearer\s/i.test(auth)) return true;
  const params = new URL(request.url).searchParams;
  return Boolean(
    params.get("id_token") || params.get("shop") || params.get("host") || params.get("embedded") || params.get("session"),
  );
}

function loginRedirect(request: Request, clearCookie: boolean): never {
  const url = new URL(request.url);
  // Data requests (.data suffix) should send the user to the page, not the
  // loader URL.
  const next = url.pathname.replace(/\.data$/, "") + (url.search && !url.search.includes("_routes=") ? url.search : "");
  const headers = clearCookie ? clearSessionCookieHeaders(request) : new Headers();
  throw redirect(`/web/login?next=${encodeURIComponent(next)}`, { headers });
}

export async function requireShopAccess(
  request: Request,
  opts: { permission?: Permission } = {},
): Promise<ShopAccess> {
  let access: ShopAccess;

  if (!hasShopifySignals(request) && (hasWebCookie(request) || hasSurfaceMarker(request))) {
    const session = await readWebSession(request);
    if (!session) loginRedirect(request, hasWebCookie(request));
    const shop = await db.shop.findUnique({
      where: { id: session.shopId },
      select: { domain: true, uninstalledAt: true },
    });
    if (!shop || shop.uninstalledAt) loginRedirect(request, true);
    const shopDomain = shop.domain;
    const getAdmin = async () => (await unauthenticated.admin(shopDomain)).admin;
    access = {
      surface: "web",
      shopId: session.shopId,
      shopDomain,
      member: session.member,
      role: session.member.role,
      sessionId: session.sessionId,
      getAdmin,
      getAdminOptional: optional(getAdmin),
    };
  } else {
    const { session, admin } = await authenticate.admin(request);
    const shopId = await resolveShopId(session.shop);
    access = {
      surface: "admin",
      shopId,
      shopDomain: session.shop,
      member: null,
      role: "owner",
      sessionId: null,
      getAdmin: async () => admin,
      getAdminOptional: async () => admin,
    };
  }

  if (opts.permission && !can(access.role, access.surface, opts.permission)) {
    throw new Response("Forbidden", { status: 403, statusText: "Forbidden" });
  }
  return access;
}

/** Admin-surface only (e.g. minting a web handoff). */
export async function requireAdminSurface(request: Request): Promise<ShopAccess> {
  const access = await requireShopAccess(request);
  if (access.surface !== "admin") throw new Response("Forbidden", { status: 403 });
  return access;
}

/** Web-surface only (account page, push subscriptions). */
export async function requireWebSurface(request: Request): Promise<ShopAccess & { member: WebSessionMember }> {
  const access = await requireShopAccess(request);
  if (access.surface !== "web" || !access.member) throw new Response("Forbidden", { status: 403 });
  return access as ShopAccess & { member: WebSessionMember };
}
