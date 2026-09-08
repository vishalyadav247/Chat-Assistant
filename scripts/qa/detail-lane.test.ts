/* Product-detail lane QA (spec 03 delta, 2026-09-07 — QA area Y).
 *
 * Run:  npx tsx scripts/qa/detail-lane.test.ts
 * Needs: dev Postgres up (npm run db:up), migrated and seeded (dev-shop).
 *        No dev server. No LLM key: every check here is either pure or DB-only,
 *        and the one model-shaped decision is exercised through its parser.
 *
 * WHAT THIS PROTECTS. A shopper shown three bracelets asks "what is this one
 * made of?" and used to receive a fresh recommendation — three DIFFERENT
 * products. The router has only buy/question/chat, `question` means POLICY, so
 * every product-shaped message became `buy`, and `buy` always means retrieve
 * and recommend. The detail lane is the missing fourth path.
 *
 * Fixtures are tagged `qa-detail-` and removed in the `finally` block; seeded
 * data is never modified.
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

const DEV_SHOP_DOMAIN = "dev-shop.myshopify.com";
const SESSION_PREFIX = "qa-detail-";

let passed = 0;
let failed = 0;

function ok(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  ok(
    name,
    JSON.stringify(actual) === JSON.stringify(expected),
    `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`,
  );
}

async function main(): Promise<void> {
  const db = (await import("../../app/db.server")).default;
  const { parseDetailLine, splitDetailStream } = await import("../../app/lib/pipeline/picks.server");
  const { shownProducts, detailSnippet, isDetailFollowUp } = await import(
    "../../app/lib/pipeline/detail.server"
  );
  const { PRODUCT_DETAIL, detailConfirmUser } = await import("../../app/lib/pipeline/prompts");

  // ── 1. The DETAIL control line ────────────────────────────────────────────
  console.log("\n[1] DETAIL line parsing");
  eq("plain id", parseDetailLine("DETAIL: 2"), { kind: "id", id: 2 });
  eq("lowercase", parseDetailLine("detail: 1"), { kind: "id", id: 1 });
  eq("markdown noise", parseDetailLine("**DETAIL:** 3"), { kind: "id", id: 3 });
  eq("none", parseDetailLine("DETAIL: none"), { kind: "none" });
  eq("empty body is none", parseDetailLine("DETAIL:"), { kind: "none" });
  eq(
    "only the first id — the lane answers about ONE product",
    parseDetailLine("DETAIL: 2, 3"),
    { kind: "id", id: 2 },
  );
  ok("prose is not a control line", parseDetailLine("Detailed care instructions follow") === null);
  ok("unrelated line", parseDetailLine("This one is made of obsidian.") === null);
  ok("a PICKS line is not a DETAIL line", parseDetailLine("PICKS: 1, 2") === null);
  // Ids are 1-based, so "0" is not a product. It parses as `none` rather than
  // as an id — inherited from the PICKS none-words — which lands on exactly the
  // right behaviour anyway: no card, and a reply that asks which one they mean.
  eq("id 0 is not a product", parseDetailLine("DETAIL: 0"), { kind: "none" });

  // The line must be stripped from what the shopper reads.
  const source = (async function* () {
    yield "DETAIL: 2\n";
    yield "It is made of ";
    yield "polished obsidian.";
  })();
  const split = splitDetailStream(source);
  let visible = "";
  for await (const token of split.text) visible += token;
  eq("control line stripped from shopper text", visible.trim(), "It is made of polished obsidian.");
  eq("parsed subject", split.result().parsed, { kind: "id", id: 2 });

  // ── 2. The prompt forbids the reported behaviour ──────────────────────────
  console.log("\n[2] Prompt contract");
  ok(
    "answers about that product only",
    /THAT product only/i.test(PRODUCT_DETAIL),
    "the whole point of the lane",
  );
  ok(
    "explicitly forbids offering other products",
    /Do NOT recommend, mention, compare or suggest any other product/i.test(PRODUCT_DETAIL),
    "this is the exact production complaint",
  );
  ok(
    "forbids inventing specifications",
    /Never invent a material, measurement/i.test(PRODUCT_DETAIL) && /ONLY the product data/i.test(PRODUCT_DETAIL),
  );
  ok("requires the DETAIL control line", /`DETAIL: <id>`/.test(PRODUCT_DETAIL));
  // The boundary the golden set forced. "the waterproof one?" after a jacket
  // search is the shopper CHOOSING among what they were shown — still browsing,
  // and the buy lane's tuned selection behaviour has to keep it. A detail lane
  // that swallows selection turns is a worse bug than the one it fixes.
  const confirm = detailConfirmUser("is it waterproof?", ["A"]);
  ok(
    "yes is limited to facts about a settled product",
    /Answer yes ONLY if/i.test(confirm) && /what it is made of/i.test(confirm),
  );
  ok(
    "choosing, narrowing and comparing are explicitly NOT detail",
    /choosing between the products/i.test(confirm) &&
      /narrowing by an\s+attribute/i.test(confirm) &&
      /still browsing/i.test(confirm),
    "this is the regression the golden set caught",
  );

  const shop = await db.shop.findUnique({ where: { domain: DEV_SHOP_DOMAIN }, select: { id: true } });
  if (!shop) throw new Error(`dev shop ${DEV_SHOP_DOMAIN} not found — run npx prisma db seed`);
  const shopId = shop.id;

  const catalogue = await db.product.findMany({
    where: { shopId, learnEnabled: true },
    take: 3,
    select: { shopifyProductId: true, title: true },
  });
  if (catalogue.length < 3) throw new Error("need 3 seeded products — run npx prisma db seed");

  try {
    // ── 3. Which products count as "already shown" ──────────────────────────
    console.log("\n[3] Shown-product recovery");
    const convo = await db.conversation.create({
      data: { shopId, sessionId: `${SESSION_PREFIX}${Date.now()}`, isTest: false },
    });
    const card = (p: { shopifyProductId: string; title: string }) => ({
      shopifyProductId: p.shopifyProductId,
      title: p.title,
      price: 10,
      imageUrl: null,
      handle: "h",
      variantId: null,
      variantGid: null,
    });

    eq("no cards shown yet ⇒ nothing to ask about", await shownProducts(shopId, convo.id), []);

    await db.message.create({
      data: {
        shopId,
        conversationId: convo.id,
        role: "out",
        author: "ai",
        content: "These fit.",
        sourceLayer: "buy",
        productCards: [card(catalogue[0]), card(catalogue[1])],
      },
    });
    const afterFirst = await shownProducts(shopId, convo.id);
    eq("both shown products recovered", afterFirst.length, 2);
    ok(
      "recovered from the catalogue, not from the stored card",
      afterFirst.every((p) => p.price !== 10),
      "the card is a snapshot; price and stock move underneath it",
    );
    ok(
      "detail data is carried",
      afterFirst.every((p) => typeof p.description === "string" && Array.isArray(p.tags)),
    );

    // A later turn showing one of the same products must not duplicate it.
    await db.message.create({
      data: {
        shopId,
        conversationId: convo.id,
        role: "out",
        author: "ai",
        content: "And this one.",
        sourceLayer: "buy",
        productCards: [card(catalogue[1]), card(catalogue[2])],
      },
    });
    const afterSecond = await shownProducts(shopId, convo.id);
    eq("deduplicated across turns", afterSecond.length, 3);
    eq(
      "most recently shown first — that is what 'this one' usually means",
      afterSecond[0].shopifyProductId,
      catalogue[1].shopifyProductId,
    );

    // ── 4. Tenancy ─────────────────────────────────────────────────────────
    console.log("\n[4] Tenancy");
    const otherShop = await db.shop.create({
      data: { domain: `${SESSION_PREFIX}other-${Date.now()}.myshopify.com`, plan: "free" },
    });
    eq(
      "another shop sees nothing of this conversation",
      await shownProducts(otherShop.id, convo.id),
      [],
    );
    let threw = false;
    try {
      await shownProducts("", convo.id);
    } catch {
      threw = true;
    }
    ok("a blank shopId is rejected outright", threw);

    // ── 5. Fail-safe behaviour ─────────────────────────────────────────────
    console.log("\n[5] Fail-safe");
    eq(
      "no shown products ⇒ no confirm call is made at all",
      await isDetailFollowUp(shopId, "what is it made of?", []),
      false,
    );

    const snippet = detailSnippet(afterSecond[0]);
    ok("the snippet states stock", /in stock|out of stock/.test(snippet));
    ok(
      "the snippet carries specification sources",
      snippet.includes("type:") || snippet.includes("description:") || snippet.includes("specs:"),
    );

    // ── 6. The lane is reachable and distinct in the logs ───────────────────
    console.log("\n[6] Observability");
    const pipeline = readFileSync(
      join(process.cwd(), "app", "lib", "pipeline", "index.server.ts"),
      "utf-8",
    );
    ok(
      'the lane writes its own sourceLayer ("detail")',
      /sourceLayer: "detail"/.test(pipeline),
      "otherwise a detail turn is indistinguishable from a recommendation in analytics",
    );
    ok(
      "the check runs only when cards were already shown",
      /if \(shown\.length > 0\) \{/.test(pipeline),
      "a first-turn shopper must not pay for a confirm call",
    );
    ok(
      "the buy lane still runs when the answer is no",
      /if \(isDetail\) \{[\s\S]{0,400}?\n\s{4}\}\n\s{4}yield\* buyLane\(/.test(pipeline),
      "the detail lane is additive — it must never swallow a real product request",
    );
    ok(
      "the catalogue permission still gates it",
      /config\.settings\.learn\.products\s*\n?\s*\?\s*await shownProducts/.test(pipeline),
      "Learn products off means the catalogue is off-limits, detail included",
    );

    await db.message.deleteMany({ where: { shopId, conversationId: convo.id } });
    await db.conversation.delete({ where: { id: convo.id } });
    await db.shop.delete({ where: { id: otherShop.id } });
  } finally {
    await db.conversation.deleteMany({ where: { sessionId: { startsWith: SESSION_PREFIX } } });
    await db.shop.deleteMany({ where: { domain: { startsWith: SESSION_PREFIX } } });
    await db.$disconnect();
  }

  console.log(`\n${passed} passed / ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
