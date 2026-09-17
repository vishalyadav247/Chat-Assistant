import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate, useRouteError, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";
import db from "../db.server";
import { SHOWABLE_PRODUCT } from "../lib/search/showable";
import type { Prisma } from "@prisma/client";
import {
  getQuota,
  nextPlanNameForQuota,
  PlanGateError,
} from "../lib/billing/plans.server";
import { bonusQuota } from "../lib/billing/quota-grants.server";
import { loadShopSettings } from "../lib/settings/save.server";
import { shopSettingsSchema } from "../lib/settings/schemas";
import { invalidateShopConfig } from "../lib/config/shop-config.server";
import { enqueue, enqueueSync } from "../lib/jobs/queue.server";
import { JOBS } from "../lib/jobs/handlers.server";
import { KNOWLEDGE_INGEST_JOB } from "../lib/ingestion/knowledge-jobs.server";
import { rebuildContentBridge } from "../lib/ingestion/content-sync.server";
import {
  isSupportedMetafieldType,
  listMetafieldDefinitions,
  parseStoredMetafields,
  renderMetafieldValue,
  syncMetafieldDefinitions,
  type MetafieldDefinitionRow,
} from "../lib/ingestion/metafields.server";
import {
  convertLegacyPagesSources,
  createSource,
  csvByteCap,
  deleteSource,
  fetchShopPolicies,
  listSources,
  QuotaError,
  resyncSource,
  urlSourceSchema,
} from "../lib/ingestion/sources.server";
import {
  deleteCategory,
  deleteFaq,
  exportFaqCsv,
  importFaqCsv,
  listFaqTree,
  moveCategory,
  moveFaq,
  placeCategory,
  placeFaq,
  saveCategory,
  saveFaq,
  setCategoryFeatured,
  setFaqFeatured,
  type FaqCategoryData,
} from "../lib/faq/faq.server";
import { FaqManager } from "../components/FaqManager";
import { PageHeader } from "../components/ui/PageHeader";
import { TrainingProductsTab } from "../components/TrainingProductsTab";
import { TrainingCollectionsTab } from "../components/TrainingCollectionsTab";
import { TrainingContentTab } from "../components/TrainingContentTab";
import { TrainingDiscountsTab } from "../components/TrainingDiscountsTab";
import { TrainingKnowledgeTab } from "../components/TrainingKnowledgeTab";
import { createTableSource, tableMetadata, updateTableSource } from "../lib/lookup/lookup-import.server";
import { COLUMN_ROLES, MAX_TABLE_COLUMNS, TABLE_DESCRIPTION_MAX, type ColumnRole } from "../lib/lookup/lookup-shared";
import { requireShopAccess } from "../lib/access.server";
import { routeError } from "../lib/ui/route-error";
import { APP_NAME } from "./app";

// Training data (spec 07, design ai-agent.html #viewTraining): seven tabs via
// ?tab= — Products / Collections / Pages / Blogs (spec 22) / Discounts / FAQs /
// Custom knowledge.
// All reads and writes are shop-scoped via resolveShopId(shopDomain).

export type TrainingTab =
  | "products"
  | "collections"
  | "pages"
  | "blogs"
  | "discounts"
  | "faqs"
  | "knowledge";

export interface ProductRow {
  id: string;
  shopifyProductId: string;
  title: string;
  imageUrl: string | null;
  tags: string[];
  status: string;
  learnEnabled: boolean;
  /** Why the AI can't learn this product whatever its switch says (draft,
   *  archived, not on the Online Store) — the SHOWABLE_PRODUCT rule the
   *  dashboard and the chat use. null = learnable. */
  notLearnable: string | null;
}

export interface CollectionRow {
  id: string;
  title: string;
  description: string;
  conditions: string;
  productCount: number;
  learnEnabled: boolean;
}

/** Pages tab (spec 22). Full bodies stay server-side — the table needs an excerpt. */
export interface PageRow {
  id: string;
  title: string;
  handle: string;
  excerpt: string;
  isPublished: boolean;
  updatedAt: string | null;
  learnEnabled: boolean;
}

/** Blogs tab (spec 22). */
export interface ArticleRow extends PageRow {
  blogTitle: string;
  author: string;
  tags: string[];
}

