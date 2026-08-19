import { Prisma } from "@prisma/client";
import db from "../../db.server";
import { unauthenticated } from "../../shopify.server";
import { recordEvent } from "../analytics/events.server";
import { getQuota } from "../billing/plans.server";
import { productEmbeddingText } from "../embeddings/embedding.server";
import { requireShopId, resolveShopId } from "../tenancy.server";
import {
  buildMetafieldText,
  embedProducts,
  hashText,
  loadEnabledMetafields,
  parseStoredMetafields,
  refreshMetafieldUsage,
  syncMetafieldDefinitions,
  toStoredMetafield,
  type StoredMetafield,
} from "./metafields.server";

// Catalog sync (spec 02). Full paged sync + webhook-driven single upserts.
// Re-embeds ONLY when the embedding text (title/type/vendor/tags/description/
// enabled metafields) changed — contentHash over productEmbeddingText().
// Every product + variant metafield is stored (Product.metafields) so the
// Manage metafields modal can enable/disable without another Shopify call.

const PRODUCTS_QUERY = `#graphql
  query CatalogSyncProducts($cursor: String) {
    products(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        description
        productType
        vendor
        tags
        status
        handle
        featuredMedia { preview { image { url } } }
        priceRangeV2 { minVariantPrice { amount } }
        totalInventory
        variants(first: 10) {
          nodes {
            id title price availableForSale
            metafields(first: 30) { nodes { namespace key type value definition { id } } }
          }
        }
        metafields(first: 100) { nodes { namespace key type value definition { id } } }
      }
    }
  }
`;

/** Webhook payloads carry no metafields — refetch them for one product. */
const PRODUCT_METAFIELDS_QUERY = `#graphql
  query CatalogSyncProductMetafields($id: ID!) {
    product(id: $id) {
      metafields(first: 100) { nodes { namespace key type value definition { id } } }
      variants(first: 10) {
        nodes { title metafields(first: 30) { nodes { namespace key type value definition { id } } } }
      }
    }
  }
`;

interface MetafieldNode {
  namespace: string;
  key: string;
  type: string;
  value: string | null;
  /** null = no metafield definition → ignored (structured-only rule). */
  definition: { id: string } | null;
}

/** Flatten product + variant metafield nodes into the stored shape. */
function collectMetafields(
  productNodes: MetafieldNode[] | undefined,
  variants: Array<{ title: string; metafields?: { nodes: MetafieldNode[] } }> | undefined,
): StoredMetafield[] {
  const out: StoredMetafield[] = [];
  for (const node of productNodes ?? []) {
    const stored = toStoredMetafield("product", "", node);
    if (stored) out.push(stored);
  }
  for (const variant of variants ?? []) {
    for (const node of variant.metafields?.nodes ?? []) {
      const stored = toStoredMetafield("variant", variant.title, node);
      if (stored) out.push(stored);
    }
  }
  return out;
}

interface SyncedProduct {
  shopifyProductId: string;
  title: string;
  description: string;
  productType: string;
  vendor: string;
  tags: string[];
  status: string;
  handle: string;
  imageUrl: string | null;
  price: number;
  stock: number;
  variants?: { id: string; title: string; price: number; available: boolean }[];
  /** All product + variant metafields; undefined = leave the stored value untouched. */
  metafields?: StoredMetafield[];
}

