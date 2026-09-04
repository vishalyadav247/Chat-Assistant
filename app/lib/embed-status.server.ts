import { unauthenticated } from "../shopify.server";
import { assertShopDomain } from "./tenancy.server";
import { runtimeConfig } from "./admin/runtime-config.server";
import { logError } from "./log.server";

// Theme app-embed detection (spec 13). Two independent signals, AUTHORITATIVE
// first:
//
//   1. THEME READ (read_themes). Reads config/settings_data.json on the
//      published (MAIN) theme and looks for our "chat-widget" app-embed block.
//      This is the only signal that can prove "off", so it decides whenever it
//      can answer at all. When the published theme does NOT have it, the
//      UNPUBLISHED and DEVELOPMENT themes are checked too — many merchants set
//      apps up on a draft theme first, and reporting a flat "Off" there tells
//      them their work did not register when it did. That case is its own
//      status, "draft": correctly not live for shoppers, but not "off" either.
//   2. STOREFRONT TRAFFIC (no scope), consulted only when the theme read comes
//      back "unknown". Only the theme app embed calls /proxy/widget-config, so
//      a recent request proves the embed is live. One-directional: silence is
//      NOT evidence of "off", because a store with no traffic looks identical
//      to one with the embed disabled.
//
// The order used to be reversed, on the theory that traffic is free and the
// themes query costs an Admin call. It was wrong: `widgetSeenAt` is a stamp of
// the LAST request, kept valid for 7 days, so a merchant who disabled the embed
// in the theme customizer kept seeing an "On" badge for up to a week — the
// cheap signal was answering a question it cannot answer. The themes query is
// read fresh wherever a merchant is actually looking at the badge, so a page
// refresh always shows the truth.
//
// It used to be cached per shop for 5 minutes. That is exactly the window a
// merchant looks at this badge in — they toggle the embed in the customizer,
// come back and refresh — so the cache was stale precisely when it was read.
// Settings now passes `fresh` and never sees a cached value. The dashboard
// does NOT: its loader revalidates every 5 seconds for the live KPI feed, and
// an Admin call on that cadence would burn the rate-limit bucket for a setup
// checklist row. It keeps a short cache, which the fresh reads refill.
//
// read_themes was added to shopify.app.toml on 2026-08-26 — deliberately BEFORE
// launch, while no merchant had yet installed, because a scope added afterwards
// forces every existing merchant through re-auth. A shop that authorised before
// that still lacks the grant: there the query returns no data and this resolves
// to "unknown" — it never throws. The dashboard renders the unknown state as a
// "Verify in theme editor" link.

/**
 * "on"      live on the published theme — shoppers see the chat.
 * "draft"   enabled on an unpublished/development theme only. Not live yet,
 *           but the merchant HAS turned it on; it goes live with that theme.
 * "off"     not enabled on any theme we can read.
 * "unknown" we could not read the themes (no grant, kill-switch, throttle).
 */
export type EmbedStatus = "on" | "draft" | "off" | "unknown";

/** Status plus, for "draft", the theme the merchant actually enabled it on. */
export interface EmbedDetail {
  status: EmbedStatus;
  /** Name of the unpublished theme carrying the embed ("draft" only). */
  themeName: string | null;
}

/** Poll damper for the dashboard only — never consulted by a `fresh` read. */
const TTL_MS = 30 * 1000;

declare global {
  // eslint-disable-next-line no-var
  var embedStatusCache: Map<string, { detail: EmbedDetail; at: number }> | undefined;
}

