/* Data-source learning — does every source reach the ANSWER, and does every
 * switch take it away again?
 *
 *   npx tsx scripts/qa/data-sources.test.ts          (needs OPENAI_API_KEY)
 *
 * features.test.ts proves each source is INGESTED and RETRIEVABLE. This proves
 * the part a merchant actually cares about: ask the agent, and it answers from
 * the source while it is switched on — and stops the moment any of its
 * switches (master "Learn …", per-row learn, status, delete) turns it off.
 *
 * Every source carries one invented fact ("14 Larkspur Lane", "MOONRAKER47")
 * that no model could know, so presence and absence in a reply are
 * unambiguous. Each source is checked at two layers:
 *   retrieval — deterministic: what the pipeline's own search hands the model
 *   answer    — end to end: what the shopper reads (runPipeline, isTest)
 *
 * Runs in whatever engine the environment selects — the tools agent by default
 * (spec 24), the old router with AI_AGENT_MODE=pipeline. Section 6 needs the
 * dev server running (its pg-boss worker drains the queued rebuilds).
 *
 * Runs on a throwaway shop and removes it with the app's real uninstall purge,
 * which is itself asserted: nothing may survive it.
 */
import { randomBytes } from "node:crypto";

try {
  process.loadEnvFile(".env");
} catch {
  // no .env — use the ambient environment
}
// The purge lives in jobs/handlers, which imports shopify.server, which refuses
// to load without these. Placeholders only — this suite never calls Shopify.
process.env.SHOPIFY_API_KEY ||= "qa-placeholder-key";
process.env.SHOPIFY_API_SECRET ||= "qa-placeholder-secret";
process.env.SHOPIFY_APP_URL ||= "http://localhost:3000";

const DOMAIN = `qa-ds-${randomBytes(4).toString("hex")}.myshopify.com`;
const LAMP_GID = "gid://shopify/Product/990000001";

const results: { name: string; pass: boolean; detail: string }[] = [];
let retries = 0;

function ok(name: string, pass: boolean, detail = ""): void {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}
function section(title: string): void {
  console.log(`\n── ${title}`);
}

interface Turn {
  outcome: string;
  text: string;
  cards: { title: string }[];
}

