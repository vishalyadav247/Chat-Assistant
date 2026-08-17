import type { Guardrails, Persona } from "@prisma/client";
import db from "../../db.server";
import { requireShopId } from "../tenancy.server";
import {
  widgetSettingsSchema,
  shopSettingsSchema,
  handoverConfigSchema,
  type WidgetSettingsData,
  type ShopSettingsData,
  type HandoverConfigData,
} from "../settings/schemas";

// Cached per-shop config (persona, guardrails, widget + shop settings, handover).
// TTL is only a cross-process backstop — every save action MUST call
// invalidateShopConfig(shopId) so acceptance flows never wait on expiry.

const TTL_MS = 60_000;

export interface ShopConfig {
  shopId: string;
  plan: string;
  aiEnabled: boolean;
  currency: string;
  timezone: string;
  /** Shopify shop name — default store name when Settings → General is blank. */
  shopName: string;
  persona: Persona | null;
  guardrails: Guardrails | null;
  widget: WidgetSettingsData;
  settings: ShopSettingsData;
  handover: HandoverConfigData;
}

declare global {
  // eslint-disable-next-line no-var
  var shopConfigCache: Map<string, { config: ShopConfig; at: number }> | undefined;
}

function cache(): Map<string, { config: ShopConfig; at: number }> {
  if (!global.shopConfigCache) global.shopConfigCache = new Map();
  return global.shopConfigCache;
}

export async function getShopConfig(shopId: string): Promise<ShopConfig> {
  requireShopId(shopId);
  const hit = cache().get(shopId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.config;

  const [shop, persona, guardrails, widgetRow, settingsRow, handoverRow] = await Promise.all([
    db.shop.findUnique({ where: { id: shopId } }),
    db.persona.findUnique({ where: { shopId } }),
    db.guardrails.findUnique({ where: { shopId } }),
    db.widgetSettings.findUnique({ where: { shopId } }),
    db.shopSettings.findUnique({ where: { shopId } }),
    db.handoverConfig.findUnique({ where: { shopId } }),
  ]);

  const config: ShopConfig = {
    shopId,
    plan: shop?.plan ?? "free",
    aiEnabled: shop?.aiEnabled ?? true,
    currency: shop?.currency ?? "USD",
    timezone: shop?.timezone ?? "UTC",
    shopName: shop?.name ?? "",
    persona,
    guardrails,
    widget: widgetSettingsSchema.parse(widgetRow?.settings ?? {}),
    settings: shopSettingsSchema.parse(settingsRow?.settings ?? {}),
    handover: handoverConfigSchema.parse(handoverRow?.config ?? {}),
  };
  cache().set(shopId, { config, at: Date.now() });
  return config;
}

/** Call from EVERY action that saves shop-scoped config. */
export function invalidateShopConfig(shopId: string): void {
  cache().delete(shopId);
}
