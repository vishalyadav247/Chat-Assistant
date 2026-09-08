import { Prisma } from "@prisma/client";
import db from "../../db.server";
import { unauthenticated } from "../../shopify.server";
import { recordEvent } from "../analytics/events.server";
import { getQuota } from "../billing/plans.server";
import { bonusQuota } from "../billing/quota-grants.server";
import { productEmbeddingText } from "../embeddings/embedding.server";
import { requireShopId } from "../tenancy.server";
import {
  buildMetafieldText,
  embedProducts,
  hashText,
  loadEnabledMetafields,
  parseStoredMetafields,
  refreshMetafieldUsage,
  resolveMetaobjectRefs,
  syncMetafieldDefinitions,
  toStoredMetafield,
  type StoredMetafield,
} from "./metafields.server";
import { logError, logWarn } from "../log.server";

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
        onlineStoreUrl
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

/**
 * Non-creating shop lookup for every webhook/job-driven entry point (QA D11):
 * a webhook or a queued sync for a domain we have no row for (never installed,
 * or already purged) must not materialise a Shop — the install/auth path
 * (install.server.ts → resolveShopId) is the only creator. Returns null →
 * caller no-ops.
 */
async function existingShopId(shopDomain: string): Promise<string | null> {
  const shop = await db.shop.findUnique({ where: { domain: shopDomain }, select: { id: true } });
  if (!shop) {
    logWarn("catalog_unknown_shop", undefined, { shopDomain });
    return null;
  }
  return requireShopId(shop.id);
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
  /** Shopify Product.onlineStoreUrl — NULL when not published to the storefront. */
  onlineStoreUrl?: string | null;
  /** On the Online Store sales channel. False = a shopper cannot open it.
   *  Omit to leave the stored value untouched (an update whose payload does not
   *  carry the field must not silently unpublish the product). */
  publishedOnline?: boolean;
  price: number;
  stock: number;
  variants?: { id: string; title: string; price: number; available: boolean }[];
  /** All product + variant metafields; undefined = leave the stored value untouched. */
  metafields?: StoredMetafield[];
}

