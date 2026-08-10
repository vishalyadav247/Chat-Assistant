import { z } from "zod";
import db from "../../db.server";
import { syncFaqKnowledge } from "../ingestion/knowledge-ingest.server";
import { parseCsvContent } from "../ingestion/sources.server";
import { sanitizeHtml } from "../sanitize.server";
import { requireShopId } from "../tenancy.server";

// FAQ CRUD server logic (spec 07). Every function takes a TRUSTED shopId
// (from authenticate.admin) as its first argument and scopes every query.
//
// Knowledge bridge (spec 04): mutations that change what the FAQ knowledge
// source reads (question / answer / published-status / order / existence) call
// syncFaqKnowledge(shopId) so published FAQs stay embedded. Star/featured and
// category cosmetics only affect the widget FAQ screen, not knowledge.

export const DEFAULT_CATEGORY_NAME = "Uncategorized";
export const FAQ_CSV_MAX_BYTES = 1024 * 1024; // 1MB (design: Import FAQs modal)

export interface FaqRowData {
  id: string;
  categoryId: string | null;
  question: string;
  answerHtml: string;
  status: string; // published | draft
  featured: boolean;
  position: number;
}

export interface FaqCategoryData {
  id: string;
  name: string;
  icon: string;
  position: number;
  status: string; // published | draft
  featured: boolean;
  isDefault: boolean;
  faqs: FaqRowData[];
}

/** Seed the default "Uncategorized" category on first visit (idempotent). */
export async function ensureDefaultCategory(shopId: string): Promise<string> {
  requireShopId(shopId);
  const existing = await db.faqCategory.findFirst({
    where: { shopId, isDefault: true },
    select: { id: true },
  });
  if (existing) return existing.id;
  const count = await db.faqCategory.count({ where: { shopId } });
  const created = await db.faqCategory.create({
    data: {
      shopId,
      name: DEFAULT_CATEGORY_NAME,
      icon: "📄",
      position: count,
      status: "published",
      isDefault: true,
    },
  });
  return created.id;
}

/** Category tree with FAQs grouped inside, both ordered by position. */
export async function listFaqTree(shopId: string): Promise<FaqCategoryData[]> {
  requireShopId(shopId);
  const defaultId = await ensureDefaultCategory(shopId);
  const [categories, faqs] = await Promise.all([
    db.faqCategory.findMany({
      where: { shopId },
      orderBy: [{ position: "asc" }, { name: "asc" }],
    }),
    db.faq.findMany({
      where: { shopId },
      orderBy: [{ position: "asc" }, { question: "asc" }],
    }),
  ]);
  const knownIds = new Set(categories.map((c) => c.id));
  return categories.map((category) => ({
    id: category.id,
    name: category.name,
    icon: category.icon,
    position: category.position,
    status: category.status,
    featured: category.featured,
    isDefault: category.isDefault,
    faqs: faqs
      .filter((faq) =>
        faq.categoryId && knownIds.has(faq.categoryId)
          ? faq.categoryId === category.id
          : category.id === defaultId,
      )
      .map((faq) => ({
        id: faq.id,
        categoryId: faq.categoryId,
        question: faq.question,
        answerHtml: faq.answerHtml,
        status: faq.status,
        featured: faq.featured,
        position: faq.position,
      })),
  }));
}

// ── Categories ──────────────────────────────────────────────────────────────

export const categoryInputSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(100),
  icon: z.string().trim().min(1).max(16).default("📄"),
  /** Desired 1-based position within the ordered category list. */
  position: z.number().int().min(1).optional(),
  status: z.enum(["published", "draft"]).default("published"),
  featured: z.boolean().default(false),
});

export type CategoryInput = z.input<typeof categoryInputSchema>;

export async function saveCategory(shopId: string, input: CategoryInput): Promise<string> {
  requireShopId(shopId);
  const parsed = categoryInputSchema.parse(input);
  await ensureDefaultCategory(shopId);

  let id = parsed.id ?? null;
  if (id) {
    const existing = await db.faqCategory.findFirst({ where: { id, shopId } });
    if (!existing) throw new Error("faq: category not found");
    await db.faqCategory.updateMany({
      where: { id, shopId },
      data: {
        // The default category keeps its identity; everything else is editable.
        name: existing.isDefault ? existing.name : parsed.name,
        icon: parsed.icon,
        status: parsed.status,
        featured: parsed.featured,
      },
    });
  } else {
    const count = await db.faqCategory.count({ where: { shopId } });
    const created = await db.faqCategory.create({
      data: {
        shopId,
        name: parsed.name,
        icon: parsed.icon,
        position: count,
        status: parsed.status,
        featured: parsed.featured,
      },
    });
    id = created.id;
  }
  if (parsed.position) await placeCategory(shopId, id, parsed.position);
  else await normalizeCategoryPositions(shopId);
  return id;
}

