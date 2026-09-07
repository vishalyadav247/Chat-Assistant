import { getShopConfig } from "../config/shop-config.server";
import { primeBannedVectors } from "./guardrail.server";
import { primeRecommendationVectors } from "../search/recommendation-match.server";
import { primeLexicon } from "../search/product-search.server";
import { requireShopId } from "../tenancy.server";

// Warm the per-shop caches a chat turn would otherwise fill itself.
//
// WHY (measured against production 2026-09-04): the first reply in a
// conversation ran a median 5.8 s against 4.1 s for later ones, and the chat
// lane — the one that does the LEAST work — had the worst p90 at 20.7 s. The
// gap was not the model. It was four caches filled lazily INSIDE the shopper's
// first turn: the shop config (6 queries), the banned-topic vectors and the
// recommendation trigger vectors (~600 ms of OpenAI each), and the typo
// lexicon (a full-catalogue scan).
//
// All four can be filled earlier for free. The widget fetches /widget-config
// when the panel opens — seconds before anyone types — so that request warms
// the shop on its way out. Nothing here is awaited by a shopper-facing
// response and nothing here throws: a cold cache is a slow turn, never a
// broken one.

/** Shops warmed recently, so a busy storefront does not re-warm per page view.
 *  Shorter than the shop-config TTL (60 s) so a warm never expires between
 *  the panel opening and the first message. */
const WARM_TTL_MS = 45_000;

declare global {
  // eslint-disable-next-line no-var
  var shopWarmAt: Map<string, number> | undefined;
}

/** Cap on tracked shops — one process serves many tenants and the timestamps
 *  are worth less than the memory past this point. */
const MAX_TRACKED = 1000;

/**
 * Fill this shop's chat caches. Fire-and-forget: call it with `void`.
 *
 * Throttled per shop, so the config endpoint stays a cheap cached GET even
 * when a storefront is serving thousands of page views an hour.
 */
export async function warmShop(shopId: string): Promise<void> {
  requireShopId(shopId);
  if (!global.shopWarmAt) global.shopWarmAt = new Map();
  const seen = global.shopWarmAt.get(shopId);
  const now = Date.now();
  if (seen && now - seen < WARM_TTL_MS) return;
  // Claim the slot BEFORE the awaits: two page views landing together must not
  // both run the warm.
  global.shopWarmAt.set(shopId, now);
  if (global.shopWarmAt.size > MAX_TRACKED) {
    for (const [key, at] of global.shopWarmAt) {
      if (now - at >= WARM_TTL_MS) global.shopWarmAt.delete(key);
    }
  }

  try {
    const config = await getShopConfig(shopId);
    await Promise.all([
      primeBannedVectors(shopId, config.guardrails),
      primeRecommendationVectors(shopId),
      config.settings.learn.products ? primeLexicon(shopId) : Promise.resolve(),
    ]);
  } catch {
    // Warming is best-effort by definition — the turn fills whatever is missing.
    // Clear the marker so the next request may retry rather than wait out the TTL.
    global.shopWarmAt?.delete(shopId);
  }
}
