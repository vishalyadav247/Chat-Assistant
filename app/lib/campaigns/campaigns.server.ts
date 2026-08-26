import { z } from "zod";
import db from "../../db.server";
import { getQuota, hasFeature, isUnlimitedQuota, requirePlan, PlanGateError } from "../billing/plans.server";
import {
  CAMPAIGN_MESSAGE_KINDS,
  CAMPAIGN_PAGE_SCOPES,
  CAMPAIGN_RECOMMENDATION_SOURCES,
  campaignSettingsSchema,
  parseCampaignSettings,
  type CampaignSettingsData,
} from "../settings/schemas";
import { sanitizeHtml } from "../sanitize.server";
import { requireShopId } from "../tenancy.server";
import { campaignTemplate, isPremiumTemplate } from "./templates";
import { logError } from "../log.server";

// Proactive-chat campaign CRUD + widget projection + metric counters (spec 12).
// Every function is shop-scoped; premium templates, the Product Quiz message
// type and the "similar products" recommendation source are gated server-side
// both on save (requirePlan) and on widget serve (activeCampaignsForWidget).

export interface CampaignRow {
  id: string;
  name: string;
  templateType: string;
  status: string;
  priority: number;
  settings: CampaignSettingsData;
  views: number;
  clicks: number;
  atcs: number;
  revenue: number;
  orders: number;
  updatedAt: string;
}