export async function fullCatalogSync(shopDomain: string): Promise<void> {
  const shopId = await existingShopId(shopDomain);
  if (!shopId) return;
  await db.syncState.upsert({
    where: { shopId },
    update: { status: "running", errorMessage: null },
    create: { shopId, status: "running" },
  });

  try {
    const shop = await db.shop.findUnique({ where: { id: shopId }, select: { plan: true } });
    // products_synced is a CEILING, so an operator grant raises the cap while it
    // is live rather than being consumed per product (quota-grants.server.ts).
    const cap =
      getQuota(shop?.plan ?? "free", "products_synced") +
      (await bonusQuota(shopId, "products_synced"));
    const { admin } = await unauthenticated.admin(shopDomain);
    // Metaobject-reference metafields resolve to text at sync time (spec 07,
    // 2026-09-07); the cache carries gid → rendered text across pages, so a
    // metaobject shared by many products is fetched once per run.
    const enabledMetafields = await loadEnabledMetafields(shopId);
    const metaobjectCache = new Map<string, string>();
    let cursor: string | null = null;
    let total = 0;
    let capped = false;
    // Every Shopify id seen in this run — rows not in this set were deleted in
    // Shopify while a webhook was missed and are pruned after a COMPLETE run.
    const seenIds = new Set<string>();

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
              onlineStoreUrl: string | null;
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
          // NULL = not published to the Online Store. Shopify's ACTIVE status
          // does NOT imply published, and an unpublished product 404s for the
          // shopper — so recommendations must be able to exclude it.
          onlineStoreUrl: node.onlineStoreUrl ?? null,
          publishedOnline: Boolean(node.onlineStoreUrl),
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
      await resolveMetaobjectRefs(
        admin,
        products.map((p) => p.metafields),
        enabledMetafields,
        metaobjectCache,
      );
      await upsertProducts(shopId, products);
      for (const product of products) seenIds.add(product.shopifyProductId);
      total += products.length;
      cursor = !capped && page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (cursor);

    // QA D7: reconcile deletions. Only after a full, uncapped enumeration —
    // a capped run stopped paging, so "unseen" would include live products
    // beyond the cap; an error never reaches this line (throw above).
    // Mirrors deleteProductFromWebhook (the Product row is the only table the
    // delete webhook touches — embeddings live on the row itself).
    if (!capped) {
      const pruned = await db.product.deleteMany({
        where: { shopId, shopifyProductId: { notIn: [...seenIds] } },
      });
      if (pruned.count > 0) console.log(`catalog_sync_pruned ${shopDomain} products=${pruned.count}`);
    }

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
      logError("metafield_definitions_sync_error", error, { shopDomain }),
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
  const shopId = await existingShopId(shopDomain);
  if (!shopId) return;
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
    // Null when the product is not on the Online Store sales channel. This is
    // the webhook-payload equivalent of Product.onlineStoreUrl, and the reason
    // an ACTIVE product can still 404 for a shopper.
    published_at?: string | null;
    image?: { src?: string } | null;
    variants?: Array<{ price?: string; inventory_quantity?: number }>;
  };
  const shopifyProductId = p.admin_graphql_api_id ?? `gid://shopify/Product/${p.id}`;

  // QA D7: the products_synced cap applies to webhook CREATES too (updates of
  // an already-synced product always apply). getQuota is unlimited in "open"
  // enforcement mode, so this only bites once enforcement is switched on.
  const existing = await db.product.findUnique({
    where: { shopId_shopifyProductId: { shopId, shopifyProductId } },
    select: { id: true },
  });
  if (!existing) {
    const shop = await db.shop.findUnique({ where: { id: shopId }, select: { plan: true } });
    const cap =
      getQuota(shop?.plan ?? "free", "products_synced") +
      (await bonusQuota(shopId, "products_synced"));
    const count = await db.product.count({ where: { shopId } });
    if (count >= cap) {
      console.log(`product_webhook_create_capped ${shopDomain} count=${count} cap=${cap}`);
      return;
    }
  }

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
      await resolveMetaobjectRefs(admin, [metafields], await loadEnabledMetafields(shopId));
    }
  } catch (error) {
    logError("product_webhook_metafield_refetch_failed", error, { shopId });
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
      // The webhook payload carries no onlineStoreUrl, so it is OMITTED here:
      // writing null would wipe the URL the full sync stored, on every product
      // update. published_at carries the same published/not signal.
      // ABSENT means the payload did not say, so leave the stored value alone;
      // only an explicit null means "not on the Online Store". Defaulting a
      // missing field to false would unpublish the whole catalogue on the first
      // webhook that happened to omit it.
      publishedOnline: p.published_at === undefined ? undefined : Boolean(p.published_at),
      imageUrl: p.image?.src ?? null,
      price: Number.isFinite(price) ? price : 0,
      stock,
    },
  ]);
  await refreshMetafieldUsage(shopId).catch((error: unknown) =>
    logError("metafield_usage_refresh_error", error, { shopDomain }),
  );
}

