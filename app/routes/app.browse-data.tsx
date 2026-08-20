import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { requireShopAccess } from "../lib/access.server";

// Resource route feeding the shared Browse products / Browse collections
// modals (specs 08/09/12). Loader-only JSON; every query shop-scoped via
// resolveShopId(shopDomain) — the shop identity never comes from the client.

const PAGE_SIZE = 10;
const COLLECTION_GID = /^gid:\/\/shopify\/Collection\/\d+$/;

export interface BrowseProductItem {
  id: string; // shopify product gid — the selection value
  title: string;
  imageUrl: string | null;
  price: number;
  stockLabel: string;
}

export interface BrowseCollectionItem {
  id: string; // shopify collection gid — the selection value
  title: string;
  productCount: number;
}

export interface BrowseData {
  kind: "products" | "collections";
  page: number;
  pageSize: number;
  total: number;
  currency: string;
  products: BrowseProductItem[];
  collections: BrowseCollectionItem[];
  filters: {
    vendors: string[];
    tags: string[];
    collections: { id: string; title: string }[];
  };
}

function stockLabel(stock: number, variants: unknown): string {
  const count = Array.isArray(variants) ? variants.length : 0;
  return count ? `${stock} in stock for ${count} variants` : `${stock} in stock`;
}

export const loader = async ({ request }: LoaderFunctionArgs): Promise<BrowseData> => {
  // Catalog browsing feeds the AI-agent / curated / proactive modals — not an
  // agent-role surface (spec 18 roles).
  const access = await requireShopAccess(request, { permission: "ai_agent" });
  const { shopId } = access;
  const admin = await access.getAdmin();

  const url = new URL(request.url);
  const kind = url.searchParams.get("kind") === "collections" ? "collections" : "products";
  const q = (url.searchParams.get("q") ?? "").trim();
  const vendor = (url.searchParams.get("vendor") ?? "").trim();
  const tag = (url.searchParams.get("tag") ?? "").trim();
  const collectionId = (url.searchParams.get("collectionId") ?? "").trim();
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);

  const shop = await db.shop.findUnique({ where: { id: shopId }, select: { currency: true } });
  const currency = shop?.currency ?? "USD";

  if (kind === "collections") {
    const where = {
      shopId,
      ...(q ? { title: { contains: q, mode: "insensitive" as const } } : {}),
    };
    const [total, rows] = await Promise.all([
      db.collection.count({ where }),
      db.collection.findMany({
        where,
        orderBy: { title: "asc" },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        select: { shopifyCollectionId: true, title: true, productCount: true },
      }),
    ]);
    return {
      kind,
      page,
      pageSize: PAGE_SIZE,
      total,
      currency,
      products: [],
      collections: rows.map((row) => ({
        id: row.shopifyCollectionId,
        title: row.title,
        productCount: row.productCount,
      })),
      filters: { vendors: [], tags: [], collections: [] },
    };
  }

  // The product mirror has no collection-membership table (schema 01/02), so the
  // Collection filter resolves member ids live from the Admin API (first 250).
  let memberGids: string[] | null = null;
  if (collectionId && COLLECTION_GID.test(collectionId)) {
    try {
      const response = await admin.graphql(
        `#graphql
        query BrowseCollectionProducts($id: ID!) {
          collection(id: $id) {
            products(first: 250) { nodes { id } }
          }
        }`,
        { variables: { id: collectionId } },
      );
      const body = (await response.json()) as {
        data?: { collection?: { products?: { nodes?: Array<{ id: string }> } } | null };
      };
      memberGids = body.data?.collection?.products?.nodes?.map((n) => n.id) ?? [];
    } catch (error) {
      console.error("browse_collection_filter_error", error);
      memberGids = [];
    }
  }

  const where = {
    shopId,
    ...(q ? { title: { contains: q, mode: "insensitive" as const } } : {}),
    ...(vendor ? { vendor } : {}),
    ...(tag ? { tags: { has: tag } } : {}),
    ...(memberGids ? { shopifyProductId: { in: memberGids } } : {}),
  };

  const [total, rows, vendorRows, tagRows, collectionRows] = await Promise.all([
    db.product.count({ where }),
    db.product.findMany({
      where,
      orderBy: { title: "asc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        shopifyProductId: true,
        title: true,
        imageUrl: true,
        price: true,
        stock: true,
        variants: true,
      },
    }),
    db.product.findMany({
      where: { shopId },
      select: { vendor: true },
      distinct: ["vendor"],
      orderBy: { vendor: "asc" },
      take: 100,
    }),
    db.product.findMany({ where: { shopId }, select: { tags: true }, take: 1000 }),
    db.collection.findMany({
      where: { shopId },
      orderBy: { title: "asc" },
      take: 100,
      select: { shopifyCollectionId: true, title: true },
    }),
  ]);

  const tags = [...new Set(tagRows.flatMap((r) => r.tags))].sort((a, b) => a.localeCompare(b));

  return {
    kind,
    page,
    pageSize: PAGE_SIZE,
    total,
    currency,
    products: rows.map((row) => ({
      id: row.shopifyProductId,
      title: row.title,
      imageUrl: row.imageUrl,
      price: Number(row.price),
      stockLabel: stockLabel(row.stock, row.variants),
    })),
    collections: [],
    filters: {
      vendors: vendorRows.map((r) => r.vendor).filter(Boolean),
      tags: tags.slice(0, 100),
      collections: collectionRows.map((r) => ({ id: r.shopifyCollectionId, title: r.title })),
    },
  };
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
