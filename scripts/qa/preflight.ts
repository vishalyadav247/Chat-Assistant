/* Preflight: is the shared dev environment in a state where a QA run can be
 * believed?
 *
 *   npm run qa:preflight
 *
 * Several suites deliberately mutate GLOBAL state — the golden eval parks the
 * `[qa-fixture]` curated answers, overage.test.ts rewrites `admin:plans`,
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

  // ── 1. Curated fixtures parked by an interrupted golden eval ──────────────
  const parked = await db.curatedAnswer.count({
    where: { talkingPoints: { contains: "[qa-fixture]" }, status: "draft" },
  });
  if (parked > 0 && FIX) {
    await db.curatedAnswer.updateMany({
      where: { talkingPoints: { contains: "[qa-fixture]" }, status: "draft" },
      data: { status: "published" },
    });
  }
  report(
    "[qa-fixture] curated answers are published",
    parked === 0,
    `${parked} still parked as draft`,
    parked > 0 && FIX ? `republished ${parked}` : undefined,
  );

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