function toRow(row: {
  id: string;
  name: string;
  templateType: string;
  status: string;
  priority: number;
  settings: unknown;
  views: number;
  clicks: number;
  atcs: number;
  revenue: unknown;
  orders: number;
  updatedAt: Date;
}): CampaignRow {
  return {
    id: row.id,
    name: row.name,
    templateType: row.templateType,
    status: row.status,
    priority: row.priority,
    settings: parseCampaignSettings(row.settings),
    views: row.views,
    clicks: row.clicks,
    atcs: row.atcs,
    revenue: Number(row.revenue),
    orders: row.orders,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listCampaigns(shopId: string): Promise<CampaignRow[]> {
  requireShopId(shopId);
  const rows = await db.campaign.findMany({
    where: { shopId },
    orderBy: [{ priority: "asc" }, { updatedAt: "desc" }],
  });
  return rows.map(toRow);
}

const savePayloadSchema = z.object({
  id: z.string().max(64).optional(),
  name: z.string().trim().min(1, "Give the campaign a name").max(100, "Name must be 100 characters or fewer"),
  templateType: z.string().max(40),
  status: z.enum(["active", "inactive"]),
  settings: z.unknown().optional(),
});

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// SAVE-path settings schema: STRICT. The frozen campaignSettingsSchema uses
// `.catch()` so stored blobs always parse on READ, but on save that would
// silently rewrite an over-long message to "" under a "Campaign saved" toast.
// Invalid input returns { ok:false, error } instead.
const strictCampaignSettingsSchema = z
  .object({
    trigger: z.object({
      pageScope: z.enum(CAMPAIGN_PAGE_SCOPES),
      urlContains: z.string().max(300, "“URL contains” must be 300 characters or fewer"),
      pageProductIds: z.array(z.string().max(120)).max(50, "Pick at most 50 products"),
      pageCollectionIds: z.array(z.string().max(120)).max(50, "Pick at most 50 collections"),
      sendAfter: z.enum(["time", "scroll"]),
      delaySeconds: z
        .number()
        .int("Delay must be a whole number of seconds")
        .min(0, "Delay can't be negative")
        .max(600, "Delay can be at most 600 seconds"),
      scrollPercent: z
        .number()
        .int("Scroll depth must be a whole percentage")
        .min(1, "Scroll depth must be at least 1%")
        .max(100, "Scroll depth can be at most 100%"),
      cartMinValue: z.number().min(0, "Minimum cart value can't be negative"),
      cartMaxValue: z.number().min(0, "Maximum cart value can't be negative").nullable(),
      cartMinItems: z.number().int("Cart items must be a whole number").min(0, "Cart items can't be negative"),
      exitIntent: z.boolean(),
    }),
    conditions: z.object({
      audience: z.enum(["all", "visitors", "customers"]),
      displayTime: z.enum(["all", "business_hours"]),
      device: z.enum(["all", "desktop", "mobile"]),
      displayDuration: z.enum(["always", "custom"]),
      startDate: z.string().max(10),
      endDate: z.string().max(10),
      countryMode: z.enum(["all", "selected"]),
      countries: z.array(z.string().max(2)).max(250),
    }),
    message: z.object({
      kind: z.enum(CAMPAIGN_MESSAGE_KINDS),
      contentMode: z.enum(["quick_question", "custom"]),
      bodyHtml: z.string().max(4000, "Message must be 4000 characters or fewer"),
      recommendation: z.enum(CAMPAIGN_RECOMMENDATION_SOURCES),
      productIds: z.array(z.string().max(120)).max(20, "Pick at most 20 products"),
      collectionIds: z.array(z.string().max(120)).max(20, "Pick at most 20 collections"),
      primaryButtonText: z.string().max(30, "Button text must be 30 characters or fewer"),
      secondaryButtonText: z.string().max(30, "Button text must be 30 characters or fewer"),
      triggerButtonText: z.string().max(60, "Trigger button text must be 60 characters or fewer"),
      discountCode: z.string().max(60, "Discount code must be 60 characters or fewer"),
      usageInstruction: z.string().max(300, "Usage instruction must be 300 characters or fewer"),
      collectLead: z.boolean(),
      lead: z.object({
        introduction: z.string().max(300, "Introduction must be 300 characters or fewer"),
        askName: z.boolean(),
        askPhone: z.boolean(),
        doubleOptIn: z.boolean(),
        successMessage: z.string().max(400, "Success message must be 400 characters or fewer"),
      }),
      floaterMessage: z.string().max(100, "Floater message must be 100 characters or fewer"),
      subtitle: z.string().max(120, "Subtitle must be 120 characters or fewer"),
      ctaText: z.string().max(30, "CTA button text must be 30 characters or fewer"),
    }),
    appearance: z.object({
      background: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Background color must be a #rrggbb hex value"),
      textColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Text color must be a #rrggbb hex value"),
      buttonBackground: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Button color must be a #rrggbb hex value"),
      buttonLabelColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Button label color must be a #rrggbb hex value"),
    }),
  })
  .superRefine((s, ctx) => {
    const issue = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

    if (s.trigger.pageScope === "specific_pages" && s.trigger.urlContains.trim() === "") {
      issue("Add the URL fragment the specific pages share", ["trigger", "urlContains"]);
    }
    if (s.trigger.pageScope === "specific_product_pages" && s.trigger.pageProductIds.length === 0) {
      issue("Pick at least one product page", ["trigger", "pageProductIds"]);
    }
    if (s.trigger.pageScope === "specific_collection_pages" && s.trigger.pageCollectionIds.length === 0) {
      issue("Pick at least one collection page", ["trigger", "pageCollectionIds"]);
    }
    if (
      s.trigger.cartMaxValue !== null &&
      s.trigger.cartMaxValue > 0 &&
      s.trigger.cartMaxValue < s.trigger.cartMinValue
    ) {
      issue("Maximum cart value must be higher than the minimum", ["trigger", "cartMaxValue"]);
    }
    if (s.conditions.displayDuration === "custom") {
      if (!ISO_DATE.test(s.conditions.startDate)) issue("Pick a start date", ["conditions", "startDate"]);
      if (!ISO_DATE.test(s.conditions.endDate)) issue("Pick an end date", ["conditions", "endDate"]);
      if (
        ISO_DATE.test(s.conditions.startDate) &&
        ISO_DATE.test(s.conditions.endDate) &&
        s.conditions.endDate < s.conditions.startDate
      ) {
        issue("End date must be on or after the start date", ["conditions", "endDate"]);
      }
    }
    if (s.conditions.countryMode === "selected" && s.conditions.countries.length === 0) {
      issue("Pick at least one country", ["conditions", "countries"]);
    }
    if (s.message.kind === "discount" && s.message.discountCode.trim() === "") {
      issue("Pick the discount code this campaign offers", ["message", "discountCode"]);
    }
    if (s.message.kind === "product_recommendation" && s.message.recommendation === "custom") {
      if (s.message.productIds.length === 0) {
        issue("Pick at least one product to recommend", ["message", "productIds"]);
      }
    }
    if (s.message.kind === "floater" && s.message.floaterMessage.trim() === "") {
      issue("Add the floater message", ["message", "floaterMessage"]);
    }
  });

/** ZodError → one merchant-readable line. */
function issueMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Invalid campaign payload";
  return issue.message;
}

export type SaveCampaignResult =
  | { ok: true; id: string }
  | { ok: false; error: string; code?: "plan_gate" | "not_found" | "invalid" };

/** Create or update (upsert-by-id) a campaign. Validates settings strictly and
 *  enforces every plan gate the editor renders (premium template, Product Quiz
 *  message type, "similar products" recommendation, active-campaign quota). */
export async function saveCampaign(
  shopId: string,
  plan: string,
  payload: unknown,
): Promise<SaveCampaignResult> {
  requireShopId(shopId);
  const parsed = savePayloadSchema.safeParse(payload);
  if (!parsed.success) return { ok: false, error: issueMessage(parsed.error), code: "invalid" };
  const { id, name, templateType, status } = parsed.data;
  const template = campaignTemplate(templateType);
  if (!template) return { ok: false, error: "Unknown template", code: "invalid" };

  try {
    if (isPremiumTemplate(templateType)) requirePlan(plan, "premium_campaign_templates");
  } catch (error) {
    if (error instanceof PlanGateError) {
      return { ok: false, error: "This template requires a Pro or Plus plan.", code: "plan_gate" };
    }
    throw error;
  }

  // Fill any field the client omitted with its default, then validate the
  // merchant's own values strictly.
  const base = campaignSettingsSchema.parse({});
  const incoming = (parsed.data.settings ?? {}) as Partial<CampaignSettingsData>;
  const strict = strictCampaignSettingsSchema.safeParse({
    trigger: { ...base.trigger, ...(incoming.trigger ?? {}) },
    conditions: { ...base.conditions, ...(incoming.conditions ?? {}) },
    message: {
      ...base.message,
      ...(incoming.message ?? {}),
      lead: { ...base.message.lead, ...(incoming.message?.lead ?? {}) },
    },
    appearance: { ...base.appearance, ...(incoming.appearance ?? {}) },
  });
  if (!strict.success) return { ok: false, error: issueMessage(strict.error), code: "invalid" };

  // The message body reaches storefront visitors through innerHTML — allow-list
  // it here, exactly like FAQ answers and starter replies.
  const settings: CampaignSettingsData = {
    ...strict.data,
    message: { ...strict.data.message, bodyHtml: sanitizeHtml(strict.data.message.bodyHtml) },
  };

  // The template decides which message tabs exist; a payload naming any other
  // kind is either a stale tab or a hand-rolled request.
  if (!template.messageKinds.includes(settings.message.kind)) {
    return { ok: false, error: "That message type isn't available for this template.", code: "invalid" };
  }
  // Product Quiz has no runtime yet: widget-renderer.js has no quiz branch, so a
  // saved quiz falls through to renderText() and the shopper gets a plain text
  // bubble. Refusing it for EVERY plan is the honest behaviour until the
  // renderer exists — gating it on Pro+ meant paying customers were the only
  // ones who could configure something that silently does not work.
  if (settings.message.kind === "product_quiz") {
    return { ok: false, error: "Product Quiz isn't available yet.", code: "invalid" };
  }
  if (
    settings.message.kind === "product_recommendation" &&
    settings.message.recommendation === "similar" &&
    !hasFeature(plan, "custom_recommendations")
  ) {
    return {
      ok: false,
      error: "“Recommend similar products” requires a Pro or Plus plan.",
      code: "plan_gate",
    };
  }

  // active_campaigns quota (spec 15). Only saving AS ACTIVE is gated — drafts
  // are unlimited, and an already-active campaign re-saved stays active.
  if (status === "active" && (await activationWouldExceedQuota(shopId, plan, id))) {
    return {
      ok: false,
      error:
        "You've reached your plan's limit for active campaigns. Deactivate another one or upgrade your plan.",
      code: "plan_gate",
    };
  }

  if (id) {
    const updated = await db.campaign.updateMany({
      where: { id, shopId },
      data: { name, status, settings },
    });
    if (updated.count === 0) return { ok: false, error: "Campaign not found", code: "not_found" };
    return { ok: true, id };
  }

  const max = await db.campaign.aggregate({ where: { shopId }, _max: { priority: true } });
  const created = await db.campaign.create({
    data: {
      shopId,
      name,
      templateType,
      status,
      priority: (max._max.priority ?? 0) + 1,
      settings,
    },
  });
  return { ok: true, id: created.id };
}

/** Copy a campaign as "<name> copy", inactive, lowest priority. */
export async function duplicateCampaign(shopId: string, id: string): Promise<string | null> {
  requireShopId(shopId);
  const source = await db.campaign.findFirst({ where: { id, shopId } });
  if (!source) return null;
  const max = await db.campaign.aggregate({ where: { shopId }, _max: { priority: true } });
  const copy = await db.campaign.create({
    data: {
      shopId,
      name: `${source.name} copy`.slice(0, 100),
      templateType: source.templateType,
      status: "inactive",
      priority: (max._max.priority ?? 0) + 1,
      settings: source.settings ?? {},
    },
  });
  return copy.id;
}

export async function deleteCampaign(shopId: string, id: string): Promise<boolean> {
  requireShopId(shopId);
  const result = await db.campaign.deleteMany({ where: { id, shopId } });
  return result.count > 0;
}

/** Would activating one more campaign exceed the plan's `active_campaigns`
 *  quota? Counts only campaigns that are active RIGHT NOW, excluding the row
 *  being changed, so re-saving an already-active campaign never trips the gate.
 *
 *  Downgrade rule (spec 15): campaigns already active on a higher plan keep
 *  running after a downgrade — this only blocks going from N to N+1. */
async function activationWouldExceedQuota(
  shopId: string,
  plan: string,
  excludeId?: string,
): Promise<boolean> {
  const quota = getQuota(plan, "active_campaigns");
  if (isUnlimitedQuota(quota)) return false;
  const active = await db.campaign.count({
    where: { shopId, status: "active", ...(excludeId ? { id: { not: excludeId } } : {}) },
  });
  return active >= quota;
}

export async function toggleCampaign(
  shopId: string,
  id: string,
  active: boolean,
): Promise<boolean | { error: string }> {
  requireShopId(shopId);
  if (active) {
    const shop = await db.shop.findUnique({ where: { id: shopId }, select: { plan: true } });
    if (await activationWouldExceedQuota(shopId, shop?.plan ?? "free", id)) {
      return {
        error:
          "You've reached your plan's limit for active campaigns. Deactivate another one or upgrade your plan.",
      };
    }
  }
  const result = await db.campaign.updateMany({
    where: { id, shopId },
    data: { status: active ? "active" : "inactive" },
  });
  return result.count > 0;
}

/** Move a campaign one step up/down in evaluation order (lower = evaluated
 *  first). Renumbers the whole shop's campaigns 1..n so priorities stay dense. */
export async function reorderCampaign(
  shopId: string,
  id: string,
  direction: "up" | "down",
): Promise<boolean> {
  requireShopId(shopId);
  const rows = await db.campaign.findMany({
    where: { shopId },
    orderBy: [{ priority: "asc" }, { updatedAt: "desc" }],
    select: { id: true },
  });
  const index = rows.findIndex((r) => r.id === id);
  if (index === -1) return false;
  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= rows.length) return false;
  const order = rows.map((r) => r.id);
  [order[index], order[target]] = [order[target], order[index]];
  await db.$transaction(
    order.map((campaignId, i) =>
      db.campaign.updateMany({ where: { id: campaignId, shopId }, data: { priority: i + 1 } }),
    ),
  );
  return true;
}

