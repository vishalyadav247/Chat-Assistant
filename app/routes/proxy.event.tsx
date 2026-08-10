import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";
import { authenticate } from "../shopify.server";
import { recordEvent, type AnalyticsEventType } from "../lib/analytics/events.server";
import { recordCampaignMetric, type CampaignMetric } from "../lib/campaigns/campaigns.server";
import { resolveShopId } from "../lib/tenancy.server";

// Storefront analytics beacon (spec 05 delta): allow-listed widget events only.
// Shop identity from the proxy signature; payloads size-bounded.

const ALLOWED_EVENTS = new Set<AnalyticsEventType>([
  "widget_opened",
  "product_card_clicked",
  "added_to_cart",
  "campaign_view",
  "campaign_click",
  "campaign_atc",
]);

const bodySchema = z.object({
  type: z.string().max(40),
  payload: z.record(z.string(), z.union([z.string().max(200), z.number(), z.boolean()])).optional(),
});

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return new Response("not found", { status: 404 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !ALLOWED_EVENTS.has(parsed.data.type as AnalyticsEventType)) {
    return new Response("bad request", { status: 400 });
  }

  const shopId = await resolveShopId(session.shop);
  await recordEvent(shopId, parsed.data.type as AnalyticsEventType, parsed.data.payload);

  // Campaign beacons also increment the Campaign row counters (spec 12).
  const campaignMetric = CAMPAIGN_METRICS[parsed.data.type];
  const campaignId = parsed.data.payload?.campaignId;
  if (campaignMetric && typeof campaignId === "string") {
    const revenue = parsed.data.payload?.revenue;
    await recordCampaignMetric(
      shopId,
      campaignId,
      campaignMetric,
      typeof revenue === "number" ? revenue : undefined,
    );
  }
  return Response.json({ ok: true });
};

const CAMPAIGN_METRICS: Record<string, CampaignMetric> = {
  campaign_view: "view",
  campaign_click: "click",
  campaign_atc: "atc",
};
