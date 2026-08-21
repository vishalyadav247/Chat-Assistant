import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import db from "../../db.server";
import { embedTexts, productEmbeddingText, toSqlVector } from "../embeddings/embedding.server";
import { runtimeConfig } from "../platform/runtime-config.server";
import { requireShopId } from "../tenancy.server";
import { logWarn } from "../log.server";

// Product metafields as AI training data (spec 07 → "Manage metafields",
// 2026-08-19). Catalog sync stores the product + variant metafields on the
// product row (Product.metafields JSON); the merchant opts individual
// metafields in from the modal. Only ENABLED metafields are rendered into
// Product.metafieldText, which is (a) part of productEmbeddingText() → the
// vector, (b) part of the weighted full-text index (weight C, like the
// description), (c) shown to the LLM in the candidate snippet. Toggling a
// definition therefore never needs Shopify — it re-renders from the stored
// JSON and re-embeds only the products whose text changed.
//
// STRUCTURED metafields only (user decision 2026-08-19): the catalog is
// Shopify's metafieldDefinitions(ownerType) for products + variants, and only
// metafield values that belong to a definition are stored — app-private /
// legacy "namespace.key" metafields without a definition (review widgets,
// SEO tags, feed categories…) are ignored everywhere. Merchants can promote a
// legacy metafield by adding a definition in Shopify → Settings → Custom data.

export type MetafieldOwner = "product" | "variant";

/** One synced metafield value, as stored in Product.metafields (JSON array). */
export interface StoredMetafield {
  owner: MetafieldOwner;
  /** Variant title for owner=variant ("" for product-level). */
  variant: string;
  namespace: string;
  key: string;
  type: string;
  /** Raw Shopify value (string form), capped at RAW_VALUE_CAP chars. */
  value: string;
}

/** Definition row as listed in the modal. */
export interface MetafieldDefinitionRow {
  id: string;
  ownerType: MetafieldOwner;
  namespace: string;
  key: string;
  name: string;
  type: string;
  hasDefinition: boolean;
  usedIn: number;
  enabled: boolean;
  supported: boolean;
}

const RAW_VALUE_CAP = 4000;
/** Rendered length cap per metafield and for the whole product text. */
const RENDERED_VALUE_CAP = 1500;
const TEXT_CAP = 8000;

/**
 * Metafield types the AI can learn from (rendered to plain text). Reference
 * types (product/file/metaobject/page…), JSON blobs and colors carry no
 * shopper-readable meaning without extra resolution and are listed as
 * "Not supported" (backlog: metaobject resolution).
 */
const SUPPORTED_BASE_TYPES = new Set([
  "single_line_text_field",
  "multi_line_text_field",
  "rich_text_field",
  "string", // legacy text type on old definitions, may contain HTML
  "integer", // legacy
  "number_integer",
  "number_decimal",
  "boolean",
  "date",
  "date_time",
  "url",
  "dimension",
  "volume",
  "weight",
  "rating",
  "money",
  "link",
  "color", // hex → nearest colour name (+ hex), see colorName()
]);

/** Small palette for hex → shopper-language colour names (nearest RGB). */
const COLOR_NAMES: [string, number, number, number][] = [
  ["black", 0, 0, 0], ["white", 255, 255, 255], ["gray", 128, 128, 128],
  ["silver", 192, 192, 192], ["red", 220, 20, 60], ["dark red", 139, 0, 0],
  ["orange", 255, 140, 0], ["yellow", 255, 215, 0], ["gold", 212, 175, 55],
  ["green", 34, 139, 34], ["light green", 144, 238, 144], ["olive", 128, 128, 0],
  ["teal", 0, 128, 128], ["cyan", 0, 206, 209], ["blue", 30, 100, 220],
  ["navy", 0, 0, 128], ["light blue", 135, 206, 235], ["purple", 128, 0, 128],
  ["violet", 148, 0, 211], ["pink", 255, 105, 180], ["light pink", 255, 182, 193],
  ["brown", 139, 69, 19], ["tan", 210, 180, 140], ["beige", 245, 245, 220],
  ["cream", 255, 253, 208], ["maroon", 128, 0, 0], ["coral", 255, 127, 80],
  ["turquoise", 64, 224, 208], ["lavender", 200, 180, 230], ["khaki", 195, 176, 145],
  ["burgundy", 128, 0, 32], ["mint", 152, 255, 152], ["peach", 255, 218, 185],
  ["charcoal", 54, 69, 79], ["ivory", 255, 255, 240], ["rose gold", 183, 110, 121],
];

