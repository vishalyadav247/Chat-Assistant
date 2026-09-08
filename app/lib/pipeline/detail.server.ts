import { Prisma } from "@prisma/client";
import db from "../../db.server";
import { getLlmProvider } from "../llm/index.server";
import { logError } from "../log.server";
import type { ProductCandidate, ProductVariantInfo } from "../search/product-search.server";
import { requireShopId } from "../tenancy.server";
import { DETAIL_CONFIRM_SYSTEM, detailConfirmUser } from "./prompts";

/**
 * Product-detail follow-ups (spec 03 delta, 2026-09-07).
 *
 * WHY (production behaviour report): the shopper is shown three bracelets,
 * asks "what is this one made of?", and gets a fresh recommendation — three
 * DIFFERENT products, with prose about them. The shopper asked about a thing
 * they were already looking at and the agent changed the subject.
 *
 * The cause is structural, not a tuning miss. The router has exactly three
 * intents — buy / question / chat. `question` means POLICY (shipping, returns,
 * sizing, payment, warranty, care), answered from store info. So any message
 * with product words in it lands in `buy`, and `buy` always means "retrieve
 * candidates and recommend". A question ABOUT a product had no lane at all: it
 * was re-run through hybrid search, whose query ("what is it made of") matches
 * more or less arbitrary rows, and the model dutifully recommended them.
 *
 * The fix is a fourth path, deliberately kept OUT of the buy lane: that lane
 * carries a lot of tuned precision machinery (relevance tiers, lexical anchors,
 * pick constraints) which exists to answer "which of these fit the request?"
 * — the wrong question here, where the product is already decided. This lane
 * only ever speaks about products this conversation has ALREADY shown, so it
 * cannot introduce one, and it retrieves nothing.
 */

/** How many earlier assistant turns to mine for already-shown products. */
const HISTORY_TURNS = 6;
/** Allow-list ceiling handed to the model. */
export const DETAIL_CANDIDATES = 6;

interface StoredCard {
  shopifyProductId?: unknown;
  title?: unknown;
}

/**
 * Products this conversation has already put in front of the shopper, newest
 * first, re-read from the catalogue rather than trusted from the stored card.
 *
 * The card is a snapshot of what was shown; price and stock move underneath it,
 * and a detail answer that quotes a stale price is worse than no answer. The
 * stored card is used only for WHICH products, never for what is true of them.
 */
export async function shownProducts(
  shopId: string,
  conversationId: string,
): Promise<ProductCandidate[]> {
  requireShopId(shopId);
  const rows = await db.message.findMany({
    where: { shopId, conversationId, role: "out", productCards: { not: Prisma.DbNull } },
    orderBy: { createdAt: "desc" },
    take: HISTORY_TURNS,
    select: { productCards: true },
  });

  const ids: string[] = [];
  for (const row of rows) {
    const cards = Array.isArray(row.productCards) ? (row.productCards as StoredCard[]) : [];
    for (const card of cards) {
      const id = typeof card?.shopifyProductId === "string" ? card.shopifyProductId : null;
      if (id && !ids.includes(id)) ids.push(id);
    }
  }
  if (ids.length === 0) return [];

  const products = await db.product.findMany({
    where: { shopId, shopifyProductId: { in: ids.slice(0, DETAIL_CANDIDATES) }, learnEnabled: true },
    select: {
      id: true,
      shopifyProductId: true,
      title: true,
      price: true,
      stock: true,
      imageUrl: true,
      handle: true,
      variants: true,
      productType: true,
      tags: true,
      description: true,
      metafieldText: true,
    },
  });

  // Preserve "most recently shown first" — findMany returns insertion order,
  // and the newest card set is the one the shopper is most likely pointing at.
  const order = new Map(ids.map((id, i) => [id, i]));
  return products
    .sort((a, b) => (order.get(a.shopifyProductId) ?? 0) - (order.get(b.shopifyProductId) ?? 0))
    .map((p) => ({
      id: p.id,
      shopifyProductId: p.shopifyProductId,
      title: p.title,
      price: Number(p.price),
      stock: p.stock,
      imageUrl: p.imageUrl,
      handle: p.handle,
      variants: (p.variants as ProductVariantInfo[] | null) ?? null,
      productType: p.productType,
      tags: p.tags,
      description: p.description,
      metafieldText: p.metafieldText,
      // Retrieval scores are meaningless here: nothing was searched for. The
      // buy lane's tier guards read these, which is one more reason this lane
      // must not reuse it.
      score: null,
      headline: null,
      matchedTerms: [],
      headTerms: [],
      coverage: 0,
      fused: 0,
    }));
}

/**
 * Is this message a question ABOUT a product already shown, rather than a
 * request to see different ones?
 *
 * One focused yes/no call at temperature 0 — the same shape as the borderline
 * curated confirm and the router block confirm, and for the same reason: the
 * router's single crowded JSON judgement is not reliable enough to carry a new
 * distinction, and a 3-token call is far cheaper than a wrong lane.
 *
 * Fails CLOSED: any error, or an unreadable answer, keeps the existing buy-lane
 * behaviour. A broken detail check must never cost a shopper their
 * recommendations.
 */
export async function isDetailFollowUp(
  shopId: string,
  message: string,
  shownTitles: string[],
): Promise<boolean> {
  if (shownTitles.length === 0) return false;
  try {
    const answer = await getLlmProvider().chat(
      [
        { role: "system", content: DETAIL_CONFIRM_SYSTEM },
        { role: "user", content: detailConfirmUser(message, shownTitles) },
      ],
      { shopId, purpose: "router" },
      { temperature: 0, maxTokens: 3 },
    );
    return answer.trim().toLowerCase().startsWith("y");
  } catch (error) {
    logError("detail_confirm_error", error, { shopId });
    return false;
  }
}

/** What the model is allowed to say about each shown product. */
export function detailSnippet(c: ProductCandidate): string {
  const parts: string[] = [];
  if (c.productType) parts.push(`type: ${c.productType}`);
  if (c.tags.length > 0) parts.push(`tags: ${c.tags.slice(0, 12).join(", ")}`);
  const options = variantSummary(c.variants);
  if (options) parts.push(`variants: ${options}`);
  parts.push(c.stock > 0 ? "in stock" : "out of stock");
  // Metafields first: on a well-run store this is where the actual
  // specifications live (material, dimensions, care), whereas the description
  // is marketing prose. Both are truncated — a detail answer is 1-4 sentences,
  // not a data sheet.
  if (c.metafieldText.trim()) parts.push(`specs:\n${c.metafieldText.trim().slice(0, 700)}`);
  if (c.description.trim()) parts.push(`description: ${c.description.trim().slice(0, 900)}`);
  return parts.join("\n");
}

function variantSummary(variants: ProductVariantInfo[] | null): string {
  if (!variants || variants.length === 0) return "";
  const titles = variants
    .map((v) => (typeof v.title === "string" ? v.title.trim() : ""))
    .filter((t) => t.length > 0 && t.toLowerCase() !== "default title");
  if (titles.length === 0) return "";
  return titles.slice(0, 10).join(" | ");
}

