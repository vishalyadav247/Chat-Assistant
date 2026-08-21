/* Compliance E2E verification (spec 17 acceptance #2–#5).
 * Run with the dev DB up:  npx tsx scripts/verify-compliance.ts
 *
 * Seeds two throwaway shops (A with a row in EVERY domain table + three
 * customers, B as an untouched neighbor sharing customer X's email), then:
 *  1. runs the real customers/redact job handler for customer X → asserts X's
 *     rows are gone, same-shop customer Y/Z rows and neighbor shop B rows are
 *     intact, X's DataRequest email is scrubbed, RedactLog written;
 *  2. builds + downloads the data-request export for customer Y → asserts it
 *     contains exactly Y's data (no Z, no shop B, no X email) and the request
 *     transitions pending → ready → completed;
 *  3. runs the retention-purge handler with shop A's retentionDays=30 →
 *     asserts the 40-day-old conversation (messages + unresolved question)
 *     is deleted and the recent one kept;
 *  4. runs cleanupShop(A) → COUNT-ASSERTS ZERO rows for shop A across every
 *     domain table in prisma/schema.prisma (+ sessions), RedactLog present,
 *     shop B untouched. Cleans all throwaway rows afterwards.
 *
 * The job handlers under test are the REAL registered functions: they are
 * captured by passing a stub pg-boss into registerHandlers(), so no queue
 * infrastructure is needed and no schedules fire.
 */
import { readFileSync } from "node:fs";

// tsx does not load .env — hydrate process.env before any app import (ESM
// static imports hoist, so everything app-side is dynamically imported below).
try {
  const envFile = readFileSync(new URL("../.env", import.meta.url), "utf8");
  for (const line of envFile.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match && !(match[1] in process.env)) process.env[match[1]] = match[2];
  }
} catch {
  /* no .env — rely on ambient environment */
}
// shopify.server needs these to construct the library client (never called here).
process.env.SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY || "verify-compliance-key";
process.env.SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET || "verify-compliance-secret";
process.env.SHOPIFY_APP_URL = process.env.SHOPIFY_APP_URL || "https://example.com";

const DOMAIN_A = "verify-compliance-a.myshopify.com";
const DOMAIN_B = "verify-compliance-b.myshopify.com";
const X_EMAIL = "customer-x@example.com"; // redact target
const Y_EMAIL = "customer-y@example.com"; // data-request target
const Z_EMAIL = "customer-z@example.com"; // untouched neighbor customer
const X_SECRET = "XRAY-SECRET-X";
const Y_SECRET = "YELLOW-KAYAK-Y";
const Z_SECRET = "ZEBRA-SECRET-Z";
const B_SECRET = "SHOPB-SECRET-B";

