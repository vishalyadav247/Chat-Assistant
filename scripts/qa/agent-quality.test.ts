/* Recommendation-quality probe against the REAL merchant catalogue.
 *
 *   npx tsx scripts/qa/agent-quality.test.ts
 *   npx tsx scripts/qa/agent-quality.test.ts --shop other.myshopify.com
 *
 * The golden eval (scripts/eval-golden.ts) measures the PATH a turn takes on a
 * clean 43-product fixture. This measures the ANSWER on the 167-product mixed
 * catalogue of jgw-check — crystal bracelets sharing a shop with a cosmetics
 * range — which is where relevance actually gets hard: "shampoo for dandruff"
 * must not surface a bracelet, and "bracelet for money" must not surface a
 * face wash.
 *
 * Each case asserts three things a shopper would notice:
 *   expectTitle  — the right product ranks (recall + ranking)
 *   rejectTitle  — the wrong product does NOT appear (precision; the failure
 *                  mode long SEO descriptions cause, since prose about one
 *                  product names another's colour, stone or use)
 *   maxPrice     — a stated budget is respected
 *
 * Turns are isTest, so nothing ticks the usage meter or reaches the inbox.
 */
import { PrismaClient } from "@prisma/client";

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

interface Case {
  /** Grouping label printed in the summary. */
  area: string;
  input: string;
  expectOutcome: string[];
  expectCards?: boolean;
  expectTitle?: RegExp;
  rejectTitle?: RegExp;
  maxPrice?: number;
  expectInText?: RegExp;
}

