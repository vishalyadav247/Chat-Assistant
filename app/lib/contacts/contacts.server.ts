import db from "../../db.server";
import { requireShopId } from "../tenancy.server";
import {
  CONTACTS_PAGE_SIZE,
  type ContactSort,
  type ContactType,
} from "../../components/ContactsShared";

export { CONTACTS_PAGE_SIZE };
export type { ContactSort, ContactType };

// Contacts CRM server helpers (spec 11). Contacts are CREATED elsewhere —
// pre-chat / handover form upserts leads in proxy.prechat.tsx (specs 05/10);
// this module only lists, classifies, details and exports them.
// Every function is shop-scoped: shopId comes from authenticate.admin only.

export interface ContactListOptions {
  type?: ContactType;
  q?: string;
  sort?: ContactSort;
}

export interface ContactListItem {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  type: string;
  channel: string;
  location: string | null;
  marketingOptIn: boolean;
  createdAt: Date;
  conversationCount: number;
}

const CONTACT_SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
  type: true,
  channel: true,
  location: true,
  marketingOptIn: true,
  createdAt: true,
} as const;

function listWhere(shopId: string, opts: ContactListOptions) {
  const q = opts.q?.trim();
  return {
    shopId: requireShopId(shopId),
    ...(opts.type ? { type: opts.type } : {}),
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" as const } },
            { email: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };
}

/** List contacts for the admin table: optional type filter + name/email search,
 *  with per-contact conversation counts (test conversations excluded). */
export async function listContacts(
  shopId: string,
  opts: ContactListOptions = {},
): Promise<ContactListItem[]> {
  const contacts = await db.contact.findMany({
    where: listWhere(shopId, opts),
    orderBy:
      opts.sort === "name"
        ? [{ name: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }]
        : { createdAt: "desc" },
    select: CONTACT_SELECT,
  });
  if (contacts.length === 0) return [];

  const counts = await db.conversation.groupBy({
    by: ["contactId"],
    where: {
      shopId,
      contactId: { in: contacts.map((c) => c.id) },
      isTest: false,
    },
    _count: { _all: true },
  });
  const countByContact = new Map(counts.map((row) => [row.contactId, row._count._all]));
  return contacts.map((c) => ({
    ...c,
    conversationCount: countByContact.get(c.id) ?? 0,
  }));
}

export interface ContactStats {
  total: number;
  customers: number;
  leads: number;
  anonymous: number;
}

/** Stat-tile counts: total / customers / leads / anonymous. */
export async function contactStats(shopId: string): Promise<ContactStats> {
  const grouped = await db.contact.groupBy({
    by: ["type"],
    where: { shopId: requireShopId(shopId) },
    _count: { _all: true },
  });
  const of = (type: string) => grouped.find((g) => g.type === type)?._count._all ?? 0;
  const customers = of("customer");
  const leads = of("lead");
  const anonymous = of("anonymous");
  return { total: customers + leads + anonymous, customers, leads, anonymous };
}

/** Re-evaluate a contact's type. v1 rule: a contact bound to a storefront
 *  customer id (captured at creation from the logged-in session, spec 05) is a
 *  customer; leads/anonymous never downgrade. Email→customer matching via the
 *  Admin API is deferred (see spec 11 delta note). */
export async function classifyContact(shopId: string, contactId: string) {
  const contact = await db.contact.findFirst({
    where: { id: contactId, shopId: requireShopId(shopId) },
  });
  if (!contact) return null;
  if (contact.type !== "customer" && contact.shopifyCustomerId) {
    return db.contact.update({
      where: { id: contact.id },
      data: { type: "customer" },
    });
  }
  return contact;
}

/** Opportunistic pass on page load: upgrade any contact whose Shopify customer
 *  id arrived after its row was created. Returns number of upgrades. */
export async function reclassifyPendingContacts(shopId: string): Promise<number> {
  const pending = await db.contact.findMany({
    where: {
      shopId: requireShopId(shopId),
      type: { not: "customer" },
      shopifyCustomerId: { not: null },
    },
    select: { id: true },
  });
  for (const row of pending) {
    await classifyContact(shopId, row.id);
  }
  return pending.length;
}

export interface ExportOptions extends ContactListOptions {
  scope: "page" | "all";
  page?: number;
}

function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Build the export CSV (UTF-8). scope "page" re-slices the same filtered +
 *  sorted list the table shows (10/page); "all" exports every matching row. */
export async function exportContactsCsv(shopId: string, opts: ExportOptions): Promise<string> {
  const all = await listContacts(shopId, opts);
  const rows =
    opts.scope === "page"
      ? all.slice(
          (Math.max(1, opts.page ?? 1) - 1) * CONTACTS_PAGE_SIZE,
          Math.max(1, opts.page ?? 1) * CONTACTS_PAGE_SIZE,
        )
      : all;

  const header = [
    "name",
    "email",
    "phone",
    "type",
    "channel",
    "location",
    "conversations",
    "marketingOptIn",
    "createdAt",
  ].join(",");
  const lines = rows.map((c) =>
    [
      csvField(c.name ?? ""),
      csvField(c.email ?? ""),
      csvField(c.phone ?? ""),
      c.type,
      c.channel,
      csvField(c.location ?? ""),
      String(c.conversationCount),
      c.marketingOptIn ? "yes" : "no",
      c.createdAt.toISOString(),
    ].join(","),
  );
  return [header, ...lines].join("\n") + "\n";
}

export interface ContactDetail {
  contact: ContactListItem;
  conversations: {
    id: string;
    preview: string;
    status: string;
    lastMessageAt: Date;
  }[];
}

/** Contact + their conversations (latest-message preview) for the side panel. */
export async function contactDetail(
  shopId: string,
  contactId: string,
): Promise<ContactDetail | null> {
  const contact = await db.contact.findFirst({
    where: { id: contactId, shopId: requireShopId(shopId) },
    select: CONTACT_SELECT,
  });
  if (!contact) return null;

  const conversations = await db.conversation.findMany({
    where: { shopId, contactId, isTest: false },
    orderBy: { lastMessageAt: "desc" },
    take: 20,
    select: { id: true, status: true, lastMessageAt: true },
  });

  const previews = await Promise.all(
    conversations.map((c) =>
      db.message.findFirst({
        where: { shopId, conversationId: c.id, role: { in: ["in", "out"] } },
        orderBy: { createdAt: "desc" },
        select: { content: true },
      }),
    ),
  );

  return {
    contact: { ...contact, conversationCount: conversations.length },
    conversations: conversations.map((c, i) => ({
      ...c,
      preview: (previews[i]?.content ?? "").slice(0, 120),
    })),
  };
}
