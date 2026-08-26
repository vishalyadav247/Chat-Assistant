import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";
import db from "../db.server";
import { recordEvent } from "../lib/analytics/events.server";
import { recordCampaignMetric } from "../lib/campaigns/campaigns.server";
import { parseCampaignSettings } from "../lib/settings/schemas";
import { resolveShopId } from "../lib/tenancy.server";
import { authenticate } from "../shopify.server";

// POST /apps/ccwidget/campaign-lead — "Collect lead" submission from a
// proactive-chat discount bubble (spec 12, Subscribe newsletter template).
//
// Same contact-merge rules as proxy.prechat: upsert by (shopId, email), never
// downgrade a known customer, opt-in only ever turns ON. The campaign's own
// stored config decides which fields are accepted and whether the double
// opt-in flag applies — the client's claims about that are ignored.

const bodySchema = z.object({
  campaignId: z.string().min(1).max(64),
  sessionId: z.string().max(64).optional(),
  email: z.email().max(200).transform((v) => v.trim().toLowerCase()),
  name: z.string().max(120).optional(),
  phone: z.string().max(40).optional(),
});

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return new Response("app not installed", { status: 404 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return new Response("bad request", { status: 400 });
  const { campaignId, sessionId, email } = parsed.data;

  const shopId = await resolveShopId(session.shop);
  const campaign = await db.campaign.findFirst({
    where: { id: campaignId, shopId, status: "active" },
    select: { settings: true },
  });
  if (!campaign) return new Response("not found", { status: 404 });

  const message = parseCampaignSettings(campaign.settings).message;
  if (!message.collectLead) return new Response("not found", { status: 404 });

  // Only store the fields this campaign actually asks for.
  const name = message.lead.askName ? parsed.data.name?.trim() || null : null;
  const phone = message.lead.askPhone ? parsed.data.phone?.trim() || null : null;
  // Double opt-in on → the address is captured but NOT marked opted-in until
  // the shopper confirms by email (spec 17). Off → the form itself is consent.
  const optIn = !message.lead.doubleOptIn;

  const existing = await db.contact.findFirst({ where: { shopId, email } });
  let contactId: string;
  if (existing) {
    const updated = await db.contact.update({
      where: { id: existing.id },
      data: {
        name: name || existing.name,
        phone: phone || existing.phone,
        type: existing.type === "customer" ? "customer" : "lead",
        marketingOptIn: optIn ? true : existing.marketingOptIn,
        ...(sessionId ? { sessionId } : {}),
      },
    });
    contactId = updated.id;
  } else {
    const created = await db.contact.create({
      data: {
        shopId,
        sessionId: sessionId || null,
        email,
        name,
        phone,
        type: "lead",
        channel: "store",
        marketingOptIn: optIn,
      },
    });
    contactId = created.id;
    await recordEvent(shopId, "contact_converted", {
      contactId,
      from: "anonymous",
      to: "lead",
      source: "campaign",
      campaignId,
    });
  }

  await recordEvent(shopId, "campaign_lead", { campaignId, doubleOptIn: message.lead.doubleOptIn });
  // A completed lead form is the campaign's conversion — count it as a click
  // so CTR reflects the funnel the merchant configured.
  await recordCampaignMetric(shopId, campaignId, "click");

  return Response.json(
    { ok: true, message: message.lead.successMessage, discountCode: message.discountCode },
    { headers: { "Cache-Control": "no-store" } },
  );
};
