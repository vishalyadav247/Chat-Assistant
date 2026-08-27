/* Free-trial entitlement tests (spec 15 · QA D-23).
 *   npx tsx scripts/qa/trial.test.ts
 *
 * The property under test: a shop gets its trial ONCE. Not once per
 * subscription, not once per install. Three layers:
 *
 *   A. the pure policy (app/lib/billing/trial.server.ts) — including the abuse
 *      loops that motivated it, driven with a synthetic clock;
 *   B. the live subscribe → callback → switch → downgrade → resubscribe flow
 *      against the real dev DB via the mock billing provider;
 *   C. a source-level guard: the five paths that cancel a subscription must
 *      never clear the entitlement ledger. That is the whole defence, and it
 *      would be silently undone by anyone adding two "obvious" lines to a
 *      reset block, so it is asserted rather than trusted to a comment.
 */

process.env.BILLING_TEST_MODE = "1";
process.env.SHOPIFY_APP_URL = process.env.SHOPIFY_APP_URL || "https://example.com";
process.env.SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY || "trial-test-key";
process.env.SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET || "trial-test-secret";
process.env.SCOPES = process.env.SCOPES || "read_products";

import { readFileSync } from "node:fs";

const TEST_DOMAIN = "trial-entitlement-test.myshopify.com";
const DAY = 24 * 60 * 60 * 1000;

