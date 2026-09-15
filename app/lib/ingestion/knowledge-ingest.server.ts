import { Prisma } from "@prisma/client";
import db from "../../db.server";
import { embedTexts, toSqlVector } from "../embeddings/embedding.server";
import { runtimeConfig } from "../admin/runtime-config.server";
import { stripToText } from "../sanitize.server";
import { requireShopId } from "../tenancy.server";
import { fetchPageText, htmlToText } from "./fetchers.server";

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
  const meta = { ...((source.metadata ?? {}) as Record<string, unknown>) };
  // The merchant's off switch survives every rebuild state: knowledge search
  // serves any source whose status is not "inactive", so flipping a switched-off
  // source to pending/error would put its chunks back in front of shoppers
  // (PH-1.2j).
  const switchedOff = meta.desiredStatus === "inactive" || source.status === "inactive";
  await db.dataSource.updateMany({
    where: { id: source.id, shopId },
    data: { status: switchedOff ? "inactive" : "pending" },
  });

  try {
    const docs = await loadDocs(shopId, source.type, source.url, meta, source.name);

    const chunks: Doc[] = [];
    for (const doc of docs) {
      for (const body of chunkText(doc.body)) {
        chunks.push({ topic: doc.topic, body });
      }
    }

    // Embed BEFORE touching the DB: a failed fetch or embed call must leave
    // the previous chunk set fully intact and serving (hardening spec 23 §1.3).
    let vectors: number[][] | null = null;
    if (chunks.length > 0 && runtimeConfig().openaiApiKey) {
      vectors = await embedTexts(chunks.map((c) => `${c.topic}. ${c.body}`), { shopId });
    } else if (chunks.length > 0) {
      // Chunks without embeddings can never be retrieved — make the skip
      // loud instead of showing a green source with a dead index (§4.4).
      const { logWarn } = await import("../log.server");
      logWarn("embedding_skipped", "knowledge ingest ran without an OpenAI key — chunks are not retrievable", {
        shopId,
        sourceId: source.id,
        chunks: chunks.length,
      });
      // Same visibility as the product path (metafields.server.ts embedProducts).
      const { recordEvent } = await import("../analytics/events.server");
      await recordEvent(shopId, "embedding_skipped", { sourceId: source.id, chunks: chunks.length });
    }

    delete meta.error;
    delete meta.consecutiveFailures;
    const status = switchedOff ? "inactive" : "active";

    // Swap the chunk set atomically. The advisory xact lock serializes
    // concurrent rebuilds of the same source (two overlapping runs would
    // otherwise interleave delete/insert into duplicated chunks); the
    // transaction means a mid-rebuild reader still sees the previous complete
    // set, never a half-built one. Embeddings go in via raw UPDATE — the
    // Prisma client cannot touch Unsupported("vector") columns.
    await db.$transaction(
      async (tx) => {
        await tx.$executeRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(hashtext(${shopId}), hashtext(${`knowledge:${source.id}`}))
        `);
        await tx.knowledge.deleteMany({ where: { shopId, dataSourceId: source.id } });
        for (let i = 0; i < chunks.length; i++) {
          const row = await tx.knowledge.create({
            data: { shopId, dataSourceId: source.id, topic: chunks[i].topic, body: chunks[i].body },
          });
          if (vectors) {
            await tx.$executeRaw(Prisma.sql`
              UPDATE "knowledge" SET "embedding" = ${toSqlVector(vectors[i])}::vector
              WHERE "id" = ${row.id} AND "shopId" = ${shopId}
            `);
          }
        }
        await tx.dataSource.updateMany({
          where: { id: source.id, shopId },
          data: {
            status,
            chunkCount: chunks.length,
            lastSyncedAt: new Date(),
            metadata: meta as Prisma.InputJsonValue,
          },
        });
      },
      { timeout: 120_000, maxWait: 15_000 },
    );
    return { sourceId: source.id, chunkCount: chunks.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The previous chunks survived (nothing is deleted before the transaction
    // commits), so they keep serving as the last good set while the source is
    // flagged. consecutiveFailures gates the weekly retry sweep (§1.2).
    const keptChunks = await db.knowledge
      .count({ where: { shopId, dataSourceId: source.id } })
      .catch(() => 0);
    const failures =
      (typeof meta.consecutiveFailures === "number" ? meta.consecutiveFailures : 0) + 1;
    await db.dataSource
      .updateMany({
        where: { id: source.id, shopId },
        data: {
          status: switchedOff ? "inactive" : "error",
          metadata: {
            ...meta,
            // A failed FIRST crawl indexed nothing, so it must not consume the
            // "N of M pages used" meter (QA D9). When old chunks were kept,
            // the meter keeps reflecting them.
            ...(keptChunks === 0 ? { pagesUsed: 0 } : {}),
            consecutiveFailures: failures,
            error: message.slice(0, 500),
          } as Prisma.InputJsonValue,
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

export const STORE_INFO_SOURCE_NAME = "Store info";

/**
 * Store info → knowledge bridge: one `type=store_info` data source rebuilt
 * from ShopSettings.storeInfo.about. Call after the text changes. Hidden from
 * the Custom knowledge list — the merchant edits it in Instructions.
 */
export async function syncStoreInfoKnowledge(shopId: string): Promise<IngestResult> {
  requireShopId(shopId);
  let source = await db.dataSource.findFirst({ where: { shopId, type: "store_info" } });
  if (!source) {
    source = await db.dataSource.create({
      data: { shopId, type: "store_info", name: STORE_INFO_SOURCE_NAME, status: "pending" },
    });
  }
  return ingestSource(shopId, source.id);
}

// ── Per-type content loading ────────────────────────────────────────────────

async function loadDocs(
  shopId: string,
  type: string,
  url: string | null,
  meta: Record<string, unknown>,
  name = "",
): Promise<Doc[]> {
  switch (type) {
    case "url": {
      if (!url) throw new Error("url source has no URL");
      // Exactly the page the merchant typed (spec 22); crawl_pages caps how
      // many URL sources exist, at creation.
      const page = await fetchPageText(url);
      meta.pagesUsed = 1; // "N of M pages used" meters read this
      return [{ topic: page.title, body: page.text }];
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
      // The merchant's title says what the file IS — better RAG
      // context than a filename like "doc_final_v3.pdf".
      return [{ topic: name || asString(meta.filename) || "Uploaded file", body: text }];
    }
    case "pages": {
      // Re-fetch from Shopify first. This case used to read only
      // the snapshot saved at connect time, so Re-sync — and the weekly
      // re-crawl, which runs the same job — re-embedded the SAME old text: a
      // merchant who edited their refund policy and clicked Re-sync kept the
      // agent quoting the old one. Mutates meta.pages, which ingestSource
      // persists, so the stored snapshot tracks Shopify too.
      await refreshConnectedPages(shopId, meta);
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
    // Spec 22 bridges. Built from the mirror tables, never from Shopify, so a
    // toggle rebuild costs no Admin call. Master switch off ⇒ no docs at all:
    // the source goes active with zero chunks, which is exactly "the agent has
    // none of it". Per-row learnEnabled applies only while the master is on.
    case "store_pages": {
      const { loadShopSettings } = await import("../settings/save.server");
      if (!(await loadShopSettings(shopId)).learn.pages) return [];
      const pages = await db.storePage.findMany({
        where: { shopId, learnEnabled: true },
        orderBy: { title: "asc" },
        select: { title: true, bodyText: true },
      });
      return pages
        .filter((page) => page.bodyText.trim().length > 0)
        .map((page) => ({ topic: page.title, body: page.bodyText }));
    }
    case "blog_articles": {
      const { loadShopSettings } = await import("../settings/save.server");
      if (!(await loadShopSettings(shopId)).learn.blogs) return [];
      const articles = await db.blogArticle.findMany({
        where: { shopId, learnEnabled: true },
        orderBy: { title: "asc" },
        select: { title: true, blogTitle: true, summary: true, bodyText: true },
      });
      return articles
        .map((article) => ({
          // The blog name tells the model what kind of post it is reading
          // ("Care guides" vs "News") — context the title alone often lacks.
          topic: article.blogTitle ? `${article.title} (${article.blogTitle})` : article.title,
          body: article.bodyText.trim() || article.summary.trim(),
        }))
        .filter((doc) => doc.body.length > 0);
    }
    case "policy": {
      // One Shopify legal policy. Re-read live so an edited refund
      // policy reaches the agent on re-sync / the weekly run. Same fail-soft
      // rule as the legacy pages connector: if Shopify can't be read, the
      // snapshot is re-embedded — an outage must never wipe connected knowledge.
      const policyType = asString(meta.policyType);
      if (!policyType) throw new Error("policy source has no policy type");
      const shop = await db.shop.findUnique({ where: { id: shopId }, select: { domain: true } });
      if (shop) {
        const { fetchShopPolicies } = await import("./sources.server");
        try {
          const live = (await fetchShopPolicies(shop.domain, { strict: true })).find(
            (policy) => policy.type === policyType,
          );
          if (live) {
            meta.title = live.title;
            meta.body = live.body;
            delete meta.removedInShopify;
          } else {
            // Deleted or emptied in Shopify: stop quoting it (zero chunks) and
            // flag the row so the merchant sees why, rather than an error that
            // would leave the old chunks retrievable.
            meta.body = "";
            meta.removedInShopify = true;
          }
        } catch (error) {
          const { logError } = await import("../log.server");
          logError("policy_refresh_failed_kept_snapshot", error, { shopId });
        }
      }
      const body = asString(meta.body);
      return body ? [{ topic: asString(meta.title) || name || "Store policy", body }] : [];
    }
    // Store info bridge (Instructions → General → Store info). One doc: the
    // merchant's "About your store" text, headed by the store name so "who
    // are you?" / "where are you based?" retrieve it. Empty text ⇒ zero chunks.
    case "store_info": {
      const [{ loadShopSettings }, shop] = await Promise.all([
        import("../settings/save.server"),
        db.shop.findUnique({ where: { id: shopId }, select: { name: true } }),
      ]);
      const settings = await loadShopSettings(shopId);
      const about = settings.storeInfo.about.trim();
      if (!about) return [];
      const storeName = settings.storeInfo.name.trim() || shop?.name?.trim() || "";
      return [
        {
          topic: storeName ? `About ${storeName}` : "About the store",
          body: storeName ? `Store name: ${storeName}\n\n${about}` : about,
        },
      ];
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

/**
 * Replace a Connect source's stored page list with what Shopify holds NOW.
 *
 * Fail-soft by design: if Shopify can't be read (missing scope, a transient
 * error, the shop's token gone) the stored snapshot is kept and re-embedded,
 * exactly as before this existed — an outage must never wipe knowledge the
 * merchant connected. That is why the fetch runs in strict mode: the lenient
 * connector fetchers return [] on failure, which would be indistinguishable
 * from "every page was deleted".
 *
 * A source without `policyTypes` (seeded or pre-connector rows) has nothing to
 * look up, so it too keeps its snapshot.
 */
async function refreshConnectedPages(shopId: string, meta: Record<string, unknown>): Promise<void> {
  const selected = Array.isArray(meta.policyTypes)
    ? meta.policyTypes.filter((t): t is string => typeof t === "string")
    : [];
  if (selected.length === 0) return;
  const shop = await db.shop.findUnique({ where: { id: shopId }, select: { domain: true } });
  if (!shop) return;
  // Dynamic: sources.server imports this module (resyncSource → ingestSource).
  const { fetchPageCandidates, mergeRefreshedPages } = await import("./sources.server");
  let fresh: Awaited<ReturnType<typeof fetchPageCandidates>>;
  try {
    fresh = await fetchPageCandidates(shop.domain, { strict: true });
  } catch (error) {
    const { logError } = await import("../log.server");
    logError("pages_refresh_failed_kept_snapshot", error, { shopId });
    return;
  }
  const snapshot = (Array.isArray(meta.pages) ? meta.pages : []) as Array<{
    type?: string;
    title: string;
    url: string;
    body: string;
  }>;
  meta.pages = mergeRefreshedPages(selected, fresh, snapshot);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
