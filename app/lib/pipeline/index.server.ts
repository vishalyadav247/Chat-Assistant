import type { Prisma } from "@prisma/client";
import db from "../../db.server";
import { recordEvent } from "../analytics/events.server";
import { tickConversation, aiAllowed } from "../billing/usage.server";
import { getShopConfig, type ShopConfig } from "../config/shop-config.server";
import { embedText } from "../embeddings/embedding.server";
import { getLlmProvider, type ChatMessage } from "../llm/index.server";
import {
  hybridProductSearch,
  browseCheapestInBudget,
  candidateSnippet,
  selectRelevant,
  type ProductCandidate,
} from "../search/product-search.server";
import { knowledgeSearch } from "../search/knowledge-search.server";
import { curatedMatch } from "../search/curated-match.server";
import { recommendationMatch } from "../search/recommendation-match.server";
import { ensureSessionContact } from "../contacts/contacts.server";
import { requireShopId } from "../tenancy.server";
import { mergePageContext } from "../widget/page-context.server";
import { notifyNewConversation, notifyShopperMessage } from "../notify.server";
import { keywordScan, meaningScan, moderationCheck } from "./guardrail.server";
import { detectHandover, detectCannotAnswer, executeHandover } from "./handover.server";
import { loadHistory } from "./history.server";
import { route } from "./router.server";
import {
  buildPersonaPrompt,
  CHAT_REPLY,
  CURATED_CONFIRM_SYSTEM,
  curatedConfirmUser,
  PRODUCT_RECOMMEND,
  QUESTION_ANSWER,
} from "./prompts";

// Runtime agent pipeline (spec 03). The LLM is only the voice: code picks the
// lane, fetches facts, builds cards from DB rows. One embedding per turn,
// reused across guardrail/curated/search/RAG. Budget ≈ 2 chat + 1-2 embedding
// calls; curated/blocked/off-topic/clarify paths make ZERO generation calls.

export interface PipelineInput {
  shopId: string;
  sessionId: string;
  conversationId?: string;
  message: string;
  pageContext?: unknown;
  /** Raw User-Agent from the proxy request — parsed into the device label. */
  userAgent?: string;
  isTest?: boolean;
}

export type PipelineFrame =
  | { type: "token"; text: string }
  | { type: "message"; text: string }
  | { type: "cards"; cards: ProductCard[] }
  | { type: "handover"; data: import("./handover.server").HandoverFrameData }
  | { type: "done"; outcome: string; conversationId: string }
  | { type: "debug"; sourceLayer: string; detail: unknown };

export interface ProductCard {
  shopifyProductId: string;
  title: string;
  price: number;
  imageUrl: string | null;
  handle: string;
  /** Numeric variant id for /cart/add.js (first available variant), null if unknown. */
  variantId: string | null;
}

function numericVariantId(
  variants: { id: string; available: boolean }[] | null | undefined,
): string | null {
  const first = variants?.find((v) => v.available) ?? variants?.[0];
  if (!first) return null;
  const numeric = first.id.split("/").pop();
  return numeric && /^\d+$/.test(numeric) ? numeric : null;
}

const DEFAULT_FALLBACK =
  "I'm not sure about that one — leave your email and our team will get back to you.";
const CLARIFY_MESSAGE = "I couldn't find a match — what kind of item are you after?";
const BUSY_MESSAGE = "You're sending messages very quickly — give me a few seconds and try again.";
const CAP_MESSAGE = "Our chat assistant is offline right now — leave your email and we'll follow up.";

