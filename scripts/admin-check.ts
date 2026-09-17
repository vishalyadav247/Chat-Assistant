/* Admin settings round-trip check (spec 19 acceptance #3–#6).
 *   npx tsx scripts/admin-check.ts
 * Verifies: plan overrides apply to PLANS/gates in-process and persist to
 * app_secrets; enforcement switch works; reset restores code defaults; AI
 * overrides save/clear. Leaves the DB exactly as it found it.
 */
import db from "../app/db.server";
import { GATED_FEATURES, QUOTA_DIMENSIONS } from "../app/lib/billing/plan-shared";
import {
  DEFAULT_PLANS,
  getQuota,
  hasFeature,
  loadPlanConfig,
  PLAN_CONFIG_SECRET_KEY,
  PLANS,
} from "../app/lib/billing/plans.server";
import {
  AI_SECRET_KEY,
  getAiOverrides,
  resetPlanConfig,
  saveAiOverrides,
  savePlanConfig,
} from "../app/lib/admin/admin-settings.server";

function assert(cond: boolean, label: string) {
  if (!cond) throw new Error(`FAIL: ${label}`);
  console.log(`ok: ${label}`);
}

async function main() {
  const priorPlans = await db.appSecret.findUnique({ where: { key: PLAN_CONFIG_SECRET_KEY } });
  const priorAi = await db.appSecret.findUnique({ where: { key: AI_SECRET_KEY } });

  try {
    // 1. Plan override cycle
    // `knownFeatures` is what the operator could actually see when they saved, and
    // the real /admin/plans form always submits the full GATED_FEATURES list.
    // Without it, an unchecked feature is treated as "added after this save" and
    // correctly falls back to the plan default instead of being gated off — so
    // omitting it here would assert pre-knownFeatures semantics that no longer exist.
    await savePlanConfig({
      
      plans: { basic: { quotas: { conversations: 123 }, features: ["inbox_cart_view"], knownFeatures: [...GATED_FEATURES] } },
    });
    assert(PLANS.basic.quotas.conversations === 123, "PLANS.basic quota overridden in place");
    assert(getQuota("basic", "conversations") === 123, "getQuota reads override under enforcement");
    assert(hasFeature("basic", "inbox_cart_view") === true, "overridden feature list grants inbox_cart_view");
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
    assert(
      JSON.stringify(PLANS) === JSON.stringify(DEFAULT_PLANS),
      "reset restores the full default matrix",
    );

    // 3b. The stored matrix is the one every gate reads.
    // There used to be a second half here asserting an "open" enforcement mode
    // (unlimited quotas, every feature granted). That global switch was removed
    // — gating is now always on — and the refactor emptied its `savePlanConfig`
    // argument without deleting the assertions, leaving two identical calls of
    // which the second could only ever fail. Removed 2026-09-10.
    await savePlanConfig({});
    assert(
      getQuota("basic", "conversations") === DEFAULT_PLANS.basic.quotas.conversations,
      "the real matrix quotas are what getQuota returns",
    );
    assert(hasFeature("free", "remove_branding") === false, "a Free shop is gated");
    await resetPlanConfig();

    // 3c. The seams added 2026-08-21 must be present and enforced.
    assert(
      getQuota("free", "active_campaigns") === DEFAULT_PLANS.free.quotas.active_campaigns &&
        getQuota("pro", "active_campaigns") === DEFAULT_PLANS.pro.quotas.active_campaigns,
      "active_campaigns quota enforced per tier",
    );
    assert(
      getQuota("free", "analytics_range_days") === 7 && getQuota("plus", "analytics_range_days") === 365,
      "analytics_range_days quota enforced per tier",
    );
    for (const [feature, freeHas, plusHas] of [
      ["push_notifications", true, true], // on Free since the 2026-09-11 re-baseline
      ["remove_branding", false, true],
      ["order_tracking", false, true],
    ] as const) {
      assert(
        hasFeature("free", feature) === freeHas && hasFeature("plus", feature) === plusHas,
        `gate ${feature} follows the matrix`,
      );
    }
    // "exports" + "file_upload" un-gated 2026-09-10 (user decision) — the
    // identifiers must be gone so no operator edit can re-gate them.
    assert(
      !(GATED_FEATURES as string[]).includes("exports") &&
        !(GATED_FEATURES as string[]).includes("file_upload"),
      "exports + file_upload are no longer gated features",
    );
    assert(hasFeature("basic", "inbox_cart_view") === false, "inbox_cart_view is Pro+");
    assert(
      !(GATED_FEATURES as string[]).includes("survey"),
      "survey is on every plan — no longer a gated feature (2026-09-11)",
    );
    assert(
      !(QUOTA_DIMENSIONS as string[]).includes("cross_sell_pairs"),
      "cross_sell_pairs is no longer a quota — pairs have no limit (2026-09-11)",
    );

    // 4. AI overrides save + clear
    await saveAiOverrides({ chatModel: "gpt-4o", temperature: 0.7, maxTokens: 500 });
    const ai = await getAiOverrides();
    assert(ai.chatModel === "gpt-4o" && ai.temperature === 0.7 && ai.maxTokens === 500, "AI overrides saved");
    await saveAiOverrides({ chatModel: "", temperature: null, maxTokens: null });
    const cleared = await getAiOverrides();
    assert(cleared.chatModel === "" && cleared.temperature === null, "AI overrides cleared (env fallback)");

    console.log("\nadmin-check PASS");
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
