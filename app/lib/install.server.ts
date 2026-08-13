import db from "../db.server";
import { enqueue } from "./jobs/queue.server";
import { JOBS } from "./jobs/handlers.server";
import { resolveShopId } from "./tenancy.server";

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
          behaviours:
            "Greet warmly. Understand the shopper's need before recommending. Suggest 1-3 products with a short reason each. Never pressure.",
          guidelines: [
            "Recommend only in-stock, in-budget items from the provided list",
            "Ask one clarifying question if the request is vague",
            "Keep replies to 2-3 short sentences",
            "Always mention the price when recommending",
          ],
          avoid: [
            "Inventing products, prices, or discounts",
            "Medical, legal, or financial advice",
            "Discussing competitor stores or prices",
          ],
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

    // Initial sync — only when never synced (webhooks + daily reconcile keep it fresh).
    const syncState = await db.syncState.findUnique({ where: { shopId } });
    if (!syncState?.productSyncAt) {
      await enqueue(JOBS.catalogSync, { shopDomain });
      await enqueue(JOBS.collectionSync, { shopDomain });
      await enqueue(JOBS.discountSync, { shopDomain });
    }
  } catch (error) {
    // afterAuth must never break the OAuth flow.
    console.error("after_auth_error", error);
  }
}
