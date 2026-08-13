import type { Prisma } from "@prisma/client";
import db from "../../db.server";
import { requireShopId } from "../tenancy.server";
import { invalidateShopConfig } from "../config/shop-config.server";
import { uploadImage } from "../files.server";
import { sanitizeHtml } from "../sanitize.server";
import { recordEvent } from "../analytics/events.server";
import { requirePlan, PlanGateError } from "../billing/plans.server";
import { widgetSettingsSchema, type WidgetSettingsData } from "../settings/schemas";

// Chatbox settings save workflow (spec 06). Intents:
//   save          — full WidgetSettings draft JSON → zod parse → normalize →
//                   upsert → invalidate config cache → analytics event
//   toggle-active — page-head Activate/Deactivate (only flips `active`)
//   upload-logo / upload-icon — multipart image → Shopify Files CDN URL
//                   (uploadImage enforces ≤2MB + PNG/JPG/WebP server-side);
//                   the client puts the returned URL into the draft.

export interface ChatboxActionResult {
  ok: boolean;
  intent: string;
  error?: string;
  /** CDN URL for upload-* intents. */
  url?: string;
}

/** Load + parse the shop's widget settings (defaults when no row exists). */
export async function loadWidgetSettings(shopId: string): Promise<WidgetSettingsData> {
  requireShopId(shopId);
  const row = await db.widgetSettings.findUnique({ where: { shopId } });
  return widgetSettingsSchema.parse(row?.settings ?? {});
}

/** Server-side normalization mirroring the UI invariants. */
function normalize(settings: WidgetSettingsData): WidgetSettingsData {
  // Contact methods: single-use per type, sequential order.
  const seen = new Set<string>();
  const contactItems = settings.contactMethods.items
    .filter((item) => {
      if (seen.has(item.type)) return false;
      seen.add(item.type);
      return true;
    })
    .map((item, index) => ({ ...item, order: index }));

  // Starters: stable ids + sequential order + sanitized merchant HTML.
  const starterItems = settings.starters.items.map((item, index) => ({
    ...item,
    id: item.id || `st-${Date.now().toString(36)}-${index}`,
    answerHtml: sanitizeHtml(item.answerHtml),
    order: index,
  }));

  // Pre-chat fields: email always present and required, one row per key.
  const keys = new Set<string>();
  const fields = settings.prechat.fields.filter((field) => {
    if (keys.has(field.key)) return false;
    keys.add(field.key);
    return true;
  });
  const emailIndex = fields.findIndex((field) => field.key === "email");
  if (emailIndex === -1) fields.unshift({ key: "email", required: true });
  else fields[emailIndex] = { key: "email", required: true };

  return {
    ...settings,
    contactMethods: { ...settings.contactMethods, items: contactItems },
    starters: { ...settings.starters, items: starterItems },
    prechat: {
      ...settings.prechat,
      fields,
      disclaimer: {
        ...settings.prechat.disclaimer,
        html: sanitizeHtml(settings.prechat.disclaimer.html),
      },
    },
  };
}

async function persist(shopId: string, settings: WidgetSettingsData): Promise<void> {
  await db.widgetSettings.upsert({
    where: { shopId },
    update: { settings: settings as unknown as Prisma.InputJsonObject },
    create: { shopId, settings: settings as unknown as Prisma.InputJsonObject },
  });
  invalidateShopConfig(shopId);
}

export async function applyChatboxIntent(args: {
  shopId: string;
  shopDomain: string;
  formData: FormData;
}): Promise<ChatboxActionResult> {
  const { shopId, shopDomain, formData } = args;
  requireShopId(shopId);
  const intent = String(formData.get("intent") ?? "");

  try {
    if (intent === "upload-logo" || intent === "upload-icon") {
      const file = formData.get("file");
      if (!(file instanceof File) || file.size === 0) {
        return { ok: false, intent, error: "Choose an image file to upload." };
      }
      // Launcher icons are SVG/PNG only (user request 2026-08-13); the logo
      // keeps the wider uploadImage allowlist.
      if (intent === "upload-icon" && !["image/png", "image/svg+xml"].includes(file.type)) {
        return { ok: false, intent, error: "Launcher icon must be an SVG or PNG file." };
      }
      const bytes = Buffer.from(await file.arrayBuffer());
      const url = await uploadImage(shopDomain, {
        name: file.name || "widget-image.png",
        type: file.type,
        bytes,
      });
      return { ok: true, intent, url };
    }

    if (intent === "save") {
      const raw: unknown = JSON.parse(String(formData.get("payload") ?? "{}"));
      const parsed = normalize(widgetSettingsSchema.parse(raw));

      // Plan gate (spec 15): hiding branding is Basic+. Enforcement is
      // currently "open" (plans.server.ts) so this never throws — the seam is
      // in place for when tiers are finalized.
      if (parsed.appearance.removeBranding) {
        const shop = await db.shop.findUnique({ where: { id: shopId } });
        requirePlan(shop?.plan ?? "free", "remove_branding");
      }

      await persist(shopId, parsed);
      await recordEvent(shopId, "widget_settings_saved");
      return { ok: true, intent };
    }

    if (intent === "toggle-active") {
      const raw = JSON.parse(String(formData.get("payload") ?? "{}")) as { active?: unknown };
      const current = await loadWidgetSettings(shopId);
      const next = { ...current, active: raw.active === true };
      await persist(shopId, next);
      await recordEvent(shopId, "widget_settings_saved", { active: next.active });
      return { ok: true, intent };
    }

    return { ok: false, intent, error: `Unknown chatbox intent: ${intent || "(none)"}` };
  } catch (error) {
    if (error instanceof PlanGateError) {
      return {
        ok: false,
        intent,
        error: 'Removing the "Powered by ChatConvert" branding requires the Basic plan or above.',
      };
    }
    return {
      ok: false,
      intent,
      error: error instanceof Error ? error.message : "Invalid chatbox payload",
    };
  }
}
