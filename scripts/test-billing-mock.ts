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
// The trial-expiry section imports jobs/handlers.server, which transitively
// pulls in shopify.server — that constructs the API client at module load and
// throws without credentials. Stub them; no Shopify call is ever made here.
process.env.SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY || "billing-mock-key";
process.env.SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET || "billing-mock-secret";
process.env.SCOPES = process.env.SCOPES || "read_products";

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
  const { getBillingProvider, completeBillingReturn, downgradeToFree, isBillingTestMode } =
    await import("../app/lib/billing/shopify-billing.server");
  const { reportOverageUsage } = await import("../app/lib/billing/usage-records.server");
  const { RUNTIME_SECRET_KEY, loadRuntimeConfig } = await import(
    "../app/lib/platform/runtime-config.server"
  );

  // BILLING_TEST_MODE above is only the ENV fallback. A stored
  // /platform/settings row wins over it, so an operator who has ever saved that
  // page (billingTestMode: false) would silently push this script onto the REAL
  // provider — which then dies on missing Shopify API credentials. Force the
  // flag on for the run and restore the operator's row afterwards.
  const priorRuntime = await db.appSecret.findUnique({ where: { key: RUNTIME_SECRET_KEY } });
  const forced = { ...(priorRuntime ? JSON.parse(priorRuntime.value) : {}), billingTestMode: true };
  await db.appSecret.upsert({
    where: { key: RUNTIME_SECRET_KEY },
    create: { key: RUNTIME_SECRET_KEY, value: JSON.stringify(forced) },
    update: { value: JSON.stringify(forced) },
  });
  await loadRuntimeConfig();

  const restoreRuntime = async () => {
    if (priorRuntime) {
      await db.appSecret.upsert({
        where: { key: RUNTIME_SECRET_KEY },
        create: { key: RUNTIME_SECRET_KEY, value: priorRuntime.value },
        update: { value: priorRuntime.value },
      });
    } else {
      await db.appSecret.deleteMany({ where: { key: RUNTIME_SECRET_KEY } });
    }
    await loadRuntimeConfig();
  };

  try {
    check("mock billing provider is active", isBillingTestMode());
    await run();
  } finally {
    await restoreRuntime();
  }

  async function run() {

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
  // Two legal shapes: with SHOPIFY_API_KEY set (production + this script) the
  // return URL points INSIDE the admin —
  // /store/<handle>/apps/<api-key>/app/billing-callback — so the merchant lands
  // back in the embedded iframe. Without the key it falls back to the bare app
  // domain. Both must end at the same route.
  check(
    "confirmationUrl targets /app/billing-callback",
    url1.pathname.endsWith("/app/billing-callback"),
    url1.pathname,
  );
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

  // ── 5. plan copy is computed from the matrix, never hard-coded (QA D10) ───
  console.log("\n5. plan copy derives from the plan matrix");
  const { PLANS } = await import("../app/lib/billing/plans.server");
  const { yearlySavingsPercent, savingsBadgeLabel, termsFor } = await import(
    "../app/components/PlanCards"
  );
  const { faqItems } = await import("../app/components/PlanFaq");
  const { yearlyTotal } = await import("../app/lib/billing/shopify-billing.server");

  const cardFor = (id: "basic" | "pro" | "plus") => ({
    id,
    name: PLANS[id].name,
    description: "",
    priceMonthly: PLANS[id].priceMonthly,
    priceYearlyPerMonth: PLANS[id].priceYearlyPerMonth,
    yearlyTotal: yearlyTotal(id),
    trialDays: PLANS[id].trialDays,
    overagePerConversation: PLANS[id].overagePerConversation,
    bullets: [],
    popular: false,
  });
  const basicCard = cardFor("basic");
  const expectedBasic = Math.round(
    (1 - basicCard.yearlyTotal / (basicCard.priceMonthly * 12)) * 100,
  );
  check(
    "yearlySavingsPercent(basic) matches the matrix formula",
    yearlySavingsPercent(basicCard) === expectedBasic,
    `${yearlySavingsPercent(basicCard)}% vs ${expectedBasic}%`,
  );
  check(
    "termsFor(yearly) quotes the computed saving",
    termsFor(basicCard, "yearly").includes(`you save ${expectedBasic}%`),
    termsFor(basicCard, "yearly"),
  );
  // Synthetic plan proves the % is computed, not the 18% literal it used to be.
  const synthetic = { ...basicCard, priceMonthly: 10, yearlyTotal: 60 };
  check("synthetic 10/mo vs 60/yr → 50%", yearlySavingsPercent(synthetic) === 50);
  check(
    "savingsBadgeLabel derives from the plans passed in",
    savingsBadgeLabel([synthetic]) === "Save 50%",
    String(savingsBadgeLabel([synthetic])),
  );
  check(
    "badge label reflects the real matrix",
    savingsBadgeLabel([cardFor("basic"), cardFor("pro"), cardFor("plus")])?.includes("%") === true,
    String(savingsBadgeLabel([cardFor("basic"), cardFor("pro"), cardFor("plus")])),
  );

  const overageQ = (rate: number | null) => faqItems(rate)[1][1];
  check("FAQ overage copy uses the passed rate (0.4)", overageQ(0.4).includes("$0.40"), overageQ(0.4));
  check("FAQ overage copy uses the passed rate (1.25)", overageQ(1.25).includes("$1.25"));
  check("FAQ overage copy has no rate when the plan has none", !overageQ(null).includes("$"));

  // ── 5. Trial → active sweep (QA D-08) ─────────────────────────────────────
  console.log("\n5. trial expiry");
  const { transitionExpiredTrials } = await import("../app/lib/jobs/handlers.server");

  // A live subscription whose trial has lapsed must advance to "active".
  await db.shop.update({
    where: { id: shop.id },
    data: {
      plan: "basic",
      planStatus: "trial",
      subscriptionId: "gid://shopify/AppSubscription/trial-probe",
      trialEndsAt: new Date(Date.now() - 60_000),
    },
  });
  await transitionExpiredTrials();
  const advanced = await db.shop.findUnique({ where: { id: shop.id }, select: { planStatus: true } });
  check("expired trial advances to active", advanced?.planStatus === "active", advanced?.planStatus);

  // A trial that has NOT expired must be left alone.
  await db.shop.update({
    where: { id: shop.id },
    data: { planStatus: "trial", trialEndsAt: new Date(Date.now() + 86_400_000) },
  });
  await transitionExpiredTrials();
  const stillTrial = await db.shop.findUnique({ where: { id: shop.id }, select: { planStatus: true } });
  check("unexpired trial is untouched", stillTrial?.planStatus === "trial", stillTrial?.planStatus);

  // A cancelled shop must never be resurrected into "active".
  await db.shop.update({
    where: { id: shop.id },
    data: {
      planStatus: "trial",
      subscriptionId: null,
      trialEndsAt: new Date(Date.now() - 60_000),
    },
  });
  await transitionExpiredTrials();
  const noSub = await db.shop.findUnique({ where: { id: shop.id }, select: { planStatus: true } });
  check("a shop with no subscription is not advanced", noSub?.planStatus === "trial", noSub?.planStatus);

  // Cleanup
  await db.analyticsEvent.deleteMany({ where: { shopId: shop.id } });
  await db.shop.delete({ where: { id: shop.id } });
  }

  await db.$disconnect();
  console.log(failures === 0 ? "\nALL CHECKS PASSED ✔" : `\n${failures} CHECK(S) FAILED ✘`);
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
