import { unauthenticated } from "../shopify.server";
import { assertShopDomain } from "./tenancy.server";
import { runtimeConfig } from "./platform/runtime-config.server";
import { logError } from "./log.server";

// Theme app-embed detection (spec 13). Two independent signals, cheapest first:
//
//   1. STOREFRONT TRAFFIC (no scope). Only the theme app embed calls
//      /proxy/widget-config, so a recent request proves the embed is live.
//      One-directional: silence is NOT evidence of "off", because a store with
//      no traffic looks identical to one with the embed disabled.
//   2. THEME READ (read_themes). Reads config/settings_data.json on the
//      published (MAIN) theme and looks for our "chat-widget" app-embed block.
//      This is the only signal that can prove "off".
//
// read_themes was added to shopify.app.toml on 2026-08-26 — deliberately BEFORE
// launch, while no merchant had yet installed, because a scope added afterwards
// forces every existing merchant through re-auth. A shop that authorised before
// that still lacks the grant: there the query returns no data and this resolves
// to "unknown" — it never throws. The dashboard renders the unknown state as a
// "Verify in theme editor" link.

export type EmbedStatus = "on" | "off" | "unknown";

const TTL_MS = 5 * 60 * 1000; // in-memory per-shop cache, 5 minutes

declare global {
  // eslint-disable-next-line no-var
  var embedStatusCache: Map<string, { status: EmbedStatus; at: number }> | undefined;
}

function cache(): Map<string, { status: EmbedStatus; at: number }> {
  if (!global.embedStatusCache) global.embedStatusCache = new Map();
  return global.embedStatusCache;
}

// Our theme app extension handle (extensions/chat-widget/shopify.extension.toml).
// App-embed block types look like "shopify://apps/<app>/blocks/chat-widget/<uuid>".
const EMBED_BLOCK_MARKER = "/blocks/chat-widget/";

const THEME_SETTINGS_QUERY = `#graphql
  query DashboardEmbedStatus {
    themes(first: 1, roles: [MAIN]) {
      nodes {
        files(filenames: ["config/settings_data.json"], first: 1) {
          nodes {
            body {
              ... on OnlineStoreThemeFileBodyText {
                content
              }
            }
          }
        }
      }
    }
  }
`;

interface ThemeSettingsResponse {
  data?: {
    themes?: {
      nodes?: Array<{
        files?: {
          nodes?: Array<{ body?: { content?: string } }>;
        };
      }>;
    };
  };
  errors?: unknown;
}

/**
 * Parse settings_data.json for our app-embed block.
 * "current" is either an object with blocks, or a string naming a preset.
 */
export function parseEmbedStatus(content: string): EmbedStatus {
  // settings_data.json commonly starts with a /* comment banner */ — skip to JSON.
  const jsonStart = content.indexOf("{");
  if (jsonStart < 0) return "unknown";
  const parsed = JSON.parse(content.slice(jsonStart)) as {
    current?: string | { blocks?: Record<string, { type?: string; disabled?: boolean }> };
    presets?: Record<string, { blocks?: Record<string, { type?: string; disabled?: boolean }> }>;
  };
  const current = parsed.current;
  const blocks =
    typeof current === "string" ? parsed.presets?.[current]?.blocks : current?.blocks;
  if (!blocks || typeof blocks !== "object") return "off";
  for (const block of Object.values(blocks)) {
    if (typeof block?.type === "string" && block.type.includes(EMBED_BLOCK_MARKER)) {
      return block.disabled === true ? "off" : "on";
    }
  }
  return "off"; // embed block never added to the published theme
}

export async function getEmbedStatus(shopDomain: string): Promise<EmbedStatus> {
  assertShopDomain(shopDomain);
  // Storefront traffic proves the embed is live and costs no scope or Admin
  // call, so it is checked FIRST — most shops resolve here and never reach the
  // themes query at all.
  const fromTraffic = await embedStatusFromTraffic(shopDomain);
  if (fromTraffic) return fromTraffic;
  // Operator kill-switch for the themes query (rate limits, or a shop whose
  // grant predates read_themes). Off → nothing further can be determined.
  if (!runtimeConfig().embedStatusEnabled) return "unknown";
  const hit = cache().get(shopDomain);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.status;

  let status: EmbedStatus = "unknown";
  try {
    const { admin } = await unauthenticated.admin(shopDomain);
    const response = await admin.graphql(THEME_SETTINGS_QUERY);
    const body = (await response.json()) as ThemeSettingsResponse;
    const content = body.data?.themes?.nodes?.[0]?.files?.nodes?.[0]?.body?.content;
    if (typeof content === "string") {
      status = parseEmbedStatus(content);
    }
    // Missing scope / no MAIN theme / non-text body → stays "unknown".
  } catch (error) {
    // Scope errors, throttles, JSON parse failures — all resolve to "unknown".
    logError("embed_status_error", error, { shopDomain });
    status = "unknown";
  }

  cache().set(shopDomain, { status, at: Date.now() });
  return status;
}

/** Test/QA hook: drop the cached status for a shop. */
export function invalidateEmbedStatus(shopDomain: string): void {
  cache().delete(shopDomain);
}

// ── Storefront-traffic signal (no extra scope) ───────────────────────────────

/** Treat a widget-config request this recent as proof the embed is live. */
const SEEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Only write the stamp once an hour — the route is on every page view. */
const SEEN_WRITE_EVERY_MS = 60 * 60 * 1000;

const lastWrite = new Map<string, number>();

/**
 * Record that the storefront widget asked for its config.
 *
 * Called from proxy.widget-config, which ONLY the theme app embed calls — so a
 * recent stamp is positive proof the embed is installed and enabled on the
 * published theme, with no Admin call and no reliance on the read_themes grant.
 *
 * Never throws and never blocks the response: a failure here must not cost a
 * shopper their widget.
 */
export async function touchWidgetSeen(shopId: string): Promise<void> {
  const now = Date.now();
  const previous = lastWrite.get(shopId) ?? 0;
  if (now - previous < SEEN_WRITE_EVERY_MS) return;
  lastWrite.set(shopId, now);
  try {
    const db = (await import("../db.server")).default;
    await db.shop.update({ where: { id: shopId }, data: { widgetSeenAt: new Date(now) } });
  } catch {
    // Best-effort telemetry only.
  }
}

/**
 * "on" when the storefront has asked for its widget config recently.
 *
 * Deliberately one-directional: silence is NOT evidence the embed is off — a
 * store with no traffic looks identical to one with the embed disabled — so
 * this returns null rather than "off" and lets the caller fall through.
 */
export async function embedStatusFromTraffic(shopDomain: string): Promise<EmbedStatus | null> {
  assertShopDomain(shopDomain);
  try {
    const db = (await import("../db.server")).default;
    const shop = await db.shop.findUnique({
      where: { domain: shopDomain },
      select: { widgetSeenAt: true },
    });
    const seen = shop?.widgetSeenAt?.getTime();
    return seen && Date.now() - seen < SEEN_TTL_MS ? "on" : null;
  } catch {
    return null;
  }
}