/** "#ff0000" → "red (#ff0000)"; non-hex input is returned as-is. */
export function colorName(hex: string): string {
  const m = hex.trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return hex.trim();
  const h = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  let best = COLOR_NAMES[0];
  let bestDist = Number.POSITIVE_INFINITY;
  for (const c of COLOR_NAMES) {
    const d = (c[1] - r) ** 2 + (c[2] - g) ** 2 + (c[3] - b) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return `${best[0]} (#${h.toLowerCase()})`;
}

export function isSupportedMetafieldType(type: string): boolean {
  const base = type.startsWith("list.") ? type.slice(5) : type;
  return SUPPORTED_BASE_TYPES.has(base);
}

export function metafieldKey(owner: MetafieldOwner, namespace: string, key: string): string {
  return `${owner}:${namespace}.${key}`;
}

// ── Rendering ───────────────────────────────────────────────────────────────

/** Plain-text rendering of one metafield value ("" when nothing usable). */
export function renderMetafieldValue(type: string, raw: string): string {
  const value = raw ?? "";
  if (value.trim().length === 0) return "";
  if (type.startsWith("list.")) {
    const items = parseJson<unknown[]>(value);
    if (!Array.isArray(items)) return "";
    const base = type.slice(5);
    return items
      .map((item) => renderScalar(base, typeof item === "string" ? item : JSON.stringify(item)))
      .filter((s) => s.length > 0)
      .join(", ")
      .slice(0, RENDERED_VALUE_CAP);
  }
  return renderScalar(type, value).slice(0, RENDERED_VALUE_CAP);
}

function renderScalar(type: string, value: string): string {
  switch (type) {
    case "rich_text_field":
      return richTextToPlain(value);
    case "boolean":
      return value === "true" ? "Yes" : value === "false" ? "No" : "";
    case "dimension":
    case "volume":
    case "weight": {
      const m = parseJson<{ value?: unknown; unit?: unknown }>(value);
      return m && m.value !== undefined ? `${m.value} ${String(m.unit ?? "").toLowerCase()}`.trim() : "";
    }
    case "rating": {
      const m = parseJson<{ value?: unknown; scale_max?: unknown }>(value);
      return m && m.value !== undefined ? `${m.value}/${m.scale_max ?? 5}` : "";
    }
    case "money": {
      const m = parseJson<{ amount?: unknown; currency_code?: unknown }>(value);
      return m && m.amount !== undefined ? `${m.amount} ${m.currency_code ?? ""}`.trim() : "";
    }
    case "link": {
      const m = parseJson<{ text?: unknown; url?: unknown }>(value);
      return m ? [m.text, m.url].filter(Boolean).join(" ") : "";
    }
    case "color":
      return colorName(value);
    default:
      // single/multi line text, legacy string (may be HTML), numbers, dates, urls.
      return collapse(stripHtml(value));
  }
}

/** Shopify rich_text_field JSON → paragraphs joined by newlines. */
function richTextToPlain(value: string): string {
  const root = parseJson<RichNode>(value);
  if (!root) return collapse(stripHtml(value));
  const lines: string[] = [];
  const walk = (node: RichNode, prefix = ""): void => {
    if (!node) return;
    if (node.type === "text") {
      lines.push(prefix + String(node.value ?? ""));
      return;
    }
    if (node.type === "list-item") {
      const text = inlineText(node);
      if (text) lines.push(`${prefix}- ${text}`);
      return;
    }
    if (node.type === "paragraph" || node.type === "heading") {
      const text = inlineText(node);
      if (text) lines.push(prefix + text);
      return;
    }
    for (const child of node.children ?? []) walk(child, prefix);
  };
  walk(root);
  // Merchants paste HTML into rich-text nodes too — strip it per line.
  return lines
    .map((line) => collapse(stripHtml(line)))
    .filter((line) => line.length > 0)
    .join("\n");
}

interface RichNode {
  type?: string;
  value?: unknown;
  children?: RichNode[];
}

function inlineText(node: RichNode): string {
  const parts: string[] = [];
  const walk = (n: RichNode): void => {
    if (n.type === "text") parts.push(String(n.value ?? ""));
    for (const child of n.children ?? []) walk(child);
  };
  walk(node);
  return parts.join("").replace(/\s+/g, " ").trim();
}

function parseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, " ");
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Text block for the ENABLED metafields of one product: one "Name: value" line
 * per product metafield, "Variant <title> — Name: value" per variant metafield.
 * Deterministic order (owner, then key) so contentHash is stable.
 */
