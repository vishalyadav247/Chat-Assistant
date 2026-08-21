import { z } from "zod";
import type { Prisma } from "@prisma/client";
import db from "../../db.server";
import { requireShopId } from "../tenancy.server";
import { invalidateShopConfig } from "../config/shop-config.server";
import { uploadImage } from "../files.server";
import { shopSettingsSchema, zodMessage, type ShopSettingsData } from "./schemas";
import { validate17TrackKey } from "../tracking/seventeen-track.server";
import { DATE_FORMATS, TIME_FORMATS } from "../format/datetime";

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

// SAVE-path schemas are STRICT (no `.catch`): the lenient schemas in
// ./schemas exist so stored blobs always parse on READ, but on save a
// silently-coerced value would make the UI appear to accept input it then
// reverts. Invalid payloads return a friendly error instead (see zodMessage).
const maxText = (n: number, what: string) =>
  z.string().max(n, `${what} must be ${n} characters or fewer`);

const generalPayload = z.object({
  name: maxText(100, "Store name"),
  dateFormat: z.enum(DATE_FORMATS),
  timeFormat: z.enum(TIME_FORMATS),
  theme: z.enum(["auto", "dawn", "refresh", "craft", "custom"]),
  inbox: z.object({
    autoResolve: z.boolean(),
    after: z.number().int().min(1, "Auto-resolve delay must be at least 1"),
    unit: z.enum(["minute", "hour", "day"]),
  }),
});

const chatboxPayload = z.object({
  cartDrawer: z.boolean(),
  orderTracking: z.object({
    mode: z.enum(["default", "custom", "integration"]),
    customUrl: maxText(500, "Custom tracking URL"),
    provider: z.enum(["17track"]),
  }),
});

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const hhmm = (what: string) => z.string().regex(HHMM, `${what} must be a time like 09:00`);
const toMinutes = (hhmmValue: string) => {
  const [h, m] = hhmmValue.split(":").map(Number);
  return h * 60 + m;
};
/** Minutes spanned by from→to; a `to` at or before `from` wraps past midnight. */
const spanMinutes = (from: string, to: string) => (toMinutes(to) - toMinutes(from) + 1440) % 1440;

const strictAvailabilitySchema = z
  .object({
    mode: z.enum(["always", "custom"]),
    days: z.array(
      z.object({
        day: z.number().int().min(0).max(6),
        enabled: z.boolean(),
        from: hhmm("Opening time"),
        to: hhmm("Closing time"),
      }),
    ),
    onlineStatusMode: z.enum(["working_hours", "working_hours_or_agent", "agent_during_hours"]),
    breaks: z.object({
      enabled: z.boolean(),
      ranges: z.array(z.object({ from: hhmm("Break start"), to: hhmm("Break end") })),
    }),
    holidays: z.object({
      enabled: z.boolean(),
      items: z.array(
        z.object({
          name: maxText(100, "Holiday name"),
          from: z.string().regex(YMD, "Holiday start must be a date"),
          to: z.string().regex(YMD, "Holiday end must be a date"),
        }),
      ),
    }),
    messages: z.object({
      online: maxText(120, "Online status message"),
      offline: maxText(120, "Offline status message"),
      break: maxText(120, "Break status message"),
      holiday: maxText(120, "Holiday status message"),
    }),
  })
  .superRefine((a, ctx) => {
    const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const enabledDays = a.mode === "custom" ? a.days.filter((d) => d.enabled) : [];
    for (const d of enabledDays) {
      if (d.from === d.to) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["days"],
          message: `${DAY_NAMES[d.day]}: opening and closing time can't be the same`,
        });
      }
    }
    if (a.mode === "custom" && enabledDays.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["days"],
        message: "Enable at least one working day, or switch to 24 hours / 7 days",
      });
    }
    if (a.breaks.enabled) {
      a.breaks.ranges.forEach((r, i) => {
        const length = spanMinutes(r.from, r.to);
        if (length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["breaks"],
            message: `Break ${i + 1}: start and end time can't be the same`,
          });
          return;
        }
        // A break must sit inside every enabled day's working hours
        // (overnight windows are unwrapped onto a 0–2880 minute axis).
        for (const d of enabledDays) {
          const open = toMinutes(d.from);
          const close = open + spanMinutes(d.from, d.to);
          let start = toMinutes(r.from);
          if (start < open) start += 1440;
          if (start < open || start + length > close) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["breaks"],
              message: `Break ${i + 1} (${r.from}–${r.to}) falls outside ${DAY_NAMES[d.day]}'s working hours (${d.from}–${d.to})`,
            });
            break;
          }
        }
      });
    }
    if (a.holidays.enabled) {
      a.holidays.items.forEach((h, i) => {
        if (h.to < h.from) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["holidays"],
            message: `Holiday ${i + 1}${h.name ? ` (${h.name})` : ""}: end date is before the start date`,
          });
        }
      });
    }
  });

const availabilityPayload = z.object({
  availability: strictAvailabilitySchema,
  timezone: z.string().min(1, "Choose a time zone").max(64),
});

const surveyPayload = z.object({
  survey: z.object({
    format: z.enum(["stars", "emoji"]),
    intro: maxText(200, "Survey intro"),
    thanks: maxText(200, "Thank you message"),
    triggerOnResolve: z.boolean(),
    triggerKeywords: z.object({
      enabled: z.boolean(),
      keywords: z.array(maxText(50, "Each keyword")),
    }),
  }),
});

const privacyPayload = z.object({
  retentionDays: z.union([z.literal(0), z.literal(7), z.literal(30), z.literal(60), z.literal(90)]),
});

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
    if (error instanceof z.ZodError) return { ok: false, intent, error: zodMessage(error) };
    if (error instanceof SyntaxError) {
      return { ok: false, intent, error: "Couldn't read the settings payload — please reload and try again." };
    }
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
