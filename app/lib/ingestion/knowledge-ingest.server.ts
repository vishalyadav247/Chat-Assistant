import { Prisma } from "@prisma/client";
import db from "../../db.server";
import { getQuota } from "../billing/plans.server";
import { embedTexts, toSqlVector } from "../embeddings/embedding.server";
import { env } from "../env.server";
import { stripToText } from "../sanitize.server";
import { requireShopId } from "../tenancy.server";
import { crawl, htmlToText, HARD_CRAWL_PAGE_CAP, type CrawlScope } from "./fetchers.server";

// Knowledge ingestion pipeline (spec 04): fetch content per source type →
// deterministic chunking (~1500/150) → batch embed → shop-scoped knowledge
// rows. Deterministic chunking makes re-sync idempotent: rows are rebuilt from
// scratch on every run (delete → re-insert), same input → same chunks.

export interface ChunkOptions {
  size?: number;
  overlap?: number;
}

/** Deterministic, paragraph-aware chunking (~1500 chars, ~150 overlap). */
export function chunkText(text: string, options: ChunkOptions = {}): string[] {
  const size = options.size ?? 1500;
  const overlap = options.overlap ?? 150;
  const clean = text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
  if (clean.length <= size) return clean.length > 0 ? [clean] : [];

  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + size, clean.length);
    if (end < clean.length) {
      // Prefer a paragraph/sentence boundary inside the last 20% of the window.
      const window = clean.slice(start, end);
      const boundary = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf(". "));
      if (boundary > size * 0.8) {
        end = start + boundary + 1;
      }
    }
    chunks.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks.filter((c) => c.length > 0);
}

export const FAQ_SOURCE_NAME = "Store FAQs";

interface Doc {
  topic: string;
  body: string;
}

export interface IngestResult {
  sourceId: string;
  chunkCount: number;
}

/**
 * Full (re-)ingest of one data source: load (shop-scoped) → fetch/build docs
 * per type → chunk → replace knowledge rows → embed → mark active.
 * Failures set {status: "error", metadata.error} and rethrow (job visibility).
 */
