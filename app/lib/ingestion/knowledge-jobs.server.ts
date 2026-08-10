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
  await boss.work(KNOWLEDGE_RECRAWL_JOB, async () => {
    const sources = await db.dataSource.findMany({
      where: { reCrawlWeekly: true, status: "active", type: { in: ["url", "pages"] } },
      select: { id: true, shopId: true },
    });
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
