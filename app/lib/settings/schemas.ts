import { z } from "zod";
import { DATE_FORMATS, DEFAULT_DATE_FORMAT, DEFAULT_TIME_FORMAT, TIME_FORMATS } from "../format/datetime";

// Zod schemas + defaults for the JSON-blob settings rows (specs 06/08/16).
// `.default()`/`.catch()` everywhere so `schema.parse({})` yields a complete,
// render-ready config — the widget (05) renders from defaults before the
// chatbox admin (06) has ever saved.

const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .catch("#6d3bf5");

/** ZodError → one friendly line ("messages.online: Online status message must be…").
 *  Raw ZodError JSON must never reach a merchant-facing banner. */
export function zodMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Invalid settings payload";
  const path = issue.path.filter((p) => typeof p === "string").join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

// ── Widget settings (spec 06) ───────────────────────────────────────────────

export const contactMethodSchema = z.object({
  type: z.enum(["whatsapp", "phone", "email"]),
  value: z.string().max(200).default(""),
  countryCode: z.string().max(8).optional(),
  order: z.number().int().default(0),
});

export const starterSchema = z.object({
  id: z.string().max(64).default(""),
  emoji: z.string().max(8).default("💬"),
  question: z.string().max(100).default(""),
  answerHtml: z.string().max(5000).default(""),
  order: z.number().int().default(0),
});