async function main(): Promise<number> {
  const db = (await import("../../app/db.server")).default;
  const { runPipeline } = await import("../../app/lib/pipeline/index.server");
  const { invalidateShopConfig } = await import("../../app/lib/config/shop-config.server");
  const { shopSettingsSchema } = await import("../../app/lib/settings/schemas");
  const { loadShopSettings } = await import("../../app/lib/settings/save.server");
  const { embedProducts } = await import("../../app/lib/ingestion/metafields.server");
  const { productEmbeddingText, embedText } = await import("../../app/lib/embeddings/embedding.server");
  const { rebuildContentBridge, ensureBridgeSource } = await import("../../app/lib/ingestion/content-sync.server");
  const { ingestSource } = await import("../../app/lib/ingestion/knowledge-ingest.server");
  const { createSource, deleteSource } = await import("../../app/lib/ingestion/sources.server");
  const { saveFaq, deleteFaq, ensureDefaultCategory } = await import("../../app/lib/faq/faq.server");
  const { saveCuratedAnswer } = await import("../../app/lib/curated/save.server");
  const { saveRecommendation, setRecommendationStatus } = await import("../../app/lib/instructions/save.server");
  const { knowledgeSearch } = await import("../../app/lib/search/knowledge-search.server");
  const { grantQuota } = await import("../../app/lib/billing/quota-grants.server");
  const { cleanupShop } = await import("../../app/lib/jobs/handlers.server");

  const shop = await db.shop.create({
    data: { domain: DOMAIN, name: "QA data sources", plan: "plus", currency: "USD" },
  });
  const shopId = shop.id;
  let sender: import("pg-boss").PgBoss | undefined;
  // Tools mode (spec 24 agent) is the default; AI_AGENT_MODE=pipeline runs the
  // old router + lanes. The assertions are about what the shopper reads
  // (reply text, cards, the done-frame outcome), so they hold in both modes.
  const { agentModeEnabled } = await import("../../app/lib/pipeline/agent.server");
  console.log(`throwaway shop ${DOMAIN} · engine: ${agentModeEnabled() ? "tools (default)" : "pipeline (AI_AGENT_MODE=pipeline)"}`);

  // ── helpers ────────────────────────────────────────────────────────────
  const turn = async (message: string): Promise<Turn> => {
    const sessionId = `qa-ds-${randomBytes(5).toString("hex")}`;
    const out: Turn = { outcome: "", text: "", cards: [] };
    for await (const f of runPipeline({ shopId, sessionId, message, isTest: true })) {
      if (f.type === "token" || f.type === "message") out.text += f.text;
      if (f.type === "cards") out.cards = f.cards as { title: string }[];
      if (f.type === "done") out.outcome = f.outcome;
    }
    return out;
  };
  /** A PRESENCE check gets one retry — model wording varies run to run, and a
   *  fact stated once in a paraphrase is still a fact learned. Absence checks
   *  never retry: a leaked fact is a leak whatever the odds. */
  const turnUntil = async (message: string, pass: (t: Turn) => boolean): Promise<Turn> => {
    const first = await turn(message);
    if (pass(first)) return first;
    retries++;
    return turn(message);
  };
  const says = (t: Turn, re: RegExp) => re.test(t.text) || t.cards.some((c) => re.test(c.title));
  const brief = (t: Turn) =>
    `${t.outcome} · "${t.text.replace(/\s+/g, " ").trim().slice(0, 110)}"${t.cards.length ? ` · cards: ${t.cards.map((c) => c.title).join(" | ")}` : ""}`;
  /** Retrieval layer: the top-3 knowledgeSearch chunks — the same search the
   *  tools agent's store-info preload/tool and the old question lane ground on. */
  const retrieves = async (question: string, re: RegExp): Promise<boolean> => {
    const hits = await knowledgeSearch(shopId, await embedText(question, { shopId }), 3);
    return hits.some((h) => re.test(`${h.topic} ${h.body}`));
  };
  const setLearn = async (kind: "products" | "collections" | "discounts" | "pages" | "blogs", on: boolean) => {
    const current = await loadShopSettings(shopId);
    const settings = shopSettingsSchema.parse({ ...current, learn: { ...current.learn, [kind]: on } });
    await db.shopSettings.upsert({
      where: { shopId },
      update: { settings: settings as object },
      create: { shopId, settings: settings as object },
    });
    invalidateShopConfig(shopId);
    // Same follow-up the Training route runs: pages/blogs reach the agent only
    // through their bridge, so the switch means nothing until it is rebuilt.
    if (kind === "pages" || kind === "blogs") await rebuildContentBridge(shopId, kind, { inline: true });
  };

  try {
    // ── seed every source ────────────────────────────────────────────────
    section("Seeding one invented fact per source");
    const lamp = await db.product.create({
      data: {
        shopId, shopifyProductId: LAMP_GID, title: "Quillfeather Aurora Lamp",
        description: "A hand-blown glass table lamp made in the village of Vesterholm, with a brass dimmer.",
        productType: "Lamp", tags: ["lamp", "lighting"], price: 42, stock: 5,
        status: "active", publishedOnline: true, learnEnabled: true,
      },
    });
    await embedProducts(shopId, [{ id: lamp.id, text: productEmbeddingText(lamp) }]);
    await db.collection.create({
      data: {
        shopId, shopifyCollectionId: "gid://shopify/Collection/990000001",
        title: "Zephyr Nomad Collection", description: "Travel-sized lanterns", learnEnabled: true,
      },
    });
    const discount = await db.discount.create({
      data: {
        shopId, shopifyDiscountId: "gid://shopify/DiscountCodeNode/990000001",
        title: "Moonraker sale", summary: "47% off every lamp", code: "MOONRAKER47",
        status: "active", method: "code", learnEnabled: true,
      },
    });
    const page = await db.storePage.create({
      data: {
        shopId, shopifyPageId: "gid://shopify/Page/990000001", title: "Our workshop", handle: "our-workshop",
        bodyText: "Our workshop is open to visitors every Saturday from 10am to 2pm at 14 Larkspur Lane, Vesterholm.",
        isPublished: true, learnEnabled: true,
      },
    });
    await rebuildContentBridge(shopId, "pages", { inline: true });
    await db.blogArticle.create({
      data: {
        shopId, shopifyArticleId: "gid://shopify/Article/990000001", blogTitle: "Care guides",
        title: "Caring for Aurora glass", handle: "caring-for-aurora-glass",
        bodyText: "Clean the glass shade only with a soft cloth dampened in rosewater. Never use vinegar on it.",
        isPublished: true, learnEnabled: true,
      },
    });
    await rebuildContentBridge(shopId, "blogs", { inline: true });
    const categoryId = await ensureDefaultCategory(shopId);
    const faqId = await saveFaq(shopId, {
      question: "Do you offer engraving?",
      answerHtml: "<p>Yes. Hand engraving is done by our artisan Bramwell Oakes and takes 9 working days.</p>",
      status: "published", categoryId,
    });
    const file = await createSource(
      shopId,
      {
        type: "file", name: "warranty.txt", title: "Warranty terms", mime: "text/plain",
        bytes: Buffer.from("Warranty: every Quillfeather lamp carries a 17-year warranty against cracking, handled by the Glimmerholt service desk."),
      },
      { enqueueIngest: false },
    );
    await ingestSource(shopId, file.id);
    // A policy re-reads the live policy from Shopify; this shop has no session,
    // so ingest must fall back to the snapshot (fail-soft) rather than error.
    const policy = await createSource(
      shopId,
      {
        type: "policy", policyType: "REFUND_POLICY", title: "Refund policy",
        body: "Refunds are accepted within 61 days of delivery. Returns are processed by the Kestrelmoor returns centre.",
      },
      { enqueueIngest: false },
    );
    const policyIngest = await ingestSource(shopId, policy.id).then(() => null, (e: Error) => e.message);
    const curated = await saveCuratedAnswer(shopId, {
      question: "Do you ship lamps overseas?",
      talkingPoints: "Yes — overseas orders travel with Albatross Freight in padded crates.",
      productIds: [LAMP_GID],
      status: "published",
    });
    if (!curated.ok) throw new Error(`curated seed failed: ${curated.error}`);
    const ruleId = await saveRecommendation(shopId, {
      title: "Housewarming gifts",
      triggerQuestions: ["What is a good housewarming gift?"],
      productIds: [LAMP_GID], status: "active",
    });
    const sources = await db.dataSource.findMany({ where: { shopId }, select: { type: true, status: true, chunkCount: true } });
    console.log(`  seeded — sources: ${sources.map((s) => `${s.type}:${s.status}/${s.chunkCount}`).join(", ")}`);
    ok("policy source ingests on a shop Shopify cannot be read for (snapshot fallback)", policyIngest === null, policyIngest ?? "");
    ok(
      "every knowledge source is active with embedded chunks",
      sources.every((s) => s.status === "active" && s.chunkCount > 0),
      sources.filter((s) => s.status !== "active" || s.chunkCount === 0).map((s) => `${s.type}:${s.status}/${s.chunkCount}`).join(", "),
    );

    // Questions, each aimed at exactly one source.
    const Q = {
      product: "Do you have the Quillfeather Aurora lamp?",
      collection: "What collections do you have?",
      discount: "Do you have any discount codes right now?",
      page: "Can I visit your workshop, and when is it open?",
      article: "What should I use to clean the glass shade, and what should I avoid?",
      faq: "Do you offer engraving?",
      file: "How long is the warranty on your lamps?",
      policy: "What is your refund policy?",
      curated: "Do you ship lamps overseas?",
      rule: "What is a good housewarming gift?",
    };
    const F = {
      product: /quillfeather/i,
      collection: /zephyr/i,
      discount: /moonraker47/i,
      page: /larkspur/i,
      article: /rosewater/i,
      faq: /bramwell/i,
      file: /glimmerholt|17[- ]year/i,
      policy: /kestrelmoor|61 days/i,
      curated: /albatross/i,
    };

    // ── 1. everything ON: each source reaches the answer ─────────────────
    section("1. Every source ON — the agent answers from it");
    for (const key of ["page", "article", "faq", "file", "policy"] as const) {
      ok(`${key}: retrieval hands the model its chunk`, await retrieves(Q[key], F[key]));
    }
    for (const key of ["product", "collection", "discount", "page", "article", "faq", "file", "policy", "curated"] as const) {
      const t = await turnUntil(Q[key], (x) => says(x, F[key]));
      ok(`${key}: the answer uses it`, says(t, F[key]), brief(t));
    }
    {
      const t = await turnUntil(Q.rule, (x) => x.outcome === "recommendation" && says(x, F.product));
      ok("recommendation rule: its trigger shows the rule's product", t.outcome === "recommendation" && says(t, F.product), brief(t));
    }

    // ── 2. per-row switches ──────────────────────────────────────────────
    section("2. Per-row switches (master still ON) — each removes exactly its row");
    await db.product.update({ where: { id: lamp.id }, data: { learnEnabled: false } });
    {
      const t = await turn(Q.product);
      ok("product learnEnabled off → no card for it", !t.cards.some((c) => F.product.test(c.title)), brief(t));
    }
    {
      const t = await turn(Q.rule);
      ok("product learnEnabled off → a recommendation rule does not card it either", !t.cards.some((c) => F.product.test(c.title)), brief(t));
    }
    await db.product.update({ where: { id: lamp.id }, data: { learnEnabled: true } });

    await db.collection.updateMany({ where: { shopId }, data: { learnEnabled: false } });
    {
      const t = await turn(Q.collection);
      ok("collection learnEnabled off → not named", !says(t, F.collection), brief(t));
    }
    await db.collection.updateMany({ where: { shopId }, data: { learnEnabled: true } });

    await db.discount.update({ where: { id: discount.id }, data: { learnEnabled: false } });
    {
      const t = await turn(Q.discount);
      ok("discount learnEnabled off → code never quoted", !says(t, F.discount), brief(t));
    }
    await db.discount.update({ where: { id: discount.id }, data: { learnEnabled: true, endsAt: new Date(Date.now() - 86_400_000) } });
    {
      const t = await turn(Q.discount);
      ok("an EXPIRED discount is never quoted", !says(t, F.discount), brief(t));
    }
    await db.discount.update({ where: { id: discount.id }, data: { endsAt: null } });

    await db.storePage.update({ where: { id: page.id }, data: { learnEnabled: false } });
    await rebuildContentBridge(shopId, "pages", { inline: true });
    ok("page learnEnabled off → bridge no longer retrieves it", !(await retrieves(Q.page, F.page)));
    {
      const t = await turn(Q.page);
      ok("page learnEnabled off → answer no longer knows it", !says(t, F.page), brief(t));
    }
    await db.storePage.update({ where: { id: page.id }, data: { learnEnabled: true } });
    await rebuildContentBridge(shopId, "pages", { inline: true });

    await saveFaq(shopId, {
      id: faqId, question: "Do you offer engraving?",
      answerHtml: "<p>Yes. Hand engraving is done by our artisan Bramwell Oakes and takes 9 working days.</p>",
      status: "draft", categoryId,
    });
    ok("FAQ set to draft → no longer retrieved", !(await retrieves(Q.faq, F.faq)));
    {
      const t = await turn(Q.faq);
      ok("FAQ set to draft → answer no longer uses it", !says(t, F.faq), brief(t));
    }
    await saveFaq(shopId, {
      id: faqId, question: "Do you offer engraving?",
      answerHtml: "<p>Yes. Hand engraving is done by our artisan Bramwell Oakes and takes 9 working days.</p>",
      status: "published", categoryId,
    });
    ok("FAQ republished → retrieved again", await retrieves(Q.faq, F.faq));

    // What the Training route's file edit does for "inactive".
    await db.dataSource.updateMany({ where: { id: file.id, shopId }, data: { status: "inactive" } });
    ok("file source set inactive → no longer retrieved", !(await retrieves(Q.file, F.file)));
    {
      const t = await turn(Q.file);
      ok("file source set inactive → answer no longer uses it", !says(t, F.file), brief(t));
    }
    await db.dataSource.updateMany({ where: { id: file.id, shopId }, data: { status: "active" } });

    await saveCuratedAnswer(shopId, {
      id: curated.id, question: "Do you ship lamps overseas?",
      talkingPoints: "Yes — overseas orders travel with Albatross Freight in padded crates.", status: "draft",
    });
    {
      const t = await turn(Q.curated);
      ok("curated answer set to draft → not served", t.outcome !== "curated" && !says(t, F.curated), brief(t));
    }
    await saveCuratedAnswer(shopId, {
      id: curated.id, question: "Do you ship lamps overseas?",
      talkingPoints: "Yes — overseas orders travel with Albatross Freight in padded crates.", status: "published",
    });

    await setRecommendationStatus(shopId, ruleId, "inactive");
    {
      const t = await turn(Q.rule);
      ok("recommendation rule inactive → it no longer fires", t.outcome !== "recommendation", brief(t));
    }
    await setRecommendationStatus(shopId, ruleId, "active");

    // ── 3. master switches ───────────────────────────────────────────────
    section("3. Master \"Learn …\" switches — OFF removes the whole data type");
    await setLearn("products", false);
    {
      const t = await turn(Q.product);
      ok("Learn products OFF → no product card", !t.cards.some((c) => F.product.test(c.title)), brief(t));
    }
    {
      // Spec 07: "Master OFF ⇒ the AI must not use that data type at all."
      const t = await turn(Q.rule);
      ok(
        "Learn products OFF → a recommendation rule shows no product card either",
        !t.cards.some((c) => F.product.test(c.title)),
        brief(t),
      );
    }
    {
      const t = await turnUntil(Q.curated, (x) => says(x, F.curated));
      ok(
        "Learn products OFF → a curated answer still serves its text, without the product card",
        t.outcome === "curated" && says(t, F.curated) && !t.cards.some((c) => F.product.test(c.title)),
        brief(t),
      );
    }
    await setLearn("products", true);

    await setLearn("collections", false);
    {
      const t = await turn(Q.collection);
      ok("Learn collections OFF → collections never named", !says(t, F.collection), brief(t));
    }
    await setLearn("collections", true);

    await setLearn("discounts", false);
    {
      const t = await turn(Q.discount);
      ok("Learn discounts OFF → no code quoted", !says(t, F.discount), brief(t));
    }
    await setLearn("discounts", true);

    await setLearn("pages", false);
    {
      const bridge = await db.dataSource.findFirst({ where: { shopId, type: "store_pages" }, select: { status: true, chunkCount: true } });
      ok("Learn pages OFF → bridge emptied but not errored", bridge?.status === "active" && bridge.chunkCount === 0, JSON.stringify(bridge));
      const t = await turn(Q.page);
      ok("Learn pages OFF → answer no longer knows the page", !says(t, F.page), brief(t));
    }
    await setLearn("pages", true);
    ok("Learn pages back ON → retrieved again", await retrieves(Q.page, F.page));

    await setLearn("blogs", false);
    {
      const t = await turn(Q.article);
      ok("Learn blogs OFF → answer no longer knows the article", !says(t, F.article), brief(t));
    }
    await setLearn("blogs", true);
    ok("Learn blogs back ON → retrieved again", await retrieves(Q.article, F.article));

    // ── 4. deletion ──────────────────────────────────────────────────────
    section("4. Deletion — nothing a merchant deletes may still be answered");
    await deleteFaq(shopId, faqId);
    ok("deleted FAQ → not retrieved", !(await retrieves(Q.faq, F.faq)));
    await deleteSource(shopId, file.id);
    ok("deleted file source → not retrieved", !(await retrieves(Q.file, F.file)));
    ok(
      "deleted file source → no orphan chunks left behind",
      (await db.knowledge.count({ where: { shopId, dataSourceId: file.id } })) === 0,
    );
    {
      const t = await turn(Q.file);
      ok("deleted file source → answer no longer uses it", !says(t, F.file), brief(t));
    }

    // ── 5. instructions ──────────────────────────────────────────────────
    section("5. Instructions — the agent follows what the merchant configured");
    const SIGN_OFF = "GUIDELINES:\n- End every reply with the exact phrase: Glow on!";
    await db.persona.upsert({
      where: { shopId },
      // Behaviours = the Instructions → General box, the only instruction text
      // a merchant can edit (tuning event 2026-09-11: the prompt used to ignore it).
      create: { shopId, behaviours: SIGN_OFF },
      update: { behaviours: SIGN_OFF },
    });
    invalidateShopConfig(shopId);
    {
      const t = await turnUntil("Hi there", (x) => /glow on/i.test(x.text));
      ok("Behaviours instruction is followed in small talk", /glow on/i.test(t.text), brief(t));
    }
    {
      const t = await turnUntil(Q.policy, (x) => /glow on/i.test(x.text));
      ok("Behaviours instruction is followed in a knowledge answer too", /glow on/i.test(t.text) && says(t, F.policy), brief(t));
    }
    await db.guardrails.upsert({
      where: { shopId },
      create: { shopId, bannedTopics: ["politics", "elections"] },
      update: { bannedTopics: ["politics", "elections"] },
    });
    invalidateShopConfig(shopId);
    {
      const t = await turn("Who should I vote for in the next election?");
      ok("banned topic is refused", t.outcome === "blocked", brief(t));
    }
    const offTopic = "I can only help with Quillfeather lamps and lighting.";
    await db.persona.update({
      where: { shopId },
      data: { behaviours: "", scope: "Quillfeather sells lamps and lighting only.", offTopicMessage: offTopic },
    });
    invalidateShopConfig(shopId);
    {
      const t = await turn("What is the capital of Australia?");
      ok("configured store scope → the merchant's own off-topic message", t.outcome === "off_topic" && t.text.includes(offTopic), brief(t));
    }
    {
      // The same scope must not turn away a product the store actually sells.
      const t = await turnUntil(Q.product, (x) => x.cards.some((c) => F.product.test(c.title)));
      ok("configured store scope still answers an in-catalogue product", t.cards.some((c) => F.product.test(c.title)), brief(t));
    }

    // ── 6. the real toggle path: queued rebuild ──────────────────────────
    // The Training route does NOT rebuild inline — it enqueues a job and marks
    // the bridge pending. Since spec 23 §1.2 an ENABLED source keeps serving its
    // last good chunks while pending (knowledgeSearch excludes only "inactive"),
    // so a click never blanks the bridge; the switch takes effect when the
    // worker has rebuilt it. A merchant-INACTIVE source is the opposite: a
    // re-ingest must never flip it back into service (QA2-A1).
    section("6. Queued rebuild (what a merchant's click actually does)");
    // Send-only queue client. enqueue() would otherwise start() the app's own
    // queue, which registers EVERY job handler — turning this test process into
    // a worker on the shared queue. The job could then be drained by the test
    // itself (proving nothing about the app's worker), and a run that failed
    // to exit stayed a live worker picking up real shops' jobs.
    const { PgBoss } = await import("pg-boss");
    sender = new PgBoss({ connectionString: process.env.DATABASE_URL!, supervise: false, schedule: false });
    await sender.start();
    global.pgBossGlobal = { boss: sender, started: Promise.resolve() };
    const bridgeId = await ensureBridgeSource(shopId, "pages");
    const readBridge = () => db.dataSource.findFirst({ where: { id: bridgeId }, select: { status: true, chunkCount: true, metadata: true } });
    const drain = async () => {
      const deadline = Date.now() + 90_000;
      let b = await readBridge();
      while (b?.status === "pending" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        b = await readBridge();
      }
      return b;
    };
    const drainDetail = (b: Awaited<ReturnType<typeof readBridge>>) => {
      const err = (b?.metadata as { error?: string } | null)?.error;
      return b?.status === "pending"
        ? "still pending — no app worker picked the job up (is the dev server running?)"
        : `status=${b?.status}${err ? ` error=${err}` : ""}`;
    };

    // 6a. Merchant switches the page OFF → the route queues a rebuild.
    const chunksBefore = (await readBridge())?.chunkCount ?? 0;
    await db.storePage.update({ where: { id: page.id }, data: { learnEnabled: false } });
    await rebuildContentBridge(shopId, "pages");
    {
      const before = await readBridge();
      const served = await retrieves(Q.page, F.page);
      const after = await readBridge();
      const stillPending = before?.status === "pending" && after?.status === "pending";
      ok(
        "while the rebuild is queued the bridge keeps serving its last good chunks (spec 23 §1.2)",
        // If the worker drained the job between the two reads there is no
        // pending window left to observe — the drain check below covers it.
        !stillPending || (served && (after?.chunkCount ?? 0) === chunksBefore && chunksBefore > 0),
        stillPending ? `pending, served=${served}, chunks ${chunksBefore}→${after?.chunkCount}` : `worker drained before the check (status=${after?.status})`,
      );
    }
    {
      const b = await drain();
      ok(
        "the APP's worker (dev server) drains the queued rebuild within 90s and the switched-off page is gone",
        b?.status === "active" && !(await retrieves(Q.page, F.page)),
        drainDetail(b),
      );
      if (b?.status === "active") {
        const t = await turn(Q.page);
        ok("…and after the drain the answer no longer knows the page", !says(t, F.page), brief(t));
      }
    }
    // 6b. Switch it back ON through the same queued path.
    await db.storePage.update({ where: { id: page.id }, data: { learnEnabled: true } });
    await rebuildContentBridge(shopId, "pages");
    {
      const b = await drain();
      ok(
        "switched back ON: the worker's rebuild makes the page answerable again",
        b?.status === "active" && (await retrieves(Q.page, F.page)),
        drainDetail(b),
      );
      if (b?.status !== "active") await rebuildContentBridge(shopId, "pages", { inline: true });
    }

    // 6c. QA2-A1: a merchant-INACTIVE source stays out of service across a
    //     re-ingest (serve-stale applies to enabled sources only).
    await db.dataSource.updateMany({ where: { id: policy.id, shopId }, data: { status: "inactive" } });
    await ingestSource(shopId, policy.id).catch(() => undefined);
    {
      const row = await db.dataSource.findFirst({ where: { id: policy.id, shopId }, select: { status: true } });
      ok("an inactive source stays inactive after a re-ingest", row?.status === "inactive", `status=${row?.status}`);
      ok("…and its chunks are not retrieved", !(await retrieves(Q.policy, F.policy)));
      const t = await turn(Q.policy);
      ok("…and the answer does not use it", !says(t, F.policy), brief(t));
    }
    await db.dataSource.updateMany({ where: { id: policy.id, shopId }, data: { status: "active" } });

    // ── 7. purge ─────────────────────────────────────────────────────────
    section("7. Uninstall purge leaves nothing behind");
    await grantQuota(shopId, { dimension: "conversations", amount: 5, reason: "qa", grantedBy: "qa" });
  } finally {
    // An open pg-boss client keeps the event loop alive — the process would
    // print its results and never exit (three runs did, for up to an hour).
    if (sender) {
      await Promise.race([sender.stop({ graceful: false }), new Promise((r) => setTimeout(r, 5000))]).catch(() => undefined);
      global.pgBossGlobal = undefined;
    }
    await cleanupShop(DOMAIN).catch((e) => console.log(`  cleanupShop threw: ${e}`));
    const left: string[] = [];
    const tables: [string, () => Promise<number>][] = [
      ["products", () => db.product.count({ where: { shopId } })],
      ["collections", () => db.collection.count({ where: { shopId } })],
      ["discounts", () => db.discount.count({ where: { shopId } })],
      ["store_pages", () => db.storePage.count({ where: { shopId } })],
      ["blog_articles", () => db.blogArticle.count({ where: { shopId } })],
      ["data_sources", () => db.dataSource.count({ where: { shopId } })],
      ["knowledge", () => db.knowledge.count({ where: { shopId } })],
      ["faqs", () => db.faq.count({ where: { shopId } })],
      ["curated_answers", () => db.curatedAnswer.count({ where: { shopId } })],
      ["recommendations", () => db.recommendation.count({ where: { shopId } })],
      ["personas", () => db.persona.count({ where: { shopId } })],
      ["guardrails", () => db.guardrails.count({ where: { shopId } })],
      ["conversations", () => db.conversation.count({ where: { shopId } })],
      ["quota_grants", () => db.quotaGrant.count({ where: { shopId } })],
    ];
    for (const [name, count] of tables) {
      const n = await count();
      if (n > 0) left.push(`${name}=${n}`);
    }
    ok("uninstall purge deletes every shop-scoped row, grants included", left.length === 0, left.join(", "));
    // Test-only: the purge keeps the Shop row as a tombstone by design.
    await db.quotaGrant.deleteMany({ where: { shopId } });
    await db.shop.deleteMany({ where: { id: shopId } });
    await db.$disconnect();
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed${retries ? ` (${retries} presence check${retries === 1 ? "" : "s"} needed a retry)` : ""}`);
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
  return failed.length;
}

if (!process.env.OPENAI_API_KEY) {
  console.log("NOTE: no OPENAI_API_KEY — this suite measures real model answers. Aborting.");
  process.exit(2);
}

main()
  .then((failed) => {
    process.exitCode = failed === 0 ? 0 : 1;
  })
  .catch((error) => {
    console.error("data-sources crashed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    // A crash before the try block would otherwise leave the app singleton's
    // pool open and hang the process after printing (see TEST-CASES.md).
    const db = (await import("../../app/db.server")).default;
    await db.$disconnect().catch(() => undefined);
  });
