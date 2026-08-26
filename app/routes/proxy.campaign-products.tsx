import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  anchorProductDetail,
  contextualRecommendationCards,
  isContextualRecommendation,
} from "../lib/campaigns/campaigns.server";
import { parseCampaignSettings } from "../lib/settings/schemas";
import { resolveShopId } from "../lib/tenancy.server";

// GET /apps/ccwidget/campaign-products?campaign=<id>&product=<gid> (spec 12).
//
// The widget-config payload is cached for 5 minutes and shared by every
// shopper, so it can only carry PAGE-INDEPENDENT product cards. The two
// contextual recommendation sources ("similar", "complementary") and the Smart
// Product Page floater need the product the shopper is actually looking at —
// that resolution happens here, per page view, uncached.
//
// Shop identity comes ONLY from the verified app-proxy signature; the campaign
// id is re-read shop-scoped so a guessed id from another store returns 404.

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return new Response("app not installed", { status: 404 });

  const url = new URL(request.url);
  const campaignId = (url.searchParams.get("campaign") ?? "").slice(0, 64);
  const productId = (url.searchParams.get("product") ?? "").slice(0, 120);
  if (!campaignId || !productId) return Response.json({ products: [], anchor: null });

  const shopId = await resolveShopId(session.shop);
  const campaign = await db.campaign.findFirst({
    where: { id: campaignId, shopId, status: "active" },
    select: { settings: true },
  });
  if (!campaign) return new Response("not found", { status: 404 });

  const message = parseCampaignSettings(campaign.settings).message;

  // The floater needs the anchor product's variant options for its chips; the
  // contextual recommendation sources need sibling cards. Nothing else here
  // has a reason to hit this endpoint.
  const wantsAnchor = message.kind === "floater";
  const wantsCards = message.kind === "product_recommendation" && isContextualRecommendation(message.recommendation);
  if (!wantsAnchor && !wantsCards) return Response.json({ products: [], anchor: null });

  const [anchor, products] = await Promise.all([
    wantsAnchor ? anchorProductDetail(shopId, productId) : Promise.resolve(null),
    wantsCards
      ? contextualRecommendationCards(shopId, message.recommendation, productId)
      : Promise.resolve([]),
  ]);

  return Response.json(
    { anchor, products },
    // Per-product and per-campaign, so a short shared cache is safe and keeps
    // repeat views off the database.
    { headers: { "Cache-Control": "public, max-age=120" } },
  );
};
