/* Bonus quota grants (spec 15 delta — QA area Z).
 *
 * Run:  PRISMA_CLIENT_ENGINE_TYPE=binary npx tsx scripts/qa/quota-grants.test.ts
 * Needs: dev Postgres up + migrated. No dev server, no LLM key, no Shopify.
 *
 * WHAT A GRANT IS: a per-store increase to one quota, for as long as it lives.
 * Effective limit = plan allowance + live grants. Nothing is consumed one at a
 * time; withdrawing or expiring a grant drops the limit straight back.
 *
 * This replaced BOTH a consumable-credit model and the global open/enforced
 * enforcement switch (2026-09-08). The switch gave every store the top tier at
 * once — generous and impossible to target; a grant does the same job for one
 * store, which is what "give this merchant more" actually means.
 *
 * Fixtures are `qa-grants-*` shops, removed in the `finally`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

for (const line of readFileSync(join(process.cwd(), ".env"), "utf-8").split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (match && !line.trim().startsWith("#") && process.env[match[1]] === undefined) {
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}
process.env.BILLING_TEST_MODE = "true";

const PREFIX = "qa-grants-";
let passed = 0;
let failed = 0;

function ok(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const eq = (name: string, actual: unknown, expected: unknown) =>
  ok(name, Object.is(actual, expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);

async function main(): Promise<void> {
  const db = (await import("../../app/db.server")).default;
  const grants = await import("../../app/lib/billing/quota-grants.server");
  const usage = await import("../../app/lib/billing/usage.server");
  const plans = await import("../../app/lib/billing/plans.server");
  await plans.loadPlanConfig();

  let seq = 0;
  const mkShop = async (label: string, patch: Record<string, unknown> = {}) => {
    seq += 1;
    return db.shop.create({
      data: { domain: `${PREFIX}${label}-${Date.now()}-${seq}.myshopify.com`, plan: "free", ...patch },
    });
  };
  const period = usage.currentPeriodStart();
  const setUsed = (shopId: string, count: number) =>
    db.planUsage.upsert({
      where: { shopId_periodStart: { shopId, periodStart: period } },
      create: { shopId, periodStart: period, conversationCount: count },
      update: { conversationCount: count, overageCount: 0, overageReported: 0 },
    });
  const mkConvo = (shopId: string) =>
    db.conversation.create({
      data: { shopId, sessionId: `${PREFIX}${Math.random().toString(36).slice(2)}`, lastMessageAt: new Date() },
    });

  try {
    // ── 1. Granting and reading back ────────────────────────────────────────
    console.log("\n[1] Grant and balance");
    const a = await mkShop("grant");
    eq("a new shop has no bonus", await grants.bonusQuota(a.id), 0);
    eq("granting returns the new balance", await grants.grantQuota(a.id, { amount: 100 }), 100);
    eq("a second grant ADDS, never replaces", await grants.grantQuota(a.id, { amount: 50 }), 150);
    eq("both grants are on the ledger", (await grants.listGrants(a.id)).length, 2);

    const b = await mkShop("audit");
    await grants.grantQuota(b.id, { amount: 10, reason: "goodwill", grantedBy: "ops@example.com" });
    const [row] = await grants.listGrants(b.id);
    ok("the ledger records who and why", row.reason === "goodwill" && row.grantedBy === "ops@example.com");

    // ── 2. Guard rails ──────────────────────────────────────────────────────
    console.log("\n[2] Grant validation");
    for (const bad of [0, -5, 0.4]) {
      let threw = false;
      try {
        await grants.grantQuota(a.id, { amount: bad });
      } catch {
        threw = true;
      }
      ok(`an amount of ${bad} is refused`, threw);
    }
    let capped = false;
    try {
      await grants.grantQuota(a.id, { amount: 200_000 });
    } catch {
      capped = true;
    }
    ok("a mistyped enormous grant is refused", capped, "a typo must not uncap a shop");

    // ── 3. THE RULE: a grant raises the effective limit ─────────────────────
    console.log("\n[3] A grant raises the limit, and nothing inside it is billed");
    const planQuota = plans.getQuota("basic", "conversations");
    const paid = await mkShop("paid", {
      plan: "basic",
      planStatus: "active",
      billingInterval: "monthly",
      subscriptionId: "gid://shopify/AppSubscription/qa-grants",
      usageLineItemId: "gid://shopify/AppSubscriptionLineItem/qa-grants-usage",
    });
    ok(
      "the fixture really is billable",
      usage.overageBillable({ plan: "basic", billingInterval: "monthly", usageLineItemId: "gid://x" }),
    );
    await setUsed(paid.id, 0);
    eq("with no grant the limit is the plan's", (await usage.usageStatus(paid.id)).quota, planQuota);
    await grants.grantQuota(paid.id, { amount: 50 });
    eq("a grant raises it", (await usage.usageStatus(paid.id)).quota, planQuota + 50);
    eq("…and it is reported to the merchant", (await usage.usageStatus(paid.id)).credits, 50);

    // Sitting inside the bonus: served, and NOT billed.
    await setUsed(paid.id, planQuota + 10);
    const insideConvo = await mkConvo(paid.id);
    const inside = await usage.tickConversation({
      shopId: paid.id,
      conversationId: insideConvo.id,
      previousLastMessageAt: insideConvo.lastMessageAt,
    });
    ok("a conversation inside the bonus is not billed", inside.overageRecorded === false, JSON.stringify(inside));
    ok("…and counts as within quota", inside.withinQuota === true);

    // Past plan + bonus the ceiling is real again.
    await setUsed(paid.id, planQuota + 50);
    const pastConvo = await mkConvo(paid.id);
    const past = await usage.tickConversation({
      shopId: paid.id,
      conversationId: pastConvo.id,
      previousLastMessageAt: pastConvo.lastMessageAt,
    });
    ok("past plan + bonus, overage resumes", past.overageRecorded === true, JSON.stringify(past));

    // ── 4. Withdrawal and expiry drop the limit back ────────────────────────
    console.log("\n[4] Withdrawal and expiry");
    for (const g of await grants.listGrants(paid.id)) await grants.revokeGrant(paid.id, g.id);
    eq("withdrawing restores the plan limit", (await usage.usageStatus(paid.id)).quota, planQuota);
    ok(
      "a withdrawn grant stays on the ledger for audit",
      (await grants.listGrants(paid.id)).some((g) => g.amount === 50 && g.remaining === 0),
    );
    const exp = await mkShop("expiry");
    await grants.grantQuota(exp.id, { amount: 5, expiresAt: new Date(Date.now() - 1000) });
    eq("an expired grant adds nothing", await grants.bonusQuota(exp.id), 0);
    ok(
      "…but is still visible, marked expired",
      (await grants.listGrants(exp.id)).some((g) => g.expired && g.amount === 5),
    );

    // ── 5. The Free shop this feature exists for ────────────────────────────
    console.log("\n[5] aiAllowed on a Free shop past its cap");
    const free = await mkShop("free");
    await setUsed(free.id, plans.getQuota("free", "conversations"));
    eq("a Free shop at its cap is stopped", await usage.aiAllowed(free.id), false);
    await grants.grantQuota(free.id, { amount: 3 });
    eq("…a grant starts it answering again", await usage.aiAllowed(free.id), true);
    // The grant is a LIMIT, not a licence: past plan + bonus it stops again.
    // (Regression: aiAllowed once returned true whenever any grant existed,
    // which under the cap-raise model — where nothing decrements — meant a +3
    // grant answered for ever instead of for three more conversations.)
    await setUsed(free.id, plans.getQuota("free", "conversations") + 3);
    eq("…but only up to plan + bonus", await usage.aiAllowed(free.id), false);
    await setUsed(free.id, plans.getQuota("free", "conversations") + 1);
    eq("…and still answers inside it", await usage.aiAllowed(free.id), true);
    await grants.revokeGrant(free.id, (await grants.listGrants(free.id))[0].id);
    await setUsed(free.id, plans.getQuota("free", "conversations"));
    eq("…and withdrawing stops it again", await usage.aiAllowed(free.id), false);

    // ── 6. Dimensions are independent ───────────────────────────────────────
    console.log("\n[6] products_synced is its own balance");
    const cap = await mkShop("cap");
    eq("no grant, no bonus", await grants.bonusQuota(cap.id, "products_synced"), 0);
    await grants.grantQuota(cap.id, { dimension: "products_synced", amount: 500 });
    eq("a product grant raises the product cap", await grants.bonusQuota(cap.id, "products_synced"), 500);
    eq("…and does not touch conversations", await grants.bonusQuota(cap.id, "conversations"), 0);
    await grants.grantQuota(cap.id, { dimension: "conversations", amount: 7 });
    eq("…nor the reverse", await grants.bonusQuota(cap.id, "products_synced"), 500);
    eq("both balances stand", await grants.bonusQuota(cap.id, "conversations"), 7);

    // ── 7. Tenancy ──────────────────────────────────────────────────────────
    console.log("\n[7] Tenancy");
    const other = await mkShop("other");
    await grants.grantQuota(other.id, { amount: 99 });
    eq("one shop's grant never reaches another", await grants.bonusQuota(free.id), 0);
    eq(
      "revoking cannot reach across shops",
      await grants.revokeGrant(free.id, (await grants.listGrants(other.id))[0].id),
      false,
    );
    eq("…and the other shop keeps its balance", await grants.bonusQuota(other.id), 99);
    let blankThrew = false;
    try {
      await grants.bonusQuota("");
    } catch {
      blankThrew = true;
    }
    ok("a blank shopId is rejected outright", blankThrew);

    // ── 8. Source guards ────────────────────────────────────────────────────
    console.log("\n[8] Source guards");
    const usageSrc = readFileSync(join(process.cwd(), "app", "lib", "billing", "usage.server.ts"), "utf-8");
    ok(
      "the meter's limit is plan + bonus",
      usageSrc.includes('getQuota(plan, "conversations") + (await bonusQuota(shopId, "conversations"))'),
      "overage must only ever start past the two together",
    );
    ok(
      "nothing consumes a grant one at a time any more",
      !usageSrc.includes("consumeQuota"),
      "a consumable path would reintroduce the ordering trap this design removes",
    );
    const syncSrc = readFileSync(
      join(process.cwd(), "app", "lib", "ingestion", "catalog-sync.server.ts"),
      "utf-8",
    );
    const trainingSrc = readFileSync(
      join(process.cwd(), "app", "routes", "app.ai-agent.training.tsx"),
      "utf-8",
    );
    const planUsageSrc = readFileSync(
      join(process.cwd(), "app", "routes", "app.plan-usage.tsx"),
      "utf-8",
    );
    ok(
      "the conversation COUNT includes the bonus, not just the banner",
      planUsageSrc.includes("quota: status.quota"),
      "reading getQuota(plan) alone here excluded a bonus the banner was announcing",
    );
    ok(
      "both screens explain a grant with a banner",
      readFileSync(join(process.cwd(), "app", "components", "TrainingProductsTab.tsx"), "utf-8")
        .includes('<s-banner tone="success">'),
    );
    ok(
      "the merchant-facing product meter shows plan + bonus, not the plan alone",
      trainingSrc.includes('getQuota(plan, "products_synced") + productBonus'),
      "otherwise a granted store reads 200/200 while the sync happily runs to 700",
    );
    ok(
      "the product cap adds the bonus in BOTH enforcement sites",
      syncSrc.split('bonusQuota(shopId, "products_synced")').length - 1 === 2,
      "the bulk sync and the webhook create path each cap independently (QA D7)",
    );
    const plansSrc = readFileSync(join(process.cwd(), "app", "lib", "billing", "plans.server.ts"), "utf-8");
    ok(
      "the global enforcement switch is gone",
      !plansSrc.includes("planEnforcementMode") && !plansSrc.includes('"open"'),
      "gates are always live; one store is given more with a grant, not everyone at once",
    );
  } finally {
    const shops = await db.shop.findMany({
      where: { domain: { startsWith: PREFIX } },
      select: { id: true },
    });
    const ids = shops.map((s) => s.id);
    await db.quotaGrant.deleteMany({ where: { shopId: { in: ids } } });
    await db.planUsage.deleteMany({ where: { shopId: { in: ids } } });
    await db.conversation.deleteMany({ where: { shopId: { in: ids } } });
    await db.shop.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
  }

  console.log(`\n${passed} passed / ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
