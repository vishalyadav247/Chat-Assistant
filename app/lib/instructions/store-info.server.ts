import { unauthenticated } from "../../shopify.server";
import { STORE_INFO_MAX } from "../settings/schemas";

// "Fill from Shopify" for Instructions → General → Store info (2026-09-14).
// Builds a DRAFT the merchant reviews before saving — nothing here is saved or
// shown to shoppers until they press Save. Validated against Admin GraphQL
// 2026-07; the `shop` query needs no extra access scope.
//
// Deliberately NOT read: billingAddress. It is the account holder's billing
// address (often a home address), not a public store location — a merchant who
// wants shoppers to know where they are types it in.

const STORE_INFO_QUERY = `#graphql
  query StoreInfoPrefill {
    shop {
      name
      description
      contactEmail
      currencyCode
      shipsToCountries
      primaryDomain { host }
    }
  }
`;

interface ShopFields {
  name: string | null;
  description: string | null;
  contactEmail: string | null;
  currencyCode: string | null;
  shipsToCountries: string[] | null;
  primaryDomain: { host: string | null } | null;
}

/** Country codes → readable list; a long list is summarised, not pasted. */
export function describeShipping(codes: string[]): string {
  if (codes.length === 0) return "";
  if (codes.length > 12) return `We ship to ${codes.length} countries.`;
  let names = codes;
  try {
    const display = new Intl.DisplayNames(["en"], { type: "region" });
    names = codes.map((code) => display.of(code) ?? code);
  } catch {
    // Older runtimes without DisplayNames keep the codes.
  }
  return `We ship to: ${names.join(", ")}.`;
}

/** Pure, for tests: Shopify shop fields → the draft text. */
export function storeInfoDraftFrom(shop: ShopFields): string {
  const lines: string[] = [];
  const name = shop.name?.trim();
  const host = shop.primaryDomain?.host?.trim();
  if (name) lines.push(host ? `${name} is an online store at ${host}.` : `${name} is an online store.`);
  const description = shop.description?.trim();
  if (description) lines.push(description);
  const shipping = describeShipping(shop.shipsToCountries ?? []);
  if (shipping) lines.push(shipping);
  if (shop.currencyCode) lines.push(`Prices are in ${shop.currencyCode}.`);
  if (shop.contactEmail?.trim()) lines.push(`Customer support email: ${shop.contactEmail.trim()}`);
  return lines.join("\n").slice(0, STORE_INFO_MAX);
}

export async function buildStoreInfoDraft(shopDomain: string): Promise<string> {
  const { admin } = await unauthenticated.admin(shopDomain);
  const response = await admin.graphql(STORE_INFO_QUERY);
  const body = (await response.json()) as {
    data?: { shop?: ShopFields };
    errors?: Array<{ message: string }>;
  };
  if (body.errors?.length || !body.data?.shop) {
    throw new Error(body.errors?.map((e) => e.message).join("; ") || "Shopify returned no shop data");
  }
  return storeInfoDraftFrom(body.data.shop);
}
