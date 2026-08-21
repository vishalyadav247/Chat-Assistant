import db from "../../db.server";
import { hasFeature } from "../billing/plans.server";
import { aiAllowed } from "../billing/usage.server";
import { activeCampaignsForWidget, type WidgetCampaign } from "../campaigns/campaigns.server";
import { getShopConfig } from "../config/shop-config.server";
import { sanitizeHtml } from "../sanitize.server";
import {
  availabilityTtlSeconds,
  isAgentOnline,
  needsAgentPresence,
  resolveAvailability,
} from "../settings/availability.server";
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
      /** ttl = seconds this status line stays valid (schedule-boundary aware,
       *  capped at 5 min). The widget refetches once it lapses. */
      availability: { status: string; message: string; ttl: number };
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
      /** Bot/agent identity on message bubbles (Chatbox → Chat avatar, spec 06):
       *  store_branding → Settings → General → Store information: logo (or the
       *  name's initials when no logo) as the avatar + name as the author
       *  caption. null → default chat icon, no caption. */
      avatar: { url: string | null; name: string } | null;
    };

export async function buildWidgetConfig(
  shopId: string,
  shopDomain: string,
): Promise<WidgetConfigPayload> {
  requireShopId(shopId);
  const config = await getShopConfig(shopId);

  // Widget switched off in chatbox settings → storefront renders nothing.
  if (!config.widget.active) return { active: false };

  // Agent presence has to be resolved by the caller — the engine's `false`
  // default makes `agent_during_hours` permanently offline (see
  // availability.server.ts). Skipped entirely for plain `working_hours`.
  const agentOnline = needsAgentPresence(config.settings.availability)
    ? await isAgentOnline(shopId)
    : false;
  const availability = resolveAvailability(config.settings.availability, config.timezone, agentOnline);
  // The route's HTTP cache is a blunt 5 minutes; this ttl is exact to the
  // minute, so the widget stops claiming "We're online" after closing time
  // instead of drifting up to 10 minutes past the boundary.
  const availabilityTtl = availabilityTtlSeconds(
    config.settings.availability,
    config.timezone,
    agentOnline,
  );

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

  // Starter answers and the pre-chat disclaimer also reach the widget through
  // innerHTML. They were sanitized on save only, so any other write path
  // (seed, import, migration, direct DB) bypassed it — sanitize at serve time
  // too, exactly like featuredFaqs below (QA D16).
  const safeWidget = {
    ...config.widget,
    starters: {
      ...config.widget.starters,
      items: (config.widget.starters?.items ?? []).map((item) => ({
        ...item,
        answerHtml: item.answerHtml ? sanitizeHtml(item.answerHtml) : item.answerHtml,
      })),
    },
    prechat: {
      ...config.widget.prechat,
      disclaimer: {
        ...config.widget.prechat.disclaimer,
        html: config.widget.prechat.disclaimer?.html
          ? sanitizeHtml(config.widget.prechat.disclaimer.html)
          : config.widget.prechat.disclaimer?.html,
      },
    },
  };

  return {
    active: true,
    widget: safeWidget,
    availability: {
      status: availability.status,
      message: availability.message,
      ttl: availabilityTtl,
    },
    // Chatbox → General is canonical (spec 06) so the live preview matches the
    // storefront; the persona's legacy message is only a fallback when the
    // widget message is blank.
    welcomeMessage:
      config.widget.welcomeMessage.trim() || config.persona?.welcomeMessage?.trim() || "",
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
    avatar:
      config.widget.avatarMode === "store_branding"
        ? {
            url: config.settings.storeInfo.logoUrl || null,
            name: config.settings.storeInfo.name.trim() || config.shopName || shopDomain.replace(".myshopify.com", ""),
          }
        : null,
  };
}