export async function* runPipeline(input: PipelineInput): AsyncIterable<PipelineFrame> {
  const shopId = requireShopId(input.shopId);
  const message = input.message.slice(0, 2000).trim();

  // Rate limit before any spend (bucket keyed shop+session — tenancy audit).
  if (!consumeToken(`${shopId}:${input.sessionId}`)) {
    yield { type: "message", text: BUSY_MESSAGE };
    yield { type: "done", outcome: "rate_limited", conversationId: input.conversationId ?? "" };
    return;
  }

  const config = await getShopConfig(shopId);
  const convo = await ensureConversation(shopId, input);
  const shopperMessageId = await saveMessage(shopId, convo.id, {
    role: "in", author: "shopper", content: message,
  });

  // Human mode: AI stays dormant (spec 10 wires aiWhileWaiting refinements).
  // The team hears about the shopper's message instead (spec 18 push).
  if (convo.mode === "human") {
    if (!input.isTest) await notifyShopperMessage(shopId, convo.id);
    yield { type: "done", outcome: "human_mode", conversationId: convo.id };
    return;
  }

  if (!config.aiEnabled || !(await aiAllowed(shopId))) {
    const text = CAP_MESSAGE;
    await saveMessage(shopId, convo.id, { role: "out", author: "system", content: text, sourceLayer: "cap" });
    yield { type: "message", text };
    yield { type: "done", outcome: "ai_unavailable", conversationId: convo.id };
    return;
  }

  const guardrails = config.guardrails;
  const fallback = guardrails?.fallbackMessage?.trim() || DEFAULT_FALLBACK;
  const meterPromise = tickConversation({ shopId, conversationId: convo.id, isTest: input.isTest });

  // ── Handover triggers: explicit ask / sentiment / repeat (pre-embedding) ──
  const earlyTrigger = await detectHandover({
    shopId,
    conversationId: convo.id,
    message,
    queryEmbedding: null,
    handover: config.handover,
  }).catch(() => null);
  if (earlyTrigger) {
    const data = await executeHandover({ shopId, conversationId: convo.id, trigger: earlyTrigger, config });
    await meterPromise;
    for (const text of data.messages) yield { type: "message", text };
    yield { type: "handover", data };
    yield { type: "done", outcome: "handover", conversationId: convo.id };
    return;
  }

  // ── Layer a: keyword guardrail (no embedding needed) ──────────────────────
  const kwHit = guardrails ? keywordScan(message, guardrails.bannedTopics) : null;
  if (kwHit) {
    yield* await finishBlocked(shopId, convo.id, fallback, kwHit.layer, meterPromise);
    return;
  }

  // ── One embedding per turn ────────────────────────────────────────────────
  const queryEmbedding = await embedText(message);

  // ── Handover intent rules (needs the embedding) ───────────────────────────
  if (config.handover.intentRules.length > 0) {
    const ruleTrigger = await detectHandover({
      shopId,
      conversationId: convo.id,
      message: "", // text triggers already checked pre-embedding
      queryEmbedding,
      handover: { ...config.handover, triggers: { ...config.handover.triggers, negativeSentiment: { enabled: false }, repeatedQuestion: { ...config.handover.triggers.repeatedQuestion, enabled: false } } },
    }).catch(() => null);
    if (ruleTrigger === "intent_rule") {
      const data = await executeHandover({ shopId, conversationId: convo.id, trigger: ruleTrigger, config });
      await meterPromise;
      for (const text of data.messages) yield { type: "message", text };
      yield { type: "handover", data };
      yield { type: "done", outcome: "handover", conversationId: convo.id };
      return;
    }
  }

  // ── Layer c: meaning guardrail ────────────────────────────────────────────
  if (guardrails) {
    const meaningHit = await meaningScan(shopId, queryEmbedding, guardrails);
    if (meaningHit) {
      yield* await finishBlocked(shopId, convo.id, fallback, meaningHit.layer, meterPromise);
      return;
    }
  }

  // ── Curated shortcut (zero generation) ────────────────────────────────────
  const curatedThreshold = guardrails?.curatedMatchThreshold ?? 0.8;
  const curatedBorderline = guardrails?.curatedBorderline ?? 0.65;
  const curated = await curatedMatch(shopId, queryEmbedding);
  if (curated && curated.score >= curatedBorderline) {
    let use = curated.score >= curatedThreshold;
    if (!use) {
      const answer = await getLlmProvider().chat(
        [
          { role: "system", content: CURATED_CONFIRM_SYSTEM },
          { role: "user", content: curatedConfirmUser(message, curated.question) },
        ],
        { temperature: 0, maxTokens: 3 },
      );
      use = answer.trim().toLowerCase().startsWith("y");
    }
    if (use) {
      const cards = await cardsForShopifyIds(
        shopId, curated.productIds, config.settings.recommendationRules.excludeOutOfStock,
      );
      await db.curatedAnswer.updateMany({
        where: { id: curated.id, shopId },
        data: { servedCount: { increment: 1 } },
      });
      await saveMessage(shopId, convo.id, {
        role: "out",
        author: "ai",
        content: curated.talkingPoints,
        sourceLayer: "curated",
        productCards: cards,
      });
      await recordEvent(shopId, "curated_served", { curatedId: curated.id, score: curated.score });
      await meterPromise;
      yield { type: "message", text: curated.talkingPoints };
      if (cards.length > 0) yield { type: "cards", cards };
      yield { type: "done", outcome: "curated", conversationId: convo.id };
      return;
    }
  }

  // ── App recommendations (ranked below merchant curated, spec 08) ──────────
  const recommendation = await recommendationMatch(shopId, queryEmbedding).catch((error) => {
    console.error("recommendation_match_error", error);
    return null;
  });
  if (recommendation && recommendation.score >= curatedThreshold) {
    const cards = await cardsForShopifyIds(
      shopId, recommendation.productIds, config.settings.recommendationRules.excludeOutOfStock,
    );
    if (cards.length > 0) {
      const text = `${recommendation.title} — here are our picks:`;
      await saveMessage(shopId, convo.id, {
        role: "out",
        author: "ai",
        content: text,
        sourceLayer: "recommendation",
        productCards: cards,
      });
      await recordEvent(shopId, "recommendation_shown", {
        recommendationId: recommendation.id,
        score: recommendation.score,
        deterministic: true,
      });
      await meterPromise;
      yield { type: "message", text };
      yield { type: "cards", cards };
      yield { type: "done", outcome: "recommendation", conversationId: convo.id };
      return;
    }
  }

  // ── Router (moderation racing in parallel — layer b) ──────────────────────
  const { routerHistory, generationHistory } = await loadHistory(shopId, convo.id, {
    excludeMessageId: shopperMessageId, // appended once below, never twice
  });
  const moderationPromise = moderationCheck(shopId, message);
  const routed = await route({
    message,
    history: routerHistory,
    bannedTopics: guardrails?.bannedTopics ?? [],
    storeScope: config.persona?.scope ?? "",
  });
  const moderationHit = await moderationPromise;
  if (moderationHit) {
    yield* await finishBlocked(shopId, convo.id, fallback, "moderation", meterPromise);
    return;
  }
  if (routed.blocked) {
    yield* await finishBlocked(shopId, convo.id, fallback, "router", meterPromise);
    return;
  }
  if (routed.off_topic) {
    const text =
      config.persona?.offTopicMessage?.trim() ||
      "I can only help with our store's products and orders.";
    await saveMessage(shopId, convo.id, {
      role: "out", author: "ai", content: text, sourceLayer: "off_topic", intent: routed,
    });
    await recordEvent(shopId, "turn_off_topic", { reason: routed.off_topic_reason });
    await meterPromise;
    yield { type: "message", text };
    yield { type: "done", outcome: "off_topic", conversationId: convo.id };
    return;
  }
  if (routed.parseFailed) {
    await saveMessage(shopId, convo.id, {
      role: "out", author: "ai", content: CLARIFY_MESSAGE, sourceLayer: "clarify",
    });
    await recordEvent(shopId, "turn_fell_back", { reason: "router_parse_failed" });
    await recordUnresolved(shopId, convo.id, message, "fell_back");
    await meterPromise;
    yield { type: "message", text: CLARIFY_MESSAGE };
    const escalation = await maybeEscalateCannotAnswer(shopId, convo.id, config);
    yield* escalation;
    yield {
      type: "done",
      outcome: escalation.length > 0 ? "handover" : "clarify",
      conversationId: convo.id,
    };
    return;
  }

  const personaPrompt = config.persona
    ? buildPersonaPrompt(config.persona)
    : "You are a helpful shop assistant.";

  // ── Lanes ─────────────────────────────────────────────────────────────────
  if (routed.intent === "buy") {
    yield* buyLane({
      shopId, convoId: convo.id, config, message, queryEmbedding,
      keywords: routed.keywords, priceMax: routed.price_max,
      personaPrompt, generationHistory, meterPromise, routed,
    });
    return;
  }

  if (routed.intent === "question") {
    yield* questionLane({
      shopId, convoId: convo.id, config, message, queryEmbedding,
      fallback, personaPrompt, generationHistory, meterPromise, routed,
    });
    return;
  }

  // chat lane
  const stream = getLlmProvider().chatStream(
    [
      { role: "system", content: `${personaPrompt}\n${CHAT_REPLY}` },
      ...generationHistory,
      { role: "user", content: message },
    ],
    { temperature: 0.5, maxTokens: 60 },
  );
  yield* streamAndLog({
    shopId, convoId: convo.id, stream, sourceLayer: "chat", intent: routed, meterPromise,
  });
}

