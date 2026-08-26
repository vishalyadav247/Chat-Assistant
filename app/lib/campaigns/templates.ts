import {
  campaignSettingsSchema,
  type CampaignMessageData,
  type CampaignSettingsData,
} from "../settings/schemas";

// Proactive-chat template catalog (spec 12).
// Each entry declares BOTH the merchant-facing catalog card (category, name,
// description, preview) and the SHAPE OF THE EDITOR for that template: which
// trigger control to render, which Message tabs are offered, and the prefilled
// defaults. Design reference: .claude/resources/proactive_chat/*.png.
//
// Isomorphic — imported by the admin route (picker, editor, preview) and by
// campaigns.server.ts (premium gating, widget projection). No server imports.

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

/** Which "Page to show" choices the Trigger card offers.
 *  - `fixed`     — no picker; the trigger card just states when it fires.
 *  - `pages`     — All pages / Specific pages / All product / Specific product.
 *  - `product`   — All product pages / Specific product pages.
 *  - `collection`— All collection pages / Specific collection pages. */
export type TriggerScopeMode = "fixed" | "pages" | "product" | "collection";

/** Which "Send message after" control the Trigger card renders.
 *  - `dwell_or_scroll` — the two-radio group (seconds | scroll %).
 *  - `dwell`           — seconds only, no radios.
 *  - `exit_intent`     — no dwell control; fires on exit intent. */
export type TriggerTimingMode = "dwell_or_scroll" | "dwell" | "exit_intent";

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
  /** Preview gradient colors for the picker card. */
  colors: [string, string];
  /** Preview bubble line shown on the picker card. */
  previewLine: string;
  /** Pill under the preview line on the picker card. */
  previewCta: string;

  // ── editor shape ──
  /** One-line statement above the trigger controls ("When visitor opens…"). */
  triggerSummary: string;
  scopeMode: TriggerScopeMode;
  timingMode: TriggerTimingMode;
  /** Cart value floor/ceiling fields (cart templates). */
  showCartValue: boolean;
  /** Message tabs offered, in order. A single entry renders no tab strip. */
  messageKinds: CampaignMessageData["kind"][];
  /** Text tab shows the Quick question / Custom message radios. */
  showContentMode: boolean;

  /** Editor prefill. */
  defaults: CampaignSettingsData & { name: string };
}

// ── defaults helpers ────────────────────────────────────────────────────────

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K] };

const settings = (
  name: string,
  patch: DeepPartial<CampaignSettingsData>,
): CampaignSettingsData & { name: string } => {
  const base = campaignSettingsSchema.parse({});
  return {
    name,
    trigger: { ...base.trigger, ...(patch.trigger ?? {}) },
    conditions: { ...base.conditions, ...(patch.conditions ?? {}) },
    message: { ...base.message, ...(patch.message ?? {}) },
    appearance: { ...base.appearance, ...(patch.appearance ?? {}) },
  };
};

