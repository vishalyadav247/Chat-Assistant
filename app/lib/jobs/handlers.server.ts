import type { PgBoss } from "pg-boss";
import db from "../../db.server";
import { requireShopId } from "../tenancy.server";
import {
  fullCatalogSync,
  fullCollectionSync,
  fullDiscountSync,
  upsertProductFromWebhook,
  deleteProductFromWebhook,
  upsertDiscountFromWebhook,
  deleteDiscountFromWebhook,
} from "../ingestion/catalog-sync.server";

// Job registry. Handlers are idempotent — webhooks redeliver, jobs retry.
export const JOBS = {
  catalogSync: "catalog-sync",
  collectionSync: "collection-sync",
  discountSync: "discount-sync",
  productUpsert: "product-upsert",
  productDelete: "product-delete",
  discountUpsert: "discount-upsert",
  discountDelete: "discount-delete",
  reconcileAll: "reconcile-all",
  retentionPurge: "retention-purge",
  curatedRevalidate: "curated-revalidate",
  autoResolve: "auto-resolve",
  shopCleanup: "shop-cleanup",
  uninstallPurge: "uninstall-purge",
  knowledgeIngest: "knowledge-ingest",
  customerRedact: "customer-redact",
  metafieldApply: "metafield-apply",
  metafieldDefinitionsSync: "metafield-definitions-sync",
  teamNotify: "team-notify", // spec 18: browser push + handover email to team members
} as const;

/** Grace window after uninstall before domain data is erased (spec 17 delta).
 *  Long enough to survive accidental uninstalls / scope-reapproval reinstalls;
 *  well inside the 30-day shop/redact SLA. */
const UNINSTALL_GRACE_DAYS = 7;

interface ShopJob {
  shopDomain: string;
}

