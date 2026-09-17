import { Prisma } from "@prisma/client";
import db from "../db.server";

// Multi-tenancy seam. Every domain query goes through / is checked against a shopId
// resolved from a TRUSTED source (authenticate.admin, appProxy, webhook payload, or
// the TeamSession row behind the web-surface cookie — see app/lib/access.server.ts,
// spec 18) — never from client input. See .claude/skills/db-tenancy/SKILL.md.

/** Resolve (and lazily create) the Shop row for a trusted shop domain. */
export async function resolveShopId(shopDomain: string): Promise<string> {
  assertShopDomain(shopDomain);
  const existing = await db.shop.findUnique({ where: { domain: shopDomain } });
  if (existing) {
    return existing.id;
  }
  try {
    const created = await db.shop.create({ data: { domain: shopDomain } });
    return created.id;
  } catch (error) {
    // Shopify can deliver two afterAuth callbacks for a single install, and both
    // can reach this line having seen no row. That produced a real P2002 in
    // production (app_logs event `after_auth_error`, 2026-08-27,
    // jgw-check.myshopify.com), failing the merchant's OAuth flow for a shop that
    // already existed. This was previously an `upsert`, which did not prevent it.
    //
    // The exact window is UNCONFIRMED: an 8-way concurrency probe against a local
    // Postgres could not reproduce the failure with either form, so do not treat a
    // green local run as proof the race is gone. Catching P2002 and re-reading is
    // correct regardless of where the window actually sits, and is the behaviour
    // afterAuth needs either way — a shop that already exists is success, not an
    // error. Regression cover: scripts/qa/tenancy-race.test.ts.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const raced = await db.shop.findUnique({ where: { domain: shopDomain } });
      if (raced) {
        return raced.id;
      }
    }
    throw error;
  }
}

export function assertShopDomain(shopDomain: unknown): asserts shopDomain is string {
  if (typeof shopDomain !== "string" || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shopDomain)) {
    throw new Error("tenancy: invalid or missing shop domain");
  }
}

/** Guard for raw-SQL call sites: throws unless a non-empty shopId is provided. */
export function requireShopId(shopId: unknown): string {
  if (typeof shopId !== "string" || shopId.length === 0) {
    throw new Error("tenancy: query attempted without shopId");
  }
  return shopId;
}
