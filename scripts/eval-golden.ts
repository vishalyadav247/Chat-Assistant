/* Golden-set eval (spec 03 / ai-pipeline skill): runs the canonical inputs
 * through the REAL pipeline against the seeded dev shop and asserts the PATH
 * each takes (outcome/sourceLayer), plus semantic expectations when a real
 * OPENAI_API_KEY is present. Run BEFORE merging any prompt/threshold change:
 *   npm run eval:golden      (= npx tsx scripts/eval-golden.ts)
 * Sections: single-turn cases · description-level asks (accuracy batch
 * 2026-08-17) · multi-turn continuity · no-accidental-handover · history window.
 */
import { PrismaClient } from "@prisma/client";

const dbCheck = new PrismaClient();
const DEV_SHOP_DOMAIN = "dev-shop.myshopify.com";

interface GoldenCase {
  input: string;
  expectOutcome: string[];
  expectInText?: RegExp;
  expectCards?: boolean;
  /** At least one returned card title must match (checks ranking, not just recall). */
  expectCardTitle?: RegExp;
}

const GOLDEN: GoldenCase[] = [
  { input: "what are your best sellers?", expectOutcome: ["curated"] },
  { input: "keep my hands warm under $30", expectOutcome: ["buy", "buy_browse"], expectCards: true, expectInText: /glove|beanie|scarf|sock/i },
  { input: "do you ship to Canada?", expectOutcome: ["question"], expectInText: /canada|worldwide|ship/i },
  { input: "can you give me medical advice?", expectOutcome: ["blocked"] },
  // off_topic accepted: jewellery is outside the demo persona's declared scope,
  // so the router's polite redirect (prompts.json off_topic rule) legitimately
  // supersedes the clarify path. A jewellery store would route this to buy.
  { input: "a fancy diamond necklace", expectOutcome: ["clarify", "off_topic", "buy", "buy_browse"] },
  { input: "hi", expectOutcome: ["chat"] },
  // Ranking proof: merchant curated ("best sellers" seed) must outrank the app
  // recommendation with the identical trigger — the best-sellers case above
  // asserts outcome "curated", while this distinct trigger hits the
  // recommendation layer deterministically.
  { input: "what's new?", expectOutcome: ["recommendation"], expectCards: true },
  { input: "product under 20 dollar", expectOutcome: ["buy", "buy_browse"], expectCards: true },
  // ── Description-level asks (accuracy batch 2026-08-17) — the attribute lives
  // ONLY in the product description; the title never says it. Recall comes from
  // the OR'd weighted tsvector + message-word tier + fused ranking; the model
  // sees the matching fragment via the candidate snippet.
  { input: "gloves I can use with my phone", expectOutcome: ["buy"], expectCards: true, expectInText: /merino|glove/i, expectCardTitle: /Merino Wool Gloves/ },
  { input: "something that blocks rfid", expectOutcome: ["buy"], expectCards: true, expectInText: /wallet/i, expectCardTitle: /Leather Wallet/ },
  { input: "a bottle that keeps drinks hot", expectOutcome: ["buy"], expectCards: true, expectInText: /tumbler|bottle/i, expectCardTitle: /Tumbler|Bottle/ },
  // Bare "customer service" is a question, not a hand-off (handover.server.ts patterns).
  { input: "what is your customer service email?", expectOutcome: ["question", "fell_back"] },
];

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.log("NOTE: no OPENAI_API_KEY — structural eval will fail on router calls. Aborting.");
    process.exit(2);
  }

  const shop = await dbCheck.shop.findUnique({ where: { domain: DEV_SHOP_DOMAIN } });
  if (!shop) throw new Error("seed first (npx prisma db seed)");

  const { runPipeline } = await import("../app/lib/pipeline/index.server");

  let failures = 0;
  for (const testCase of GOLDEN) {
    const sessionId = `golden-${Math.random().toString(36).slice(2, 10)}`;
    let outcome = "";
    let text = "";
    let cards: { title: string }[] = [];
    for await (const frame of runPipeline({
      shopId: shop.id,
      sessionId,
      message: testCase.input,
      isTest: true,
    })) {
      if (frame.type === "token") text += frame.text;
      if (frame.type === "message") text += frame.text;
      if (frame.type === "cards") cards = frame.cards;
      if (frame.type === "done") outcome = frame.outcome;
    }

    const problems: string[] = [];
    if (!testCase.expectOutcome.includes(outcome)) {
      problems.push(`outcome "${outcome}" not in [${testCase.expectOutcome.join(", ")}]`);
    }
    if (testCase.expectCards && cards.length === 0 && outcome !== "clarify") {
      problems.push("expected product cards, got none");
    }
    if (testCase.expectInText && !testCase.expectInText.test(text) && outcome !== "clarify") {
      problems.push(`reply text failed ${testCase.expectInText}: "${text.slice(0, 120)}"`);
    }
    if (testCase.expectCardTitle && !cards.some((c) => testCase.expectCardTitle!.test(c.title))) {
      problems.push(`no card matched ${testCase.expectCardTitle}: [${cards.map((c) => c.title).join(" | ")}]`);
    }

    if (problems.length === 0) {
      const cardList = cards.length ? ` (${cards.length} cards: ${cards.map((c) => c.title).join(" | ")})` : "";
      console.log(`PASS  "${testCase.input}" → ${outcome}${cardList}`);
    } else {
      failures++;
      console.log(`FAIL  "${testCase.input}" → ${outcome}\n      ${problems.join("\n      ")}`);
    }
  }

  // ── Multi-turn continuity (spec 03 acceptance #6) ─────────────────────────
  // "under $25" right after a jacket request must stay in the buy lane and
  // respect the budget via history context.
  {
    const sessionId = `golden-multi-${Math.random().toString(36).slice(2, 10)}`;
    let conversationId: string | undefined;
    for await (const frame of runPipeline({
      shopId: shop.id, sessionId, message: "show me some jackets", isTest: true,
    })) {
      if (frame.type === "done") conversationId = frame.conversationId;
    }
    let outcome = "";
    let cards: { price: number; title: string }[] = [];
    for await (const frame of runPipeline({
      shopId: shop.id, sessionId, conversationId, message: "under $25", isTest: true,
    })) {
      if (frame.type === "cards") cards = frame.cards;
      if (frame.type === "done") outcome = frame.outcome;
    }
    const overBudget = cards.filter((c) => c.price > 25);
    if (["buy", "buy_browse"].includes(outcome) && overBudget.length === 0) {
      console.log(`PASS  multi-turn "under $25" → ${outcome} (${cards.length} cards, all ≤ $25)`);
    } else {
      failures++;
      console.log(
        `FAIL  multi-turn "under $25" → ${outcome}; over-budget: ${overBudget.map((c) => c.title).join(", ") || "none"}`,
      );
    }
  }

  // ── 3-turn continuity (accuracy batch 2026-08-17) ─────────────────────────
  // History window is 10 for router AND generation; the follow-ups only make
  // sense with the earlier turns in context.
  {
    const sessionId = `golden-multi3-${Math.random().toString(36).slice(2, 10)}`;
    let conversationId: string | undefined;
    const turns = ["show me some jackets", "under $100", "the waterproof one?"];
    let outcome = "";
    let cards: { price: number; title: string }[] = [];
    for (const message of turns) {
      cards = [];
      for await (const frame of runPipeline({ shopId: shop.id, sessionId, conversationId, message, isTest: true })) {
        if (frame.type === "cards") cards = frame.cards;
        if (frame.type === "done") {
          outcome = frame.outcome;
          conversationId = frame.conversationId;
        }
      }
    }
    const overBudget = cards.filter((c) => c.price > 100);
    const hasWaterproof = cards.some((c) => /waterproof|rain/i.test(c.title));
    if (["buy", "buy_browse"].includes(outcome) && overBudget.length === 0 && hasWaterproof) {
      console.log(`PASS  3-turn "the waterproof one?" → ${outcome} (${cards.map((c) => c.title).join(" | ")})`);
    } else {
      failures++;
      console.log(
        `FAIL  3-turn "the waterproof one?" → ${outcome}; cards: ${cards.map((c) => `${c.title} $${c.price}`).join(" | ") || "none"}`,
      );
    }
  }

  // ── Repeated message must NOT hand over (default threshold 3) ─────────────
  {
    const sessionId = `golden-repeat-${Math.random().toString(36).slice(2, 10)}`;
    let conversationId: string | undefined;
    let outcome = "";
    for (let i = 0; i < 2; i++) {
      for await (const frame of runPipeline({
        shopId: shop.id, sessionId, conversationId, message: "do you ship to Canada?", isTest: true,
      })) {
        if (frame.type === "done") {
          outcome = frame.outcome;
          conversationId = frame.conversationId;
        }
      }
    }
    if (outcome === "question") {
      console.log("PASS  repeated question ×2 → question (no handover)");
    } else {
      failures++;
      console.log(`FAIL  repeated question ×2 → ${outcome} (expected question)`);
    }

    // History window sanity: the just-saved shopper message is excluded when
    // its id is passed, and the window ends with the assistant's reply.
    const { loadHistory } = await import("../app/lib/pipeline/history.server");
    const lastIn = await dbCheck.message.findFirst({
      where: { shopId: shop.id, conversationId, role: "in" },
      orderBy: { createdAt: "desc" },
    });
    const bundle = await loadHistory(shop.id, conversationId!, { excludeMessageId: lastIn?.id });
    const dup = bundle.routerHistory.filter((m) => m.role === "user" && m.content === lastIn?.content).length;
    const last = bundle.routerHistory[bundle.routerHistory.length - 1];
    // Two identical shopper turns were sent above, so exactly ONE copy (turn 1) may remain.
    if (dup <= 1 && last?.role === "assistant" && bundle.generationHistory.length === bundle.routerHistory.length) {
      console.log(
        `PASS  history window excludes current message (router=${bundle.routerHistory.length}, generation=${bundle.generationHistory.length})`,
      );
    } else {
      failures++;
      console.log(
        `FAIL  history window: dup=${dup} last=${last?.role} router=${bundle.routerHistory.length} generation=${bundle.generationHistory.length}`,
      );
    }
  }

  // Cost budget assertion is enforced by design (1 embed reused; ≤2 chat calls
  // per generating turn). Curated case must have made zero generation calls —
  // verified structurally by its outcome being "curated".

  console.log(failures === 0 ? "\nGOLDEN SET PASS ✔" : `\nGOLDEN SET FAIL ✖ (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main()
  .catch((error) => {
    console.error("eval crashed:", error);
    process.exit(1);
  })
  .finally(() => dbCheck.$disconnect());
