/* Platform settings round-trip check (spec 19 acceptance #3–#6).
 *   npx tsx scripts/platform-check.ts
 * Verifies: plan overrides apply to PLANS/gates in-process and persist to
 * app_secrets; enforcement switch works; reset restores code defaults; AI
 * overrides save/clear. Leaves the DB exactly as it found it.
 */
import db from "../app/db.server";
import {
  DEFAULT_ENFORCEMENT,
  DEFAULT_PLANS,
  getQuota,
  hasFeature,
  loadPlanConfig,
  PLAN_CONFIG_SECRET_KEY,
  planEnforcementMode,
  PLANS,
} from "../app/lib/billing/plans.server";
import {
  AI_SECRET_KEY,
  getAiOverrides,
  resetPlanConfig,
  saveAiOverrides,
  savePlanConfig,
} from "../app/lib/platform/platform-settings.server";

function assert(cond: boolean, label: string) {
  if (!cond) throw new Error(`FAIL: ${label}`);
  console.log(`ok: ${label}`);
}

async function main() {
  const priorPlans = await db.appSecret.findUnique({ where: { key: PLAN_CONFIG_SECRET_KEY } });
  const priorAi = await db.appSecret.findUnique({ where: { key: AI_SECRET_KEY } });

  try {
    // 1. Plan override cycle
    await savePlanConfig({
      enforcement: "enforced",
      plans: { basic: { quotas: { conversations: 123 }, features: ["exports"] } },
    });
    assert(planEnforcementMode() === "enforced", "enforcement flips to enforced");
    assert(PLANS.basic.quotas.conversations === 123, "PLANS.basic quota overridden in place");
    assert(getQuota("basic", "conversations") === 123, "getQuota reads override under enforcement");
    assert(hasFeature("basic", "exports") === true, "overridden feature list grants exports");
    assert(hasFeature("basic", "remove_branding") === false, "non-listed feature now gated");
    assert(
      PLANS.free.quotas.conversations === DEFAULT_PLANS.free.quotas.conversations,
      "untouched plan keeps defaults",
    );

    // 2. Persistence: a fresh load from the DB reproduces the override
    PLANS.basic.quotas.conversations = 1; // simulate stale memory
    await loadPlanConfig();
    assert(PLANS.basic.quotas.conversations === 123, "override persisted + reloadable from app_secrets");

    // 3. Reset restores code defaults exactly
    await resetPlanConfig();
    assert(planEnforcementMode() === DEFAULT_ENFORCEMENT, "reset returns enforcement to the code default");
    assert(
      JSON.stringify(PLANS) === JSON.stringify(DEFAULT_PLANS),
      "reset restores the full default matrix",
    );

    // 3b. Enforced mode reads the real matrix; open mode is unlimited + all-pass.
    await savePlanConfig({ enforcement: "enforced" });
    assert(
      getQuota("basic", "conversations") === DEFAULT_PLANS.basic.quotas.conversations,
      "enforced mode = real matrix quotas",
    );
    assert(hasFeature("free", "exports") === false, "enforced mode gates a Free shop");
    await savePlanConfig({ enforcement: "open" });
    assert(getQuota("basic", "conversations") === Number.MAX_SAFE_INTEGER, "open mode = unlimited quotas");
    assert(hasFeature("free", "exports") === true, "open mode grants every feature");
    await resetPlanConfig();

    // 3c. The seams added 2026-08-21 must be present and enforced.
    assert(
      getQuota("free", "active_campaigns") === 0 && getQuota("pro", "active_campaigns") === 10,
      "active_campaigns quota enforced per tier",
    );
    assert(
      getQuota("free", "analytics_range_days") === 7 && getQuota("plus", "analytics_range_days") === 365,
      "analytics_range_days quota enforced per tier",
    );
    for (const [feature, freeHas, plusHas] of [
      ["survey", false, true],
      ["push_notifications", false, true],
      ["custom_recommendations", false, true],
      ["multi_language", false, true],
    ] as const) {
      assert(
        hasFeature("free", feature) === freeHas && hasFeature("plus", feature) === plusHas,
        `gate ${feature} follows the matrix`,
      );
    }
    assert(hasFeature("basic", "custom_recommendations") === false, "custom_recommendations is Pro+");
    assert(hasFeature("basic", "survey") === true, "survey is Basic+");
    assert(hasFeature("pro", "multi_language") === false, "multi_language is Plus-only");

    // 4. AI overrides save + clear
    await saveAiOverrides({ chatModel: "gpt-4o", temperature: 0.7, maxTokens: 500 });
    const ai = await getAiOverrides();
    assert(ai.chatModel === "gpt-4o" && ai.temperature === 0.7 && ai.maxTokens === 500, "AI overrides saved");
    await saveAiOverrides({ chatModel: "", temperature: null, maxTokens: null });
    const cleared = await getAiOverrides();
    assert(cleared.chatModel === "" && cleared.temperature === null, "AI overrides cleared (env fallback)");

    console.log("\nplatform-check PASS");
  } finally {
    // Restore whatever was stored before the check ran.
    for (const [key, prior] of [
      [PLAN_CONFIG_SECRET_KEY, priorPlans],
      [AI_SECRET_KEY, priorAi],
    ] as const) {
      if (prior) {
        await db.appSecret.upsert({ where: { key }, create: { key, value: prior.value }, update: { value: prior.value } });
      } else {
        await db.appSecret.deleteMany({ where: { key } });
      }
    }
    await loadPlanConfig();
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