const EXCERPT_CHARS = 140;
const excerpt = (text: string) =>
  text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS).trimEnd()}…` : text;

export interface DiscountRow {
  id: string;
  title: string;
  summary: string;
  status: string;
  method: string; // code | automatic
  code: string; // redeemable code; "" for automatic discounts
  discountType: string; // amount_off_order | amount_off_products | free_shipping | bxgy
  usedCount: number;
  learnEnabled: boolean;
  startsAt: string | null;
  endsAt: string | null;
}

export interface SourceRow {
  id: string;
  // url | file | pages — plus legacy manual/csv rows (creation retired
  // with the FAQ consolidation; old rows stay listed and deletable).
  type: string;
  name: string;
  url: string | null;
  reCrawlWeekly: boolean;
  status: string; // pending | active | inactive | error
  chunkCount: number;
  lastSyncedAt: string | null;
  error: string | null;
  /** Secondary line in Manage sources: the URL, the uploaded filename, or the
   *  policy's storefront URL. */
  detail: string | null;
  /** A connected policy that was deleted/emptied in Shopify. */
  removedInShopify: boolean;
  /** Lookup tables only (spec 28): what the Edit table modal shows. */
  table?: {
    description: string;
    columns: Array<{ key: string; name: string; role: ColumnRole; samples: string[]; numeric: boolean }>;
    ranges: Array<{ name: string }>;
  };
}

export interface Meter {
  used: number;
  quota: number;
}

export interface ProductDetail {
  numericId: string;
  adminUrl: string;
  title: string;
  status: string;
  url: string;
  vendor: string;
  description: string;
  tags: string[];
  variants: { title: string; price: number; available: boolean }[];
  /** Product + variant metafields as synced; `enabled` = currently trained on. */
  metafields: { label: string; value: string; enabled: boolean }[];
}

export interface PoliciesPayload {
  candidates: { type: string; title: string; url: string; kind: "policy" | "page" }[];
  selectedTypes: string[];
}

export interface TrainingActionResult {
  intent: string;
  ok: boolean;
  message?: string;
  error?: string;
  detail?: ProductDetail;
  /** Fresh Manage-metafields rows after metafields-sync / metafield-toggle. */
  metafields?: MetafieldDefinitionRow[];
  policies?: PoliciesPayload;
  csv?: string;
  filename?: string;
  imported?: number;
  skipped?: number;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shopId, shopDomain } = await requireShopAccess(request, { permission: "ai_agent" });
  // One-time, idempotent: a legacy combined "policies & pages" row becomes one
  // row per policy BEFORE the sources are listed, so Manage sources never shows
  // it. A no-op query once a shop has none.
  await convertLegacyPagesSources(shopId);

  const [shop, products, collections, discounts, syncState, faqTree, sources, shopSettings, metafieldRows] =
    await Promise.all([
      db.shop.findUnique({
        where: { id: shopId },
        select: { plan: true, domain: true, currency: true },
      }),
      db.product.findMany({
        where: { shopId },
        orderBy: { title: "asc" },
        select: {
          id: true,
          shopifyProductId: true,
          title: true,
          imageUrl: true,
          tags: true,
          status: true,
          learnEnabled: true,
          publishedOnline: true,
        },
      }),
      db.collection.findMany({
        where: { shopId },
        orderBy: { title: "asc" },
        select: {
          id: true,
          title: true,
          description: true,
          conditions: true,
          productCount: true,
          learnEnabled: true,
        },
      }),
      db.discount.findMany({
        where: { shopId },
        orderBy: { updatedAt: "desc" },
        select: {
          id: true,
          title: true,
          summary: true,
          status: true,
          method: true,
          code: true,
          discountType: true,
          usedCount: true,
          learnEnabled: true,
          startsAt: true,
          endsAt: true,
        },
      }),
      db.syncState.findUnique({ where: { shopId } }),
      listFaqTree(shopId),
      listSources(shopId),
      loadShopSettings(shopId),
      listMetafieldDefinitions(shopId),
    ]);

  const plan = shop?.plan ?? "free";
  // Spec 22 — Pages & Blogs tabs, plus their live bonus grants so the meters
  // show what the sync actually enforces (plan cap + bonus).
  const [pages, articles, pageBonus, articleBonus] = await Promise.all([
    db.storePage.findMany({
      where: { shopId },
      orderBy: [{ isPublished: "desc" }, { title: "asc" }],
      select: {
        id: true,
        title: true,
        handle: true,
        bodyText: true,
        isPublished: true,
        shopifyUpdatedAt: true,
        learnEnabled: true,
      },
    }),
    db.blogArticle.findMany({
      where: { shopId },
      orderBy: [{ isPublished: "desc" }, { shopifyUpdatedAt: "desc" }],
      select: {
        id: true,
        title: true,
        handle: true,
        bodyText: true,
        summary: true,
        isPublished: true,
        shopifyUpdatedAt: true,
        learnEnabled: true,
        blogTitle: true,
        author: true,
        tags: true,
      },
    }),
    bonusQuota(shopId, "pages_synced"),
    bonusQuota(shopId, "articles_synced"),
  ]);
  const productBonus = await bonusQuota(shopId, "products_synced");
  // The FAQ bridge source (type=faq, spec 04) is managed from the FAQs tab —
  // hide it from the Custom knowledge table so it can't be deleted by accident.
  const knowledgeSources = sources.filter((s) => s.type !== "faq");

  const meta = (s: (typeof sources)[number]) =>
    (s.metadata ?? {}) as {
      pages?: unknown;
      pagesUsed?: unknown;
      error?: unknown;
      filename?: unknown;
      removedInShopify?: unknown;
    };

  const sourceRows: SourceRow[] = knowledgeSources.map((s) => ({
    id: s.id,
    type: s.type,
    name: s.name,
    url: s.url,
    reCrawlWeekly: s.reCrawlWeekly,
    status: s.status,
    chunkCount: s.chunkCount,
    lastSyncedAt: s.lastSyncedAt ? s.lastSyncedAt.toISOString() : null,
    error: typeof meta(s).error === "string" ? (meta(s).error as string) : null,
    detail:
      s.type === "file" || s.type === "table"
        ? typeof meta(s).filename === "string" && meta(s).filename !== s.name
          ? (meta(s).filename as string)
          : null
        : s.url && s.url !== s.name
          ? s.url
          : null,
    removedInShopify: meta(s).removedInShopify === true,
    ...(s.type === "table"
      ? (() => {
          const t = tableMetadata(s.metadata);
          return {
            table: {
              description: t.description,
              columns: t.columns.map((c) => ({ key: c.key, name: c.name, role: c.role, samples: c.samples.slice(0, 5), numeric: c.numeric })),
              ranges: t.ranges.map((r) => ({ name: r.name })),
            },
          };
        })()
      : {}),
  }));

  // Both limits count SOURCES — each URL source is one page
  // and each policy is its own source — matching what creation enforces.
  const crawlUsed = knowledgeSources.filter((s) => s.type === "url").length;
  const pagesUsed = knowledgeSources.filter((s) => s.type === "policy").length;

  return {
    shop: {
      plan,
      domain: shop?.domain ?? shopDomain,
      currency: shop?.currency ?? "USD",
    },
    products: {
      rows: products.map(({ publishedOnline, ...p }): ProductRow => ({
        ...p,
        notLearnable: productNotLearnable(p.status, publishedOnline),
      })),
      total: products.length,
      // Same rule as the dashboard (SHOWABLE_PRODUCT): a draft, archived or
      // unpublished product is not learned, whatever its switch says.
      learned: products.filter((p) => p.learnEnabled && !productNotLearnable(p.status, p.publishedOnline)).length,
    },
    // Manage metafields modal (spec 07): catalog rows + plan cap on enabled ones.
    metafields: {
      rows: metafieldRows,
      quota: getQuota(plan, "metafields_enabled"),
      lastSyncedAt: syncState?.metafieldSyncAt?.toISOString() ?? null,
    },
    collections: collections as CollectionRow[],
    pages: pages.map(
      (p): PageRow => ({
        id: p.id,
        title: p.title,
        handle: p.handle,
        excerpt: excerpt(p.bodyText),
        isPublished: p.isPublished,
        updatedAt: p.shopifyUpdatedAt?.toISOString() ?? null,
        learnEnabled: p.learnEnabled,
      }),
    ),
    articles: articles.map(
      (a): ArticleRow => ({
        id: a.id,
        title: a.title,
        handle: a.handle,
        excerpt: excerpt(a.summary || a.bodyText),
        isPublished: a.isPublished,
        updatedAt: a.shopifyUpdatedAt?.toISOString() ?? null,
        learnEnabled: a.learnEnabled,
        blogTitle: a.blogTitle,
        author: a.author,
        tags: a.tags,
      }),
    ),
    discounts: discounts.map((d) => ({
      ...d,
      startsAt: d.startsAt ? d.startsAt.toISOString() : null,
      endsAt: d.endsAt ? d.endsAt.toISOString() : null,
    })) as DiscountRow[],
    sync: {
      productSyncAt: syncState?.productSyncAt?.toISOString() ?? null,
      collectionSyncAt: syncState?.collectionSyncAt?.toISOString() ?? null,
      discountSyncAt: syncState?.discountSyncAt?.toISOString() ?? null,
      pageSyncAt: syncState?.pageSyncAt?.toISOString() ?? null,
      articleSyncAt: syncState?.articleSyncAt?.toISOString() ?? null,
      status: syncState?.status ?? "idle",
    },
    faqTree: faqTree satisfies FaqCategoryData[],
    // FAQ plan cap (faqs quota) — the FAQs tab meter + Add gate.
    // Enforced server-side in saveFaq/importFaqCsv; this is the display copy.
    faqQuota: {
      used: faqTree.reduce((sum, c) => sum + c.faqs.length, 0),
      quota: getQuota(plan, "faqs"),
      nextPlan: nextPlanNameForQuota(plan, "faqs"),
    },
    knowledge: {
      sources: sourceRows,
      chunkTotal: knowledgeSources.reduce((sum, s) => sum + s.chunkCount, 0),
      quotas: {
        crawlPages: { used: crawlUsed, quota: getQuota(plan, "crawl_pages") },
        fileUploads: {
          // A lookup table is an uploaded file too (spec 28).
          used: knowledgeSources.filter((s) => s.type === "file" || s.type === "table").length,
          quota: getQuota(plan, "file_uploads"),
        },
        lookupRows: {
          used: knowledgeSources.filter((s) => s.type === "table").reduce((sum, s) => sum + s.chunkCount, 0),
          quota: getQuota(plan, "lookup_rows"),
        },
      },
      // No policy limit — just how many are connected.
      connectedPolicies: pagesUsed,
    },
    // Master training permissions (spec 07) — the Learn card switches.
    learnMaster: shopSettings.learn,
    // Plan signals (spec 15). Names come from the LIVE matrix so a feature the
    // operator moves between tiers relabels everywhere at once.
    planSignals: {
      productsSynced: {
        used: products.length,
        // Plan cap PLUS any live bonus grant, matching what catalog-sync.server
        // actually enforces. Showing the plan number alone would tell a granted
        // merchant they were full at 200 while the sync happily ran to 700 —
        // the same display-vs-enforce split that was just removed for
        // conversations.
        quota: getQuota(plan, "products_synced") + productBonus,
        bonus: productBonus,
        nextPlan: nextPlanNameForQuota(plan, "products_synced"),
      },
      // Same shape and rule as productsSynced (spec 22).
      pagesSynced: {
        used: pages.length,
        quota: getQuota(plan, "pages_synced") + pageBonus,
        bonus: pageBonus,
        nextPlan: nextPlanNameForQuota(plan, "pages_synced"),
      },
      articlesSynced: {
        used: articles.length,
        quota: getQuota(plan, "articles_synced") + articleBonus,
        bonus: articleBonus,
        nextPlan: nextPlanNameForQuota(plan, "articles_synced"),
      },
      metafieldsNext: nextPlanNameForQuota(plan, "metafields_enabled"),
      fileUploadsNext: nextPlanNameForQuota(plan, "file_uploads"),
      // CSV size is plan-specific (csv_upload_mb, 2026-09-16); bytes, already
      // clamped to the server ceiling, so the picker checks the enforced number.
      csvMaxBytes: csvByteCap(plan),
      csvUploadNext: nextPlanNameForQuota(plan, "csv_upload_mb"),
      lookupRowsNext: nextPlanNameForQuota(plan, "lookup_rows"),
      crawlPagesNext: nextPlanNameForQuota(plan, "crawl_pages"),
    },
  };
};

// ── Action ──────────────────────────────────────────────────────────────────

const statusEnum = z.enum(["active", "inactive"]);

const urlPayloadSchema = z.object({
  // Same shape check as createSource's urlSourceSchema — editing a source used
  // to accept a schemeless/ftp URL that then failed in the job (QA D10).
  url: urlSourceSchema.shape.url,
  reCrawlWeekly: z.boolean().default(false),
  status: statusEnum.default("active"),
});

const tablePayloadSchema = z.object({
  title: z.string().trim().min(1, "Give the table a title").max(200),
  description: z.string().trim().min(1, "Say what the table is for").max(TABLE_DESCRIPTION_MAX),
  filename: z.string().trim().min(1).max(200),
  roles: z.array(z.enum(COLUMN_ROLES as [ColumnRole, ...ColumnRole[]])).min(1).max(MAX_TABLE_COLUMNS),
});

const filePayloadSchema = z.object({
  name: z.string().trim().min(1).max(200),
  /** Required — says what the file is, in Manage sources. */
  title: z.string().trim().min(1, "Give the file a title").max(200),
  mime: z.string().trim().max(200).default(""),
  dataBase64: z.string().min(1),
});

/** View-product modal rows: every synced metafield, rendered, flagged when enabled. */
async function productDetailMetafields(
  shopId: string,
  json: Prisma.JsonValue | null,
): Promise<ProductDetail["metafields"]> {
  const entries = parseStoredMetafields(json);
  if (entries.length === 0) return [];
  const defs = await db.productMetafieldDefinition.findMany({
    where: { shopId },
    select: { ownerType: true, namespace: true, key: true, name: true, enabled: true },
  });
  const byKey = new Map(defs.map((d) => [`${d.ownerType}:${d.namespace}.${d.key}`, d]));
  return entries
    .map((m) => {
      const def = byKey.get(`${m.owner}:${m.namespace}.${m.key}`);
      const name = def?.name ?? `${m.namespace}.${m.key}`;
      const value = renderMetafieldValue(m.type, m.value, m.resolved) || m.value.slice(0, 200);
      return {
        label: m.owner === "variant" && m.variant ? `${name} (${m.variant})` : name,
        value: value.length > 400 ? `${value.slice(0, 400)}…` : value,
        enabled: Boolean(def?.enabled),
      };
    })
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.label.localeCompare(b.label));
}

/**
 * Policy types this shop has connected — its `policy` sources, plus the
 * policies inside a LEGACY combined `pages` source (store pages there are
 * dropped: they live on the Pages tab now). Showing the legacy ones as connected
 * means the first save converts them instead of silently disconnecting them.
 */
async function connectedPolicyTypes(shopId: string): Promise<string[]> {
  const sources = await db.dataSource.findMany({
    where: { shopId, type: { in: ["policy", "pages"] } },
    select: { type: true, metadata: true },
  });
  const out = new Set<string>();
  for (const source of sources) {
    const meta = (source.metadata ?? {}) as { policyType?: unknown; policyTypes?: unknown };
    if (source.type === "policy" && typeof meta.policyType === "string") out.add(meta.policyType);
    if (source.type === "pages" && Array.isArray(meta.policyTypes)) {
      for (const t of meta.policyTypes) {
        if (typeof t === "string" && !t.startsWith("gid://shopify/Page/")) out.add(t);
      }
    }
  }
  return [...out];
}

/** Why a product can't be learned (see SHOWABLE_PRODUCT), or null. */
function productNotLearnable(status: string, publishedOnline: boolean): string | null {
  const s = status.toLowerCase();
  if (s !== SHOWABLE_PRODUCT.status) return s === "archived" ? "Archived in Shopify" : s === "draft" ? "Draft in Shopify" : "Not active in Shopify";
  if (!publishedOnline) return "Not on the Online Store";
  return null;
}

function friendlyError(error: unknown): string {
  if (error instanceof QuotaError) {
    return `Plan limit reached: ${error.used} of ${error.limit} ${error.dimension.replace(/_/g, " ")} used. Upgrade to add more.`;
  }
  if (error instanceof PlanGateError) {
    return "This feature isn't available on your current plan. Upgrade to unlock it.";
  }
  if (error instanceof z.ZodError) {
    return error.issues[0]
      ? `${error.issues[0].path.join(".")}: ${error.issues[0].message}`
      : "Invalid input";
  }
  return error instanceof Error ? error.message : "Something went wrong";
}

export const action = async ({ request }: ActionFunctionArgs): Promise<TrainingActionResult> => {
  const { shopId, shopDomain } = await requireShopAccess(request, { permission: "ai_agent" });
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const str = (key: string) => String(formData.get(key) ?? "");
  const json = <T,>(key: string): T => JSON.parse(str(key) || "{}") as T;

  try {
    switch (intent) {
      // ── Catalog sync + learn toggles ────────────────────────────────────
      case "sync-products":
        await enqueueSync(JOBS.catalogSync, shopDomain);
        return { intent, ok: true, message: "Product sync started" };
      case "sync-collections":
        await enqueueSync(JOBS.collectionSync, shopDomain);
        return { intent, ok: true, message: "Collection sync started" };
      case "sync-pages":
        await enqueueSync(JOBS.pageSync, shopDomain);
        return { intent, ok: true, message: "Page sync started" };
      case "sync-blogs":
        await enqueueSync(JOBS.articleSync, shopDomain);
        return { intent, ok: true, message: "Blog sync started" };

      // ── Manage metafields (spec 07) ─────────────────────────────────────
      // Definitions + "used in" counts refresh inline (one Admin call + one
      // aggregate); metafield VALUES arrive via product sync / webhooks.
      case "metafields-sync": {
        const { removedEnabled } = await syncMetafieldDefinitions(shopDomain, shopId);
        if (removedEnabled) await enqueue(JOBS.metafieldApply, { shopId });
        return {
          intent,
          ok: true,
          message: "Metafields synced",
          metafields: await listMetafieldDefinitions(shopId),
        };
      }
      case "metafield-toggle": {
        const enabled = str("enabled") === "true";
        const row = await db.productMetafieldDefinition.findFirst({
          where: { id: str("id"), shopId },
        });
        if (!row) return { intent, ok: false, error: "Metafield not found" };
        if (enabled) {
          if (!isSupportedMetafieldType(row.type)) {
            return { intent, ok: false, error: "This metafield type isn't supported" };
          }
          // Plan cap on enabled metafields — server-side (open enforcement → unlimited).
          const shop = await db.shop.findUnique({ where: { id: shopId }, select: { plan: true } });
          const limit = getQuota(shop?.plan ?? "free", "metafields_enabled");
          const used = await db.productMetafieldDefinition.count({ where: { shopId, enabled: true } });
          if (!row.enabled && used >= limit) throw new QuotaError("metafields_enabled", used, limit);
        }
        if (row.enabled !== enabled) {
          await db.productMetafieldDefinition.updateMany({
            where: { id: row.id, shopId },
            data: { enabled },
          });
          // Re-render metafieldText + re-embed changed products in the background.
          await enqueue(JOBS.metafieldApply, { shopId });
        }
        return {
          intent,
          ok: true,
          message: enabled
            ? `${row.name} enabled — the AI is learning it in the background`
            : `${row.name} disabled`,
          metafields: await listMetafieldDefinitions(shopId),
        };
      }
      case "metafield-bulk-toggle": {
        // Same rules as the single toggle (owner 2026-09-16: metafields needed
        // the multi-select products and FAQs have): supported types only, plan
        // cap enforced server-side, one re-embed job for the whole batch.
        const enabled = str("enabled") === "true";
        const ids = [...new Set(str("ids").split(",").map((id) => id.trim()).filter(Boolean))].slice(0, 200);
        const candidates = await db.productMetafieldDefinition.findMany({ where: { id: { in: ids }, shopId } });
        const usable = enabled ? candidates.filter((row) => isSupportedMetafieldType(row.type)) : candidates;
        const changing = usable.filter((row) => row.enabled !== enabled);
        let applied = changing;
        if (enabled && changing.length > 0) {
          const shop = await db.shop.findUnique({ where: { id: shopId }, select: { plan: true } });
          const limit = getQuota(shop?.plan ?? "free", "metafields_enabled");
          const used = await db.productMetafieldDefinition.count({ where: { shopId, enabled: true } });
          const room = Math.max(0, limit - used);
          applied = changing.slice(0, room);
          if (room === 0) throw new QuotaError("metafields_enabled", used, limit);
        }
        if (applied.length > 0) {
          await db.productMetafieldDefinition.updateMany({
            where: { id: { in: applied.map((row) => row.id) }, shopId },
            data: { enabled },
          });
          await enqueue(JOBS.metafieldApply, { shopId });
        }
        const skipped = changing.length - applied.length;
        return {
          intent,
          ok: true,
          message:
            `${applied.length} metafield${applied.length === 1 ? "" : "s"} ${enabled ? "enabled — the AI is learning them in the background" : "disabled"}` +
            (skipped > 0 ? ` · ${skipped} skipped (plan limit reached)` : ""),
          metafields: await listMetafieldDefinitions(shopId),
        };
      }
      case "sync-discounts":
        await enqueueSync(JOBS.discountSync, shopDomain);
        return { intent, ok: true, message: "Discount sync started" };
      case "learn-master": {
        // Master training permission per data type (spec 07):
        // shop-level gate independent of per-row learnEnabled.
        const type = str("type");
        if (
          type !== "products" &&
          type !== "collections" &&
          type !== "discounts" &&
          type !== "pages" &&
          type !== "blogs"
        )
          return { intent, ok: false, error: "Unknown learn type" };
        const enabled = str("enabled") === "true";
        const current = await loadShopSettings(shopId);
        const validated = shopSettingsSchema.parse({
          ...current,
          learn: { ...current.learn, [type]: enabled },
        });
        await db.shopSettings.upsert({
          where: { shopId },
          update: { settings: validated as unknown as Prisma.InputJsonObject },
          create: { shopId, settings: validated as unknown as Prisma.InputJsonObject },
        });
        invalidateShopConfig(shopId);
        // Pages/Blogs reach the agent through their knowledge bridge (spec 22),
        // so the master switch only takes effect once the bridge is rebuilt —
        // off empties it, on refills it from the learnEnabled rows.
        if (type === "pages" || type === "blogs") await rebuildContentBridge(shopId, type);
        return {
          intent,
          ok: true,
          message: enabled ? `AI learning for ${type} on` : `AI learning for ${type} off`,
        };
      }
      case "discounts-learn": {
        // Bulk/per-row AI flag (app-only — never
        // mutates the discount in Shopify). Affects activeDiscountContext.
        const ids = str("ids").split(",").filter(Boolean);
        const enabled = str("enabled") === "true";
        if (ids.length === 0) return { intent, ok: false, error: "No discounts selected" };
        await db.discount.updateMany({
          where: { id: { in: ids }, shopId },
          data: { learnEnabled: enabled },
        });
        return {
          intent,
          ok: true,
          message: enabled
            ? `AI enabled for ${ids.length} discount${ids.length === 1 ? "" : "s"}`
            : `AI disabled for ${ids.length} discount${ids.length === 1 ? "" : "s"}`,
        };
      }
      case "product-learn":
        await db.product.updateMany({
          where: { id: str("id"), shopId },
          data: { learnEnabled: str("enabled") === "true" },
        });
        // The toast IS the confirmation for row toggles (user, 2026-09-11 —
        // only the master switch goes through Save/Discard).
        return {
          intent,
          ok: true,
          message: `Learning ${str("enabled") === "true" ? "enabled" : "disabled"} for this product`,
        };
      case "products-learn": {
        // Bulk learn toggle from table row selection (spec 07).
        const ids = str("ids").split(",").filter(Boolean);
        const enabled = str("enabled") === "true";
        if (ids.length === 0) return { intent, ok: false, error: "No products selected" };
        await db.product.updateMany({
          where: { id: { in: ids }, shopId },
          data: { learnEnabled: enabled },
        });
        return {
          intent,
          ok: true,
          message: `Learning ${enabled ? "enabled" : "disabled"} for ${ids.length} product${ids.length === 1 ? "" : "s"}`,
        };
      }
      case "collection-learn":
        await db.collection.updateMany({
          where: { id: str("id"), shopId },
          data: { learnEnabled: str("enabled") === "true" },
        });
        return {
          intent,
          ok: true,
          message: `Learning ${str("enabled") === "true" ? "enabled" : "disabled"} for this collection`,
        };
      case "collections-learn": {
        // Bulk learn toggle from table row selection (spec 07).
        const ids = str("ids").split(",").filter(Boolean);
        const enabled = str("enabled") === "true";
        if (ids.length === 0) return { intent, ok: false, error: "No collections selected" };
        await db.collection.updateMany({
          where: { id: { in: ids }, shopId },
          data: { learnEnabled: enabled },
        });
        return {
          intent,
          ok: true,
          message: `Learning ${enabled ? "enabled" : "disabled"} for ${ids.length} collection${ids.length === 1 ? "" : "s"}`,
        };
      }

      // ── Pages & Blogs (spec 22) ─────────────────────────────────────────
      // Single-row and bulk share one path: ids is a comma list either way.
      // The flag alone changes nothing the agent reads — the bridge rebuild
      // does, so it is enqueued in the same request (never awaited inline:
      // a toggle click must not wait on embedding).
      case "page-learn":
      case "pages-learn":
      case "article-learn":
      case "articles-learn": {
        const kind = intent.startsWith("page") ? "pages" : "blogs";
        const ids = (str("ids") || str("id")).split(",").filter(Boolean);
        const enabled = str("enabled") === "true";
        if (ids.length === 0) return { intent, ok: false, error: "Nothing selected" };
        const where = { id: { in: ids }, shopId };
        if (kind === "pages") {
          await db.storePage.updateMany({ where, data: { learnEnabled: enabled } });
        } else {
          await db.blogArticle.updateMany({ where, data: { learnEnabled: enabled } });
        }
        await rebuildContentBridge(shopId, kind);
        const noun = kind === "pages" ? "page" : "article";
        // Single-row toggles toast too (user, 2026-09-11) — the notification
        // is their confirmation, since only the master switch has Save/Discard.
        return {
          intent,
          ok: true,
          message:
            ids.length === 1 && !intent.endsWith("s-learn")
              ? `Learning ${enabled ? "enabled" : "disabled"} for this ${noun}`
              : `Learning ${enabled ? "enabled" : "disabled"} for ${ids.length} ${noun}${ids.length === 1 ? "" : "s"}`,
        };
      }

      // ── View product modal (lazy detail) ────────────────────────────────
      case "product-detail": {
        const product = await db.product.findFirst({
          where: { id: str("id"), shopId },
        });
        if (!product) return { intent, ok: false, error: "Product not found" };
        const numericId = product.shopifyProductId.split("/").pop() ?? product.shopifyProductId;
        const variants = Array.isArray(product.variants)
          ? (product.variants as { title?: unknown; price?: unknown; available?: unknown }[]).map(
              (v) => ({
                title: typeof v.title === "string" ? v.title : "Default",
                price: typeof v.price === "number" ? v.price : Number(v.price ?? 0),
                available: Boolean(v.available),
              }),
            )
          : [];
        return {
          intent,
          ok: true,
          detail: {
            numericId,
            adminUrl: `https://${shopDomain}/admin/products/${numericId}`,
            title: product.title,
            status: product.status,
            url: product.handle ? `https://${shopDomain}/products/${product.handle}` : "",
            vendor: product.vendor,
            description: product.description,
            tags: product.tags,
            variants,
            metafields: await productDetailMetafields(shopId, product.metafields),
          },
        };
      }

      // ── FAQs ────────────────────────────────────────────────────────────
      case "faq-save": {
        const payload = json<{
          id?: string;
          question: string;
          answerHtml: string;
          status: "published" | "draft";
          categoryId: string;
          featured: boolean;
          position?: number;
          unresolvedId?: string;
        }>("payload");
        if (!payload.question?.trim()) {
          return { intent, ok: false, error: "Enter a question." };
        }
        // A published FAQ with no answer renders as a blank bubble in the
        // widget — only drafts may be left unanswered (QA D12b).
        const answerText = (payload.answerHtml ?? "")
          .replace(/<[^>]*>/g, " ")
          .replace(/&nbsp;/gi, " ")
          .trim();
        if (payload.status === "published" && !answerText) {
          return {
            intent,
            ok: false,
            error: "Add an answer before publishing (or save it as a draft).",
          };
        }
        await saveFaq(shopId, payload);
        if (payload.unresolvedId) {
          await db.unresolvedQuestion.updateMany({
            where: { id: payload.unresolvedId, shopId },
            data: { status: "handled" },
          });
        }
        return { intent, ok: true, message: "FAQ saved" };
      }
      case "faq-delete": {
        const ok = await deleteFaq(shopId, str("id"));
        return ok
          ? { intent, ok: true, message: "FAQ deleted" }
          : { intent, ok: false, error: "FAQ not found" };
      }
      case "faq-bulk-delete": {
        const { deleteFaqs } = await import("../lib/faq/faq.server");
        const removed = await deleteFaqs(shopId, str("ids").split(",").map((id) => id.trim()));
        return { intent, ok: true, message: `${removed} FAQ${removed === 1 ? "" : "s"} deleted` };
      }
      case "faq-bulk-status": {
        const { setFaqsStatus } = await import("../lib/faq/faq.server");
        const status = str("status") === "published" ? "published" : "draft";
        const changed = await setFaqsStatus(shopId, str("ids").split(",").map((id) => id.trim()), status);
        return {
          intent,
          ok: true,
          message: `${changed} FAQ${changed === 1 ? "" : "s"} ${status === "published" ? "published" : "moved to draft"}`,
        };
      }
      case "faq-feature":
        await setFaqFeatured(shopId, str("id"), str("featured") === "true");
        return { intent, ok: true };
      case "faq-move":
        await moveFaq(shopId, str("id"), str("direction") === "up" ? "up" : "down");
        return { intent, ok: true };
      case "faq-place":
        // 0-based slot in the shop's GLOBAL widget order.
        await placeFaq(shopId, str("id"), Number(str("position")) || 0);
        return { intent, ok: true };
      case "category-save":
        await saveCategory(shopId, json("payload"));
        return { intent, ok: true, message: "Category saved" };
      case "category-delete": {
        const ok = await deleteCategory(shopId, str("id"));
        return ok
          ? { intent, ok: true, message: "Category deleted — its FAQs moved to Uncategorized" }
          : { intent, ok: false, error: "This category can't be deleted" };
      }
      case "category-feature":
        await setCategoryFeatured(shopId, str("id"), str("featured") === "true");
        return { intent, ok: true };
      case "category-move":
        await moveCategory(shopId, str("id"), str("direction") === "up" ? "up" : "down");
        return { intent, ok: true };
      case "category-place":
        await placeCategory(shopId, str("id"), Number(str("position")) || 1);
        return { intent, ok: true };
      case "faq-import": {
        const result = await importFaqCsv(shopId, str("csv"));
        if (result.imported === 0) {
          return {
            intent,
            ok: false,
            error:
              result.badRows.length > 0
                ? `No rows imported — first issue: line ${result.badRows[0].line} (${result.badRows[0].reason})`
                : result.skipped > 0
                  ? `No new FAQs — all ${result.skipped} row(s) already exist`
                  : "The CSV file is empty",
          };
        }
        // Duplicates and header consumption are called out so a "missing" row
        // is never a silent surprise (QA D7 / D12c).
        const notes = [
          result.skipped > 0 ? `${result.skipped} duplicate(s) skipped` : "",
          result.badRows.length > 0 ? `${result.badRows.length} row(s) skipped` : "",
          result.headerSkipped ? "first row read as column headers" : "",
        ].filter(Boolean);
        return {
          intent,
          ok: true,
          imported: result.imported,
          skipped: result.badRows.length + result.skipped,
          message: `Imported ${result.imported} FAQ${result.imported === 1 ? "" : "s"}${
            notes.length > 0 ? ` · ${notes.join(" · ")}` : ""
          }`,
        };
      }
      case "faq-export": {
        const scope = str("scope") === "published" ? "published" : "all";
        const csv = await exportFaqCsv(shopId, scope);
        return { intent, ok: true, csv, filename: `faqs-${scope}.csv` };
      }

      // ── Custom knowledge sources ────────────────────────────────────────
      case "source-add-url": {
        // Several URLs at once — each becomes its own source row.
        const payload = z
          .object({
            urls: z.array(urlSourceSchema.shape.url).min(1, "Add at least one URL").max(50),
            reCrawlWeekly: z.boolean().default(false),
            status: statusEnum.default("active"),
          })
          .parse(json("payload"));
        const existing = new Set(
          (await db.dataSource.findMany({ where: { shopId, type: "url" }, select: { url: true } })).map(
            (s) => s.url,
          ),
        );
        const fresh = [...new Set(payload.urls)].filter((url) => !existing.has(url));
        if (fresh.length === 0) return { intent, ok: false, error: "Those URLs are already added" };
        // Check the whole batch against the limit BEFORE creating any, so a
        // batch that does not fit adds nothing rather than a confusing part.
        const shop = await db.shop.findUnique({ where: { id: shopId }, select: { plan: true } });
        const limit = getQuota(shop?.plan ?? "free", "crawl_pages");
        if (existing.size + fresh.length > limit) {
          throw new QuotaError("crawl_pages", existing.size + fresh.length, limit);
        }
        for (const url of fresh) {
          await createSource(shopId, {
            type: "url",
            url,
            reCrawlWeekly: payload.reCrawlWeekly,
            status: payload.status,
          });
        }
        const skipped = payload.urls.length - fresh.length;
        return {
          intent,
          ok: true,
          message: `${fresh.length} URL${fresh.length === 1 ? "" : "s"} added — reading in the background${skipped > 0 ? ` (${skipped} already added)` : ""}`,
        };
      }
      case "source-add-file": {
        const payload = filePayloadSchema.parse(json("payload"));
        const bytes = Buffer.from(payload.dataBase64, "base64");
        const source = await createSource(shopId, {
          type: "file",
          name: payload.name,
          title: payload.title,
          mime: payload.mime,
          bytes,
        });
        return source.status === "error"
          ? {
              intent,
              ok: false,
              error: `File saved with an error: ${((source.metadata ?? {}) as { error?: string }).error ?? "unsupported file"}`,
            }
          : { intent, ok: true, message: "File added — indexing in the background" };
      }
      case "source-add-table": {
        // Spec 28 — multipart: the browser gzips the CSV before posting it.
        const file = formData.get("file");
        if (!(file instanceof Blob)) return { intent, ok: false, error: "Choose a CSV file." };
        const payload = tablePayloadSchema.parse(json("payload"));
        await createTableSource(shopId, {
          ...payload,
          bytes: Buffer.from(await file.arrayBuffer()),
          gzipped: str("encoding") === "gzip",
        });
        return { intent, ok: true, message: "Table added — importing rows in the background" };
      }
      case "source-update": {
        const id = str("id");
        const source = await db.dataSource.findFirst({ where: { id, shopId } });
        if (!source) return { intent, ok: false, error: "Source not found" };
        if (source.type === "table") {
          const payload = z
            .object({
              name: z.string().trim().min(1).max(200),
              description: z.string().trim().min(1).max(TABLE_DESCRIPTION_MAX),
              roles: z.record(z.string().regex(/^c\d+$/), z.enum(COLUMN_ROLES as [ColumnRole, ...ColumnRole[]])),
              status: statusEnum,
            })
            .parse(json("payload"));
          await updateTableSource(shopId, id, payload);
          return { intent, ok: true, message: "Table updated" };
        }
        const oldMeta = { ...((source.metadata ?? {}) as Record<string, unknown>) };
        if (source.type === "url") {
          const payload = urlPayloadSchema.parse(json("payload"));
          await db.dataSource.updateMany({
            where: { id, shopId },
            data: {
              url: payload.url,
              reCrawlWeekly: payload.reCrawlWeekly,
              name: source.name === source.url ? payload.url : source.name,
              status: "pending",
              metadata: { ...oldMeta, desiredStatus: payload.status },
            },
          });
          await enqueue(KNOWLEDGE_INGEST_JOB, { shopDomain, sourceId: id });
          return { intent, ok: true, message: "Source updated — re-crawling" };
        }
        if (source.type === "file") {
          const payload = z
            .object({ name: z.string().trim().min(1).max(200), status: statusEnum })
            .parse(json("payload"));
          await db.dataSource.updateMany({
            where: { id, shopId },
            data: {
              name: payload.name,
              status:
                source.status === "error"
                  ? "error"
                  : payload.status === "inactive"
                    ? "inactive"
                    : "active",
              metadata: { ...oldMeta, desiredStatus: payload.status },
            },
          });
          return { intent, ok: true, message: "File updated" };
        }
        return { intent, ok: false, error: `Edit is not supported for type "${source.type}"` };
      }
      case "source-resync":
        await resyncSource(shopId, str("id"));
        return { intent, ok: true, message: "Re-sync started" };
      case "source-delete": {
        const ok = await deleteSource(shopId, str("id"));
        return ok
          ? { intent, ok: true, message: "Source deleted" }
          : { intent, ok: false, error: "Source not found" };
      }
      // ── Policies connector ──────────────────────────────────────────────
      case "policies-list": {
        // Policies only: store pages moved to the Pages tab.
        const candidates = await fetchShopPolicies(shopDomain);
        return {
          intent,
          ok: true,
          policies: {
            candidates: candidates.map((c) => ({ type: c.type, title: c.title, url: c.url, kind: c.kind })),
            selectedTypes: await connectedPolicyTypes(shopId),
          },
        };
      }
      case "policies-save": {
        // The FULL selection, diffed against what is connected: one `policy`
        // source per policy, so each lists and deletes separately.
        const { types } = z.object({ types: z.array(z.string()).max(50) }).parse(json("payload"));
        const wanted = new Set(types);
        const current = await db.dataSource.findMany({
          where: { shopId, type: "policy" },
          select: { id: true, metadata: true },
        });
        const typeOf = (m: unknown) => ((m ?? {}) as { policyType?: unknown }).policyType;
        const have = new Set(current.map((c) => typeOf(c.metadata)).filter((t): t is string => typeof t === "string"));
        for (const source of current) {
          const type = typeOf(source.metadata);
          if (typeof type !== "string" || !wanted.has(type)) await deleteSource(shopId, source.id);
        }
        const toAdd = types.filter((t) => !have.has(t));
        if (toAdd.length > 0) {
          const candidates = await fetchShopPolicies(shopDomain);
          for (const type of toAdd) {
            const policy = candidates.find((c) => c.type === type);
            if (!policy) continue; // gone from Shopify since the list was opened
            await createSource(shopId, {
              type: "policy",
              policyType: policy.type,
              title: policy.title,
              url: policy.url,
              body: policy.body,
            });
          }
        }
        // Converting a LEGACY combined "policies & pages" source: its policies
        // were pre-selected in the list (connectedPolicyTypes), so saving has
        // just recreated them individually; its store pages are on the Pages tab.
        // Removing it here stops the same policy being indexed twice.
        const legacy = await db.dataSource.findMany({ where: { shopId, type: "pages" }, select: { id: true } });
        for (const source of legacy) await deleteSource(shopId, source.id);
        return {
          intent,
          ok: true,
          message: wanted.size === 0 ? "Policies disconnected" : `${wanted.size} polic${wanted.size === 1 ? "y" : "ies"} connected`,
        };
      }
      default:
        return { intent, ok: false, error: "Unknown action" };
    }
  } catch (error) {
    return { intent, ok: false, error: friendlyError(error) };
  }
};