export async function fullCatalogSync(shopDomain: string): Promise<void> {
  const shopId = requireShopId(await resolveShopId(shopDomain));
  await db.syncState.upsert({
    where: { shopId },
    update: { status: "running", errorMessage: null },
    create: { shopId, status: "running" },
  });

  try {
    const shop = await db.shop.findUnique({ where: { id: shopId }, select: { plan: true } });
    const cap = getQuota(shop?.plan ?? "free", "products_synced");
    const { admin } = await unauthenticated.admin(shopDomain);
    let cursor: string | null = null;
    let total = 0;
    let capped = false;

    do {
      const response = await admin.graphql(PRODUCTS_QUERY, { variables: { cursor } });
      const body = (await response.json()) as {
        data: {
          products: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: Array<{
              id: string;
              title: string;
              description: string | null;
              productType: string | null;
              vendor: string | null;
              tags: string[];
              status: string;
              handle: string;
              featuredMedia: { preview: { image: { url: string } | null } | null } | null;
              priceRangeV2: { minVariantPrice: { amount: string } };
              totalInventory: number | null;
              variants: {
                nodes: Array<{
                  id: string;
                  title: string;
                  price: string;
                  availableForSale: boolean;
                  metafields: { nodes: MetafieldNode[] };
                }>;
              };
              metafields: { nodes: MetafieldNode[] };
            }>;
          };
        };
      };

      const page = body.data.products;
      let nodes = page.nodes;
      if (total + nodes.length > cap) {
        nodes = nodes.slice(0, Math.max(0, cap - total));
        capped = true;
      }
      const products = nodes.map(
        (node): SyncedProduct => ({
          shopifyProductId: node.id,
          title: node.title,
          description: node.description ?? "",
          productType: node.productType ?? "",
          vendor: node.vendor ?? "",
          tags: node.tags ?? [],
          status: node.status.toLowerCase(),
          handle: node.handle,
          imageUrl: node.featuredMedia?.preview?.image?.url ?? null,
          price: Number(node.priceRangeV2.minVariantPrice.amount),
          stock: node.totalInventory ?? 0,
          variants: node.variants.nodes.map((v) => ({
            id: v.id,
            title: v.title,
            price: Number(v.price),
            available: v.availableForSale,
          })),
          metafields: collectMetafields(node.metafields.nodes, node.variants.nodes),
        }),
      );
      await upsertProducts(shopId, products);
      total += products.length;
      cursor = !capped && page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (cursor);

    await db.syncState.update({
      where: { shopId },
      data: {
        status: "idle",
        productSyncAt: new Date(),
        productCount: total,
        cappedAt: capped ? total : null,
      },
    });
    await recordEvent(shopId, "catalog_synced", { products: total, capped });
    // Refresh the metafield catalog (definitions + "used in" counts) from the
    // freshly synced rows; failures here must not fail the product sync.
    await syncMetafieldDefinitions(shopDomain, shopId).catch((error: unknown) =>
      console.error("metafield_definitions_sync_error", shopDomain, error),
    );
  } catch (error) {
    await db.syncState.update({
      where: { shopId },
      data: { status: "error", errorMessage: String(error).slice(0, 500) },
    });
    throw error;
  }
}

/**
 * Catalog auto sync gate (Products / Collections tabs toggle, 2026-08-17):
 * plan feature `catalog_auto_sync` AND the merchant's ShopSettings toggle.
 * Governs ONLY the daily full reconcile (user decision 2026-08-17): Shopify
 * webhooks (create/update/delete) always apply immediately, and the manual
 * "Sync now" button always works.
 */
export async function catalogAutoSyncAllowed(
  shopId: string,
  type: "products" | "collections",
): Promise<boolean> {
  const shop = await db.shop.findUnique({ where: { id: shopId }, select: { plan: true } });
  const { hasFeature } = await import("../billing/plans.server");
  if (!hasFeature(shop?.plan ?? "free", "catalog_auto_sync")) return false;
  const { loadShopSettings } = await import("../settings/save.server");
  return (await loadShopSettings(shopId)).catalogAutoSync[type];
}