// ── Widget projection ───────────────────────────────────────────────────────

export interface CampaignProductCard {
  id: string;
  title: string;
  price: number;
  imageUrl: string | null;
  handle: string;
  /** Numeric variant id for /cart/add.js (first available variant), null if unknown. */
  variantId: string | null;
}

/** Lean client shape — only what the storefront runtime needs. Mirrors the
 *  editor sections so the storefront bubble and the admin preview can be
 *  rendered by the SAME builder (widget-renderer.campaignBubble). */
export interface WidgetCampaign {
  id: string;
  templateType: string;
  trigger: CampaignSettingsData["trigger"];
  conditions: CampaignSettingsData["conditions"];
  message: Omit<CampaignSettingsData["message"], "lead"> & {
    lead: CampaignSettingsData["message"]["lead"] | null;
  };
  appearance: CampaignSettingsData["appearance"];
  /** Pre-resolved cards for the static recommendation sources. Contextual
   *  sources (similar/complementary) resolve per page via proxy.campaign-products. */
  products: CampaignProductCard[];
  /** true → the runtime must fetch cards for the page's product. */
  needsContextualProducts: boolean;
}

function firstVariantId(variants: unknown): string | null {
  if (!Array.isArray(variants)) return null;
  const list = variants as { id?: string; available?: boolean }[];
  const first = list.find((v) => v.available) ?? list[0];
  if (!first || typeof first.id !== "string") return null;
  const numeric = first.id.split("/").pop();
  return numeric && /^\d+$/.test(numeric) ? numeric : null;
}