export function buildMetafieldText(
  entries: StoredMetafield[] | null | undefined,
  enabled: Map<string, { name: string; type: string }>,
): string {
  if (!entries || entries.length === 0 || enabled.size === 0) return "";
  const lines: string[] = [];
  const sorted = [...entries].sort((a, b) =>
    a.owner === b.owner
      ? metafieldKey(a.owner, a.namespace, a.key).localeCompare(metafieldKey(b.owner, b.namespace, b.key))
      : a.owner === "product"
        ? -1
        : 1,
  );
  for (const entry of sorted) {
    const def = enabled.get(metafieldKey(entry.owner, entry.namespace, entry.key));
    if (!def || !isSupportedMetafieldType(def.type)) continue;
    const text = renderMetafieldValue(entry.type || def.type, entry.value);
    if (!text) continue;
    lines.push(
      entry.owner === "variant" && entry.variant
        ? `Variant ${entry.variant} — ${def.name}: ${text}`
        : `${def.name}: ${text}`,
    );
  }
  return lines.join("\n").slice(0, TEXT_CAP);
}

/** Enabled definitions for a shop, keyed by owner:namespace.key. */
export async function loadEnabledMetafields(
  shopId: string,
): Promise<Map<string, { name: string; type: string }>> {
  const rows = await db.productMetafieldDefinition.findMany({
    where: { shopId, enabled: true },
    select: { ownerType: true, namespace: true, key: true, name: true, type: true },
  });
  return new Map(
    rows.map((r) => [
      metafieldKey(r.ownerType as MetafieldOwner, r.namespace, r.key),
      { name: r.name, type: r.type },
    ]),
  );
}

/** Normalize a Shopify metafield node into the stored shape. Drops empties
 *  and — structured-only rule — nodes without a definition. */
export function toStoredMetafield(
  owner: MetafieldOwner,
  variant: string,
  node: {
    namespace: string;
    key: string;
    type: string;
    value: string | null;
    definition?: { id: string } | null;
  },
): StoredMetafield | null {
  if (!node.definition) return null;
  const value = String(node.value ?? "").slice(0, RAW_VALUE_CAP);
  if (value.trim().length === 0) return null;
  return { owner, variant, namespace: node.namespace, key: node.key, type: node.type, value };
}

/** Parse Product.metafields JSON back into typed entries (tolerant). */
export function parseStoredMetafields(json: unknown): StoredMetafield[] {
  if (!Array.isArray(json)) return [];
  return (json as Partial<StoredMetafield>[])
    .filter((m) => m && typeof m.namespace === "string" && typeof m.key === "string")
    .map((m) => ({
      owner: m.owner === "variant" ? "variant" : "product",
      variant: typeof m.variant === "string" ? m.variant : "",
      namespace: m.namespace as string,
      key: m.key as string,
      type: typeof m.type === "string" ? m.type : "single_line_text_field",
      value: typeof m.value === "string" ? m.value : "",
    }));
}

// ── Definitions catalog ─────────────────────────────────────────────────────

const DEFINITIONS_QUERY = `#graphql
  query MetafieldDefinitions($ownerType: MetafieldOwnerType!, $cursor: String) {
    metafieldDefinitions(ownerType: $ownerType, first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { namespace key name type { name } }
    }
  }
`;

