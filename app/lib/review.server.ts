import db from "../db.server";
import { isReviewPromptEligible } from "./review";

// Resolves the review-prompt gate for the shared shell loader (app.tsx).
// Deliberately a plain read, not resolveShopId — that helper upserts on miss
// and this runs on every admin page load. A missing Shop row means a
// brand-new shop, which is inside the 24h floor anyway.

export async function resolveReviewPromptEligible(shopDomain: string): Promise<boolean> {
  try {
    const shop = await db.shop.findUnique({
      where: { domain: shopDomain },
      select: { id: true, installedAt: true },
    });
    if (!shop) return false;

    // Engagement signal: at least one real shopper conversation. isTest: false
    // excludes the merchant's own Test AI console sessions.
    const engaged = await db.conversation.findFirst({
      where: { shopId: shop.id, isTest: false },
      select: { id: true },
    });

    return isReviewPromptEligible({
      installedAt: shop.installedAt,
      hasEngaged: engaged !== null,
    });
  } catch {
    // The review prompt must never take down the admin shell.
    return false;
  }
}
