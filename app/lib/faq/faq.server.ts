import { z } from "zod";
import db from "../../db.server";
import { syncFaqKnowledge } from "../ingestion/knowledge-ingest.server";
import { CSV_ROW_CAP, splitCsv } from "../ingestion/sources.server";
import { sanitizeHtml } from "../sanitize.server";
import { requireShopId } from "../tenancy.server";
import { logError } from "../log.server";

// FAQ CRUD server logic (spec 07). Every function takes a TRUSTED shopId
// (from authenticate.admin) as its first argument and scopes every query.
//
// Knowledge bridge (spec 04): mutations that change what the FAQ knowledge
// source reads (question / answer / published-status / order / existence) call
// syncFaqKnowledge(shopId) so published FAQs stay embedded. Star/featured and
// category cosmetics only affect the widget FAQ screen, not knowledge.

export const DEFAULT_CATEGORY_NAME = "Uncategorized";
export const FAQ_CSV_MAX_BYTES = 1024 * 1024; // 1MB (design: Import FAQs modal)

/** The shop's FAQ count cap (faqs quota — 25/50/100/250). */
async function shopFaqQuota(shopId: string): Promise<number> {
  const { getQuota } = await import("../billing/plans.server");
  const shop = await db.shop.findUnique({ where: { id: shopId }, select: { plan: true } });
  return getQuota(shop?.plan ?? "free", "faqs");
}

export interface FaqRowData {
  id: string;
  categoryId: string | null;
  question: string;
  answerHtml: string;
  status: string; // published | draft
  featured: boolean;
  position: number;
  /** ISO — DB-stamped on insert. */
  createdAt: string;
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
      icon: "page",
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
      // Alphabetical: the category Position control was
      // removed from the admin — the widget never read it — so name order is
      // the only predictable one. The position COLUMN stays but no longer
      // drives any listing.
      orderBy: [{ name: "asc" }],
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
        createdAt: faq.createdAt.toISOString(),
      })),
  }));
}

// ── Categories ──────────────────────────────────────────────────────────────

export const categoryInputSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(100),
  // Polaris icon name; legacy rows may hold emoji.
  icon: z.string().trim().min(1).max(32).default("page"),
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

/**
 * Delete a category. Its FAQs move to the default "Uncategorized" category
 * (appended at the end, order preserved) — never deleted with it. The default
 * category itself can't be deleted. Returns false when nothing was deleted.
 */
