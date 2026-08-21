/* Human-handover QA (spec 10 "Handover runtime" + spec 08 handover config).
 *
 * Run: npx tsx scripts/qa/handover.test.ts
 * Needs: dev Postgres up (npm run db:up) + migrated + seeded (dev-shop).
 * Every conversation/contact/message/event it writes is tagged with a
 * `qa-handover-` session id and deleted again; seeded data is never touched.
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
const SESSION_PREFIX = "qa-handover-";

let passed = 0;
let failed = 0;
const notes: string[] = [];

function ok(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  PASS ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  ok(name, Object.is(actual, expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

function deepEq(name: string, actual: unknown, expected: unknown): void {
  ok(
    name,
    JSON.stringify(actual) === JSON.stringify(expected),
    `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`,
  );
}

/** Spec-vs-implementation divergences worth reporting, not test failures. */
function note(text: string): void {
  notes.push(text);
  console.log(`  NOTE ${text}`);
}

async function main(): Promise<void> {
  const db = (await import("../../app/db.server")).default;
  const shop = await db.shop.findUnique({ where: { domain: DEV_SHOP_DOMAIN }, select: { id: true } });
  if (!shop) throw new Error(`dev shop ${DEV_SHOP_DOMAIN} not found — run npx prisma db seed`);
  const shopId = shop.id;

  const H = await import("../../app/lib/pipeline/handover.server");
  const I = await import("../../app/lib/inbox/inbox.server");
  const { availabilitySchema, handoverConfigSchema } = await import("../../app/lib/settings/schemas");
  const { getShopConfig } = await import("../../app/lib/config/shop-config.server");
  const baseConfig = await getShopConfig(shopId);

  type Handover = ReturnType<typeof handoverConfigSchema.parse>;
  const defaults: Handover = handoverConfigSchema.parse({});

  // "Open" = 24/7. "Shut" = a custom schedule with every day disabled.
  const OPEN = availabilitySchema.parse({ mode: "always" });
  const SHUT = availabilitySchema.parse({
    mode: "custom",
    days: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, enabled: false, from: "09:00", to: "17:00" })),
  });
  const makeConfig = (handover: Record<string, unknown>, open: boolean) => ({
    ...baseConfig,
    timezone: "UTC",
    settings: { ...baseConfig.settings, availability: open ? OPEN : SHUT },
    handover: handoverConfigSchema.parse(handover),
  });

  let seq = 0;
  async function newConversation(patch: Record<string, unknown> = {}) {
    seq += 1;
    return db.conversation.create({
      data: { shopId, sessionId: `${SESSION_PREFIX}${Date.now()}-${seq}`, isTest: false, ...patch },
    });
  }
  const shopperSays = (conversationId: string, content: string) =>
    db.message.create({ data: { shopId, conversationId, role: "in", author: "shopper", content } });
  const aiSays = (conversationId: string, content: string, sourceLayer: string) =>
    db.message.create({ data: { shopId, conversationId, role: "out", author: "ai", content, sourceLayer } });
  const messagesOf = (conversationId: string) =>
    db.message.findMany({ where: { shopId, conversationId }, orderBy: { createdAt: "asc" } });

  // ── 1. Trigger: explicit ask (always on) ──────────────────────────────────
  console.log("\n[trigger: explicit_ask]");
  const asker = await newConversation();
  const detectText = (message: string, handover: Handover = defaults) =>
    H.detectHandover({ shopId, conversationId: asker.id, message, queryEmbedding: null, handover });

  for (const phrase of [
    "I want to talk to a human",
    "Can I speak with an agent please",
    "talk to an agent",
    "I'd like to chat with someone",
    "let me talk to a real person",
    "I need human support",
    "connect me with your team",
    "connect me to an agent",
    "how do I reach customer service",
    "can I talk to your customer support team?",
  ]) {
    eq(`"${phrase}"`, await detectText(phrase), "explicit_ask");
  }
  // Negative controls: a question ABOUT support is a RAG question, not a handover.
  for (const phrase of [
    "what is your customer service email?",
    "do you ship to Canada?",
    "is this product in stock",
  ]) {
    eq(`no trigger: "${phrase}"`, await detectText(phrase), null);
  }

  // ── 2. Trigger: negative sentiment (opt-in) ───────────────────────────────
  console.log("\n[trigger: negative_sentiment]");
  const sentimentOn = handoverConfigSchema.parse({ triggers: { negativeSentiment: { enabled: true } } });
  eq("ALL CAPS", await detectText("THIS ORDER IS COMPLETELY BROKEN", sentimentOn), "negative_sentiment");
  eq("repeated punctuation", await detectText("where is my order???", sentimentOn), "negative_sentiment");
  eq("angry emoji", await detectText("my parcel never arrived 😡", sentimentOn), "negative_sentiment");
  eq("thumbs down emoji", await detectText("not helpful 👎", sentimentOn), "negative_sentiment");
  eq("calm message does not trigger", await detectText("where is my order?", sentimentOn), null);
  eq("short caps word does not trigger (< 8 letters)", await detectText("HELP", sentimentOn), null);
  eq("opt-in respected: disabled → no trigger", await detectText("THIS ORDER IS COMPLETELY BROKEN", defaults), null);
  note(
    'spec 10 lists "2+ thumbs-down" as a negative-sentiment signal; only a 👎 CHARACTER in the ' +
      "message is detected. The widget's survey/rating feedback is never fed into detectHandover, " +
      "so the thumbs-down counter part of that trigger is unimplemented.",
  );

  // ── 3. Trigger: repeated question ─────────────────────────────────────────
  console.log("\n[trigger: repeated_question]");
  const repeater = await newConversation();
  const repeatCfg = handoverConfigSchema.parse({ triggers: { repeatedQuestion: { enabled: true, threshold: 3 } } });
  const detectIn = (conversationId: string, message: string, handover: Handover) =>
    H.detectHandover({ shopId, conversationId, message, queryEmbedding: null, handover });

  await shopperSays(repeater.id, "where is my refund");
  eq("1st ask → no trigger", await detectIn(repeater.id, "where is my refund", repeatCfg), null);
  await shopperSays(repeater.id, "where is my refund");
  eq("2nd ask (threshold 3) → no trigger", await detectIn(repeater.id, "where is my refund", repeatCfg), null);
  await shopperSays(repeater.id, "Where is my refund?!");
  eq("3rd ask, punctuation/case normalized → trigger", await detectIn(repeater.id, "where is my refund", repeatCfg), "repeated_question");
  eq("opt-out respected", await detectIn(repeater.id, "where is my refund", handoverConfigSchema.parse({ triggers: { repeatedQuestion: { enabled: false } } })), null);
  // Threshold 2 fires one ask earlier.
  const repeater2 = await newConversation();
  await shopperSays(repeater2.id, "cancel my subscription");
  await shopperSays(repeater2.id, "cancel my subscription");
  eq("threshold 2 fires on the 2nd ask", await detectIn(repeater2.id, "cancel my subscription", handoverConfigSchema.parse({ triggers: { repeatedQuestion: { enabled: true, threshold: 2 } } })), "repeated_question");
  // Short text guard (normalized length must exceed 4).
  const shortRepeater = await newConversation();
  for (let i = 0; i < 4; i++) await shopperSays(shortRepeater.id, "hi");
  eq("very short repeats are ignored", await detectIn(shortRepeater.id, "hi", repeatCfg), null);
  // A paraphrase is NOT caught — this is the documented divergence.
  const paraphraser = await newConversation();
  await shopperSays(paraphraser.id, "where is my refund");
  await shopperSays(paraphraser.id, "when will I get my refund");
  await shopperSays(paraphraser.id, "refund status please");
  eq("paraphrases do not trigger (exact-text matching)", await detectIn(paraphraser.id, "any news on the refund", repeatCfg), null);
  note(
    'spec 10 specifies repeated question as "same question (embedding similarity) 2+ times"; the ' +
      "implementation compares NORMALIZED EXACT TEXT (lowercase, punctuation stripped) over the " +
      "last 8 shopper messages. Case/punctuation variants are caught, paraphrases are not.",
  );
  // Cross-conversation isolation.
  const otherThread = await newConversation();
  eq("repeats are counted per conversation", await detectIn(otherThread.id, "where is my refund", repeatCfg), null);

  // ── 4. Trigger: intent rules (semantic) ───────────────────────────────────
  console.log("\n[trigger: intent_rule]");
  const intentCfg = handoverConfigSchema.parse({ intentRules: [{ topic: "wholesale pricing" }] });
  // Pre-seed the vector cache so the assertion is deterministic and costs no
  // LLM call — same key shape as intentRuleVectors().
  const topics = intentCfg.intentRules.map((r) => r.topic);
  global.intentRuleVectorCache = new Map([[`${shopId}:${topics.join("|")}`, [[1, 0, 0, 0]]]]);
  eq("on-topic embedding → intent_rule", await H.detectHandover({ shopId, conversationId: asker.id, message: "", queryEmbedding: [1, 0, 0, 0], handover: intentCfg }), "intent_rule");
  eq("borderline below threshold (0.5) → no trigger", await H.detectHandover({ shopId, conversationId: asker.id, message: "", queryEmbedding: [0.4, 0.9, 0, 0], handover: intentCfg }), null);
  eq("orthogonal embedding → no trigger", await H.detectHandover({ shopId, conversationId: asker.id, message: "", queryEmbedding: [0, 1, 0, 0], handover: intentCfg }), null);
  eq("no embedding yet → rules skipped", await H.detectHandover({ shopId, conversationId: asker.id, message: "", queryEmbedding: null, handover: intentCfg }), null);
  eq("no rules configured → skipped", await H.detectHandover({ shopId, conversationId: asker.id, message: "", queryEmbedding: [1, 0, 0, 0], handover: defaults }), null);
  global.intentRuleVectorCache = undefined;

  // ── 5. Trigger: cannot answer ─────────────────────────────────────────────
  console.log("\n[trigger: cannot_answer]");
  const cannotCfg = handoverConfigSchema.parse({ triggers: { cannotAnswer: { enabled: true, threshold: 2 } } });
  const stuck = await newConversation();
  await aiSays(stuck.id, "Could you rephrase that?", "clarify");
  eq("1 fallback turn (threshold 2) → no", await H.detectCannotAnswer(shopId, stuck.id, cannotCfg), false);
  await aiSays(stuck.id, "I couldn't find that.", "rag_fallback");
  eq("2 consecutive fallback turns → yes", await H.detectCannotAnswer(shopId, stuck.id, cannotCfg), true);
  await aiSays(stuck.id, "Here are three options.", "recommend");
  eq("a good answer resets the streak", await H.detectCannotAnswer(shopId, stuck.id, cannotCfg), false);
  await aiSays(stuck.id, "Sorry, I can't discuss that.", "banned_router");
  await aiSays(stuck.id, "Could you rephrase that?", "clarify");
  eq("streak rebuilds", await H.detectCannotAnswer(shopId, stuck.id, cannotCfg), true);
  eq("opt-out respected", await H.detectCannotAnswer(shopId, stuck.id, handoverConfigSchema.parse({ triggers: { cannotAnswer: { enabled: false } } })), false);
  const fresh = await newConversation();
  eq("a conversation with no AI turns yet → no", await H.detectCannotAnswer(shopId, fresh.id, cannotCfg), false);

  // ── 6. executeHandover: destinations × availability × aiWhileWaiting ──────
  console.log("\n[executeHandover: inbox destination]");
  type Case = {
    label: string;
    open: boolean;
    handover: Record<string, unknown>;
    messages: string[];
    form: boolean;
    contactMethods: boolean;
    aiDormant: boolean;
  };
  const inboxCases: Case[] = [];
  for (const [ai, dormantOnline, dormantOffline] of [
    ["never", true, true],
    ["outside_hours", true, false],
    ["always", false, false],
  ] as const) {
    inboxCases.push({
      label: `inbox / online / aiWhileWaiting=${ai}`,
      open: true,
      handover: { destination: "inbox", inbox: { aiWhileWaiting: ai } },
      messages: [defaults.inbox.afterHandoverMessage],
      form: false,
      contactMethods: false,
      aiDormant: dormantOnline,
    });
    inboxCases.push({
      label: `inbox / offline+leave_message / aiWhileWaiting=${ai}`,
      open: false,
      handover: { destination: "inbox", inbox: { aiWhileWaiting: ai, offlineMode: "leave_message" } },
      messages: [defaults.inbox.leaveMessage.formMessage],
      form: true,
      contactMethods: false,
      aiDormant: dormantOffline,
    });
    inboxCases.push({
      label: `inbox / offline+contact_methods / aiWhileWaiting=${ai}`,
      open: false,
      handover: { destination: "inbox", inbox: { aiWhileWaiting: ai, offlineMode: "contact_methods" } },
      messages: [defaults.contactMethods.message],
      form: false,
      contactMethods: true,
      aiDormant: dormantOffline,
    });
  }
  const otherCases: Case[] = [
    {
      label: "collect_email / online",
      open: true,
      handover: { destination: "collect_email" },
      messages: [defaults.collectEmail.formMessage],
      form: true,
      contactMethods: false,
      aiDormant: false,
    },
    {
      label: "collect_email / offline",
      open: false,
      handover: { destination: "collect_email" },
      messages: [defaults.collectEmail.formMessage],
      form: true,
      contactMethods: false,
      aiDormant: false,
    },
    {
      label: "contact_methods / online",
      open: true,
      handover: { destination: "contact_methods" },
      messages: [defaults.contactMethods.message],
      form: false,
      contactMethods: true,
      aiDormant: false,
    },
    {
      label: "contact_methods / offline",
      open: false,
      handover: { destination: "contact_methods" },
      messages: [defaults.contactMethods.message],
      form: false,
      contactMethods: true,
      aiDormant: false,
    },
  ];

  for (const c of [...inboxCases, ...otherCases]) {
    const convo = await newConversation();
    const frame = await H.executeHandover({
      shopId,
      conversationId: convo.id,
      trigger: "explicit_ask",
      config: makeConfig(c.handover, c.open),
    });
    deepEq(`${c.label} → copy`, frame.messages, c.messages);
    eq(`${c.label} → form`, frame.form !== null, c.form);
    eq(`${c.label} → contact chips`, frame.contactMethods, c.contactMethods);
    eq(`${c.label} → aiDormant`, frame.aiDormant, c.aiDormant);
    const after = await db.conversation.findUniqueOrThrow({ where: { id: convo.id } });
    eq(`${c.label} → conversation flagged handover`, after.handover, true);
    eq(`${c.label} → conversation unread`, after.unread, true);
    eq(`${c.label} → mode`, after.mode, c.aiDormant ? "human" : "ai");
    const msgs = await messagesOf(convo.id);
    eq(`${c.label} → sys event written`, msgs.some((m) => m.role === "sys" && m.content === "Handed over to a human agent."), true);
    deepEq(
      `${c.label} → copy persisted to the thread`,
      msgs.filter((m) => m.role === "out" && m.sourceLayer === "handover").map((m) => m.content),
      c.messages,
    );
  }

  console.log("\n[executeHandover: form + analytics details]");
  const formConvo = await newConversation();
  const formFrame = await H.executeHandover({
    shopId,
    conversationId: formConvo.id,
    trigger: "cannot_answer",
    config: makeConfig(
      {
        destination: "collect_email",
        collectEmail: { collect: { email: true, issue: true, orderNumber: true, phone: true, photoUpload: true } },
      },
      true,
    ),
  });
  deepEq(
    "collect fields honour the config (photo deferred)",
    formFrame.form?.fields,
    [
      { key: "email", required: true },
      { key: "issue", required: true },
      { key: "orderNumber", required: false },
      { key: "phone", required: false },
    ],
  );
  eq("reply time surfaced to the widget", formFrame.form?.replyTime, "24h");
  const minimalForm = await H.executeHandover({
    shopId,
    conversationId: (await newConversation()).id,
    trigger: "explicit_ask",
    config: makeConfig({ destination: "collect_email", collectEmail: { collect: { email: true, issue: true, orderNumber: false, phone: false, photoUpload: false } } }, true),
  });
  deepEq("optional fields dropped when unchecked", minimalForm.form?.fields, [
    { key: "email", required: true },
    { key: "issue", required: true },
  ]);
  const events = await db.analyticsEvent.findMany({
    where: { shopId, type: "handover_triggered", occurredAt: { gte: new Date(Date.now() - 10 * 60_000) } },
    orderBy: { occurredAt: "desc" },
    take: 5,
  });
  ok(
    "handover_triggered analytics carries trigger + destination + dormancy",
    events.some((e) => {
      const p = e.payload as { trigger?: string; destination?: string; aiDormant?: boolean } | null;
      return p?.trigger === "cannot_answer" && p?.destination === "collect_email" && p?.aiDormant === false;
    }),
    `${events.length} recent events`,
  );

  // ── 7. Availability drives the offline branch through agent presence ──────
  console.log("\n[availability wiring]");
  const A = await import("../../app/lib/settings/availability.server");
  const agentGated = availabilitySchema.parse({ mode: "always", onlineStatusMode: "agent_during_hours" });
  const gatedConfig = (present: boolean) => {
    // Presence is per-shop and process-local, so drive it on a scratch shop id.
    const scratchShopId = shopId;
    if (present) A.touchAgentPresence(scratchShopId);
    return {
      ...baseConfig,
      timezone: "UTC",
      settings: { ...baseConfig.settings, availability: agentGated },
      handover: handoverConfigSchema.parse({ destination: "inbox", inbox: { aiWhileWaiting: "outside_hours", offlineMode: "contact_methods" } }),
    };
  };
  // Nobody at the desk yet (no heartbeat, no recent human_replied for this shop).
  const beforePresence = await A.isAgentOnline(shopId);
  if (beforePresence) {
    note("dev shop already shows an agent online (recent inbox activity) — offline branch skipped");
  } else {
    const offlineConvo = await newConversation();
    const offlineFrame = await H.executeHandover({ shopId, conversationId: offlineConvo.id, trigger: "explicit_ask", config: gatedConfig(false) });
    eq("agent_during_hours + nobody present → offline copy", offlineFrame.contactMethods, true);
    eq("agent_during_hours + nobody present → AI keeps answering (outside_hours)", offlineFrame.aiDormant, false);
  }
  const onlineConvo = await newConversation();
  const onlineFrame = await H.executeHandover({ shopId, conversationId: onlineConvo.id, trigger: "explicit_ask", config: gatedConfig(true) });
  eq("agent present → online copy", onlineFrame.contactMethods, false);
  deepEq("agent present → 'connected' message", onlineFrame.messages, [defaults.inbox.afterHandoverMessage]);
  eq("agent present + outside_hours → AI goes quiet", onlineFrame.aiDormant, true);

  // ── 8. Two-way flow: shopper → inbox → merchant reply → widget → resolve ──
  console.log("\n[two-way flow]");
  const flow = await newConversation();
  const flowSession = (await db.conversation.findUniqueOrThrow({ where: { id: flow.id } })).sessionId;
  await shopperSays(flow.id, "I want to talk to a human");
  const before = new Date(Date.now() - 1000);
  const flowFrame = await H.executeHandover({
    shopId,
    conversationId: flow.id,
    trigger: "explicit_ask",
    config: makeConfig({ destination: "inbox", inbox: { aiWhileWaiting: "never" } }, true),
  });
  eq("handover parks the thread in human mode", flowFrame.aiDormant, true);

  const poll1 = await I.getWidgetThreadState(shopId, flow.id, before, false, flowSession);
  eq("widget poll sees human mode", poll1?.mode, "human");
  ok("widget poll receives the sys + handover copy", (poll1?.messages.length ?? 0) >= 2, `${poll1?.messages.length} frames`);

  const replyAt = new Date();
  await new Promise((r) => setTimeout(r, 5));
  eq("merchant reply accepted", await I.sendAgentReply(shopId, flow.id, "Hi! Jo here, taking a look now."), true);
  const poll2 = await I.getWidgetThreadState(shopId, flow.id, replyAt, true, flowSession);
  ok(
    "merchant reply reaches the widget poll",
    (poll2?.messages ?? []).some((m) => m.author === "agent" && m.content === "Hi! Jo here, taking a look now."),
    JSON.stringify(poll2?.messages.map((m) => m.author)),
  );
  const seen = await db.message.findFirst({ where: { shopId, conversationId: flow.id, author: "agent" }, orderBy: { createdAt: "desc" } });
  ok("rendering the reply marks it seen", seen?.seenAt !== null, `seenAt=${seen?.seenAt?.toISOString() ?? "null"}`);

  eq("resolve succeeds", await I.setResolved(shopId, flow.id, true), true);
  const resolved = await db.conversation.findUniqueOrThrow({ where: { id: flow.id } });
  eq("resolve closes the conversation", resolved.status, "resolved");
  eq("resolve hands the thread back to the AI", resolved.mode, "ai");
  eq("resolve clears the unread flag", resolved.unread, false);
  ok("resolve writes the sys event", (await messagesOf(flow.id)).some((m) => m.content === I.RESOLVED_SYS_MESSAGE), "");
  const poll3 = await I.getWidgetThreadState(shopId, flow.id, replyAt, false, flowSession);
  eq("widget poll sees the resolved status", poll3?.status, "resolved");
  eq("widget poll sees the AI back in charge", poll3?.mode, "ai");

  eq("reopen succeeds", await I.setResolved(shopId, flow.id, false), true);
  const reopened = await db.conversation.findUniqueOrThrow({ where: { id: flow.id } });
  eq("reopen reopens", reopened.status, "open");
  eq("reopen clears endedAt", reopened.endedAt, null);
  eq("reopen leaves the AI awake (never stuck in human mode)", reopened.mode, "ai");

  // Merchant replying again takes the thread back over.
  await I.sendAgentReply(shopId, flow.id, "One more thing…");
  eq("a merchant reply re-takes the thread", (await db.conversation.findUniqueOrThrow({ where: { id: flow.id } })).mode, "human");

  console.log("\n[flow guards]");
  const blocked = await newConversation({ blocked: true });
  eq("blocked visitors cannot be replied to", await I.sendAgentReply(shopId, blocked.id, "hello?"), false);
  eq("blocked conversation returns blocked to the widget", (await I.getWidgetThreadState(shopId, blocked.id, new Date(0), false))?.blocked, true);
  eq("another shop's id can't reply", await I.sendAgentReply("not-this-shop", flow.id, "leak"), false);
  eq("another shop's id can't resolve", await I.setResolved("not-this-shop", flow.id, true), false);
  eq("a wrong session id can't read the thread", await I.getWidgetThreadState(shopId, flow.id, new Date(0), false, "someone-elses-session"), null);
  eq("a wrong session id can't read the history", await I.getWidgetThreadHistory(shopId, flow.id, "someone-elses-session"), null);
  ok(
    "history restore carries the handover sys line",
    ((await I.getWidgetThreadHistory(shopId, flow.id, flowSession))?.messages ?? []).some(
      (m) => m.role === "sys" && m.content === "Handed over to a human agent.",
    ),
    "",
  );

  // ── 9. Leave-a-message / collect-email form submission ────────────────────
  console.log("\n[handover form submission]");
  const formTarget = await newConversation();
  const formSession = (await db.conversation.findUniqueOrThrow({ where: { id: formTarget.id } })).sessionId;
  const submitted = await I.submitHandoverForm(shopId, {
    sessionId: formSession,
    conversationId: formTarget.id,
    values: { email: `${SESSION_PREFIX}lead@example.com`, issue: "My parcel is late", orderNumber: "#1001", phone: "+15550100" },
  });
  ok("form submission accepted", submitted !== null, "");
  ok("post-submit copy returned", typeof submitted?.postSubmitMessage === "string" && submitted.postSubmitMessage.length > 0, submitted?.postSubmitMessage ?? "");
  const lead = await db.contact.findFirst({ where: { shopId, email: `${SESSION_PREFIX}lead@example.com` } });
  eq("a lead contact is created", lead?.type, "lead");
  eq("the lead is attached to the conversation", (await db.conversation.findUniqueOrThrow({ where: { id: formTarget.id } })).contactId, lead?.id ?? null);
  const formMsg = (await messagesOf(formTarget.id)).find((m) => m.sourceLayer === "handover" && m.role === "in");
  ok("the request lands in the thread for the merchant", Boolean(formMsg && /My parcel is late/.test(formMsg.content) && /#1001/.test(formMsg.content)), formMsg?.content ?? "none");
  eq("submission marks the conversation unread", (await db.conversation.findUniqueOrThrow({ where: { id: formTarget.id } })).unread, true);
  eq("a foreign session can't submit into someone else's thread", await I.submitHandoverForm(shopId, { sessionId: "not-my-session", conversationId: formTarget.id, values: { email: "x@example.com", issue: "x" } }), null);

  console.log(`\n${failed === 0 ? "HANDOVER TESTS PASS" : "HANDOVER TESTS FAIL"} — ${passed} passed, ${failed} failed`);
  if (notes.length > 0) {
    console.log(`\n${notes.length} spec divergence(s) reported above (not failures).`);
  }
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error("\nHANDOVER TESTS ERROR", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    const db = (await import("../../app/db.server")).default;
    try {
      const shop = await db.shop.findUnique({ where: { domain: DEV_SHOP_DOMAIN }, select: { id: true } });
      if (shop) {
        const convos = await db.conversation.findMany({
          where: { shopId: shop.id, sessionId: { startsWith: SESSION_PREFIX } },
          select: { id: true },
        });
        const ids = convos.map((c) => c.id);
        if (ids.length > 0) {
          await db.message.deleteMany({ where: { shopId: shop.id, conversationId: { in: ids } } });
          await db.unresolvedQuestion.deleteMany({ where: { shopId: shop.id, conversationId: { in: ids } } });
          await db.conversation.deleteMany({ where: { shopId: shop.id, id: { in: ids } } });
          // human_replied doubles as the cross-instance agent-presence signal,
          // so leaving these behind makes the NEXT run see a phantom agent
          // online and skip the offline branch.
          const { Prisma } = await import("@prisma/client");
          await db.$executeRaw`
            DELETE FROM analytics_events
            WHERE "shopId" = ${shop.id}
              AND type = 'human_replied'
              AND payload->>'conversationId' IN (${Prisma.join(ids)})`;
        }
        await db.contact.deleteMany({
          where: { shopId: shop.id, OR: [{ sessionId: { startsWith: SESSION_PREFIX } }, { email: { startsWith: SESSION_PREFIX } }] },
        });
      }
    } catch (error) {
      console.error("cleanup failed", error);
      process.exitCode = 1;
    }
    // executeHandover enqueues the team notification, which lazily starts the
    // shared pg-boss poller — without stopping it the process never exits.
    try {
      if (global.pgBossGlobal) {
        const { getQueue } = await import("../../app/lib/jobs/queue.server");
        await Promise.race([
          getQueue().boss.stop({ graceful: false }),
          new Promise((resolve) => setTimeout(resolve, 5000)),
        ]);
      }
    } catch {
      /* queue never started */
    }
    // MUST await — the shared client keeps the pool (and the process) alive.
    await db.$disconnect();
    process.exit(process.exitCode ?? 0);
  });
