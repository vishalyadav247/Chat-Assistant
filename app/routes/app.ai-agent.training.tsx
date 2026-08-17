import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate, useRouteError, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { resolveShopId } from "../lib/tenancy.server";
import type { Prisma } from "@prisma/client";
import {
  displayQuota,
  getQuota,
  hasFeature,
  requirePlan,
  PlanGateError,
} from "../lib/billing/plans.server";
import { loadShopSettings } from "../lib/settings/save.server";
import { shopSettingsSchema } from "../lib/settings/schemas";
import { invalidateShopConfig } from "../lib/config/shop-config.server";
import { enqueue } from "../lib/jobs/queue.server";
import { JOBS } from "../lib/jobs/handlers.server";
import { KNOWLEDGE_INGEST_JOB } from "../lib/ingestion/knowledge-jobs.server";
import {
  approveSuggested,
  createSource,
  deleteSource,
  dismissSuggested,
  fetchPageCandidates,
  listSources,
  listSuggested,
  parseCsvContent,
  QuotaError,
  resyncSource,
  CSV_ROW_CAP,
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
import { TrainingDiscountsTab } from "../components/TrainingDiscountsTab";
import { TrainingKnowledgeTab } from "../components/TrainingKnowledgeTab";

// Training data (spec 07, design ai-agent.html #viewTraining): five tabs via
// ?tab= — Products / Collections / Discounts / FAQs / Custom knowledge.
// All reads and writes are shop-scoped via resolveShopId(session.shop).

export type TrainingTab = "products" | "collections" | "discounts" | "faqs" | "knowledge";

export interface ProductRow {
  id: string;
  shopifyProductId: string;
  title: string;
  imageUrl: string | null;
  tags: string[];
  status: string;
  learnEnabled: boolean;
}

export interface CollectionRow {
  id: string;
  title: string;
  description: string;
  conditions: string;
  productCount: number;
  learnEnabled: boolean;
}

export interface DiscountRow {
  id: string;
  title: string;
  summary: string;
  status: string;
  method: string; // code | automatic
  discountType: string; // amount_off_order | amount_off_products | free_shipping | bxgy
  usedCount: number;
  learnEnabled: boolean;
  startsAt: string | null;
  endsAt: string | null;
}

export interface SourceRow {
  id: string;
  type: string; // url | manual | csv | file | pages
  name: string;
  url: string | null;
  crawlScope: string;
  reCrawlWeekly: boolean;
  status: string; // pending | active | inactive | error
  chunkCount: number;
  lastSyncedAt: string | null;
  error: string | null;
  // Flattened metadata for the type-specific edit modals:
  question: string;
  synonyms: string[];
  answer: string;
  csvText: string;
  pagesCount: number;
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
  faqCount: number;
  variants: { title: string; price: number; available: boolean }[];
}

export interface PoliciesPayload {
  candidates: { type: string; title: string; url: string; kind: "policy" | "page" }[];
  selectedTypes: string[];
  quota: number;
}

export interface TrainingActionResult {
  intent: string;
  ok: boolean;
  message?: string;
  error?: string;
  detail?: ProductDetail;
  policies?: PoliciesPayload;
  csv?: string;
  filename?: string;
  imported?: number;
  skipped?: number;
}

const csvEscape = (value: string) =>
  /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = await resolveShopId(session.shop);

  const [shop, products, collections, discounts, syncState, faqTree, sources, suggested, shopSettings] =
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
      listSuggested(shopId),
      loadShopSettings(shopId),
    ]);

  const plan = shop?.plan ?? "free";
  // The FAQ bridge source (type=faq, spec 04) is managed from the FAQs tab —
  // hide it from the Custom knowledge table so it can't be deleted by accident.
  const knowledgeSources = sources.filter((s) => s.type !== "faq");

  const meta = (s: (typeof sources)[number]) =>
    (s.metadata ?? {}) as {
      question?: unknown;
      synonyms?: unknown;
      answer?: unknown;
      rows?: unknown;
      pages?: unknown;
      pagesUsed?: unknown;
      error?: unknown;
    };

  const sourceRows: SourceRow[] = knowledgeSources.map((s) => {
    const m = meta(s);
    const rows = Array.isArray(m.rows)
      ? (m.rows as { question?: unknown; answer?: unknown }[])
      : [];
    return {
      id: s.id,
      type: s.type,
      name: s.name,
      url: s.url,
      crawlScope: s.crawlScope ?? "page",
      reCrawlWeekly: s.reCrawlWeekly,
      status: s.status,
      chunkCount: s.chunkCount,
      lastSyncedAt: s.lastSyncedAt ? s.lastSyncedAt.toISOString() : null,
      error: typeof m.error === "string" ? m.error : null,
      question: typeof m.question === "string" ? m.question : "",
      synonyms: Array.isArray(m.synonyms)
        ? (m.synonyms as unknown[]).filter((x): x is string => typeof x === "string")
        : [],
      answer: typeof m.answer === "string" ? m.answer : "",
      csvText: rows
        .map((r) =>
          [String(r.question ?? ""), String(r.answer ?? "")].map(csvEscape).join(","),
        )
        .join("\n"),
      pagesCount: Array.isArray(m.pages) ? m.pages.length : 0,
    };
  });

  const crawlUsed = knowledgeSources
    .filter((s) => s.type === "url")
    .reduce((sum, s) => {
      const used = meta(s).pagesUsed;
      return sum + (typeof used === "number" ? used : 0);
    }, 0);
  const pagesUsed = knowledgeSources
    .filter((s) => s.type === "pages")
    .reduce((sum, s) => {
      const pages = meta(s).pages;
      return sum + (Array.isArray(pages) ? pages.length : 0);
    }, 0);

  return {
    shop: {
      plan,
      domain: shop?.domain ?? session.shop,
      currency: shop?.currency ?? "USD",
    },
    products: {
      rows: products as ProductRow[],
      total: products.length,
      learned: products.filter((p) => p.learnEnabled).length,
    },
    collections: collections as CollectionRow[],
    discounts: discounts.map((d) => ({
      ...d,
      startsAt: d.startsAt ? d.startsAt.toISOString() : null,
      endsAt: d.endsAt ? d.endsAt.toISOString() : null,
    })) as DiscountRow[],
    sync: {
      productSyncAt: syncState?.productSyncAt?.toISOString() ?? null,
      collectionSyncAt: syncState?.collectionSyncAt?.toISOString() ?? null,
      discountSyncAt: syncState?.discountSyncAt?.toISOString() ?? null,
      status: syncState?.status ?? "idle",
    },
    faqTree: faqTree satisfies FaqCategoryData[],
    knowledge: {
      sources: sourceRows,
      suggested: suggested.map((s) => ({
        id: s.id,
        question: s.question,
        answer: s.answer,
        createdAt: s.createdAt.toISOString(),
      })),
      chunkTotal: knowledgeSources.reduce((sum, s) => sum + s.chunkCount, 0),
      csvRowCap: CSV_ROW_CAP,
      quotas: {
        crawlPages: { used: crawlUsed, quota: displayQuota(plan, "crawl_pages") },
        manualQas: {
          used: knowledgeSources.filter((s) => s.type === "manual").length,
          quota: displayQuota(plan, "manual_qas"),
        },
        fileUploads: {
          used: knowledgeSources.filter((s) => s.type === "file").length,
          quota: displayQuota(plan, "file_uploads"),
        },
        policyPages: { used: pagesUsed, quota: displayQuota(plan, "policy_pages") },
      },
    },
    // Plan gate (spec 15) — in open enforcement mode hasFeature() passes for
    // every plan, so the banner stays hidden; the condition ships regardless.
    discountGate: {
      showBanner: !hasFeature(plan, "discount_realtime_sync"),
      realtime: hasFeature(plan, "discount_realtime_sync"),
      realtimeEnabled: shopSettings.discountRealtime,
    },
    // Catalog auto sync (Products / Collections tabs, 2026-08-17): same shape —
    // plan feature availability + the merchant's per-type toggle.
    catalogGate: {
      available: hasFeature(plan, "catalog_auto_sync"),
      products: shopSettings.catalogAutoSync.products,
      collections: shopSettings.catalogAutoSync.collections,
    },
    // Master training permissions (spec 07) — the Learn card switches.
    learnMaster: shopSettings.learn,
  };
};

