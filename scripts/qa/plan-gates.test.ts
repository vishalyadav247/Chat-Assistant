/* Plan gate enforcement — end-to-end (test cases B-10 .. B-15, spec 15).
 * Run: npx tsx scripts/qa/plan-gates.test.ts
 *
 * admin-check.ts already proves the MATRIX resolves correctly. This proves
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
// The store-info chain (instructions/settings save → files.server) imports
// shopify.server, which throws on an empty app URL / API key (QA-T1).
process.env.SHOPIFY_API_KEY ||= "qa-placeholder-key";
process.env.SHOPIFY_API_SECRET ||= "qa-placeholder-secret";
process.env.SHOPIFY_APP_URL ||= "http://localhost:3000";
process.env.SCOPES ||= "read_products";

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

async function main(): Promise<void> {
  const db = (await import("../../app/db.server")).default;
  const plans = await import("../../app/lib/billing/plans.server");
  const { savePlanConfig } = await import(
    "../../app/lib/admin/admin-settings.server"
  );
  const { saveCuratedAnswer } = await import("../../app/lib/curated/save.server");
  const { saveCampaign, toggleCampaign } = await import("../../app/lib/campaigns/campaigns.server");
  const { saveRecommendation, saveCrossSellPair, saveGeneralInstructions } = await import(
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
    // Gates are always live now; pin the matrix to defaults for the run.
    await savePlanConfig({});

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
    await setPlan("basic"); // quota read live — 3 since the 2026-09-11 re-baseline
    const basicCampaigns = plans.getQuota("basic", "active_campaigns");
    const campaignPayload = (name: string, status: "active" | "inactive") => ({
      name,
      templateType: "welcome",
      status,
      settings: {},
    });
    const withinQuota = [];
    for (let i = 1; i <= basicCampaigns; i++) {
      withinQuota.push(await saveCampaign(shopId, "basic", campaignPayload(`probe ${i}`, "active")));
    }
    const c1 = withinQuota[0];
    ok(
      `${basicCampaigns} active campaigns allowed on Basic`,
      withinQuota.length === basicCampaigns && withinQuota.every((r) => r.ok === true),
    );
    const c3 = await saveCampaign(shopId, "basic", campaignPayload("probe over quota", "active"));
    ok(
      "the next ACTIVE campaign past the quota is refused on Basic",
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

    // ── B-15: recommendation rules + cross-sell are UN-GATED (2026-09-10) ──
    // The merged rule saves on every plan; cross-sell pairs have no limit.
    await setPlan("free");
    let freeRecOk = false;
    try {
      await saveRecommendation(shopId, {
        title: "probe rec",
        triggerQuestions: ["probe"],
        productIds: ["gid://shopify/Product/1"],
        collectionIds: [],
        status: "active",
      });
      freeRecOk = true;
    } catch {
      freeRecOk = false;
    }
    ok("merged recommendation rule saves on Free (un-gated 2026-09-10)", freeRecOk);
    // recommendation_rules quota (5/10/25/50, user decision): count is tiered.
    const freeRuleQuota = plans.getQuota("free", "recommendation_rules");
    ok("recommendation_rules quota on Free is 5", freeRuleQuota === 5, String(freeRuleQuota));
    let rulesCreated = 1; // "probe rec" above is the first
    for (let i = rulesCreated + 1; i <= freeRuleQuota; i++) {
      try {
        await saveRecommendation(shopId, {
          title: `probe rec ${i}`,
          triggerQuestions: ["probe"],
          productIds: ["gid://shopify/Product/1"],
          collectionIds: [],
          status: "active",
        });
        rulesCreated++;
      } catch {
        break;
      }
    }
    ok("rules save up to the quota", rulesCreated === freeRuleQuota, String(rulesCreated));
    let sixthRefused = false;
    try {
      await saveRecommendation(shopId, {
        title: "probe rec over quota",
        triggerQuestions: ["probe"],
        productIds: ["gid://shopify/Product/1"],
        collectionIds: [],
        status: "active",
      });
    } catch (error) {
      sixthRefused = /plan allows/i.test((error as Error).message ?? "");
    }
    ok("one rule past the quota is refused", sixthRefused);
    // Products XOR collections (user decision 2026-09-10): both at once refused.
    let bothRefused = false;
    try {
      await saveRecommendation(shopId, {
        title: "probe both",
        triggerQuestions: ["probe"],
        productIds: ["gid://shopify/Product/1"],
        collectionIds: ["gid://shopify/Collection/1"],
        status: "active",
      });
    } catch (error) {
      bothRefused = /not both/i.test((error as Error).message ?? "");
    }
    ok("a rule with BOTH products and collections is refused", bothRefused);
    ok(
      "custom_recommendations is no longer a gated feature",
      !(plans.GATED_FEATURES as string[]).includes("custom_recommendations"),
    );

    // Cross-sell pairs have NO limit since 2026-09-11 (user decision): a pair
    // costs nothing per chat turn and is already bounded by one pair per
    // product. Asserted on Free, where the old limit of 3 used to refuse.
    ok(
      "cross_sell_pairs is no longer a quota dimension",
      !(plans.QUOTA_DIMENSIONS as string[]).includes("cross_sell_pairs"),
    );
    const PAIRS_PAST_OLD_LIMIT = 6; // the old Free limit was 3
    let pairsCreated = 0;
    for (let i = 1; i <= PAIRS_PAST_OLD_LIMIT; i++) {
      try {
        await saveCrossSellPair(shopId, {
          productId: `gid://shopify/Product/${i}`,
          companionIds: ["gid://shopify/Product/99"],
        });
        pairsCreated++;
      } catch {
        break;
      }
    }
    ok(
      "a Free store saves cross-sell pairs past the old limit of 3",
      pairsCreated === PAIRS_PAST_OLD_LIMIT,
      String(pairsCreated),
    );
    let editOk = false;
    try {
      await saveCrossSellPair(shopId, {
        productId: "gid://shopify/Product/1",
        companionIds: ["gid://shopify/Product/98"],
      });
      editOk = true;
    } catch {
      editOk = false;
    }
    ok("editing an existing pair still saves", editOk);

    // Auto-detect language is UN-GATED (2026-09-03): every plan may turn it on.
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
    await setPlan("free");
    let freeLangOk = false;
    try {
      await saveGeneralInstructions(shopId, general);
      freeLangOk = true;
    } catch {
      freeLangOk = false;
    }
    ok("auto-detect language saves on Free (multi_language un-gated 2026-09-03)", freeLangOk);
    ok(
      "multi_language is no longer a gated feature",
      !(plans.GATED_FEATURES as string[]).includes("multi_language"),
    );

    // ── B-13 never-gated surfaces stay open on Free ───────────────────────
    await setPlan("free");
    // push_notifications is on Free since the 2026-09-11 re-baseline.
    for (const feature of ["remove_branding", "order_tracking"] as const) {
      ok(`free is gated out of ${feature}`, plans.hasFeature("free", feature) === false);
    }
    // order_tracking is applied in shop-config, so the widget config AND the
    // pipeline's track_order action both see the effective value. The stored
    // switch stays on — an upgrade restores it untouched.
    {
      const { getShopConfig, invalidateShopConfig } = await import(
        "../../app/lib/config/shop-config.server"
      );
      const { availableActions } = await import("../../app/lib/pipeline/actions.server");
      await db.widgetSettings.upsert({
        where: { shopId },
        create: { shopId, settings: { orderTracking: true } },
        update: { settings: { orderTracking: true } },
      });
      invalidateShopConfig(shopId);
      const freeCfg = await getShopConfig(shopId);
      ok(
        "Free: stored orderTracking on → effective off, no track_order action",
        freeCfg.widget.orderTracking === false &&
          !availableActions(freeCfg.widget).some((a) => a.key === "track_order"),
      );
      await setPlan("basic");
      invalidateShopConfig(shopId);
      const basicCfg = await getShopConfig(shopId);
      ok(
        "Basic: order tracking effective again after the upgrade",
        basicCfg.widget.orderTracking === true &&
          availableActions(basicCfg.widget).some((a) => a.key === "track_order"),
      );
      await db.widgetSettings.delete({ where: { shopId } });
      invalidateShopConfig(shopId);
      await setPlan("free");
    }
    // "exports" and "file_upload" were un-gated 2026-09-10 (user decision):
    // exports have no cap at all; file uploads are capped only by the
    // file_uploads QUOTA (5 on every plan).
    ok(
      "exports + file_upload are no longer gated features",
      !(plans.GATED_FEATURES as string[]).includes("exports") &&
        !(plans.GATED_FEATURES as string[]).includes("file_upload"),
    );
    ok(
      "file_uploads quota is nonzero on every plan",
      (["free", "basic", "pro", "plus"] as const).every((p) => plans.getQuota(p, "file_uploads") > 0),
    );
    // Spec 15 never-gate list: inbox, human handover, GDPR flows and the Test
    // AI console must have NO gate identifier at all, so no operator edit at
    // /admin/plans can ever switch them off for a tier.
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

    // ── B-05 a BONUS GRANT lifts the quota for one shop ───────────────────
    // Successor to the old "open mode makes every gate pass" case: that switch
    // was global, this is per-shop, and it is what an operator uses now.
    // curated_answers is NOT grantable: nothing reads the bonus at its check
    // site, so offering it would be a silent no-op. The grant must be refused
    // rather than saved and ignored.
    const grantsMod = await import("../../app/lib/billing/quota-grants.server");
    let refusedDimension = false;
    try {
      await grantsMod.grantQuota(shopId, { dimension: "curated_answers", amount: 50, reason: "qa" });
    } catch {
      refusedDimension = true;
    }
    ok("a grant for an unwired dimension is refused, not silently ignored", refusedDimension);
    const openCreate = await saveCuratedAnswer(shopId, {
      question: "gate probe question OPEN MODE",
      synonyms: [],
      productIds: [],
      talkingPoints: "probe",
      status: "draft",
      priority: "normal",
    });
    ok("…so the curated quota still bites", openCreate.ok === false);
    // FEATURES are not grantable — a grant tops up a NUMBER, never unlocks a
    // gated capability. Upgrading is the only way to get those.
    ok("…but features stay gated by plan", plans.hasFeature("free", "remove_branding") === false);
    for (const g of await grantsMod.listGrants(shopId)) await grantsMod.revokeGrant(shopId, g.id);
  } finally {
    // Remove the fixture shop and restore the operator's stored plan config.
    await db.curatedAnswer.deleteMany({ where: { shopId } });
    await db.campaign.deleteMany({ where: { shopId } });
    await db.recommendation.deleteMany({ where: { shopId } });
    await db.crossSellPair.deleteMany({ where: { shopId } });
    await db.persona.deleteMany({ where: { shopId } });
    await db.guardrails.deleteMany({ where: { shopId } });
    await db.analyticsEvent.deleteMany({ where: { shopId } });
    // The gate fixtures embed content, so this shop owns usage rows. llm_usage_daily
    // has no foreign key, so anything left here is counted by the admin fleet
    // cost tile forever with no shop left to attribute it to.
    await db.llmUsageDaily.deleteMany({ where: { shopId } });
    await db.planUsage.deleteMany({ where: { shopId } });
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
