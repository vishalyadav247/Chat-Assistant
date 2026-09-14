/* Multi-turn conversation eval (area AB) — measures the agent on REAL shopper
 * conversations, turn by turn, with pass RATES rather than one-off pass/fail.
 *
 *   npm run eval:conversations
 *   npm run eval:conversations -- --runs 3
 *   npm run eval:conversations -- --case evil-eye-followups --no-judge
 *   npm run eval:conversations -- --compare scripts/qa/results/conversations-<stamp>.json
 *
 * Flags: --shop <domain> (default jgw-check.myshopify.com) · --runs N (default 1)
 *        --case <id> · --no-judge · --judge-model <id> (default gpt-4.1)
 *        --compare <results.json> · --verbose (print every turn's reply)
 *
 * Why this exists: single test chats hid the real problem. A conversation fails
 * on turn 5 because of what turn 2 decided, and a model that answers correctly
 * one run in three passes a single check. Each run replays whole conversations
 * (scripts/qa/conversation-cases.ts) through the real pipeline as isTest turns
 * (no usage meter, no inbox, no unresolved queue), asserts what the SHOPPER sees
 * (cards, reply, handover — never internal lane names, so a pipeline redesign
 * is measured by the same cases), and optionally asks an LLM judge a
 * plain-English rubric per turn. Results are written to scripts/qa/results/
 * (git-ignored) so the next change can be compared against this baseline.
 *
 * The judge calls the OpenAI REST API directly: it must not record tokens
 * against the merchant's usage rows, and app code is the only place the openai
 * SDK is imported.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { CONVERSATION_CASES, type ConversationCase, type TurnExpect } from "./conversation-cases";

try {
  process.loadEnvFile(".env");
} catch {
  // no .env — use the ambient environment
}

const prisma = new PrismaClient();

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const SHOP_DOMAIN = flag("shop") ?? "jgw-check.myshopify.com";
const RUNS = Math.max(1, Number(flag("runs") ?? 1));
const ONLY_CASE = flag("case");
const USE_JUDGE = !process.argv.includes("--no-judge");
const JUDGE_MODEL = flag("judge-model") ?? "gpt-4.1";
const COMPARE = flag("compare");
const VERBOSE = process.argv.includes("--verbose");

const FALLBACK_RE = /I'm not sure about that one|couldn't find a match/i;

interface TurnResult {
  shopper: string;
  reply: string;
  cards: string[];
  outcome: string;
  handover: boolean;
  /** Router/lane decisions from the trace, for debugging a failure. */
  decisions: Record<string, unknown>;
  failures: string[];
  judge?: { pass: boolean; reason: string };
}

interface CaseRun {
  caseId: string;
  run: number;
  turns: TurnResult[];
}

// ── One turn through the real pipeline ─────────────────────────────────────
async function runTurn(
  shopId: string,
  sessionId: string,
  conversationId: string | undefined,
  message: string,
): Promise<Omit<TurnResult, "failures" | "judge"> & { conversationId: string }> {
  const { runPipeline } = await import("../../app/lib/pipeline/index.server");
  const { createTrace } = await import("../../app/lib/pipeline/trace.server");
  const trace = createTrace(true);
  let reply = "";
  let outcome = "";
  let handover = false;
  let convId = conversationId ?? "";
  const cards: string[] = [];
  for await (const frame of runPipeline({ shopId, sessionId, conversationId, message, isTest: true }, trace)) {
    if (frame.type === "token") reply += frame.text;
    else if (frame.type === "message") reply += (reply ? "\n" : "") + frame.text;
    else if (frame.type === "cards") cards.push(...frame.cards.map((c) => c.title));
    else if (frame.type === "handover") handover = true;
    else if (frame.type === "done") {
      outcome = frame.outcome;
      if (frame.conversationId) convId = frame.conversationId;
    }
  }
  const decisions: Record<string, unknown> = {};
  for (const step of trace.steps()) {
    if (step.layer === "router") decisions.router = step.detail;
    else if (["detail_confirm", "question_rescue", "rag_fallback", "guardrail_meaning", "curated_served", "recommendation_served", "model_picks", "detail_subject"].includes(step.layer)) {
      decisions[step.layer] = step.status;
    }
  }
  return { shopper: message, reply: reply.trim(), cards, outcome, handover, decisions, conversationId: convId };
}