export async function registerHandlers(boss: PgBoss): Promise<void> {
  for (const name of Object.values(JOBS)) {
    await boss.createQueue(name).catch(() => {
      /* queue may already exist */
    });
  }

  await boss.work<ShopJob>(JOBS.catalogSync, async ([job]) => {
    await fullCatalogSync(job.data.shopDomain);
  });

  await boss.work<ShopJob>(JOBS.collectionSync, async ([job]) => {
    await fullCollectionSync(job.data.shopDomain);
  });

  await boss.work<ShopJob>(JOBS.discountSync, async ([job]) => {
    await fullDiscountSync(job.data.shopDomain);
  });

  await boss.work<ShopJob & { payload: unknown }>(JOBS.discountUpsert, async ([job]) => {
    await upsertDiscountFromWebhook(job.data.shopDomain, job.data.payload);
  });

  await boss.work<ShopJob & { payload: unknown }>(JOBS.discountDelete, async ([job]) => {
    await deleteDiscountFromWebhook(job.data.shopDomain, job.data.payload);
  });

  // Daily reconcile (spec 02): re-sync every installed shop to heal missed webhooks.
  await boss.work(JOBS.reconcileAll, async () => {
    const shops = await db.shop.findMany({
      where: { uninstalledAt: null },
      select: { id: true, domain: true },
    });
    const { catalogAutoSyncAllowed } = await import("../ingestion/catalog-sync.server");
    for (const shop of shops) {
      // Auto sync toggle + plan gate per data type (Products / Collections tabs).
      if (await catalogAutoSyncAllowed(shop.id, "products")) {
        await boss.send(JOBS.catalogSync, { shopDomain: shop.domain });
      }
      if (await catalogAutoSyncAllowed(shop.id, "collections")) {
        await boss.send(JOBS.collectionSync, { shopDomain: shop.domain });
      }
    }
  });
  await boss.schedule(JOBS.reconcileAll, "17 3 * * *", {}, {}).catch((error: unknown) => {
    console.error("reconcile_schedule_error", error);
  });

  // Daily retention purge (spec 17 / review M1): the Settings UI already
  // promises deletion, so the job ships now. Deletes transcripts older than
  // each shop's retentionDays window (0 = keep forever). Contacts are kept
  // (governed by redact/uninstall).
  await boss.work(JOBS.retentionPurge, async () => {
    const { shopSettingsSchema } = await import("../settings/schemas");
    // Expired web sessions / one-time tokens (spec 18) ride along daily.
    const { purgeExpiredTokens } = await import("../team/tokens.server");
    await purgeExpiredTokens().catch((error: unknown) => console.error("token_purge_error", error));
    const rows = await db.shopSettings.findMany({
      select: { shopId: true, settings: true },
    });
    for (const row of rows) {
      const parsed = shopSettingsSchema.safeParse(row.settings ?? {});
      const days = parsed.success ? parsed.data.retentionDays : 0;
      if (!days) continue;
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const old = await db.conversation.findMany({
        where: { shopId: row.shopId, lastMessageAt: { lt: cutoff } },
        select: { id: true },
      });
      if (old.length === 0) continue;
      const ids = old.map((c) => c.id);
      await db.message.deleteMany({ where: { shopId: row.shopId, conversationId: { in: ids } } });
      await db.unresolvedQuestion.deleteMany({
        where: { shopId: row.shopId, conversationId: { in: ids } },
      });
      await db.conversation.deleteMany({ where: { shopId: row.shopId, id: { in: ids } } });
    }
  });
  await boss.schedule(JOBS.retentionPurge, "41 4 * * *", {}, {}).catch((error: unknown) => {
    console.error("retention_schedule_error", error);
  });

  // Team notifications (spec 18): push + email delivery off the request path.
  await boss.work<{ shopId: string; conversationId: string; kind: "handover" | "humanReply" | "newConversation" }>(
    JOBS.teamNotify,
    async ([job]) => {
      const { deliverNotification } = await import("../notify/deliver.server");
      await deliverNotification(job.data);
    },
  );

  // Daily curated stock revalidation (spec 09): flags dead-stock picks.
  await boss.work(JOBS.curatedRevalidate, async () => {
    const { revalidateCuratedStock } = await import("../curated/revalidate.server");
    const shops = await db.shop.findMany({
      where: { uninstalledAt: null },
      select: { id: true },
    });
    for (const shop of shops) {
      await revalidateCuratedStock(shop.id).catch((error: unknown) =>
        console.error("curated_revalidate_error", shop.id, error),
      );
    }
  });
  await boss.schedule(JOBS.curatedRevalidate, "23 5 * * *", {}, {}).catch((error: unknown) => {
    console.error("curated_revalidate_schedule_error", error);
  });

  // Inbox auto-resolution (spec 10 / settings 16): every 10 minutes.
  await boss.work(JOBS.autoResolve, async () => {
    const { autoResolveInactive } = await import("../inbox/inbox.server");
    await autoResolveInactive();
  });
  await boss.schedule(JOBS.autoResolve, "*/10 * * * *", {}, {}).catch((error: unknown) => {
    console.error("auto_resolve_schedule_error", error);
  });

  await boss.work<ShopJob & { payload: unknown }>(JOBS.productUpsert, async ([job]) => {
    await upsertProductFromWebhook(job.data.shopDomain, job.data.payload);
  });

  await boss.work<ShopJob & { payload: unknown }>(JOBS.productDelete, async ([job]) => {
    await deleteProductFromWebhook(job.data.shopDomain, job.data.payload);
  });

  // Manage metafields (spec 07): after an enable/disable toggle, re-render
  // Product.metafieldText from the stored JSON and re-embed changed products.
  // Idempotent — a stale duplicate just finds nothing to change.
  await boss.work<{ shopId: string }>(JOBS.metafieldApply, async ([job]) => {
    const { applyMetafieldSelection } = await import("../ingestion/metafields.server");
    await applyMetafieldSelection(requireShopId(job.data.shopId));
  });

  // metafield_definitions/* webhooks (spec 07): re-mirror the definitions
  // catalog from the Admin API (payload shape irrelevant → idempotent), then
  // drop vanished-but-enabled metafields from product text + embeddings.
  await boss.work<ShopJob>(JOBS.metafieldDefinitionsSync, async ([job]) => {
    const { resolveShopId } = await import("../tenancy.server");
    const shopId = requireShopId(await resolveShopId(job.data.shopDomain));
    const { syncMetafieldDefinitions, applyMetafieldSelection } = await import(
      "../ingestion/metafields.server"
    );
    const { removedEnabled } = await syncMetafieldDefinitions(job.data.shopDomain, shopId);
    if (removedEnabled) await applyMetafieldSelection(shopId);
  });

  await boss.work<ShopJob>(JOBS.shopCleanup, async ([job]) => {
    await cleanupShop(job.data.shopDomain);
  });

  // Daily uninstall purge: erase shops whose grace window has lapsed and that
  // haven't reinstalled (reinstall clears uninstalledAt via onShopAuthenticated).
  // The shop-type redactLog row cleanupShop writes is the already-done marker.
  await boss.work(JOBS.uninstallPurge, async () => {
    const cutoff = new Date(Date.now() - UNINSTALL_GRACE_DAYS * 24 * 60 * 60 * 1000);
    const shops = await db.shop.findMany({
      where: { uninstalledAt: { lt: cutoff } },
      select: { id: true, domain: true, uninstalledAt: true },
    });
    for (const shop of shops) {
      const done = await db.redactLog.findFirst({
        where: { shopId: shop.id, type: "shop", completedAt: { gte: shop.uninstalledAt! } },
      });
      if (done) continue;
      await cleanupShop(shop.domain).catch((error: unknown) =>
        console.error("uninstall_purge_error", shop.domain, error),
      );
    }
  });
  await boss.schedule(JOBS.uninstallPurge, "53 4 * * *", {}, {}).catch((error: unknown) => {
    console.error("uninstall_purge_schedule_error", error);
  });

  // Knowledge ingestion + weekly re-crawl (feature 04) — handlers live in
  // ingestion/knowledge-jobs.server.ts; registered + scheduled here.
  {
    const { registerKnowledgeJobs, KNOWLEDGE_RECRAWL_JOB, KNOWLEDGE_RECRAWL_CRON } = await import(
      "../ingestion/knowledge-jobs.server"
    );
    await registerKnowledgeJobs(boss);
    await boss.schedule(KNOWLEDGE_RECRAWL_JOB, KNOWLEDGE_RECRAWL_CRON, {}, {}).catch(
      (error: unknown) => console.error("knowledge_recrawl_schedule_error", error),
    );
  }

  await boss.work<ShopJob & { customerEmail?: string; customerId?: string }>(
    JOBS.customerRedact,
    async ([job]) => {
      // Minimal v1: full workflow in feature 17 (.claude/specs/17-compliance-gdpr.md).
      const shop = await db.shop.findUnique({ where: { domain: job.data.shopDomain } });
      if (!shop) return;
      const shopId = requireShopId(shop.id);
      // Review M2: match by email OR Shopify customer id — contacts created
      // from a logged-in storefront session may have no email.
      if (!job.data.customerEmail && !job.data.customerId) return;
      const contacts = await db.contact.findMany({
        where: {
          shopId,
          OR: [
            ...(job.data.customerEmail ? [{ email: job.data.customerEmail }] : []),
            ...(job.data.customerId ? [{ shopifyCustomerId: job.data.customerId }] : []),
          ],
        },
        select: { id: true },
      });
      const contactIds = contacts.map((c) => c.id);
      if (contactIds.length > 0) {
        const convos = await db.conversation.findMany({
          where: { shopId, contactId: { in: contactIds } },
          select: { id: true },
        });
        const convoIds = convos.map((c) => c.id);
        await db.message.deleteMany({ where: { shopId, conversationId: { in: convoIds } } });
        // Unresolved-question copies of this customer's turns go too (audit).
        await db.unresolvedQuestion.deleteMany({
          where: { shopId, conversationId: { in: convoIds } },
        });
        await db.conversation.deleteMany({ where: { shopId, id: { in: convoIds } } });
        await db.contact.deleteMany({ where: { shopId, id: { in: contactIds } } });
      }
      // The redaction request itself must not retain the erased email.
      await db.dataRequest.updateMany({
        where: { shopId, customerEmail: job.data.customerEmail },
        data: { customerEmail: "[redacted]" },
      });
      await db.redactLog.create({
        data: { shopId, type: "customer", completedAt: new Date() },
      });
    },
  );
}