export const MAX_CAMPAIGN_CARDS = 3;

type CardSelect = {
  shopifyProductId: string;
  title: string;
  price: unknown;
  imageUrl: string | null;
  handle: string;
  variants: unknown;
};

const CARD_SELECT = {
  shopifyProductId: true,
  title: true,
  price: true,
  imageUrl: true,
  handle: true,
  variants: true,
} as const;

export function toCard(p: CardSelect): CampaignProductCard {
  return {
    id: p.shopifyProductId,
    title: p.title,
    price: Number(p.price),
    imageUrl: p.imageUrl,
    handle: p.handle,
    variantId: firstVariantId(p.variants),
  };
}

/** Recommendation sources that depend on the page the shopper is on. */
export function isContextualRecommendation(source: string): boolean {
  return source === "similar" || source === "complementary";
}

/** Resolve a static (page-independent) recommendation source to product cards.
 *
 *  There is no order-volume column on the catalog mirror, so "best sellers" and
 *  "new arrivals" read the merchant's curated Recommendation lists (spec 08,
 *  seeded at install) and fall back to the catalog when those are empty —
 *  newest-first for arrivals, in-stock for best sellers. */
async function staticRecommendationCards(
  shopId: string,
  source: string,
  explicitIds: string[],
): Promise<CampaignProductCard[]> {
  if (source === "custom") {
    if (explicitIds.length === 0) return [];
    const rows = await db.product.findMany({
      where: {
        shopId,
        shopifyProductId: { in: explicitIds.slice(0, MAX_CAMPAIGN_CARDS) },
        status: "active",
        stock: { gt: 0 },
      },
      select: CARD_SELECT,
    });
    const byGid = new Map(rows.map((r) => [r.shopifyProductId, toCard(r)]));
    // Preserve the merchant's chosen order.
    return explicitIds
      .slice(0, MAX_CAMPAIGN_CARDS)
      .map((gid) => byGid.get(gid))
      .filter((c): c is CampaignProductCard => Boolean(c));
  }

  const listTitle = source === "new_arrivals" ? "New arrivals" : "Best sellers";
  const curated = await db.recommendation.findFirst({
    where: { shopId, status: "active", title: { equals: listTitle, mode: "insensitive" } },
    select: { productIds: true },
  });
  const curatedIds = (curated?.productIds ?? []).slice(0, MAX_CAMPAIGN_CARDS);
  if (curatedIds.length > 0) {
    const rows = await db.product.findMany({
      where: { shopId, shopifyProductId: { in: curatedIds }, status: "active", stock: { gt: 0 } },
      select: CARD_SELECT,
    });
    const byGid = new Map(rows.map((r) => [r.shopifyProductId, toCard(r)]));
    const cards = curatedIds.map((gid) => byGid.get(gid)).filter((c): c is CampaignProductCard => Boolean(c));
    if (cards.length > 0) return cards;
  }

  const rows = await db.product.findMany({
    where: { shopId, status: "active", stock: { gt: 0 } },
    orderBy: source === "new_arrivals" ? { createdAt: "desc" } : { updatedAt: "desc" },
    take: MAX_CAMPAIGN_CARDS,
    select: CARD_SELECT,
  });
  return rows.map(toCard);
}

