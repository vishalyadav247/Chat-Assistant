/* Plan gate enforcement — end-to-end (test cases B-10 .. B-15, spec 15).
 * Run: npx tsx scripts/qa/plan-gates.test.ts
 *
 * platform-check.ts already proves the MATRIX resolves correctly. This proves
 * the gates actually BITE at the real mutation points: quotas refuse the N+1th
 * create, feature gates throw PlanGateError, over-quota data survives a
 * downgrade, and the never-gate list stays open on Free.
 *
 * Runs against a throwaway shop and removes it afterwards. Never touches
 * dev-shop.myshopify.com.
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

const SHOP_DOMAIN = "plan-gates-test.myshopify.com";
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

/** Run `fn` and report whether it was refused by a plan gate. */
async function refused(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    const result = await fn();
    // Savers that return a result object rather than throwing.
    if (result && typeof result === "object") {
      const r = result as { ok?: boolean; code?: string; error?: string };
      if (r.ok === false && (r.code === "cap" || r.code === "plan_gate")) return true;
      if (r.ok === false) return false;
    }
    return false;
  } catch (error) {
    return (error as Error).message?.startsWith("plan_gate:") ?? false;
  }
}

async function main(): Promise<void> {
  const db = (await import("../../app/db.server")).default;
  const plans = await import("../../app/lib/billing/plans.server");
  const { savePlanConfig } = await import(
    "../../app/lib/platform/platform-settings.server"
  );
  const { saveCuratedAnswer } = await import("../../app/lib/curated/save.server");
  const { saveCampaign, toggleCampaign } = await import("../../app/lib/campaigns/campaigns.server");
  const { saveCustomRecommendation, saveCrossSellPair, saveGeneralInstructions } = await import(
    "../../app/lib/instructions/save.server"
  );

  const priorConfig = await db.appSecret.findUnique({
    where: { key: plans.PLAN_CONFIG_SECRET_KEY },
  });

  const shop = await db.shop.upsert({
    where: { domain: SHOP_DOMAIN },
    create: { domain: SHOP_DOMAIN, name: "Plan gates fixture", plan: "free" },
    update: { plan: "free", uninstalledAt: null },
  });
  const shopId = shop.id;

  const setPlan = async (plan: string) => {
    await db.shop.update({ where: { id: shopId }, data: { plan } });
  };

  try {
    await savePlanConfig({ enforcement: "enforced" });
    ok("enforcement is enforced for this run", plans.planEnforcementMode() === "enforced");

    // ── B-10 quota bites: curated_answers on Free (quota 5) ────────────────
    await setPlan("free");
    const quota = plans.getQuota("free", "curated_answers");
    ok("free curated_answers quota is 5", quota === 5, String(quota));

    let created = 0;
    for (let i = 0; i < quota; i++) {
      const r = await saveCuratedAnswer(shopId, {
        question: `gate probe question ${i}`,
        synonyms: [],
        productIds: [],
        talkingPoints: "probe",
        status: "draft",
        priority: "normal",
      });
      if (r.ok) created++;
    }
    ok("creates up to the quota succeed", created === quota, `${created}/${quota}`);

    const overCap = await saveCuratedAnswer(shopId, {
      question: "gate probe question OVER",
      synonyms: [],
      productIds: [],
      talkingPoints: "probe",
      status: "draft",
      priority: "normal",
    });
    ok(
      "the N+1th create is refused with code=cap",
      overCap.ok === false && overCap.code === "cap",
      overCap.ok === false ? overCap.error : "unexpectedly succeeded",
    );

    // ── B-12 downgrade keeps over-quota data ──────────────────────────────
    await setPlan("plus");
    const extra = await saveCuratedAnswer(shopId, {
      question: "gate probe question PLUS",
      synonyms: [],
      productIds: [],
      talkingPoints: "probe",
      status: "draft",
      priority: "normal",
    });
    ok("upgrading lifts the cap", extra.ok === true);

    await setPlan("free");
    const survivors = await db.curatedAnswer.count({ where: { shopId } });
    ok(
      "downgrade KEEPS over-quota rows (no deletions)",
      survivors === quota + 1,
      `${survivors} rows retained`,
    );
    const blockedAfterDowngrade = await saveCuratedAnswer(shopId, {
      question: "gate probe question AFTER DOWNGRADE",
      synonyms: [],
      productIds: [],
      talkingPoints: "probe",
      status: "draft",
      priority: "normal",
    });
    ok(
      "downgrade blocks NEW creates while over quota",
      blockedAfterDowngrade.ok === false && blockedAfterDowngrade.code === "cap",
    );

    // ── B-15 active_campaigns quota ───────────────────────────────────────
    await setPlan("basic"); // quota 2
    const campaignPayload = (name: string, status: "active" | "inactive") => ({
      name,
      templateType: "welcome",
      status,
      settings: {},
    });
    const c1 = await saveCampaign(shopId, "basic", campaignPayload("probe 1", "active"));
    const c2 = await saveCampaign(shopId, "basic", campaignPayload("probe 2", "active"));
    ok("two active campaigns allowed on Basic", c1.ok === true && c2.ok === true);
    const c3 = await saveCampaign(shopId, "basic", campaignPayload("probe 3", "active"));
    ok(
      "third ACTIVE campaign refused on Basic",
      c3.ok === false && c3.code === "plan_gate",
      c3.ok === false ? c3.error : "unexpectedly succeeded",
    );
    const c3draft = await saveCampaign(shopId, "basic", campaignPayload("probe 3 draft", "inactive"));
    ok("inactive campaigns are NOT quota-limited", c3draft.ok === true);

    if (c3draft.ok) {
      const toggled = await toggleCampaign(shopId, c3draft.id, true);
      ok(
        "activating a draft over quota is refused",
        typeof toggled === "object" && "error" in toggled,
      );
    }
    // Re-saving an already-active campaign must not trip its own gate.
    if (c1.ok) {
      const resave = await saveCampaign(shopId, "basic", {
        ...campaignPayload("probe 1 renamed", "active"),
        id: c1.id,
      });
      ok("re-saving an already-active campaign still works", resave.ok === true);
    }

    await setPlan("plus"); // unlimited
    const cUnlimited = await saveCampaign(shopId, "plus", campaignPayload("probe plus", "active"));
    ok("Plus has unlimited active campaigns", cUnlimited.ok === true);

    // ── B-15 feature gates ────────────────────────────────────────────────
    await setPlan("basic");
    ok(
      "custom_recommendations refused on Basic",
      await refused(() =>
        saveCustomRecommendation(shopId, {
          name: "probe rec",
          searchTerms: ["probe"],
          productIds: ["gid://shopify/Product/1"],
          collectionIds: [],
          status: "active",
        }),
      ),
    );
    ok(
      "cross-sell pairs refused on Basic",
      await refused(() =>
        saveCrossSellPair(shopId, {
          productId: "gid://shopify/Product/1",
          companionIds: ["gid://shopify/Product/2"],
        }),
      ),
    );

    await setPlan("pro");
    let proRecOk = false;
    try {
      await saveCustomRecommendation(shopId, {
        name: "probe rec pro",
        searchTerms: ["probe"],
        productIds: ["gid://shopify/Product/1"],
        collectionIds: [],
        status: "active",
      });
      proRecOk = true;
    } catch {
      proRecOk = false;
    }
    ok("custom_recommendations allowed on Pro", proRecOk);

    // multi_language: Plus only, and only the OFF→ON transition is gated.
    const general = {
      role: "Support agent",
      communicationStyle: "friendly",
      brandVoice: "warm",
      behaviours: "be helpful",
      defaultLanguage: "en",
      autoDetectLanguage: true,
      bannedTopics: [],
      fallbackMessage: "Sorry, I can't help with that.",
    };
    await setPlan("pro");
    ok(
      "multi_language refused on Pro",
      await refused(() => saveGeneralInstructions(shopId, general)),
    );
    await setPlan("plus");
    let plusLangOk = false;
    try {
      await saveGeneralInstructions(shopId, general);
      plusLangOk = true;
    } catch {
      plusLangOk = false;
    }
    ok("multi_language allowed on Plus", plusLangOk);

    await setPlan("pro");
    let keptOnDowngrade = false;
    try {
      // Already ON from the Plus save — saving again must NOT be refused.
      await saveGeneralInstructions(shopId, general);
      keptOnDowngrade = true;
    } catch {
      keptOnDowngrade = false;
    }
    ok("a downgraded shop keeps auto-detect and can still save", keptOnDowngrade);

    // ── B-13 never-gated surfaces stay open on Free ───────────────────────
    await setPlan("free");
    for (const feature of ["survey", "push_notifications", "custom_recommendations", "multi_language"] as const) {
      ok(`free is gated out of ${feature}`, plans.hasFeature("free", feature) === false);
    }
    // Spec 15 never-gate list: inbox, human handover, GDPR flows and the Test
    // AI console must have NO gate identifier at all, so no operator edit at
    // /platform/plans can ever switch them off for a tier.
    // inbox_cart_view is deliberately allowed: it gates an extra PANEL inside
    // the inbox (the shopper's live cart), not access to the inbox itself.
    const allowed = new Set(["inbox_cart_view"]);
    const forbidden = ["inbox", "handover", "gdpr", "compliance", "data_request", "test_ai"];
    const offenders = plans.GATED_FEATURES.filter(
      (f) => !allowed.has(f) && forbidden.some((word) => f === word || f.startsWith(`${word}_`)),
    );
    ok(
      "never-gate list has no gate identifier",
      offenders.length === 0,
      offenders.length ? `found ${offenders.join(", ")}` : "inbox/handover/GDPR/Test AI ungated",
    );
    ok(
      "inbox_cart_view is a display gate, not an inbox gate",
      plans.GATED_FEATURES.includes("inbox_cart_view") && plans.hasFeature("free", "inbox_cart_view") === false,
    );

    // ── B-05 open mode makes every gate pass ──────────────────────────────
    await savePlanConfig({ enforcement: "open" });
    const openCreate = await saveCuratedAnswer(shopId, {
      question: "gate probe question OPEN MODE",
      synonyms: [],
      productIds: [],
      talkingPoints: "probe",
      status: "draft",
      priority: "normal",
    });
    ok("open mode lifts the quota", openCreate.ok === true);
    ok("open mode grants every feature", plans.hasFeature("free", "multi_language") === true);
  } finally {
    // Remove the fixture shop and restore the operator's stored plan config.
    await db.curatedAnswer.deleteMany({ where: { shopId } });
    await db.campaign.deleteMany({ where: { shopId } });
    await db.customRecommendation.deleteMany({ where: { shopId } });
    await db.crossSellPair.deleteMany({ where: { shopId } });
    await db.persona.deleteMany({ where: { shopId } });
    await db.guardrails.deleteMany({ where: { shopId } });
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
    console.error("\nPLAN GATE TESTS FAIL", error?.message ?? error);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Disconnect the shared singleton or the open pool keeps the event loop
    // alive and the script never exits.
    const appDb = (await import("../../app/db.server")).default;
    await appDb.$disconnect();
  });