export async function setCategoryFeatured(
  shopId: string,
  categoryId: string,
  featured: boolean,
): Promise<void> {
  requireShopId(shopId);
  await db.faqCategory.updateMany({ where: { id: categoryId, shopId }, data: { featured } });
}

export async function moveCategory(
  shopId: string,
  categoryId: string,
  direction: "up" | "down",
): Promise<void> {
  requireShopId(shopId);
  const ordered = await db.faqCategory.findMany({
    where: { shopId },
    orderBy: [{ position: "asc" }, { name: "asc" }],
    select: { id: true },
  });
  const index = ordered.findIndex((c) => c.id === categoryId);
  if (index < 0) return;
  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= ordered.length) return;
  [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
  await db.$transaction(
    ordered.map((c, position) =>
      db.faqCategory.updateMany({ where: { id: c.id, shopId }, data: { position } }),
    ),
  );
}

/** Re-place one category at a 1-based position, reindexing the rest. */
export async function placeCategory(
  shopId: string,
  categoryId: string,
  position1: number,
): Promise<void> {
  const ordered = await db.faqCategory.findMany({
    where: { shopId },
    orderBy: [{ position: "asc" }, { name: "asc" }],
    select: { id: true },
  });
  const without = ordered.filter((c) => c.id !== categoryId);
  const index = Math.min(Math.max(position1 - 1, 0), without.length);
  without.splice(index, 0, { id: categoryId });
  await db.$transaction(
    without.map((c, position) =>
      db.faqCategory.updateMany({ where: { id: c.id, shopId }, data: { position } }),
    ),
  );
}

async function normalizeCategoryPositions(shopId: string): Promise<void> {
  const ordered = await db.faqCategory.findMany({
    where: { shopId },
    orderBy: [{ position: "asc" }, { name: "asc" }],
    select: { id: true },
  });
  await db.$transaction(
    ordered.map((c, position) =>
      db.faqCategory.updateMany({ where: { id: c.id, shopId }, data: { position } }),
    ),
  );
}

// ── FAQs ────────────────────────────────────────────────────────────────────

export const faqInputSchema = z.object({
  id: z.string().optional(),
  question: z.string().trim().min(1).max(500),
  /** Raw editor HTML — sanitized server-side before storage (XSS). */
  answerHtml: z.string().max(20_000).default(""),
  status: z.enum(["published", "draft"]).default("draft"),
  categoryId: z.string().min(1),
  featured: z.boolean().default(false),
});

export type FaqInput = z.input<typeof faqInputSchema>;

export async function saveFaq(shopId: string, input: FaqInput): Promise<string> {
  requireShopId(shopId);
  const parsed = faqInputSchema.parse(input);
  const category = await db.faqCategory.findFirst({
    where: { id: parsed.categoryId, shopId },
    select: { id: true },
  });
  if (!category) throw new Error("faq: category not found");
  const answerHtml = sanitizeHtml(parsed.answerHtml);

  let id = parsed.id ?? null;
  if (id) {
    const existing = await db.faq.findFirst({ where: { id, shopId }, select: { id: true } });
    if (!existing) throw new Error("faq: FAQ not found");
    await db.faq.updateMany({
      where: { id, shopId },
      data: {
        question: parsed.question,
        answerHtml,
        status: parsed.status,
        categoryId: category.id,
        featured: parsed.featured,
      },
    });
  } else {
    const max = await db.faq.aggregate({
      where: { shopId, categoryId: category.id },
      _max: { position: true },
    });
    const created = await db.faq.create({
      data: {
        shopId,
        question: parsed.question,
        answerHtml,
        status: parsed.status,
        categoryId: category.id,
        featured: parsed.featured,
        position: (max._max.position ?? -1) + 1,
      },
    });
    id = created.id;
  }
  await syncFaqKnowledgeSafe(shopId);
  return id;
}

export async function deleteFaq(shopId: string, faqId: string): Promise<boolean> {
  requireShopId(shopId);
  const result = await db.faq.deleteMany({ where: { id: faqId, shopId } });
  if (result.count > 0) await syncFaqKnowledgeSafe(shopId);
  return result.count > 0;
}

export async function setFaqFeatured(
  shopId: string,
  faqId: string,
  featured: boolean,
): Promise<void> {
  requireShopId(shopId);
  await db.faq.updateMany({ where: { id: faqId, shopId }, data: { featured } });
}