let failures = 0;
function check(name: string, condition: boolean, detail?: string) {
  console.log(`  ${condition ? "✔" : "✘"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures += 1;
}

async function main() {
  const { default: db } = await import("../../app/db.server");
  const { trialEntitlement, trialLedgerAfterGrant, trialDaysByPlan, TRIAL_WINDOW_DAYS } =
    await import("../../app/lib/billing/trial.server");
  const { getBillingProvider, completeBillingReturn, downgradeToFree, isBillingTestMode } =
    await import("../../app/lib/billing/shopify-billing.server");
  const { RUNTIME_SECRET_KEY, loadRuntimeConfig } = await import(
    "../../app/lib/platform/runtime-config.server"
  );

  // Same guard as test-billing-mock: a stored /platform/settings row outranks
  // the env fallback and would push this onto the real provider.
  const priorRuntime = await db.appSecret.findUnique({ where: { key: RUNTIME_SECRET_KEY } });
  const forced = { ...(priorRuntime ? JSON.parse(priorRuntime.value) : {}), billingTestMode: true };
  await db.appSecret.upsert({
    where: { key: RUNTIME_SECRET_KEY },
    create: { key: RUNTIME_SECRET_KEY, value: JSON.stringify(forced) },
    update: { value: JSON.stringify(forced) },
  });
  await loadRuntimeConfig();

  try {
    check("mock billing provider is active", isBillingTestMode());

    // ── A. Pure policy ───────────────────────────────────────────────────────
    console.log("\nA. entitlement policy (synthetic clock)");

    const T0 = new Date("2026-03-01T12:00:00.000Z");
    const at = (days: number) => new Date(T0.getTime() + days * DAY);
    const EMPTY = { trialStartedAt: null, trialDeadlineAt: null };

    check(
      "A1 a shop that never trialled gets the full allowance",
      trialEntitlement(EMPTY, 7, T0).grantDays === 7,
    );
    check(
      "A2 a 0-day allowance grants nothing (Free tier)",
      trialEntitlement(EMPTY, 0, T0).grantDays === 0,
    );

    // The ledger a first subscribe would leave behind.
    const first = trialLedgerAfterGrant({
      ledger: EMPTY,
      allowanceDays: 7,
      subscriptionCreatedAt: T0,
      trialEndsAt: at(7),
      now: T0,
    });
    check(
      "A3 first grant stamps start + deadline from Shopify's trial end",
      first.trialStartedAt?.getTime() === T0.getTime() &&
        first.trialDeadlineAt?.getTime() === at(7).getTime(),
    );

    // ABUSE LOOP 1 — plan switch. Upgrading on day 3 must hand over the 4 days
    // that are left, not a brand-new 7.
    const day3 = trialEntitlement(first, 7, at(3));
    check(
      "A4 mid-trial upgrade grants only the days remaining",
      day3.grantDays === 4,
      `${day3.grantDays}d`,
    );
    check(
      "A5 ... and does NOT move the deadline",
      day3.deadlineAt?.getTime() === at(7).getTime(),
    );

    // An upgrade minutes after subscribing must not cost the merchant a day —
    // the common legitimate case, and why the grant rounds up.
    check(
      "A6 upgrading 10 minutes in still grants the full 7 days",
      trialEntitlement(first, 7, new Date(T0.getTime() + 10 * 60_000)).grantDays === 7,
    );

    // ABUSE LOOP 2 — switch plans repeatedly. The deadline is the anchor, so
    // 200 switches over the same 7 days can never extend the entitlement.
    let ledger = first;
    let deadlineMoved = false;
    for (let i = 1; i <= 200; i += 1) {
      const now = new Date(T0.getTime() + i * 30 * 60_000); // every 30 minutes
      const grant = trialEntitlement(ledger, 7, now);
      const endsAt = new Date(now.getTime() + grant.grantDays * DAY);
      ledger = trialLedgerAfterGrant({
        ledger,
        allowanceDays: 7,
        subscriptionCreatedAt: now,
        trialEndsAt: grant.grantDays > 0 ? endsAt : null,
        now,
      });
      if ((ledger.trialDeadlineAt?.getTime() ?? 0) > at(7).getTime()) deadlineMoved = true;
    }
    check(
      "A7 200 plan switches cannot push the deadline forward",
      !deadlineMoved && ledger.trialDeadlineAt?.getTime() === at(7).getTime(),
      ledger.trialDeadlineAt?.toISOString(),
    );

    // ABUSE LOOP 3 — uninstall / reinstall, or downgrade-to-Free / resubscribe.
    check(
      "A8 a spent entitlement grants nothing (reinstall / resubscribe)",
      trialEntitlement(first, 7, at(8)).grantDays === 0,
    );
    check(
      "A9 ... still nothing just inside the rolling window",
      trialEntitlement(first, 7, at(7 + TRIAL_WINDOW_DAYS - 1)).grantDays === 0,
    );
    const aged = trialEntitlement(first, 7, at(7 + TRIAL_WINDOW_DAYS + 1));
    check(
      "A10 a genuinely-departed merchant is forgiven past the window",
      aged.grantDays === 7 && aged.reset === true,
    );

    // Operator changes trialDays at /platform/plans mid-flight.
    check(
      "A11 raising the allowance extends the SAME trial, not a new one",
      trialEntitlement(first, 10, at(3)).grantDays === 7,
      `${trialEntitlement(first, 10, at(3)).grantDays}d (expected 10 total − 3 used)`,
    );
    check(
      "A12 lowering the allowance never shortens a trial already running",
      trialEntitlement(first, 3, at(3)).deadlineAt?.getTime() === at(7).getTime(),
    );

    // Replay safety — a redelivered webhook or a refreshed callback tab.
    const replay = trialLedgerAfterGrant({
      ledger: first,
      allowanceDays: 7,
      subscriptionCreatedAt: T0,
      trialEndsAt: at(7),
      now: at(1),
    });
    check(
      "A13 a replayed confirmation is idempotent",
      replay.trialStartedAt?.getTime() === first.trialStartedAt?.getTime() &&
        replay.trialDeadlineAt?.getTime() === first.trialDeadlineAt?.getTime(),
    );
    check(
      "A14 a subscription with no trial leaves the ledger untouched",
      trialLedgerAfterGrant({
        ledger: first,
        allowanceDays: 7,
        subscriptionCreatedAt: at(9),
        trialEndsAt: null,
        now: at(9),
      }).trialDeadlineAt?.getTime() === at(7).getTime(),
    );

    const byPlan = trialDaysByPlan(first, ["free", "basic", "pro", "plus"], at(3));
    check(
      "A15 plan-card copy shows the remaining days on every paid tier",
      byPlan.free === 0 && byPlan.basic === 4 && byPlan.pro === 4 && byPlan.plus === 4,
      JSON.stringify(byPlan),
    );

    // ── B. Live flow (mock provider, real DB) ────────────────────────────────
    console.log("\nB. live subscribe → switch → downgrade → resubscribe");

    const stale = await db.shop.findUnique({ where: { domain: TEST_DOMAIN } });
    if (stale) {
      await db.analyticsEvent.deleteMany({ where: { shopId: stale.id } });
      await db.shop.delete({ where: { id: stale.id } });
    }
    await db.shop.create({ data: { domain: TEST_DOMAIN } });
    const provider = getBillingProvider();

    const subscribe = async (plan: "basic" | "pro" | "plus", interval: "monthly" | "yearly") => {
      const { confirmationUrl } = await provider.createSubscription({
        shopDomain: TEST_DOMAIN,
        plan,
        interval,
      });
      const url = new URL(confirmationUrl);
      const result = await completeBillingReturn({
        shopDomain: TEST_DOMAIN,
        plan,
        interval,
        chargeId: url.searchParams.get("charge_id"),
      });
      const row = await db.shop.findUniqueOrThrow({ where: { domain: TEST_DOMAIN } });
      return { result, row };
    };

    // B1 — Pro end-to-end. Previously only Basic and Plus were ever driven
    // through this flow, so Pro's trial was never actually exercised.
    const b1 = await subscribe("pro", "monthly");
    const b1Days = b1.row.trialEndsAt
      ? (b1.row.trialEndsAt.getTime() - Date.now()) / DAY
      : -1;
    check("B1 Pro monthly gets the full 7-day trial", b1.result.ok && b1Days > 6.9 && b1Days <= 7.01, `${b1Days.toFixed(2)}d`);
    check("B1 planStatus = trial", b1.row.planStatus === "trial", b1.row.planStatus);
    check(
      "B1 entitlement ledger stamped",
      b1.row.trialStartedAt !== null && b1.row.trialDeadlineAt !== null,
    );
    const deadline = b1.row.trialDeadlineAt!.getTime();

    // B2 — upgrade to Plus. Same trial deadline, no restart.
    const b2 = await subscribe("plus", "monthly");
    check("B2 upgrade to Plus succeeds", b2.result.ok && b2.row.plan === "plus", b2.row.plan);
    check(
      "B2 upgrading does NOT move the trial deadline",
      b2.row.trialDeadlineAt!.getTime() === deadline,
      `${b2.row.trialDeadlineAt!.toISOString()} vs ${new Date(deadline).toISOString()}`,
    );

    // B3 — downgrade to Free, then resubscribe. The classic reset loop.
    const down = await downgradeToFree(TEST_DOMAIN);
    const afterDown = await db.shop.findUniqueOrThrow({ where: { domain: TEST_DOMAIN } });
    check("B3 downgrade to Free succeeds", down.ok && afterDown.plan === "free");
    check("B3 live trial cleared", afterDown.trialEndsAt === null);
    check(
      "B3 entitlement ledger SURVIVES the downgrade",
      afterDown.trialDeadlineAt?.getTime() === deadline,
    );

    const b4 = await subscribe("basic", "monthly");
    check("B4 resubscribe succeeds", b4.result.ok && b4.row.plan === "basic");
    check(
      "B4 resubscribing does NOT restart the trial",
      b4.row.trialDeadlineAt?.getTime() === deadline,
    );

    // B5 — simulate the uninstall reset (same field set the webhook writes) and
    // confirm a reinstall still cannot mint a trial.
    await db.shop.update({
      where: { domain: TEST_DOMAIN },
      data: {
        uninstalledAt: new Date(),
        plan: "free",
        planStatus: "none",
        subscriptionId: null,
        billingInterval: null,
        trialEndsAt: null,
        usageLineItemId: null,
      },
    });
    // ... and age the entitlement out so it is genuinely spent, not merely
    // running: this is the reinstall-tomorrow case, not the 180-day case.
    await db.shop.update({
      where: { domain: TEST_DOMAIN },
      data: { trialStartedAt: new Date(Date.now() - 30 * DAY), trialDeadlineAt: new Date(Date.now() - 23 * DAY) },
    });
    const b5 = await subscribe("plus", "monthly");
    check("B5 reinstall + subscribe succeeds", b5.result.ok && b5.row.plan === "plus");
    check(
      "B5 reinstalling grants NO new trial",
      b5.row.trialEndsAt === null && b5.row.planStatus === "active",
      `trialEndsAt=${b5.row.trialEndsAt} status=${b5.row.planStatus}`,
    );

    // B6 — past the rolling window the merchant is treated as new again.
    await db.shop.update({
      where: { domain: TEST_DOMAIN },
      data: {
        plan: "free",
        planStatus: "none",
        subscriptionId: null,
        trialEndsAt: null,
        trialStartedAt: new Date(Date.now() - (TRIAL_WINDOW_DAYS + 30) * DAY),
        trialDeadlineAt: new Date(Date.now() - (TRIAL_WINDOW_DAYS + 23) * DAY),
      },
    });
    const b6 = await subscribe("basic", "monthly");
    const b6Days = b6.row.trialEndsAt ? (b6.row.trialEndsAt.getTime() - Date.now()) / DAY : -1;
    check(
      `B6 past the ${TRIAL_WINDOW_DAYS}-day window the trial is granted again`,
      b6Days > 6.9 && b6Days <= 7.01,
      `${b6Days.toFixed(2)}d`,
    );

    await db.analyticsEvent.deleteMany({ where: { shopId: b6.row.id } });
    await db.shop.delete({ where: { id: b6.row.id } });

    // ── C. Source guard ──────────────────────────────────────────────────────
    console.log("\nC. no reset path may clear the entitlement ledger");

    const RESET_SITES = [
      "app/lib/billing/shopify-billing.server.ts",
      "app/lib/jobs/handlers.server.ts",
      "app/routes/webhooks.app.uninstalled.tsx",
      "app/routes/webhooks.app-subscriptions.tsx",
      "app/routes/webhooks.compliance.tsx",
    ];
    for (const file of RESET_SITES) {
      const raw = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
      // Comments stripped first — every one of these files carries a prose note
      // naming both fields, which would otherwise read as a write.
      const source = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      // The ledger is written ONLY from a trialLedgerAfterGrant() result. Any
      // other assignment — above all `trialStartedAt: null` in a reset block —
      // reopens the abuse loop this whole module exists to close.
      const writes = source.match(/trial(?:StartedAt|DeadlineAt):\s*[^,\n]+/g) ?? [];
      const bad = writes.filter((w) => !/ledger\.trial(?:StartedAt|DeadlineAt)/.test(w));
      check(`C ${file} never clears the ledger`, bad.length === 0, bad.join(" | ") || "clean");
    }
  } finally {
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
    await db.$disconnect();
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED ✔" : `\n${failures} CHECK(S) FAILED ✘`);
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