/** Delete ALL rows for a shop (uninstall cleanup; shop/redact is the ~48h backstop). */
export async function cleanupShop(shopDomain: string): Promise<void> {
  const shop = await db.shop.findUnique({ where: { domain: shopDomain } });
  if (!shop) return;
  const shopId = requireShopId(shop.id);

  // Order matters only for readability — no FK constraints between domain tables.
  await db.$transaction([
    db.message.deleteMany({ where: { shopId } }),
    db.conversation.deleteMany({ where: { shopId } }),
    db.contact.deleteMany({ where: { shopId } }),
    db.analyticsEvent.deleteMany({ where: { shopId } }),
    db.metricsDaily.deleteMany({ where: { shopId } }),
    db.campaign.deleteMany({ where: { shopId } }),
    db.planUsage.deleteMany({ where: { shopId } }),
    db.knowledge.deleteMany({ where: { shopId } }),
    db.dataSource.deleteMany({ where: { shopId } }),
    db.faq.deleteMany({ where: { shopId } }),
    db.faqCategory.deleteMany({ where: { shopId } }),
    db.curatedAnswer.deleteMany({ where: { shopId } }),
    db.recommendation.deleteMany({ where: { shopId } }),
    db.customRecommendation.deleteMany({ where: { shopId } }),
    db.crossSellPair.deleteMany({ where: { shopId } }),
    db.unresolvedQuestion.deleteMany({ where: { shopId } }),
    db.persona.deleteMany({ where: { shopId } }),
    db.guardrails.deleteMany({ where: { shopId } }),
    db.handoverConfig.deleteMany({ where: { shopId } }),
    db.widgetSettings.deleteMany({ where: { shopId } }),
    db.shopSettings.deleteMany({ where: { shopId } }),
    db.product.deleteMany({ where: { shopId } }),
    db.productMetafieldDefinition.deleteMany({ where: { shopId } }),
    db.collection.deleteMany({ where: { shopId } }),
    db.discount.deleteMany({ where: { shopId } }),
    db.syncState.deleteMany({ where: { shopId } }),
    db.dataRequest.deleteMany({ where: { shopId } }),
    // Team logins for the standalone web app (spec 18).
    db.pushSubscription.deleteMany({ where: { shopId } }),
    db.teamSession.deleteMany({ where: { shopId } }),
    db.teamMember.deleteMany({ where: { shopId } }),
    // Session rows hold the offline token + owner PII — must go too (review M3).
    db.session.deleteMany({ where: { shop: shopDomain } }),
    // Preserve the original uninstall stamp (the purge sweep's done-marker
    // compares redactLog.completedAt against it).
    db.shop.update({
      where: { id: shopId },
      data: { uninstalledAt: shop.uninstalledAt ?? new Date() },
    }),
  ]);
  await db.redactLog.create({ data: { shopId, type: "shop", completedAt: new Date() } });
}
