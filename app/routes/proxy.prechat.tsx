import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";
import db from "../db.server";
import { recordEvent } from "../lib/analytics/events.server";
import { resolveShopId } from "../lib/tenancy.server";
import { authenticate } from "../shopify.server";

// POST /apps/chatconvert/prechat — pre-chat form submission (spec 05).
// Creates/updates the lead Contact for this shop and attaches it to the
// conversation. Shop identity comes ONLY from the verified proxy signature.

const bodySchema = z.object({
  sessionId: z.string().min(8).max(64),
  conversationId: z.string().max(64).optional(),
  email: z.email().max(200),
  name: z.string().max(120).optional(),
  phone: z.string().max(40).optional(),
  optIn: z.boolean().optional().default(false),
});

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) {
    return new Response("app not installed", { status: 404 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return new Response("bad request", { status: 400 });
  }
  const { sessionId, conversationId, email, name, phone, optIn } = parsed.data;
  const shopId = await resolveShopId(session.shop);

  // Upsert by (shopId, email). No DB unique on the pair, so find-then-write.
  // The session may already own an anonymous contact (created at conversation
  // start, spec 11) — identify upgrades that row in place, or merges it into
  // the email match, so one person never spans two rows.
  const existing = await db.contact.findFirst({ where: { shopId, email } });
  const anon = await db.contact.findFirst({
    where: { shopId, sessionId, type: "anonymous" },
    orderBy: { createdAt: "desc" },
  });
  let contact;
  if (existing) {
    contact = await db.contact.update({
      where: { id: existing.id },
      data: {
        sessionId,
        name: name || existing.name,
        phone: phone || existing.phone,
        // Never downgrade a known customer; opt-in only ever turns on here.
        type: existing.type === "customer" ? "customer" : "lead",
        marketingOptIn: optIn ? true : existing.marketingOptIn,
      },
    });
    if (anon && anon.id !== existing.id) {
      await db.conversation.updateMany({
        where: { shopId, contactId: anon.id },
        data: { contactId: existing.id },
      });
      await db.contact.delete({ where: { id: anon.id } });
    }
  } else if (anon) {
    contact = await db.contact.update({
      where: { id: anon.id },
      data: {
        email,
        name: name || null,
        phone: phone || null,
        type: "lead",
        marketingOptIn: optIn,
      },
    });
  } else {
    contact = await db.contact.create({
      data: {
        shopId,
        sessionId,
        email,
        name: name || null,
        phone: phone || null,
        type: "lead",
        channel: "store",
        marketingOptIn: optIn,
      },
    });
  }

  if (conversationId) {
    await db.conversation.updateMany({
      where: { id: conversationId, shopId },
      data: { contactId: contact.id },
    });
  }

  await recordEvent(shopId, "prechat_submitted", { optIn, hasName: Boolean(name) });

  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
};