// ── Buy lane ────────────────────────────────────────────────────────────────

async function* buyLane(args: {
  shopId: string;
  convoId: string;
  config: ShopConfig;
  message: string;
  queryEmbedding: number[];
  keywords: string[];
  priceMax: number | null;
  personaPrompt: string;
  generationHistory: ChatMessage[];
  meterPromise: Promise<unknown>;
  routed: unknown;
}): AsyncIterable<PipelineFrame> {
  const minMeaningScore = args.config.guardrails?.minMeaningScore ?? 0.3;
  const excludeOutOfStock = args.config.settings.recommendationRules.excludeOutOfStock;
  // Master "Learn products" permission (spec 07): OFF ⇒ the catalog is
  // off-limits — no search, no browse fallback; the lane falls through to the
  // clarify path below. Per-product learnEnabled applies only when this is on.
  const learnProducts = args.config.settings.learn.products;

  // Custom recommendations (spec 08): a matched search term constrains the
  // candidate pool to the merchant's hand-picked products for that occasion.
  const constrained = learnProducts
    ? await customRecommendationPool(args.shopId, args.message, args.priceMax, excludeOutOfStock)
    : null;
  let candidates = !learnProducts
    ? []
    : (constrained ??
      (await hybridProductSearch({
        shopId: args.shopId,
        queryEmbedding: args.queryEmbedding,
        keywords: args.keywords,
        message: args.message,
        priceMax: args.priceMax,
        minMeaningScore,
        excludeOutOfStock,
      })));
  let browse = false;

  if (learnProducts && candidates.length === 0 && args.priceMax !== null) {
    candidates = await browseCheapestInBudget(args.shopId, args.priceMax, 4, excludeOutOfStock);
    browse = true;
  }

  if (candidates.length === 0) {
    await saveMessage(args.shopId, args.convoId, {
      role: "out", author: "ai", content: CLARIFY_MESSAGE, sourceLayer: "clarify", intent: args.routed,
    });
    await recordEvent(args.shopId, "turn_fell_back", { reason: "no_candidates" });
    await recordUnresolved(args.shopId, args.convoId, args.message, "fell_back");
    await args.meterPromise;
    yield { type: "message", text: CLARIFY_MESSAGE };
    const escalation = await maybeEscalateCannotAnswer(args.shopId, args.convoId, args.config);
    yield* escalation;
    yield {
      type: "done",
      outcome: escalation.length > 0 ? "handover" : "clarify",
      conversationId: args.convoId,
    };
    return;
  }

  // Relevance cut: only the top match tier is shown — 1, 2 or 4 products
  // depending on what actually matched, never padded to four. The model gets
  // the SAME set (allow-list) so its text and the cards agree. The snippet
  // (type · tags · matching fragment · matched words) lets it judge
  // description-level asks — titles/prices still come only from DB rows.
  const relevant = selectRelevant(candidates, 4);
  const allowList = relevant.map((c) => ({
    title: c.title,
    price: c.price,
    snippet: candidateSnippet(c),
  }));
  let cards = relevant.map(toCard);
  // Cross-sell (spec 08): append companions of any anchored card (cap 6 total).
  cards = await appendCrossSell(args.shopId, cards, excludeOutOfStock);

  const stream = getLlmProvider().chatStream(
    [
      { role: "system", content: `${args.personaPrompt}\n${PRODUCT_RECOMMEND}` },
      ...args.generationHistory,
      {
        role: "user",
        content: `Candidate products: ${JSON.stringify(allowList)}\n\nShopper: ${args.message}`,
      },
    ],
    // Compact reply (user decision 2026-08-18): 1-2 sentences, no titles/prices.
    { temperature: 0.3, maxTokens: 90 },
  );

  await recordEvent(args.shopId, "recommendation_shown", {
    count: cards.length,
    browse,
    keywords: args.keywords,
  });
  yield* streamAndLog({
    shopId: args.shopId,
    convoId: args.convoId,
    stream,
    sourceLayer: browse ? "buy_browse" : "buy",
    intent: args.routed,
    cards,
    meterPromise: args.meterPromise,
  });
}

