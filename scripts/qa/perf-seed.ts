/* QA performance seeder — generates realistic synthetic volume on a DEDICATED
 * throwaway shop so query plans are exercised at production-like scale.
 *
 *   npx tsx scripts/qa/perf-seed.ts            # seed
 *   npx tsx scripts/qa/perf-seed.ts --clean    # remove the throwaway shop + every row
 *
 * NEVER touches dev-shop.myshopify.com. Everything it writes belongs to
 * PERF_SHOP_DOMAIN and --clean deletes strictly by that shopId.
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

export const PERF_SHOP_DOMAIN = "perf-test.myshopify.com";

// ── Volume targets ──────────────────────────────────────────────────────────
const N_PRODUCTS = 2_000;
const N_CONTACTS = 5_000;
const N_CONVERSATIONS = 20_000;
const N_MESSAGES = 200_000;
const N_EVENTS = 150_000;
const N_KNOWLEDGE = 5_000;
const N_CURATED = 1_000;

const DAY_MS = 24 * 60 * 60 * 1000;
const YEAR_MS = 365 * DAY_MS;

// Deterministic PRNG so re-seeding produces the same distribution.
let seed = 0x2f6e2b1;
function rnd(): number {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x100000000;
}
function pick<T>(items: readonly T[]): T {
  return items[Math.floor(rnd() * items.length)];
}
function int(min: number, max: number): number {
  return min + Math.floor(rnd() * (max - min + 1));
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
/** cuid-shaped 25-char id so index sizes / comparison costs match production. */
function id(prefix: string): string {
  let out = prefix;
  while (out.length < 25) out += ALPHABET[Math.floor(rnd() * ALPHABET.length)];
  return out.slice(0, 25);
}

const WORDS = [
  "silver", "gold", "bracelet", "necklace", "birthstone", "february", "amethyst", "pendant",
  "leather", "wallet", "cotton", "shirt", "organic", "candle", "hand", "poured", "soy", "wax",
  "ceramic", "mug", "stoneware", "matte", "linen", "throw", "blanket", "walnut", "oak", "board",
  "stainless", "steel", "bottle", "insulated", "travel", "vegan", "cruelty", "free", "serum",
  "hydrating", "lightweight", "waterproof", "rfid", "touchscreen", "compact", "gift", "set",
];
const TYPES = ["Jewelry", "Apparel", "Home", "Accessories", "Beauty", "Kitchen", "Outdoor"];
const VENDORS = ["Aurora", "Northwind", "Kestrel", "Marlowe", "Vellum", "Sundry", "Halcyon"];

function sentence(n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(pick(WORDS));
  return out.join(" ");
}

const SHOPPER_LINES = [
  "do you have anything for a february birthstone gift",
  "what is your return policy",
  "how long does shipping take to canada",
  "is this bracelet adjustable",
  "can I get a discount code",
  "do you ship internationally",
  "what materials is the wallet made of",
  "I need something under 30 dollars",
  "is the candle vegan",
  "when will the silver necklace be back in stock",
];
const AI_LINES = [
  "Here are a few options that match what you are after.",
  "Our standard shipping takes 3-5 business days.",
  "Yes, that piece is fully adjustable.",
  "I can help with that — here is what we have in your budget.",
  "Let me check that for you.",
];
const SOURCE_LAYERS = [
  "curated", "router", "buy", "buy_browse", "recommendation", "question",
  "chat", "clarify", "rag_fallback", "handover", null,
];
const EVENT_TYPES = [
  "conversation_started", "turn_completed", "added_to_cart", "recommendation_shown",
  "curated_served", "turn_fell_back", "handover_requested", "human_replied",
  "conversation_resolved", "prechat_submitted", "widget_opened", "contact_converted",
];

async function main(): Promise<void> {
  const clean = process.argv.includes("--clean");
  const { default: db } = await import("../../app/db.server");

  try {
    if (clean) {
      await cleanUp(db);
      return;
    }
    await seedAll(db);
  } finally {
    // MUST await — the shared singleton otherwise keeps the process alive.
    await db.$disconnect();
  }
}

type Db = Awaited<typeof import("../../app/db.server")>["default"];

