import { Prisma } from "@prisma/client";
import { z } from "zod";
import db from "../../db.server";
import { requireShopId } from "../tenancy.server";
import { assigneeNameMap } from "../team/team.server";
import { recordEvent } from "../analytics/events.server";
import {
  CONTACTS_PAGE_SIZE,
  compareContacts,
  type ContactSort,
  type ContactSortDir,
  type ContactType,
} from "../../components/ContactsShared";

export { CONTACTS_PAGE_SIZE };
export type { ContactSort, ContactSortDir, ContactType };

// Contacts CRM server helpers (spec 11). Contacts are CREATED elsewhere —
// pre-chat / handover form upserts leads in proxy.prechat.tsx (specs 05/10);
// this module only lists, classifies, details and exports them.
// Every function is shop-scoped: shopId comes from authenticate.admin only.

export interface ContactListOptions {
  type?: ContactType;
  q?: string;
  sort?: ContactSort;
  dir?: ContactSortDir;
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
  lastActivityAt: Date | null;
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
 *  with per-contact conversation counts and latest activity (test conversations
 *  excluded). Sorted with the same comparator the table uses client-side. */
export async function listContacts(
  shopId: string,
  opts: ContactListOptions = {},
): Promise<ContactListItem[]> {
  const contacts = await db.contact.findMany({
    where: listWhere(shopId, opts),
    orderBy: { createdAt: "desc" },
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
    _max: { lastMessageAt: true },
  });
  const countByContact = new Map(counts.map((row) => [row.contactId, row._count._all]));
  const activityByContact = new Map(counts.map((row) => [row.contactId, row._max.lastMessageAt]));
  return contacts
    .map((c) => ({
      ...c,
      lastActivityAt: activityByContact.get(c.id) ?? null,
      conversationCount: countByContact.get(c.id) ?? 0,
    }))
    .sort((a, b) => compareContacts(a, b, opts.sort ?? "created", opts.dir ?? "desc"));
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

/** Ensure the widget session has a contact row: reuse whatever contact is
 *  already bound to the sessionId (anonymous OR identified), else create an
 *  anonymous one (spec 11: anonymous conversation start → anonymous contact). */
export async function ensureSessionContact(shopId: string, sessionId: string): Promise<string> {
  const existing = await db.contact.findFirst({
    where: { shopId: requireShopId(shopId), sessionId },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (existing) return existing.id;
  const created = await db.contact.create({
    data: { shopId, sessionId, type: "anonymous", channel: "store" },
    select: { id: true },
  });
  return created.id;
}

/** Manual edit from the Contacts table: update basic identity fields. An
 *  anonymous contact gaining an email becomes a lead (mirrors pre-chat).
 *  Customers are NOT editable — their identity lives on the linked Shopify
 *  profile and a local edit would silently desync from it (the UI hides the
 *  button; this guard enforces it server-side). */
export async function updateContactInfo(
  shopId: string,
  contactId: string,
  data: { name: string; email: string; phone: string },
): Promise<boolean | { error: string }> {
  const existing = await db.contact.findFirst({
    where: { id: contactId, shopId: requireShopId(shopId) },
    select: { type: true },
  });
  if (!existing || existing.type === "customer") return false;
  const name = data.name.trim().slice(0, 120) || null;
  const email = data.email.trim().toLowerCase() || null;
  const phone = data.phone.trim() || null;
  if (email && !z.email().max(200).safeParse(email).success) {
    return { error: "Enter a valid email address." };
  }
  if (phone && !/^\+?[\d\s().-]{5,40}$/.test(phone)) {
    return { error: "Enter a valid phone number." };
  }
  if (email) {
    const clash = await db.contact.findFirst({
      where: { shopId, email, id: { not: contactId } },
      select: { id: true },
    });
    if (clash) return { error: "Another contact already uses this email." };
  }
  const becomesLead = existing.type === "anonymous" && Boolean(email);
  // A lead whose identity fields are all cleared is anonymous again.
  const becomesAnonymous = existing.type === "lead" && !email && !name && !phone;
  await db.contact.update({
    where: { id: contactId },
    data: {
      name,
      email,
      phone,
      ...(becomesLead ? { type: "lead" } : {}),
      ...(becomesAnonymous ? { type: "anonymous" } : {}),
    },
  });
  if (becomesLead) {
    await recordEvent(shopId, "contact_converted", {
      contactId,
      from: "anonymous",
      to: "lead",
      source: "manual",
    });
  }
  return true;
}

/** Delete a contact, their linked conversations (messages → unresolved
 *  questions → conversations, mirroring the retention purge) AND their Shopify
 *  customer profile if one is linked (contact4.png; merchant-confirmed
 *  2026-08-14). The Shopify delete is fail-soft: Shopify refuses to delete
 *  customers with orders — the app-side delete still proceeds. NOTE: the
 *  Contacts loader must NOT backfill contact-less conversations — a deleted
 *  contact would be recreated on the very next load. New conversations bind a
 *  contact at creation (ensureSessionContact in the pipeline). */
export async function deleteContact(
  shopId: string,
  contactId: string,
  graphql: AdminGraphql,
): Promise<boolean> {
  const existing = await db.contact.findFirst({
    where: { id: contactId, shopId: requireShopId(shopId) },
    select: { id: true, sessionId: true, shopifyCustomerId: true },
  });
  if (!existing) return false;
  if (existing.shopifyCustomerId) {
    try {
      await graphql(
        `#graphql
        mutation ContactCustomerDelete($input: CustomerDeleteInput!) {
          customerDelete(input: $input) {
            deletedCustomerId
            userErrors { message }
          }
        }`,
        { variables: { input: { id: existing.shopifyCustomerId } } },
      );
    } catch {
      // Missing scope / API error — the contact + conversations still delete.
    }
  }
  // Everything this person talked about: conversations bound to the contact,
  // plus any unbound ones from the same widget session (legacy rows).
  const conversations = await db.conversation.findMany({
    where: {
      shopId,
      OR: [
        { contactId },
        ...(existing.sessionId
          ? [{ sessionId: existing.sessionId, contactId: null }]
          : []),
      ],
    },
    select: { id: true },
  });
  const ids = conversations.map((c) => c.id);
  if (ids.length > 0) {
    await db.message.deleteMany({ where: { shopId, conversationId: { in: ids } } });
    await db.unresolvedQuestion.deleteMany({ where: { shopId, conversationId: { in: ids } } });
    await db.conversation.deleteMany({ where: { shopId, id: { in: ids } } });
  }
  await db.contact.delete({ where: { id: contactId } });
  return true;
}

/** Minimal shape of admin.graphql from authenticate.admin — kept structural so
 *  this module doesn't import shopify.server. */
type AdminGraphql = (
  query: string,
  options?: { variables?: Record<string, unknown> },
) => Promise<Response>;

/** Match unmatched contacts (email set, no shopifyCustomerId) against the
 *  shop's Shopify customers by email and upgrade hits to "customer".
 *  Needs the read_customers scope — failures (e.g. scope not yet granted)
 *  are swallowed so the Contacts page still loads. */
export async function matchContactsToShopifyCustomers(
  shopId: string,
  graphql: AdminGraphql,
): Promise<number> {
  const candidates = await db.contact.findMany({
    where: {
      shopId: requireShopId(shopId),
      type: { not: "customer" },
      shopifyCustomerId: null,
      email: { not: null },
    },
    orderBy: { createdAt: "desc" },
    take: 25,
    select: { id: true, email: true, type: true },
  });
  if (candidates.length === 0) return 0;

  let upgraded = 0;
  try {
    // One search query per chunk: email:"a" OR email:"b" …
    for (let i = 0; i < candidates.length; i += 10) {
      const chunk = candidates.slice(i, i + 10);
      const search = chunk
        .map((c) => `email:"${(c.email ?? "").replace(/["\\]/g, "")}"`)
        .join(" OR ");
      const response = await graphql(
        `#graphql
        query MatchContacts($search: String!) {
          customers(first: 30, query: $search) {
            nodes { id email }
          }
        }`,
        { variables: { search } },
      );
      const body = (await response.json()) as {
        data?: { customers?: { nodes?: { id: string; email: string | null }[] } };
      };
      const byEmail = new Map(
        (body.data?.customers?.nodes ?? [])
          .filter((n) => n.email)
          .map((n) => [n.email!.toLowerCase(), n.id]),
      );
      for (const contact of chunk) {
        const customerId = byEmail.get((contact.email ?? "").toLowerCase());
        if (!customerId) continue;
        await db.contact.update({
          where: { id: contact.id },
          data: { type: "customer", shopifyCustomerId: customerId },
        });
        await recordEvent(shopId, "contact_converted", {
          contactId: contact.id,
          from: contact.type,
          to: "customer",
          source: "shopify_match",
        });
        upgraded += 1;
      }
    }
  } catch {
    // Missing scope / API error — leave contacts as-is, retry next load.
  }
  return upgraded;
}

export interface ConvertToCustomerInput {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

/** "Convert to customer" (detail panel, contact3.png): create a real Shopify
 *  customer profile via customerCreate — or link the existing one if the email
 *  is already taken — then upgrade the contact. Needs write_customers. */
export async function convertContactToShopifyCustomer(
  shopId: string,
  contactId: string,
  graphql: AdminGraphql,
  input: ConvertToCustomerInput,
): Promise<{ ok: boolean; error?: string }> {
  const contact = await db.contact.findFirst({
    where: { id: contactId, shopId: requireShopId(shopId) },
  });
  if (!contact) return { ok: false, error: "Contact not found." };
  const email = input.email.trim();
  if (!email) return { ok: false, error: "Email address is required." };
  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  const phone = input.phone.trim();

  let customerId: string | null = null;
  let linkedExisting = false;
  try {
    const response = await graphql(
      `#graphql
      mutation ContactConvertCustomerCreate($input: CustomerInput!) {
        customerCreate(input: $input) {
          customer { id }
          userErrors { message }
        }
      }`,
      {
        variables: {
          input: {
            email,
            ...(firstName ? { firstName } : {}),
            ...(lastName ? { lastName } : {}),
            ...(phone ? { phone } : {}),
          },
        },
      },
    );
    const body = (await response.json()) as {
      data?: {
        customerCreate?: {
          customer?: { id: string } | null;
          userErrors?: { message: string }[];
        };
      };
    };
    customerId = body.data?.customerCreate?.customer?.id ?? null;
    const errors = body.data?.customerCreate?.userErrors ?? [];
    if (!customerId && errors.length > 0) {
      // Email already belongs to a Shopify customer → link that one instead.
      if (errors.some((e) => /taken/i.test(e.message))) {
        const lookup = await graphql(
          `#graphql
          query ContactConvertCustomerLookup($search: String!) {
            customers(first: 1, query: $search) {
              nodes { id email }
            }
          }`,
          { variables: { search: `email:"${email.replace(/["\\]/g, "")}"` } },
        );
        const lookupBody = (await lookup.json()) as {
          data?: { customers?: { nodes?: { id: string; email: string | null }[] } };
        };
        const match = lookupBody.data?.customers?.nodes?.find(
          (n) => n.email?.toLowerCase() === email.toLowerCase(),
        );
        customerId = match?.id ?? null;
        linkedExisting = customerId !== null;
      }
      if (!customerId) return { ok: false, error: errors.map((e) => e.message).join(" ") };
    }
  } catch {
    return { ok: false, error: "Couldn't reach Shopify. Please try again." };
  }
  if (!customerId) return { ok: false, error: "Shopify didn't return a customer. Please try again." };

  const name = `${firstName} ${lastName}`.trim();
  await db.contact.update({
    where: { id: contact.id },
    data: {
      type: "customer",
      shopifyCustomerId: customerId,
      email,
      name: name || contact.name,
      phone: phone || contact.phone,
    },
  });
  if (contact.type !== "customer") {
    await recordEvent(shopId, "contact_converted", {
      contactId: contact.id,
      from: contact.type,
      to: "customer",
      source: linkedExisting ? "manual_link" : "manual_create",
    });
  }
  return { ok: true };
}

/** Re-evaluate a contact's type. v1 rule: a contact bound to a storefront
 *  customer id (captured at creation from the logged-in session, spec 05) is a
 *  customer; leads/anonymous never downgrade. Email→customer matching runs in
 *  matchContactsToShopifyCustomers (Contacts page load). */
export async function classifyContact(shopId: string, contactId: string) {
  const contact = await db.contact.findFirst({
    where: { id: contactId, shopId: requireShopId(shopId) },
  });
  if (!contact) return null;
  if (contact.type !== "customer" && contact.shopifyCustomerId) {
    const updated = await db.contact.update({
      where: { id: contact.id },
      data: { type: "customer" },
    });
    await recordEvent(shopId, "contact_converted", {
      contactId: contact.id,
      from: contact.type,
      to: "customer",
      source: "storefront_id",
    });
    return updated;
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
  /** Rows per page for scope "page" (the table's items-per-page selector). */
  pageSize?: number;
}

function csvField(value: string): string {
  // Spreadsheet formula injection: a cell starting with = + - @ or a tab/CR is
  // evaluated by Excel/Sheets even when quoted — neutralise with a leading
  // apostrophe (the standard mitigation; the value still reads correctly).
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r']/.test(safe) || safe !== value
    ? `"${safe.replace(/"/g, '""')}"`
    : safe;
}

/** Build the export CSV (UTF-8). scope "page" re-slices the same filtered +
 *  sorted list the table shows (pageSize/page from the table state); "all"
 *  exports every matching row. */
export async function exportContactsCsv(shopId: string, opts: ExportOptions): Promise<string> {
  const all = await listContacts(shopId, opts);
  const pageSize = opts.pageSize && opts.pageSize > 0 ? opts.pageSize : CONTACTS_PAGE_SIZE;
  const rows =
    opts.scope === "page"
      ? all.slice(
          (Math.max(1, opts.page ?? 1) - 1) * pageSize,
          Math.max(1, opts.page ?? 1) * pageSize,
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

export type ContactActivityKind =
  | "first_seen"
  | "conversation_started"
  | "conversation_resolved"
  | "handover"
  | "rated"
  | "recommended"
  | "added_to_cart"
  | "converted";

export interface ContactActivity {
  at: Date;
  kind: ContactActivityKind;
  /** Resolver name (the conversation's assignee) for conversation_resolved. */
  by?: string;
  rating?: number;
  products?: string[];
  /** Conversion entries: the new type + how it happened (contact_converted). */
  to?: string;
  source?: string;
}

export interface ContactDetail {
  contact: ContactListItem;
  conversations: {
    id: string;
    preview: string;
    status: string;
    lastMessageAt: Date;
  }[];
  /** Timeline for the panel's Activity section (customer5.png), newest first. */
  activities: ContactActivity[];
}

/** Contact + their conversations (latest-message preview) + activity timeline
 *  for the side panel. The timeline is DERIVED — conversation lifecycle rows,
 *  handover messages, and product-card messages already carry timestamps, so
 *  no separate activity table exists. */
export async function contactDetail(
  shopId: string,
  contactId: string,
): Promise<ContactDetail | null> {
  const contact = await db.contact.findFirst({
    where: { id: contactId, shopId: requireShopId(shopId) },
    select: { ...CONTACT_SELECT, sessionId: true },
  });
  if (!contact) return null;

  // Header count is the true total; the list below is capped at 20.
  const conversationCount = await db.conversation.count({
    where: { shopId, contactId, isTest: false },
  });
  const conversations = await db.conversation.findMany({
    where: { shopId, contactId, isTest: false },
    orderBy: { lastMessageAt: "desc" },
    take: 20,
    select: {
      id: true,
      status: true,
      lastMessageAt: true,
      startedAt: true,
      endedAt: true,
      rating: true,
      assigneeId: true,
    },
  });
  const convoIds = conversations.map((c) => c.id);

  // added_to_cart beacons are attributed via the sessionId/conversationId the
  // widget sends with the cart snapshot (stored into the payload since
  // 2026-08-14 — older events carry no identity and can't be shown).
  //
  // PERF (QA pass): these two lookups used Prisma's `payload: { path, equals }`
  // filter, which compiles to `payload#>>'{key}' = $n` — unindexable, so both
  // scanned every event of that type (measured 161 ms and 2 627 ms at 150k
  // events). Written as jsonb containment (`@>`) they hit
  // analytics_events_payload_gin (migration 20260821140000): 3.7 ms and 1.0 ms.
  const atcContainment: Prisma.Sql[] = [
    ...convoIds.map(
      (id) => Prisma.sql`"payload" @> jsonb_build_object('conversationId', ${id}::text)`,
    ),
    ...(contact.sessionId
      ? [Prisma.sql`"payload" @> jsonb_build_object('sessionId', ${contact.sessionId}::text)`]
      : []),
  ];

  const [previews, handoverMessages, cardMessages, cartEvents, conversionEvents, assigneeNames] =
    await Promise.all([
    // One DISTINCT ON pass instead of one findFirst per conversation (was 20
    // round-trips per contact-detail open).
    convoIds.length
      ? db.$queryRaw<{ conversationId: string; content: string }[]>`
          SELECT DISTINCT ON ("conversationId") "conversationId", "content"
          FROM "messages"
          WHERE "shopId" = ${shopId}
            AND "conversationId" IN (${Prisma.join(convoIds)})
            AND "role" IN ('in', 'out')
          ORDER BY "conversationId", "createdAt" DESC`
      : Promise.resolve([]),
    convoIds.length
      ? db.message.findMany({
          where: { shopId, conversationId: { in: convoIds }, sourceLayer: "handover" },
          orderBy: { createdAt: "asc" },
          select: { conversationId: true, createdAt: true },
        })
      : Promise.resolve([]),
    convoIds.length
      ? db.message.findMany({
          where: {
            shopId,
            conversationId: { in: convoIds },
            NOT: { productCards: { equals: Prisma.DbNull } },
          },
          orderBy: { createdAt: "desc" },
          take: 20,
          select: { createdAt: true, productCards: true },
        })
      : Promise.resolve([]),
    atcContainment.length
      ? db.$queryRaw<{ occurredAt: Date; payload: unknown }[]>`
          SELECT "occurredAt", "payload" FROM "analytics_events"
          WHERE "shopId" = ${shopId} AND "type" = 'added_to_cart'
            AND (${Prisma.join(atcContainment, " OR ")})
          ORDER BY "occurredAt" DESC LIMIT 20`
      : Promise.resolve([]),
    db.$queryRaw<{ occurredAt: Date; payload: unknown }[]>`
      SELECT "occurredAt", "payload" FROM "analytics_events"
      WHERE "shopId" = ${shopId} AND "type" = 'contact_converted'
        AND "payload" @> jsonb_build_object('contactId', ${contactId}::text)
      ORDER BY "occurredAt" DESC LIMIT 10`,
    assigneeNameMap(shopId),
  ]);

  const memberName = assigneeNames;
  const activities: ContactActivity[] = [{ at: contact.createdAt, kind: "first_seen" }];
  for (const c of conversations) {
    activities.push({ at: c.startedAt, kind: "conversation_started" });
    if (c.status === "resolved") {
      activities.push({
        at: c.endedAt ?? c.lastMessageAt,
        kind: "conversation_resolved",
        by: c.assigneeId ? memberName.get(c.assigneeId) : undefined,
      });
    }
    if (c.rating != null) {
      // Ratings have no own timestamp — the conversation's last activity is
      // the closest moment (the survey follows the final message).
      activities.push({ at: c.endedAt ?? c.lastMessageAt, kind: "rated", rating: c.rating });
    }
  }
  const seenHandover = new Set<string>();
  for (const m of handoverMessages) {
    if (seenHandover.has(m.conversationId)) continue;
    seenHandover.add(m.conversationId);
    activities.push({ at: m.createdAt, kind: "handover" });
  }
  for (const m of cardMessages) {
    const cards = (m.productCards ?? []) as { title?: string }[];
    const products = cards.map((card) => card.title ?? "").filter(Boolean);
    if (products.length > 0) activities.push({ at: m.createdAt, kind: "recommended", products });
  }
  for (const event of cartEvents) {
    const product = (event.payload as { product?: unknown } | null)?.product;
    activities.push({
      at: event.occurredAt,
      kind: "added_to_cart",
      products: typeof product === "string" && product ? [product] : undefined,
    });
  }
  for (const event of conversionEvents) {
    const payload = (event.payload ?? {}) as { to?: unknown; source?: unknown };
    activities.push({
      at: event.occurredAt,
      kind: "converted",
      to: typeof payload.to === "string" ? payload.to : undefined,
      source: typeof payload.source === "string" ? payload.source : undefined,
    });
  }
  activities.sort((a, b) => b.at.getTime() - a.at.getTime());

  const previewByConvo = new Map(previews.map((p) => [p.conversationId, p.content]));
  return {
    contact: {
      ...contact,
      lastActivityAt: conversations[0]?.lastMessageAt ?? null,
      conversationCount,
    },
    conversations: conversations.map((c) => ({
      id: c.id,
      status: c.status,
      lastMessageAt: c.lastMessageAt,
      preview: (previewByConvo.get(c.id) ?? "").slice(0, 120),
    })),
    activities: activities.slice(0, 50),
  };
}
