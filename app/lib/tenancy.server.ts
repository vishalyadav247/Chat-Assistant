import db from "../db.server";

// Multi-tenancy seam. Every domain query goes through / is checked against a shopId
// resolved from a TRUSTED source (authenticate.admin, appProxy, webhook payload) —
// never from client input. See .claude/skills/db-tenancy/SKILL.md.

/** Resolve (and lazily create) the Shop row for a trusted shop domain. */
export async function resolveShopId(shopDomain: string): Promise<string> {
  assertShopDomain(shopDomain);
  const existing = await db.shop.findUnique({ where: { domain: shopDomain } });
  if (existing) {
    return existing.id;
  }
  const created = await db.shop.upsert({
    where: { domain: shopDomain },
    update: {},
    create: { domain: shopDomain },
  });
  return created.id;
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