const CASES: Case[] = [
  // ── Cross-category precision. Both ranges live in one shop, so every one of
  // these is a chance to answer from the wrong half of the catalogue.
  { area: "cross-category", input: "i need a sunscreen for oily skin", expectOutcome: ["buy", "buy_browse"], expectCards: true, expectTitle: /sunscreen|sun stick|spf/i, rejectTitle: /bracelet|anklet/i },
  { area: "cross-category", input: "shampoo for dandruff", expectOutcome: ["buy", "buy_browse"], expectCards: true, expectTitle: /dandruff|shampoo/i, rejectTitle: /bracelet|lipstick|nail polish/i },
  { area: "cross-category", input: "my hair is falling a lot, what do you have", expectOutcome: ["buy", "buy_browse"], expectCards: true, expectTitle: /hairfall|hair growth|bhringraj|scalp|shampoo|onion/i, rejectTitle: /bracelet/i },
  { area: "cross-category", input: "beard oil for men", expectOutcome: ["buy", "buy_browse"], expectCards: true, expectTitle: /beard/i, rejectTitle: /bracelet|lipstick/i },
  { area: "cross-category", input: "show me a red lipstick", expectOutcome: ["buy", "buy_browse"], expectCards: true, expectTitle: /lipstick|lip crayon|lip gloss/i, rejectTitle: /nail polish|bracelet/i },
  { area: "cross-category", input: "vitamin c serum for glowing skin", expectOutcome: ["buy", "buy_browse"], expectCards: true, expectTitle: /vitamin c|serum/i, rejectTitle: /bracelet/i },

  // ── Intent-level crystal asks. The stone is never named — the benefit is,
  // and it lives in the title tail or the description.
  { area: "intent", input: "i want a bracelet for money and wealth", expectOutcome: ["buy", "buy_browse"], expectCards: true, expectTitle: /pyrite|abundance|citrine/i, rejectTitle: /shampoo|lipstick|sunscreen/i },
  { area: "intent", input: "something to calm my mind and help me relax", expectOutcome: ["buy", "buy_browse", "question"], expectTitle: /amethyst|howlite|lavender|moonstone/i },
  { area: "intent", input: "bracelet for protection from evil eye", expectOutcome: ["buy", "buy_browse"], expectCards: true, expectTitle: /obsidian|tourmaline|evil eye/i },
  { area: "intent", input: "which one helps with confidence and leadership", expectOutcome: ["buy", "buy_browse"], expectCards: true, expectTitle: /sunstone|citrine|carnelian|red jasper/i },
  { area: "intent", input: "a gift for my wife, she loves pink", expectOutcome: ["buy", "buy_browse", "clarify"], expectTitle: /rose quartz|strawberry quartz|pink/i },
  { area: "intent", input: "bracelet to help me focus and concentrate", expectOutcome: ["buy", "buy_browse"], expectCards: true, expectTitle: /fluorite|memory|concentration|amethyst/i },

  // ── Literal attribute asks. The exact word must win over prose that merely
  // mentions it (the 2026-09-01 field-aware ranking change).
  { area: "literal", input: "lapis lazuli bracelet", expectOutcome: ["buy", "buy_browse"], expectCards: true, expectTitle: /lapis lazuli/i, rejectTitle: /rose quartz|shampoo/i },
  { area: "literal", input: "moonstone bracelet", expectOutcome: ["buy", "buy_browse"], expectCards: true, expectTitle: /moonstone/i },
  { area: "literal", input: "green aventurine bracelet", expectOutcome: ["buy", "buy_browse"], expectCards: true, expectTitle: /aventurine/i },
  // Tiger Eye and Green Jade exist in the catalogue but are OUT OF STOCK, and
  // 126 of the 167 products are — so this asserts the honest answer rather than
  // a card. The reply must say so; the mechanical tier still shows near-misses
  // because a router keyword ("bracelet") anchors, which is why no card
  // assertion belongs here. See the 2026-09-04 note in TEST-CASES.md.
  { area: "literal", input: "do you have a tiger eye bracelet", expectOutcome: ["buy", "buy_browse", "clarify"], expectInText: /don't have|do not have|dont have|no tiger|not have|unavailable|out of stock|sorry|currently/i, rejectTitle: /shampoo|lipstick|sunscreen/i },
  { area: "literal", input: "do you sell anklets", expectOutcome: ["buy", "buy_browse"], expectCards: true, expectTitle: /anklet/i, rejectTitle: /shampoo|lipstick/i },

  // ── Budget. A stated ceiling is the single most checkable promise the agent
  // makes; an over-budget card is a visible defect.
  { area: "budget", input: "show me bracelets under 500", expectOutcome: ["buy", "buy_browse"], expectCards: true, maxPrice: 500, expectTitle: /bracelet/i },
  { area: "budget", input: "any perfume under 1500", expectOutcome: ["buy", "buy_browse"], expectCards: true, maxPrice: 1500, expectTitle: /perfume|parfum|attar/i },

  // ── Catalogue honesty. Nothing here is a shoe or a laptop; inventing cards
  // is worse than saying no.
  { area: "honesty", input: "do you sell running shoes", expectOutcome: ["buy", "buy_browse", "clarify", "question", "off_topic", "fell_back"], rejectTitle: /bracelet|shampoo|lipstick/i },
  { area: "honesty", input: "i am looking for a laptop", expectOutcome: ["buy", "buy_browse", "clarify", "question", "off_topic", "fell_back"], rejectTitle: /bracelet|shampoo|lipstick/i },

  // ── Support lane. These must NOT become product pitches.
  { area: "support", input: "do you ship internationally?", expectOutcome: ["question", "fell_back", "curated"] },
  { area: "support", input: "what is your return policy", expectOutcome: ["question", "fell_back", "curated"] },
  { area: "support", input: "hello", expectOutcome: ["chat"] },
  { area: "support", input: "can you tell me if this crystal cures cancer", expectOutcome: ["blocked", "question", "fell_back"] },
];

interface Card {
  title: string;
  price: number;
}

async function runTurn(shopId: string, message: string, sessionId: string, conversationId?: string) {
  const { runPipeline } = await import("../../app/lib/pipeline/index.server");
  let outcome = "";
  let text = "";
  let cards: Card[] = [];
  let convId = conversationId;
  for await (const frame of runPipeline({ shopId, sessionId, conversationId, message, isTest: true })) {
    if (frame.type === "token" || frame.type === "message") text += frame.text;
    if (frame.type === "cards") cards = frame.cards as Card[];
    if (frame.type === "done") {
      outcome = frame.outcome;
      convId = frame.conversationId;
    }
  }
  return { outcome, text, cards, conversationId: convId };
}

async function main(): Promise<number> {
  const shop = await prisma.shop.findUnique({ where: { domain: SHOP_DOMAIN } });
  if (!shop) throw new Error(`no shop ${SHOP_DOMAIN} — seed or sync it first`);
  const products = await prisma.product.count({ where: { shopId: shop.id } });
  console.log(`shop ${SHOP_DOMAIN} · plan ${shop.plan} · ${products} products\n`);

  let failures = 0;
  const byArea = new Map<string, { pass: number; fail: number }>();

  for (const testCase of CASES) {
    const sessionId = `aq-${Math.random().toString(36).slice(2, 10)}`;
    const { outcome, text, cards } = await runTurn(shop.id, testCase.input, sessionId);

    const problems: string[] = [];
    if (!testCase.expectOutcome.includes(outcome)) {
      problems.push(`outcome "${outcome}" not in [${testCase.expectOutcome.join(", ")}]`);
    }
    if (testCase.expectCards && cards.length === 0) problems.push("expected product cards, got none");
    if (testCase.expectTitle && cards.length > 0 && !cards.some((c) => testCase.expectTitle!.test(c.title))) {
      problems.push(`no card matched ${testCase.expectTitle}`);
    }
    if (testCase.rejectTitle && cards.some((c) => testCase.rejectTitle!.test(c.title))) {
      problems.push(`a card matched ${testCase.rejectTitle} and must not`);
    }
    if (testCase.maxPrice !== undefined) {
      const over = cards.filter((c) => Number(c.price) > testCase.maxPrice!);
      if (over.length > 0) problems.push(`over budget: ${over.map((c) => `${c.title} ${c.price}`).join(", ")}`);
    }
    if (testCase.expectInText && !testCase.expectInText.test(text)) {
      problems.push(`reply text failed ${testCase.expectInText}`);
    }

    const tally = byArea.get(testCase.area) ?? { pass: 0, fail: 0 };
    const cardList = cards.length ? ` [${cards.map((c) => c.title).join(" | ")}]` : "";
    if (problems.length === 0) {
      tally.pass++;
      console.log(`PASS  (${testCase.area}) "${testCase.input}" → ${outcome}${cardList}`);
    } else {
      tally.fail++;
      failures++;
      console.log(`FAIL  (${testCase.area}) "${testCase.input}" → ${outcome}${cardList}\n      ${problems.join("\n      ")}`);
    }
    byArea.set(testCase.area, tally);
  }

  // ── Multi-turn: the follow-up carries the earlier subject and the budget.
  {
    const sessionId = `aq-multi-${Math.random().toString(36).slice(2, 10)}`;
    const first = await runTurn(shop.id, "show me some bracelets", sessionId);
    const second = await runTurn(shop.id, "under 500", sessionId, first.conversationId);
    const over = second.cards.filter((c) => Number(c.price) > 500);
    if (["buy", "buy_browse"].includes(second.outcome) && second.cards.length > 0 && over.length === 0) {
      console.log(`PASS  (multi-turn) "under 500" → ${second.outcome} (${second.cards.length} cards, all ≤ 500)`);
    } else {
      failures++;
      console.log(
        `FAIL  (multi-turn) "under 500" → ${second.outcome}; cards: ${second.cards.map((c) => `${c.title} ${c.price}`).join(" | ") || "none"}`,
      );
    }
  }

  console.log("");
  for (const [area, tally] of byArea) {
    console.log(`${area.padEnd(16)} ${tally.pass} pass / ${tally.fail} fail`);
  }
  console.log(`\n${CASES.length + 1} checks · ${failures} failed`);
  return failures;
}

if (!process.env.OPENAI_API_KEY) {
  console.log("NOTE: no OPENAI_API_KEY — this suite measures real model output. Aborting.");
  process.exit(2);
}

main()
  .then((failures) => {
    process.exitCode = failures === 0 ? 0 : 1;
  })
  .catch((error) => {
    console.error("agent-quality crashed:", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
