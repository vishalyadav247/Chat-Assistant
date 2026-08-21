/* Promo / coupon code QA (spec 15 · discount coupons).
 * Run with the dev DB up:  npx tsx scripts/qa/promo-codes.test.ts
 *
 * Manual-QA-grade coverage of the whole feature:
 *  1. code normalization + format/value validation (pure helpers)
 *  2. code state: valid / expired / inactive / unknown
 *  3. scope: wrong plan, wrong interval, fixed discount >= interval price
 *  4. Shopify discount input + price previews (server vs plan-card client)
 *  5. redemption lifecycle: reserve → pending → confirmed → badge
 *  6. plan change carries the redemption onto the new subscription
 *  7. maxRedemptions: exhausted, released slot reuse, stale-pending GC
 *  8. tenancy: shop A can neither see nor consume shop B's redemption
 *  9. concurrency: N shops racing a 1-slot code → exactly one wins
 * 10. code-enumeration throttle
 *
 * Every row it creates is namespaced (QAPROMO* codes, qa-promo-*.myshopify.com
 * shops) and deleted in the finally block, which also disconnects the shared
 * app/db.server singleton — without that await the process hangs forever.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Load .env manually (tsx does not) BEFORE importing app modules.
for (const line of readFileSync(join(process.cwd(), ".env"), "utf-8").split(
  /\r?\n/,
)) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (
    match &&
    !line.trim().startsWith("#") &&
    process.env[match[1]] === undefined
  ) {
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}

const CODE_PREFIX = "QAPROMO";
const SHOP_PREFIX = "qa-promo-";

let failures = 0;
let checks = 0;
function check(name: string, condition: boolean, detail?: string) {
  checks += 1;
  console.log(
    `  ${condition ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`,
  );
  if (!condition) failures += 1;
}

async function main() {
  const { default: db } = await import("../../app/db.server");
  const promo = await import("../../app/lib/billing/promo-codes.server");
  const { PLANS } = await import("../../app/lib/billing/plans.server");
  const { yearlyTotal } = await import(
    "../../app/lib/billing/shopify-billing.server"
  );
  const { promoPreviewFor, promoPriceFor } = await import(
    "../../app/components/PlanCards"
  );

  const {
    activeRedemptionFor,
    confirmRedemption,
    countRedemptions,
    describePromo,
    discountInputFor,
    discountedPrice,
    generatePromoCode,
    intervalPrice,
    normalizePromoCode,
    promoApplicabilityProblem,
    promoCodeProblem,
    promoValueProblem,
    purgeStalePendingRedemptions,
    recordPendingRedemption,
    releaseRedemptionsForShop,
    resetPromoValidationThrottle,
    validatePromoCode,
    PENDING_TTL_MS,
  } = promo;

  const BASIC_MONTHLY = PLANS.basic.priceMonthly;
  const PRO_YEARLY = yearlyTotal("pro");

  // ── fixtures ────────────────────────────────────────────────────────────
  async function cleanup() {
    const codes = await db.promoCode.findMany({
      where: { code: { startsWith: CODE_PREFIX } },
      select: { id: true },
    });
    const shops = await db.shop.findMany({
      where: { domain: { startsWith: SHOP_PREFIX } },
      select: { id: true },
    });
    await db.promoRedemption.deleteMany({
      where: {
        OR: [
          { promoCodeId: { in: codes.map((c) => c.id) } },
          { shopId: { in: shops.map((s) => s.id) } },
        ],
      },
    });
    await db.promoCode.deleteMany({ where: { id: { in: codes.map((c) => c.id) } } });
    await db.analyticsEvent.deleteMany({
      where: { shopId: { in: shops.map((s) => s.id) } },
    });
    await db.shop.deleteMany({ where: { id: { in: shops.map((s) => s.id) } } });
  }
  await cleanup(); // leftovers from an aborted run

  const shopId = async (slug: string) =>
    (
      await db.shop.create({
        data: { domain: `${SHOP_PREFIX}${slug}.myshopify.com` },
      })
    ).id;

  const makeCode = async (
    suffix: string,
    data: Partial<{
      kind: string;
      value: number;
      durationIntervals: number | null;
      plans: string[];
      intervals: string[];
      maxRedemptions: number | null;
      expiresAt: Date | null;
      active: boolean;
    }> = {},
  ) =>
    db.promoCode.create({
      data: {
        code: `${CODE_PREFIX}${suffix}`,
        kind: "percent",
        value: 20,
        durationIntervals: null,
        plans: [],
        intervals: [],
        maxRedemptions: null,
        expiresAt: null,
        active: true,
        ...data,
      },
    });

  const shopA = await shopId("a");
  const shopB = await shopId("b");

  const pct20 = await makeCode("PCT20");
  const fixed10 = await makeCode("FIX10", {
    kind: "fixed",
    value: 10,
    durationIntervals: 3,
  });
  const expired = await makeCode("EXPIRED", {
    expiresAt: new Date(Date.now() - 60_000),
  });
  const inactive = await makeCode("INACTIVE", { active: false });
  const once = await makeCode("ONCE", { maxRedemptions: 1 });
  const proYearly = await makeCode("PROYEAR", {
    plans: ["pro"],
    intervals: ["yearly"],
  });
  const tooBig = await makeCode("TOOBIG", {
    kind: "fixed",
    value: BASIC_MONTHLY + 5,
  });
  const race = await makeCode("RACE", { maxRedemptions: 1 });

  // ── 1. normalization + pure validation ──────────────────────────────────
  console.log("\n1. normalization + value validation (promo-shared)");
  check(
    'normalizePromoCode strips INTERNAL whitespace ("save 20" → "SAVE20")',
    normalizePromoCode("save 20") === "SAVE20",
    normalizePromoCode("save 20"),
  );
  check(
    "normalizePromoCode strips surrounding whitespace + tabs/newlines",
    normalizePromoCode("\t save\n20 ") === "SAVE20",
    normalizePromoCode("\t save\n20 "),
  );
  check(
    'the letter S survives the fix ("summer sale" → "SUMMERSALE")',
    normalizePromoCode("summer sale") === "SUMMERSALE",
    normalizePromoCode("summer sale"),
  );
  check(
    "a code typed with a space now passes the format check",
    promoCodeProblem(normalizePromoCode("save 20")) === null,
  );
  check(
    "generatePromoCode(prefix) normalizes the prefix",
    /^BLACKFRIDAY-[A-Z2-9]{8}$/.test(generatePromoCode("black friday")),
    generatePromoCode("black friday"),
  );
  check("empty code is rejected", promoCodeProblem("") === "Please enter a code.");
  check("2-char code is rejected", promoCodeProblem("AB") !== null);
  check("32-char code is accepted", promoCodeProblem("A".repeat(32)) === null);
  check("33-char code is rejected", promoCodeProblem("A".repeat(33)) !== null);
  check("code with '@' is rejected", promoCodeProblem("SAVE@20") !== null);

  check("percent 20 is representable", promoValueProblem("percent", 20) === null);
  check(
    "percent 12.34 is representable (→ 0.1234 exactly)",
    promoValueProblem("percent", 12.34) === null,
  );
  check(
    "percent 12.345 is rejected (would round to 0.1235 at Shopify)",
    promoValueProblem("percent", 12.345) !== null,
    String(promoValueProblem("percent", 12.345)),
  );
  check("percent 101 is rejected", promoValueProblem("percent", 101) !== null);
  check("value 0 is rejected", promoValueProblem("percent", 0) !== null);
  check("value NaN is rejected", promoValueProblem("fixed", Number.NaN) !== null);
  check("fixed 10.5 is accepted", promoValueProblem("fixed", 10.5) === null);
  check(
    "fixed 10.005 is rejected (sub-cent)",
    promoValueProblem("fixed", 10.005) !== null,
  );

  check(
    "describePromo: forever",
    describePromo({ kind: "percent", value: 20, durationIntervals: null }) ===
      "20% off forever",
  );
  check(
    "describePromo: 1 cycle",
    describePromo({ kind: "fixed", value: 10, durationIntervals: 1 }) ===
      "$10 off for the first billing cycle",
  );
  check(
    "describePromo: n cycles",
    describePromo({ kind: "fixed", value: 10, durationIntervals: 3 }) ===
      "$10 off for 3 billing cycles",
  );

  // ── 2. code state ───────────────────────────────────────────────────────
  console.log("\n2. code state: valid / expired / inactive / unknown");
  resetPromoValidationThrottle();
  let result = await validatePromoCode({ shopId: shopA, code: pct20.code });
  check("valid code validates", result.ok, result.ok ? result.promo.label : result.error);
  check(
    "summary carries kind/value/duration",
    result.ok &&
      result.promo.kind === "percent" &&
      result.promo.value === 20 &&
      result.promo.durationIntervals === null,
  );

  result = await validatePromoCode({ shopId: shopA, code: "  qapromopct20  " });
  check("lower-case + padded input validates", result.ok);
  result = await validatePromoCode({
    shopId: shopA,
    code: `${pct20.code.slice(0, 4)} ${pct20.code.slice(4)}`,
  });
  check("code typed WITH an internal space validates (defect 1)", result.ok);

  result = await validatePromoCode({ shopId: shopA, code: expired.code });
  check(
    "expired code is refused with the expiry message",
    !result.ok && result.error === "That code has expired.",
    result.ok ? "accepted!" : result.error,
  );
  result = await validatePromoCode({ shopId: shopA, code: inactive.code });
  check(
    "deactivated code is refused",
    !result.ok && result.error === "That code isn't valid.",
    result.ok ? "accepted!" : result.error,
  );
  result = await validatePromoCode({ shopId: shopA, code: `${CODE_PREFIX}NOPE` });
  check(
    "unknown code is refused with the same generic message (no oracle)",
    !result.ok && result.error === "That code isn't valid.",
  );
  let threw = false;
  try {
    await validatePromoCode({ shopId: "", code: pct20.code });
  } catch {
    threw = true;
  }
  check("validate without a shopId throws (tenancy guard)", threw);

  // ── 3. scope ────────────────────────────────────────────────────────────
  console.log("\n3. scope: plan, interval, discount larger than the charge");
  resetPromoValidationThrottle();
  result = await validatePromoCode({
    shopId: shopA,
    code: proYearly.code,
    plan: "basic",
    interval: "yearly",
  });
  check(
    "wrong plan is refused, naming the allowed plan",
    !result.ok && result.error.includes(PLANS.pro.name),
    result.ok ? "accepted!" : result.error,
  );
  result = await validatePromoCode({
    shopId: shopA,
    code: proYearly.code,
    plan: "pro",
    interval: "monthly",
  });
  check(
    "wrong interval is refused, naming the allowed term",
    !result.ok && result.error.includes("yearly"),
    result.ok ? "accepted!" : result.error,
  );
  result = await validatePromoCode({
    shopId: shopA,
    code: proYearly.code,
    plan: "pro",
    interval: "yearly",
  });
  check("in-scope plan+interval is accepted", result.ok);

  resetPromoValidationThrottle();
  result = await validatePromoCode({
    shopId: shopA,
    code: tooBig.code,
    plan: "basic",
    interval: "monthly",
  });
  check(
    "fixed discount >= interval price says SO (not the misleading scope copy)",
    !result.ok &&
      /more than/.test(result.error) &&
      !/doesn't apply to that plan/.test(result.error),
    result.ok ? "accepted!" : result.error,
  );
  check(
    "…and the same code is fine on a term that costs more",
    (
      await validatePromoCode({
        shopId: shopB,
        code: tooBig.code,
        plan: "pro",
        interval: "yearly",
      })
    ).ok,
  );
  check(
    "promoApplicabilityProblem distinguishes scope from too-large",
    promoApplicabilityProblem(
      { plans: ["pro"], intervals: [], kind: "percent", value: 20 },
      "basic",
      "monthly",
    ) === "scope" &&
      promoApplicabilityProblem(
        { plans: [], intervals: [], kind: "fixed", value: BASIC_MONTHLY },
        "basic",
        "monthly",
      ) === "too-large",
  );

  // ── 4. Shopify discount input + price previews ──────────────────────────
  console.log("\n4. Shopify discount input + client/server price agreement");
  const pct20Summary = (
    await validatePromoCode({ shopId: shopA, code: pct20.code })
  );
  const fixed10Summary = await validatePromoCode({
    shopId: shopA,
    code: fixed10.code,
  });
  if (!pct20Summary.ok || !fixed10Summary.ok) throw new Error("fixture broken");
  const pctInput = discountInputFor(pct20Summary.promo);
  check(
    "percent → { percentage: 0.2 } (0–1 fraction) with no duration limit",
    JSON.stringify(pctInput) === JSON.stringify({ value: { percentage: 0.2 } }),
    JSON.stringify(pctInput),
  );
  const fixInput = discountInputFor(fixed10Summary.promo);
  check(
    "fixed → { amount: 10 } + durationLimitInIntervals: 3",
    JSON.stringify(fixInput) ===
      JSON.stringify({ value: { amount: 10 }, durationLimitInIntervals: 3 }),
    JSON.stringify(fixInput),
  );
  check(
    "intervalPrice(basic, monthly) matches the plan matrix",
    intervalPrice("basic", "monthly") === BASIC_MONTHLY,
  );
  check(
    "intervalPrice(pro, yearly) is the yearly total",
    intervalPrice("pro", "yearly") === PRO_YEARLY,
  );
  check(
    "discountedPrice(20%, basic monthly) is 80% of the price",
    discountedPrice(pct20Summary.promo, BASIC_MONTHLY) ===
      Number((BASIC_MONTHLY * 0.8).toFixed(2)),
  );

  const card = {
    id: "basic",
    name: PLANS.basic.name,
    description: "",
    priceMonthly: BASIC_MONTHLY,
    priceYearlyPerMonth: PLANS.basic.priceYearlyPerMonth,
    yearlyTotal: yearlyTotal("basic"),
    trialDays: PLANS.basic.trialDays,
    overagePerConversation: PLANS.basic.overagePerConversation,
    bullets: [],
    popular: false,
  };
  const clientPromo = {
    code: pct20.code,
    label: "20% off forever",
    kind: "percent" as const,
    value: 20,
    durationIntervals: null,
    plans: [],
    intervals: [],
  };
  check(
    "card preview (monthly) matches discountedPrice",
    promoPriceFor(card, "monthly", clientPromo) ===
      discountedPrice(pct20Summary.promo, BASIC_MONTHLY),
    String(promoPriceFor(card, "monthly", clientPromo)),
  );
  const bigPreview = promoPreviewFor(card, "monthly", {
    ...clientPromo,
    kind: "fixed",
    value: BASIC_MONTHLY + 5,
  });
  check(
    "card preview flags a too-large fixed code instead of silently showing full price",
    bigPreview.kind === "too-large",
    bigPreview.kind,
  );
  check(
    "…and that matches what the server would answer",
    promoApplicabilityProblem(
      { plans: [], intervals: [], kind: "fixed", value: BASIC_MONTHLY + 5 },
      "basic",
      "monthly",
    ) === "too-large",
  );
  check(
    "card preview returns not-applicable for an out-of-scope plan",
    promoPreviewFor(card, "monthly", { ...clientPromo, plans: ["pro"] }).kind ===
      "not-applicable",
  );

  // ── 5. redemption lifecycle ─────────────────────────────────────────────
  console.log("\n5. redemption lifecycle: reserve → pending → confirmed");
  await db.promoRedemption.deleteMany({ where: { promoCodeId: pct20.id } });
  resetPromoValidationThrottle();
  const subA1 = "gid://shopify/AppSubscription/QA-A-1";
  result = await validatePromoCode({
    shopId: shopA,
    code: pct20.code,
    plan: "basic",
    interval: "monthly",
  });
  check("subscribe-path validate succeeds", result.ok);
  let row = await db.promoRedemption.findFirstOrThrow({
    where: { shopId: shopA, promoCodeId: pct20.id },
  });
  check(
    "…and RESERVES the slot up-front (pending row exists before Shopify is called)",
    row.status === "pending" && row.subscriptionId === null,
    `${row.status}/${row.subscriptionId}`,
  );
  await recordPendingRedemption({
    shopId: shopA,
    promoId: pct20.id,
    subscriptionId: subA1,
    plan: "basic",
    interval: "monthly",
  });
  row = await db.promoRedemption.findFirstOrThrow({
    where: { shopId: shopA, promoCodeId: pct20.id },
  });
  check(
    "recordPendingRedemption attaches the subscription id",
    row.subscriptionId === subA1 && row.status === "pending",
  );
  check(
    "badge is NOT shown while pending",
    (await activeRedemptionFor(shopA, subA1)) === null,
  );
  await confirmRedemption(shopA, subA1);
  row = await db.promoRedemption.findFirstOrThrow({
    where: { shopId: shopA, promoCodeId: pct20.id },
  });
  check(
    "confirmRedemption marks it redeemed + stamps redeemedAt",
    row.status === "redeemed" && row.redeemedAt !== null,
    `${row.status}/${row.redeemedAt?.toISOString() ?? "null"}`,
  );
  const badge = await activeRedemptionFor(shopA, subA1);
  check(
    "plan page badge shows the code + label",
    badge?.code === pct20.code && badge.label === "20% off forever",
    JSON.stringify(badge),
  );
  const firstRedeemedAt = row.redeemedAt;
  await confirmRedemption(shopA, subA1);
  row = await db.promoRedemption.findFirstOrThrow({
    where: { shopId: shopA, promoCodeId: pct20.id },
  });
  check(
    "confirmRedemption is idempotent (redeemedAt not re-stamped)",
    row.redeemedAt?.getTime() === firstRedeemedAt?.getTime(),
  );
  check(
    "no live subscription → no badge",
    (await activeRedemptionFor(shopA, null)) === null,
  );

  // Double-redeem by the SAME shop must never create a second row / slot.
  resetPromoValidationThrottle();
  result = await validatePromoCode({
    shopId: shopA,
    code: pct20.code,
    plan: "basic",
    interval: "monthly",
  });
  check("same shop re-applying its own code is allowed", result.ok);
  check(
    "…and still holds exactly ONE row (one slot)",
    (await db.promoRedemption.count({
      where: { shopId: shopA, promoCodeId: pct20.id },
    })) === 1,
  );
  check(
    "…and the row stayed 'redeemed' (live discount not retired by a re-apply)",
    (
      await db.promoRedemption.findFirstOrThrow({
        where: { shopId: shopA, promoCodeId: pct20.id },
      })
    ).status === "redeemed",
  );

  // ── 6. plan change carries the redemption ───────────────────────────────
  console.log("\n6. plan change carries the discount to the new subscription");
  const subA2 = "gid://shopify/AppSubscription/QA-A-2";
  resetPromoValidationThrottle();
  result = await validatePromoCode({
    shopId: shopA,
    code: pct20.code,
    plan: "plus",
    interval: "yearly",
  });
  check(
    "upgrading: the code is accepted again (defect 4 — used to be refused)",
    result.ok,
    result.ok ? "" : result.error,
  );
  await recordPendingRedemption({
    shopId: shopA,
    promoId: pct20.id,
    subscriptionId: subA2,
    plan: "plus",
    interval: "yearly",
  });
  check(
    "badge survives the in-flight upgrade (old subscription still discounted)",
    (await activeRedemptionFor(shopA, subA1))?.code === pct20.code,
  );
  await confirmRedemption(shopA, subA2);
  row = await db.promoRedemption.findFirstOrThrow({
    where: { shopId: shopA, promoCodeId: pct20.id },
  });
  check(
    "after approval the row points at the NEW subscription, still redeemed",
    row.subscriptionId === subA2 &&
      row.status === "redeemed" &&
      row.plan === "plus" &&
      row.interval === "yearly",
    `${row.subscriptionId}/${row.status}/${row.plan}/${row.interval}`,
  );
  check(
    "badge follows the new subscription",
    (await activeRedemptionFor(shopA, subA2))?.code === pct20.code,
  );
  check(
    "the upgrade consumed no extra redemption slot",
    (await countRedemptions(pct20.id)) === 1,
    String(await countRedemptions(pct20.id)),
  );

  // ── 7. maxRedemptions ───────────────────────────────────────────────────
  console.log("\n7. maxRedemptions: exhausted, released, stale-pending GC");
  resetPromoValidationThrottle();
  result = await validatePromoCode({
    shopId: shopA,
    code: once.code,
    plan: "basic",
    interval: "monthly",
  });
  check("first shop takes the single slot", result.ok);
  const subOnce = "gid://shopify/AppSubscription/QA-ONCE";
  await recordPendingRedemption({
    shopId: shopA,
    promoId: once.id,
    subscriptionId: subOnce,
    plan: "basic",
    interval: "monthly",
  });
  await confirmRedemption(shopA, subOnce);

  resetPromoValidationThrottle();
  result = await validatePromoCode({ shopId: shopB, code: once.code });
  check(
    "second shop is refused with the limit message (even before picking a plan)",
    !result.ok && result.error === "That code has reached its redemption limit.",
    result.ok ? "accepted!" : result.error,
  );
  result = await validatePromoCode({
    shopId: shopB,
    code: once.code,
    plan: "basic",
    interval: "monthly",
  });
  check(
    "…and on the subscribe path too",
    !result.ok && result.error === "That code has reached its redemption limit.",
  );
  check(
    "…and no reservation row was created for it",
    (await db.promoRedemption.count({
      where: { shopId: shopB, promoCodeId: once.id },
    })) === 0,
  );

  // Release (downgrade / cancel / uninstall) frees the slot for everyone.
  await releaseRedemptionsForShop(shopA);
  check(
    "releaseRedemptionsForShop retires the shop's rows",
    (
      await db.promoRedemption.findFirstOrThrow({
        where: { shopId: shopA, promoCodeId: once.id },
      })
    ).status === "released",
  );
  check(
    "released rows keep redeemedAt (billing history preserved)",
    (
      await db.promoRedemption.findFirstOrThrow({
        where: { shopId: shopA, promoCodeId: once.id },
      })
    ).redeemedAt !== null,
  );
  check(
    "…and no longer occupy a slot",
    (await countRedemptions(once.id)) === 0,
    String(await countRedemptions(once.id)),
  );
  resetPromoValidationThrottle();
  check(
    "a downgraded shop can apply its own code again",
    (await validatePromoCode({ shopId: shopA, code: once.code })).ok,
  );
  check(
    "the freed slot is available to another shop",
    (await validatePromoCode({ shopId: shopB, code: once.code })).ok,
  );
  check(
    "downgrade also drops the plan-page badge",
    (await activeRedemptionFor(shopA, subOnce)) === null,
  );
  // Re-release so the "once" fixture is back to a free slot for later checks.
  await releaseRedemptionsForShop(shopA);

  // Abandoned approvals must not hold a slot forever.
  const shopC = await shopId("c");
  const stalePending = await db.promoRedemption.create({
    data: {
      shopId: shopC,
      promoCodeId: once.id,
      plan: "basic",
      interval: "monthly",
      status: "pending",
      createdAt: new Date(Date.now() - PENDING_TTL_MS - 60_000),
    },
  });
  check(
    "a stale pending reservation does not occupy a slot",
    (await countRedemptions(once.id)) === 0,
    String(await countRedemptions(once.id)),
  );
  // A FRESH reservation must hold the slot — otherwise two merchants sitting on
  // the Shopify approval page could both redeem a 1-use code.
  const shopD = await shopId("d");
  resetPromoValidationThrottle();
  check(
    "shop D takes the free slot with a fresh reservation",
    (
      await validatePromoCode({
        shopId: shopD,
        code: once.code,
        plan: "basic",
        interval: "monthly",
      })
    ).ok,
  );
  check(
    "a FRESH pending reservation occupies the slot",
    (await countRedemptions(once.id)) === 1,
    String(await countRedemptions(once.id)),
  );
  const shopE = await shopId("e");
  const blocked = await validatePromoCode({
    shopId: shopE,
    code: once.code,
    plan: "basic",
    interval: "monthly",
  });
  check(
    "…so another shop is blocked while the approval page is open",
    !blocked.ok &&
      blocked.error === "That code has reached its redemption limit.",
    blocked.ok ? "accepted!" : blocked.error,
  );
  await db.promoRedemption.deleteMany({
    where: { shopId: shopD, promoCodeId: once.id },
  });
  check(
    "the reservation write path garbage-collects the abandoned row",
    (await db.promoRedemption.count({ where: { id: stalePending.id } })) === 0,
  );
  // …and the standalone sweep (for codes nobody redeems again) works too.
  const shopF = await shopId("f");
  const stale2 = await db.promoRedemption.create({
    data: {
      shopId: shopF,
      promoCodeId: proYearly.id,
      plan: "pro",
      interval: "yearly",
      status: "pending",
      createdAt: new Date(Date.now() - PENDING_TTL_MS - 60_000),
    },
  });
  // An OLD but redeemed row must survive the sweep.
  const shopG = await shopId("g");
  const oldRedeemed = await db.promoRedemption.create({
    data: {
      shopId: shopG,
      promoCodeId: proYearly.id,
      plan: "pro",
      interval: "yearly",
      status: "redeemed",
      createdAt: new Date(Date.now() - PENDING_TTL_MS * 30),
      redeemedAt: new Date(Date.now() - PENDING_TTL_MS * 30),
    },
  });
  const purged = await purgeStalePendingRedemptions();
  check(
    "purgeStalePendingRedemptions deletes the abandoned row",
    purged >= 1 &&
      (await db.promoRedemption.count({ where: { id: stale2.id } })) === 0,
    `purged=${purged}`,
  );
  check(
    "…and never touches an old REDEEMED row",
    (await db.promoRedemption.count({ where: { id: oldRedeemed.id } })) === 1,
  );

  // ── 8. tenancy ──────────────────────────────────────────────────────────
  console.log("\n8. tenancy: shop A cannot see or consume shop B's redemption");
  await db.promoRedemption.deleteMany({ where: { promoCodeId: fixed10.id } });
  resetPromoValidationThrottle();
  const subB = "gid://shopify/AppSubscription/QA-B-1";
  await validatePromoCode({
    shopId: shopB,
    code: fixed10.code,
    plan: "pro",
    interval: "monthly",
  });
  await recordPendingRedemption({
    shopId: shopB,
    promoId: fixed10.id,
    subscriptionId: subB,
    plan: "pro",
    interval: "monthly",
  });
  await confirmRedemption(shopB, subB);
  check(
    "shop A gets no badge for shop B's subscription id",
    (await activeRedemptionFor(shopA, subB)) === null,
  );
  await confirmRedemption(shopA, subB);
  check(
    "confirmRedemption from shop A cannot touch shop B's row",
    (
      await db.promoRedemption.findFirstOrThrow({
        where: { shopId: shopB, promoCodeId: fixed10.id },
      })
    ).shopId === shopB &&
      (await db.promoRedemption.count({
        where: { shopId: shopA, promoCodeId: fixed10.id },
      })) === 0,
  );
  await releaseRedemptionsForShop(shopA);
  check(
    "releasing shop A leaves shop B's redemption alone",
    (
      await db.promoRedemption.findFirstOrThrow({
        where: { shopId: shopB, promoCodeId: fixed10.id },
      })
    ).status === "redeemed",
  );
  check(
    "shop B's badge still resolves",
    (await activeRedemptionFor(shopB, subB))?.code === fixed10.code,
  );

  // ── 9. concurrency ──────────────────────────────────────────────────────
  console.log("\n9. concurrency: 6 shops race a 1-redemption code");
  const racers = await Promise.all(
    Array.from({ length: 6 }, (_, i) => shopId(`race${i}`)),
  );
  resetPromoValidationThrottle();
  const outcomes = await Promise.all(
    racers.map((id) =>
      validatePromoCode({
        shopId: id,
        code: race.code,
        plan: "basic",
        interval: "monthly",
      }).catch((error) => ({ ok: false as const, error: String(error) })),
    ),
  );
  const winners = outcomes.filter((o) => o.ok).length;
  check(
    "exactly 1 of 6 concurrent redemptions succeeds",
    winners === 1,
    `${winners} winners`,
  );
  check(
    "…and exactly 1 reservation row exists",
    (await db.promoRedemption.count({ where: { promoCodeId: race.id } })) === 1,
    String(await db.promoRedemption.count({ where: { promoCodeId: race.id } })),
  );
  check(
    "losers all got the limit message",
    outcomes
      .filter((o) => !o.ok)
      .every(
        (o) =>
          !o.ok && o.error === "That code has reached its redemption limit.",
      ),
    outcomes.filter((o) => !o.ok).map((o) => (o.ok ? "" : o.error))[0],
  );
  // Same shop racing itself must also converge on one row.
  const selfShop = await shopId("self");
  resetPromoValidationThrottle();
  const selfOutcomes = await Promise.all(
    Array.from({ length: 4 }, () =>
      validatePromoCode({
        shopId: selfShop,
        code: pct20.code,
        plan: "basic",
        interval: "monthly",
      }).catch((error) => ({ ok: false as const, error: String(error) })),
    ),
  );
  check(
    "4 concurrent applies by one shop all succeed",
    selfOutcomes.every((o) => o.ok),
    selfOutcomes.find((o) => !o.ok && o.error)?.["error" as never] ?? "",
  );
  check(
    "…and create exactly one row",
    (await db.promoRedemption.count({
      where: { shopId: selfShop, promoCodeId: pct20.id },
    })) === 1,
  );

  // ── 10. enumeration throttle ────────────────────────────────────────────
  console.log("\n10. code-enumeration throttle");
  const guesser = await shopId("guesser");
  resetPromoValidationThrottle();
  const attempts: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    const r = await validatePromoCode({
      shopId: guesser,
      code: `${CODE_PREFIX}GUESS${i}`,
    });
    attempts.push(r.ok ? "ok" : r.error);
  }
  check(
    "a guessing loop is cut off after ~10 failures",
    attempts.some((a) => a.startsWith("Too many code attempts")),
    `last=${attempts[attempts.length - 1]}`,
  );
  check(
    "the first attempts still returned the real (generic) answer",
    attempts[0] === "That code isn't valid.",
    attempts[0],
  );
  resetPromoValidationThrottle();
  const honest = await shopId("honest");
  let allOk = true;
  for (let i = 0; i < 20; i += 1) {
    const r = await validatePromoCode({ shopId: honest, code: pct20.code });
    if (!r.ok) allOk = false;
  }
  check(
    "successful applies never spend throttle budget (honest merchant unaffected)",
    allOk,
  );

  console.log(
    failures === 0
      ? `\nALL ${checks} CHECKS PASSED`
      : `\n${failures} OF ${checks} CHECK(S) FAILED`,
  );
  return cleanup;
}

let cleanupFn: (() => Promise<void>) | null = null;
main()
  .then((cleanup) => {
    cleanupFn = cleanup;
  })
  .catch((error) => {
    console.error(error);
    failures += 1;
  })
  .finally(async () => {
    try {
      if (cleanupFn) await cleanupFn();
    } catch (error) {
      console.error("cleanup failed", error);
      failures += 1;
    }
    // MUST await: the shared app/db.server singleton keeps the process alive
    // (this exact omission wedged `npm run smoke` before).
    const { default: db } = await import("../../app/db.server");
    await db.$disconnect();
    process.exit(failures === 0 ? 0 : 1);
  });
