import type { CampaignSettingsData } from "../settings/schemas";

// Proactive-chat template catalog (spec 12, design proactive-chat.html).
// Names / categories / descriptions / CTA labels are VERBATIM from the design.
// Isomorphic: imported by the admin route (picker + editor prefill) and by
// campaigns.server.ts (premium gating, widget filtering).

export type CampaignTemplateType =
  | "welcome"
  | "newsletter"
  | "product_recommendation"
  | "cart_booster"
  | "view_cart"
  | "abandoned_cart"
  | "collection_boost"
  | "remove_items"
  | "search_page"
  | "smart_product_page";

export interface CampaignTemplate {
  type: CampaignTemplateType;
  category: string;
  name: string;
  description: string;
  /** Gated behind hasFeature(plan, "premium_campaign_templates") (Pro+). */
  premium: boolean;
  /** ✦ NEW badge (Smart Product Page). */
  isNew: boolean;
  /** Type icon shown in the campaign table + picker. */
  emoji: string;
  /** Preview gradient colors from the design. */
  colors: [string, string];
  /** Preview bubble line + pill from the design. */
  previewLine: string;
  /** Editor prefill — merged over defaultCampaignSettings(). */
  defaults: CampaignSettingsData & { name: string };
}

const trigger = (t: Partial<CampaignSettingsData["trigger"]>): CampaignSettingsData["trigger"] => ({
  pageTypes: ["any"],
  urlContains: "",
  delaySeconds: 3,
  exitIntent: false,
  cartMinItems: 0,
  cartMinValue: 0,
  ...t,
});

const settings = (
  s: Partial<Omit<CampaignSettingsData, "trigger">> & {
    trigger?: Partial<CampaignSettingsData["trigger"]>;
    name: string;
  },
): CampaignSettingsData & { name: string } => ({
  name: s.name,
  trigger: trigger(s.trigger ?? {}),
  message: s.message ?? "",
  ctaLabel: s.ctaLabel ?? "",
  ctaAction: s.ctaAction ?? "open_chat",
  ctaUrl: s.ctaUrl ?? "",
  discountCode: s.discountCode ?? "",
  productIds: s.productIds ?? [],
  collectionIds: s.collectionIds ?? [],
});

