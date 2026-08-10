/* Billing mock-flow test (spec 15 / feature 15b acceptance #1).
 * Run with the dev DB up:  npx tsx scripts/test-billing-mock.ts
 *
 * Exercises the full subscribe → billing-callback → Shop update flow using the
 * MockBillingProvider (BILLING_TEST_MODE=1) against the real dev database:
 *  1. subscribe(basic, monthly) → callback → plan/status/subscriptionId/interval
 *     + trialEndsAt + usageLineItemId land on Shop, plan_changed event recorded
 *  2. subscribe(plus, yearly) → yearly interval + trial fields
 *  3. overage reporting call (mock logs, skips silently without a usage line)
 *  4. downgrade to Free → cancel + reset of all subscription fields
 */

process.env.BILLING_TEST_MODE = "1";
process.env.SHOPIFY_APP_URL = process.env.SHOPIFY_APP_URL || "https://example.com";

const TEST_DOMAIN = "billing-mock-test.myshopify.com";

let failures = 0;
function check(name: string, condition: boolean, detail?: string) {
  const mark = condition ? "✔" : "✘";
  console.log(`  ${mark} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures += 1;
}

async function main() {
  // Dynamic imports AFTER env vars are set (ESM imports hoist).
  const { default: db } = await import("../app/db.server");
  const { getBillingProvider, completeBillingReturn, downgradeToFree } = await import(
    "../app/lib/billing/shopify-billing.server"
  );
  const { reportOverageUsage } = await import("../app/lib/billing/usage-records.server");

  // Fresh test shop (isolated from the seeded dev shop).
  const stale = await db.shop.findUnique({ where: { domain: TEST_DOMAIN } });
  if (stale) {
    await db.analyticsEvent.deleteMany({ where: { shopId: stale.id } });
    await db.shop.delete({ where: { id: stale.id } });
  }
  const shop = await db.shop.create({ data: { domain: TEST_DOMAIN } });
  console.log(`test shop ${TEST_DOMAIN} (${shop.id})`);

  const provider = getBillingProvider();

  // ── 1. subscribe basic/monthly → callback ─────────────────────────────────
  console.log("\n1. subscribe(basic, monthly) → billing callback");
  const sub1 = await provider.createSubscription({
    shopDomain: TEST_DOMAIN,
    plan: "basic",
    interval: "monthly",
  });
  const url1 = new URL(sub1.confirmationUrl);
  check("confirmationUrl targets /app/billing-callback", url1.pathname === "/app/billing-callback");
  check(
    "confirmationUrl carries plan/interval/charge_id",
    url1.searchParams.get("plan") === "basic" &&
      url1.searchParams.get("interval") === "monthly" &&
      Boolean(url1.searchParams.get("charge_id")),
  );

  const ret1 = await completeBillingReturn({
    shopDomain: TEST_DOMAIN,
    plan: "basic",
    interval: "monthly",
    chargeId: url1.searchParams.get("charge_id"),
  });
  check("completeBillingReturn ok", ret1.ok, ret1.error);

  let row = await db.shop.findUniqueOrThrow({ where: { domain: TEST_DOMAIN } });
  check("Shop.plan = basic", row.plan === "basic", row.plan);
  check("Shop.planStatus = trial (7-day trial)", row.planStatus === "trial", row.planStatus);
  check(
    "Shop.subscriptionId stored",
    row.subscriptionId === url1.searchParams.get("charge_id"),
    row.subscriptionId ?? "null",
  );
  check("Shop.billingInterval = monthly", row.billingInterval === "monthly", row.billingInterval ?? "null");
  const days = row.trialEndsAt
    ? (row.trialEndsAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)
    : -1;
  check("Shop.trialEndsAt ≈ now + 7 days", days > 6.9 && days <= 7.01, `${days.toFixed(2)}d`);
  check("Shop.usageLineItemId stored (overage plan)", Boolean(row.usageLineItemId), row.usageLineItemId ?? "null");

  let events = await db.analyticsEvent.findMany({
    where: { shopId: shop.id, type: "plan_changed" },
    orderBy: { occurredAt: "asc" },
  });
  check("plan_changed event recorded", events.length === 1, `count=${events.length}`);

  // ── 2. subscribe plus/yearly (plan switch) ────────────────────────────────
  console.log("\n2. subscribe(plus, yearly) → billing callback");
  const sub2 = await provider.createSubscription({
    shopDomain: TEST_DOMAIN,
    plan: "plus",
    interval: "yearly",
  });
  const url2 = new URL(sub2.confirmationUrl);
  const ret2 = await completeBillingReturn({
    shopDomain: TEST_DOMAIN,
    plan: "plus",
    interval: "yearly",
    chargeId: url2.searchParams.get("charge_id"),
  });
  check("completeBillingReturn ok", ret2.ok, ret2.error);
  row = await db.shop.findUniqueOrThrow({ where: { domain: TEST_DOMAIN } });
  check("Shop.plan = plus", row.plan === "plus", row.plan);
  check("Shop.billingInterval = yearly", row.billingInterval === "yearly", row.billingInterval ?? "null");
  check("Shop.planStatus = trial", row.planStatus === "trial", row.planStatus);

  // ── 3. overage reporting (mock logs) ──────────────────────────────────────
  console.log("\n3. reportOverageUsage (mock mode → log line expected below)");
  await reportOverageUsage(shop.id, "Extra AI conversation beyond the 1,000/month plan allowance");
  check("reportOverageUsage completed without throwing", true);

  // ── 4. downgrade to Free (cancels subscription) ───────────────────────────
  console.log("\n4. downgrade to Free");
  const ret3 = await downgradeToFree(TEST_DOMAIN);
  check("downgradeToFree ok", ret3.ok, ret3.error);
  row = await db.shop.findUniqueOrThrow({ where: { domain: TEST_DOMAIN } });
  check("Shop.plan = free", row.plan === "free", row.plan);
  check("Shop.planStatus = none", row.planStatus === "none", row.planStatus);
  check("Shop.subscriptionId cleared", row.subscriptionId === null);
  check("Shop.billingInterval cleared", row.billingInterval === null);
  check("Shop.trialEndsAt cleared", row.trialEndsAt === null);
  check("Shop.usageLineItemId cleared", row.usageLineItemId === null);

  events = await db.analyticsEvent.findMany({
    where: { shopId: shop.id, type: "plan_changed" },
  });
  check("3 plan_changed events total", events.length === 3, `count=${events.length}`);

  // Overage report after downgrade must skip silently (no usage line item).
  await reportOverageUsage(shop.id, "should be skipped silently");
  check("overage report without usage line skips silently", true);

  // Cleanup
  await db.analyticsEvent.deleteMany({ where: { shopId: shop.id } });
  await db.shop.delete({ where: { id: shop.id } });
  await db.$disconnect();

  console.log(failures === 0 ? "\nALL CHECKS PASSED ✔" : `\n${failures} CHECK(S) FAILED ✘`);
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
