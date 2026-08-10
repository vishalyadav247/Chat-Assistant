import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import db from "../../db.server";
import { unauthenticated } from "../../shopify.server";
import { recordEvent } from "../analytics/events.server";
import { getQuota } from "../billing/plans.server";
import { embedTexts, toSqlVector } from "../embeddings/embedding.server";
import { env } from "../env.server";
import { requireShopId, resolveShopId } from "../tenancy.server";

// Catalog sync (spec 02). Full paged sync + webhook-driven single upserts.
// Re-embeds ONLY when title/description changed (contentHash).

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
          nodes { id title price availableForSale }
        }
      }
    }
  }
`;

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
                nodes: Array<{ id: string; title: string; price: string; availableForSale: boolean }>;
              };
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
  } catch (error) {
    await db.syncState.update({
      where: { shopId },
      data: { status: "error", errorMessage: String(error).slice(0, 500) },
    });
    throw error;
  }
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
  }>;
  const stock = webhookVariants.reduce((sum, v) => sum + (v.inventory_quantity ?? 0), 0);
  const price = Math.min(...(webhookVariants.length ? webhookVariants : [{ price: "0" }]).map((v) => Number(v.price ?? 0)));

  await upsertProducts(shopId, [
    {
      variants: webhookVariants
        .filter((v) => v.id)
        .map((v) => ({
          id: `gid://shopify/ProductVariant/${v.id}`,
          title: v.title ?? "",
          price: Number(v.price ?? 0),
          available: (v.inventory_quantity ?? 0) > 0,
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
}

export async function deleteProductFromWebhook(shopDomain: string, payload: unknown): Promise<void> {
  const shopId = requireShopId(await resolveShopId(shopDomain));
  const p = payload as { admin_graphql_api_id?: string; id?: number };
  const shopifyProductId = p.admin_graphql_api_id ?? `gid://shopify/Product/${p.id}`;
  await db.product.deleteMany({ where: { shopId, shopifyProductId } });
}

/** Upsert rows, then (re-)embed only those whose title+description changed. */
async function upsertProducts(shopId: string, products: SyncedProduct[]): Promise<void> {
  if (products.length === 0) return;
  const toEmbed: { id: string; text: string }[] = [];

  for (const product of products) {
    const contentHash = hash(`${product.title}\n${product.description}`);
    const { variants, ...fields } = product;
    const variantsJson = (variants ?? []) as unknown as Prisma.InputJsonValue;
    const existing = await db.product.findUnique({
      where: { shopId_shopifyProductId: { shopId, shopifyProductId: product.shopifyProductId } },
      select: { id: true, contentHash: true },
    });
    const row = await db.product.upsert({
      where: { shopId_shopifyProductId: { shopId, shopifyProductId: product.shopifyProductId } },
      update: { ...fields, variants: variantsJson, contentHash },
      create: { ...fields, variants: variantsJson, shopId, contentHash },
    });
    if (!existing || existing.contentHash !== contentHash) {
      toEmbed.push({ id: row.id, text: `${product.title}. ${product.description}` });
    }
  }

  if (toEmbed.length === 0 || !env().OPENAI_API_KEY) return;
  const vectors = await embedTexts(toEmbed.map((e) => e.text));
  for (let i = 0; i < toEmbed.length; i++) {
    await db.$executeRaw(Prisma.sql`
      UPDATE "products" SET "embedding" = ${toSqlVector(vectors[i])}::vector
      WHERE "id" = ${toEmbed[i].id} AND "shopId" = ${shopId}
    `);
  }
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
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

const DISCOUNTS_QUERY = `#graphql
  query CatalogSyncDiscounts($cursor: String) {
    discountNodes(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        discount {
          __typename
          ... on DiscountCodeBasic { title summary status startsAt endsAt }
          ... on DiscountCodeBxgy { title summary status startsAt endsAt }
          ... on DiscountCodeFreeShipping { title summary status startsAt endsAt }
          ... on DiscountAutomaticBasic { title summary status startsAt endsAt }
          ... on DiscountAutomaticBxgy { title summary status startsAt endsAt }
          ... on DiscountAutomaticFreeShipping { title summary status startsAt endsAt }
        }
      }
    }
  }
`;

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
            discount: {
              title?: string;
              summary?: string | null;
              status?: string;
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
      await db.discount.upsert({
        where: { shopId_shopifyDiscountId: { shopId, shopifyDiscountId: node.id } },
        update: {
          title: node.discount.title,
          summary: node.discount.summary ?? "",
          status: (node.discount.status ?? "active").toLowerCase(),
          startsAt: node.discount.startsAt ? new Date(node.discount.startsAt) : null,
          endsAt: node.discount.endsAt ? new Date(node.discount.endsAt) : null,
        },
        create: {
          shopId,
          shopifyDiscountId: node.id,
          title: node.discount.title,
          summary: node.discount.summary ?? "",
          status: (node.discount.status ?? "active").toLowerCase(),
          startsAt: node.discount.startsAt ? new Date(node.discount.startsAt) : null,
          endsAt: node.discount.endsAt ? new Date(node.discount.endsAt) : null,
        },
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
  // Real-time discount sync is a Pro+ feature (seam active even in open mode).
  const shop = await db.shop.findUnique({ where: { id: shopId }, select: { plan: true } });
  const { hasFeature } = await import("../billing/plans.server");
  if (!hasFeature(shop?.plan ?? "free", "discount_realtime_sync")) return;
  const p = payload as { admin_graphql_api_id?: string; title?: string; status?: string };
  if (!p.admin_graphql_api_id) return;
  await db.discount.upsert({
    where: { shopId_shopifyDiscountId: { shopId, shopifyDiscountId: p.admin_graphql_api_id } },
    update: { title: p.title ?? "", status: (p.status ?? "active").toLowerCase() },
    create: {
      shopId,
      shopifyDiscountId: p.admin_graphql_api_id,
      title: p.title ?? "",
      status: (p.status ?? "active").toLowerCase(),
    },
  });
}

export async function deleteDiscountFromWebhook(shopDomain: string, payload: unknown): Promise<void> {
  const shopId = requireShopId(await resolveShopId(shopDomain));
  const p = payload as { admin_graphql_api_id?: string };
  if (!p.admin_graphql_api_id) return;
  await db.discount.deleteMany({ where: { shopId, shopifyDiscountId: p.admin_graphql_api_id } });
}