/**
 * Refresh the per-shop metafield catalog: Shopify definitions (names/types)
 * for products + variants, with "used in N products" counts computed from the
 * synced rows. Never resets the merchant's enable flags; definitions deleted
 * in Shopify are dropped here too.
 */
export async function syncMetafieldDefinitions(
  shopDomain: string,
  shopId: string,
): Promise<{ removedEnabled: boolean }> {
  requireShopId(shopId);
  const { unauthenticated } = await import("../../shopify.server");
  const { admin } = await unauthenticated.admin(shopDomain);

  const defined = new Map<
    string,
    { owner: MetafieldOwner; namespace: string; key: string; name: string; type: string }
  >();
  for (const [owner, ownerType] of [
    ["product", "PRODUCT"],
    ["variant", "PRODUCTVARIANT"],
  ] as const) {
    let cursor: string | null = null;
    do {
      const response = await admin.graphql(DEFINITIONS_QUERY, { variables: { ownerType, cursor } });
      const body = (await response.json()) as {
        data: {
          metafieldDefinitions: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: Array<{ namespace: string; key: string; name: string; type: { name: string } }>;
          };
        };
      };
      const page = body.data.metafieldDefinitions;
      for (const node of page.nodes) {
        defined.set(metafieldKey(owner, node.namespace, node.key), {
          owner,
          namespace: node.namespace,
          key: node.key,
          name: node.name || `${node.namespace}.${node.key}`,
          type: node.type.name,
        });
      }
      cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (cursor);
  }

  const usage = await metafieldUsage(shopId);

  for (const [k, def] of defined) {
    const count = usage.get(k)?.count ?? 0;
    await db.productMetafieldDefinition.upsert({
      where: {
        shopId_ownerType_namespace_key: {
          shopId, ownerType: def.owner, namespace: def.namespace, key: def.key,
        },
      },
      update: { name: def.name, type: def.type, hasDefinition: true, usedIn: count },
      create: {
        shopId,
        ownerType: def.owner,
        namespace: def.namespace,
        key: def.key,
        name: def.name,
        type: def.type,
        hasDefinition: true,
        usedIn: count,
      },
    });
  }

  // Definitions gone from Shopify (or legacy undefined rows) → drop the row.
  const stale = await db.productMetafieldDefinition.findMany({
    where: { shopId },
    select: { id: true, ownerType: true, namespace: true, key: true, enabled: true },
  });
  const staleRows = stale.filter(
    (r) => !defined.has(metafieldKey(r.ownerType as MetafieldOwner, r.namespace, r.key)),
  );
  if (staleRows.length > 0) {
    await db.productMetafieldDefinition.deleteMany({
      where: { shopId, id: { in: staleRows.map((r) => r.id) } },
    });
  }

  await db.syncState.upsert({
    where: { shopId },
    update: { metafieldSyncAt: new Date() },
    create: { shopId, metafieldSyncAt: new Date() },
  });
  // Callers re-render product text (applyMetafieldSelection) when an ENABLED
  // definition disappeared, so its lines leave the embeddings/index too.
  return { removedEnabled: staleRows.some((r) => r.enabled) };
}

/** Distinct owner:namespace.key → count of products carrying it. */
async function metafieldUsage(shopId: string): Promise<Map<string, { count: number }>> {
  const rows = await db.$queryRaw<
    { owner: string; namespace: string; key: string; count: number }[]
  >(Prisma.sql`
    SELECT m->>'owner' AS owner, m->>'namespace' AS namespace, m->>'key' AS key,
           count(DISTINCT p."id")::int AS count
    FROM "products" p, jsonb_array_elements(COALESCE(p."metafields", '[]'::jsonb)) AS m
    WHERE p."shopId" = ${shopId}
    GROUP BY 1, 2, 3
  `);
  const map = new Map<string, { count: number }>();
  for (const r of rows) {
    const owner: MetafieldOwner = r.owner === "variant" ? "variant" : "product";
    map.set(metafieldKey(owner, r.namespace, r.key), { count: Number(r.count) });
  }
  return map;
}