function cache(): Map<string, { detail: EmbedDetail; at: number }> {
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

// Only reached when the PUBLISHED theme does not carry the embed, so the extra
// call is paid by the merchant who set the app up on a draft theme — not on
// every load. `first: 10` is a deliberate bound: settings_data.json is a large
// file and this fetches one per theme.
const OTHER_THEMES_QUERY = `#graphql
  query EmbedStatusOtherThemes {
    themes(first: 10, roles: [UNPUBLISHED, DEVELOPMENT]) {
      nodes {
        name
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
        name?: string;
        files?: {
          nodes?: Array<{ body?: { content?: string } }>;
        };
      }>;
    };
  };
  errors?: unknown;
}

/** parseEmbedStatus, but never throws — a malformed file reads as "unknown". */
function safeParse(content: unknown): EmbedStatus {
  if (typeof content !== "string") return "unknown";
  try {
    return parseEmbedStatus(content);
  } catch {
    return "unknown";
  }
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

export async function getEmbedStatus(
  shopDomain: string,
  opts: { fresh?: boolean } = {},
): Promise<EmbedStatus> {
  return (await getEmbedDetail(shopDomain, opts)).status;
}

/** As getEmbedStatus, but also names the draft theme when status is "draft". */
export async function getEmbedDetail(
  shopDomain: string,
  opts: { fresh?: boolean } = {},
): Promise<EmbedDetail> {
  assertShopDomain(shopDomain);
  const fromTheme = await embedStatusFromTheme(shopDomain, opts.fresh === true);
  if (fromTheme.status !== "unknown") return fromTheme;
  // The themes could not answer (operator kill-switch, a grant that predates
  // read_themes, a throttle). Recent storefront traffic can still prove "on";
  // it can never prove "off", so a null falls through to unknown.
  return { status: (await embedStatusFromTraffic(shopDomain)) ?? "unknown", themeName: null };
}

/**
 * The authoritative signal: what the themes' settings actually say. The
 * published theme decides; only when it says "off" do the unpublished and
 * development themes get a look, which is how "draft" is reached.
 * Returns "unknown" — never throws — when nothing can be read.
 */
async function embedStatusFromTheme(shopDomain: string, fresh: boolean): Promise<EmbedDetail> {
  // Operator kill-switch for the themes query (rate limits, or a shop whose
  // grant predates read_themes).
  if (!runtimeConfig().embedStatusEnabled) return { status: "unknown", themeName: null };
  if (!fresh) {
    const hit = cache().get(shopDomain);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.detail;
  }

  let detail: EmbedDetail = { status: "unknown", themeName: null };
  try {
    const { admin } = await unauthenticated.admin(shopDomain);
    const response = await admin.graphql(THEME_SETTINGS_QUERY);
    const body = (await response.json()) as ThemeSettingsResponse;
    const content = body.data?.themes?.nodes?.[0]?.files?.nodes?.[0]?.body?.content;
    if (typeof content === "string") {
      detail = { status: safeParse(content), themeName: null };
    }
    // Missing scope / no MAIN theme / non-text body → stays "unknown".
    if (detail.status === "off") {
      const draft = await draftThemeWithEmbed(admin);
      if (draft) detail = { status: "draft", themeName: draft };
    }
  } catch (error) {
    // Scope errors, throttles, JSON parse failures — all resolve to "unknown".
    logError("embed_status_error", error, { shopDomain });
    detail = { status: "unknown", themeName: null };
  }

  // A fresh read still refills the cache, so the dashboard poll benefits from
  // whatever the merchant's own page load just proved.
  cache().set(shopDomain, { detail, at: Date.now() });
  return detail;
}

/**
 * Name of the first unpublished/development theme carrying an ENABLED embed,
 * or null. Only called once the published theme has already said "off".
 */
async function draftThemeWithEmbed(admin: {
  graphql: (query: string) => Promise<{ json: () => Promise<unknown> }>;
}): Promise<string | null> {
  const response = await admin.graphql(OTHER_THEMES_QUERY);
  const body = (await response.json()) as ThemeSettingsResponse;
  for (const theme of body.data?.themes?.nodes ?? []) {
    const content = theme.files?.nodes?.[0]?.body?.content;
    if (safeParse(content) === "on") return theme.name?.trim() || "your draft theme";
  }
  return null;
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