/** Cards for a contextual source, anchored on the product the shopper is
 *  viewing. Used by proxy.campaign-products (never by the cached config). */
export async function contextualRecommendationCards(
  shopId: string,
  source: string,
  anchorProductId: string,
): Promise<CampaignProductCard[]> {
  requireShopId(shopId);
  if (source === "complementary") {
    const pair = await db.crossSellPair.findFirst({
      where: { shopId, productId: anchorProductId, status: "active" },
      select: { companionIds: true },
    });
    const ids = (pair?.companionIds ?? []).slice(0, MAX_CAMPAIGN_CARDS);
    if (ids.length > 0) {
      const rows = await db.product.findMany({
        where: { shopId, shopifyProductId: { in: ids }, status: "active", stock: { gt: 0 } },
        select: CARD_SELECT,
      });
      const byGid = new Map(rows.map((r) => [r.shopifyProductId, toCard(r)]));
      const cards = ids.map((gid) => byGid.get(gid)).filter((c): c is CampaignProductCard => Boolean(c));
      if (cards.length > 0) return cards;
    }
  }

  // "similar" (and complementary with no configured pair): same product type /
  // vendor as the anchor, excluding the anchor itself.
  const anchor = await db.product.findFirst({
    where: { shopId, shopifyProductId: anchorProductId },
    select: { productType: true, vendor: true },
  });
  const rows = await db.product.findMany({
    where: {
      shopId,
      status: "active",
      stock: { gt: 0 },
      shopifyProductId: { not: anchorProductId },
      ...(anchor?.productType
        ? { productType: anchor.productType }
        : anchor?.vendor
          ? { vendor: anchor.vendor }
          : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: MAX_CAMPAIGN_CARDS,
    select: CARD_SELECT,
  });
  return rows.map(toCard);
}

/** Full detail for the Smart Product Page floater: the anchor product plus its
 *  variant option values, so the widget can draw the size/color chips. */
export interface CampaignAnchorProduct extends CampaignProductCard {
  /** Option name shown in "Not sure which {{ option }}?" (e.g. "Size"). */
  optionName: string;
  /** Chips: one per distinct value of the first option. */
  options: { value: string; variantId: string | null; available: boolean }[];
}

export async function anchorProductDetail(
  shopId: string,
  productId: string,
): Promise<CampaignAnchorProduct | null> {
  requireShopId(shopId);
  const row = await db.product.findFirst({
    where: { shopId, shopifyProductId: productId, status: "active" },
    select: CARD_SELECT,
  });
  if (!row) return null;
  const card = toCard(row);

  // Catalog-mirror variants carry `title` (the joined option values) and, when
  // the sync captured them, `selectedOptions`. Prefer the structured field and
  // fall back to the first "/"-separated segment of the title.
  type Variant = {
    id?: string;
    title?: string;
    available?: boolean;
    selectedOptions?: { name?: string; value?: string }[];
  };
  const variants: Variant[] = Array.isArray(row.variants) ? (row.variants as Variant[]) : [];
  let optionName = "";
  const seen = new Set<string>();
  const options: CampaignAnchorProduct["options"] = [];
  for (const v of variants) {
    const structured = v.selectedOptions?.[0];
    const value = (structured?.value ?? String(v.title ?? "").split("/")[0] ?? "").trim();
    if (!value || value.toLowerCase() === "default title" || seen.has(value)) continue;
    seen.add(value);
    if (!optionName && structured?.name) optionName = structured.name;
    const numeric = String(v.id ?? "").split("/").pop() ?? "";
    options.push({
      value,
      variantId: /^\d+$/.test(numeric) ? numeric : null,
      available: v.available !== false,
    });
  }
  return { ...card, optionName: optionName || "option", options: options.slice(0, 8) };
}

/** Active campaigns for the widget-config payload: priority order, premium
 *  templates removed below Pro (server-side gate), recommendation sources
 *  resolved to product cards where they don't depend on the current page. */
export async function activeCampaignsForWidget(
  shopId: string,
  plan: string,
): Promise<WidgetCampaign[]> {
  requireShopId(shopId);
  const rows = await db.campaign.findMany({
    where: { shopId, status: "active" },
    orderBy: [{ priority: "asc" }, { updatedAt: "desc" }],
  });
  const premiumAllowed = hasFeature(plan, "premium_campaign_templates");
  const similarAllowed = hasFeature(plan, "custom_recommendations");
  const allowed = rows.filter((r) => premiumAllowed || !isPremiumTemplate(r.templateType));

  const campaigns = allowed
    .map((r) => ({ row: r, settings: parseCampaignSettings(r.settings) }))
    // Product Quiz is Pro+ — below that the campaign has no renderable body,
    // so drop it entirely rather than serve an empty bubble.
    .filter((c) => premiumAllowed || c.settings.message.kind !== "product_quiz");

  const projected: WidgetCampaign[] = [];
  for (const { row, settings } of campaigns) {
    const wantsProducts = settings.message.kind === "product_recommendation";
    // Below Pro, "similar" degrades to best sellers instead of showing nothing.
    const source =
      settings.message.recommendation === "similar" && !similarAllowed
        ? "best_sellers"
        : settings.message.recommendation;
    const contextual = wantsProducts && isContextualRecommendation(source);
    const products =
      wantsProducts && !contextual
        ? await staticRecommendationCards(shopId, source, settings.message.productIds)
        : [];

    projected.push({
      id: row.id,
      templateType: row.templateType,
      trigger: settings.trigger,
      conditions: settings.conditions,
      message: {
        ...settings.message,
        recommendation: source,
        // Lead config only travels when the campaign actually collects one.
        lead: settings.message.collectLead ? settings.message.lead : null,
      },
      appearance: settings.appearance,
      products,
      needsContextualProducts: contextual || settings.message.kind === "floater",
    });
  }
  return projected;
}

// ── Metrics ─────────────────────────────────────────────────────────────────

export type CampaignMetric = "view" | "click" | "atc";

/** Increment a campaign's counters (shop-scoped; no-op for unknown ids).
 *  Review m4: the beacon's revenue number is CLIENT-SUPPLIED and ignored —
 *  ATC revenue is recomputed server-side from the campaign's own product
 *  mirror prices (min price when the added variant can't be identified). */
export async function recordCampaignMetric(
  shopId: string,
  campaignId: string,
  metric: CampaignMetric,
  _clientRevenue?: number,
): Promise<void> {
  requireShopId(shopId);
  if (!campaignId) return;
  let data: Record<string, unknown>;
  if (metric === "view") {
    data = { views: { increment: 1 } };
  } else if (metric === "click") {
    data = { clicks: { increment: 1 } };
  } else {
    const revenue = await serverSideAtcRevenue(shopId, campaignId);
    data = {
      atcs: { increment: 1 },
      ...(revenue > 0 ? { revenue: { increment: revenue } } : {}),
    };
  }
  try {
    await db.campaign.updateMany({ where: { id: campaignId, shopId }, data });
  } catch (error) {
    // Metrics must never break the beacon path.
    logError("campaign_metric_error", error, { metric, shopId });
  }
}

/** Trusted ATC value: cheapest in-stock price among the campaign's products.
 *  Campaigns whose products are resolved dynamically (best sellers, similar…)
 *  have no fixed list, so they fall back to the cheapest in-stock product. */
async function serverSideAtcRevenue(shopId: string, campaignId: string): Promise<number> {
  try {
    const campaign = await db.campaign.findFirst({
      where: { id: campaignId, shopId },
      select: { settings: true },
    });
    if (!campaign) return 0;
    const productIds = parseCampaignSettings(campaign.settings).message.productIds;
    const cheapest = await db.product.findFirst({
      where: {
        shopId,
        stock: { gt: 0 },
        ...(productIds.length > 0 ? { shopifyProductId: { in: productIds } } : {}),
      },
      orderBy: { price: "asc" },
      select: { price: true },
    });
    return cheapest ? Number(cheapest.price) : 0;
  } catch {
    return 0;
  }
}
