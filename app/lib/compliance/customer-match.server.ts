import type { Prisma } from "@prisma/client";

// ONE contact-matching rule for the two customer compliance webhooks
// (QA-C4, 2026-09-14): customers/redact erases exactly what
// customers/data_request exports. They used to drift — the export matched
// email only, redact matched email OR customer id.
//
// Payload shape (shopify.dev "Privacy law compliance", verified 2026-09-14):
// `customer: { id: number, email, phone }`; "in some cases a customer record
// contains only the customer's email address".
//
// Id format: the webhook sends the NUMERIC id, while Contact.shopifyCustomerId
// is written from Admin GraphQL as a GID (`gid://shopify/Customer/123`). The old
// redact compared "123" with the GID and never matched — so both forms are
// tried here.

export interface CustomerIdentity {
  email?: string | null;
  customerId?: string | number | null;
  phone?: string | null;
}

const GID_PREFIX = "gid://shopify/Customer/";

const clean = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : typeof value === "number" ? String(value) : undefined;

/** Both representations of a Shopify customer id, or [] when absent. */
export function customerIdForms(raw: string | number | null | undefined): string[] {
  const id = clean(raw);
  if (!id) return [];
  const numeric = id.startsWith(GID_PREFIX) ? id.slice(GID_PREFIX.length) : id;
  if (!/^\d+$/.test(numeric)) return [id];
  return [numeric, `${GID_PREFIX}${numeric}`];
}

/**
 * Contact filter for one customer, or null when the identity has nothing to
 * match on. Callers MUST treat null as "no contacts" — never pass an undefined
 * filter to Prisma, which would drop it and match the whole shop (QA D3).
 */
export function contactMatchWhere(
  shopId: string,
  identity: CustomerIdentity,
): Prisma.ContactWhereInput | null {
  const email = clean(identity.email);
  const phone = clean(identity.phone);
  const ids = customerIdForms(identity.customerId);
  const or: Prisma.ContactWhereInput[] = [
    ...(email ? [{ email }] : []),
    ...(ids.length > 0 ? [{ shopifyCustomerId: { in: ids } }] : []),
    ...(phone ? [{ phone }] : []),
  ];
  if (or.length === 0) return null;
  return { shopId, OR: or };
}
