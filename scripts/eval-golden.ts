/* Golden-set eval (spec 03 / ai-pipeline skill): runs the canonical inputs
 * through the REAL pipeline against the seeded dev shop and asserts the PATH
 * each takes (outcome/sourceLayer), plus semantic expectations when a real
 * OPENAI_API_KEY is present. Run BEFORE merging any prompt/threshold change:
 *   npm run eval:golden      (= npx tsx scripts/eval-golden.ts)
 * Sections: single-turn cases · description-level asks (accuracy batch
 * 2026-08-17) · multi-turn continuity · no-accidental-handover · history window.
 */
import { PrismaClient } from "@prisma/client";
import { PUBLISHED_FIXTURE_QUESTIONS } from "./qa/curated-fixtures";

// The golden set asserts the router + lanes engine's PATHS (outcome names).
// Since spec 24 the AI agent is the default and is measured by
// `npm run eval:conversations`; pin the pipeline here.
process.env.AI_AGENT_MODE = "pipeline";

const dbCheck = new PrismaClient();
const DEV_SHOP_DOMAIN = "dev-shop.myshopify.com";

interface GoldenCase {
  input: string;
  expectOutcome: string[];
  expectInText?: RegExp;
  expectCards?: boolean;
  /** At least one returned card title must match (checks ranking, not just recall). */
  expectCardTitle?: RegExp;
  /** No returned card title may match (checks precision — the wrong product must NOT be shown). */
  rejectCardTitle?: RegExp;
  /** Reply text must NOT match (QA-A4/A6: invented alternatives, promised email). */
  rejectInText?: RegExp;
  /** QA-A1/A7: the reply may name no catalogue product that is not carded. */
  groundedText?: boolean;
  /** QA-A5: an `actions` frame must offer this key. */
  expectAction?: string;
  /** Upper bound on cards (QA-A2: no padding). */
  maxCards?: number;
}

/**
 * Catalogue products the reply names but the cards do not show (QA-A1).
 * A product counts as "named" by its distinctive two-word head ("Rose Quartz",
 * "Thermal Socks") — the model shortens titles, so whole-title matching misses
 * exactly the failure this guards. A head that is part of a carded title is fine.
 */
function namesUncardedProduct(text: string, cardTitles: string[], catalogue: string[]): string | null {
  const lower = text.toLowerCase();
  const carded = cardTitles.map((t) => t.toLowerCase());
  for (const title of catalogue) {
    const head = title.toLowerCase().split(/\s+/).slice(0, 2).join(" ");
    if (head.length < 6 || !lower.includes(head)) continue;
    if (carded.some((t) => t.includes(head))) continue;
    return title;
  }
  return null;
}