interface MessageRow {
  id: string;
  conversationId: string;
  shopId: string;
  role: string;
  author: string;
  content: string;
  sourceLayer: string | null;
  seenAt: Date | null;
  createdAt: Date;
}

async function cleanUp(db: Db): Promise<void> {
  const shop = await db.shop.findUnique({ where: { domain: PERF_SHOP_DOMAIN } });
  if (!shop) {
    console.log(`clean: no ${PERF_SHOP_DOMAIN} shop row — nothing to do`);
    return;
  }
  const shopId = shop.id;
  console.log(`clean: removing every row for ${PERF_SHOP_DOMAIN} (${shopId})`);
  const started = Date.now();
  // Order does not matter (no FK constraints in this schema) but messages first
  // keeps the largest delete off the smallest table's lock.
  const steps: [string, () => Promise<{ count: number }>][] = [
    ["messages", () => db.message.deleteMany({ where: { shopId } })],
    ["analytics_events", () => db.analyticsEvent.deleteMany({ where: { shopId } })],
    ["conversations", () => db.conversation.deleteMany({ where: { shopId } })],
    ["contacts", () => db.contact.deleteMany({ where: { shopId } })],
    ["knowledge", () => db.knowledge.deleteMany({ where: { shopId } })],
    ["curated_answers", () => db.curatedAnswer.deleteMany({ where: { shopId } })],
    ["products", () => db.product.deleteMany({ where: { shopId } })],
    ["metrics_daily", () => db.metricsDaily.deleteMany({ where: { shopId } })],
    ["unresolved_questions", () => db.unresolvedQuestion.deleteMany({ where: { shopId } })],
    ["data_sources", () => db.dataSource.deleteMany({ where: { shopId } })],
    ["team_members", () => db.teamMember.deleteMany({ where: { shopId } })],
    ["shop_settings", () => db.shopSettings.deleteMany({ where: { shopId } })],
    ["widget_settings", () => db.widgetSettings.deleteMany({ where: { shopId } })],
    ["handover_configs", () => db.handoverConfig.deleteMany({ where: { shopId } })],
    ["personas", () => db.persona.deleteMany({ where: { shopId } })],
    ["guardrails", () => db.guardrails.deleteMany({ where: { shopId } })],
    ["campaigns", () => db.campaign.deleteMany({ where: { shopId } })],
    ["plan_usage", () => db.planUsage.deleteMany({ where: { shopId } })],
    ["app_logs", () => db.appLog.deleteMany({ where: { shopId } })],
  ];
  for (const [label, run] of steps) {
    const { count } = await run();
    if (count > 0) console.log(`  - ${label}: ${count}`);
  }
  await db.shop.delete({ where: { id: shopId } });
  console.log(`  - shops: 1`);
  console.log(`clean: done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

async function seedAll(db: Db): Promise<void> {
  const t0 = Date.now();
  const shop = await db.shop.upsert({
    where: { domain: PERF_SHOP_DOMAIN },
    update: { plan: "plus", planStatus: "active", aiEnabled: true },
    create: {
      domain: PERF_SHOP_DOMAIN,
      name: "Perf Test Store",
      currency: "USD",
      timezone: "UTC",
      plan: "plus",
      planStatus: "active",
    },
  });
  const shopId = shop.id;
  console.log(`seed: shop ${PERF_SHOP_DOMAIN} = ${shopId}`);

  // Wipe any previous run so counts are exact.
  await cleanRowsOnly(db, shopId);

  await db.persona.upsert({
    where: { shopId },
    update: {},
    create: { shopId, role: "Perf assistant", behaviours: "Be brief." },
  });
  await db.guardrails.upsert({ where: { shopId }, update: {}, create: { shopId } });
  await db.widgetSettings.upsert({
    where: { shopId },
    update: { settings: {} },
    create: { shopId, settings: {} },
  });
  await db.shopSettings.upsert({
    where: { shopId },
    update: { settings: {} },
    create: { shopId, settings: {} },
  });
  await db.handoverConfig.upsert({
    where: { shopId },
    update: { config: {} },
    create: { shopId, config: {} },
  });

  const now = Date.now();

  // ── Team members (assigneeId targets) ────────────────────────────────────
  const memberIds: string[] = [];
  for (let i = 0; i < 6; i++) {
    const m = await db.teamMember.create({
      data: {
        shopId,
        email: `perf-agent-${i}@example.com`,
        name: `Perf Agent ${i}`,
        role: "agent",
        status: "active",
      },
    });
    memberIds.push(m.id);
  }

  // ── Products ─────────────────────────────────────────────────────────────
  const productRows = [];
  for (let i = 0; i < N_PRODUCTS; i++) {
    const stock = rnd() < 0.15 ? 0 : int(1, 200);
    productRows.push({
      id: id("perfp"),
      shopId,
      shopifyProductId: `gid://shopify/Product/9${String(1000000 + i)}`,
      title: `${pick(VENDORS)} ${sentence(3)} ${i}`,
      description: sentence(60),
      productType: pick(TYPES),
      vendor: pick(VENDORS),
      tags: [pick(WORDS), pick(WORDS), pick(WORDS)],
      status: rnd() < 0.05 ? "draft" : "active",
      price: Number((int(500, 40000) / 100).toFixed(2)),
      stock,
      handle: `perf-product-${i}`,
      variants:
        stock === 0 && rnd() < 0.4
          ? [{ id: `gid://shopify/ProductVariant/${i}`, title: "Default", price: 19.99, available: true }]
          : [{ id: `gid://shopify/ProductVariant/${i}`, title: "Default", price: 19.99, available: stock > 0 }],
      metafieldText: `Material: ${pick(WORDS)}\nCare: ${sentence(6)}`,
      learnEnabled: rnd() < 0.97,
    });
  }
  await batchInsert(db, "products", productRows, 500, (chunk) =>
    db.product.createMany({ data: chunk }),
  );
  // Embeddings live in an Unsupported() column — createMany cannot write them.
  // Deterministic per-row pseudo-vector, correlated on the row id so the HNSW
  // graph is a real graph and not 2000 copies of one point.
  console.log("seed: generating product embeddings (SQL)…");
  await db.$executeRawUnsafe(
    `UPDATE "products" p SET "embedding" = (
       SELECT array_agg(((abs(hashtext(p."id" || g::text)) % 2000)::float8 - 1000) / 1000.0
              ORDER BY g)::real[]::vector(1536)
       FROM generate_series(1, 1536) g)
     WHERE p."shopId" = $1`,
    shopId,
  );

  // ── Contacts ─────────────────────────────────────────────────────────────
  const contactIds: string[] = [];
  const contactRows = [];
  for (let i = 0; i < N_CONTACTS; i++) {
    const cid = id("perfk");
    contactIds.push(cid);
    const type = rnd() < 0.2 ? "customer" : rnd() < 0.5 ? "lead" : "anonymous";
    contactRows.push({
      id: cid,
      shopId,
      sessionId: `perf-sess-${i}`,
      name: type === "anonymous" ? null : `Perf Person ${i}`,
      email: type === "anonymous" ? null : `perf.person.${i}@example.com`,
      phone: rnd() < 0.3 ? `+1555${String(1000000 + i)}` : null,
      type,
      channel: pick(["store", "web", "email"]),
      location: pick(["US", "CA", "GB", "AU", "DE", null]),
      marketingOptIn: rnd() < 0.35,
      createdAt: new Date(now - Math.floor(rnd() * YEAR_MS)),
    });
  }
  await batchInsert(db, "contacts", contactRows, 1000, (chunk) =>
    db.contact.createMany({ data: chunk }),
  );

  // ── Conversations ────────────────────────────────────────────────────────
  interface ConvoPlan {
    id: string;
    startedAt: Date;
    lastMessageAt: Date;
    messages: number;
  }
  const plans: ConvoPlan[] = [];
  const convoRows = [];
  for (let i = 0; i < N_CONVERSATIONS; i++) {
    const cid = id("perfv");
    const startedAt = new Date(now - Math.floor(rnd() * YEAR_MS));
    // Conversation length: mostly short, a long tail.
    const messages = rnd() < 0.7 ? int(2, 8) : rnd() < 0.9 ? int(9, 20) : int(21, 60);
    const lastMessageAt = new Date(
      Math.min(now, startedAt.getTime() + messages * int(20_000, 400_000)),
    );
    const status = rnd() < 0.35 ? "open" : "resolved";
    const handover = rnd() < 0.18;
    const blocked = rnd() < 0.03;
    plans.push({ id: cid, startedAt, lastMessageAt, messages });
    convoRows.push({
      id: cid,
      shopId,
      sessionId: `perf-sess-${int(0, N_CONTACTS - 1)}`,
      contactId: rnd() < 0.85 ? pick(contactIds) : null,
      mode: handover && rnd() < 0.6 ? "human" : "ai",
      status,
      outcome: status === "resolved" ? pick(["answered", "handover", "abandoned"]) : null,
      starred: rnd() < 0.07,
      blocked,
      unread: status === "open" ? rnd() < 0.4 : false,
      handover,
      assigneeId: handover && rnd() < 0.7 ? pick(memberIds) : null,
      channel: pick(["store", "web"]),
      isTest: rnd() < 0.02,
      rating: rnd() < 0.25 ? int(1, 5) : null,
      startedAt,
      endedAt: status === "resolved" ? lastMessageAt : null,
      lastMessageAt,
    });
  }
  await batchInsert(db, "conversations", convoRows, 2000, (chunk) =>
    db.conversation.createMany({ data: chunk }),
  );

  // ── Messages ─────────────────────────────────────────────────────────────
  // Distribute N_MESSAGES over the planned per-conversation lengths.
  const plannedTotal = plans.reduce((sum, p) => sum + p.messages, 0);
  const scale = N_MESSAGES / plannedTotal;
  let written = 0;
  let buffer: MessageRow[] = [];
  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return;
    await db.message.createMany({ data: buffer });
    written += buffer.length;
    buffer = [];
    process.stdout.write(`\r  messages: ${written}/${N_MESSAGES}`);
  };
  for (const plan of plans) {
    const count = Math.max(2, Math.round(plan.messages * scale));
    const span = Math.max(1, plan.lastMessageAt.getTime() - plan.startedAt.getTime());
    for (let m = 0; m < count && written + buffer.length < N_MESSAGES; m++) {
      const inbound = m % 2 === 0;
      buffer.push({
        id: id("perfm"),
        conversationId: plan.id,
        shopId,
        role: inbound ? "in" : rnd() < 0.05 ? "sys" : "out",
        author: inbound ? "shopper" : rnd() < 0.15 ? "agent" : "ai",
        content: inbound ? pick(SHOPPER_LINES) : pick(AI_LINES),
        sourceLayer: inbound ? null : pick(SOURCE_LAYERS),
        seenAt: rnd() < 0.6 ? new Date(plan.lastMessageAt) : null,
        createdAt: new Date(plan.startedAt.getTime() + Math.floor((span * m) / count)),
      });
      if (buffer.length >= 5000) await flush();
    }
    if (written + buffer.length >= N_MESSAGES) break;
  }
  await flush();
  process.stdout.write("\n");

  // ── Analytics events ─────────────────────────────────────────────────────
  const eventRows = [];
  for (let i = 0; i < N_EVENTS; i++) {
    const convo = plans[Math.floor(rnd() * plans.length)];
    eventRows.push({
      id: id("perfe"),
      shopId,
      type: pick(EVENT_TYPES),
      payload: {
        conversationId: convo.id,
        sessionId: `perf-sess-${int(0, N_CONTACTS - 1)}`,
        value: int(1, 500),
      },
      occurredAt: new Date(now - Math.floor(rnd() * YEAR_MS)),
    });
  }
  await batchInsert(db, "analytics_events", eventRows, 5000, (chunk) =>
    db.analyticsEvent.createMany({ data: chunk }),
  );

  // ── Knowledge + curated answers (vector lanes) ────────────────────────────
  const knowledgeRows = [];
  for (let i = 0; i < N_KNOWLEDGE; i++) {
    knowledgeRows.push({
      id: id("perfn"),
      shopId,
      dataSourceId: null,
      topic: `Perf topic ${i}: ${sentence(4)}`,
      body: sentence(80),
    });
  }
  await batchInsert(db, "knowledge", knowledgeRows, 1000, (chunk) =>
    db.knowledge.createMany({ data: chunk }),
  );
  const curatedRows = [];
  for (let i = 0; i < N_CURATED; i++) {
    curatedRows.push({
      id: id("perfu"),
      shopId,
      question: `Perf question ${i}: ${sentence(6)}?`,
      synonyms: [sentence(2), sentence(2)],
      productIds: [],
      talkingPoints: sentence(30),
      status: rnd() < 0.75 ? "published" : "draft",
      priority: pick(["low", "normal", "high"]),
    });
  }
  await batchInsert(db, "curated_answers", curatedRows, 500, (chunk) =>
    db.curatedAnswer.createMany({ data: chunk }),
  );
  console.log("seed: generating knowledge + curated embeddings (SQL)…");
  for (const table of ["knowledge", "curated_answers"]) {
    await db.$executeRawUnsafe(
      `UPDATE "${table}" t SET "embedding" = (
         SELECT array_agg(((abs(hashtext(t."id" || g::text)) % 2000)::float8 - 1000) / 1000.0
                ORDER BY g)::real[]::vector(1536)
         FROM generate_series(1, 1536) g)
       WHERE t."shopId" = $1`,
      shopId,
    );
  }

  // ── Statistics ───────────────────────────────────────────────────────────
  console.log("seed: ANALYZE…");
  for (const table of [
    "products", "contacts", "conversations", "messages", "analytics_events",
    "knowledge", "curated_answers", "metrics_daily",
  ]) {
    await db.$executeRawUnsafe(`ANALYZE "${table}"`);
  }

  const counts = await rowCounts(db, shopId);
  console.log("\nseeded row counts (shopId-scoped):");
  for (const [table, n] of counts) console.log(`  ${table.padEnd(20)} ${n}`);
  console.log(`\nseed: done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

/** Delete this shop's data rows but keep the Shop row (re-seed path). */
async function cleanRowsOnly(db: Db, shopId: string): Promise<void> {
  await db.message.deleteMany({ where: { shopId } });
  await db.analyticsEvent.deleteMany({ where: { shopId } });
  await db.conversation.deleteMany({ where: { shopId } });
  await db.contact.deleteMany({ where: { shopId } });
  await db.knowledge.deleteMany({ where: { shopId } });
  await db.curatedAnswer.deleteMany({ where: { shopId } });
  await db.product.deleteMany({ where: { shopId } });
  await db.metricsDaily.deleteMany({ where: { shopId } });
  await db.teamMember.deleteMany({ where: { shopId } });
}

async function rowCounts(db: Db, shopId: string): Promise<[string, number][]> {
  const [products, contacts, conversations, messages, events, knowledge, curated] =
    await Promise.all([
      db.product.count({ where: { shopId } }),
      db.contact.count({ where: { shopId } }),
      db.conversation.count({ where: { shopId } }),
      db.message.count({ where: { shopId } }),
      db.analyticsEvent.count({ where: { shopId } }),
      db.knowledge.count({ where: { shopId } }),
      db.curatedAnswer.count({ where: { shopId } }),
    ]);
  return [
    ["products", products],
    ["contacts", contacts],
    ["conversations", conversations],
    ["messages", messages],
    ["analytics_events", events],
    ["knowledge", knowledge],
    ["curated_answers", curated],
  ];
}

async function batchInsert<T>(
  _db: Db,
  label: string,
  rows: T[],
  size: number,
  run: (chunk: T[]) => Promise<unknown>,
): Promise<void> {
  const started = Date.now();
  for (let i = 0; i < rows.length; i += size) {
    await run(rows.slice(i, i + size));
    process.stdout.write(`\r  ${label}: ${Math.min(i + size, rows.length)}/${rows.length}`);
  }
  process.stdout.write(
    `\r  ${label}: ${rows.length}/${rows.length} (${((Date.now() - started) / 1000).toFixed(1)}s)\n`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
