import { unauthenticated } from "../shopify.server";
import { assertShopDomain } from "./tenancy.server";

// Theme app-embed detection (spec 13): reads the published (MAIN) theme's
// config/settings_data.json via the Admin GraphQL theme files API and looks
// for our "chat-widget" app-embed block. Requires the read_themes scope —
// which this app deliberately does NOT request (scope additions force a
// merchant re-auth; see shopify.app.toml). Without it the query returns no
// data and this resolves to "unknown" — never throws. The dashboard renders
// the unknown state as a "Verify in theme editor" link.

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
  // The themes query needs read_themes, which the app deliberately doesn't
  // request yet — skip the guaranteed-to-fail Admin call (rate-limit + log
  // noise, review m3) until the flag is enabled alongside the scope.
  if (process.env.EMBED_STATUS_ENABLED !== "1") return "unknown";
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
    console.error("embed_status_error", shopDomain, error);
    status = "unknown";
  }

  cache().set(shopDomain, { status, at: Date.now() });
  return status;
}

/** Test/QA hook: drop the cached status for a shop. */
export function invalidateEmbedStatus(shopDomain: string): void {
  cache().delete(shopDomain);
}