// ── Question (RAG) lane ─────────────────────────────────────────────────────

async function* questionLane(args: {
  shopId: string;
  convoId: string;
  config: ShopConfig;
  message: string;
  queryEmbedding: number[];
  fallback: string;
  personaPrompt: string;
  generationHistory: ChatMessage[];
  meterPromise: Promise<unknown>;
  routed: unknown;
}): AsyncIterable<PipelineFrame> {
  const guardrails = args.config.guardrails;
  const minMeaningScore = guardrails?.minMeaningScore ?? 0.3;
  const [hits, discountContext] = await Promise.all([
    knowledgeSearch(args.shopId, args.queryEmbedding, 3),
    // Master "Learn discounts" permission (spec 07): OFF ⇒ no discount facts,
    // regardless of per-row learnEnabled.
    args.config.settings.learn.discounts
      ? activeDiscountContext(args.shopId, args.message)
      : Promise.resolve(""),
  ]);
  const strongEnough = hits.length > 0 && hits[0].score >= minMeaningScore;

  // Discount questions are grounded mechanically from the synced Discount
  // mirror (spec 02 backlog: "synced discounts become RAG-available later").
  // When we hold real discount facts, the no-knowledge fallback is skipped —
  // the context IS the store info for this turn.
  if ((guardrails?.answerOnlyFromKnowledge ?? true) && !strongEnough && !discountContext) {
    await saveMessage(args.shopId, args.convoId, {
      role: "out", author: "ai", content: args.fallback, sourceLayer: "rag_fallback", intent: args.routed,
    });
    await recordEvent(args.shopId, "turn_fell_back", { reason: "no_knowledge" });
    await recordUnresolved(args.shopId, args.convoId, args.message, "fell_back");
    await args.meterPromise;
    yield { type: "message", text: args.fallback };
    const escalation = await maybeEscalateCannotAnswer(args.shopId, args.convoId, args.config);
    yield* escalation;
    yield {
      type: "done",
      outcome: escalation.length > 0 ? "handover" : "fell_back",
      conversationId: args.convoId,
    };
    return;
  }

  const context =
    hits.map((h) => `[${h.topic}] ${h.body}`).join("\n\n") + discountContext;
  const stream = getLlmProvider().chatStream(
    [
      { role: "system", content: `${args.personaPrompt}\n${QUESTION_ANSWER}` },
      ...args.generationHistory,
      { role: "user", content: `Store info:\n${context}\n\nShopper question: ${args.message}` },
    ],
    { temperature: 0.3, maxTokens: 220 },
  );
  yield* streamAndLog({
    shopId: args.shopId,
    convoId: args.convoId,
    stream,
    sourceLayer: "question",
    intent: args.routed,
    meterPromise: args.meterPromise,
  });
}

