import db from "../../db.server";
import { formatMoney } from "../format/money";
import { requireShopId } from "../tenancy.server";
import { logError } from "../log.server";

// What the agent is allowed to know about the person it is talking to.
//
// WHY (production transcript, ankastra.myshopify.com, 2026-09-04):
//
//     shopper: do you know how i am
//     agent:   I don't know you personally…
//     shopper: i have already shared my email and phone with you so why you
//              dont know me
//     agent:   I don't have access to personal information…
//
// Both replies were false. The shopper had filled in the pre-chat form; the
// name, email and phone were sitting on their Contact row, joined to that very
// conversation. Nothing read them — proxy.prechat.tsx wrote the row and the
// pipeline only ever called ensureSessionContact to create one. The agent
// contradicted something the shopper knew to be true, which costs more trust
// than never having asked.
//
// The block this builds is appended to the persona prompt, so every lane (buy,
// question, chat) gets it from one place.
//
// PRIVACY (spec 17 / App Store): the NAME may be spoken. The email, phone and
// address never enter the prompt at all — the model cannot repeat what it was
// never given, which is a stronger guarantee than instructing it not to.

export interface ShopperContextInput {
  shopId: string;
  contactId: string | null;
  /** The conversation's merged pageContext blob (page + live cart + device). */
  pageContext: unknown;
  currency: string;
}

/** Everything the prompt is allowed to say about the shopper, already rendered.
 *  Empty string when we know nothing — the persona prompt is then unchanged. */
export async function shopperContext(input: ShopperContextInput): Promise<string> {
  const facts: string[] = [];
  let hasName = false;

  try {
    if (input.contactId) {
      const contact = await db.contact.findFirst({
        where: { id: input.contactId, shopId: requireShopId(input.shopId) },
        select: { name: true, type: true, location: true },
      });
      const firstName = (contact?.name ?? "").trim().split(/\s+/)[0] ?? "";
      // A one-character or numeric "name" is form noise, not something to greet.
      if (firstName.length >= 2 && /[a-z]/i.test(firstName)) {
        // People type their own name lowercase in a form ("vishal yadav") and
        // the model then greets them lowercase. Capitalise the first letter and
        // leave the rest alone, so "McRae" and "d'Souza" survive.
        const shown = firstName.charAt(0).toUpperCase() + firstName.slice(1);
        facts.push(`Their first name is ${shown}.`);
        hasName = true;
      }
      if (contact?.type === "customer") {
        facts.push("They have ordered from this store before.");
      }
      if (contact?.location) {
        facts.push(`They are in ${contact.location}.`);
      }
    }
  } catch (error) {
    // Knowing nothing is the old behaviour; failing the turn is not.
    logError("shopper_context_error", error, { shopId: input.shopId });
  }

  facts.push(...browsingFacts(input.pageContext, input.currency));
  if (facts.length === 0) return "";

  return [
    `SHOPPER: ${facts.join(" ")}`,
    "Treat this as things you already know about them.",
    // Only worth saying when there IS a name — otherwise it invites the model
    // to ask for one, or to address a stranger by a name it does not have.
    hasName
      ? "Use their name naturally and at most once in a reply — never open every message with it."
      : "",
    "If they ask whether you know them or what they told you, answer from this list and say yes; never tell them you have no information about them.",
    "Never state their email address, phone number or full address back to them.",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Facts from the merged pageContext blob: where they are and what is in the
 *  cart. The widget already sends both with every message for the inbox
 *  details card; until now generation threw them away. */
function browsingFacts(pageContext: unknown, currency: string): string[] {
  if (!pageContext || typeof pageContext !== "object" || Array.isArray(pageContext)) return [];
  const ctx = pageContext as Record<string, unknown>;
  const out: string[] = [];

  const url = typeof ctx.url === "string" ? ctx.url.trim() : "";
  // Only a product page is worth naming — "/" or "/collections/all" tells the
  // model nothing and invites it to guess.
  if (url.startsWith("/products/")) {
    const handle = url.slice("/products/".length).split(/[?#]/)[0];
    if (handle) out.push(`They are looking at the product page for "${handle}".`);
  }

  const cart = ctx.cart;
  if (cart && typeof cart === "object" && !Array.isArray(cart)) {
    const c = cart as Record<string, unknown>;
    const count = typeof c.itemCount === "number" ? c.itemCount : 0;
    const total = typeof c.totalValue === "number" ? c.totalValue : 0;
    if (count > 0) {
      const items = Array.isArray(c.items) ? c.items : [];
      const titles = items
        .map((i) => (i && typeof i === "object" ? (i as { title?: unknown }).title : null))
        .filter((t): t is string => typeof t === "string" && t.length > 0)
        .slice(0, 3);
      const named = titles.length > 0 ? ` (${titles.join(", ")})` : "";
      out.push(
        `Their cart holds ${count} item${count === 1 ? "" : "s"}${named}, ${formatMoney(total, currency)} in total.`,
      );
    }
  }

  return out;
}
