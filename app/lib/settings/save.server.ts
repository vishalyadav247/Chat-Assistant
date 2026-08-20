import { z } from "zod";
import type { Prisma } from "@prisma/client";
import db from "../../db.server";
import { requireShopId } from "../tenancy.server";
import { invalidateShopConfig } from "../config/shop-config.server";
import { uploadImage } from "../files.server";
import {
  availabilitySchema,
  surveySchema,
  shopSettingsSchema,
  type ShopSettingsData,
} from "./schemas";
import { validate17TrackKey } from "../tracking/seventeen-track.server";
import { DATE_FORMATS, DEFAULT_DATE_FORMAT, DEFAULT_TIME_FORMAT, TIME_FORMATS } from "../format/datetime";

// Settings save workflow (spec 16): one intent per tab/card. Every intent
// zod-parses the incoming slice, merges it onto the current settings blob,
// re-validates the whole blob, upserts ShopSettings and invalidates the
// per-shop config cache.

export interface SettingsActionResult {
  ok: boolean;
  intent: string;
  error?: string;
  logoUrl?: string;
}

const generalPayload = z.object({
  name: z.string().max(100).catch(""),
  dateFormat: z.enum(DATE_FORMATS).catch(DEFAULT_DATE_FORMAT),
  timeFormat: z.enum(TIME_FORMATS).catch(DEFAULT_TIME_FORMAT),
  theme: shopSettingsSchema.shape.theme,
  inbox: shopSettingsSchema.shape.inbox,
});

const chatboxPayload = z.object({
  cartDrawer: shopSettingsSchema.shape.cartDrawer,
  orderTracking: shopSettingsSchema.shape.orderTracking,
});

const availabilityPayload = z.object({
  availability: availabilitySchema,
  timezone: z.string().min(1).max(64),
});

const surveyPayload = z.object({ survey: surveySchema });

const privacyPayload = z.object({ retentionDays: shopSettingsSchema.shape.retentionDays });

/** Load + parse the shop's settings blob (defaults when no row exists yet). */
export async function loadShopSettings(shopId: string): Promise<ShopSettingsData> {
  requireShopId(shopId);
  const row = await db.shopSettings.findUnique({ where: { shopId } });
  return shopSettingsSchema.parse(row?.settings ?? {});
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function applySettingsIntent(args: {
  shopId: string;
  shopDomain: string;
  formData: FormData;
}): Promise<SettingsActionResult> {
  const { shopId, shopDomain, formData } = args;
  requireShopId(shopId);
  const intent = String(formData.get("intent") ?? "");
  const current = await loadShopSettings(shopId);

  let next: ShopSettingsData = current;
  const extra: Partial<SettingsActionResult> = {};

  try {
    if (intent === "upload-logo") {
      const file = formData.get("logo");
      if (!(file instanceof File) || file.size === 0) {
        return { ok: false, intent, error: "Choose an image file to upload." };
      }
      const bytes = Buffer.from(await file.arrayBuffer());
      const url = await uploadImage(shopDomain, {
        name: file.name || "store-logo.png",
        type: file.type,
        bytes,
      });
      next = { ...current, storeInfo: { ...current.storeInfo, logoUrl: url } };
      extra.logoUrl = url;
    } else if (intent === "remove-logo") {
      // ✕ on the store logo (2026-08-17): back to the initials avatar. The
      // CDN file itself is left in place (harmless; Files cleanup is out of scope).
      next = { ...current, storeInfo: { ...current.storeInfo, logoUrl: null } };
      extra.logoUrl = "";
    } else {
      const raw: unknown = JSON.parse(String(formData.get("payload") ?? "{}"));
      switch (intent) {
        case "save-general": {
          const p = generalPayload.parse(raw);
          next = {
            ...current,
            theme: p.theme,
            inbox: p.inbox,
            storeInfo: { ...current.storeInfo, name: p.name, dateFormat: p.dateFormat, timeFormat: p.timeFormat },
          };
          break;
        }
        case "save-chatbox": {
          const p = chatboxPayload.parse(raw);
          next = {
            ...current,
            cartDrawer: p.cartDrawer,
            // The provider key changes only via connect-tracking (the payload
            // omits it, and the schema would otherwise default it to "").
            orderTracking: { ...p.orderTracking, apiKey: current.orderTracking.apiKey },
          };
          break;
        }
        case "save-availability": {
          const p = availabilityPayload.parse(raw);
          if (!isValidTimezone(p.timezone)) {
            return { ok: false, intent, error: `Unknown time zone: ${p.timezone}` };
          }
          next = { ...current, availability: p.availability };
          await db.shop.update({ where: { id: shopId }, data: { timezone: p.timezone } });
          break;
        }
        case "save-survey": {
          const p = surveyPayload.parse(raw);
          next = { ...current, survey: p.survey };
          break;
        }
        case "save-privacy": {
          const p = privacyPayload.parse(raw);
          next = { ...current, retentionDays: p.retentionDays };
          break;
        }

        // ── Order-tracking app integration (spec 16 delta) ──────────────────
        // Connect validates the key against the provider BEFORE persisting;
        // an empty key disconnects. Persisting also switches the mode so
        // Connect is the single activation step (mirrors the design).
        case "connect-tracking": {
          const p = z.object({ apiKey: z.string().trim().max(200) }).parse(raw);
          if (p.apiKey && !(await validate17TrackKey(p.apiKey))) {
            return {
              ok: false,
              intent,
              error: "17Track rejected this API key. Check it and try again.",
            };
          }
          next = {
            ...current,
            orderTracking: {
              ...current.orderTracking,
              mode: p.apiKey ? "integration" : "default",
              provider: "17track",
              apiKey: p.apiKey,
            },
          };
          break;
        }

        default:
          return { ok: false, intent, error: `Unknown settings intent: ${intent || "(none)"}` };
      }
    }
  } catch (error) {
    return {
      ok: false,
      intent,
      error: error instanceof Error ? error.message : "Invalid settings payload",
    };
  }

  const validated = shopSettingsSchema.parse(next);
  await db.shopSettings.upsert({
    where: { shopId },
    update: { settings: validated as unknown as Prisma.InputJsonObject },
    create: { shopId, settings: validated as unknown as Prisma.InputJsonObject },
  });
  invalidateShopConfig(shopId);
  return { ok: true, intent, ...extra };
}
