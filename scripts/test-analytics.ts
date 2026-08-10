/* Analytics rollup + reports acceptance test (spec 14, criteria 1–5).
 * Run with the dev DB up:  npx tsx scripts/test-analytics.ts
 *
 * Seeds a throwaway shop with deterministic conversations / messages / events
 * across 3 UTC days (plus an isTest conversation that must be excluded
 * everywhere), rolls the days up, and asserts exact counter values, the
 * Human/AI series split, donut percentages summing to 100, CSAT math, the
 * recommendation funnel, first-response/resolution averages from message
 * timestamps, rollup idempotency, top questions, and CSV exports. Cleans up
 * after itself.
 */

export {}; // module scope — avoids global-script name collisions with sibling test scripts

const TEST_DOMAIN = "analytics-fixture-test.myshopify.com";

let failures = 0;
function check(name: string, condition: boolean, detail?: string) {
  const mark = condition ? "✔" : "✘";
  console.log(`  ${mark} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures += 1;
}

const DAY_MS = 24 * 60 * 60 * 1000;

async function main() {
  const { default: db } = await import("../app/db.server");
  const { rollupDay, utcDay } = await import("../app/lib/analytics/rollup.server");
  const {
    conversationSeries,
    resolutionBreakdown,
    csatSummary,
    recommendationFunnel,
    responsePerformance,
    topQuestions,
    exportConversationsCsv,
    exportAnalyticsCsv,
  } = await import("../app/lib/analytics/reports.server");

  async function cleanup(shopId: string) {
    await db.message.deleteMany({ where: { shopId } });
    await db.conversation.deleteMany({ where: { shopId } });
    await db.analyticsEvent.deleteMany({ where: { shopId } });
    await db.metricsDaily.deleteMany({ where: { shopId } });
    await db.shop.delete({ where: { id: shopId } });
  }

  const stale = await db.shop.findUnique({ where: { domain: TEST_DOMAIN } });
  if (stale) await cleanup(stale.id);
  const shop = await db.shop.create({ data: { domain: TEST_DOMAIN } });
  const shopId = shop.id;
  console.log(`test shop ${TEST_DOMAIN} (${shopId})`);

  const today = utcDay(new Date());
  const dayA = new Date(today.getTime() - 2 * DAY_MS);
  const dayB = new Date(today.getTime() - 1 * DAY_MS);
  const at = (day: Date, h: number, m: number, s: number) =>
    new Date(day.getTime() + ((h * 60 + m) * 60 + s) * 1000);

  async function convo(data: {
    started: Date;
    ended?: Date;
    status?: string;
    mode?: string;
    handover?: boolean;
    rating?: number;
    isTest?: boolean;
    messages: { at: Date; role: "in" | "out"; content: string; sourceLayer?: string }[];
  }) {
    const row = await db.conversation.create({
      data: {
        shopId,
        sessionId: `sess-${Math.random().toString(36).slice(2)}`,
        status: data.status ?? "open",
        mode: data.mode ?? "ai",
        handover: data.handover ?? false,
        rating: data.rating ?? null,
        isTest: data.isTest ?? false,
        startedAt: data.started,
        endedAt: data.ended ?? null,
        lastMessageAt: data.messages[data.messages.length - 1]?.at ?? data.started,
      },
    });
    for (const m of data.messages) {
      await db.message.create({
        data: {
          shopId,
          conversationId: row.id,
          role: m.role,
          author: m.role === "in" ? "shopper" : "ai",
          content: m.content,
          sourceLayer: m.sourceLayer ?? null,
          createdAt: m.at,
        },
      });
    }
    return row;
  }

  // ── Fixtures ──────────────────────────────────────────────────────────────
  // Day A: 3 real conversations (1 curated-resolved by AI, 1 handover resolved
  // by human w/ recommendation, 1 unresolved fallback) + 1 isTest conversation
  // + 2 added_to_cart events.
  const a1 = await convo({
    started: at(dayA, 10, 0, 0),
    ended: at(dayA, 10, 5, 0), // 300 000 ms resolution
    status: "resolved",
    rating: 5,
    messages: [
      { at: at(dayA, 10, 0, 0), role: "in", content: "What is your return policy?" },
      { at: at(dayA, 10, 0, 4), role: "out", content: "30 days.", sourceLayer: "curated" }, // 4 000 ms first response
    ],
  });
  await convo({
    started: at(dayA, 11, 0, 0),
    ended: at(dayA, 11, 10, 0), // 600 000 ms resolution
    status: "resolved",
    mode: "human",
    handover: true,
    rating: 4,
    messages: [
      { at: at(dayA, 11, 0, 0), role: "in", content: "Help me find a gift" },
      { at: at(dayA, 11, 0, 6), role: "out", content: "Try these:", sourceLayer: "buy" }, // 6 000 ms
      { at: at(dayA, 11, 1, 0), role: "out", content: "Connecting you…", sourceLayer: "handover" },
    ],
  });
  await convo({
    started: at(dayA, 12, 0, 0),
    messages: [
      { at: at(dayA, 12, 0, 0), role: "in", content: "help me find a GIFT!!" },
      { at: at(dayA, 12, 0, 10), role: "out", content: "Could you clarify?", sourceLayer: "clarify" }, // 10 000 ms, fallback
    ],
  });
  await convo({
    started: at(dayA, 13, 0, 0),
    isTest: true,
    rating: 1, // must NOT appear in CSAT
    messages: [
      { at: at(dayA, 13, 0, 0), role: "in", content: "TEST ONLY QUESTION" },
      { at: at(dayA, 13, 0, 1), role: "out", content: "test", sourceLayer: "curated" },
    ],
  });
  for (let i = 0; i < 2; i++) {
    await db.analyticsEvent.create({
      data: { shopId, type: "added_to_cart", payload: {}, occurredAt: at(dayA, 13, 30, i) },
    });
  }

  // Day B: 1 resolved-by-AI + 1 unresolved RAG fallback.
  await convo({
    started: at(dayB, 9, 0, 0),
    ended: at(dayB, 9, 3, 0), // 180 000 ms
    status: "resolved",
    rating: 3,
    messages: [
      { at: at(dayB, 9, 0, 0), role: "in", content: "Where is my order?" },
      { at: at(dayB, 9, 0, 2), role: "out", content: "It ships Monday.", sourceLayer: "question" }, // 2 000 ms
    ],
  });
  await convo({
    started: at(dayB, 10, 0, 0),
    messages: [
      { at: at(dayB, 10, 0, 0), role: "in", content: "Do you ship internationally?" },
      { at: at(dayB, 10, 0, 8), role: "out", content: "I'm not sure.", sourceLayer: "rag_fallback" }, // 8 000 ms, fallback
      { at: at(dayB, 10, 5, 0), role: "in", content: "How long does delivery take?" }, // 5th distinct top question
    ],
  });

  // Day C (today): 1 open conversation + 1 ATC event.
  await convo({
    started: at(today, 0, 5, 0),
    messages: [
      { at: at(today, 0, 5, 0), role: "in", content: "What is your return policy" },
      { at: at(today, 0, 5, 3), role: "out", content: "30 days.", sourceLayer: "chat" }, // 3 000 ms
    ],
  });
  await db.analyticsEvent.create({
    data: { shopId, type: "added_to_cart", payload: {}, occurredAt: at(today, 0, 30, 0) },
  });

  // ── 1. rollupDay exact counters (criteria 1, 2, 3 + isTest exclusion) ─────
  console.log("\n1. rollupDay(day A) exact counters");
  const cA = await rollupDay(shopId, dayA);
  const expectA = {
    conversations: 3,
    aiConversations: 2,
    humanConversations: 1,
    resolvedByAi: 1,
    resolvedByHuman: 1,
    unresolved: 1,
    turns: 3, // isTest turn excluded
    curatedServed: 1, // isTest curated reply excluded
    recommendationsShown: 1,
    atc: 2,
    fellBack: 1,
    handovers: 1,
    avgFirstResponseMs: Math.round((4000 + 6000 + 10000) / 3), // 6667
    firstResponseCount: 3,
    avgResolutionMs: (300000 + 600000) / 2, // 450 000
    resolutionCount: 2,
    answeredFirstTry: 2,
  };
  for (const [key, expected] of Object.entries(expectA)) {
    const actual = (cA as unknown as Record<string, unknown>)[key];
    check(`${key} = ${expected}`, actual === expected, `got ${actual}`);
  }

  console.log("\n   rollupDay(day B) spot checks");
  const cB = await rollupDay(shopId, dayB);
  check("conversations = 2", cB.conversations === 2, `got ${cB.conversations}`);
  check("fellBack = 1", cB.fellBack === 1, `got ${cB.fellBack}`);
  check("avgFirstResponseMs = 5000", cB.avgFirstResponseMs === 5000, `got ${cB.avgFirstResponseMs}`);
  check("avgResolutionMs = 180000", cB.avgResolutionMs === 180000, `got ${cB.avgResolutionMs}`);
  check("answeredFirstTry = 1", cB.answeredFirstTry === 1, `got ${cB.answeredFirstTry}`);

  // ── 2. Idempotency (criterion 4) ──────────────────────────────────────────
  console.log("\n2. rollup idempotency (re-run same day → same numbers, one row)");
  const cA2 = await rollupDay(shopId, dayA);
  check("re-run counters identical", JSON.stringify(cA) === JSON.stringify(cA2));
  const rowsA = await db.metricsDaily.findMany({ where: { shopId, date: dayA } });
  check("single MetricsDaily row for the day", rowsA.length === 1, `got ${rowsA.length}`);
  // jsonb does not preserve key order — compare with sorted keys.
  const canon = (value: unknown) =>
    JSON.stringify(
      Object.fromEntries(
        Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
      ),
    );
  check("stored counters match computed", canon(rowsA[0]?.counters) === canon(cA2));

  // ── 3. conversationSeries (criteria 1, 2, 4 — today live) ────────────────
  console.log("\n3. conversationSeries(7d): buckets, split, gap fill, live today");
  const series = await conversationSeries(shopId, "7d");
  check("7 daily buckets", series.length === 7, `got ${series.length}`);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const pointA = series.find((p) => p.date === iso(dayA));
  const pointB = series.find((p) => p.date === iso(dayB));
  const pointC = series.find((p) => p.date === iso(today));
  check("day A split ai=2 human=1", pointA?.ai === 2 && pointA?.human === 1, JSON.stringify(pointA));
  check("day B split ai=2 human=0", pointB?.ai === 2 && pointB?.human === 0, JSON.stringify(pointB));
  check("today computed live ai=1", pointC?.ai === 1 && pointC?.human === 0, JSON.stringify(pointC));
  const zeros = series.filter((p) => ![iso(dayA), iso(dayB), iso(today)].includes(p.date));
  check(
    "empty days filled with 0",
    zeros.length === 4 && zeros.every((p) => p.ai === 0 && p.human === 0),
  );

  // ── 4. resolutionBreakdown (criterion 2 — donut sums 100) ────────────────
  console.log("\n4. resolutionBreakdown(7d)");
  const donut = await resolutionBreakdown(shopId, "7d");
  // Totals: 6 conversations → resolvedByAi 2 (33.33%), resolvedByHuman 1 (16.67%), unresolved 3 (50%).
  check("resolvedByAiPct = 33", donut.resolvedByAiPct === 33, `got ${donut.resolvedByAiPct}`);
  check("resolvedByHumanPct = 17", donut.resolvedByHumanPct === 17, `got ${donut.resolvedByHumanPct}`);
  check("unresolvedPct = 50", donut.unresolvedPct === 50, `got ${donut.unresolvedPct}`);
  check(
    "segments sum to exactly 100",
    donut.resolvedByAiPct + donut.resolvedByHumanPct + donut.unresolvedPct === 100,
  );
  check("center resolvedPct = 50", donut.resolvedPct === 50, `got ${donut.resolvedPct}`);

  // ── 5. CSAT (criterion 1; isTest rating excluded) ────────────────────────
  console.log("\n5. csatSummary");
  const csat = await csatSummary(shopId);
  check("avg = 4.0 (ratings 5,4,3)", csat.avg === 4, `got ${csat.avg}`);
  check("responses = 3 (isTest rating excluded)", csat.responses === 3, `got ${csat.responses}`);
  check(
    "histogram 5★→1★ = [1,1,1,0,0]",
    JSON.stringify(csat.histogram) === JSON.stringify([1, 1, 1, 0, 0]),
    JSON.stringify(csat.histogram),
  );

  // ── 6. Recommendation funnel (criterion 1) ───────────────────────────────
  console.log("\n6. recommendationFunnel(7d)");
  const funnel = await recommendationFunnel(shopId, "7d");
  check("shown = 1", funnel.shown === 1, `got ${funnel.shown}`);
  check("atc = 3", funnel.atc === 3, `got ${funnel.atc}`);
  check("purchased deferred (null → '—')", funnel.purchased === null);

  // ── 7. Response performance (criterion 3 — timestamp math) ───────────────
  console.log("\n7. responsePerformance(7d)");
  const perf = await responsePerformance(shopId, "7d");
  // Weighted first response: (6667×3 + 5000×2 + 3000×1) / 6 = 5500 ms.
  check("avgFirstResponseMs = 5500", perf.avgFirstResponseMs === 5500, `got ${perf.avgFirstResponseMs}`);
  // Weighted resolution: (450000×2 + 180000×1) / 3 = 360 000 ms.
  check("avgResolutionMs = 360000", perf.avgResolutionMs === 360000, `got ${perf.avgResolutionMs}`);
  check("answeredFirstTryPct = 67 (4/6)", perf.answeredFirstTryPct === 67, `got ${perf.answeredFirstTryPct}`);
  check("handedToHuman = 1", perf.handedToHuman === 1, `got ${perf.handedToHuman}`);

  // ── 8. Top questions (normalized grouping; isTest excluded) ──────────────
  console.log("\n8. topQuestions");
  const top = await topQuestions(shopId);
  check("5 distinct questions", top.length === 5, `got ${top.length}`);
  const counts = top.map((q) => q.count);
  check("grouped counts [2,2,1,1,1]", JSON.stringify(counts) === JSON.stringify([2, 2, 1, 1, 1]), JSON.stringify(counts));
  check("top entry bar = 100%", top[0]?.pct === 100, `got ${top[0]?.pct}`);
  const giftGroup = top.find((q) => q.question.toLowerCase().includes("gift"));
  check("'help me find a gift' variants merged", giftGroup?.count === 2, JSON.stringify(giftGroup));
  check(
    "isTest question excluded",
    !top.some((q) => q.question.includes("TEST ONLY")),
  );

  // ── 9. CSV exports (criterion 5; gate coded server-side) ─────────────────
  console.log("\n9. exports");
  const convCsv = await exportConversationsCsv(shopId);
  const convLines = convCsv.trim().split("\n");
  check(
    "conversations CSV header",
    convLines[0] === "id,startedAt,status,mode,outcome,rating,messages",
    convLines[0],
  );
  check("6 conversation rows (isTest excluded)", convLines.length === 7, `got ${convLines.length - 1}`);
  const a1Line = convLines.find((l) => l.startsWith(a1.id));
  check(
    "row a1: resolved, ai, rating 5, 2 messages",
    a1Line !== undefined &&
      a1Line.includes(",resolved,ai,") &&
      a1Line.endsWith(",5,2"),
    a1Line,
  );

  const analyticsCsv = await exportAnalyticsCsv(shopId, "7d");
  const aLines = analyticsCsv.trim().split("\n");
  check("analytics CSV = header + 7 day rows", aLines.length === 8, `got ${aLines.length}`);
  const dayARow = aLines.find((l) => l.startsWith(iso(dayA)));
  check(
    "day A row carries the counters",
    dayARow !== undefined && dayARow.includes(",3,2,1,1,1,1,3,1,1,2,1,1,"),
    dayARow,
  );
  // Plan gate: exportConversationsCsv/exportAnalyticsCsv call requirePlan(plan,
  // "exports") via requireExports() — open enforcement passes (asserted by the
  // calls above succeeding on a free shop); when ENFORCEMENT flips to
  // "enforced" the same call throws PlanGateError (route action maps it to the
  // locked response). Condition verified by code path, mode is a build-time const.
  const { hasFeature, planEnforcementMode } = await import("../app/lib/billing/plans.server");
  check(
    "open mode: hasFeature(free, exports) passes",
    planEnforcementMode() === "open" && hasFeature("free", "exports"),
  );

  // ── Cleanup ───────────────────────────────────────────────────────────────
  await cleanup(shopId);
  const gone = await db.shop.findUnique({ where: { domain: TEST_DOMAIN } });
  console.log(`\ncleanup: ${gone === null ? "done" : "FAILED"}`);
  if (gone !== null) failures += 1;

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