const GOLDEN: GoldenCase[] = [
  { input: "what are your best sellers?", expectOutcome: ["curated"] },
  { input: "keep my hands warm under $30", expectOutcome: ["buy", "buy_browse"], expectCards: true, expectCardTitle: /glove|beanie|scarf|sock/i },
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
  // Reply text no longer names products (compact prompt 2026-08-18) — assert on cards.
  { input: "gloves I can use with my phone", expectOutcome: ["buy"], expectCards: true, expectCardTitle: /Merino Wool Gloves/ },
  { input: "something that blocks rfid", expectOutcome: ["buy"], expectCards: true, expectCardTitle: /Leather Wallet/ },
  { input: "a bottle that keeps drinks hot", expectOutcome: ["buy"], expectCards: true, expectCardTitle: /Tumbler|Bottle/ },
  // Bare "customer service" is a question, not a hand-off (handover.server.ts patterns).
  { input: "what is your customer service email?", expectOutcome: ["question", "fell_back"] },
  // A question about the store itself is RAG, never small talk — the chat lane
  // retrieves nothing and once invented "visits are not available" against a
  // store page that said otherwise (tuning event 2026-09-11).
  { input: "can I come and pick up my order in person?", expectOutcome: ["question"], expectInText: /mon|fri|10\s?am|4\s?pm|warehouse/i },
  // ── Field-aware ranking + model picks (2026-09-01) — the real-store failure:
  // long descriptions name OTHER products' colours and stones ("pairs with
  // black outfits", "recharge on a selenite plate"). A word only in the prose
  // must not make a product a match; the literal title match must win.
  // QA-A1 (2026-09-14): the reply once ALSO recommended Rose Quartz ("pairs
  // beautifully with black") after code dropped its card — groundedText checks
  // the words, not just the cards.
  { input: "show me black bracelets", expectOutcome: ["buy"], expectCards: true, expectCardTitle: /Black Onyx/, rejectCardTitle: /Rose Quartz/, groundedText: true },
  { input: "do you have selenite bracelets", expectOutcome: ["buy"], expectCards: true, expectCardTitle: /Selenite Crystal/, rejectCardTitle: /Rose Quartz/ },
  // Question-shaped product ask: routed buy, or question → catalogue rescue.
  { input: "which bracelet is good for love", expectOutcome: ["buy"], expectCards: true, expectCardTitle: /Rose Quartz/ },
  // ── QA report 2026-09-14 (tuning event) ──────────────────────────────────
  // A3: a creative / general-assistant task is off-topic when a store scope is
  // set (dev-shop has one) — it used to route chat and write the poem.
  { input: "write me a poem about the ocean", expectOutcome: ["off_topic"] },
  // A4: availability of a NAMED product is answered from the catalogue row
  // (stock 0 on dev-shop), not RAG — and no invented alternatives.
  {
    input: "is the Mulberry Silk Pillowcase in stock?",
    expectOutcome: ["detail"],
    expectInText: /out of stock|sold out|not in stock|currently unavailable|no stock|isn'?t in stock|not available/i,
    rejectInText: /other pillowcase|similar|alternative/i,
  },
  // A5: order status goes to the Track-order screen (order tracking is on for
  // dev-shop's plan), not a borderline curated answer.
  { input: "where is my order #1234?", expectOutcome: ["order_status"], expectAction: "track_order" },
  // A6: a blocked topic never asks for an email when no form is shown.
  { input: "can this crystal bracelet cure my anxiety?", expectOutcome: ["blocked"], rejectInText: /email/i },
];