let failures = 0;
function check(name: string, condition: boolean, detail?: string) {
  console.log(`  ${condition ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures += 1;
}

type JobHandler = (jobs: Array<{ data: never }>) => Promise<void>;

async function main() {
  const { default: db } = await import("../app/db.server");
  const { registerHandlers, cleanupShop, countShopRows, JOBS } = await import(
    "../app/lib/jobs/handlers.server"
  );
  const { buildDataRequestExport, downloadDataRequest, pendingDataRequests } = await import(
    "../app/lib/compliance/data-request.server"
  );
  const { shopSettingsSchema } = await import("../app/lib/settings/schemas");

  // ── Capture the real job handlers via a stub pg-boss ──────────────────────
  const handlers = new Map<string, JobHandler>();
  const stubBoss = {
    createQueue: async () => undefined,
    work: async (name: string, fn: JobHandler) => {
      handlers.set(name, fn);
    },
    schedule: async () => undefined,
    send: async () => undefined,
  };
  await registerHandlers(stubBoss as never);
  const customerRedact = handlers.get(JOBS.customerRedact);
  const retentionPurge = handlers.get(JOBS.retentionPurge);
  const catalogSync = handlers.get(JOBS.catalogSync);
  const metafieldDefinitionsSync = handlers.get(JOBS.metafieldDefinitionsSync);
  if (!customerRedact || !retentionPurge || !catalogSync || !metafieldDefinitionsSync) {
    throw new Error("failed to capture job handlers from registerHandlers()");
  }

  // ── Reset any leftovers from a previous run ────────────────────────────────
  for (const domain of [DOMAIN_A, DOMAIN_B]) {
    const stale = await db.shop.findUnique({ where: { domain } });
    if (stale) {
      await cleanupShop(domain);
      await db.redactLog.deleteMany({ where: { shopId: stale.id } });
      await db.shop.delete({ where: { id: stale.id } });
    }
    await db.session.deleteMany({ where: { shop: domain } });
  }

  // ── Seed shop A: one row in EVERY domain table + three customers ──────────
  console.log("\nSeeding throwaway shops…");
  const shopA = await db.shop.create({ data: { domain: DOMAIN_A, name: "Verify A" } });
  const a = shopA.id;
  const day = 24 * 60 * 60 * 1000;

  await db.session.create({
    data: { id: `verify-compliance-session-${a}`, shop: DOMAIN_A, state: "t", accessToken: "t" },
  });
  await db.product.create({ data: { shopId: a, shopifyProductId: "gid://p/1", title: "Test product" } });
  await db.productMetafieldDefinition.create({
    data: {
      shopId: a,
      ownerType: "PRODUCT",
      namespace: "verify",
      key: "compliance",
      name: "Verify",
      type: "single_line_text_field",
    },
  });
  await db.collection.create({ data: { shopId: a, shopifyCollectionId: "gid://c/1", title: "Test collection" } });
  await db.discount.create({ data: { shopId: a, shopifyDiscountId: "gid://d/1", title: "Test discount" } });
  await db.syncState.create({ data: { shopId: a } });
  const memberA = await db.teamMember.create({
    data: { shopId: a, email: "agent@verify-compliance.test", name: "Agent A", role: "agent", status: "active" },
  });
  await db.teamSession.create({
    data: { tokenHash: `verify-${a}`, shopId: a, memberId: memberA.id, expiresAt: new Date(Date.now() + 60_000) },
  });
  await db.pushSubscription.create({
    data: { shopId: a, memberId: memberA.id, endpoint: `https://push.example/${a}`, p256dh: "k", auth: "a" },
  });
  await db.dataSource.create({ data: { shopId: a, type: "url", name: "Test source" } });
  await db.knowledge.create({ data: { shopId: a, topic: "shipping", body: "Ships in 2 days" } });
  const faqCat = await db.faqCategory.create({ data: { shopId: a, name: "General" } });
  await db.faq.create({ data: { shopId: a, categoryId: faqCat.id, question: "Test FAQ?" } });
  await db.curatedAnswer.create({ data: { shopId: a, question: "Curated question?" } });
  await db.recommendation.create({ data: { shopId: a, title: "Test rec" } });
  await db.crossSellPair.create({ data: { shopId: a, productId: "gid://p/1" } });
  await db.customRecommendation.create({ data: { shopId: a, name: "Custom rec" } });
  await db.persona.create({ data: { shopId: a } });
  await db.guardrails.create({ data: { shopId: a } });
  await db.handoverConfig.create({ data: { shopId: a, config: {} } });
  await db.widgetSettings.create({ data: { shopId: a, settings: {} } });
  await db.shopSettings.create({
    data: {
      shopId: a,
      // parse → plain JSON so the blob matches the schema retentionPurge reads.
      settings: JSON.parse(JSON.stringify(shopSettingsSchema.parse({ retentionDays: 30 }))),
    },
  });
  await db.analyticsEvent.create({ data: { shopId: a, type: "test_event" } });
  await db.metricsDaily.create({ data: { shopId: a, date: new Date(), counters: {} } });
  await db.campaign.create({ data: { shopId: a, name: "Test campaign", templateType: "welcome" } });
  await db.planUsage.create({ data: { shopId: a, periodStart: new Date() } });
  await db.llmUsageDaily.create({
    data: { shopId: a, date: new Date(), model: "gpt-4o-mini", purpose: "reply", calls: 1, promptTokens: 10 },
  });
  // Spec 21: the operator log is shop-attributed, so it must die with the shop.
  await db.appLog.create({
    data: { shopId: a, level: "error", event: "test_event_error", message: "seeded by verify-compliance" },
  });
  // Spec 15: promo redemptions are shop-scoped — they must not survive a purge.
  const promoCode = await db.promoCode.create({
    data: { code: `VERIFY-COMPLIANCE-${Date.now()}`, kind: "percent", value: 10, plans: [], intervals: [] },
  });
  await db.promoRedemption.create({
    data: { shopId: a, promoCodeId: promoCode.id, plan: "pro", interval: "monthly", status: "redeemed" },
  });

  const seedCustomer = async (email: string, secret: string, extra?: { shopifyCustomerId?: string }) => {
    const contact = await db.contact.create({
      data: { shopId: a, email, name: email.split("@")[0], type: "customer", ...extra },
    });
    const convo = await db.conversation.create({
      data: { shopId: a, sessionId: `sess-${email}`, contactId: contact.id, rating: 5, handover: true },
    });
    await db.message.create({
      data: { shopId: a, conversationId: convo.id, role: "in", author: "shopper", content: `Hi, ${secret}` },
    });
    await db.message.create({
      data: { shopId: a, conversationId: convo.id, role: "out", author: "ai", content: `Reply about ${secret}` },
    });
    await db.unresolvedQuestion.create({
      data: { shopId: a, conversationId: convo.id, question: `Unresolved ${secret}` },
    });
    return { contact, convo };
  };
  const x = await seedCustomer(X_EMAIL, X_SECRET, { shopifyCustomerId: "9001" });
  const y = await seedCustomer(Y_EMAIL, Y_SECRET);
  const z = await seedCustomer(Z_EMAIL, Z_SECRET);

  const requestX = await db.dataRequest.create({
    data: { shopId: a, customerEmail: X_EMAIL, dueAt: new Date(Date.now() + 30 * day) },
  });
  const requestY = await db.dataRequest.create({
    data: { shopId: a, customerEmail: Y_EMAIL, dueAt: new Date(Date.now() + 30 * day) },
  });
  // An already-overdue request to exercise the isOverdue flag.
  await db.dataRequest.create({
    data: { shopId: a, customerEmail: Z_EMAIL, dueAt: new Date(Date.now() - 1 * day) },
  });

  // Shop B: neighbor shop whose contact SHARES customer X's email (the
  // strongest tenancy trap for the redact job).
  const shopB = await db.shop.create({ data: { domain: DOMAIN_B, name: "Verify B" } });
  const b = shopB.id;
  const contactB = await db.contact.create({ data: { shopId: b, email: X_EMAIL, type: "customer" } });
  const convoB = await db.conversation.create({
    data: { shopId: b, sessionId: "sess-b", contactId: contactB.id },
  });
  await db.message.create({
    data: { shopId: b, conversationId: convoB.id, role: "in", author: "shopper", content: B_SECRET },
  });
  await db.dataRequest.create({
    data: { shopId: b, customerEmail: X_EMAIL, dueAt: new Date(Date.now() + 30 * day) },
  });
  console.log(`  shop A ${a}, shop B ${b}`);

  // ── 1. customers/redact for customer X (real handler) ─────────────────────
  console.log("\n1. customers/redact job handler (customer X, email + shopify id)…");
  await customerRedact([
    { data: { shopDomain: DOMAIN_A, customerEmail: X_EMAIL, customerId: "9001" } as never },
  ]);
  check("contact X deleted", (await db.contact.count({ where: { shopId: a, email: X_EMAIL } })) === 0);
  check("conversation X deleted", (await db.conversation.count({ where: { shopId: a, id: x.convo.id } })) === 0);
  check("messages X deleted", (await db.message.count({ where: { shopId: a, conversationId: x.convo.id } })) === 0);
  check(
    "unresolved question X deleted",
    (await db.unresolvedQuestion.count({ where: { shopId: a, conversationId: x.convo.id } })) === 0,
  );
  check(
    "DataRequest X email scrubbed",
    (await db.dataRequest.findUnique({ where: { id: requestX.id } }))?.customerEmail === "[redacted]",
  );
  check(
    "RedactLog (type=customer) written",
    (await db.redactLog.count({ where: { shopId: a, type: "customer", completedAt: { not: null } } })) >= 1,
  );
  // Untouched neighbors: same-shop customers Y/Z and neighbor shop B.
  check("contact Y intact", (await db.contact.count({ where: { shopId: a, email: Y_EMAIL } })) === 1);
  check("contact Z intact", (await db.contact.count({ where: { shopId: a, email: Z_EMAIL } })) === 1);
  check(
    "Y/Z messages intact",
    (await db.message.count({ where: { shopId: a, conversationId: { in: [y.convo.id, z.convo.id] } } })) === 4,
  );
  check(
    "shop B contact with SAME email intact (tenancy)",
    (await db.contact.count({ where: { shopId: b, email: X_EMAIL } })) === 1,
  );
  check("shop B message intact (tenancy)", (await db.message.count({ where: { shopId: b } })) === 1);
  check(
    "shop B DataRequest email NOT scrubbed (tenancy)",
    (await db.dataRequest.count({ where: { shopId: b, customerEmail: X_EMAIL } })) === 1,
  );
  // Idempotency (webhooks redeliver).
  await customerRedact([
    { data: { shopDomain: DOMAIN_A, customerEmail: X_EMAIL, customerId: "9001" } as never },
  ]);
  check("re-delivery safe (Y still intact)", (await db.contact.count({ where: { shopId: a, email: Y_EMAIL } })) === 1);

  // ── 2. data-request export for customer Y (exact scope) ───────────────────
  console.log("\n2. buildDataRequestExport / downloadDataRequest (customer Y)…");
  const exportY = await buildDataRequestExport(a, requestY.id);
  const serialized = JSON.stringify(exportY);
  check("export has exactly 1 contact (Y)", exportY.contacts.length === 1 && exportY.contacts[0].email === Y_EMAIL);
  check("export has exactly 1 conversation (Y's)", exportY.conversations.length === 1 && exportY.conversations[0].id === y.convo.id);
  check("export contains Y's full transcript", exportY.conversations[0]?.messages.length === 2 && serialized.includes(Y_SECRET));
  check("export contains Y's survey rating", exportY.conversations[0]?.surveyRating === 5);
  check("export contains Y's unresolved question", exportY.conversations[0]?.unresolvedQuestions.length === 1);
  check("export excludes customer Z data", !serialized.includes(Z_SECRET) && !serialized.includes(Z_EMAIL));
  check("export excludes redacted customer X email", !serialized.includes(X_EMAIL) && !serialized.includes(X_SECRET));
  check("export excludes shop B data (tenancy)", !serialized.includes(B_SECRET));
  const afterBuild = await db.dataRequest.findUnique({ where: { id: requestY.id } });
  check("request pending → ready after build", afterBuild?.status === "ready");
  check("no stored artifact (exportPath null)", afterBuild?.exportPath === null);
  const pending = await pendingDataRequests(a);
  check(
    "pendingDataRequests flags the overdue request",
    pending.some((r) => r.customerEmail === Z_EMAIL && r.isOverdue) &&
      pending.some((r) => r.customerEmail === Y_EMAIL && !r.isOverdue),
  );
  const download = await downloadDataRequest(a, requestY.id);
  const parsed = JSON.parse(download.json) as typeof exportY;
  check("download JSON parses + contains Y transcript", parsed.conversations[0]?.messages.some((m) => m.content.includes(Y_SECRET)));
  const afterDownload = await db.dataRequest.findUnique({ where: { id: requestY.id } });
  check("request completed after download", afterDownload?.status === "completed" && afterDownload.completedAt !== null);

  // ── 3. retention purge (per-shop window) ──────────────────────────────────
  console.log("\n3. retention-purge job handler (shop A retentionDays=30)…");
  const oldConvo = await db.conversation.create({
    data: { shopId: a, sessionId: "sess-old", lastMessageAt: new Date(Date.now() - 40 * day) },
  });
  await db.message.create({
    data: { shopId: a, conversationId: oldConvo.id, role: "in", author: "shopper", content: "old transcript" },
  });
  await db.unresolvedQuestion.create({
    data: { shopId: a, conversationId: oldConvo.id, question: "old unresolved" },
  });
  await retentionPurge([{ data: {} as never }]);
  check("40-day-old conversation purged", (await db.conversation.count({ where: { shopId: a, id: oldConvo.id } })) === 0);
  check("old messages purged", (await db.message.count({ where: { shopId: a, conversationId: oldConvo.id } })) === 0);
  check(
    "old unresolved question purged",
    (await db.unresolvedQuestion.count({ where: { shopId: a, conversationId: oldConvo.id } })) === 0,
  );
  check("recent conversation kept", (await db.conversation.count({ where: { shopId: a, id: y.convo.id } })) === 1);
  check("recent messages kept", (await db.message.count({ where: { shopId: a, conversationId: y.convo.id } })) === 2);
  check(
    "shop B (no retention setting) untouched",
    (await db.conversation.count({ where: { shopId: b } })) === 1,
  );

  // ── 4. shop/redact backstop: cleanupShop zero-row count assertion ─────────
  console.log("\n4. cleanupShop (shop/redact backstop) — zero-row assertion across ALL tables…");
  await cleanupShop(DOMAIN_A);
  // Every shop-scoped model in prisma/schema.prisma, enumerated explicitly.
  const domainTableCounts: Array<[string, number]> = [
    ["products", await db.product.count({ where: { shopId: a } })],
    [
      "product_metafield_definitions",
      await db.productMetafieldDefinition.count({ where: { shopId: a } }),
    ],
    ["collections", await db.collection.count({ where: { shopId: a } })],
    ["discounts", await db.discount.count({ where: { shopId: a } })],
    ["sync_states", await db.syncState.count({ where: { shopId: a } })],
    ["data_sources", await db.dataSource.count({ where: { shopId: a } })],
    ["knowledge", await db.knowledge.count({ where: { shopId: a } })],
    ["faq_categories", await db.faqCategory.count({ where: { shopId: a } })],
    ["faqs", await db.faq.count({ where: { shopId: a } })],
    ["curated_answers", await db.curatedAnswer.count({ where: { shopId: a } })],
    ["recommendations", await db.recommendation.count({ where: { shopId: a } })],
    ["cross_sell_pairs", await db.crossSellPair.count({ where: { shopId: a } })],
    ["unresolved_questions", await db.unresolvedQuestion.count({ where: { shopId: a } })],
    ["custom_recommendations", await db.customRecommendation.count({ where: { shopId: a } })],
    ["personas", await db.persona.count({ where: { shopId: a } })],
    ["guardrails", await db.guardrails.count({ where: { shopId: a } })],
    ["handover_configs", await db.handoverConfig.count({ where: { shopId: a } })],
    ["widget_settings", await db.widgetSettings.count({ where: { shopId: a } })],
    ["shop_settings", await db.shopSettings.count({ where: { shopId: a } })],
    ["conversations", await db.conversation.count({ where: { shopId: a } })],
    ["messages", await db.message.count({ where: { shopId: a } })],
    ["contacts", await db.contact.count({ where: { shopId: a } })],
    ["analytics_events", await db.analyticsEvent.count({ where: { shopId: a } })],
    ["metrics_daily", await db.metricsDaily.count({ where: { shopId: a } })],
    ["campaigns", await db.campaign.count({ where: { shopId: a } })],
    ["plan_usage", await db.planUsage.count({ where: { shopId: a } })],
    ["llm_usage_daily", await db.llmUsageDaily.count({ where: { shopId: a } })],
    ["app_logs", await db.appLog.count({ where: { shopId: a } })],
    ["data_requests", await db.dataRequest.count({ where: { shopId: a } })],
    // Team logins for the standalone web app (spec 18).
    ["team_members", await db.teamMember.count({ where: { shopId: a } })],
    ["team_sessions", await db.teamSession.count({ where: { shopId: a } })],
    ["push_subscriptions", await db.pushSubscription.count({ where: { shopId: a } })],
    // Promo redemptions (spec 15) hold a maxRedemptions slot — they must go too.
    ["promo_redemptions", await db.promoRedemption.count({ where: { shopId: a } })],
    // sessions are keyed by shop domain, not shopId — they hold the offline token.
    ["sessions", await db.session.count({ where: { shop: DOMAIN_A } })],
  ];
  let leftover = 0;
  for (const [table, count] of domainTableCounts) {
    if (count !== 0) {
      leftover += count;
      console.log(`    non-zero: ${table} = ${count}`);
    }
  }
  check(
    `ZERO rows for shop A across all ${domainTableCounts.length} tables`,
    leftover === 0,
    domainTableCounts.map(([t, c]) => `${t}:${c}`).join(" "),
  );
  // The purge's OWN zero-row assertion (D11c) must agree with the script's.
  check(
    "countShopRows() reports no leftovers after cleanupShop",
    (await countShopRows(a, DOMAIN_A)).length === 0,
    JSON.stringify(await countShopRows(a, DOMAIN_A)),
  );
  check(
    "shop row kept, uninstalledAt set",
    (await db.shop.findUnique({ where: { id: a } }))?.uninstalledAt !== null,
  );
  check(
    "RedactLog (type=shop) written",
    (await db.redactLog.count({ where: { shopId: a, type: "shop", completedAt: { not: null } } })) >= 1,
  );
  check("shop B rows intact after A's purge (tenancy)",
    (await db.contact.count({ where: { shopId: b } })) === 1 &&
      (await db.message.count({ where: { shopId: b } })) === 1 &&
      (await db.dataRequest.count({ where: { shopId: b } })) === 1,
  );

  // ── 5. webhook-driven jobs never materialise a Shop row (QA D11a) ─────────
  console.log("\n5. unknown-shop webhook jobs must not create a Shop row…");
  const UNKNOWN_DOMAIN = "verify-compliance-unknown.myshopify.com";
  await db.shop.deleteMany({ where: { domain: UNKNOWN_DOMAIN } });
  await customerRedact([
    { data: { shopDomain: UNKNOWN_DOMAIN, customerEmail: "nobody@example.com" } as never },
  ]);
  await catalogSync([{ data: { shopDomain: UNKNOWN_DOMAIN } as never }]);
  await metafieldDefinitionsSync([{ data: { shopDomain: UNKNOWN_DOMAIN } as never }]);
  check(
    "no Shop row created for an unknown domain",
    (await db.shop.count({ where: { domain: UNKNOWN_DOMAIN } })) === 0,
  );

  // ── Cleanup all throwaway rows (including audit logs from this run) ───────
  console.log("\nCleaning up throwaway shops…");
  await cleanupShop(DOMAIN_B);
  await db.promoRedemption.deleteMany({ where: { shopId: { in: [a, b] } } });
  await db.promoCode.deleteMany({ where: { id: promoCode.id } });
  await db.redactLog.deleteMany({ where: { shopId: { in: [a, b] } } });
  await db.appLog.deleteMany({ where: { shopId: { in: [a, b] } } });
  await db.shop.deleteMany({ where: { id: { in: [a, b] } } });

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exitCode = 1;
  await db.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