export async function deleteCategory(shopId: string, categoryId: string): Promise<boolean> {
  requireShopId(shopId);
  const category = await db.faqCategory.findFirst({
    where: { id: categoryId, shopId },
    select: { id: true, isDefault: true },
  });
  if (!category || category.isDefault) return false;

  const defaultId = await ensureDefaultCategory(shopId);
  const orphans = await db.faq.findMany({
    where: { shopId, categoryId },
    select: { id: true },
  });
  // Positions are GLOBAL (widget order) — moving orphans to the default
  // category is a relabel only, their widget slots stay exactly where they are.
  await db.$transaction([
    db.faq.updateMany({ where: { shopId, categoryId }, data: { categoryId: defaultId } }),
    db.faqCategory.deleteMany({ where: { id: categoryId, shopId } }),
  ]);
  await normalizeCategoryPositions(shopId);
  if (orphans.length > 0) await syncFaqKnowledgeSafe(shopId); // chunk order follows FAQ order
  return true;
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
  requireShopId(shopId);
  const target = await db.faqCategory.findFirst({
    where: { id: categoryId, shopId },
    select: { id: true },
  });
  if (!target) return;
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
  /** 1-based slot in the shop's GLOBAL FAQ order — the order the chat widget
   *  shows (featured list + search sort by position across all categories).
   *  Absent → a new
   *  FAQ appends at the end, an edit keeps its slot. */
  position: z.number().int().min(1).optional(),
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
    // faqs quota — creating only; editing an existing FAQ is never blocked.
    const quota = await shopFaqQuota(shopId);
    const count = await db.faq.count({ where: { shopId } });
    if (count >= quota) {
      throw new Error(`Your plan allows ${quota} FAQs — remove one or upgrade to add more`);
    }
    // End of the GLOBAL widget order (position is shop-wide, not per category).
    const max = await db.faq.aggregate({
      where: { shopId },
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
  if (parsed.position) {
    // placeFaq reindexes the whole shop order and runs the knowledge sync.
    await placeFaq(shopId, id, parsed.position - 1);
  } else {
    await syncFaqKnowledgeSafe(shopId);
  }
  return id;
}

export async function deleteFaq(shopId: string, faqId: string): Promise<boolean> {
  requireShopId(shopId);
  const result = await db.faq.deleteMany({ where: { id: faqId, shopId } });
  if (result.count > 0) await syncFaqKnowledgeSafe(shopId);
  return result.count > 0;
}

/** Bulk delete from the FAQ table's selection (owner 2026-09-16). Shop-scoped; one knowledge rebuild. */
export async function deleteFaqs(shopId: string, faqIds: string[]): Promise<number> {
  requireShopId(shopId);
  const ids = [...new Set(faqIds.filter(Boolean))].slice(0, 500);
  if (ids.length === 0) return 0;
  const result = await db.faq.deleteMany({ where: { id: { in: ids }, shopId } });
  if (result.count > 0) await syncFaqKnowledgeSafe(shopId);
  return result.count;
}

/**
 * Bulk publish / unpublish. Publishing is what puts an FAQ in front of shoppers
 * and into the AI's knowledge, so the plan's FAQ quota is not re-checked here
 * (the rows already exist) but the knowledge bridge is rebuilt once.
 */
export async function setFaqsStatus(shopId: string, faqIds: string[], status: "published" | "draft"): Promise<number> {
  requireShopId(shopId);
  const ids = [...new Set(faqIds.filter(Boolean))].slice(0, 500);
  if (ids.length === 0) return 0;
  const result = await db.faq.updateMany({ where: { id: { in: ids }, shopId }, data: { status } });
  if (result.count > 0) await syncFaqKnowledgeSafe(shopId);
  return result.count;
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
    select: { id: true },
  });
  if (!faq) return;
  // GLOBAL order: position is the FAQ's slot in
  // the CHAT WIDGET across all categories — the widget's featured list and
  // search both sort by it shop-wide, categories are only labels.
  const siblings = await db.faq.findMany({
    where: { shopId },
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
 * Place a FAQ at a 0-based index in the shop's GLOBAL FAQ order — the order
 * the CHAT WIDGET shows (featured list + search both sort by position across
 * all categories; a category is only a label). All rows are reindexed, which
 * also normalizes any legacy per-category position duplicates.
 */
export async function placeFaq(shopId: string, faqId: string, index: number): Promise<void> {
  requireShopId(shopId);
  const faq = await db.faq.findFirst({ where: { id: faqId, shopId }, select: { id: true } });
  if (!faq) return;
  const all = await db.faq.findMany({
    where: { shopId },
    orderBy: [{ position: "asc" }, { question: "asc" }],
    select: { id: true },
  });
  const without = all.filter((f) => f.id !== faqId);
  const at = Math.min(Math.max(index, 0), without.length);
  without.splice(at, 0, { id: faqId });
  await db.$transaction(
    without.map((f, position) =>
      db.faq.updateMany({ where: { id: f.id, shopId }, data: { position } }),
    ),
  );
  await syncFaqKnowledgeSafe(shopId); // chunk order follows FAQ order
}

// ── Import / export ─────────────────────────────────────────────────────────

export interface FaqImportResult {
  imported: number;
  badRows: { line: number; reason: string }[];
  /** True when the first row was consumed as a column header (QA D7 — the
   *  merchant can tell a dropped row from a header at a glance). */
  headerSkipped: boolean;
  /** Rows skipped because an FAQ with the same question already exists. */
  skipped: number;
}

/**
 * Import FAQ CSV text (≤1MB). Round-trips with exportFaqCsv: a header row may
 * name question/answer plus the optional category/status columns — categories
 * are created by name as needed. Headerless files fall back to
 * "question,answer" into the default category (published).
 * The CSV carries NO ordering and NO featured flag:
 * imported FAQs append to the end of the global widget order in file order,
 * not featured — position and featured are set in the app afterwards.
 */
export async function importFaqCsv(shopId: string, csvText: string): Promise<FaqImportResult> {
  requireShopId(shopId);
  if (Buffer.byteLength(csvText, "utf-8") > FAQ_CSV_MAX_BYTES) {
    throw new Error("CSV too large (max 1MB)");
  }
  const records = splitCsv(csvText);
  const badRows: FaqImportResult["badRows"] = [];
  if (records.length === 0) {
    return { imported: 0, badRows, headerSkipped: false, skipped: 0 };
  }

  // EXACT header tokens only. Substring matching ate real Q&A rows whose
  // question merely contained the word "question" (QA D7).
  const header = records[0].map((cell) => cell.trim().toLowerCase());
  const qCol = header.findIndex((cell) => cell === "question" || cell === "q");
  const aCol = header.findIndex((cell) => cell === "answer" || cell === "a");
  const hadHeader = qCol >= 0 && aCol >= 0 && qCol !== aCol;
  const catCol = hadHeader ? header.findIndex((cell) => cell === "category") : -1;
  const statusCol = hadHeader ? header.findIndex((cell) => cell === "status") : -1;
  const questionCol = hadHeader ? qCol : 0;
  const answerCol = hadHeader ? aCol : 1;

  const data = hadHeader ? records.slice(1) : records;
  const lineOffset = hadHeader ? 2 : 1;

  const defaultId = await ensureDefaultCategory(shopId);
  const existing = await db.faqCategory.findMany({
    where: { shopId },
    select: { id: true, name: true },
  });
  const categoryByName = new Map(existing.map((c) => [c.name.toLowerCase(), c.id]));
  let categoryCount = existing.length;

  // Imported rows append to the END of the GLOBAL widget order, in file order
  // (a category is only a label).
  const posMax = await db.faq.aggregate({ where: { shopId }, _max: { position: true } });
  let nextPosition = (posMax._max.position ?? -1) + 1;

  // Re-importing an export used to duplicate every row — skip questions the
  // shop already has, and questions repeated within the file (QA D12c).
  const existingFaqs = await db.faq.findMany({ where: { shopId }, select: { question: true } });
  const seenQuestions = new Set(existingFaqs.map((f) => f.question.trim().toLowerCase()));

  // faqs quota (25/50/100/250 — the FAQ consolidation
  // made FAQs the ONE Q&A surface, so the count is tiered like curated answers).
  // Rows past the cap are reported per line, never silently dropped.
  const faqQuota = await shopFaqQuota(shopId);
  let existingCount = existingFaqs.length;

  let imported = 0;
  let skipped = 0;
  for (let i = 0; i < data.length; i++) {
    const line = i + lineOffset;
    const question = (data[i][questionCol] ?? "").trim();
    const answer = (data[i][answerCol] ?? "").trim();
    if (!question || !answer) {
      badRows.push({ line, reason: !question ? "missing question" : "missing answer" });
      continue;
    }
    const questionKey = question.slice(0, 500).trim().toLowerCase();
    if (seenQuestions.has(questionKey)) {
      skipped++;
      continue;
    }
    if (imported >= CSV_ROW_CAP) {
      badRows.push({ line, reason: `row limit (${CSV_ROW_CAP}) exceeded` });
      continue;
    }
    if (existingCount >= faqQuota) {
      badRows.push({ line, reason: `plan FAQ limit (${faqQuota}) reached` });
      continue;
    }

    let categoryId = defaultId;
    const categoryName = catCol >= 0 ? (data[i][catCol] ?? "").trim() : "";
    if (categoryName && categoryName.toLowerCase() !== DEFAULT_CATEGORY_NAME.toLowerCase()) {
      const key = categoryName.toLowerCase();
      if (!categoryByName.has(key)) {
        const created = await db.faqCategory.create({
          data: {
            shopId,
            name: categoryName.slice(0, 100),
            icon: "page",
            position: categoryCount++,
            status: "published",
          },
        });
        categoryByName.set(key, created.id);
      }
      categoryId = categoryByName.get(key)!;
    }

    const status =
      statusCol >= 0 && /draft/i.test((data[i][statusCol] ?? "").trim()) ? "draft" : "published";

    await db.faq.create({
      data: {
        shopId,
        categoryId,
        question: question.slice(0, 500),
        answerHtml: sanitizeHtml(answer),
        status,
        // featured deliberately not settable by CSV
        // — it is chosen in the app, like position.
        position: nextPosition++,
      },
    });
    seenQuestions.add(questionKey);
    existingCount++;
    imported++;
  }

  if (imported > 0) await syncFaqKnowledgeSafe(shopId);
  return { imported, badRows, headerSkipped: hadHeader, skipped };
}

/**
 * Export FAQs as CSV — exactly the columns importFaqCsv understands
 * (question/answer/category/status), so an export can be edited and
 * re-imported. Ordering and featured are NOT exported: both are managed
 * in the app, not the file.
 */
export async function exportFaqCsv(
  shopId: string,
  scope: "all" | "published",
): Promise<string> {
  requireShopId(shopId);
  const tree = await listFaqTree(shopId);
  const lines: string[] = ["question,answer,category,status"];
  for (const category of tree) {
    for (const faq of category.faqs) {
      if (scope === "published" && faq.status !== "published") continue;
      lines.push(
        [faq.question, faq.answerHtml, category.name, faq.status].map(csvCell).join(","),
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
    logError("faq_knowledge_sync_error", error, { shopId });
  }
}