export const CAMPAIGN_TEMPLATES: CampaignTemplate[] = [
  {
    type: "welcome",
    category: "Engage",
    name: "Welcome visitors",
    description: "Greet shoppers with a personalized hello, making their visit feel extra special.",
    premium: false,
    isNew: false,
    emoji: "👋",
    colors: ["#6d3bf5", "#3b82f6"],
    previewLine: "Hi there 👋 How can we help?",
    defaults: settings({
      name: "Welcome visitors",
      trigger: { pageTypes: ["home"], delaySeconds: 3 },
      message: "Hi {{customer_name}} 👋 How can we help you today?",
      ctaLabel: "Say hello",
      ctaAction: "open_chat",
    }),
  },
  {
    type: "newsletter",
    category: "Grow list",
    name: "Subscribe newsletter",
    description: "Capture emails with hot deals, exclusive updates and rewards.",
    premium: false,
    isNew: false,
    emoji: "✉️",
    colors: ["#f59e0b", "#ec4899"],
    previewLine: "Get 10% off — join us",
    defaults: settings({
      name: "Subscribe newsletter",
      trigger: { pageTypes: ["any"], delaySeconds: 8 },
      message: "Get 10% off your first order — join our newsletter!",
      ctaLabel: "Subscribe",
      ctaAction: "open_chat",
    }),
  },
  {
    type: "product_recommendation",
    category: "Upsell",
    name: "Product recommendation",
    description: "Boost sales by recommending hot-deals, cross-sell offers and discounts.",
    premium: false,
    isNew: false,
    emoji: "✨",
    colors: ["#06b6d4", "#3b82f6"],
    previewLine: "You might like this ✨",
    defaults: settings({
      name: "Product recommendation",
      trigger: { pageTypes: ["any"], delaySeconds: 5 },
      message: "You might like these ✨",
      ctaLabel: "View similar",
      ctaAction: "open_chat",
    }),
  },
  {
    type: "cart_booster",
    category: "Convert",
    name: "Cart booster",
    description: "Convince shoppers to buy by offering a small discount in the cart.",
    premium: true,
    isNew: false,
    emoji: "🎁",
    colors: ["#8b5cf6", "#6366f1"],
    previewLine: "Here’s a little nudge 🎁",
    defaults: settings({
      name: "Cart booster",
      trigger: { pageTypes: ["cart"], delaySeconds: 2, cartMinItems: 1 },
      message: "Here’s a little nudge 🎁 Use this code for a discount at checkout.",
      ctaLabel: "Apply code",
      ctaAction: "apply_code",
    }),
  },
  {
    type: "view_cart",
    category: "Convert",
    name: "View cart",
    description: "Reduce drop-off and increase AOV when visitors view the cart page.",
    premium: true,
    isNew: false,
    emoji: "🛒",
    colors: ["#10b981", "#06b6d4"],
    previewLine: "Complete your look 👗",
    defaults: settings({
      name: "View cart",
      trigger: { pageTypes: ["cart"], delaySeconds: 2, cartMinItems: 1 },
      message: "Complete your look 👗 Want a hand finding something that goes with it?",
      ctaLabel: "Add more",
      ctaAction: "open_chat",
    }),
  },
  {
    type: "abandoned_cart",
    category: "Recover",
    name: "Abandoned cart reminder",
    description: "Encourage shoppers to complete their order after leaving items behind.",
    premium: true,
    isNew: false,
    emoji: "⏰",
    colors: ["#f43f5e", "#f59e0b"],
    previewLine: "You left something!",
    defaults: settings({
      name: "Abandoned cart reminder",
      trigger: { pageTypes: ["cart"], delaySeconds: 0, exitIntent: true, cartMinItems: 1 },
      message: "You left something behind! Complete your order before it sells out.",
      ctaLabel: "Complete order",
      ctaAction: "link",
      ctaUrl: "/checkout",
    }),
  },
  {
    type: "collection_boost",
    category: "Upsell",
    name: "Collection boost",
    description: "Boost sales while shoppers are browsing a collection page.",
    premium: true,
    isNew: false,
    emoji: "🗂️",
    colors: ["#ec4899", "#8b5cf6"],
    previewLine: "Browsing? Let me help 🔎",
    defaults: settings({
      name: "Collection boost",
      trigger: { pageTypes: ["collection"], delaySeconds: 3 },
      message: "Browsing? Let me help 🔎 I can pick out the best of this collection.",
      ctaLabel: "Show picks",
      ctaAction: "open_chat",
    }),
  },
  {
    type: "remove_items",
    category: "Reassure",
    name: "Remove items from cart",
    description: "Reassure shoppers when they remove items from their cart.",
    premium: false,
    isNew: false,
    emoji: "🤝",
    colors: ["#0ea5e9", "#6366f1"],
    previewLine: "Changed your mind? 🙂",
    defaults: settings({
      name: "Remove items from cart",
      trigger: { pageTypes: ["cart"], delaySeconds: 2 },
      message: "Changed your mind? 🙂 Happy to answer any questions about it.",
      ctaLabel: "Ask about it",
      ctaAction: "open_chat",
    }),
  },
  {
    type: "search_page",
    category: "Guide",
    name: "Search page",
    description: "Proactively guide users to search via the chatbot for accurate results.",
    premium: false,
    isNew: false,
    emoji: "🔍",
    colors: ["#14b8a6", "#3b82f6"],
    previewLine: "Find the perfect product 😊",
    defaults: settings({
      name: "Search page",
      trigger: { pageTypes: ["search"], delaySeconds: 2 },
      message: "Find the perfect product 😊 Tell me what you’re after and I’ll search for you.",
      ctaLabel: "Search now",
      ctaAction: "open_chat",
    }),
  },
  {
    type: "smart_product_page",
    category: "Assist",
    name: "Smart Product Page",
    description: "Show a contextual floater with variant picker and in-chat Add to Cart.",
    premium: false,
    isNew: true,
    emoji: "📦",
    colors: ["#7c3aed", "#db2777"],
    previewLine: "Not sure which size?",
    defaults: settings({
      name: "Smart Product Page",
      trigger: { pageTypes: ["product"], delaySeconds: 3 },
      message: "Not sure which one to pick? I can add it straight to your cart.",
      ctaLabel: "Add to cart",
      ctaAction: "open_chat",
    }),
  },
];

const byType = new Map(CAMPAIGN_TEMPLATES.map((t) => [t.type as string, t]));

export function campaignTemplate(type: string): CampaignTemplate | undefined {
  return byType.get(type);
}

export function isPremiumTemplate(type: string): boolean {
  return byType.get(type)?.premium ?? false;
}

/** Templates whose trigger editor exposes cart state fields (items/value). */
export function isCartTemplate(type: string): boolean {
  return type === "cart_booster" || type === "view_cart" || type === "abandoned_cart" || type === "remove_items";
}

/** Templates whose editor shows the product picker. */
export function usesProductPicker(type: string): boolean {
  return type === "product_recommendation" || type === "smart_product_page";
}

/** Templates whose editor shows the collection picker. */
export function usesCollectionPicker(type: string): boolean {
  return type === "collection_boost";
}
