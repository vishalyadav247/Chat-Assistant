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
import { logError } from "../log.server";
import { invalidateShopConfig } from "../config/shop-config.server";

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
    logError("reconcile_schedule_error", error);
  });

  // Daily retention purge (spec 17 / review M1): the Settings UI already
  // promises deletion, so the job ships now. Deletes transcripts older than
  // each shop's retentionDays window (0 = keep forever). Contacts are kept
  // (governed by redact/uninstall).
  await boss.work(JOBS.retentionPurge, async () => {
    const { shopSettingsSchema } = await import("../settings/schemas");
    // Expired web sessions / one-time tokens (spec 18) ride along daily.
    const { purgeExpiredTokens } = await import("../team/tokens.server");
    await purgeExpiredTokens().catch((error: unknown) => logError("token_purge_error", error));
    // Operator sessions (spec 19) were never pruned — teamSession rows were, but
    // platformSession rows accumulated forever (QA D-23). Same daily sweep.
    const { purgeExpiredPlatformSessions } = await import("../platform/platform-auth.server");
    await purgeExpiredPlatformSessions().catch((error: unknown) =>
      logError("platform_session_purge_error", error),
    );
    await transitionExpiredTrials()
      .then((count) => {
        if (count > 0) console.log(`retention-purge: ${count} trial(s) → active`);
      })
      .catch((error: unknown) => logError("trial_transition_error", error));
    // Operator log retention (spec 21). 14 days is what keeps app_logs in
    // Postgres instead of a paid log drain — do not extend it without also
    // re-checking the volume ceiling in the spec. The second delete is the
    // backstop for the fire-and-forget race in cleanupShop: a log row written
    // microseconds after a purge would otherwise outlive its shop.
    await purgeAppLogs().catch((error: unknown) => logError("app_log_purge_error", error));
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
    logError("retention_schedule_error", error);
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
        logError("curated_revalidate_error", error, { shopId: shop.id }),
      );
    }
  });
  await boss.schedule(JOBS.curatedRevalidate, "23 5 * * *", {}, {}).catch((error: unknown) => {
    logError("curated_revalidate_schedule_error", error);
  });

  // Inbox auto-resolution (spec 10 / settings 16): every 10 minutes.
  await boss.work(JOBS.autoResolve, async () => {
    const { autoResolveInactive } = await import("../inbox/inbox.server");
    await autoResolveInactive();
  });
  await boss.schedule(JOBS.autoResolve, "*/10 * * * *", {}, {}).catch((error: unknown) => {
    logError("auto_resolve_schedule_error", error);
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
    // Non-creating lookup (QA D11): a webhook-driven job never materialises a shop.
    const shop = await db.shop.findUnique({
      where: { domain: job.data.shopDomain },
      select: { id: true },
    });
    if (!shop) return;
    const shopId = requireShopId(shop.id);
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
        logError("uninstall_purge_error", error, { shopDomain: shop.domain }),
      );
    }
  });
  await boss.schedule(JOBS.uninstallPurge, "53 4 * * *", {}, {}).catch((error: unknown) => {
    logError("uninstall_purge_schedule_error", error);
  });

  // Knowledge ingestion + weekly re-crawl (feature 04) — handlers live in
  // ingestion/knowledge-jobs.server.ts; registered + scheduled here.
  {
    const { registerKnowledgeJobs, KNOWLEDGE_RECRAWL_JOB, KNOWLEDGE_RECRAWL_CRON } = await import(
      "../ingestion/knowledge-jobs.server"
    );
    await registerKnowledgeJobs(boss);
    await boss.schedule(KNOWLEDGE_RECRAWL_JOB, KNOWLEDGE_RECRAWL_CRON, {}, {}).catch(
      (error: unknown) => logError("knowledge_recrawl_schedule_error", error),
    );
  }

  await boss.work<ShopJob & { customerEmail?: string; customerId?: string }>(
    JOBS.customerRedact,
    async ([job]) => {
      // Minimal v1: full workflow in feature 17 (.claude/specs/17-compliance-gdpr.md).
      const shop = await db.shop.findUnique({ where: { domain: job.data.shopDomain } });
      if (!shop) return;
      const shopId = requireShopId(shop.id);
      // QA D3: normalise job data to non-empty strings or undefined. A `where`
      // key set to undefined makes Prisma DROP that filter, which would turn a
      // scoped updateMany into a whole-shop one — never pass raw job values in.
      const customerEmail =
        typeof job.data.customerEmail === "string" && job.data.customerEmail.trim()
          ? job.data.customerEmail.trim()
          : undefined;
      const customerId =
        typeof job.data.customerId === "string" && job.data.customerId.trim()
          ? job.data.customerId.trim()
          : undefined;
      // Review M2: match by email OR Shopify customer id — contacts created
      // from a logged-in storefront session may have no email.
      if (!customerEmail && !customerId) return;
      const contacts = await db.contact.findMany({
        where: {
          shopId,
          OR: [
            ...(customerEmail ? [{ email: customerEmail }] : []),
            ...(customerId ? [{ shopifyCustomerId: customerId }] : []),
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
      // The redaction request itself must not retain the erased email. Only
      // when we HAVE an email — an undefined filter would scrub every request
      // of the shop (QA D3).
      if (customerEmail) {
        await db.dataRequest.updateMany({
          where: { shopId, customerEmail },
          data: { customerEmail: "[redacted]" },
        });
      }
      await db.redactLog.create({
        data: { shopId, type: "customer", completedAt: new Date() },
      });
    },
  );
}

/** Operator log retention window (spec 21 · volume ceiling rule 3). */
export const APP_LOG_RETENTION_DAYS = 14;

/**
 * Purge the operator log: anything past the retention window, plus anything
 * still attributed to an uninstalled shop (the cleanupShop race backstop).
 * Exported so scripts/tests can run it without the scheduler.
 */
/**
 * Trial → active (QA D-08). `planStatus` is stamped at subscribe time from
 * `trialEndsAt` and nothing moved it afterwards, so a shop whose trial had
 * lapsed sat at "trial" indefinitely unless an `app_subscriptions/update`
 * webhook happened to arrive. Shopify begins charging when the trial ends, so
 * the status has to follow it.
 *
 * Only shops that still hold a subscription are advanced — a cancelled shop is
 * "none"/"cancelled" and must not be resurrected into "active". Exported so the
 * billing test can drive it directly rather than re-implementing the predicate.
 */
export async function transitionExpiredTrials(now = new Date()): Promise<number> {
  const result = await db.shop.updateMany({
    where: {
      planStatus: "trial",
      trialEndsAt: { not: null, lt: now },
      subscriptionId: { not: null },
    },
    data: { planStatus: "active" },
  });
  return result.count;
}

export async function purgeAppLogs(): Promise<number> {
  const cutoff = new Date(Date.now() - APP_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const aged = await db.appLog.deleteMany({ where: { occurredAt: { lt: cutoff } } });

  const gone = await db.shop.findMany({
    where: { uninstalledAt: { not: null } },
    select: { id: true },
  });
  if (gone.length === 0) return aged.count;
  const orphaned = await db.appLog.deleteMany({
    where: { shopId: { in: gone.map((s) => s.id) } },
  });
  return aged.count + orphaned.count;
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
    db.llmUsageDaily.deleteMany({ where: { shopId } }),
    // Operator error log (spec 21) — deleted with everything else so the
    // "no rows survive cleanupShop" contract stays absolute.
    db.appLog.deleteMany({ where: { shopId } }),
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
    // Promo redemptions (spec 15) are shop-scoped too: the shop is gone for
    // good, its subscription with it, so the row must not survive shop/redact
    // (it would also keep holding a maxRedemptions slot forever). PromoCode
    // itself is operator-owned and stays.
    db.promoRedemption.deleteMany({ where: { shopId } }),
    // Session rows hold the offline token + owner PII — must go too (review M3).
    db.session.deleteMany({ where: { shop: shopDomain } }),
    // Preserve the original uninstall stamp (the purge sweep's done-marker
    // compares redactLog.completedAt against it). Billing fields reset to Free
    // (QA D6) — Shopify cancelled the subscription on uninstall; the
    // app/uninstalled webhook already did this, cleanupShop is the backstop.
    db.shop.update({
      where: { id: shopId },
      data: {
        uninstalledAt: shop.uninstalledAt ?? new Date(),
        plan: "free",
        planStatus: "none",
        subscriptionId: null,
        billingInterval: null,
        trialEndsAt: null,
        usageLineItemId: null,
      },
    }),
  ]);
  await db.redactLog.create({ data: { shopId, type: "shop", completedAt: new Date() } });

  // QA D11c: post-purge zero-row assertion across every shop-scoped table.
  // Loud (operator log + console) but non-throwing — the redactLog marker is
  // written above so the sweep doesn't retry forever; operations get a precise
  // list. This is the ONE place allowed to write an app_logs row for a shop
  // that was just purged: it only fires when the purge itself failed, in which
  // case the surviving row is the point (spec 21).
  // The 60s shop-config cache still holds this shop's persona, guardrails and
  // widget settings. Without this the pipeline can keep serving a redacted
  // shop's deleted configuration for up to a minute after erasure — a
  // compliance-adjacent staleness, not just a UX one (QA cache audit).
  invalidateShopConfig(shopId);

  const leftovers = await countShopRows(shopId, shopDomain);
  if (leftovers.length > 0) {
    logError("shop_purge_incomplete", { leftovers }, { shopId, shopDomain });
  }
}

/** Count residual rows per shop-scoped table after a purge (D11c). */
export async function countShopRows(
  shopId: string,
  shopDomain: string,
): Promise<Array<{ table: string; count: number }>> {
  requireShopId(shopId);
  const where = { where: { shopId } };
  const counts: Array<[string, number]> = [
    ["messages", await db.message.count(where)],
    ["conversations", await db.conversation.count(where)],
    ["contacts", await db.contact.count(where)],
    ["analytics_events", await db.analyticsEvent.count(where)],
    ["metrics_daily", await db.metricsDaily.count(where)],
    ["campaigns", await db.campaign.count(where)],
    ["plan_usage", await db.planUsage.count(where)],
    ["llm_usage_daily", await db.llmUsageDaily.count(where)],
    ["app_logs", await db.appLog.count(where)],
    ["knowledge", await db.knowledge.count(where)],
    ["data_sources", await db.dataSource.count(where)],
    ["faqs", await db.faq.count(where)],
    ["faq_categories", await db.faqCategory.count(where)],
    ["curated_answers", await db.curatedAnswer.count(where)],
    ["recommendations", await db.recommendation.count(where)],
    ["custom_recommendations", await db.customRecommendation.count(where)],
    ["cross_sell_pairs", await db.crossSellPair.count(where)],
    ["unresolved_questions", await db.unresolvedQuestion.count(where)],
    ["personas", await db.persona.count(where)],
    ["guardrails", await db.guardrails.count(where)],
    ["handover_configs", await db.handoverConfig.count(where)],
    ["widget_settings", await db.widgetSettings.count(where)],
    ["shop_settings", await db.shopSettings.count(where)],
    ["products", await db.product.count(where)],
    ["product_metafield_definitions", await db.productMetafieldDefinition.count(where)],
    ["collections", await db.collection.count(where)],
    ["discounts", await db.discount.count(where)],
    ["sync_states", await db.syncState.count(where)],
    ["data_requests", await db.dataRequest.count(where)],
    ["push_subscriptions", await db.pushSubscription.count(where)],
    ["team_sessions", await db.teamSession.count(where)],
    ["team_members", await db.teamMember.count(where)],
    ["promo_redemptions", await db.promoRedemption.count(where)],
    ["sessions", await db.session.count({ where: { shop: shopDomain } })],
  ];
  return counts.filter(([, count]) => count > 0).map(([table, count]) => ({ table, count }));
}
