/* Preflight: is the shared dev environment in a state where a QA run can be
 * believed?
 *
 *   npm run qa:preflight
 *
 * Several suites deliberately mutate GLOBAL state — the golden eval parks the
 * QA-fixture curated answers, overage.test.ts rewrites `admin:plans`,
 * model-portability writes AI overrides — and each restores it in a `finally`.
 * A `finally` does not run when the process is killed, so an interrupted run
 * leaves the environment altered and the NEXT run fails for reasons that have
 * nothing to do with the code. That has happened twice:
 *
 *   · 14 curated answers left `draft` → storefront.test.ts failed three curated
 *     cases against a shop with no published curated answers.
 *
 * Run this before a campaign and after any interrupted suite. `--fix` puts
 * everything back; without it the script only reports (exit 1 if anything is
 * off), so it is safe to run against an environment someone else is using.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

for (const line of readFileSync(join(process.cwd(), ".env"), "utf-8").split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (match && !line.trim().startsWith("#") && process.env[match[1]] === undefined) {
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}

const FIX = process.argv.includes("--fix");
let dirty = 0;

function report(name: string, clean: boolean, detail: string, fixed?: string): void {
  if (clean) {
    console.log(`  OK    ${name}${detail ? ` — ${detail}` : ""}`);
    return;
  }
  dirty++;
  console.log(`  DIRTY ${name} — ${detail}${fixed ? `\n        fixed: ${fixed}` : ""}`);
}

async function main(): Promise<void> {
  const db = (await import("../../app/db.server")).default;

  // ── 1. Curated fixtures in their INTENDED state (QA-T3) ───────────────────
  // Identified by question on the dev shop. The old check republished every
  // tagged draft — including the draft-on-purpose "black friday" fixture,
  // which is how a reply saying "Draft answer, should not be served" went live.
  const {
    DEV_SHOP_DOMAIN,
    PUBLISHED_FIXTURE_QUESTIONS,
    DRAFT_FIXTURE_QUESTIONS,
    LEGACY_FIXTURE_TAG,
    stripLegacyTag,
  } = await import("./curated-fixtures");
  const devShop = await db.shop.findUnique({ where: { domain: DEV_SHOP_DOMAIN }, select: { id: true } });
  if (devShop) {
    const shopId = devShop.id;
    const parkedWhere = { shopId, question: { in: PUBLISHED_FIXTURE_QUESTIONS }, status: "draft" };
    const leakedDraftWhere = { shopId, question: { in: DRAFT_FIXTURE_QUESTIONS }, status: "published" };
    const [parked, leakedDrafts] = await Promise.all([
      db.curatedAnswer.count({ where: parkedWhere }),
      db.curatedAnswer.count({ where: leakedDraftWhere }),
    ]);
    if (FIX) {
      if (parked > 0) await db.curatedAnswer.updateMany({ where: parkedWhere, data: { status: "published" } });
      if (leakedDrafts > 0) await db.curatedAnswer.updateMany({ where: leakedDraftWhere, data: { status: "draft" } });
    }
    report(
      "curated fixtures are in their intended draft / published state",
      parked === 0 && leakedDrafts === 0,
      `${parked} parked as draft by an interrupted golden run, ${leakedDrafts} draft-on-purpose fixture(s) published`,
      FIX && (parked > 0 || leakedDrafts > 0) ? `republished ${parked}, unpublished ${leakedDrafts}` : undefined,
    );

    // ── 1b. No fixture marker / "draft" wording in shopper-visible text ─────
    // Curated talking points are served verbatim; FAQ answers are shown in the
    // widget. Anything published must read like a real store answer.
    const [curatedLeaks, faqLeaks] = await Promise.all([
      db.curatedAnswer.findMany({
        where: {
          shopId,
          status: "published",
          OR: [
            { talkingPoints: { contains: LEGACY_FIXTURE_TAG } },
            { talkingPoints: { contains: "should not be served", mode: "insensitive" } },
            { talkingPoints: { contains: "draft answer", mode: "insensitive" } },
          ],
        },
        select: { id: true, question: true, talkingPoints: true },
      }),
      db.faq.findMany({
        where: {
          shopId,
          status: "published",
          OR: [
            { answerHtml: { contains: LEGACY_FIXTURE_TAG } },
            { question: { contains: LEGACY_FIXTURE_TAG } },
            { answerHtml: { contains: "should not be served", mode: "insensitive" } },
          ],
        },
        select: { id: true, question: true },
      }),
    ]);
    const markerRows = curatedLeaks.filter((row) => row.talkingPoints.includes(LEGACY_FIXTURE_TAG));
    if (FIX) {
      for (const row of markerRows) {
        await db.curatedAnswer.update({
          where: { id: row.id, shopId },
          data: { talkingPoints: stripLegacyTag(row.talkingPoints) },
        });
      }
    }
    report(
      "no QA-fixture marker or draft wording in published shopper-visible text",
      curatedLeaks.length === 0 && faqLeaks.length === 0,
      [
        ...curatedLeaks.map((row) => `curated "${row.question}"`),
        ...faqLeaks.map((row) => `FAQ "${row.question}"`),
      ].join(", "),
      FIX && markerRows.length > 0
        ? `stripped the marker from ${markerRows.length} curated answer(s); anything else needs a manual edit`
        : undefined,
    );
  } else {
    console.log(`  NOTE  ${DEV_SHOP_DOMAIN} not seeded — fixture checks skipped`);
  }

  // ── 2. Plan config left mid-test ─────────────────────────────────────────
  // The `enforcement` switch was REMOVED on 2026-09-08, so a stored value is
  // now inert — but a row carrying one means an old suite (or an old build)
  // touched this environment, and the quota overrides beside it are the ones
  // that still bite. Flag it, and strip it under --fix.
  const planRow = await db.appSecret.findUnique({ where: { key: "admin:plans" } });
  const planConfig = planRow ? (JSON.parse(planRow.value) as Record<string, unknown>) : {};
  const planProblems: string[] = [];
  if (planConfig.enforcement !== undefined) {
    planProblems.push(`stale enforcement: ${JSON.stringify(planConfig.enforcement)} (the switch no longer exists)`);
  }
  // Deliberately NOT flagging `plans` overrides: those are legitimate operator
  // edits, not test residue, and nagging about them would train people to
  // ignore this report.
  if (planProblems.length > 0 && FIX && planRow) {
    const { enforcement: _e, ...rest } = planConfig;
    await db.appSecret.update({ where: { key: "admin:plans" }, data: { value: JSON.stringify(rest) } });
  }
  report(
    "admin:plans carries no leftover test overrides",
    planProblems.length === 0,
    planProblems.join(", "),
    planProblems.length > 0 && FIX ? "removed both fields (back to the code defaults)" : undefined,
  );

  // ── 3. AI overrides left mid-test ────────────────────────────────────────
  // model-portability sets temperature 1.9 to prove strict-JSON routing
  // survives it; left behind, it de-tunes the router for every tenant.
  const aiRow = await db.appSecret.findUnique({ where: { key: "platform:ai" } });
  const ai = aiRow ? (JSON.parse(aiRow.value) as Record<string, unknown>) : {};
  const aiDirty = ai.temperature != null || ai.maxTokens != null;
  if (aiDirty && FIX && aiRow) {
    await db.appSecret.update({
      where: { key: "platform:ai" },
      data: { value: JSON.stringify({ ...ai, temperature: null, maxTokens: null }) },
    });
  }
  report(
    "platform:ai has no global temperature / maxTokens override",
    !aiDirty,
    `temperature=${JSON.stringify(ai.temperature)} maxTokens=${JSON.stringify(ai.maxTokens)}`,
    aiDirty && FIX ? "cleared both" : undefined,
  );

  // ── 4. Throwaway shops a killed suite never removed ───────────────────────
  const strays = await db.shop.findMany({
    where: {
      OR: [
        { domain: { startsWith: "qa-" } },
        { domain: { startsWith: "perf-test" } },
        { domain: { endsWith: ".invalid" } },
      ],
    },
    select: { domain: true },
  });
  report(
    "no throwaway QA shops left behind",
    strays.length === 0,
    strays.map((s) => s.domain).join(", "),
  );
  // Never deleted here even under --fix: a suite may still be running against
  // them, and each suite already removes its own in a `finally`.
  if (strays.length > 0) {
    console.log(
      "        not auto-removed — run the owning suite's cleanup (e.g. scripts/qa/perf-seed.ts --clean)",
    );
  }

  // ── 5. Live plan matrix vs the shipped defaults (report only) ─────────────
  // NOT a dirty state: an operator is entitled to grant a tier extra features
  // or change a quota at /admin/plans, and those edits are the product working.
  // But every plan-gate assertion means something different once they exist —
  // storefront.test.ts asserted a flat 403 for `survey` on Free and failed for
  // a whole run because Free had legitimately been granted it. So it is printed
  // rather than fixed: read it before believing any gate result.
  const { DEFAULT_PLANS, PLANS, loadPlanConfig } = await import("../../app/lib/billing/plans.server");
  await loadPlanConfig();
  const divergences: string[] = [];
  for (const id of Object.keys(DEFAULT_PLANS) as (keyof typeof DEFAULT_PLANS)[]) {
    const live = PLANS[id];
    const base = DEFAULT_PLANS[id];
    const added = live.features.filter((f) => !base.features.includes(f));
    const removed = base.features.filter((f) => !live.features.includes(f));
    if (added.length > 0) divergences.push(`${id}: +${added.join(", +")}`);
    if (removed.length > 0) divergences.push(`${id}: -${removed.join(", -")}`);
    for (const dim of Object.keys(base.quotas) as (keyof typeof base.quotas)[]) {
      if (live.quotas[dim] !== base.quotas[dim]) {
        divergences.push(`${id}.${dim}: ${base.quotas[dim]} → ${live.quotas[dim]}`);
      }
    }
  }
  if (divergences.length === 0) {
    console.log("  OK    live plan matrix matches the shipped defaults");
  } else {
    console.log(`  NOTE  live plan matrix differs from the defaults in ${divergences.length} place(s):`);
    for (const d of divergences) console.log(`          ${d}`);
    console.log("        Deliberate operator edits are fine — but a plan-gate result");
    console.log("        only means what it says once you have read this list.");
  }

  console.log(
    dirty === 0
      ? "\nPREFLIGHT CLEAN — suite results can be believed"
      : `\n${dirty} thing(s) dirty${FIX ? " (fixed where safe — re-run to confirm)" : " — re-run with --fix"}`,
  );
  await db.$disconnect();
  process.exitCode = dirty === 0 || FIX ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
