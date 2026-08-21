/* app_subscriptions/update webhook — status handling (test cases A-13..A-16).
 * Run: npx tsx scripts/qa/subscription-webhook.test.ts
 *
 * Drives the real route action with genuinely HMAC-signed requests, so
 * authenticate.webhook() actually runs. Covers the branches that decide whether
 * a merchant keeps a paid tier:
 *   ACTIVE                       → plan granted from the VERIFIED subscription name
 *   ACTIVE for a stale sub id    → ignored (never downgrade a paying shop)
 *   CANCELLED for a replaced sub → ignored (a plan switch cancels the old one)
 *   CANCELLED for the current sub→ downgrade to Free
 *   FROZEN                       → entitlement suspended (QA D-09)
 *   PENDING / unknown            → no plan change
 *
 * Uses a throwaway shop and removes it afterwards.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHmac } from "node:crypto";

// Load .env manually (tsx does not) BEFORE importing app modules.
for (const line of readFileSync(join(process.cwd(), ".env"), "utf-8").split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (match && !line.trim().startsWith("#") && process.env[match[1]] === undefined) {
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}
process.env.SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY || "sub-webhook-key";
process.env.SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET || "sub-webhook-secret";
process.env.SHOPIFY_APP_URL = process.env.SHOPIFY_APP_URL || "https://example.com";
process.env.SCOPES = process.env.SCOPES || "read_products";
// Force the mock provider so the ACTIVE branch's "look up the live
// subscription" step reads the Shop row instead of calling Shopify.
process.env.BILLING_TEST_MODE = "1";

const SECRET = process.env.SHOPIFY_API_SECRET;
const APP_URL = process.env.SHOPIFY_APP_URL.replace(/\/$/, "");
const SHOP_DOMAIN = "sub-webhook-test.myshopify.com";
const CURRENT_SUB = "gid://shopify/AppSubscription/111";
const OTHER_SUB = "gid://shopify/AppSubscription/999";

let passed = 0;
let failed = 0;

function ok(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  PASS ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function webhookRequest(payload: unknown): Request {
  const body = JSON.stringify(payload);
  const hmac = createHmac("sha256", SECRET).update(body, "utf8").digest("base64");
  return new Request(`${APP_URL}/webhooks/app-subscriptions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-shopify-topic": "app_subscriptions/update",
      "x-shopify-hmac-sha256": hmac,
      "x-shopify-shop-domain": SHOP_DOMAIN,
      "x-shopify-api-version": "2026-07",
      "x-shopify-webhook-id": `qa-sub-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    },
    body,
  });
}

function payloadFor(status: string, subscriptionId: string, name = "ChatConvert Pro") {
  return {
    app_subscription: {
      admin_graphql_api_id: subscriptionId,
      name,
      status,
      created_at: new Date(Date.now() - 86_400_000).toISOString(),
    },
  };
}

async function main(): Promise<void> {
  const db = (await import("../../app/db.server")).default;
  const { action } = await import("../../app/routes/webhooks.app-subscriptions");
  const { savePlanConfig } = await import("../../app/lib/platform/platform-settings.server");
  const plans = await import("../../app/lib/billing/plans.server");

  const priorConfig = await db.appSecret.findUnique({
    where: { key: plans.PLAN_CONFIG_SECRET_KEY },
  });

  const shop = await db.shop.upsert({
    where: { domain: SHOP_DOMAIN },
    create: { domain: SHOP_DOMAIN, name: "Subscription webhook fixture", plan: "free" },
    update: { plan: "free", uninstalledAt: null },
  });
  const shopId = shop.id;

  const setShop = (data: Record<string, unknown>) =>
    db.shop.update({ where: { id: shopId }, data });
  const readShop = () =>
    db.shop.findUniqueOrThrow({
      where: { id: shopId },
      select: { plan: true, planStatus: true, subscriptionId: true },
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deliver = (payload: unknown) => action({ request: webhookRequest(payload) } as any);

  try {
    await savePlanConfig({ enforcement: "enforced" });

    // ── ACTIVE grants the plan named by the VERIFIED subscription ───────────
    await setShop({
      plan: "free",
      planStatus: "none",
      subscriptionId: CURRENT_SUB,
      billingInterval: "monthly",
      trialEndsAt: null,
      usageLineItemId: null,
    });
    await deliver(payloadFor("ACTIVE", CURRENT_SUB, "ChatConvert Pro"));
    let state = await readShop();
    ok("ACTIVE grants the plan from the subscription name", state.plan === "pro", state.plan);

    // ── ACTIVE for a stale subscription id must not change the plan ─────────
    await deliver(payloadFor("ACTIVE", OTHER_SUB, "ChatConvert Basic"));
    state = await readShop();
    ok(
      "stale ACTIVE for another subscription is ignored",
      state.plan === "pro" && state.subscriptionId === CURRENT_SUB,
      `${state.plan}/${state.subscriptionId}`,
    );

    // ── An unmappable subscription name must never fall back to a plan ──────
    await deliver(payloadFor("ACTIVE", CURRENT_SUB, "Some Other App Premium"));
    state = await readShop();
    ok("unknown subscription name leaves the plan alone", state.plan === "pro", state.plan);

    // ── FROZEN suspends the entitlement (QA D-09) ──────────────────────────
    await deliver(payloadFor("FROZEN", CURRENT_SUB));
    state = await readShop();
    ok(
      "FROZEN drops the shop to free and marks planStatus=frozen",
      state.plan === "free" && state.planStatus === "frozen",
      `${state.plan}/${state.planStatus}`,
    );
    ok(
      "FROZEN keeps subscriptionId so an unfreeze can restore the tier",
      state.subscriptionId === CURRENT_SUB,
      String(state.subscriptionId),
    );

    // Unfreezing (a later ACTIVE for the same subscription) restores the tier.
    await deliver(payloadFor("ACTIVE", CURRENT_SUB, "ChatConvert Pro"));
    state = await readShop();
    ok("a later ACTIVE restores the tier after a freeze", state.plan === "pro", state.plan);

    // ── FROZEN for a subscription the shop is not on is ignored ────────────
    await deliver(payloadFor("FROZEN", OTHER_SUB));
    state = await readShop();
    ok("FROZEN for a non-current subscription is ignored", state.plan === "pro", state.plan);

    // ── PENDING is not an entitlement and changes nothing ──────────────────
    await deliver(payloadFor("PENDING", CURRENT_SUB));
    state = await readShop();
    ok("PENDING changes nothing", state.plan === "pro", state.plan);

    // ── CANCELLED for a replaced subscription must not downgrade ───────────
    await deliver(payloadFor("CANCELLED", OTHER_SUB));
    state = await readShop();
    ok("CANCELLED for a replaced subscription is ignored", state.plan === "pro", state.plan);

    // ── CANCELLED for the current subscription downgrades ──────────────────
    await deliver(payloadFor("CANCELLED", CURRENT_SUB));
    state = await readShop();
    ok(
      "CANCELLED for the current subscription downgrades to free",
      state.plan === "free" && state.planStatus === "cancelled" && state.subscriptionId === null,
      `${state.plan}/${state.planStatus}`,
    );

    // ── An invalid HMAC must be rejected before any handler code runs ───────
    await setShop({ plan: "pro", planStatus: "active", subscriptionId: CURRENT_SUB });
    let rejected = false;
    const body = JSON.stringify(payloadFor("CANCELLED", CURRENT_SUB));
    const forged = new Request(`${APP_URL}/webhooks/app-subscriptions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shopify-topic": "app_subscriptions/update",
        "x-shopify-hmac-sha256": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        "x-shopify-shop-domain": SHOP_DOMAIN,
        "x-shopify-api-version": "2026-07",
        "x-shopify-webhook-id": "qa-forged",
      },
      body,
    });
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = await action({ request: forged } as any);
      rejected = (response as Response)?.status === 401;
    } catch (error) {
      rejected = (error as Response)?.status === 401;
    }
    state = await readShop();
    ok("forged HMAC is rejected", rejected);
    ok("forged HMAC caused no plan change", state.plan === "pro", state.plan);
  } finally {
    await db.analyticsEvent.deleteMany({ where: { shopId } });
    await db.shop.deleteMany({ where: { id: shopId } });
    if (priorConfig) {
      await db.appSecret.upsert({
        where: { key: plans.PLAN_CONFIG_SECRET_KEY },
        create: { key: plans.PLAN_CONFIG_SECRET_KEY, value: priorConfig.value },
        update: { value: priorConfig.value },
      });
    } else {
      await db.appSecret.deleteMany({ where: { key: plans.PLAN_CONFIG_SECRET_KEY } });
    }
    await plans.loadPlanConfig();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error("\nSUBSCRIPTION WEBHOOK TESTS FAIL", error?.message ?? error);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Disconnect the shared singleton or the open pool keeps the event loop
    // alive and the script never exits.
    const appDb = (await import("../../app/db.server")).default;
    await appDb.$disconnect();
  });