// ── Page ────────────────────────────────────────────────────────────────────

const TABS: { id: TrainingTab; label: string }[] = [
  { id: "products", label: "Products" },
  { id: "collections", label: "Collections" },
  // Spec 22 — synced from the Admin API, like the two tabs before them.
  { id: "pages", label: "Pages" },
  { id: "blogs", label: "Blogs" },
  { id: "discounts", label: "Discounts" },
  { id: "faqs", label: "FAQs" },
  { id: "knowledge", label: "Custom knowledge" },
];

export default function TrainingDataPage() {
  const data = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get("tab");
  const tab: TrainingTab = TABS.some((t) => t.id === rawTab)
    ? (rawTab as TrainingTab)
    : "products";
  const prefillFaq = searchParams.get("prefillFaq") ?? "";
  const unresolvedId = searchParams.get("unresolvedId") ?? "";

  const setTab = (next: TrainingTab) => {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        params.set("tab", next);
        params.delete("prefillFaq");
        params.delete("unresolvedId");
        return params;
      },
      { preventScrollReset: true },
    );
  };

  return (
    <s-page heading={APP_NAME}>
      <s-stack gap="base">
        <PageHeader
          title="Training data"
          backTo="/app/ai-agent"
          backLabel="AI Agent"
          tabs={TABS}
          activeTab={tab}
          onTabChange={setTab}
          toolbar={<s-button onClick={() => navigate("/app/ai-agent/test")}>Test AI</s-button>}
        />

        {tab === "products" ? (
          <TrainingProductsTab
            rows={data.products.rows}
            total={data.products.total}
            learned={data.products.learned}
            lastSyncedAt={data.sync.productSyncAt}
            syncStatus={data.sync.status}
            currency={data.shop.currency}
            masterEnabled={data.learnMaster.products}
            metafields={data.metafields.rows}
            metafieldQuota={data.metafields.quota}
            metafieldNextPlan={data.planSignals.metafieldsNext}
            metafieldSyncAt={data.metafields.lastSyncedAt}
            syncedUsed={data.planSignals.productsSynced.used}
            syncedQuota={data.planSignals.productsSynced.quota}
            syncedBonus={data.planSignals.productsSynced.bonus}
            syncedNextPlan={data.planSignals.productsSynced.nextPlan}
          />
        ) : null}
        {tab === "collections" ? (
          <TrainingCollectionsTab
            rows={data.collections}
            lastSyncedAt={data.sync.collectionSyncAt}
            masterEnabled={data.learnMaster.collections}
          />
        ) : null}
        {tab === "pages" ? (
          <TrainingContentTab
            kind="pages"
            rows={data.pages}
            lastSyncedAt={data.sync.pageSyncAt}
            masterEnabled={data.learnMaster.pages}
            syncedUsed={data.planSignals.pagesSynced.used}
            syncedQuota={data.planSignals.pagesSynced.quota}
            syncedBonus={data.planSignals.pagesSynced.bonus}
            syncedNextPlan={data.planSignals.pagesSynced.nextPlan}
          />
        ) : null}
        {tab === "blogs" ? (
          <TrainingContentTab
            kind="blogs"
            rows={data.articles}
            lastSyncedAt={data.sync.articleSyncAt}
            masterEnabled={data.learnMaster.blogs}
            syncedUsed={data.planSignals.articlesSynced.used}
            syncedQuota={data.planSignals.articlesSynced.quota}
            syncedBonus={data.planSignals.articlesSynced.bonus}
            syncedNextPlan={data.planSignals.articlesSynced.nextPlan}
          />
        ) : null}
        {tab === "discounts" ? (
          <TrainingDiscountsTab
            rows={data.discounts}
            lastSyncedAt={data.sync.discountSyncAt}
            masterEnabled={data.learnMaster.discounts}
            shopDomain={data.shop.domain}
          />
        ) : null}
        {tab === "faqs" ? (
          <FaqManager
            tree={data.faqTree}
            quotaUsed={data.faqQuota.used}
            quotaLimit={data.faqQuota.quota}
            quotaNextPlan={data.faqQuota.nextPlan}
            prefillQuestion={prefillFaq}
            prefillUnresolvedId={prefillFaq ? unresolvedId : ""}
          />
        ) : null}
        {tab === "knowledge" ? (
          <TrainingKnowledgeTab
            sources={data.knowledge.sources}
            chunkTotal={data.knowledge.chunkTotal}
            quotas={data.knowledge.quotas}
            connectedPolicies={data.knowledge.connectedPolicies}
            planSignals={data.planSignals}
          />
        ) : null}
      </s-stack>
    </s-page>
  );
}

export function ErrorBoundary() {
  return routeError(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