// ── Discount grounding (spec 02 delta closed 2026-08-10) ────────────────────
// Mechanical context injection: when the shopper's message reads like a
// discount question, the currently-active synced discounts (title + Shopify's
// human-readable summary) are appended to the question-lane store info. The
// model still can't invent discounts (prompt rule) — it can only voice these
// rows. Zero extra LLM calls; one indexed query, only on matching messages.

const DISCOUNT_INTENT_RE =
  /\b(discount|coupon|promo|promotion|voucher|sale|offer|deal|discount code|promo code)\b/i;

async function activeDiscountContext(shopId: string, message: string): Promise<string> {
  if (!DISCOUNT_INTENT_RE.test(message)) return "";
  const now = new Date();
  const discounts = await db.discount.findMany({
    where: {
      shopId,
      status: "active",
      learnEnabled: true,
      AND: [
        { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
        { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
      ],
    },
    orderBy: { updatedAt: "desc" },
    take: 6,
    select: { title: true, summary: true, endsAt: true },
  });
  if (discounts.length === 0) return "";
  const lines = discounts.map((d) => {
    const ends = d.endsAt ? ` (ends ${d.endsAt.toISOString().slice(0, 10)})` : "";
    return `- ${d.title}${d.summary ? `: ${d.summary}` : ""}${ends}`;
  });
  return `\n\n[Current discounts — the only discounts that exist]\n${lines.join("\n")}`;
}

// ── Shared helpers ──────────────────────────────────────────────────────────

async function* streamAndLog(args: {
  shopId: string;
  convoId: string;
  stream: AsyncIterable<string>;
  sourceLayer: string;
  intent: unknown;
  cards?: ProductCard[];
  meterPromise: Promise<unknown>;
}): AsyncIterable<PipelineFrame> {
  let full = "";
  try {
    for await (const token of args.stream) {
      full += token;
      yield { type: "token", text: token };
    }
  } catch (error) {
    console.error("generation_error", error);
    await recordEvent(args.shopId, "llm_error", { layer: args.sourceLayer });
    if (!full) {
      full = DEFAULT_FALLBACK;
      yield { type: "message", text: full };
    }
  }

  if (args.cards && args.cards.length > 0) {
    yield { type: "cards", cards: args.cards };
  }
  await saveMessage(args.shopId, args.convoId, {
    role: "out",
    author: "ai",
    content: full,
    sourceLayer: args.sourceLayer,
    intent: args.intent,
    productCards: args.cards,
  });
  await recordEvent(args.shopId, "turn_completed", { sourceLayer: args.sourceLayer });
  await args.meterPromise;
  yield { type: "done", outcome: args.sourceLayer, conversationId: args.convoId };
}

/**
 * Escalate to handover after N consecutive fallback turns (spec 10 trigger
 * "AI cannot answer"). Yields extra frames when it fires; call after a
 * fallback reply has been saved.
 */
async function maybeEscalateCannotAnswer(
  shopId: string,
  conversationId: string,
  config: ShopConfig,
): Promise<PipelineFrame[]> {
  try {
    const fires = await detectCannotAnswer(shopId, conversationId, config.handover);
    if (!fires) return [];
    const data = await executeHandover({ shopId, conversationId, trigger: "cannot_answer", config });
    const frames: PipelineFrame[] = data.messages.map((text) => ({ type: "message", text }));
    frames.push({ type: "handover", data });
    return frames;
  } catch (error) {
    console.error("handover_escalate_error", error);
    return [];
  }
}

/**
 * Feed the unresolved-questions review queue (07/09 consume it): dedupe by
 * normalized text per shop, incrementing the count on repeats.
 */
async function recordUnresolved(
  shopId: string,
  conversationId: string,
  question: string,
  reason: string,
): Promise<void> {
  try {
    const normalized = question.trim().slice(0, 300);
    if (!normalized) return;
    const existing = await db.unresolvedQuestion.findFirst({
      where: { shopId, status: "pending", question: { equals: normalized, mode: "insensitive" } },
    });
    if (existing) {
      await db.unresolvedQuestion.update({
        where: { id: existing.id },
        data: { count: { increment: 1 } },
      });
    } else {
      await db.unresolvedQuestion.create({
        data: { shopId, question: normalized, conversationId, reason },
      });
    }
  } catch (error) {
    console.error("unresolved_record_error", error);
  }
}

async function finishBlocked(
  shopId: string,
  convoId: string,
  fallback: string,
  layer: string,
  meterPromise: Promise<unknown>,
): Promise<PipelineFrame[]> {
  await saveMessage(shopId, convoId, {
    role: "out", author: "ai", content: fallback, sourceLayer: `banned_${layer}`,
  });
  await recordEvent(shopId, "turn_blocked", { layer });
  await meterPromise;
  return [
    { type: "message", text: fallback },
    { type: "done", outcome: "blocked", conversationId: convoId },
  ];
}

async function ensureConversation(shopId: string, input: PipelineInput) {
  // Every turn folds its context into the stored blob (browsed-page history,
  // latest cart snapshot, device) — the inbox details card reads from it.
  if (input.conversationId) {
    const existing = await db.conversation.findFirst({
      // sessionId binds the by-id resume to the caller's own widget session
      // (review C1 — prevents appending to / reading context from a foreign
      // conversation via a leaked id).
      where: { id: input.conversationId, shopId, sessionId: input.sessionId },
    });
    if (existing) {
      await db.conversation.update({
        where: { id: existing.id },
        data: {
          lastMessageAt: new Date(),
          unread: true,
          pageContext: mergePageContext(existing.pageContext, input.pageContext, input.userAgent),
        },
      });
      return existing;
    }
  }
  const bySession = await db.conversation.findFirst({
    where: { shopId, sessionId: input.sessionId, status: "open" },
    orderBy: { startedAt: "desc" },
  });
  if (bySession) {
    await db.conversation.update({
      where: { id: bySession.id },
      data: {
        lastMessageAt: new Date(),
        unread: true,
        pageContext: mergePageContext(bySession.pageContext, input.pageContext, input.userAgent),
      },
    });
    return bySession;
  }
  // New conversation: bind it to the session's contact (existing identified
  // row, else a fresh anonymous one) so unidentified chatters appear in the
  // Contacts Anonymous tab (spec 11). Test-widget chats stay contact-less.
  const contactId = input.isTest ? null : await ensureSessionContact(shopId, input.sessionId);
  const created = await db.conversation.create({
    data: {
      shopId,
      sessionId: input.sessionId,
      isTest: input.isTest ?? false,
      contactId,
      pageContext: mergePageContext(undefined, input.pageContext, input.userAgent),
    },
  });
  // Opt-in "new conversation" notification for team members (spec 18).
  if (!input.isTest) await notifyNewConversation(shopId, created.id);
  return created;
}

async function saveMessage(
  shopId: string,
  conversationId: string,
  data: {
    role: "in" | "out" | "sys";
    author: string;
    content: string;
    sourceLayer?: string;
    intent?: unknown;
    productCards?: ProductCard[];
  },
): Promise<string> {
  const row = await db.message.create({
    data: {
      shopId,
      conversationId,
      role: data.role,
      author: data.author,
      content: data.content,
      sourceLayer: data.sourceLayer,
      intent: data.intent ? (data.intent as Prisma.InputJsonValue) : undefined,
      productCards: data.productCards ? (data.productCards as unknown as Prisma.InputJsonValue) : undefined,
    },
    select: { id: true },
  });
  return row.id;
}

/**
 * Custom-recommendation constraint (spec 08): case-insensitive search-term
 * inclusion in the shopper message → candidate pool = the recommendation's
 * hand-picked products (stock/price still enforced). Collections deferred
 * (membership not mirrored).
 */
async function customRecommendationPool(
  shopId: string,
  message: string,
  priceMax: number | null,
  excludeOutOfStock: boolean,
): Promise<ProductCandidate[] | null> {
  try {
    const rows = await db.customRecommendation.findMany({
      where: { shopId, status: "active" },
      select: { id: true, searchTerms: true, productIds: true },
    });
    const lower = message.toLowerCase();
    const matched = rows.find(
      (r) =>
        r.productIds.length > 0 &&
        r.searchTerms.some((t) => t.trim().length > 2 && lower.includes(t.trim().toLowerCase())),
    );
    if (!matched) return null;
    const products = await db.product.findMany({
      where: {
        shopId,
        shopifyProductId: { in: matched.productIds },
        ...purchasableWhere(excludeOutOfStock),
        ...(priceMax !== null ? { price: { lte: priceMax } } : {}),
      },
      select: {
        id: true, shopifyProductId: true, title: true, price: true, stock: true,
        imageUrl: true, handle: true, variants: true,
        productType: true, tags: true, description: true, metafieldText: true,
      },
      take: 8,
    });
    if (products.length === 0) return null;
    return products.map((p, i) => ({
      id: p.id,
      shopifyProductId: p.shopifyProductId,
      title: p.title,
      price: Number(p.price),
      stock: p.stock,
      imageUrl: p.imageUrl,
      handle: p.handle,
      variants: p.variants as ProductCandidate["variants"],
      productType: p.productType,
      tags: p.tags,
      description: p.description,
      metafieldText: p.metafieldText,
      score: null,
      headline: null,
      matchedTerms: [],
      coverage: 0,
      fused: 1 / (60 + i),
    }));
  } catch (error) {
    console.error("custom_recommendation_error", error);
    return null;
  }
}

/** Cross-sell (spec 08): companions of anchored cards appended, 6-card cap. */
async function appendCrossSell(
  shopId: string,
  cards: ProductCard[],
  excludeOutOfStock: boolean,
): Promise<ProductCard[]> {
  try {
    if (cards.length === 0) return cards;
    const anchors = await db.crossSellPair.findMany({
      where: {
        shopId,
        status: "active",
        productId: { in: cards.map((c) => c.shopifyProductId) },
      },
      select: { companionIds: true },
    });
    if (anchors.length === 0) return cards;
    const have = new Set(cards.map((c) => c.shopifyProductId));
    const companionIds = anchors
      .flatMap((a) => a.companionIds)
      .filter((id) => !have.has(id))
      .slice(0, 6 - cards.length);
    if (companionIds.length === 0) return cards;
    const companions = await cardsForShopifyIds(shopId, companionIds, excludeOutOfStock);
    return [...cards, ...companions].slice(0, 6);
  } catch (error) {
    console.error("cross_sell_error", error);
    return cards;
  }
}

/** Prisma equivalent of product-search's purchasable SQL: tracked stock OR any
 *  variant availableForSale (array_contains → jsonb `@>` containment). */
function purchasableWhere(excludeOutOfStock: boolean): Prisma.ProductWhereInput {
  if (!excludeOutOfStock) return {};
  return {
    OR: [{ stock: { gt: 0 } }, { variants: { array_contains: [{ available: true }] } }],
  };
}

async function cardsForShopifyIds(
  shopId: string,
  shopifyProductIds: string[],
  excludeOutOfStock: boolean,
): Promise<ProductCard[]> {
  if (shopifyProductIds.length === 0) return [];
  const rows = await db.product.findMany({
    where: {
      shopId,
      shopifyProductId: { in: shopifyProductIds },
      ...purchasableWhere(excludeOutOfStock),
    },
    select: {
      shopifyProductId: true, title: true, price: true, imageUrl: true, handle: true, variants: true,
    },
  });
  return rows.map((r) => ({
    shopifyProductId: r.shopifyProductId,
    title: r.title,
    price: Number(r.price),
    imageUrl: r.imageUrl,
    handle: r.handle,
    variantId: numericVariantId(r.variants as { id: string; available: boolean }[] | null),
  }));
}

function toCard(candidate: ProductCandidate): ProductCard {
  return {
    shopifyProductId: candidate.shopifyProductId,
    title: candidate.title,
    price: candidate.price,
    imageUrl: candidate.imageUrl,
    handle: candidate.handle,
    variantId: numericVariantId(candidate.variants),
  };
}

// ── Rate limiting (in-memory token bucket per session) ──────────────────────

declare global {
  // eslint-disable-next-line no-var
  var rateBuckets: Map<string, { tokens: number; at: number }> | undefined;
}

const BUCKET_CAPACITY = 10;
const REFILL_PER_MS = 10 / 60_000; // 10 per minute

function consumeToken(bucketKey: string): boolean {
  if (!global.rateBuckets) global.rateBuckets = new Map();
  const now = Date.now();
  const bucket = global.rateBuckets.get(bucketKey) ?? { tokens: BUCKET_CAPACITY, at: now };
  bucket.tokens = Math.min(BUCKET_CAPACITY, bucket.tokens + (now - bucket.at) * REFILL_PER_MS);
  bucket.at = now;
  if (bucket.tokens < 1) {
    global.rateBuckets.set(bucketKey, bucket);
    return false;
  }
  bucket.tokens -= 1;
  global.rateBuckets.set(bucketKey, bucket);
  if (global.rateBuckets.size > 10_000) {
    // Prune stale buckets (idle >10 min) instead of a global reset.
    const cutoff = now - 10 * 60 * 1000;
    for (const [key, b] of global.rateBuckets) {
      if (b.at < cutoff) global.rateBuckets.delete(key);
    }
  }
  return true;
}
