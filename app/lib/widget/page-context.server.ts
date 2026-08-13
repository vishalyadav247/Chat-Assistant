import { z } from "zod";
import type { Prisma } from "@prisma/client";

// Conversation pageContext: the client-supplied context blob that powers the
// inbox details card (browsed pages, live cart, device). Everything here is
// storefront input — bounded schemas, unknown keys stripped, merged (never
// replaced wholesale) so history like `pages` survives each turn.

export const cartSchema = z.object({
  itemCount: z.number().int().min(0).max(999),
  totalValue: z.number().min(0),
  items: z
    .array(
      z.object({
        title: z.string().max(200),
        variant: z.string().max(200).optional(),
        quantity: z.number().int().min(0).max(999),
        price: z.number().min(0),
      }),
    )
    .max(20),
});

export const pageContextSchema = z.object({
  pageType: z.string().max(40).optional(),
  url: z.string().max(300).optional(),
  cart: cartSchema.optional(),
});

const PAGE_HISTORY_LIMIT = 20;

/** Human label from the raw User-Agent — enough for the inbox details card. */
export function deviceLabel(ua: string | undefined): string | null {
  if (!ua) return null;
  const os = /iPhone|iPad|iPod/i.test(ua)
    ? "iOS"
    : /Android/i.test(ua)
      ? "Android"
      : /Windows/i.test(ua)
        ? "Windows"
        : /Mac OS X|Macintosh/i.test(ua)
          ? "macOS"
          : /Linux/i.test(ua)
            ? "Linux"
            : null;
  const browser = /Edg\//i.test(ua)
    ? "Edge"
    : /OPR\//i.test(ua)
      ? "Opera"
      : /SamsungBrowser/i.test(ua)
        ? "Samsung Internet"
        : /Chrome\//i.test(ua)
          ? "Chrome"
          : /Firefox\//i.test(ua)
            ? "Firefox"
            : /Safari\//i.test(ua)
              ? "Safari"
              : null;
  const form = /iPad|Tablet/i.test(ua) ? "Tablet" : /Mobi|iPhone|Android/i.test(ua) ? "Mobile" : "Desktop";
  const parts = [form, os, browser].filter((p): p is string => Boolean(p));
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Merge one turn's context into the stored blob: latest url/pageType/cart,
 *  url appended to the `pages` history (unique URLs only, capped), device set once. */
export function mergePageContext(
  prev: unknown,
  incoming: unknown,
  userAgent?: string,
): Prisma.InputJsonValue | undefined {
  const prevObj =
    prev && typeof prev === "object" && !Array.isArray(prev)
      ? { ...(prev as Record<string, unknown>) }
      : {};
  const ctx =
    incoming && typeof incoming === "object" && !Array.isArray(incoming)
      ? (incoming as Record<string, unknown>)
      : {};

  const merged: Record<string, unknown> = { ...prevObj };
  if (typeof ctx.pageType === "string") merged.pageType = ctx.pageType;
  if (typeof ctx.url === "string") merged.url = ctx.url;
  if (ctx.cart && typeof ctx.cart === "object") merged.cart = ctx.cart;

  const pages = Array.isArray(prevObj.pages)
    ? prevObj.pages.filter((p): p is string => typeof p === "string")
    : typeof prevObj.url === "string" && prevObj.url
      ? [prevObj.url]
      : [];
  if (typeof ctx.url === "string" && ctx.url && !pages.includes(ctx.url)) {
    pages.push(ctx.url);
  }
  if (pages.length > 0) merged.pages = pages.slice(-PAGE_HISTORY_LIMIT);

  if (!merged.device) {
    const device = deviceLabel(userAgent);
    if (device) merged.device = device;
  }

  return Object.keys(merged).length > 0 ? (merged as Prisma.InputJsonValue) : undefined;
}