export const widgetSettingsSchema = z.object({
  active: z.boolean().catch(true),
  chatFocusMode: z.boolean().catch(false),
  header: z
    .object({
      logoUrl: z.string().max(500).nullable().catch(null),
      name: z.string().max(60).catch(""), // "" → "ChatConvert"
      description: z.string().max(120).catch("How can we help you?"),
    })
    .catch({ logoUrl: null, name: "", description: "How can we help you?" }),
  chatStatus: z.boolean().catch(true),
  liveChat: z.boolean().catch(true),
  contactMethods: z
    .object({ enabled: z.boolean().catch(false), items: z.array(contactMethodSchema).catch([]) })
    .catch({ enabled: false, items: [] }),
  orderTracking: z.boolean().catch(true),
  faqs: z.boolean().catch(true),
  welcomeMessage: z.string().max(500).catch("Hi {{customer_name}} 👋 What can I help you find today?"),
  offlineMessageEnabled: z.boolean().catch(false),
  offlineMessage: z.string().max(500).catch(""),
  starters: z
    .object({ enabled: z.boolean().catch(true), items: z.array(starterSchema).catch([]) })
    .catch({ enabled: true, items: [] }),
  avatarMode: z.enum(["store_branding", "team_member"]).catch("store_branding"),
  prechat: z
    .object({
      mode: z.enum(["guest", "anonymous", "both"]).catch("both"),
      showAfterMessages: z.number().int().min(0).max(20).catch(1),
      description: z.string().max(300).catch(""),
      fields: z
        .array(z.object({ key: z.enum(["email", "name", "phone"]), required: z.boolean() }))
        .catch([{ key: "email", required: true }]),
      marketingOptIn: z.boolean().catch(false),
      disclaimer: z
        .object({ enabled: z.boolean().catch(false), html: z.string().max(2000).catch("By sending us a message, you agree to our privacy policy.") })
        .catch({ enabled: false, html: "By sending us a message, you agree to our privacy policy." }),
    })
    .catch({
      mode: "both",
      showAfterMessages: 1,
      description: "",
      fields: [{ key: "email", required: true }],
      marketingOptIn: false,
      disclaimer: { enabled: false, html: "By sending us a message, you agree to our privacy policy." },
    }),
  survey: z.boolean().catch(false),
  appearance: z
    .object({
      colorMode: z.enum(["solid", "gradient"]).catch("gradient"),
      solid: hexColor,
      gradient: z
        .object({
          start: hexColor,
          end: z
            .string()
            .regex(/^#[0-9a-fA-F]{6}$/)
            .catch("#3b82f6"),
        })
        .catch({ start: "#6d3bf5", end: "#3b82f6" }),
      launcher: z
        .object({
          style: z.enum(["icon", "label", "icon_label"]).catch("icon"),
          label: z.string().max(40).catch("Chat with us"),
          icon: z.enum(["chat", "help", "custom"]).catch("chat"),
          customIconUrl: z.string().max(500).nullable().catch(null),
          position: z.enum(["bottom_right", "bottom_left", "top_right", "top_left"]).catch("bottom_right"),
          /** Effective launcher button background — "" inherits the brand colors. */
          bgColor: z
            .string()
            .regex(/^#[0-9a-fA-F]{6}$/)
            .or(z.literal(""))
            .catch(""),
          /** The merchant's last custom pick, remembered while "Use brand color"
           *  is on so re-disabling the toggle restores it (2026-08-17). */
          customBgColor: z
            .string()
            .regex(/^#[0-9a-fA-F]{6}$/)
            .or(z.literal(""))
            .catch(""),
          /** Launcher label text color — "" uses the default white. */
          labelColor: z
            .string()
            .regex(/^#[0-9a-fA-F]{6}$/)
            .or(z.literal(""))
            .catch(""),
        })
        // Pre-2026-08-17 rows: a custom bgColor without the remembered pick.
        .transform((l) => ({ ...l, customBgColor: l.customBgColor || l.bgColor }))
        .catch({ style: "icon", label: "Chat with us", icon: "chat", customIconUrl: null, position: "bottom_right", bgColor: "", customBgColor: "", labelColor: "" }),
      removeBranding: z.boolean().catch(false),
    })
    .catch({
      colorMode: "gradient",
      solid: "#6d3bf5",
      gradient: { start: "#6d3bf5", end: "#3b82f6" },
      launcher: { style: "icon", label: "Chat with us", icon: "chat", customIconUrl: null, position: "bottom_right", bgColor: "", customBgColor: "", labelColor: "" },
      removeBranding: false,
    }),
});

export type WidgetSettingsData = z.infer<typeof widgetSettingsSchema>;
export const defaultWidgetSettings = (): WidgetSettingsData => widgetSettingsSchema.parse({});

// ── Shop settings (spec 16) ─────────────────────────────────────────────────

const timeRange = z.object({ from: z.string().catch("09:00"), to: z.string().catch("17:00") });

export const availabilitySchema = z.object({
  mode: z.enum(["always", "custom"]).catch("always"),
  days: z
    .array(z.object({ day: z.number().int().min(0).max(6), enabled: z.boolean(), from: z.string(), to: z.string() }))
    .catch([1, 2, 3, 4, 5].map((day) => ({ day, enabled: true, from: "09:00", to: "17:00" }))),
  onlineStatusMode: z.enum(["working_hours", "working_hours_or_agent", "agent_during_hours"]).catch("working_hours"),
  breaks: z.object({ enabled: z.boolean().catch(false), ranges: z.array(timeRange).catch([]) }).catch({ enabled: false, ranges: [] }),
  holidays: z
    .object({
      enabled: z.boolean().catch(false),
      items: z.array(z.object({ name: z.string().max(100), from: z.string(), to: z.string() })).catch([]),
    })
    .catch({ enabled: false, items: [] }),
  messages: z
    .object({
      online: z.string().max(120).catch("We are online"),
      offline: z.string().max(120).catch("We're away · Back {{schedule}}"),
      break: z.string().max(120).catch("On break · Back at {{schedule}}"),
      holiday: z.string().max(120).catch("Off today · Back at {{schedule}}"),
    })
    .catch({ online: "We are online", offline: "We're away · Back {{schedule}}", break: "On break · Back at {{schedule}}", holiday: "Off today · Back at {{schedule}}" }),
});

export const surveySchema = z.object({
  format: z.enum(["stars", "emoji"]).catch("stars"),
  intro: z.string().max(200).catch("How was your experience?"),
  thanks: z.string().max(200).catch("Thank you for your feedback!"),
  triggerOnResolve: z.boolean().catch(false),
  triggerKeywords: z.object({ enabled: z.boolean().catch(true), keywords: z.array(z.string().max(50)).catch(["Thank you", "Thanks", "Got it", "That helps", "Perfect"]) }).catch({ enabled: true, keywords: ["Thank you", "Thanks", "Got it", "That helps", "Perfect"] }),
});

export const shopSettingsSchema = z.object({
  storeInfo: z
    .object({
      name: z.string().max(100).catch(""),
      logoUrl: z.string().max(500).nullable().catch(null),
      /** Global date/time display format (Settings → General; spec 16
       *  delta 2026-08-19). Every admin/web date goes through
       *  app/lib/format/datetime.ts with these + Shop.timezone. */
      dateFormat: z.enum(DATE_FORMATS).catch(DEFAULT_DATE_FORMAT),
      timeFormat: z.enum(TIME_FORMATS).catch(DEFAULT_TIME_FORMAT),
    })
    .catch({ name: "", logoUrl: null, dateFormat: DEFAULT_DATE_FORMAT, timeFormat: DEFAULT_TIME_FORMAT }),
  theme: z.enum(["auto", "dawn", "refresh", "craft", "custom"]).catch("auto"),
  inbox: z
    .object({ autoResolve: z.boolean().catch(true), after: z.number().int().min(1).catch(60), unit: z.enum(["minute", "hour", "day"]).catch("minute") })
    .catch({ autoResolve: true, after: 60, unit: "minute" }),
  availability: availabilitySchema.catch(availabilitySchema.parse({})),
  survey: surveySchema.catch(surveySchema.parse({})),
  orderTracking: z
    .object({
      mode: z.enum(["default", "custom", "integration"]).catch("default"),
      customUrl: z.string().max(500).catch(""),
      /** Tracking-app integration (spec 16 delta): provider API key is
       *  SERVER-ONLY — widget config strips it (config.server.ts). */
      provider: z.enum(["17track"]).catch("17track"),
      apiKey: z.string().max(200).catch(""),
    })
    .catch({ mode: "default", customUrl: "", provider: "17track", apiKey: "" }),
  cartDrawer: z.boolean().catch(true),
  retentionDays: z.union([z.literal(0), z.literal(7), z.literal(30), z.literal(60), z.literal(90)]).catch(0), // 0 = forever
  /** Real-time discount webhook sync (spec 02, Pro+ plan gate applies on top). */
  discountRealtime: z.boolean().catch(true),
  /** Catalog auto sync (Products / Collections tabs, 2026-08-17): the DAILY
   *  full re-sync only — Shopify webhooks always apply immediately and manual
   *  "Sync now" always works. Plan-gated (`catalog_auto_sync`, Pro+) on top. */
  catalogAutoSync: z
    .object({ products: z.boolean().catch(true), collections: z.boolean().catch(true) })
    .catch({ products: true, collections: true }),
  /** AI recommendation rules (spec 08 Rules card). excludeOutOfStock OFF lets
   *  unavailable products appear in recommendation cards. */
  recommendationRules: z
    .object({ excludeOutOfStock: z.boolean().catch(true) })
    .catch({ excludeOutOfStock: true }),
  /** Master training permissions (spec 07 Learn cards, user decision
   *  2026-08-12): independent of per-row learnEnabled. Master OFF ⇒ the AI
   *  must not use that data type at all; per-row flags apply only when the
   *  master is ON. */
  learn: z
    .object({
      products: z.boolean().catch(true),
      collections: z.boolean().catch(true),
      discounts: z.boolean().catch(true),
    })
    .catch({ products: true, collections: true, discounts: true }),
  // Team roster moved to the TeamMember table (spec 18) — any leftover
  // `team` key in stored JSON is stripped on the next save.
});

export type ShopSettingsData = z.infer<typeof shopSettingsSchema>;
export type AvailabilityData = z.infer<typeof availabilitySchema>;
export const defaultShopSettings = (): ShopSettingsData => shopSettingsSchema.parse({});

// ── Handover config (spec 08) ───────────────────────────────────────────────

const collectFields = z
  .object({
    email: z.literal(true).catch(true),
    issue: z.literal(true).catch(true),
    orderNumber: z.boolean().catch(false),
    phone: z.boolean().catch(false),
    photoUpload: z.boolean().catch(false),
  })
  .catch({ email: true, issue: true, orderNumber: false, phone: false, photoUpload: false });

const replyTime = z.enum(["24h", "12h", "48h", "same_day"]).catch("24h");

export const handoverConfigSchema = z.object({
  triggers: z
    .object({
      cannotAnswer: z.object({ enabled: z.boolean().catch(true), threshold: z.number().int().min(1).max(10).catch(3) }).catch({ enabled: true, threshold: 3 }),
      repeatedQuestion: z.object({ enabled: z.boolean().catch(true), threshold: z.number().int().min(2).max(10).catch(3) }).catch({ enabled: true, threshold: 3 }),
      negativeSentiment: z.object({ enabled: z.boolean().catch(false) }).catch({ enabled: false }),
    })
    .catch({ cannotAnswer: { enabled: true, threshold: 3 }, repeatedQuestion: { enabled: true, threshold: 3 }, negativeSentiment: { enabled: false } }),
  intentRules: z.array(z.object({ topic: z.string().max(150) })).max(20).catch([]),
  destination: z.enum(["inbox", "collect_email", "contact_methods"]).catch("inbox"),
  inbox: z
    .object({
      onlineAskMessage: z.string().max(300).catch("Would you like me to connect you with our team?"),
      afterHandoverMessage: z.string().max(300).catch("You're connected — a team member will reply here shortly."),
      offlineMode: z.enum(["leave_message", "contact_methods"]).catch("leave_message"),
      leaveMessage: z
        .object({
          replyTime,
          collect: collectFields,
          formMessage: z.string().max(300).catch("Leave your details and we'll get back to you."),
          postSubmitMessage: z.string().max(300).catch("Thanks — our team will follow up soon."),
        })
        .catch({ replyTime: "24h", collect: collectFields.parse({}), formMessage: "Leave your details and we'll get back to you.", postSubmitMessage: "Thanks — our team will follow up soon." }),
      aiWhileWaiting: z.enum(["never", "outside_hours", "always"]).catch("always"),
    })
    .catch({
      onlineAskMessage: "Would you like me to connect you with our team?",
      afterHandoverMessage: "You're connected — a team member will reply here shortly.",
      offlineMode: "leave_message",
      leaveMessage: { replyTime: "24h", collect: collectFields.parse({}), formMessage: "Leave your details and we'll get back to you.", postSubmitMessage: "Thanks — our team will follow up soon." },
      aiWhileWaiting: "always",
    }),
  collectEmail: z
    .object({
      replyTime,
      collect: collectFields,
      formMessage: z.string().max(300).catch("Leave your details and we'll get back to you."),
      postSubmitMessage: z.string().max(300).catch("Thanks — our team will follow up soon."),
    })
    .catch({ replyTime: "24h", collect: collectFields.parse({}), formMessage: "Leave your details and we'll get back to you.", postSubmitMessage: "Thanks — our team will follow up soon." }),
  contactMethods: z
    .object({ message: z.string().max(300).catch("Sorry we couldn't resolve this in chat — reach us directly:") })
    .catch({ message: "Sorry we couldn't resolve this in chat — reach us directly:" }),
});

export type HandoverConfigData = z.infer<typeof handoverConfigSchema>;
export const defaultHandoverConfig = (): HandoverConfigData => handoverConfigSchema.parse({});

// ── Campaign settings (spec 12) ─────────────────────────────────────────────
// Shape mirrors the proactive-chat editor 1:1 (design reference:
// .claude/resources/proactive_chat/*.png): Trigger / Conditions / Message /
// Appearance. Every field `.catch()`es so campaigns saved under the old flat
// shape (pageTypes/message/ctaLabel) still parse — legacy blobs are lifted by
// migrateCampaignSettings() below before parsing.

/** Where a campaign is allowed to fire. One enum covers every template's
 *  "Page to show" control; templates that don't offer a choice pin one value. */
export const CAMPAIGN_PAGE_SCOPES = [
  "all_pages",
  "specific_pages",
  "all_product_pages",
  "specific_product_pages",
  "all_collection_pages",
  "specific_collection_pages",
  "home",
  "search",
  "cart",
] as const;

export const campaignTriggerSchema = z.object({
  pageScope: z.enum(CAMPAIGN_PAGE_SCOPES).catch("all_pages"),
  /** "Specific pages" → URL substring match. */
  urlContains: z.string().max(300).catch(""),
  /** "Specific product/collection pages" → Shopify GIDs picked in the editor. */
  pageProductIds: z.array(z.string().max(120)).catch([]),
  pageCollectionIds: z.array(z.string().max(120)).catch([]),
  /** "Send message after": dwell time vs scroll depth. */
  sendAfter: z.enum(["time", "scroll"]).catch("time"),
  delaySeconds: z.number().int().min(0).max(600).catch(5),
  scrollPercent: z.number().int().min(1).max(100).catch(50),
  /** Cart-value window (cart templates). 0 = no floor; null = no ceiling. */
  cartMinValue: z.number().min(0).catch(0),
  cartMaxValue: z.number().min(0).nullable().catch(null),
  cartMinItems: z.number().int().min(0).catch(0),
  /** Abandoned-cart: fire when the pointer leaves toward the browser chrome. */
  exitIntent: z.boolean().catch(false),
});

export const campaignConditionsSchema = z.object({
  audience: z.enum(["all", "visitors", "customers"]).catch("all"),
  /** "During business hour" resolves against the widget availability status. */
  displayTime: z.enum(["all", "business_hours"]).catch("all"),
  device: z.enum(["all", "desktop", "mobile"]).catch("all"),
  displayDuration: z.enum(["always", "custom"]).catch("always"),
  /** YYYY-MM-DD, inclusive, shop time zone. Only read when duration=custom. */
  startDate: z.string().max(10).catch(""),
  endDate: z.string().max(10).catch(""),
  countryMode: z.enum(["all", "selected"]).catch("all"),
  /** ISO-3166 alpha-2, uppercase. */
  countries: z.array(z.string().max(2)).catch([]),
});

/** Lead-capture block (Subscribe newsletter → Collect lead). */
export const campaignLeadSchema = z.object({
  introduction: z
    .string()
    .max(300)
    .catch("Subscribe to get hot deals, exclusive updates and rewards."),
  /** Email is always collected — the editor renders that checkbox fixed on. */
  askName: z.boolean().catch(false),
  askPhone: z.boolean().catch(false),
  doubleOptIn: z.boolean().catch(false),
  successMessage: z
    .string()
    .max(400)
    .catch(
      "Thank you for subscribing! Check your inbox and stay tuned for the latest news and exclusive offers.",
    ),
});

export const CAMPAIGN_MESSAGE_KINDS = [
  "text",
  "product_recommendation",
  "discount",
  "product_quiz",
  "floater",
] as const;

export const CAMPAIGN_RECOMMENDATION_SOURCES = [
  "best_sellers",
  "new_arrivals",
  "similar",
  "complementary",
  "custom",
] as const;

export const campaignMessageSchema = z.object({
  kind: z.enum(CAMPAIGN_MESSAGE_KINDS).catch("text"),

  // ── text ──
  /** "Quick question" reuses the chatbox's conversation starters as chips;
   *  "Custom message" renders bodyHtml. */
  contentMode: z.enum(["quick_question", "custom"]).catch("custom"),
  /** Rich text — sanitized server-side on save, like FAQ answers. */
  bodyHtml: z.string().max(4000).catch(""),

  // ── product recommendation ──
  recommendation: z.enum(CAMPAIGN_RECOMMENDATION_SOURCES).catch("best_sellers"),
  productIds: z.array(z.string().max(120)).catch([]),
  collectionIds: z.array(z.string().max(120)).catch([]),
  /** Card buttons. Secondary is omitted from the bubble when blank. */
  primaryButtonText: z.string().max(30).catch("Ask about it"),
  secondaryButtonText: z.string().max(30).catch("View product"),

  // ── discount / newsletter ──
  triggerButtonText: z.string().max(60).catch("Yes, sure!"),
  discountCode: z.string().max(60).catch(""),
  usageInstruction: z.string().max(300).catch(""),
  collectLead: z.boolean().catch(false),
  lead: campaignLeadSchema.catch(campaignLeadSchema.parse({})),

  // ── smart product page floater ──
  floaterMessage: z.string().max(100).catch("Not sure which {{ option }}?"),
  subtitle: z.string().max(120).catch("I can help you find the right fit"),
  ctaText: z.string().max(30).catch("Ask about it"),
});

/** Bubble colors. Defaults = the design's white bubble / near-black ink.
 *  NOT the shared `hexColor` — that one already carries `.catch("#6d3bf5")`,
 *  and a second `.catch()` on top would never fire (the inner one absorbs
 *  every failure), silently painting every bubble brand-purple. */
const campaignHex = (fallback: string) =>
  z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .catch(fallback);

export const campaignAppearanceSchema = z.object({
  background: campaignHex("#ffffff"),
  textColor: campaignHex("#1a1a1f"),
  buttonBackground: campaignHex("#1a1a1f"),
  buttonLabelColor: campaignHex("#ffffff"),
});

export const campaignSettingsSchema = z.object({
  trigger: campaignTriggerSchema.catch(campaignTriggerSchema.parse({})),
  conditions: campaignConditionsSchema.catch(campaignConditionsSchema.parse({})),
  message: campaignMessageSchema.catch(campaignMessageSchema.parse({})),
  appearance: campaignAppearanceSchema.catch(campaignAppearanceSchema.parse({})),
});

export type CampaignTriggerData = z.infer<typeof campaignTriggerSchema>;
export type CampaignConditionsData = z.infer<typeof campaignConditionsSchema>;
export type CampaignMessageData = z.infer<typeof campaignMessageSchema>;
export type CampaignAppearanceData = z.infer<typeof campaignAppearanceSchema>;
export type CampaignSettingsData = z.infer<typeof campaignSettingsSchema>;
export const defaultCampaignSettings = (): CampaignSettingsData => campaignSettingsSchema.parse({});

/** Legacy blobs (flat `pageTypes`/`message`/`ctaLabel`/`discountCode`) predate
 *  the editor rebuild. Without this they would parse to an all-defaults
 *  campaign and the merchant's copy would silently vanish — lift the fields
 *  that still have a home and let the schema fill the rest. Idempotent: a blob
 *  whose `message` is already an object passes straight through. */
export function migrateCampaignSettings(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const blob = raw as Record<string, unknown>;
  if (typeof blob.message === "object" && blob.message !== null) return raw;

  const legacyTrigger = (blob.trigger ?? {}) as Record<string, unknown>;
  const pageTypes = Array.isArray(legacyTrigger.pageTypes) ? (legacyTrigger.pageTypes as string[]) : [];
  const pageScope = pageTypes.includes("product")
    ? "all_product_pages"
    : pageTypes.includes("collection")
      ? "all_collection_pages"
      : pageTypes.includes("home")
        ? "home"
        : pageTypes.includes("search")
          ? "search"
          : pageTypes.includes("cart")
            ? "cart"
            : "all_pages";

  const text = typeof blob.message === "string" ? blob.message : "";
  const productIds = Array.isArray(blob.productIds) ? (blob.productIds as string[]) : [];
  const ctaLabel = typeof blob.ctaLabel === "string" && blob.ctaLabel ? blob.ctaLabel : "";
  // Legacy messages were plain text — escape before wrapping so a stray "<"
  // isn't reinterpreted as markup by the rich-text editor.
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  return {
    trigger: {
      pageScope,
      urlContains: legacyTrigger.urlContains,
      sendAfter: "time",
      delaySeconds: legacyTrigger.delaySeconds,
      cartMinItems: legacyTrigger.cartMinItems,
      cartMinValue: legacyTrigger.cartMinValue,
      exitIntent: legacyTrigger.exitIntent,
    },
    conditions: {},
    message: {
      kind: blob.discountCode ? "discount" : productIds.length > 0 ? "product_recommendation" : "text",
      contentMode: "custom",
      bodyHtml: escaped ? `<p>${escaped}</p>` : "",
      recommendation: productIds.length > 0 ? "custom" : "best_sellers",
      productIds,
      collectionIds: Array.isArray(blob.collectionIds) ? blob.collectionIds : [],
      primaryButtonText: ctaLabel || "Ask about it",
      triggerButtonText: ctaLabel || "Yes, sure!",
      discountCode: blob.discountCode,
    },
    appearance: {},
  };
}

/** Read helper: migrate-then-parse. Every read path goes through this. */
export function parseCampaignSettings(raw: unknown): CampaignSettingsData {
  return campaignSettingsSchema.parse(migrateCampaignSettings(raw ?? {}));
}
