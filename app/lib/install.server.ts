import type { Prisma } from "@prisma/client";
import db from "../db.server";
import { shopSettingsSchema } from "./settings/schemas";
import { enqueue } from "./jobs/queue.server";
import { JOBS } from "./jobs/handlers.server";
import { resolveShopId } from "./tenancy.server";
import { logError } from "./log.server";
import { DEFAULT_GUARDRAILS, DEFAULT_PERSONA } from "./ai-defaults";

// Install/afterAuth bootstrap (specs 02/08): shop row, default persona +
// guardrails + seeded app recommendations, initial catalog sync. Idempotent —
// afterAuth also fires on token refresh.

/** Default transcript retention for stores installing after 2026-09-14 (QA-P4). */
export const NEW_INSTALL_RETENTION_DAYS = 90;


export async function onShopAuthenticated(shopDomain: string): Promise<void> {
  try {
    // Capture the pre-auth state: a reinstall inside the grace window keeps
    // its rows but missed every webhook while uninstalled (QA D12).
    const before = await db.shop.findUnique({
      where: { domain: shopDomain },
      select: { uninstalledAt: true },
    });
    const wasUninstalled = Boolean(before?.uninstalledAt);
    const shopId = await resolveShopId(shopDomain);
    await db.shop.update({ where: { id: shopId }, data: { uninstalledAt: null } });

    const persona = await db.persona.findUnique({ where: { shopId } });
    if (!persona) {
      // Generic defaults (app/lib/ai-defaults.ts) the merchant refines in
      // Instructions → General. Store info stays empty — the merchant adds it.
      await db.persona.create({
        data: {
          shopId,
          role: DEFAULT_PERSONA.role,
          communicationStyle: DEFAULT_PERSONA.communicationStyle,
          brandVoice: DEFAULT_PERSONA.brandVoice,
          behaviours: DEFAULT_PERSONA.behaviours,
          welcomeMessage: DEFAULT_PERSONA.welcomeMessage,
        },
      });
    }

    const guardrails = await db.guardrails.findUnique({ where: { shopId } });
    if (!guardrails) {
      await db.guardrails.create({
        data: { shopId, ...DEFAULT_GUARDRAILS, bannedTopics: [...DEFAULT_GUARDRAILS.bannedTopics] },
      });
    }

    // Transcript retention defaults to 90 days for NEW installs (QA-P4, owner
    // decision 2026-09-14). `before === null` means this store had no row until
    // this authentication — afterAuth also fires on token refresh, so keying on
    // "no settings row" would silently move existing stores off "Keep forever".
    // Existing stores keep whatever they have; merchants can change it anytime.
    if (!before) {
      const settingsRow = await db.shopSettings.findUnique({ where: { shopId }, select: { id: true } });
      if (!settingsRow) {
        const settings = shopSettingsSchema.parse({ retentionDays: NEW_INSTALL_RETENTION_DAYS });
        await db.shopSettings.create({
          data: { shopId, settings: settings as unknown as Prisma.InputJsonObject },
        });
      }
    }

    // Seed app recommendations (spec 08) once.
    const recCount = await db.recommendation.count({ where: { shopId } });
    if (recCount === 0) {
      await db.recommendation.createMany({
        data: [
          {
            shopId,
            title: "Best sellers",
            triggerQuestions: ["What are your best sellers?", "Show me your top products"],
            status: "active",
          },
          {
            shopId,
            title: "New arrivals",
            triggerQuestions: ["Any new items?", "What's new?"],
            status: "active",
          },
        ],
      });
    }

    // Initial sync — when never synced (webhooks + daily reconcile keep it
    // fresh) OR on reinstall after an uninstall (catalog changed unobserved).
    const syncState = await db.syncState.findUnique({ where: { shopId } });
    if (!syncState?.productSyncAt || wasUninstalled) {
      await enqueue(JOBS.catalogSync, { shopDomain });
      await enqueue(JOBS.collectionSync, { shopDomain });
      await enqueue(JOBS.discountSync, { shopDomain });
    }
    // Spec 22 — its own stamps, so a shop installed before Pages/Blogs existed
    // gets its first content sync on the next auth instead of waiting for a
    // daily run its plan may not include.
    if (!syncState?.pageSyncAt || wasUninstalled) await enqueue(JOBS.pageSync, { shopDomain });
    if (!syncState?.articleSyncAt || wasUninstalled) await enqueue(JOBS.articleSync, { shopDomain });

    // Spec 26: a NEW store gets its instructions written from its own data once
    // the first product sync lands (the job waits for it). Stores that already
    // existed are not rewritten on a token refresh — they use Regenerate.
    if (!before || !persona) {
      const { requestAiSetup } = await import("./instructions/ai-setup.server");
      await requestAiSetup(shopId, shopDomain).catch((error) => logError("ai_setup_request_error", error, { shopId }));
    }
  } catch (error) {
    // afterAuth must never break the OAuth flow.
    logError("after_auth_error", error);
  }
}