// ── Action ──────────────────────────────────────────────────────────────────

const statusEnum = z.enum(["active", "inactive"]);

const manualPayloadSchema = z.object({
  question: z.string().trim().min(1).max(500),
  synonyms: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  answer: z.string().trim().min(1).max(10_000),
  status: statusEnum.default("active"),
  unresolvedId: z.string().optional(),
});

const urlPayloadSchema = z.object({
  url: z.string().trim().min(1).max(2000),
  crawlScope: z.enum(["page", "linked", "sitemap"]).default("page"),
  reCrawlWeekly: z.boolean().default(false),
  status: statusEnum.default("active"),
});

const csvPayloadSchema = z.object({
  csvText: z.string().min(1).max(1024 * 1024),
  name: z.string().trim().max(200).optional(),
});

const filePayloadSchema = z.object({
  name: z.string().trim().min(1).max(200),
  mime: z.string().trim().max(200).default(""),
  dataBase64: z.string().min(1),
});

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
  const { session } = await authenticate.admin(request);
  const shopId = await resolveShopId(session.shop);
  const shopDomain = session.shop;
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const str = (key: string) => String(formData.get(key) ?? "");
  const json = <T,>(key: string): T => JSON.parse(str(key) || "{}") as T;

  try {
    switch (intent) {
      // ── Catalog sync + learn toggles ────────────────────────────────────
      case "sync-products":
        await enqueue(JOBS.catalogSync, { shopDomain });
        return { intent, ok: true, message: "Product sync started" };
      case "sync-collections":
        await enqueue(JOBS.collectionSync, { shopDomain });
        return { intent, ok: true, message: "Collection sync started" };
      case "sync-discounts":
        await enqueue(JOBS.discountSync, { shopDomain });
        return { intent, ok: true, message: "Discount sync started" };
      case "discount-realtime": {
        const enabled = str("enabled") === "true";
        requirePlan(
          (await db.shop.findUnique({ where: { id: shopId }, select: { plan: true } }))?.plan ??
            "free",
          "discount_realtime_sync",
        );
        const current = await loadShopSettings(shopId);
        const validated = shopSettingsSchema.parse({ ...current, discountRealtime: enabled });
        await db.shopSettings.upsert({
          where: { shopId },
          update: { settings: validated as unknown as Prisma.InputJsonObject },
          create: { shopId, settings: validated as unknown as Prisma.InputJsonObject },
        });
        invalidateShopConfig(shopId);
        return {
          intent,
          ok: true,
          message: enabled ? "Real-time discount sync on" : "Real-time discount sync off",
        };
      }
      case "catalog-autosync": {
        // Auto sync toggle per data type (daily full re-sync only; webhooks unaffected).
        const type = str("type");
        if (type !== "products" && type !== "collections")
          return { intent, ok: false, error: "Unknown sync type" };
        const enabled = str("enabled") === "true";
        requirePlan(
          (await db.shop.findUnique({ where: { id: shopId }, select: { plan: true } }))?.plan ??
            "free",
          "catalog_auto_sync",
        );
        const current = await loadShopSettings(shopId);
        const validated = shopSettingsSchema.parse({
          ...current,
          catalogAutoSync: { ...current.catalogAutoSync, [type]: enabled },
        });
        await db.shopSettings.upsert({
          where: { shopId },
          update: { settings: validated as unknown as Prisma.InputJsonObject },
          create: { shopId, settings: validated as unknown as Prisma.InputJsonObject },
        });
        invalidateShopConfig(shopId);
        return {
          intent,
          ok: true,
          message: enabled ? `Auto sync for ${type} on` : `Auto sync for ${type} off`,
        };
      }
      case "learn-master": {
        // Master training permission per data type (spec 07, user decision
        // 2026-08-12): shop-level gate independent of per-row learnEnabled.
        const type = str("type");
        if (type !== "products" && type !== "collections" && type !== "discounts")
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
        return {
          intent,
          ok: true,
          message: enabled ? `AI learning for ${type} on` : `AI learning for ${type} off`,
        };
      }
      case "discounts-learn": {
        // Bulk/per-row AI flag (app-only per user decision 2026-08-12 — never
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
        return { intent, ok: true };
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
        return { intent, ok: true };
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
            faqCount: 0,
            variants,
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
          unresolvedId?: string;
        }>("payload");
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
      case "faq-feature":
        await setFaqFeatured(shopId, str("id"), str("featured") === "true");
        return { intent, ok: true };
      case "faq-move":
        await moveFaq(shopId, str("id"), str("direction") === "up" ? "up" : "down");
        return { intent, ok: true };
      case "faq-place":
        await placeFaq(shopId, str("id"), str("categoryId"), Number(str("position")) || 0);
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
                : "The CSV file is empty",
          };
        }
        return {
          intent,
          ok: true,
          imported: result.imported,
          skipped: result.badRows.length,
          message: `Imported ${result.imported} FAQ${result.imported === 1 ? "" : "s"}${
            result.badRows.length > 0 ? ` · ${result.badRows.length} row(s) skipped` : ""
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
        const payload = urlPayloadSchema.parse(json("payload"));
        await createSource(shopId, { type: "url", ...payload });
        return { intent, ok: true, message: "Source added — crawling in the background" };
      }
      case "source-add-manual": {
        const payload = manualPayloadSchema.parse(json("payload"));
        await createSource(shopId, {
          type: "manual",
          question: payload.question,
          synonyms: payload.synonyms,
          answer: payload.answer,
          status: payload.status,
        });
        if (payload.unresolvedId) {
          await db.unresolvedQuestion.updateMany({
            where: { id: payload.unresolvedId, shopId },
            data: { status: "handled" },
          });
        }
        return { intent, ok: true, message: "Q&A added" };
      }
      case "source-add-csv": {
        const payload = csvPayloadSchema.parse(json("payload"));
        const parsed = parseCsvContent(payload.csvText);
        if (parsed.rows.length === 0) {
          return {
            intent,
            ok: false,
            error:
              parsed.badRows.length > 0
                ? `No valid rows — first issue: line ${parsed.badRows[0].line} (${parsed.badRows[0].reason})`
                : "Paste or upload question,answer rows first",
          };
        }
        const name =
          payload.name?.trim() ||
          `${parsed.rows[0].question}${parsed.rows.length > 1 ? ` (+${parsed.rows.length - 1} more)` : ""}`;
        await createSource(shopId, { type: "csv", name: name.slice(0, 200), rows: parsed.rows });
        return {
          intent,
          ok: true,
          imported: parsed.rows.length,
          skipped: parsed.badRows.length,
          message: `Added ${parsed.rows.length} Q&A row${parsed.rows.length === 1 ? "" : "s"}${
            parsed.badRows.length > 0 ? ` · ${parsed.badRows.length} row(s) skipped` : ""
          }`,
        };
      }
      case "source-add-file": {
        const payload = filePayloadSchema.parse(json("payload"));
        const bytes = Buffer.from(payload.dataBase64, "base64");
        const source = await createSource(shopId, {
          type: "file",
          name: payload.name,
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
      case "source-update": {
        const id = str("id");
        const source = await db.dataSource.findFirst({ where: { id, shopId } });
        if (!source) return { intent, ok: false, error: "Source not found" };
        const oldMeta = { ...((source.metadata ?? {}) as Record<string, unknown>) };
        if (source.type === "manual") {
          const payload = manualPayloadSchema.parse(json("payload"));
          await db.dataSource.updateMany({
            where: { id, shopId },
            data: {
              name: payload.question,
              status: "pending",
              metadata: {
                ...oldMeta,
                question: payload.question,
                synonyms: payload.synonyms,
                answer: payload.answer,
                desiredStatus: payload.status,
              },
            },
          });
          await enqueue(KNOWLEDGE_INGEST_JOB, { shopDomain, sourceId: id });
          return { intent, ok: true, message: "Q&A updated" };
        }
        if (source.type === "csv") {
          const payload = csvPayloadSchema.parse(json("payload"));
          const parsed = parseCsvContent(payload.csvText);
          if (parsed.rows.length === 0) {
            return { intent, ok: false, error: "No valid question,answer rows" };
          }
          await db.dataSource.updateMany({
            where: { id, shopId },
            data: { status: "pending", metadata: { ...oldMeta, rows: parsed.rows } },
          });
          await enqueue(KNOWLEDGE_INGEST_JOB, { shopDomain, sourceId: id });
          return {
            intent,
            ok: true,
            imported: parsed.rows.length,
            skipped: parsed.badRows.length,
            message: "CSV content updated — re-indexing",
          };
        }
        if (source.type === "url") {
          const payload = urlPayloadSchema.parse(json("payload"));
          await db.dataSource.updateMany({
            where: { id, shopId },
            data: {
              url: payload.url,
              crawlScope: payload.crawlScope,
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
      case "suggested-approve":
        await approveSuggested(shopId, str("id"));
        return { intent, ok: true, message: "Q&A approved and added" };
      case "suggested-dismiss":
        await dismissSuggested(shopId, str("id"));
        return { intent, ok: true, message: "Suggestion dismissed" };

      // ── Policies connector ──────────────────────────────────────────────
      case "policies-list": {
        const shop = await db.shop.findUnique({ where: { id: shopId }, select: { plan: true } });
        const candidates = await fetchPageCandidates(shopDomain);
        const existing = await db.dataSource.findFirst({ where: { shopId, type: "pages" } });
        const existingTypes = (existing?.metadata as { policyTypes?: unknown } | null)
          ?.policyTypes;
        return {
          intent,
          ok: true,
          policies: {
            candidates: candidates.map((c) => ({
              type: c.type,
              title: c.title,
              url: c.url,
              kind: c.kind,
            })),
            selectedTypes: Array.isArray(existingTypes)
              ? existingTypes.filter((t): t is string => typeof t === "string")
              : [],
            quota: displayQuota(shop?.plan ?? "free", "policy_pages"),
          },
        };
      }
      case "policies-save": {
        const { types } = z
          .object({ types: z.array(z.string()).max(50) })
          .parse(json("payload"));
        const existing = await db.dataSource.findFirst({ where: { shopId, type: "pages" } });
        if (types.length === 0) {
          if (existing) await deleteSource(shopId, existing.id);
          return { intent, ok: true, message: "Pages disconnected" };
        }
        const candidates = await fetchPageCandidates(shopDomain);
        const pages = candidates
          .filter((c) => types.includes(c.type))
          .map((c) => ({ title: c.title, url: c.url, body: c.body }));
        if (pages.length === 0) return { intent, ok: false, error: "No matching pages found" };
        if (existing) {
          const shop = await db.shop.findUnique({ where: { id: shopId }, select: { plan: true } });
          const limit = getQuota(shop?.plan ?? "free", "policy_pages");
          if (pages.length > limit) throw new QuotaError("policy_pages", pages.length, limit);
          const oldMeta = { ...((existing.metadata ?? {}) as Record<string, unknown>) };
          await db.dataSource.updateMany({
            where: { id: existing.id, shopId },
            data: {
              status: "pending",
              metadata: { ...oldMeta, pages, policyTypes: types },
            },
          });
          await enqueue(KNOWLEDGE_INGEST_JOB, { shopDomain, sourceId: existing.id });
        } else {
          const source = await createSource(shopId, { type: "pages", pages });
          await db.dataSource.updateMany({
            where: { id: source.id, shopId },
            data: { metadata: { pages, policyTypes: types } },
          });
        }
        return {
          intent,
          ok: true,
          message: `${pages.length} page${pages.length === 1 ? "" : "s"} connected — indexing`,
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
  const prefillQa = searchParams.get("prefillQa") ?? "";
  const unresolvedId = searchParams.get("unresolvedId") ?? "";

  const setTab = (next: TrainingTab) => {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        params.set("tab", next);
        params.delete("prefillFaq");
        params.delete("prefillQa");
        params.delete("unresolvedId");
        return params;
      },
      { preventScrollReset: true },
    );
  };

  return (
    <s-page heading="Training data">
      <s-stack gap="base">
        <PageHeader
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
            autoSyncAvailable={data.catalogGate.available}
            autoSyncEnabled={data.catalogGate.products}
          />
        ) : null}
        {tab === "collections" ? (
          <TrainingCollectionsTab
            rows={data.collections}
            lastSyncedAt={data.sync.collectionSyncAt}
            masterEnabled={data.learnMaster.collections}
            autoSyncAvailable={data.catalogGate.available}
            autoSyncEnabled={data.catalogGate.collections}
          />
        ) : null}
        {tab === "discounts" ? (
          <TrainingDiscountsTab
            rows={data.discounts}
            lastSyncedAt={data.sync.discountSyncAt}
            masterEnabled={data.learnMaster.discounts}
            showUpgradeBanner={data.discountGate.showBanner}
            realtime={data.discountGate.realtime}
            realtimeEnabled={data.discountGate.realtimeEnabled}
            shopDomain={data.shop.domain}
          />
        ) : null}
        {tab === "faqs" ? (
          <FaqManager
            tree={data.faqTree}
            prefillQuestion={prefillFaq}
            prefillUnresolvedId={prefillFaq ? unresolvedId : ""}
          />
        ) : null}
        {tab === "knowledge" ? (
          <TrainingKnowledgeTab
            sources={data.knowledge.sources}
            suggested={data.knowledge.suggested}
            chunkTotal={data.knowledge.chunkTotal}
            quotas={data.knowledge.quotas}
            csvRowCap={data.knowledge.csvRowCap}
            prefillQuestion={prefillQa}
            prefillUnresolvedId={prefillQa ? unresolvedId : ""}
          />
        ) : null}
      </s-stack>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