// ── Mechanical checks ───────────────────────────────────────────────────────
function check(turn: Omit<TurnResult, "failures" | "judge">, expect: TurnExpect): string[] {
  const out: string[] = [];
  const cardList = `[${turn.cards.join(" | ") || "no cards"}]`;
  if (expect.cardsInclude && !turn.cards.some((c) => expect.cardsInclude!.test(c))) {
    out.push(`no card matched ${expect.cardsInclude} ${cardList}`);
  }
  if (expect.cardsOnly) {
    const stray = turn.cards.filter((c) => !expect.cardsOnly!.test(c));
    if (stray.length > 0) out.push(`cards outside ${expect.cardsOnly}: ${stray.join(" | ")}`);
  }
  if (expect.cardsExclude) {
    const bad = turn.cards.filter((c) => expect.cardsExclude!.test(c));
    if (bad.length > 0) out.push(`cards matched ${expect.cardsExclude}: ${bad.join(" | ")}`);
  }
  if (expect.noCards && turn.cards.length > 0) out.push(`expected no cards ${cardList}`);
  if (expect.replyIncludes && !expect.replyIncludes.test(turn.reply)) out.push(`reply lacks ${expect.replyIncludes}`);
  if (expect.replyExcludes && expect.replyExcludes.test(turn.reply)) out.push(`reply matched ${expect.replyExcludes}`);
  if (expect.notFallback && (["fell_back", "clarify"].includes(turn.outcome) || FALLBACK_RE.test(turn.reply))) {
    out.push(`dead end (${turn.outcome})`);
  }
  if (expect.notBlocked && turn.outcome === "blocked") out.push("refused as a banned topic");
  if (expect.noHandover && turn.handover) out.push("handover triggered");
  return out;
}

// ── LLM judge ───────────────────────────────────────────────────────────────
async function judgeTurn(history: TurnResult[], turn: Omit<TurnResult, "failures" | "judge">, rubric: string) {
  const transcript = history
    .map((t) => `Shopper: ${t.shopper}\nAssistant: ${t.reply}${t.cards.length ? `\n[cards shown: ${t.cards.join(" | ")}]` : ""}`)
    .join("\n\n");
  const body = {
    model: JUDGE_MODEL,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          'You grade one reply of an online store\'s sales assistant. Judge ONLY against the rubric, using the conversation for context. Facts stated in the rubric are ground truth; earlier assistant replies are NOT a source of facts (they may be wrong). Cards are product tiles shown under the reply. Return JSON: {"pass": true|false, "reason": "<one short sentence>"}.',
      },
      {
        role: "user",
        content: `Conversation so far:\n${transcript || "(this is the first message)"}\n\n--- Reply being graded ---\nShopper: ${turn.shopper}\nAssistant: ${turn.reply}\n[cards shown: ${turn.cards.join(" | ") || "none"}]\n\nRubric: ${rubric}`,
      },
    ],
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`judge HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const json = (await res.json()) as { choices: { message: { content: string } }[] };
      const parsed = JSON.parse(json.choices[0].message.content) as { pass?: unknown; reason?: unknown };
      return { pass: parsed.pass === true, reason: String(parsed.reason ?? "") };
    } catch (error) {
      if (attempt === 2) return { pass: false, reason: `judge unavailable: ${String(error).slice(0, 160)}` };
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  return { pass: false, reason: "judge unavailable" };
}

// ── One conversation ────────────────────────────────────────────────────────
async function runCase(shopId: string, testCase: ConversationCase, run: number): Promise<CaseRun> {
  const sessionId = `conv-eval-${testCase.id}-${run}-${Date.now().toString(36)}`;
  let conversationId: string | undefined;
  const turns: TurnResult[] = [];
  for (const spec of testCase.turns) {
    const raw = await runTurn(shopId, sessionId, conversationId, spec.shopper);
    conversationId = raw.conversationId || conversationId;
    const { conversationId: _ignored, ...turn } = raw;
    const failures = spec.expect ? check(turn, spec.expect) : [];
    const judge = USE_JUDGE && spec.expect?.judge ? await judgeTurn(turns, turn, spec.expect.judge) : undefined;
    if (judge && !judge.pass) failures.push(`judge: ${judge.reason}`);
    turns.push({ ...turn, failures, judge });
  }
  return { caseId: testCase.id, run, turns };
}

// ── Reporting ───────────────────────────────────────────────────────────────
type TurnKey = string;
const turnKey = (caseId: string, index: number) => `${caseId}#${index + 1}`;

function tally(runs: CaseRun[]) {
  const perTurn = new Map<TurnKey, { pass: number; total: number }>();
  for (const r of runs) {
    const testCase = CONVERSATION_CASES.find((c) => c.id === r.caseId)!;
    r.turns.forEach((t, i) => {
      if (!testCase.turns[i].expect) return; // unchecked setup turn
      const key = turnKey(r.caseId, i);
      const row = perTurn.get(key) ?? { pass: 0, total: 0 };
      row.total++;
      if (t.failures.length === 0) row.pass++;
      perTurn.set(key, row);
    });
  }
  return perTurn;
}

