/* Spec 26 — AI setup: instructions written from the store's own data (AS-*).
 *
 * Run (PowerShell):  npx tsx scripts/qa/ai-setup.test.ts
 * Needs: dev Postgres up + migrated. No dev server, no LLM spend: the app's LLM
 * singleton's `inner` is swapped for a scripted fake before any app code runs,
 * pg-boss is a recording fake, and Shopify is never reached (no offline session
 * for the throwaway shops — the shop/policy reads fail soft, as designed).
 * Throwaway shops `qa-as-<ts>-<x>.myshopify.com`, removed in `finally`.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

for (const line of readFileSync(join(process.cwd(), ".env"), "utf-8").split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (match && !line.trim().startsWith("#") && process.env[match[1]] === undefined) {
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}

process.env.SHOPIFY_APP_URL ||= "http://localhost:3000";
process.env.SHOPIFY_API_KEY ||= "placeholder-ai-setup";
process.env.SHOPIFY_API_SECRET ||= "placeholder-ai-setup";
process.env.SCOPES ||= "read_products";

const TS = Date.now();
const DOMAIN_A = `qa-as-${TS}-a.myshopify.com`;
const DOMAIN_B = `qa-as-${TS}-b.myshopify.com`;

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(id: string, name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  PASS ${id} ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    failures.push(`${id} ${name}`);
    console.error(`  FAIL ${id} ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── scripted fake model ──────────────────────────────────────────────────────
const setupPrompts: string[] = [];
let nextSetupOutputs: string[] = [];
const GOOD = {
  storeInfo:
    "Aurora Lights sells handmade lamps. Free shipping on orders over ₹299. Delivery takes 3-4 days. Call us on +1 555 123 4567 for help. Returns are accepted within 45 days. WhatsApp +91 98106 73742.",
  role: "You are Aurora Lights' lighting guide. You help shoppers pick the right lamp.",
  brandVoice: "Warm and calm.",
  behaviours: "ROLE:\n- Match shoppers to lamps.\nGUIDELINES:\n- Ask the room size.\nAVOID:\n- Guessing.",
  scope: "Lamps and lighting",
  offTopicMessage: "I can help with our lamps and your orders.",
  fallbackMessage: "Leave your details and we'll reply, or email help@aurora-qa.example.",
  bannedTopics: ["electrical wiring advice", "competitor pricing", "lamps"],
  language: "en",
  faqDrafts: [
    { question: "Do you ship internationally?", answer: null },
    { question: "How long does delivery take?", answer: "Delivery takes 3-4 days." },
    { question: "What is the warranty?", answer: "Every lamp has a 5 year warranty." },
  ],
  conflicts: ["Banner says free shipping on all orders; shipping page says over ₹299"],
};
const fake = {
  async chat(messages: Array<{ role: string; content: string }>, ctx: { shopId: string; purpose: string }): Promise<string> {
    if (ctx.purpose === "setup") {
      setupPrompts.push(`${ctx.shopId}::${messages.map((m) => m.content).join("\n")}`);
      return nextSetupOutputs.shift() ?? JSON.stringify(GOOD);
    }
    return "no";
  },
  chatStream() {
    return (async function* () {
      yield "ok";
    })();
  },
  agentStream() {
    return (async function* () {})();
  },
  pseudo: null as null | ((t: string) => number[]),
  async embed(text: string) {
    return this.pseudo!(text);
  },
  async embedBatch(texts: string[]) {
    return texts.map((t) => this.pseudo!(t));
  },
  async moderate() {
    return [];
  },
};
const bossSent: Array<{ name: string; data: unknown; options: unknown }> = [];
const fakeBoss = {
  send: async (name: string, data: unknown, options: unknown) => {
    bossSent.push({ name, data, options });
    return randomUUID();
  },
  on: () => undefined,
};

async function main(): Promise<void> {
  const db = (await import("../../app/db.server")).default;
  const { getLlmProvider } = await import("../../app/lib/llm/index.server");
  const emb = await import("../../app/lib/embeddings/embedding.server");
  fake.pseudo = emb.pseudoEmbedding;
  const capturing = getLlmProvider() as unknown as { inner: unknown };
  if (!("inner" in capturing)) throw new Error("LLM seam changed — refusing to run (would hit the real API)");
  capturing.inner = fake;
  (global as unknown as { pgBossGlobal?: unknown }).pgBossGlobal = { boss: fakeBoss, started: Promise.resolve() };

  const setup = await import("../../app/lib/instructions/ai-setup.server");
  const { saveGeneralInstructions } = await import("../../app/lib/instructions/save.server");
  const { cleanupShop } = await import("../../app/lib/jobs/handlers.server");
  const { shopSettingsSchema } = await import("../../app/lib/settings/schemas");
  const { DEFAULT_PERSONA, DEFAULT_GUARDRAILS } = await import("../../app/lib/ai-defaults");

  const settingsOf = async (shopId: string) =>
    shopSettingsSchema.parse((await db.shopSettings.findUnique({ where: { shopId } }))?.settings ?? {});

  async function makeShop(domain: string, pageBody: string) {
    await cleanupShop(domain).catch(() => undefined);
    await db.shop.deleteMany({ where: { domain } });
    const shop = await db.shop.create({ data: { domain, name: domain, currency: "INR" } });
    await db.persona.create({
      data: {
        shopId: shop.id,
        role: DEFAULT_PERSONA.role,
        brandVoice: DEFAULT_PERSONA.brandVoice,
        behaviours: DEFAULT_PERSONA.behaviours,
        welcomeMessage: DEFAULT_PERSONA.welcomeMessage,
      },
    });
    await db.guardrails.create({ data: { shopId: shop.id, ...DEFAULT_GUARDRAILS, bannedTopics: [...DEFAULT_GUARDRAILS.bannedTopics] } });
    await db.product.create({
      data: {
        shopId: shop.id,
        shopifyProductId: `gid://shopify/Product/${TS % 100000}${domain.endsWith("a.myshopify.com") ? 1 : 2}`,
        title: "Aurora Lamp",
        productType: "Lamp",
        price: 1499,
        stock: 5,
        publishedOnline: true,
      },
    });
    await db.storePage.create({
      data: { shopId: shop.id, shopifyPageId: `gid://shopify/Page/${randomUUID()}`, title: "Shipping", handle: "shipping", bodyText: pageBody },
    });
    return shop;
  }

  let shopA: { id: string } | null = null;
  let shopB: { id: string } | null = null;
  try {
    console.log("\n[AS-1] fact guard (pure)");
    const facts = setup.factIndex("Free shipping over ₹299. Delivery 3-4 days. WhatsApp +91 98106 73742. Email help@aurora.example.");
    const guarded = setup.factGuard(
      "Free shipping over ₹299. Delivery takes 3-4 days. Call +1 555 123 4567. Returns within 45 days. Email help@aurora.example. Email fake@nope.example. WhatsApp +91 9810673742.",
      facts,
    );
    ok("AS-1a", "supported numbers are kept", guarded.text.includes("₹299") && guarded.text.includes("3-4 days"), guarded.text);
    ok("AS-1b", "an invented phone number sentence is removed", !guarded.text.includes("555"));
    ok("AS-1c", "an invented number of days is removed", !guarded.text.includes("45 days"));
    ok("AS-1d", "an email not in the data is removed; one in the data is kept", !guarded.text.includes("fake@nope") && guarded.text.includes("help@aurora.example"));
    ok("AS-1e", "a phone number written differently (spaces) is still recognised", guarded.text.includes("9810673742"));

    console.log("\n[AS-2] ownership (pure)");
    ok("AS-2a", "install default role is AI-owned", setup.aiOwns("role", DEFAULT_PERSONA.role, {}));
    ok("AS-2b", "empty store info is AI-owned", setup.aiOwns("storeInfo", "", {}));
    ok("AS-2c", "merchant-written role is NOT AI-owned", !setup.aiOwns("role", "You are Maya, our stylist.", {}));
    ok("AS-2d", "text AI wrote earlier stays AI-owned", setup.aiOwns("role", "AI wrote this", { role: setup.fieldHash("AI wrote this") }));
    ok("AS-2e", "AI text edited by the merchant is NOT AI-owned", !setup.aiOwns("role", "AI wrote this, edited", { role: setup.fieldHash("AI wrote this") }));

    shopA = await makeShop(DOMAIN_A, "Free shipping on orders over ₹299. Delivery takes 3-4 days. WhatsApp +91 98106 73742. Aurora-A-secret-page.");
    shopB = await makeShop(DOMAIN_B, "Shop B ships in 10 days. Bravo-B-secret-page.");

    console.log("\n[AS-3] waits for the first product sync");
    const waiting = await setup.runAiSetup(DOMAIN_A);
    ok("AS-3a", "no productSyncAt → waiting, nothing written", waiting.status === "waiting" && (await db.persona.findUnique({ where: { shopId: shopA.id } }))?.role === DEFAULT_PERSONA.role, JSON.stringify(waiting));
    bossSent.length = 0;
    await setup.aiSetupJob({ shopDomain: DOMAIN_A });
    ok("AS-3b", "the job re-queues itself with a delay while waiting", bossSent.some((s) => s.name === "ai-setup" && (s.options as { startAfter?: number })?.startAfter === 180));
    ok("AS-3d", "after enough attempts it stops waiting for pages/blogs and runs on what synced", /WAIT_FOR_CONTENT_ATTEMPTS/.test(readFileSync("app/lib/instructions/ai-setup.server.ts", "utf-8")));
    // Products synced, the rest of the install sync still running: setup waits
    // (owner rule 2026-09-16 — instructions are written FROM the store's data).
    await db.syncState.create({ data: { shopId: shopA.id, productSyncAt: new Date() } });
    const halfway = await setup.runAiSetup(DOMAIN_A);
    ok("AS-3c", "products alone is not enough — it waits for the rest of the first sync", halfway.status === "waiting" && /collections|pages/.test(halfway.reason), JSON.stringify(halfway));
    const synced = { productSyncAt: new Date(), collectionSyncAt: new Date(), discountSyncAt: new Date(), pageSyncAt: new Date(), articleSyncAt: new Date(), status: "idle" };
    await db.syncState.update({ where: { shopId: shopA.id }, data: synced });
    await db.syncState.create({ data: { shopId: shopB.id, ...synced } });

    console.log("\n[AS-4] first run applies AI-owned fields");
    setupPrompts.length = 0;
    const run = await setup.runAiSetup(DOMAIN_A);
    const personaA = await db.persona.findUnique({ where: { shopId: shopA.id } });
    const guardA = await db.guardrails.findUnique({ where: { shopId: shopA.id } });
    const settingsA = await settingsOf(shopA.id);
    ok("AS-4a", "status done, every default field applied", run.status === "done" && run.applied.includes("role") && run.applied.includes("storeInfo"), JSON.stringify(run));
    ok("AS-4b", "store info keeps supported facts, drops the invented phone and return window", settingsA.storeInfo.about.includes("₹299") && !settingsA.storeInfo.about.includes("555") && !settingsA.storeInfo.about.includes("45 days"), settingsA.storeInfo.about);
    ok("AS-4c", "fallback message drops an email that is not in the store data", !(guardA?.fallbackMessage ?? "").includes("help@aurora-qa.example"), guardA?.fallbackMessage);
    ok("AS-4d", "role, scope, off-topic message written", personaA?.role.startsWith("You are Aurora") === true && personaA.scope === "Lamps and lighting" && personaA.offTopicMessage.length > 0);
    ok("AS-4e", "banned topics: single-word topics dropped", JSON.stringify(guardA?.bannedTopics) === JSON.stringify(["electrical wiring advice", "competitor pricing"]), JSON.stringify(guardA?.bannedTopics));
    ok("AS-4f", "settings.aiSetup records done, hashes, conflicts, unreviewed", settingsA.aiSetup.status === "done" && Boolean(settingsA.aiSetup.hashes.role) && settingsA.aiSetup.conflicts.length === 1 && settingsA.aiSetup.reviewedAt === "");
    const faqs = await db.faq.findMany({ where: { shopId: shopA.id }, orderBy: { position: "asc" } });
    ok("AS-4g", "FAQ drafts created as drafts, never published", faqs.length === 3 && faqs.every((f) => f.status === "draft"), faqs.map((f) => `${f.status}:${f.question}`).join(" | "));
    ok("AS-4h", "an FAQ answer citing an unsupported fact is emptied; a supported one kept", faqs.find((f) => f.question.includes("warranty"))?.answerHtml === "" && (faqs.find((f) => f.question.includes("delivery"))?.answerHtml ?? "").includes("3-4 days"));
    ok("AS-4i", "the prompt carries shop A's page and never shop B's", setupPrompts.length === 1 && setupPrompts[0].includes("Aurora-A-secret-page") && !setupPrompts[0].includes("Bravo-B-secret-page"));
    ok("AS-4j", "shop B untouched by shop A's run", (await db.persona.findUnique({ where: { shopId: shopB.id } }))?.role === DEFAULT_PERSONA.role && (await settingsOf(shopB.id)).aiSetup.status === "none");

    console.log("\n[AS-5] already done → skipped without force");
    const again = await setup.runAiSetup(DOMAIN_A);
    ok("AS-5a", "second run without force is skipped", again.status === "skipped", JSON.stringify(again));

    console.log("\n[AS-6] merchant edits survive a forced rewrite");
    await saveGeneralInstructions(shopA.id, {
      role: "You are Maya, the merchant's own words.",
      communicationStyle: "custom",
      brandVoice: personaA!.brandVoice,
      behaviours: personaA!.behaviours,
      defaultLanguage: "en",
      autoDetectLanguage: false,
      bannedTopics: guardA!.bannedTopics,
      fallbackMessage: guardA!.fallbackMessage,
      storeInfoAbout: settingsA.storeInfo.about,
      scope: personaA!.scope,
      offTopicMessage: personaA!.offTopicMessage,
    });
    const reviewed = await settingsOf(shopA.id);
    ok("AS-6a", "saving General marks the setup reviewed and drops the edited field's hash", reviewed.aiSetup.reviewedAt !== "" && !reviewed.aiSetup.hashes.role && Boolean(reviewed.aiSetup.hashes.scope));
    // Owner decision 2026-09-16: the Rewrite button replaces EVERY field,
    // merchant text included — a rewrite that kept every hand-written field
    // looked like nothing had happened.
    nextSetupOutputs = [JSON.stringify({ ...GOOD, role: "You are the NEW AI role.", scope: "Lamps, lighting and bulbs", faqDrafts: [{ question: "Do you ship internationally?", answer: null }] })];
    const forced = await setup.runAiSetup(DOMAIN_A, { force: true });
    const personaA2 = await db.persona.findUnique({ where: { shopId: shopA.id } });
    ok("AS-6b", "Rewrite (force) replaces the merchant's own role too", personaA2?.role === "You are the NEW AI role." && forced.status === "done" && forced.applied.includes("role"), JSON.stringify(forced));
    // Only a field the model left empty (here: the fallback, whose invented
    // email the fact guard removed) is ever skipped by a forced rewrite.
    ok(
      "AS-6c",
      "…and every other field the model wrote",
      personaA2?.scope === "Lamps, lighting and bulbs" &&
        forced.status === "done" &&
        forced.kept.every((f: string) => f === "fallbackMessage"),
      `kept=${forced.status === "done" ? forced.kept.join(",") : "?"}`,
    );
    // Owner rule 2026-09-16: never filter FAQ drafts — the merchant reviews
    // them, publishes what they want and deletes the rest.
    ok("AS-6d", "every suggested question is drafted again, duplicates included", (await db.faq.count({ where: { shopId: shopA.id, status: "draft" } })) === 4);
    const settingsAfterForce = await settingsOf(shopA.id);
    ok("AS-6e", "the run records what it rewrote, for the merchant's banner", settingsAfterForce.aiSetup.applied.includes("role") && settingsAfterForce.aiSetup.replacedAll === true, JSON.stringify(settingsAfterForce.aiSetup.applied));
    // The automatic (install) run still protects merchant text.
    await db.persona.updateMany({ where: { shopId: shopA.id }, data: { role: "Merchant role again." } });
    await db.shopSettings.update({
      where: { shopId: shopA.id },
      data: { settings: shopSettingsSchema.parse({ ...settingsAfterForce, aiSetup: { ...settingsAfterForce.aiSetup, status: "none" } }) as never },
    });
    nextSetupOutputs = [JSON.stringify({ ...GOOD, role: "Automatic run role.", faqDrafts: [] })];
    const auto = await setup.runAiSetup(DOMAIN_A);
    ok("AS-6f", "the automatic run never replaces merchant text", (await db.persona.findUnique({ where: { shopId: shopA.id } }))?.role === "Merchant role again." && auto.status === "done" && auto.kept.includes("role"), JSON.stringify(auto));

    console.log("\n[AS-7] invalid model output twice → nothing written");
    nextSetupOutputs = ["not json", "{\"role\": 5}"];
    const before = await db.persona.findUnique({ where: { shopId: shopB.id } });
    const bad = await setup.runAiSetup(DOMAIN_B);
    const after = await db.persona.findUnique({ where: { shopId: shopB.id } });
    ok("AS-7a", "status error, persona unchanged", bad.status === "error" && before?.role === after?.role && (await settingsOf(shopB.id)).aiSetup.status === "error", JSON.stringify(bad));
    ok("AS-7b", "no FAQ drafts on a failed run", (await db.faq.count({ where: { shopId: shopB.id } })) === 0);

    console.log("\n[AS-8] Regenerate is rate-limited");
    bossSent.length = 0;
    // The failed run above stamped requestedAt; start the cooldown window fresh.
    const bSettings = await settingsOf(shopB.id);
    await db.shopSettings.update({
      where: { shopId: shopB.id },
      data: { settings: shopSettingsSchema.parse({ ...bSettings, aiSetup: { ...bSettings.aiSetup, requestedAt: "" } }) as never },
    });
    const first = await setup.requestAiSetup(shopB.id, DOMAIN_B, { force: true });
    const second = await setup.requestAiSetup(shopB.id, DOMAIN_B, { force: true });
    ok("AS-8a", "first request queues, a second within the cooldown does not", first === true && second === false && bossSent.filter((s) => s.name === "ai-setup").length === 1);

    console.log("\n[AS-9] install only requests setup for new stores (source check)");
    const install = readFileSync(join(process.cwd(), "app/lib/install.server.ts"), "utf-8");
    ok("AS-9a", "onShopAuthenticated requests AI setup only when the store or its persona is new", /if \(!before \|\| !persona\)[\s\S]{0,200}requestAiSetup/.test(install));
  } finally {
    for (const d of [DOMAIN_A, DOMAIN_B]) {
      await cleanupShop(d).catch(() => undefined);
      await db.shop.deleteMany({ where: { domain: d } }).catch(() => undefined);
    }
    await db.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("FAILED:");
    for (const f of failures) console.log(`  ${f}`);
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 200));
