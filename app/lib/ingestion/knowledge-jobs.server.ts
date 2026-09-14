import type { PgBoss } from "pg-boss";
import db from "../../db.server";
import { requireShopId, resolveShopId } from "../tenancy.server";
import { ingestSource } from "./knowledge-ingest.server";

// Knowledge job registrations (spec 04). The jobs orchestrator
// (app/lib/jobs/handlers.server.ts) wires registerKnowledgeJobs into the main
// registry and schedules KNOWLEDGE_RECRAWL_JOB on KNOWLEDGE_RECRAWL_CRON.

export const KNOWLEDGE_INGEST_JOB = "knowledge-ingest";
export const KNOWLEDGE_RECRAWL_JOB = "knowledge-recrawl";
/** Weekly re-crawl cron target (Mondays 05:23 UTC) — scheduled by the orchestrator. */
export const KNOWLEDGE_RECRAWL_CRON = "23 5 * * 1";
/** Error-status sources retry weekly up to this many consecutive failures (~2 months). */
export const MAX_ERROR_RETRIES = 8;

export interface KnowledgeIngestJobData {
  shopDomain: string;
  sourceId: string;
}

export async function registerKnowledgeJobs(boss: PgBoss): Promise<void> {
  for (const name of [KNOWLEDGE_INGEST_JOB, KNOWLEDGE_RECRAWL_JOB]) {
    await boss.createQueue(name).catch(() => {
      /* queue may already exist */
    });
  }

  await boss.work<KnowledgeIngestJobData>(KNOWLEDGE_INGEST_JOB, async ([job]) => {
    const shopId = requireShopId(await resolveShopId(job.data.shopDomain));
    await ingestSource(shopId, job.data.sourceId);
  });

  // Weekly re-crawl: enqueue an ingest for every flagged, active url/pages
  // source of every installed shop (each ingest itself runs shop-scoped).
  // Error-status sources of ANY type are retried too (hardening spec 23 §1.2):
  // without this, one transient fetch/embed failure silenced a source forever —
  // the sweep only picked active rows and, for bridge types like `faq`, nothing
  // else ever re-ran the ingest. Capped so a permanently dead URL stops burning
  // the queue and waits for a manual Re-sync.
  await boss.work(KNOWLEDGE_RECRAWL_JOB, async () => {
    const [recrawl, errored] = await Promise.all([
      db.dataSource.findMany({
        where: { reCrawlWeekly: true, status: "active", type: { in: ["url", "pages", "policy"] } },
        select: { id: true, shopId: true },
      }),
      db.dataSource.findMany({
        where: { status: "error" },
        select: { id: true, shopId: true, metadata: true },
      }),
    ]);
    const retryable = errored.filter((s) => {
      const failures = (s.metadata as { consecutiveFailures?: unknown } | null)?.consecutiveFailures;
      return typeof failures !== "number" || failures < MAX_ERROR_RETRIES;
    });
    const seen = new Set(recrawl.map((s) => s.id));
    const sources = [...recrawl, ...retryable.filter((s) => !seen.has(s.id))];
    if (sources.length === 0) return;
    const shops = await db.shop.findMany({
      where: { id: { in: [...new Set(sources.map((s) => s.shopId))] }, uninstalledAt: null },
      select: { id: true, domain: true },
    });
    const domainByShopId = new Map(shops.map((s) => [s.id, s.domain]));
    for (const source of sources) {
      const shopDomain = domainByShopId.get(source.shopId);
      if (!shopDomain) continue;
      await boss.send(KNOWLEDGE_INGEST_JOB, {
        shopDomain,
        sourceId: source.id,
      } satisfies KnowledgeIngestJobData);
    }
  });
}