async function main(): Promise<number> {
  const shop = await prisma.shop.findUnique({ where: { domain: SHOP_DOMAIN } });
  if (!shop) throw new Error(`no shop ${SHOP_DOMAIN}`);
  if (!shop.aiEnabled) {
    console.log(`NOTE: the AI is switched OFF for ${SHOP_DOMAIN} — every turn would short-circuit. Turn it on first. Aborting.`);
    return -1;
  }
  const cases = CONVERSATION_CASES.filter((c) => !ONLY_CASE || c.id === ONLY_CASE);
  if (cases.length === 0) throw new Error(`no case "${ONLY_CASE}"`);
  console.log(
    `shop ${SHOP_DOMAIN} · ${cases.length} conversation(s) · ${RUNS} run(s) · judge ${USE_JUDGE ? JUDGE_MODEL : "off"}\n`,
  );

  const runs: CaseRun[] = [];
  for (let run = 1; run <= RUNS; run++) {
    for (const testCase of cases) {
      const result = await runCase(shop.id, testCase, run);
      runs.push(result);
      const checked = result.turns.filter((_, i) => testCase.turns[i].expect);
      const passed = checked.filter((t) => t.failures.length === 0).length;
      console.log(`${passed === checked.length ? "PASS" : "FAIL"}  [run ${run}] ${testCase.id} (${testCase.tag}) — ${passed}/${checked.length} turns`);
      result.turns.forEach((t, i) => {
        const expected = Boolean(testCase.turns[i].expect);
        if (!VERBOSE && (t.failures.length === 0 || !expected)) return;
        const mark = !expected ? "·" : t.failures.length === 0 ? "✓" : "✗";
        console.log(`   ${mark} ${i + 1}. "${t.shopper}" → ${t.outcome}`);
        console.log(`        reply: ${t.reply.replace(/\s+/g, " ").slice(0, 220)}`);
        if (t.cards.length) console.log(`        cards: ${t.cards.join(" | ")}`);
        for (const f of t.failures) console.log(`        ✗ ${f}`);
      });
    }
  }

  // Summary: pass rate per checked turn, then per tag and overall.
  const perTurn = tally(runs);
  console.log("\nTurn pass rates");
  for (const testCase of cases) {
    testCase.turns.forEach((turn, i) => {
      const row = perTurn.get(turnKey(testCase.id, i));
      if (!row) return;
      const pct = Math.round((row.pass / row.total) * 100);
      console.log(`  ${String(pct).padStart(3)}%  ${turnKey(testCase.id, i).padEnd(28)} "${turn.shopper.slice(0, 60)}"`);
    });
  }
  const byTag = new Map<string, { pass: number; total: number }>();
  for (const [key, row] of perTurn) {
    const tag = CONVERSATION_CASES.find((c) => c.id === key.split("#")[0])!.tag;
    const agg = byTag.get(tag) ?? { pass: 0, total: 0 };
    agg.pass += row.pass;
    agg.total += row.total;
    byTag.set(tag, agg);
  }
  let pass = 0;
  let total = 0;
  console.log("");
  for (const [tag, agg] of byTag) {
    console.log(`${tag.padEnd(9)} ${agg.pass}/${agg.total} turns (${Math.round((agg.pass / agg.total) * 100)}%)`);
    pass += agg.pass;
    total += agg.total;
  }
  const wholeCases = runs.filter((r) => r.turns.every((t) => t.failures.length === 0)).length;
  console.log(`overall   ${pass}/${total} turns (${Math.round((pass / total) * 100)}%) · ${wholeCases}/${runs.length} conversations fully correct`);

  // Persist for the next comparison.
  mkdirSync("scripts/qa/results", { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = `scripts/qa/results/conversations-${stamp}.json`;
  const turnRates = Object.fromEntries([...perTurn].map(([k, v]) => [k, v]));
  writeFileSync(
    outFile,
    JSON.stringify({ shop: SHOP_DOMAIN, runs: RUNS, judge: USE_JUDGE ? JUDGE_MODEL : null, at: new Date().toISOString(), summary: { pass, total }, turnRates, results: runs }, null, 2),
  );
  console.log(`\nresults → ${outFile}`);

  if (COMPARE) {
    const before = JSON.parse(readFileSync(COMPARE, "utf8")) as { turnRates: Record<string, { pass: number; total: number }>; summary: { pass: number; total: number } };
    console.log(`\nCompared with ${COMPARE}`);
    for (const [key, now] of perTurn) {
      const prev = before.turnRates[key];
      if (!prev) continue;
      const a = Math.round((prev.pass / prev.total) * 100);
      const b = Math.round((now.pass / now.total) * 100);
      if (a !== b) console.log(`  ${key.padEnd(28)} ${a}% → ${b}% ${b > a ? "▲" : "▼"}`);
    }
    const a = Math.round((before.summary.pass / before.summary.total) * 100);
    console.log(`  overall ${a}% → ${Math.round((pass / total) * 100)}%`);
  }
  return total - pass;
}

if (!process.env.OPENAI_API_KEY) {
  console.log("NOTE: no OPENAI_API_KEY — this suite measures real model output. Aborting.");
  process.exit(2);
}

main()
  .then((failures) => {
    process.exitCode = failures === -1 ? 2 : failures === 0 ? 0 : 1;
  })
  .catch((error) => {
    console.error("conversations eval crashed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    // runPipeline uses the app/db.server singleton; leaving it connected hangs the exit.
    const appDb = (await import("../../app/db.server")).default;
    await appDb.$disconnect().catch(() => undefined);
    process.exit();
  });
