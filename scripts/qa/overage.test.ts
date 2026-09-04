/* QA: conversation metering + overage billing (spec 15 · cases A-02, A-03,
 * A-17, A-18, and the 2026-09-03 hardening).
 *
 *   Run: npx tsx scripts/qa/overage.test.ts
 *   Needs: the dev Postgres up. No dev server, no Shopify — the run forces
 *          BILLING_TEST_MODE, so appUsageRecordCreate is never called for real.
 *
 * This is the suite that has to hold before any pricing change ships: it is the
 * difference between "we bill for extra conversations" and "we work for free
 * and nobody notices". Every fixture is a synthetic shop, removed in `finally`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Load .env manually (tsx does not) BEFORE importing app modules.
for (const line of readFileSync(join(process.cwd(), ".env"), "utf-8").split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (match && !line.trim().startsWith("#") && process.env[match[1]] === undefined) {
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}
process.env.SHOPIFY_API_KEY ||= "qa-placeholder-key";
process.env.SHOPIFY_API_SECRET ||= "qa-placeholder-secret";
process.env.SHOPIFY_APP_URL ||= "http://localhost:3000";
process.env.SCOPES ||= "read_products";
// Never touch real billing from a test run.
process.env.BILLING_TEST_MODE = "true";

const TAG = `qa-overage-${Date.now()}`;
let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  PASS ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function section(title: string): void {
  console.log(`\n── ${title}`);
}

async function main(): Promise<void> {
  const db = (await import("../../app/db.server")).default;
  const usage = await import("../../app/lib/billing/usage.server");
  const records = await import("../../app/lib/billing/usage-records.server");
  const cap = await import("../../app/lib/billing/usage-cap.server");
  const plans = await import("../../app/lib/billing/plans.server");
  const billing = await import("../../app/lib/billing/shopify-billing.server");
  const adminSettings = await import("../../app/lib/admin/admin-settings.server");

  const shopIds: string[] = [];
  const period = usage.currentPeriodStart();
  const snapshotPlans = await db.appSecret.findUnique({ where: { key: "admin:plans" } });

  const mkShop = async (label: string, data: Record<string, unknown>) => {
    const shop = await db.shop.create({
      data: { domain: `${TAG}-${label}.myshopify.invalid`, name: `QA ${label}`, ...data } as never,
    });
    shopIds.push(shop.id);
    return shop;
  };
  const mkConvo = (shopId: string, extra: Record<string, unknown> = {}) =>
    db.conversation.create({
      data: {
        shopId,
        sessionId: `${TAG}-${Math.random().toString(36).slice(2)}`,
        lastMessageAt: new Date(),
        ...extra,
      } as never,
    });
  const setUsage = (shopId: string, conversationCount: number, overageCount = 0, overageReported = 0) =>
    db.planUsage.upsert({
      where: { shopId_periodStart: { shopId, periodStart: period } },
      create: { shopId, periodStart: period, conversationCount, overageCount, overageReported },
      update: { conversationCount, overageCount, overageReported },
    });
  const usageRow = (shopId: string) =>
    db.planUsage.findUniqueOrThrow({
      where: { shopId_periodStart: { shopId, periodStart: period } },
    });

  try {
    await plans.loadPlanConfig();
    const rate = plans.PLANS.basic.overagePerConversation;
    const quota = plans.PLANS.basic.quotas.conversations;
    if (rate === null) {
      ok("Basic has an overage rate (the suite needs one)", false);
      return;
    }

    section("0. Matrix");
    ok("enforcement is 'enforced' — nothing meters in open mode", plans.planEnforcementMode() === "enforced", plans.planEnforcementMode());
    ok("Free has NO overage rate", plans.PLANS.free.overagePerConversation === null);
    for (const id of ["basic", "pro", "plus"] as const) {
      ok(`${id} has an overage rate`, typeof plans.PLANS[id].overagePerConversation === "number", String(plans.PLANS[id].overagePerConversation));
    }

    // ── A-18: metering rules ────────────────────────────────────────────────
    section("1. Metering — one conversation = one 30-minute session");
    const meter = await mkShop("meter", {
      plan: "basic",
      planStatus: "active",
      billingInterval: "monthly",
      subscriptionId: "gid://shopify/AppSubscription/meter",
      usageLineItemId: "gid://shopify/AppSubscriptionLineItem/meter-usage",
    });
    await setUsage(meter.id, 0);
    const convo = await mkConvo(meter.id);
    const t1 = await usage.tickConversation({ shopId: meter.id, conversationId: convo.id, previousLastMessageAt: convo.lastMessageAt });
    ok("the first AI message of a session ticks", t1.ticked && t1.conversationCount === 1);
    const t2 = await usage.tickConversation({ shopId: meter.id, conversationId: convo.id, previousLastMessageAt: new Date() });
    ok("a second message in the same session does NOT tick", t2.ticked === false && t2.conversationCount === 1);
    const stale = new Date(Date.now() - usage.SESSION_INACTIVITY_MS - 1000);
    const t3 = await usage.tickConversation({ shopId: meter.id, conversationId: convo.id, previousLastMessageAt: stale });
    ok("resuming after 30 minutes ticks again", t3.ticked === true && t3.conversationCount === 2);
    const testConvo = await mkConvo(meter.id, { isTest: true });
    ok("Test AI never ticks (flag)", (await usage.tickConversation({ shopId: meter.id, conversationId: testConvo.id, isTest: true })).ticked === false);
    ok("Test AI never ticks (row)", (await usage.tickConversation({ shopId: meter.id, conversationId: testConvo.id })).ticked === false);
    ok("an unknown conversation never ticks", (await usage.tickConversation({ shopId: meter.id, conversationId: "does-not-exist" })).ticked === false);

    section("2. Tenancy + concurrency");
    const other = await mkShop("other", { plan: "free" });
    const foreign = await mkConvo(other.id);
    ok("another shop's conversation never ticks", (await usage.tickConversation({ shopId: meter.id, conversationId: foreign.id })).ticked === false);
    await setUsage(meter.id, 0);
    const many = await Promise.all([1, 2, 3, 4, 5].map(() => mkConvo(meter.id)));
    await Promise.all(
      many.map((c) => usage.tickConversation({ shopId: meter.id, conversationId: c.id, previousLastMessageAt: c.lastMessageAt })),
    );
    ok("5 parallel sessions = exactly 5 ticks (atomic increment)", (await usageRow(meter.id)).conversationCount === 5, String((await usageRow(meter.id)).conversationCount));

    // ── A-17: billing the overage ───────────────────────────────────────────
    section("3. Every conversation past the allowance is billed exactly once");
    await setUsage(meter.id, quota + 4, 4, 0);
    cap.invalidateUsageBalance(meter.id);
    ok("4 conversations owed", (await records.unbilledOverage(meter.id, period)) === 4);
    const billedFirst = await records.submitOverageRecords(meter.id, period);
    ok("all 4 are billed in one pass", billedFirst.accepted === 4 && billedFirst.owed === 0, JSON.stringify(billedFirst));
    ok("overageReported now matches overageCount", (await usageRow(meter.id)).overageReported === 4);
    ok("a second pass charges nothing (no double billing)", (await records.submitOverageRecords(meter.id, period)).accepted === 0);

    section("4. A failed report is retried, never lost");
    // 5 more conversations served, none reported — exactly the state a network
    // blip at tick time leaves behind. The hourly reconcile job runs this call.
    await setUsage(meter.id, quota + 9, 9, 4);
    ok("5 owed after a simulated failure", (await records.unbilledOverage(meter.id, period)) === 5);
    const retried = await records.submitOverageRecords(meter.id, period);
    ok("the reconcile pass bills exactly the 5 owed", retried.accepted === 5 && retried.owed === 0, JSON.stringify(retried));

    // ── The merchant's approved spend ceiling ───────────────────────────────
    section("5. The approved ceiling stops the app working for free");
    ok("the balance reflects what was billed", (await cap.usageBalance(meter.id)).used === Number((9 * rate).toFixed(2)), `$${(9 * rate).toFixed(2)}`);
    ok("under the ceiling the AI keeps answering", (await usage.aiAllowed(meter.id)) === true);
    const toCeiling = Math.floor(billing.USAGE_CAPPED_AMOUNT / rate);
    await setUsage(meter.id, quota + toCeiling, toCeiling, toCeiling);
    cap.invalidateUsageBalance(meter.id);
    const balance = await cap.usageBalance(meter.id);
    ok("the ceiling is reached", balance.remaining < rate, `remaining $${balance.remaining.toFixed(2)}`);
    ok("aiAllowed STOPS — no unpaid conversations", (await usage.aiAllowed(meter.id)) === false);
    const ceilingStatus = await usage.usageStatus(meter.id);
    ok("usageStatus flags it for the merchant banner", ceilingStatus.ceilingReached === true);
    ok("usageStatus reports the spend", ceilingStatus.spend === Number((toCeiling * rate).toFixed(2)), `$${ceilingStatus.spend}`);
    ok("nothing is left unbilled", ceilingStatus.unbilled === 0);
    ok("the next ceiling step is higher", billing.nextUsageCap(balance.capped) > balance.capped, `$${billing.nextUsageCap(balance.capped)}`);
    ok("raising the ceiling succeeds", (await billing.raiseUsageCap(meter.domain, "gid://line", billing.nextUsageCap(balance.capped))).ok === true);

    section("6. Warnings fire before the merchant is surprised");
    await setUsage(meter.id, Math.ceil(quota * 0.85), 0, 0);
    cap.invalidateUsageBalance(meter.id);
    const near = await usage.usageStatus(meter.id);
    ok("nearCap at 85% of the allowance", near.nearCap === true, `${near.pct}%`);
    ok("not yet reported as overage", near.overage === 0 && near.ceilingReached === false);
    await setUsage(meter.id, quota + 3, 3, 3);
    cap.invalidateUsageBalance(meter.id);
    const over = await usage.usageStatus(meter.id);
    ok("past the allowance it reports the count AND the money", over.overage === 3 && over.spend > 0, `${over.overage} @ $${over.spend}`);
    ok("nearCap is off once genuinely over", over.nearCap === false);

    // ── A-02 / A-03: who can never be billed ────────────────────────────────
    section("7. Free hard-caps (no subscription, no usage line)");
    const free = await mkShop("free", { plan: "free" });
    await setUsage(free.id, plans.PLANS.free.quotas.conversations, 0, 0);
    ok("aiAllowed is false at the cap", (await usage.aiAllowed(free.id)) === false);
    const freeConvo = await mkConvo(free.id);
    const freeTick = await usage.tickConversation({ shopId: free.id, conversationId: freeConvo.id, previousLastMessageAt: freeConvo.lastMessageAt });
    ok("the counter still ticks but records no overage", freeTick.ticked && freeTick.overageRecorded === false);
    ok("submitting bills nothing", (await records.submitOverageRecords(free.id, period)).accepted === 0);
    const freeStatus = await usage.usageStatus(free.id);
    ok("usageStatus says not billable", freeStatus.billable === false && freeStatus.ceilingReached === false);
    await setUsage(free.id, plans.PLANS.free.quotas.conversations - 1, 0, 0);
    ok("below the cap the AI answers", (await usage.aiAllowed(free.id)) === true);

    section("8. Yearly hard-caps — Shopify rejects usage lines on annual subs (D1)");
    const yearly = await mkShop("yearly", {
      plan: "basic",
      planStatus: "active",
      billingInterval: "yearly",
      subscriptionId: "gid://shopify/AppSubscription/yearly",
      usageLineItemId: "gid://shopify/AppSubscriptionLineItem/yearly-usage",
    });
    ok("overageBillable is false even WITH a usage line", usage.overageBillable({ plan: "basic", billingInterval: "yearly", usageLineItemId: "gid://line" }) === false);
    await setUsage(yearly.id, quota + 5, 5, 0);
    ok("aiAllowed is false at the cap", (await usage.aiAllowed(yearly.id)) === false);
    ok("submitting bills nothing", (await records.submitOverageRecords(yearly.id, period)).accepted === 0);
    ok("the debt is not silently cleared", (await usageRow(yearly.id)).overageReported === 0);

    section("9. A monthly plan with no usage line hard-caps too");
    const noLine = await mkShop("noline", { plan: "basic", planStatus: "active", billingInterval: "monthly", subscriptionId: "gid://n" });
    await setUsage(noLine.id, quota, 0, 0);
    ok("aiAllowed is false at the cap", (await usage.aiAllowed(noLine.id)) === false);

    section("10. Open enforcement = the top tier, NOT unlimited");
    const storedPlans = await adminSettings.getStoredPlanConfig();
    await adminSettings.savePlanConfig({ ...storedPlans, enforcement: "open" });
    await plans.loadPlanConfig();
    const topPlan = plans.PLANS[plans.OPEN_MODE_PLAN];
    ok("a Basic shop is granted the top tier's quota", plans.getQuota("basic", "conversations") === topPlan.quotas.conversations, `${plans.getQuota("basic", "conversations")}`);
    ok("the quota is a real number, not MAX_SAFE_INTEGER", !plans.isUnlimitedQuota(plans.getQuota("basic", "conversations")));
    ok("a Free shop is granted the top tier's features", plans.hasFeature("free", "exports") === true);
    ok("open mode is never a downgrade for the top tier itself", plans.getQuota("plus", "conversations") === topPlan.quotas.conversations);
    ok("a genuinely unlimited dimension stays unlimited", plans.isUnlimitedQuota(plans.getQuota("free", "active_campaigns")) === plans.isUnlimitedQuota(topPlan.quotas.active_campaigns));
    // Between its own cap and the top tier's, a Basic shop is served and not billed.
    await setUsage(meter.id, quota + 50, 0, 0);
    ok("above its OWN quota the AI keeps answering", (await usage.aiAllowed(meter.id)) === true);
    const openConvo = await mkConvo(meter.id);
    const openTick = await usage.tickConversation({ shopId: meter.id, conversationId: openConvo.id, previousLastMessageAt: openConvo.lastMessageAt });
    ok("and nothing is billed there", openTick.overageRecorded === false && openTick.withinQuota === true);
    // Past the TOP tier's cap the ceiling is real again.
    await setUsage(meter.id, topPlan.quotas.conversations, 0, 0);
    const cappedConvo = await mkConvo(meter.id);
    const cappedTick = await usage.tickConversation({ shopId: meter.id, conversationId: cappedConvo.id, previousLastMessageAt: cappedConvo.lastMessageAt });
    ok("past the TOP tier's quota there IS a ceiling", cappedTick.withinQuota === false, `${cappedTick.conversationCount}/${topPlan.quotas.conversations}`);
    await adminSettings.savePlanConfig(storedPlans);
    await plans.loadPlanConfig();
    ok("enforcement restored", plans.planEnforcementMode() === "enforced");
    ok("quotas are back to the shop's own plan", plans.getQuota("basic", "conversations") === quota, `${plans.getQuota("basic", "conversations")}`);

    section("11. Annual billing can be withdrawn");
    ok("annual billing is offered by default", plans.yearlyBillingEnabled() === true);
    const beforeYearly = await adminSettings.getStoredPlanConfig();
    await adminSettings.savePlanConfig({ ...beforeYearly, yearlyBilling: false });
    await plans.loadPlanConfig();
    ok("the switch takes effect", plans.yearlyBillingEnabled() === false);
    // The card hiding its toggle is presentation; THIS is the guard, because the
    // interval arrives in a form field.
    const planUsageSrc = readFileSync(join(process.cwd(), "app", "routes", "app.plan-usage.tsx"), "utf-8");
    ok(
      "the subscribe action refuses a yearly interval when it is off",
      /interval === "yearly" && !yearlyBillingEnabled\(\)/.test(planUsageSrc),
    );
    ok(
      "the card is told, so the toggle disappears too",
      /yearlyEnabled=\{data\.yearlyEnabled\}/.test(planUsageSrc) &&
        /yearlyBillingEnabled\(\) \|\| shop\?\.billingInterval === "yearly"/.test(planUsageSrc),
    );
    ok(
      "a shop already on annual still sees its own interval",
      /shop\?\.billingInterval === "yearly"/.test(planUsageSrc),
    );
    await adminSettings.savePlanConfig(beforeYearly);
    await plans.loadPlanConfig();
    ok("annual billing restored", plans.yearlyBillingEnabled() === true);

    section("12. The period key is the 1st of the month, UTC");
    const jan = usage.currentPeriodStart(new Date("2026-01-31T23:59:59Z"));
    const feb = usage.currentPeriodStart(new Date("2026-02-01T00:00:00Z"));
    ok("month rollover starts a new counter", jan.getTime() !== feb.getTime() && feb.toISOString().startsWith("2026-02-01"));
  } finally {
    if (snapshotPlans) {
      await db.appSecret.upsert({
        where: { key: "admin:plans" },
        create: { key: "admin:plans", value: snapshotPlans.value },
        update: { value: snapshotPlans.value },
      });
    } else {
      await db.appSecret.deleteMany({ where: { key: "admin:plans" } });
    }
    const { loadPlanConfig } = await import("../../app/lib/billing/plans.server");
    await loadPlanConfig();
    await db.message.deleteMany({ where: { shopId: { in: shopIds } } }).catch(() => undefined);
    await db.conversation.deleteMany({ where: { shopId: { in: shopIds } } }).catch(() => undefined);
    await db.planUsage.deleteMany({ where: { shopId: { in: shopIds } } }).catch(() => undefined);
    await db.shop.deleteMany({ where: { id: { in: shopIds } } }).catch(() => undefined);
    const leftover = await db.shop.count({ where: { domain: { startsWith: "qa-overage-" } } });
    ok("no QA shops left behind", leftover === 0, `${leftover} left`);
    await db.$disconnect();
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failures.length) {
      console.log("\nFailures:");
      for (const f of failures) console.log(`  - ${f}`);
    }
    process.exitCode = failed === 0 ? 0 : 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