export async function moveFaq(
  shopId: string,
  faqId: string,
  direction: "up" | "down",
): Promise<void> {
  requireShopId(shopId);
  const faq = await db.faq.findFirst({
    where: { id: faqId, shopId },
    select: { id: true, categoryId: true },
  });
  if (!faq) return;
  const siblings = await db.faq.findMany({
    where: { shopId, categoryId: faq.categoryId },
    orderBy: [{ position: "asc" }, { question: "asc" }],
    select: { id: true },
  });
  const index = siblings.findIndex((f) => f.id === faqId);
  const target = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= siblings.length) return;
  [siblings[index], siblings[target]] = [siblings[target], siblings[index]];
  await db.$transaction(
    siblings.map((f, position) =>
      db.faq.updateMany({ where: { id: f.id, shopId }, data: { position } }),
    ),
  );
  await syncFaqKnowledgeSafe(shopId); // chunk order follows FAQ order
}

/**
 * Place a FAQ at a 0-based index within a category (drag-and-drop reorder).
 * Supports moving across categories; positions in the target category are
 * reindexed. Gaps left in the source category are harmless — ordering is
 * relative and listFaqTree sorts by position.
 */
export async function placeFaq(
  shopId: string,
  faqId: string,
  categoryId: string,
  index: number,
): Promise<void> {
  requireShopId(shopId);
  const [faq, category] = await Promise.all([
    db.faq.findFirst({ where: { id: faqId, shopId }, select: { id: true } }),
    db.faqCategory.findFirst({ where: { id: categoryId, shopId }, select: { id: true } }),
  ]);
  if (!faq || !category) return;
  const siblings = await db.faq.findMany({
    where: { shopId, categoryId },
    orderBy: [{ position: "asc" }, { question: "asc" }],
    select: { id: true },
  });
  const without = siblings.filter((f) => f.id !== faqId);
  const at = Math.min(Math.max(index, 0), without.length);
  without.splice(at, 0, { id: faqId });
  await db.$transaction([
    db.faq.updateMany({ where: { id: faqId, shopId }, data: { categoryId } }),
    ...without.map((f, position) =>
      db.faq.updateMany({ where: { id: f.id, shopId }, data: { position } }),
    ),
  ]);
  await syncFaqKnowledgeSafe(shopId); // chunk order follows FAQ order
}

// ── Import / export ─────────────────────────────────────────────────────────

export interface FaqImportResult {
  imported: number;
  badRows: { line: number; reason: string }[];
}

/**
 * Import "question,answer" CSV text (≤1MB): rows become published FAQs in the
 * default category. Column mapping/row cap via parseCsvContent (spec 04).
 */
export async function importFaqCsv(shopId: string, csvText: string): Promise<FaqImportResult> {
  requireShopId(shopId);
  if (Buffer.byteLength(csvText, "utf-8") > FAQ_CSV_MAX_BYTES) {
    throw new Error("CSV too large (max 1MB)");
  }
  const { rows, badRows } = parseCsvContent(csvText);
  if (rows.length === 0) return { imported: 0, badRows };
  const defaultId = await ensureDefaultCategory(shopId);
  const max = await db.faq.aggregate({
    where: { shopId, categoryId: defaultId },
    _max: { position: true },
  });
  let position = (max._max.position ?? -1) + 1;
  await db.faq.createMany({
    data: rows.map((row) => ({
      shopId,
      categoryId: defaultId,
      question: row.question.slice(0, 500),
      answerHtml: sanitizeHtml(row.answer),
      status: "published",
      position: position++,
    })),
  });
  await syncFaqKnowledgeSafe(shopId);
  return { imported: rows.length, badRows };
}

/**
 * Export FAQs as CSV. Header includes extra columns (category/status/featured)
 * for reference — re-import maps question/answer by header, so a round-trip
 * preserves Q&A content.
 */
export async function exportFaqCsv(
  shopId: string,
  scope: "all" | "published",
): Promise<string> {
  requireShopId(shopId);
  const tree = await listFaqTree(shopId);
  const lines: string[] = ["question,answer,category,status,featured"];
  for (const category of tree) {
    for (const faq of category.faqs) {
      if (scope === "published" && faq.status !== "published") continue;
      lines.push(
        [faq.question, faq.answerHtml, category.name, faq.status, String(faq.featured)]
          .map(csvCell)
          .join(","),
      );
    }
  }
  return lines.join("\r\n");
}

function csvCell(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/**
 * Knowledge bridge — never let an embedding hiccup fail the merchant's save;
 * the FAQ source row surfaces status=error in the Custom knowledge tab.
 */
async function syncFaqKnowledgeSafe(shopId: string): Promise<void> {
  try {
    await syncFaqKnowledge(shopId);
  } catch (error) {
    console.error("faq_knowledge_sync_error", shopId, error);
  }
}
