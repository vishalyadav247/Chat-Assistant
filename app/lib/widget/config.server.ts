import db from "../../db.server";
import { hasFeature } from "../billing/plans.server";
import { aiAllowed } from "../billing/usage.server";
import { activeCampaignsForWidget, type WidgetCampaign } from "../campaigns/campaigns.server";
import { getShopConfig } from "../config/shop-config.server";
import { sanitizeHtml } from "../sanitize.server";
import { resolveAvailability } from "../settings/availability.server";
import type { WidgetSettingsData, ShopSettingsData } from "../settings/schemas";
import { requireShopId } from "../tenancy.server";

// Widget-config payload builder (spec 05). One JSON blob drives the entire
// storefront widget render: settings, availability, FAQs, branding, gating.
// Served by proxy.widget-config with a 5-minute public cache.

export interface WidgetFeaturedFaq {
  id: string;
  question: string;
  answerHtml: string;
  category: string | null;
}

export type WidgetConfigPayload =
  | { active: false }
  | {
      active: true;
      widget: WidgetSettingsData;
      availability: { status: string; message: string };
      welcomeMessage: string;
      currency: string;
      /** true → render "Powered by ChatConvert" footer. */
      showBranding: boolean;
      featuredFaqs: WidgetFeaturedFaq[];
      aiAvailable: boolean;
      shopDomain: string;
      survey: ShopSettingsData["survey"];
      /** apiKey/provider stay server-side — the widget only needs the mode
       *  ("integration" → in-widget lookup via proxy) and the custom URL. */
      orderTracking: {
        mode: ShopSettingsData["orderTracking"]["mode"];
        customUrl: string;
      };
      cartDrawer: boolean;
      /** Active proactive-chat campaigns (spec 12): priority-ordered, premium
       *  templates already filtered server-side by plan. */
      campaigns: WidgetCampaign[];
    };

export async function buildWidgetConfig(
  shopId: string,
  shopDomain: string,
): Promise<WidgetConfigPayload> {
  requireShopId(shopId);
  const config = await getShopConfig(shopId);

  // Widget switched off in chatbox settings → storefront renders nothing.
  if (!config.widget.active) return { active: false };

  const availability = resolveAvailability(config.settings.availability, config.timezone);

  // Branding gate (spec 15): only plans with "remove_branding" may hide the
  // footer. Without the feature the footer always shows, whatever is saved.
  const showBranding = hasFeature(config.plan, "remove_branding")
    ? !config.widget.appearance.removeBranding
    : true;

  const [faqs, categories, allowed, campaigns] = await Promise.all([
    db.faq.findMany({
      where: { shopId, status: "published", featured: true },
      orderBy: { position: "asc" },
      take: 8,
      select: { id: true, question: true, answerHtml: true, categoryId: true },
    }),
    db.faqCategory.findMany({
      where: { shopId, status: "published" },
      select: { id: true, name: true },
    }),
    aiAllowed(shopId),
    activeCampaignsForWidget(shopId, config.plan),
  ]);
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));

  return {
    active: true,
    widget: config.widget,
    availability: { status: availability.status, message: availability.message },
    welcomeMessage: config.persona?.welcomeMessage?.trim() || config.widget.welcomeMessage,
    currency: config.currency,
    showBranding,
    // Defense in depth: sanitize merchant HTML at serve time (widget injects
    // via innerHTML); write paths (07/09) sanitize on save as well.
    featuredFaqs: faqs.map((f) => ({
      id: f.id,
      question: f.question,
      answerHtml: sanitizeHtml(f.answerHtml),
      category: (f.categoryId && categoryName.get(f.categoryId)) || null,
    })),
    aiAvailable: config.aiEnabled && allowed,
    shopDomain,
    survey: config.settings.survey,
    orderTracking: {
      mode: config.settings.orderTracking.mode,
      customUrl: config.settings.orderTracking.customUrl,
    },
    cartDrawer: config.settings.cartDrawer,
    campaigns,
  };
}