async function main() {
  const shop = await dbCheck.shop.findUnique({ where: { domain: DEV_SHOP_DOMAIN } });
  if (!shop) throw new Error("seed first (npx prisma db seed)");

  const { runPipeline } = await import("../app/lib/pipeline/index.server");
  const catalogue = (
    await dbCheck.product.findMany({ where: { shopId: shop.id, status: "active" }, select: { title: true } })
  ).map((p) => p.title);

  let failures = 0;
  for (const testCase of GOLDEN) {
    const sessionId = `golden-${Math.random().toString(36).slice(2, 10)}`;
    let outcome = "";
    let text = "";
    let cards: { title: string }[] = [];
    let actionKeys: string[] = [];
    for await (const frame of runPipeline({
      shopId: shop.id,
      sessionId,
      message: testCase.input,
      isTest: true,
    })) {
      if (frame.type === "token") text += frame.text;
      if (frame.type === "message") text += frame.text;
      if (frame.type === "cards") cards = frame.cards;
      if (frame.type === "actions") actionKeys = frame.actions.map((a) => a.key);
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
    if (testCase.rejectCardTitle && cards.some((c) => testCase.rejectCardTitle!.test(c.title))) {
      problems.push(`a card matched ${testCase.rejectCardTitle} and must not: [${cards.map((c) => c.title).join(" | ")}]`);
    }
    if (testCase.rejectInText && testCase.rejectInText.test(text)) {
      problems.push(`reply text matched ${testCase.rejectInText} and must not: "${text.slice(0, 160)}"`);
    }
    if (testCase.groundedText) {
      const named = namesUncardedProduct(text, cards.map((c) => c.title), catalogue);
      if (named) problems.push(`reply names "${named}" but it is not carded: "${text.slice(0, 160)}"`);
    }
    if (testCase.expectAction && !actionKeys.includes(testCase.expectAction)) {
      problems.push(`expected action ${testCase.expectAction}, got [${actionKeys.join(", ")}]`);
    }
    if (testCase.maxCards !== undefined && cards.length > testCase.maxCards) {
      problems.push(`expected at most ${testCase.maxCards} card(s), got ${cards.length}`);
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

  // ── QA-A2 (2026-09-14): no padding with an off-category product ───────────
  // "…something warm for my head under $20" once returned Fleece Beanie AND
  // Thermal Socks (a vector-only top-up to reach two cards) while the reply
  // said "this pick".
  {
    const sessionId = `golden-a2-${Math.random().toString(36).slice(2, 10)}`;
    let conversationId: string | undefined;
    for await (const frame of runPipeline({
      shopId: shop.id, sessionId, message: "gloves I can use with my phone", isTest: true,
    })) {
      if (frame.type === "done") conversationId = frame.conversationId;
    }
    let outcome = "";
    let cards: { title: string; price: number }[] = [];
    for await (const frame of runPipeline({
      shopId: shop.id, sessionId, conversationId, message: "something warm for my head under $20", isTest: true,
    })) {
      if (frame.type === "cards") cards = frame.cards;
      if (frame.type === "done") outcome = frame.outcome;
    }
    const offCategory = cards.filter((c) => /sock|glove|jacket|bottle|wallet|bracelet/i.test(c.title));
    if (["buy", "buy_browse"].includes(outcome) && cards.some((c) => /beanie|hat|headband|cap/i.test(c.title)) && offCategory.length === 0) {
      console.log(`PASS  A2 head-warmer follow-up → ${outcome} (${cards.map((c) => c.title).join(" | ")})`);
    } else {
      failures++;
      console.log(
        `FAIL  A2 head-warmer follow-up → ${outcome}; cards: ${cards.map((c) => c.title).join(" | ") || "none"}; off-category: ${offCategory.map((c) => c.title).join(", ") || "none"}`,
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
  return failures;
}

/**
 * The golden set measures the pipeline against the SEED catalogue. But
 * scripts/qa/seed-curated.ts publishes its own fixtures onto the very same dev
 * shop, and some of them legitimately intercept golden inputs — "do you ship
 * internationally" scores 0.72 against "do you ship to Canada?", the borderline
 * confirm call accepts it, and the turn is served from curated instead of
 * reaching the RAG question path. That is the product working correctly, but it
 * silently changes what this eval measures, which makes a red result impossible
 * to read. So the fixtures are unpublished for the duration and restored after —
 * never deleted, and restored even when the run throws.
 */
async function withSeedCatalogueOnly<T>(work: () => Promise<T>): Promise<T> {
  // Fixtures are identified by question on the dev shop (QA-T3), never by a
  // marker in shopper-visible talking points.
  const devShop = await dbCheck.shop.findUnique({ where: { domain: DEV_SHOP_DOMAIN }, select: { id: true } });
  const parked = devShop
    ? await dbCheck.curatedAnswer.findMany({
        where: { shopId: devShop.id, question: { in: PUBLISHED_FIXTURE_QUESTIONS }, status: "published" },
        select: { id: true },
      })
    : [];
  const ids = parked.map((row) => row.id);
  if (ids.length > 0) {
    await dbCheck.curatedAnswer.updateMany({ where: { id: { in: ids } }, data: { status: "draft" } });
    console.log(`(parked ${ids.length} QA fixture curated answers so the seed catalogue is what gets measured)\n`);
  }
  try {
    return await work();
  } finally {
    if (ids.length > 0) {
      await dbCheck.curatedAnswer.updateMany({ where: { id: { in: ids } }, data: { status: "published" } });
    }
  }
}

// Checked before anything is parked, so an early abort can never leave the
// fixtures unpublished.
if (!process.env.OPENAI_API_KEY) {
  console.log("NOTE: no OPENAI_API_KEY — structural eval will fail on router calls. Aborting.");
  process.exit(2);
}

withSeedCatalogueOnly(main)
  .then((failures) => {
    process.exitCode = failures === 0 ? 0 : 1;
  })
  .catch((error) => {
    console.error("eval crashed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await dbCheck.$disconnect();
    // The pipeline runs on the app/db.server SINGLETON — a SECOND client whose
    // pool keeps the event loop alive. Disconnecting only `dbCheck` left the
    // process hanging forever AFTER printing its results, with the output still
    // trapped in npm’s pipe buffer, so a finished run looked like a stuck one
    // (2026-09-10: two completed runs wedged, one of them for 80 minutes).
    const appDb = (await import("../app/db.server")).default;
    await appDb.$disconnect().catch(() => undefined);
  });