export async function upsertProductFromWebhook(shopDomain: string, payload: unknown): Promise<void> {
  const shopId = requireShopId(await resolveShopId(shopDomain));
  const p = payload as {
    admin_graphql_api_id?: string;
    id?: number;
    title?: string;
    body_html?: string;
    product_type?: string;
    vendor?: string;
    tags?: string;
    status?: string;
    handle?: string;
    image?: { src?: string } | null;
    variants?: Array<{ price?: string; inventory_quantity?: number }>;
  };
  const shopifyProductId = p.admin_graphql_api_id ?? `gid://shopify/Product/${p.id}`;
  const description = stripHtml(p.body_html ?? "");
  const webhookVariants = (p.variants ?? []) as Array<{
    id?: number;
    title?: string;
    price?: string;
    inventory_quantity?: number;
    inventory_management?: string | null;
    inventory_policy?: string;
  }>;
  const stock = webhookVariants.reduce((sum, v) => sum + (v.inventory_quantity ?? 0), 0);
  const price = Math.min(...(webhookVariants.length ? webhookVariants : [{ price: "0" }]).map((v) => Number(v.price ?? 0)));

  // Metafields aren't in the webhook payload: refetch them so metafield edits
  // (which also fire products/update) reach the AI. On failure keep the stored
  // metafields (undefined = untouched) rather than wiping them.
  let metafields: StoredMetafield[] | undefined;
  try {
    const { admin } = await unauthenticated.admin(shopDomain);
    const response = await admin.graphql(PRODUCT_METAFIELDS_QUERY, {
      variables: { id: shopifyProductId },
    });
    const body = (await response.json()) as {
      data: {
        product: {
          metafields: { nodes: MetafieldNode[] };
          variants: { nodes: Array<{ title: string; metafields: { nodes: MetafieldNode[] } }> };
        } | null;
      };
    };
    if (body.data?.product) {
      metafields = collectMetafields(
        body.data.product.metafields.nodes,
        body.data.product.variants.nodes,
      );
    }
  } catch (error) {
    console.error("product webhook metafield refetch failed", error);
  }

  await upsertProducts(shopId, [
    {
      metafields,
      variants: webhookVariants
        .filter((v) => v.id)
        .map((v) => ({
          id: `gid://shopify/ProductVariant/${v.id}`,
          title: v.title ?? "",
          price: Number(v.price ?? 0),
          // Mirrors availableForSale: sellable when quantity remains, inventory
          // is untracked, or the variant oversells (inventory_policy "continue").
          available:
            (v.inventory_quantity ?? 0) > 0 ||
            v.inventory_management == null ||
            v.inventory_policy === "continue",
        })),
      shopifyProductId,
      title: p.title ?? "",
      description,
      productType: p.product_type ?? "",
      vendor: p.vendor ?? "",
      tags: (p.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean),
      status: (p.status ?? "active").toLowerCase(),
      handle: p.handle ?? "",
      imageUrl: p.image?.src ?? null,
      price: Number.isFinite(price) ? price : 0,
      stock,
    },
  ]);
  await refreshMetafieldUsage(shopId).catch((error: unknown) =>
    console.error("metafield_usage_refresh_error", shopDomain, error),
  );
}

export async function deleteProductFromWebhook(shopDomain: string, payload: unknown): Promise<void> {
  const shopId = requireShopId(await resolveShopId(shopDomain));
  const p = payload as { admin_graphql_api_id?: string; id?: number };
  const shopifyProductId = p.admin_graphql_api_id ?? `gid://shopify/Product/${p.id}`;
  await db.product.deleteMany({ where: { shopId, shopifyProductId } });
}

