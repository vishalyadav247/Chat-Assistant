import { z } from "zod";

// Zod schemas + defaults for the JSON-blob settings rows (specs 06/08/16).
// `.default()`/`.catch()` everywhere so `schema.parse({})` yields a complete,
// render-ready config — the widget (05) renders from defaults before the
// chatbox admin (06) has ever saved.

const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .catch("#6d3bf5");

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
        .object({ start: hexColor, end: hexColor.catch("#3b82f6") })
        .catch({ start: "#6d3bf5", end: "#3b82f6" }),
      launcher: z
        .object({
          style: z.enum(["icon", "label", "icon_label"]).catch("icon"),
          label: z.string().max(40).catch("Chat with us"),
          icon: z.enum(["chat", "help", "custom"]).catch("chat"),
          customIconUrl: z.string().max(500).nullable().catch(null),
          position: z.enum(["bottom_right", "bottom_left", "top_right", "top_left"]).catch("bottom_right"),
          /** Launcher button background — "" inherits the brand colors. */
          bgColor: z
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
        .catch({ style: "icon", label: "Chat with us", icon: "chat", customIconUrl: null, position: "bottom_right", bgColor: "", labelColor: "" }),
      removeBranding: z.boolean().catch(false),
    })
    .catch({
      colorMode: "gradient",
      solid: "#6d3bf5",
      gradient: { start: "#6d3bf5", end: "#3b82f6" },
      launcher: { style: "icon", label: "Chat with us", icon: "chat", customIconUrl: null, position: "bottom_right", bgColor: "", labelColor: "" },
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

export const teamMemberSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(200),
  role: z.enum(["admin", "agent"]).catch("agent"),
  /** ISO date the member was added. */
  since: z.string().max(30).catch(""),
});
export type TeamMemberData = z.infer<typeof teamMemberSchema>;

export const shopSettingsSchema = z.object({
  storeInfo: z.object({ name: z.string().max(100).catch(""), logoUrl: z.string().max(500).nullable().catch(null) }).catch({ name: "", logoUrl: null }),
  theme: z.enum(["auto", "dawn", "refresh", "craft", "custom"]).catch("auto"),
  inbox: z
    .object({ autoResolve: z.boolean().catch(true), after: z.number().int().min(1).catch(60), unit: z.enum(["minute", "hour", "day"]).catch("minute") })
    .catch({ autoResolve: true, after: 60, unit: "minute" }),
  availability: availabilitySchema.catch(availabilitySchema.parse({})),
  survey: surveySchema.catch(surveySchema.parse({})),
  orderTracking: z
    .object({ mode: z.enum(["default", "custom"]).catch("default"), customUrl: z.string().max(500).catch("") })
    .catch({ mode: "default", customUrl: "" }),
  cartDrawer: z.boolean().catch(true),
  retentionDays: z.union([z.literal(0), z.literal(7), z.literal(30), z.literal(60), z.literal(90)]).catch(0), // 0 = forever
  /** Real-time discount webhook sync (spec 02, Pro+ plan gate applies on top). */
  discountRealtime: z.boolean().catch(true),
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
  /** Team roster (spec 16 team v1): powers inbox assignment + member table.
   *  Login access itself is managed by Shopify staff accounts — the roster is
   *  ChatConvert's assignment/display layer. */
  team: z
    .object({ members: z.array(teamMemberSchema).max(50).catch([]) })
    .catch({ members: [] }),
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
      cannotAnswer: z.object({ enabled: z.boolean().catch(true), threshold: z.number().int().min(1).max(10).catch(2) }).catch({ enabled: true, threshold: 2 }),
      repeatedQuestion: z.object({ enabled: z.boolean().catch(true), threshold: z.number().int().min(2).max(10).catch(2) }).catch({ enabled: true, threshold: 2 }),
      negativeSentiment: z.object({ enabled: z.boolean().catch(false) }).catch({ enabled: false }),
    })
    .catch({ cannotAnswer: { enabled: true, threshold: 2 }, repeatedQuestion: { enabled: true, threshold: 2 }, negativeSentiment: { enabled: false } }),
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
      aiWhileWaiting: z.enum(["never", "outside_hours", "always"]).catch("outside_hours"),
    })
    .catch({
      onlineAskMessage: "Would you like me to connect you with our team?",
      afterHandoverMessage: "You're connected — a team member will reply here shortly.",
      offlineMode: "leave_message",
      leaveMessage: { replyTime: "24h", collect: collectFields.parse({}), formMessage: "Leave your details and we'll get back to you.", postSubmitMessage: "Thanks — our team will follow up soon." },
      aiWhileWaiting: "outside_hours",
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

export const campaignSettingsSchema = z.object({
  trigger: z
    .object({
      pageTypes: z.array(z.enum(["home", "product", "collection", "search", "cart", "any"])).catch(["any"]),
      urlContains: z.string().max(300).catch(""),
      delaySeconds: z.number().int().min(0).max(300).catch(3),
      exitIntent: z.boolean().catch(false),
      cartMinItems: z.number().int().min(0).catch(0),
      cartMinValue: z.number().min(0).catch(0),
    })
    .catch({ pageTypes: ["any"], urlContains: "", delaySeconds: 3, exitIntent: false, cartMinItems: 0, cartMinValue: 0 }),
  message: z.string().max(500).catch(""),
  ctaLabel: z.string().max(60).catch(""),
  ctaAction: z.enum(["open_chat", "apply_code", "link"]).catch("open_chat"),
  // Only relative paths or http(s) — a javascript:/data: CTA would execute in
  // storefront visitors' browsers (review M3).
  ctaUrl: z
    .string()
    .max(500)
    .refine((v) => v === "" || v.startsWith("/") || /^https?:\/\//i.test(v))
    .catch(""),
  discountCode: z.string().max(60).catch(""),
  productIds: z.array(z.string()).catch([]),
  collectionIds: z.array(z.string()).catch([]),
});

export type CampaignSettingsData = z.infer<typeof campaignSettingsSchema>;
export const defaultCampaignSettings = (): CampaignSettingsData => campaignSettingsSchema.parse({});
