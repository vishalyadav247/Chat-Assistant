import { z } from "zod";
import db from "../../db.server";
import { getQuota, hasFeature, isUnlimitedQuota, requirePlan, PlanGateError } from "../billing/plans.server";
import { campaignSettingsSchema, type CampaignSettingsData } from "../settings/schemas";
import { requireShopId } from "../tenancy.server";
import { campaignTemplate, isPremiumTemplate } from "./templates";
import { logError } from "../log.server";

// Proactive-chat campaign CRUD + widget projection + metric counters (spec 12).
// Every function is shop-scoped; premium templates are gated server-side both
// on save (requirePlan) and on widget serve (activeCampaignsForWidget filter).

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
    settings: campaignSettingsSchema.parse(row.settings ?? {}),
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

// SAVE-path settings schema: STRICT. The frozen campaignSettingsSchema uses
// `.catch()` so stored blobs always parse on READ, but on save that would
// silently rewrite a bad URL / oversized message to "" under a "Campaign
// saved" toast. Invalid input returns { ok:false, error } instead.
const strictCampaignSettingsSchema = z
  .object({
    trigger: z.object({
      pageTypes: z
        .array(z.enum(["home", "product", "collection", "search", "cart", "any"]))
        .min(1, "Pick at least one page type"),
      urlContains: z.string().max(300, "“URL contains” must be 300 characters or fewer"),
      delaySeconds: z
        .number()
        .int("Delay must be a whole number of seconds")
        .min(0, "Delay can't be negative")
        .max(300, "Delay can be at most 300 seconds"),
      exitIntent: z.boolean(),
      cartMinItems: z.number().int("Cart items must be a whole number").min(0, "Cart items can't be negative"),
      cartMinValue: z.number().min(0, "Cart value can't be negative"),
    }),
    message: z.string().max(500, "Message must be 500 characters or fewer"),
    ctaLabel: z.string().max(60, "Button label must be 60 characters or fewer"),
    ctaAction: z.enum(["open_chat", "apply_code", "link"]),
    // Only relative paths or http(s) — a javascript:/data: CTA would execute
    // in storefront visitors' browsers (review M3).
    ctaUrl: z
      .string()
      .max(500, "Link URL must be 500 characters or fewer")
      .refine(
        (v) => v === "" || v.startsWith("/") || /^https?:\/\//i.test(v),
        "Link URL must start with / or http(s)://",
      ),
    discountCode: z.string().max(60, "Discount code must be 60 characters or fewer"),
    productIds: z.array(z.string().max(120)),
    collectionIds: z.array(z.string().max(120)),
  })
  .superRefine((s, ctx) => {
    if (s.ctaAction === "link" && s.ctaUrl.trim() === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ctaUrl"],
        message: "Add the link the button should open",
      });
    }
    if (s.ctaAction === "apply_code" && s.discountCode.trim() === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["discountCode"],
        message: "Add the discount code the button should apply",
      });
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

/** Create or update (upsert-by-id) a campaign. Validates settings against the
 *  frozen campaignSettingsSchema and enforces the premium-template plan gate. */
export async function saveCampaign(
  shopId: string,
  plan: string,
  payload: unknown,
): Promise<SaveCampaignResult> {
  requireShopId(shopId);
  const parsed = savePayloadSchema.safeParse(payload);
  if (!parsed.success) return { ok: false, error: issueMessage(parsed.error), code: "invalid" };
  const { id, name, templateType, status } = parsed.data;
  if (!campaignTemplate(templateType)) {
    return { ok: false, error: "Unknown template", code: "invalid" };
  }
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
    ...base,
    ...incoming,
    trigger: { ...base.trigger, ...(incoming.trigger ?? {}) },
  });
  if (!strict.success) return { ok: false, error: issueMessage(strict.error), code: "invalid" };
  const settings = strict.data;

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
  title: string;
  price: number;
  imageUrl: string | null;
  handle: string;
  /** Numeric variant id for /cart/add.js (first available variant), null if unknown. */
  variantId: string | null;
}

/** Lean client shape — only what the storefront runtime needs. */
export interface WidgetCampaign {
  id: string;
  templateType: string;
  trigger: CampaignSettingsData["trigger"];
  message: string;
  ctaLabel: string;
  ctaAction: CampaignSettingsData["ctaAction"];
  ctaUrl: string;
  discountCode: string;
  products: CampaignProductCard[];
}

function firstVariantId(variants: unknown): string | null {
  if (!Array.isArray(variants)) return null;
  const list = variants as { id?: string; available?: boolean }[];
  const first = list.find((v) => v.available) ?? list[0];
  if (!first || typeof first.id !== "string") return null;
  const numeric = first.id.split("/").pop();
  return numeric && /^\d+$/.test(numeric) ? numeric : null;
}

const MAX_CAMPAIGN_CARDS = 3;

/** Active campaigns for the widget-config payload: priority order, premium
 *  templates removed below Pro (server-side gate), productIds resolved to up
 *  to 3 in-stock product cards from the catalog mirror. */
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
  const allowed = rows.filter((r) => premiumAllowed || !isPremiumTemplate(r.templateType));

  const campaigns = allowed.map((r) => ({
    row: r,
    settings: campaignSettingsSchema.parse(r.settings ?? {}),
  }));

  // Resolve all referenced products in one shop-scoped query.
  const wantedIds = [
    ...new Set(campaigns.flatMap((c) => c.settings.productIds.slice(0, MAX_CAMPAIGN_CARDS))),
  ];
  const products = wantedIds.length
    ? await db.product.findMany({
        where: { shopId, shopifyProductId: { in: wantedIds }, status: "active", stock: { gt: 0 } },
        select: {
          shopifyProductId: true,
          title: true,
          price: true,
          imageUrl: true,
          handle: true,
          variants: true,
        },
      })
    : [];
  const cardByGid = new Map(
    products.map((p) => [
      p.shopifyProductId,
      {
        title: p.title,
        price: Number(p.price),
        imageUrl: p.imageUrl,
        handle: p.handle,
        variantId: firstVariantId(p.variants),
      } satisfies CampaignProductCard,
    ]),
  );

  return campaigns.map(({ row, settings }) => ({
    id: row.id,
    templateType: row.templateType,
    trigger: settings.trigger,
    message: settings.message,
    ctaLabel: settings.ctaLabel,
    ctaAction: settings.ctaAction,
    ctaUrl: settings.ctaUrl,
    discountCode: settings.discountCode,
    products: settings.productIds
      .slice(0, MAX_CAMPAIGN_CARDS)
      .map((gid) => cardByGid.get(gid))
      .filter((card): card is CampaignProductCard => Boolean(card)),
  }));
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

/** Trusted ATC value: cheapest in-stock price among the campaign's products. */
async function serverSideAtcRevenue(shopId: string, campaignId: string): Promise<number> {
  try {
    const campaign = await db.campaign.findFirst({
      where: { id: campaignId, shopId },
      select: { settings: true },
    });
    const productIds = (campaign?.settings as { productIds?: string[] } | null)?.productIds ?? [];
    if (productIds.length === 0) return 0;
    const cheapest = await db.product.findFirst({
      where: { shopId, shopifyProductId: { in: productIds }, stock: { gt: 0 } },
      orderBy: { price: "asc" },
      select: { price: true },
    });
    return cheapest ? Number(cheapest.price) : 0;
  } catch {
    return 0;
  }
}