/** Upsert rows, then (re-)embed only those whose embedding text changed. */
async function upsertProducts(shopId: string, products: SyncedProduct[]): Promise<void> {
  if (products.length === 0) return;
  const enabledMetafields = await loadEnabledMetafields(shopId);
  const toEmbed: { id: string; text: string }[] = [];

  for (const product of products) {
    const { variants, metafields, ...fields } = product;
    const variantsJson = (variants ?? []) as unknown as Prisma.InputJsonValue;
    const existing = await db.product.findUnique({
      where: { shopId_shopifyProductId: { shopId, shopifyProductId: product.shopifyProductId } },
      select: { id: true, contentHash: true, metafields: true },
    });
    // Webhook path without a successful refetch keeps the stored metafields.
    const storedMetafields =
      metafields ?? (existing ? parseStoredMetafields(existing.metafields) : []);
    const metafieldText = buildMetafieldText(storedMetafields, enabledMetafields);
    const embeddingText = productEmbeddingText({ ...product, metafieldText });
    const contentHash = hashText(embeddingText);
    const metafieldsJson = storedMetafields as unknown as Prisma.InputJsonValue;
    const row = await db.product.upsert({
      where: { shopId_shopifyProductId: { shopId, shopifyProductId: product.shopifyProductId } },
      update: {
        ...fields, variants: variantsJson, metafields: metafieldsJson, metafieldText, contentHash,
      },
      create: {
        ...fields, variants: variantsJson, metafields: metafieldsJson, metafieldText, shopId, contentHash,
      },
    });
    if (!existing || existing.contentHash !== contentHash) {
      toEmbed.push({ id: row.id, text: embeddingText });
    }
  }

  await embedProducts(shopId, toEmbed);
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

// ── Collections ─────────────────────────────────────────────────────────────

const COLLECTIONS_QUERY = `#graphql
  query CatalogSyncCollections($cursor: String) {
    collections(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        description
        productsCount { count }
        ruleSet { rules { column relation condition } }
      }
    }
  }
`;

export async function fullCollectionSync(shopDomain: string): Promise<void> {
  const shopId = requireShopId(await resolveShopId(shopDomain));
  const { admin } = await unauthenticated.admin(shopDomain);
  let cursor: string | null = null;
  let total = 0;

  do {
    const response = await admin.graphql(COLLECTIONS_QUERY, { variables: { cursor } });
    const body = (await response.json()) as {
      data: {
        collections: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: Array<{
            id: string;
            title: string;
            description: string | null;
            productsCount: { count: number } | null;
            ruleSet: { rules: unknown[] } | null;
          }>;
        };
      };
    };
    const page = body.data.collections;
    for (const node of page.nodes) {
      await db.collection.upsert({
        where: { shopId_shopifyCollectionId: { shopId, shopifyCollectionId: node.id } },
        update: {
          title: node.title,
          description: node.description ?? "",
          productCount: node.productsCount?.count ?? 0,
          conditions: node.ruleSet ? `Automated (${node.ruleSet.rules.length} rules)` : "Manual",
        },
        create: {
          shopId,
          shopifyCollectionId: node.id,
          title: node.title,
          description: node.description ?? "",
          productCount: node.productsCount?.count ?? 0,
          conditions: node.ruleSet ? `Automated (${node.ruleSet.rules.length} rules)` : "Manual",
        },
      });
      total++;
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  await db.syncState.upsert({
    where: { shopId },
    update: { collectionSyncAt: new Date() },
    create: { shopId, collectionSyncAt: new Date() },
  });
  await recordEvent(shopId, "collection_synced", { collections: total });
}

// ── Discounts ───────────────────────────────────────────────────────────────

const DISCOUNT_FIELDS = `
          __typename
          ... on DiscountCodeBasic { title summary status startsAt endsAt discountClasses asyncUsageCount }
          ... on DiscountCodeBxgy { title summary status startsAt endsAt discountClasses asyncUsageCount }
          ... on DiscountCodeFreeShipping { title summary status startsAt endsAt discountClasses asyncUsageCount }
          ... on DiscountAutomaticBasic { title summary status startsAt endsAt discountClasses asyncUsageCount }
          ... on DiscountAutomaticBxgy { title summary status startsAt endsAt discountClasses asyncUsageCount }
          ... on DiscountAutomaticFreeShipping { title summary status startsAt endsAt discountClasses asyncUsageCount }
`;

const DISCOUNTS_QUERY = `#graphql
  query CatalogSyncDiscounts($cursor: String) {
    discountNodes(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        discount { ${DISCOUNT_FIELDS} }
      }
    }
  }
`;

const DISCOUNT_NODE_QUERY = `#graphql
  query CatalogSyncDiscountNode($id: ID!) {
    discountNode(id: $id) {
      id
      discount { ${DISCOUNT_FIELDS} }
    }
  }
`;

interface DiscountPayload {
  __typename?: string;
  title?: string;
  summary?: string | null;
  status?: string;
  startsAt?: string | null;
  endsAt?: string | null;
  discountClasses?: string[];
  asyncUsageCount?: number;
}

/** Row fields shared by full sync and the real-time webhook path. Method and
 *  display type come from the GraphQL typename + discountClasses (spec 07
 *  Discounts table: Code/Automatic × Amount off order/products, Free shipping,
 *  Buy X get Y). */
function discountRowFields(d: DiscountPayload) {
  const typename = d.__typename ?? "";
  return {
    title: d.title ?? "",
    summary: d.summary ?? "",
    status: (d.status ?? "active").toLowerCase(),
    method: typename.startsWith("DiscountAutomatic") ? "automatic" : "code",
    discountType: typename.includes("Bxgy")
      ? "bxgy"
      : typename.includes("FreeShipping")
        ? "free_shipping"
        : d.discountClasses?.includes("PRODUCT")
          ? "amount_off_products"
          : "amount_off_order",
    usedCount: d.asyncUsageCount ?? 0,
    startsAt: d.startsAt ? new Date(d.startsAt) : null,
    endsAt: d.endsAt ? new Date(d.endsAt) : null,
  };
}

export async function fullDiscountSync(shopDomain: string): Promise<void> {
  const shopId = requireShopId(await resolveShopId(shopDomain));
  const { admin } = await unauthenticated.admin(shopDomain);
  let cursor: string | null = null;
  let total = 0;

  do {
    const response = await admin.graphql(DISCOUNTS_QUERY, { variables: { cursor } });
    const body = (await response.json()) as {
      data: {
        discountNodes: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: Array<{
            id: string;
            discount: DiscountPayload & {
              startsAt?: string | null;
              endsAt?: string | null;
            } | null;
          }>;
        };
      };
    };
    const page = body.data.discountNodes;
    for (const node of page.nodes) {
      if (!node.discount?.title) continue;
      const fields = discountRowFields(node.discount);
      await db.discount.upsert({
        where: { shopId_shopifyDiscountId: { shopId, shopifyDiscountId: node.id } },
        update: fields,
        create: { shopId, shopifyDiscountId: node.id, ...fields },
      });
      total++;
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  await db.syncState.upsert({
    where: { shopId },
    update: { discountSyncAt: new Date() },
    create: { shopId, discountSyncAt: new Date() },
  });
  await recordEvent(shopId, "discount_synced", { discounts: total });
}

export async function upsertDiscountFromWebhook(shopDomain: string, payload: unknown): Promise<void> {
  const shopId = requireShopId(await resolveShopId(shopDomain));
  // Real-time discount sync is a Pro+ feature (seam active even in open mode)
  // AND a merchant toggle (ShopSettings.discountRealtime, Discounts tab).
  const shop = await db.shop.findUnique({ where: { id: shopId }, select: { plan: true } });
  const { hasFeature } = await import("../billing/plans.server");
  if (!hasFeature(shop?.plan ?? "free", "discount_realtime_sync")) return;
  const { loadShopSettings } = await import("../settings/save.server");
  if (!(await loadShopSettings(shopId)).discountRealtime) return;
  const p = payload as { admin_graphql_api_id?: string; title?: string; status?: string };
  if (!p.admin_graphql_api_id) return;

  // The webhook payload lacks summary/classes/usage — refetch the node so the
  // Discounts table columns (Method/Type/Used, dates) stay accurate. Falls back
  // to the payload's title/status if the Admin API call fails.
  let fields: ReturnType<typeof discountRowFields> | null = null;
  try {
    const { admin } = await unauthenticated.admin(shopDomain);
    const response = await admin.graphql(DISCOUNT_NODE_QUERY, {
      variables: { id: p.admin_graphql_api_id },
    });
    const body = (await response.json()) as {
      data: { discountNode: { discount: DiscountPayload | null } | null };
    };
    const discount = body.data.discountNode?.discount;
    if (discount?.title) fields = discountRowFields(discount);
  } catch (error) {
    console.error("discount webhook refetch failed, using payload fields", error);
  }
  const fallback = {
    title: p.title ?? "",
    status: (p.status ?? "active").toLowerCase(),
  };

  await db.discount.upsert({
    where: { shopId_shopifyDiscountId: { shopId, shopifyDiscountId: p.admin_graphql_api_id } },
    update: fields ?? fallback,
    create: {
      shopId,
      shopifyDiscountId: p.admin_graphql_api_id,
      ...(fields ?? fallback),
    },
  });
}

export async function deleteDiscountFromWebhook(shopDomain: string, payload: unknown): Promise<void> {
  const shopId = requireShopId(await resolveShopId(shopDomain));
  const p = payload as { admin_graphql_api_id?: string };
  if (!p.admin_graphql_api_id) return;
  await db.discount.deleteMany({ where: { shopId, shopifyDiscountId: p.admin_graphql_api_id } });
}
