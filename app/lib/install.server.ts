import db from "../db.server";
import { enqueue } from "./jobs/queue.server";
import { JOBS } from "./jobs/handlers.server";
import { resolveShopId } from "./tenancy.server";
import { logError } from "./log.server";

// Install/afterAuth bootstrap (specs 02/08): shop row, default persona +
// guardrails + seeded app recommendations, initial catalog sync. Idempotent —
// afterAuth also fires on token refresh.

const DEFAULT_GUARDRAILS = {
  answerOnlyFromKnowledge: true,
  bannedTopics: ["medical advice", "legal advice", "competitor pricing"],
  fallbackMessage:
    "I'm not sure about that one — leave your email and our team will get back to you.",
};

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
      await db.persona.create({
        data: {
          shopId,
          role: "You are a friendly sales and support assistant for this store.",
          communicationStyle: "friendly",
          brandVoice: "Warm, approachable and helpful. Plain, encouraging language.",
          // What the merchant edits in Instructions → General, and what the AI
          // reads (buildPersonaPrompt). How many cards show is decided by the
          // pipeline, so this deliberately names no number; grounding and the
          // medical/legal blocks live in the lane prompts and banned topics.
          behaviours:
            "Greet warmly. Understand the shopper's need before recommending, and give a short reason for each suggestion. Ask one clarifying question if the request is vague. Never pressure.",
          welcomeMessage: "Hi {{customer_name}} 👋 What can I help you find today?",
        },
      });
    }

    const guardrails = await db.guardrails.findUnique({ where: { shopId } });
    if (!guardrails) {
      await db.guardrails.create({ data: { shopId, ...DEFAULT_GUARDRAILS } });
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
  } catch (error) {
    // afterAuth must never break the OAuth flow.
    logError("after_auth_error", error);
  }
}