export async function deleteProductFromWebhook(shopDomain: string, payload: unknown): Promise<void> {
  const shopId = await existingShopId(shopDomain);
  if (!shopId) return;
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

/** Membership is enumerated per collection — see MAX_COLLECTION_PRODUCTS. */
const COLLECTION_PRODUCTS_QUERY = `#graphql
  query CatalogSyncCollectionProducts($id: ID!, $cursor: String) {
    collection(id: $id) {
      products(first: 250, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id }
      }
    }
  }
`;

/**
 * Membership cap per collection. A collection with more members than this is
 * "everything we sell" — useless as a recommendation target, and enumerating
 * it would cost far more than it can ever be worth. The cap is logged, never
 * silent: a truncated collection still recommends, from its first N products.
 */
const MAX_COLLECTION_PRODUCTS = 2000;

/**
 * Mirror one collection's product membership into `collection_products`.
 *
 * Replace-in-a-transaction rather than upsert-and-diff: Shopify is the
 * authority on who is in a collection, and a partial write that left stale
 * members behind would recommend products that have since been pulled from the
 * collection — the exact failure a merchant would blame on the AI.
 */
async function syncCollectionMembership(
  admin: Awaited<ReturnType<typeof unauthenticated.admin>>["admin"],
  shopId: string,
  collectionId: string,
): Promise<number> {
  const ids: string[] = [];
  let cursor: string | null = null;
  let capped = false;
  do {
    const response = await admin.graphql(COLLECTION_PRODUCTS_QUERY, {
      variables: { id: collectionId, cursor },
    });
    const body = (await response.json()) as {
      data: {
        collection: {
          products: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: Array<{ id: string }>;
          };
        } | null;
      };
    };
    const page = body.data.collection?.products;
    if (!page) break;
    for (const node of page.nodes) ids.push(node.id);
    if (ids.length >= MAX_COLLECTION_PRODUCTS) {
      capped = true;
      break;
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  if (capped) {
    ids.length = MAX_COLLECTION_PRODUCTS;
    console.log(
      `collection_membership_capped shop=${shopId} collection=${collectionId} cap=${MAX_COLLECTION_PRODUCTS}`,
    );
  }

  await db.$transaction([
    db.collectionProduct.deleteMany({ where: { shopId, collectionId } }),
    db.collectionProduct.createMany({
      data: ids.map((shopifyProductId) => ({ shopId, collectionId, shopifyProductId })),
      skipDuplicates: true,
    }),
  ]);
  return ids.length;
}

/**
 * Refresh ONE collection's membership (COLLECTIONS_UPDATE). The webhook
 * payload carries no products, and re-enumerating them is far too slow for a
 * webhook handler's 5s budget — so the handler enqueues this instead.
 */
export async function syncCollectionMembershipFromWebhook(
  shopDomain: string,
  collectionId: string,
): Promise<void> {
  const shopId = await existingShopId(shopDomain);
  if (!shopId) return;
  const { admin } = await unauthenticated.admin(shopDomain);
  await syncCollectionMembership(admin, shopId, collectionId);
}

export async function fullCollectionSync(shopDomain: string): Promise<void> {
  const shopId = await existingShopId(shopDomain);
  if (!shopId) return;
  const { admin } = await unauthenticated.admin(shopDomain);
  let cursor: string | null = null;
  let total = 0;
  let members = 0;
  const seenIds = new Set<string>();

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
      seenIds.add(node.id);
      total++;
      // Membership, so collection-targeted recommendations can resolve to
      // actual products. Enumerated per collection rather than nested in the
      // page query above: 100 collections × 250 products in one request would
      // blow the GraphQL cost budget.
      members += await syncCollectionMembership(admin, shopId, node.id);
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  // QA D7: prune collections deleted in Shopify (full enumeration completed —
  // any GraphQL error throws out of the loop before reaching this line).
  // Mirrors the COLLECTIONS_DELETE webhook (deleteMany on the Collection row).
  const pruned = await db.collection.deleteMany({
    where: { shopId, shopifyCollectionId: { notIn: [...seenIds] } },
  });
  // Membership of a pruned collection has to go with it, or a recommendation
  // would keep resolving through a collection that no longer exists.
  await db.collectionProduct.deleteMany({
    where: { shopId, collectionId: { notIn: [...seenIds] } },
  });
  if (pruned.count > 0) console.log(`collection_sync_pruned ${shopDomain} collections=${pruned.count}`);

  await db.syncState.upsert({
    where: { shopId },
    update: { collectionSyncAt: new Date() },
    create: { shopId, collectionSyncAt: new Date() },
  });
  await recordEvent(shopId, "collection_synced", { collections: total, members });
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
  const shopId = await existingShopId(shopDomain);
  if (!shopId) return;
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
  const shopId = await existingShopId(shopDomain);
  if (!shopId) return;
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
    logError("discount_webhook_refetch_failed", error, { shopId, shopDomain });
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
  const shopId = await existingShopId(shopDomain);
  if (!shopId) return;
  const p = payload as { admin_graphql_api_id?: string };
  if (!p.admin_graphql_api_id) return;
  await db.discount.deleteMany({ where: { shopId, shopifyDiscountId: p.admin_graphql_api_id } });
}