export async function ingestSource(shopId: string, sourceId: string): Promise<IngestResult> {
  requireShopId(shopId);
  const source = await db.dataSource.findFirst({ where: { id: sourceId, shopId } });
  if (!source) {
    throw new Error(`knowledge-ingest: source ${sourceId} not found for shop`);
  }
  await db.dataSource.updateMany({
    where: { id: source.id, shopId },
    data: { status: "pending" },
  });
  const meta = { ...((source.metadata ?? {}) as Record<string, unknown>) };

  try {
    const docs = await loadDocs(shopId, source.type, source.url, source.crawlScope, meta);

    const chunks: Doc[] = [];
    for (const doc of docs) {
      for (const body of chunkText(doc.body)) {
        chunks.push({ topic: doc.topic, body });
      }
    }

    // Replace rows (idempotent re-sync), then write embeddings via raw UPDATE —
    // the Prisma client cannot touch Unsupported("vector") columns.
    await db.knowledge.deleteMany({ where: { shopId, dataSourceId: source.id } });
    const rowIds: string[] = [];
    for (const chunk of chunks) {
      const row = await db.knowledge.create({
        data: { shopId, dataSourceId: source.id, topic: chunk.topic, body: chunk.body },
      });
      rowIds.push(row.id);
    }
    if (chunks.length > 0 && env().OPENAI_API_KEY) {
      const vectors = await embedTexts(chunks.map((c) => `${c.topic}. ${c.body}`));
      for (let i = 0; i < rowIds.length; i++) {
        await db.$executeRaw(Prisma.sql`
          UPDATE "knowledge" SET "embedding" = ${toSqlVector(vectors[i])}::vector
          WHERE "id" = ${rowIds[i]} AND "shopId" = ${shopId}
        `);
      }
    }

    delete meta.error;
    const status = meta.desiredStatus === "inactive" ? "inactive" : "active";
    await db.dataSource.updateMany({
      where: { id: source.id, shopId },
      data: {
        status,
        chunkCount: chunks.length,
        lastSyncedAt: new Date(),
        metadata: meta as Prisma.InputJsonValue,
      },
    });
    return { sourceId: source.id, chunkCount: chunks.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.dataSource
      .updateMany({
        where: { id: source.id, shopId },
        data: {
          status: "error",
          metadata: { ...meta, error: message.slice(0, 500) } as Prisma.InputJsonValue,
        },
      })
      .catch(() => {});
    throw error;
  }
}

/**
 * FAQ → knowledge bridge: mirror published FAQs into a single `type=faq`
 * data source ("Store FAQs"). Call after any FAQ create/update/delete/publish
 * (07 wires this); also used by jobs.
 */
export async function syncFaqKnowledge(shopId: string): Promise<IngestResult> {
  requireShopId(shopId);
  let source = await db.dataSource.findFirst({ where: { shopId, type: "faq" } });
  if (!source) {
    source = await db.dataSource.create({
      data: { shopId, type: "faq", name: FAQ_SOURCE_NAME, status: "pending" },
    });
  }
  return ingestSource(shopId, source.id);
}

// ── Per-type content loading ────────────────────────────────────────────────

async function loadDocs(
  shopId: string,
  type: string,
  url: string | null,
  crawlScope: string | null,
  meta: Record<string, unknown>,
): Promise<Doc[]> {
  switch (type) {
    case "url": {
      if (!url) throw new Error("url source has no URL");
      const shop = await db.shop.findUnique({ where: { id: shopId }, select: { plan: true } });
      // Plan quota seam = per-crawl page cap (never above the hard safety cap).
      const cap = Math.min(getQuota(shop?.plan ?? "free", "crawl_pages"), HARD_CRAWL_PAGE_CAP);
      const scope: CrawlScope =
        crawlScope === "linked" || crawlScope === "sitemap" ? crawlScope : "page";
      const pages = await crawl(url, scope, cap);
      meta.pagesUsed = pages.length; // "N of M pages used" meters read this
      return pages.map((page) => ({ topic: page.title, body: page.text }));
    }
    case "manual": {
      const question = asString(meta.question);
      const answer = asString(meta.answer);
      if (!question || !answer) throw new Error("manual source missing question/answer");
      const synonyms = Array.isArray(meta.synonyms) ? meta.synonyms.filter((s) => typeof s === "string") : [];
      const body = synonyms.length > 0 ? `${answer}\n\nAlso matches: ${synonyms.join(", ")}` : answer;
      return [{ topic: question, body }];
    }
    case "csv": {
      const rows = Array.isArray(meta.rows) ? meta.rows : [];
      const docs: Doc[] = [];
      for (const row of rows) {
        const record = row as { question?: unknown; answer?: unknown };
        const question = asString(record.question);
        const answer = asString(record.answer);
        if (question && answer) docs.push({ topic: question, body: answer });
      }
      if (docs.length === 0) throw new Error("csv source has no valid rows");
      return docs;
    }
    case "file": {
      const text = asString(meta.text);
      if (!text) {
        throw new Error(
          asString(meta.error) || "file source has no extracted text (parser pending)",
        );
      }
      return [{ topic: asString(meta.filename) || "Uploaded file", body: text }];
    }
    case "pages": {
      const pages = Array.isArray(meta.pages) ? meta.pages : [];
      const docs: Doc[] = [];
      for (const page of pages) {
        const record = page as { title?: unknown; body?: unknown };
        const title = asString(record.title);
        const rawBody = asString(record.body);
        if (!title || !rawBody) continue;
        const body = /<[a-z][\s\S]*>/i.test(rawBody) ? htmlToText(rawBody).text : rawBody;
        if (body) docs.push({ topic: title, body });
      }
      if (docs.length === 0) throw new Error("pages source has no readable pages");
      return docs;
    }
    case "faq": {
      const faqs = await db.faq.findMany({
        where: { shopId, status: "published" },
        orderBy: [{ position: "asc" }, { question: "asc" }],
        select: { question: true, answerHtml: true },
      });
      return faqs
        .map((faq) => ({ topic: faq.question, body: stripToText(faq.answerHtml) }))
        .filter((doc) => doc.body.length > 0);
    }
    default:
      throw new Error(`unknown source type "${type}"`);
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