/** Message-tab sets. Product Quiz is Pro+ everywhere it appears. */
const FULL_KINDS: CampaignMessageData["kind"][] = [
  "text",
  "product_recommendation",
  "discount",
  "product_quiz",
];
const NO_QUIZ_KINDS: CampaignMessageData["kind"][] = ["text", "product_recommendation", "discount"];

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
    previewCta: "Say hello",
    triggerSummary: "When visitor open the homepage",
    scopeMode: "fixed",
    timingMode: "dwell_or_scroll",
    showCartValue: false,
    messageKinds: FULL_KINDS,
    showContentMode: true,
    defaults: settings("Welcome visitor", {
      trigger: { pageScope: "home", sendAfter: "time", delaySeconds: 5 },
      message: {
        kind: "text",
        contentMode: "custom",
        bodyHtml: "<p>Hi {{customer_name}} 👋</p><p>How can we help you?</p>",
      },
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
    previewCta: "Yes, sure!",
    triggerSummary: "When visitor spends time on the store",
    scopeMode: "pages",
    timingMode: "dwell_or_scroll",
    showCartValue: false,
    messageKinds: ["discount"],
    showContentMode: false,
    defaults: settings("Subscribe Newsletter", {
      trigger: { pageScope: "all_pages", sendAfter: "time", delaySeconds: 30 },
      message: {
        kind: "discount",
        bodyHtml: "<p>Don't miss out 👋</p><p>Discover the special offer we're tailored for you!</p>",
        triggerButtonText: "Yes, sure!",
        usageInstruction: "This coupon is valid for summer clothing, with all items eligible for a 20% discount.",
        collectLead: true,
      },
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
    previewCta: "Ask about it",
    triggerSummary: "When visitor browses a product page",
    scopeMode: "product",
    timingMode: "dwell_or_scroll",
    showCartValue: false,
    messageKinds: FULL_KINDS,
    showContentMode: false,
    defaults: settings("Product Recommendation", {
      trigger: { pageScope: "all_product_pages", sendAfter: "time", delaySeconds: 8 },
      message: {
        kind: "product_recommendation",
        bodyHtml: "<p>You might like this product!</p>",
        recommendation: "best_sellers",
        primaryButtonText: "Ask about it",
        secondaryButtonText: "View product",
      },
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
    previewLine: "Here's a little nudge 🎁",
    previewCta: "Apply my discount",
    triggerSummary: "When visitor opens the cart with items in it",
    scopeMode: "fixed",
    timingMode: "dwell_or_scroll",
    showCartValue: true,
    messageKinds: ["discount"],
    showContentMode: false,
    defaults: settings("Cart Booster", {
      trigger: {
        pageScope: "cart",
        sendAfter: "time",
        delaySeconds: 4,
        cartMinItems: 1,
      },
      message: {
        kind: "discount",
        bodyHtml: "<p>Here's a little nudge 🎁</p><p>Use this code and finish your order today.</p>",
        triggerButtonText: "Apply my discount",
        usageInstruction: "Applied automatically at checkout on your current cart.",
        collectLead: false,
      },
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
    previewCta: "Ask about it",
    triggerSummary: "When visitor opens the cart page",
    scopeMode: "fixed",
    timingMode: "dwell_or_scroll",
    showCartValue: true,
    messageKinds: NO_QUIZ_KINDS,
    showContentMode: false,
    defaults: settings("View Cart", {
      trigger: { pageScope: "cart", sendAfter: "time", delaySeconds: 5, cartMinItems: 1 },
      message: {
        kind: "product_recommendation",
        bodyHtml: "<p>Complete your look 👗</p><p>These go well with what's in your cart.</p>",
        recommendation: "complementary",
        primaryButtonText: "Ask about it",
        secondaryButtonText: "View product",
      },
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
    previewCta: "Ask about it",
    triggerSummary: "When visitor is about to leave with items still in their cart",
    scopeMode: "fixed",
    timingMode: "exit_intent",
    showCartValue: true,
    messageKinds: ["text", "discount"],
    showContentMode: false,
    defaults: settings("Abandoned Cart Reminder", {
      trigger: { pageScope: "all_pages", exitIntent: true, delaySeconds: 0, cartMinItems: 1 },
      message: {
        kind: "text",
        contentMode: "custom",
        bodyHtml: "<p>You left something behind! ⏰</p><p>Need a hand before it sells out?</p>",
        primaryButtonText: "Ask about it",
      },
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
    previewCta: "Ask about it",
    triggerSummary: "When visitor browses a collection page",
    scopeMode: "collection",
    timingMode: "dwell_or_scroll",
    showCartValue: false,
    messageKinds: NO_QUIZ_KINDS,
    showContentMode: false,
    defaults: settings("Collection Boost", {
      trigger: { pageScope: "all_collection_pages", sendAfter: "time", delaySeconds: 6 },
      message: {
        kind: "product_recommendation",
        bodyHtml: "<p>Browsing? Let me help 🔎</p><p>Here are the picks shoppers love most.</p>",
        recommendation: "best_sellers",
        primaryButtonText: "Ask about it",
        secondaryButtonText: "View product",
      },
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
    previewCta: "Ask about it",
    triggerSummary: "When visitor removes an item from their cart",
    scopeMode: "fixed",
    timingMode: "dwell_or_scroll",
    showCartValue: true,
    messageKinds: NO_QUIZ_KINDS,
    showContentMode: false,
    defaults: settings("Remove items from cart", {
      trigger: { pageScope: "all_pages", sendAfter: "time", delaySeconds: 3, cartMinValue: 0 },
      message: {
        kind: "text",
        contentMode: "custom",
        bodyHtml:
          "<p>Changed your mind? 💭 I'm here if you need help finding something better!</p>",
        primaryButtonText: "Ask about it",
      },
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
    previewCta: "Search now",
    triggerSummary: "When visitor open the search page",
    scopeMode: "fixed",
    timingMode: "dwell_or_scroll",
    showCartValue: false,
    messageKinds: FULL_KINDS,
    showContentMode: true,
    defaults: settings("Search page", {
      trigger: { pageScope: "search", sendAfter: "time", delaySeconds: 5 },
      message: {
        kind: "text",
        contentMode: "custom",
        bodyHtml: "<p>Can I help you find the perfect product? 😊</p>",
      },
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
    previewCta: "Ask about it",
    triggerSummary: "When visitor browses a product page",
    scopeMode: "product",
    timingMode: "dwell",
    showCartValue: false,
    messageKinds: ["floater"],
    showContentMode: false,
    defaults: settings("Smart Product Page", {
      trigger: { pageScope: "all_product_pages", sendAfter: "time", delaySeconds: 6 },
      message: {
        kind: "floater",
        floaterMessage: "Not sure which {{ option }}?",
        subtitle: "I can help you find the right fit",
        ctaText: "Ask about it",
      },
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

/** Message-kind labels for the tab strip + the right-hand summary card. */
export const MESSAGE_KIND_LABELS: Record<CampaignMessageData["kind"], string> = {
  text: "Text",
  product_recommendation: "Product Recommendation",
  discount: "Discount",
  product_quiz: "Product Quiz",
  floater: "Smart Product Page",
};

/** Product Quiz is Pro+ regardless of the template it appears on. */
export function isPremiumMessageKind(kind: CampaignMessageData["kind"]): boolean {
  return kind === "product_quiz";
}

/** "Recommend similar products" is Pro+ (browsing-history driven). */
export function isPremiumRecommendation(source: string): boolean {
  return source === "similar";
}

export const RECOMMENDATION_OPTIONS: {
  value: CampaignSettingsData["message"]["recommendation"];
  label: string;
  help: string;
}[] = [
  {
    value: "best_sellers",
    label: "Recommend best sellers",
    help: "Suggest top-selling items based on order volume",
  },
  {
    value: "new_arrivals",
    label: "Recommend new arrivals",
    help: "Highlight the latest products recently added to your store",
  },
  {
    value: "similar",
    label: "Recommend similar products",
    help: "Suggest items based on browsing history",
  },
  {
    value: "complementary",
    label: "Recommend complementary products",
    help: "Show complementary items from the same collection",
  },
  {
    value: "custom",
    label: "Custom recommendation",
    help: "Manually choose specific products to recommend",
  },
];

/** Templates whose editor shows the product picker for the page scope. */
export function scopeUsesProductPicker(scope: string): boolean {
  return scope === "specific_product_pages";
}

export function scopeUsesCollectionPicker(scope: string): boolean {
  return scope === "specific_collection_pages";
}