/**
 * Cheap usage refresh after a webhook upsert (no Shopify call): recount
 * "used in" for the known definitions.
 */
export async function refreshMetafieldUsage(shopId: string): Promise<void> {
  requireShopId(shopId);
  const usage = await metafieldUsage(shopId);
  const rows = await db.productMetafieldDefinition.findMany({
    where: { shopId },
    select: { id: true, ownerType: true, namespace: true, key: true, usedIn: true },
  });
  for (const r of rows) {
    const k = metafieldKey(r.ownerType as MetafieldOwner, r.namespace, r.key);
    const count = usage.get(k)?.count ?? 0;
    if (count !== r.usedIn) {
      await db.productMetafieldDefinition.updateMany({
        where: { id: r.id, shopId },
        data: { usedIn: count },
      });
    }
  }
}

export async function listMetafieldDefinitions(shopId: string): Promise<MetafieldDefinitionRow[]> {
  requireShopId(shopId);
  const rows = await db.productMetafieldDefinition.findMany({
    where: { shopId },
    orderBy: [{ ownerType: "asc" }, { usedIn: "desc" }, { name: "asc" }],
  });
  return rows.map((r) => ({
    id: r.id,
    ownerType: r.ownerType as MetafieldOwner,
    namespace: r.namespace,
    key: r.key,
    name: r.name,
    type: r.type,
    hasDefinition: r.hasDefinition,
    usedIn: r.usedIn,
    enabled: r.enabled,
    supported: isSupportedMetafieldType(r.type),
  }));
}

// ── Applying the selection to products ──────────────────────────────────────

/**
 * Re-render metafieldText for every product of the shop from the stored JSON
 * and re-embed the ones whose embedding text changed. Runs as a job after an
 * enable/disable toggle (many products may change at once).
 */
export async function applyMetafieldSelection(shopId: string): Promise<{ changed: number }> {
  requireShopId(shopId);
  const enabled = await loadEnabledMetafields(shopId);
  const products = await db.product.findMany({
    where: { shopId },
    select: {
      id: true, title: true, description: true, productType: true, vendor: true, tags: true,
      metafields: true, metafieldText: true, contentHash: true,
    },
  });
  const toEmbed: { id: string; text: string; hash: string }[] = [];
  for (const p of products) {
    const metafieldText = buildMetafieldText(parseStoredMetafields(p.metafields), enabled);
    const text = productEmbeddingText({ ...p, metafieldText });
    const contentHash = hashText(text);
    if (metafieldText === p.metafieldText && contentHash === p.contentHash) continue;
    await db.product.updateMany({
      where: { id: p.id, shopId },
      data: { metafieldText, contentHash },
    });
    if (contentHash !== p.contentHash) toEmbed.push({ id: p.id, text, hash: contentHash });
  }
  await embedProducts(shopId, toEmbed);
  return { changed: toEmbed.length };
}

/** Shared by catalog sync + selection apply: batch-embed and write vectors. */
export async function embedProducts(
  shopId: string,
  items: { id: string; text: string }[],
): Promise<void> {
  if (items.length === 0) return;
  if (!runtimeConfig().openaiApiKey) {
    // Never silent: rows keep their previous/NULL embedding.
    logWarn("embedding_skipped", "no OPENAI_API_KEY", { shopId, products: items.length });
    const { recordEvent } = await import("../analytics/events.server");
    await recordEvent(shopId, "embedding_skipped", { products: items.length });
    return;
  }
  const BATCH = 100;
  for (let start = 0; start < items.length; start += BATCH) {
    const slice = items.slice(start, start + BATCH);
    const vectors = await embedTexts(slice.map((e) => e.text), { shopId });
    for (let i = 0; i < slice.length; i++) {
      await db.$executeRaw(Prisma.sql`
        UPDATE "products" SET "embedding" = ${toSqlVector(vectors[i])}::vector
        WHERE "id" = ${slice[i].id} AND "shopId" = ${shopId}
      `);
    }
  }
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}
