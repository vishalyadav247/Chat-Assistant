import type { Conversation, Prisma } from "@prisma/client";
import db from "../../db.server";
import { recordEvent, type AnalyticsEventType } from "../analytics/events.server";
import { tickConversation, aiAllowed } from "../billing/usage.server";
import { getShopConfig, type ShopConfig } from "../config/shop-config.server";
import { embedText } from "../embeddings/embedding.server";
import { getLlmProvider, type ChatMessage } from "../llm/index.server";
import {
  hybridProductSearch,
  browseCheapestInBudget,
  candidateSnippet,
  purchasableWhere,
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
import { logError } from "../log.server";
import { createTrace, type Trace, type TraceStep, type TraceSummary } from "./trace.server";

// Runtime agent pipeline (spec 03). The LLM is only the voice: code picks the
// lane, fetches facts, builds cards from DB rows. One embedding per turn,
// reused across guardrail/curated/search/RAG. Budget ≈ 2 chat + 1-2 embedding
// calls; curated/blocked/off-topic/clarify paths make ZERO generation calls.

/** Analytics writer bound to this turn — tags every event with payload.isTest
 *  when the turn came from the merchant's Test AI console (QA D3), so KPI
 *  readers can exclude test traffic. */
type TrackFn = (type: AnalyticsEventType, payload?: Record<string, unknown>) => Promise<void>;

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
  // Test AI only: the full decision record for the turn, yielded after "done"
  // by api.test-chat.tsx. Storefront turns never carry it (noop trace).
  | { type: "trace"; steps: TraceStep[]; summary: TraceSummary };

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
const BLOCKED_MESSAGE = "This chat has been closed by the store team.";

export async function* runPipeline(
  input: PipelineInput,
  // Test AI passes a live trace; storefront turns get the shared noop, which
  // records nothing and never touches the hot path (trace.server.ts).
  trace: Trace = createTrace(false),
): AsyncIterable<PipelineFrame> {
  const shopId = requireShopId(input.shopId);
  const message = input.message.slice(0, 2000).trim();

  // Rate limit before any spend (bucket keyed shop+session — tenancy audit).
  if (!consumeToken(`${shopId}:${input.sessionId}`)) {
    trace.step("rate_limit", "Per-session rate limit", "hit", { bucket: "shopId:sessionId" });
    yield { type: "message", text: BUSY_MESSAGE };
    yield { type: "done", outcome: "rate_limited", conversationId: input.conversationId ?? "" };
    return;
  }

  const config = await getShopConfig(shopId);
  const { conversation: convo, previousLastMessageAt } = await ensureConversation(shopId, input);
  const isTest = input.isTest ?? false;
  // Test-AI turns must never pollute merchant KPIs: every pipeline event this
  // turn records carries payload.isTest so readers can exclude them (the
  // rollup already excludes test turns via Message→Conversation.isTest; the
  // curated KPIs now do too). Unresolved-queue writes are skipped entirely.
  const track: TrackFn = (type, payload) =>
    recordEvent(shopId, type, isTest ? { ...(payload ?? {}), isTest: true } : payload);

  trace.step("config", "Shop config resolved", "info", {
    plan: config.plan,
    aiEnabled: config.aiEnabled,
    persona: config.persona ? "custom" : "default",
    "learn.products": config.settings.learn.products,
    "learn.discounts": config.settings.learn.discounts,
    answerOnlyFromKnowledge: config.guardrails?.answerOnlyFromKnowledge ?? true,
    curatedMatchThreshold: config.guardrails?.curatedMatchThreshold ?? 0.8,
    curatedBorderline: config.guardrails?.curatedBorderline ?? 0.65,
    bannedMatchThreshold: config.guardrails?.bannedMatchThreshold ?? 0.35,
    minMeaningScore: config.guardrails?.minMeaningScore ?? 0.3,
    bannedTopics: config.guardrails?.bannedTopics ?? [],
    handoverIntentRules: config.handover.intentRules.length,
  });
  trace.step("conversation", "Conversation resolved", "info", {
    conversationId: convo.id,
    isNewConversation: previousLastMessageAt === null,
    mode: convo.mode,
    blocked: convo.blocked,
    isTest,
  });

  // Blocked visitor (merchant action, spec 10): nothing is stored, the AI
  // stays silent and the widget locks its composer on this outcome.
  if (convo.blocked) {
    trace.step("visitor_blocked", "Visitor blocked by the team", "hit", { stored: false });
    yield { type: "message", text: BLOCKED_MESSAGE };
    yield { type: "done", outcome: "visitor_blocked", conversationId: convo.id };
    return;
  }

  const shopperMessageId = await saveMessage(shopId, convo.id, {
    role: "in", author: "shopper", content: message,
  });

  // Human mode: AI stays dormant (spec 10 wires aiWhileWaiting refinements).
  // The team hears about the shopper's message instead (spec 18 push).
  if (convo.mode === "human") {
    trace.step("human_mode", "Conversation in human mode — AI dormant", "hit", {
      notifiedTeam: !input.isTest,
    });
    if (!input.isTest) await notifyShopperMessage(shopId, convo.id);
    yield { type: "done", outcome: "human_mode", conversationId: convo.id };
    return;
  }

  if (!config.aiEnabled || !(await aiAllowed(shopId))) {
    trace.step("ai_availability", "AI unavailable", "hit", {
      aiEnabled: config.aiEnabled,
      reason: config.aiEnabled ? "usage cap reached" : "AI switched off in settings",
    });
    const text = CAP_MESSAGE;
    await saveMessage(shopId, convo.id, { role: "out", author: "system", content: text, sourceLayer: "cap" });
    yield { type: "message", text };
    yield { type: "done", outcome: "ai_unavailable", conversationId: convo.id };
    return;
  }

  const guardrails = config.guardrails;
  const fallback = guardrails?.fallbackMessage?.trim() || DEFAULT_FALLBACK;
  // previousLastMessageAt is the row's lastMessageAt BEFORE this turn touched
  // it — the 30-min session rule in usage.server.ts needs that value (QA D13).
  const meterPromise = tickConversation({
    shopId,
    conversationId: convo.id,
    isTest: input.isTest,
    previousLastMessageAt,
  });

  // ── Handover triggers: explicit ask / sentiment / repeat (pre-embedding) ──
  const earlyTrigger = await detectHandover({
    shopId,
    conversationId: convo.id,
    message,
    queryEmbedding: null,
    handover: config.handover,
  }).catch(() => null);
  trace.step("handover_text", "Handover triggers (text)", earlyTrigger ? "hit" : "pass", {
    trigger: earlyTrigger,
    checks: ["explicit ask", "negative sentiment", "repeated question"],
  });
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
  trace.step(
    "guardrail_keyword",
    "Banned topics: word-boundary scan",
    !guardrails || guardrails.bannedTopics.length === 0 ? "skip" : kwHit ? "hit" : "pass",
    { topics: guardrails?.bannedTopics ?? [], matched: kwHit?.topic ?? null },
  );
  if (kwHit) {
    yield* await finishBlocked(shopId, convo.id, fallback, kwHit.layer, meterPromise, track);
    return;
  }

  // ── One embedding per turn ────────────────────────────────────────────────
  const queryEmbedding = await embedText(message, { shopId });
  trace.countLlm("embedding");
  trace.step("embedding", "Message embedded once, reused all turn", "info", {
    dimensions: queryEmbedding.length,
    embeddedText: message,
  });

  // ── Handover intent rules (needs the embedding) ───────────────────────────
  if (config.handover.intentRules.length === 0) {
    trace.step("handover_intent", "Handover intent rules (vector)", "skip", {
      reason: "no intent rules configured",
    });
  }
  if (config.handover.intentRules.length > 0) {
    const ruleTrigger = await detectHandover({
      shopId,
      conversationId: convo.id,
      message: "", // text triggers already checked pre-embedding
      queryEmbedding,
      handover: { ...config.handover, triggers: { ...config.handover.triggers, negativeSentiment: { enabled: false }, repeatedQuestion: { ...config.handover.triggers.repeatedQuestion, enabled: false } } },
    }).catch(() => null);
    trace.step(
      "handover_intent",
      "Handover intent rules (vector)",
      ruleTrigger === "intent_rule" ? "hit" : "pass",
      { rules: config.handover.intentRules.length },
    );
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
  if (!guardrails || guardrails.bannedTopics.filter((t) => t.trim()).length === 0) {
    trace.step("guardrail_meaning", "Banned topics: meaning scan", "skip", {
      reason: "no banned topics configured",
    });
  }
  if (guardrails) {
    const meaningHit = await meaningScan(shopId, queryEmbedding, guardrails);
    if (guardrails.bannedTopics.filter((t) => t.trim()).length > 0) {
      trace.step("guardrail_meaning", "Banned topics: meaning scan", meaningHit ? "hit" : "pass", {
        threshold: guardrails.bannedMatchThreshold,
        matchedTopic: meaningHit?.topic ?? null,
        score: meaningHit?.score ?? null,
      });
    }
    if (meaningHit) {
      yield* await finishBlocked(shopId, convo.id, fallback, meaningHit.layer, meterPromise, track);
      return;
    }
  }

  // ── Curated shortcut (zero generation) ────────────────────────────────────
  const curatedThreshold = guardrails?.curatedMatchThreshold ?? 0.8;
  const curatedBorderline = guardrails?.curatedBorderline ?? 0.65;
  const curated = await curatedMatch(shopId, queryEmbedding);
  trace.step(
    "curated_match",
    "Merchant curated answers (vector)",
    !curated ? "miss" : curated.score >= curatedBorderline ? "hit" : "miss",
    {
      bestMatch: curated?.question ?? null,
      score: curated?.score ?? null,
      serveThreshold: curatedThreshold,
      borderlineThreshold: curatedBorderline,
      verdict: !curated
        ? "no published curated answer scored"
        : curated.score >= curatedThreshold
          ? "above serve threshold — serve directly"
          : curated.score >= curatedBorderline
            ? "borderline — ask the model to confirm"
            : "below borderline — skip this layer",
      pinnedProducts: curated?.productIds.length ?? 0,
    },
  );
  if (curated && curated.score >= curatedBorderline) {
    let use = curated.score >= curatedThreshold;
    if (!use) {
      const answer = await getLlmProvider().chat(
        [
          { role: "system", content: CURATED_CONFIRM_SYSTEM },
          { role: "user", content: curatedConfirmUser(message, curated.question) },
        ],
        { shopId, purpose: "router" },
        { temperature: 0, maxTokens: 3 },
      );
      use = answer.trim().toLowerCase().startsWith("y");
      trace.countLlm("router");
      trace.step(
        "curated_confirm",
        "Borderline curated: yes/no confirm call",
        use ? "pass" : "miss",
        { modelAnswer: answer.trim().slice(0, 20), accepted: use },
      );
    }
    if (use) {
      const cards = await cardsForShopifyIds(
        shopId, curated.productIds, config.settings.recommendationRules.excludeOutOfStock,
      );
      // Spec 09 "all dead → no-match": an answer whose hand-picked products are
      // ALL unavailable/deleted must not be served card-less — fall through to
      // the next layer instead (QA D11). Answers with no products are text-only
      // by design and still serve.
      if (curated.productIds.length > 0 && cards.length === 0) {
        use = false;
        trace.step("curated_cards", "Curated products all unavailable", "miss", {
          pinnedProducts: curated.productIds.length,
          resolvedCards: 0,
          effect: "falling through to the next layer (QA D11)",
        });
      }
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
      trace.step("curated_served", "Served from curated — zero generation calls", "hit", {
        curatedId: curated.id,
        score: curated.score,
        cards: cards.length,
      });
      await track("curated_served", { curatedId: curated.id, score: curated.score });
      await meterPromise;
      yield { type: "message", text: curated.talkingPoints };
      if (cards.length > 0) yield { type: "cards", cards };
      yield { type: "done", outcome: "curated", conversationId: convo.id };
      return;
    }
  }

  // ── App recommendations (ranked below merchant curated, spec 08) ──────────
  const recommendation = await recommendationMatch(shopId, queryEmbedding).catch((error) => {
    logError("recommendation_match_error", error, { shopId });
    return null;
  });
  trace.step(
    "recommendation_match",
    "App recommendations (vector)",
    recommendation && recommendation.score >= curatedThreshold ? "hit" : "miss",
    {
      bestMatch: recommendation?.title ?? null,
      score: recommendation?.score ?? null,
      threshold: curatedThreshold,
      pinnedProducts: recommendation?.productIds.length ?? 0,
    },
  );
  if (recommendation && recommendation.score >= curatedThreshold) {
    const cards = await cardsForShopifyIds(
      shopId, recommendation.productIds, config.settings.recommendationRules.excludeOutOfStock,
    );
    if (cards.length === 0) {
      trace.step("recommendation_cards", "Recommendation products all unavailable", "miss", {
        pinnedProducts: recommendation.productIds.length,
        effect: "falling through to the router",
      });
    }
    if (cards.length > 0) {
      const text = `${recommendation.title} — here are our picks:`;
      await saveMessage(shopId, convo.id, {
        role: "out",
        author: "ai",
        content: text,
        sourceLayer: "recommendation",
        productCards: cards,
      });
      trace.step("recommendation_served", "Served from a recommendation", "hit", {
        recommendationId: recommendation.id,
        score: recommendation.score,
        cards: cards.length,
      });
      await track("recommendation_shown", {
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
  trace.step("history", "Conversation history loaded", "info", {
    routerTurns: routerHistory.length,
    generationTurns: generationHistory.length,
  });
  const moderationPromise = moderationCheck(shopId, message);
  const routed = await route({
    shopId,
    message,
    history: routerHistory,
    bannedTopics: guardrails?.bannedTopics ?? [],
    storeScope: config.persona?.scope ?? "",
  });
  trace.countLlm("router");
  trace.step("router", "Intent router (LLM call 1 of 2)", routed.parseFailed ? "error" : "info", {
    intent: routed.intent,
    keywords: routed.keywords,
    price_max: routed.price_max,
    blocked: routed.blocked,
    blocked_reason: routed.blocked_reason || null,
    off_topic: routed.off_topic,
    off_topic_reason: routed.off_topic_reason || null,
    parseFailed: routed.parseFailed ?? false,
    storeScope: config.persona?.scope || null,
  });
  const moderationHit = await moderationPromise;
  trace.countLlm("moderation");
  trace.step("guardrail_moderation", "Provider moderation (ran in parallel)", moderationHit ? "hit" : "pass", {
    flagged: moderationHit?.topic ?? null,
  });
  if (moderationHit) {
    yield* await finishBlocked(shopId, convo.id, fallback, "moderation", meterPromise, track);
    return;
  }
  // The router may only enforce a policy the MERCHANT configured. With no
  // banned topics the prompt carries no BANNED TOPICS line, yet the model
  // still returned blocked:true on roughly a third of runs for ordinary
  // product questions ("something that blocks rfid") — inventing a rule and
  // refusing a real shopper. Independent safety is unaffected: moderation ran
  // above, and configured banned topics are enforced deterministically by
  // keywordScan + meaningScan before this point.
  const bannedConfigured = (guardrails?.bannedTopics ?? []).some((t) => t.trim());
  trace.step(
    "router_block",
    "Router policy block",
    routed.blocked && bannedConfigured ? "hit" : routed.blocked ? "skip" : "pass",
    {
      routerSaidBlocked: routed.blocked,
      merchantConfiguredBannedTopics: bannedConfigured,
      note: routed.blocked && !bannedConfigured
        ? "ignored — the router may only enforce a policy the merchant configured"
        : null,
    },
  );
  if (routed.blocked && bannedConfigured) {
    yield* await finishBlocked(shopId, convo.id, fallback, "router", meterPromise, track);
    return;
  }
  if (routed.off_topic) {
    trace.step("off_topic", "Off-topic redirect", "hit", { reason: routed.off_topic_reason });
    const text =
      config.persona?.offTopicMessage?.trim() ||
      "I can only help with our store's products and orders.";
    await saveMessage(shopId, convo.id, {
      role: "out", author: "ai", content: text, sourceLayer: "off_topic", intent: routed,
    });
    await track("turn_off_topic", { reason: routed.off_topic_reason });
    await meterPromise;
    yield { type: "message", text };
    yield { type: "done", outcome: "off_topic", conversationId: convo.id };
    return;
  }
  if (routed.parseFailed) {
    trace.step("router_parse_failed", "Router JSON unparseable after retry", "error", {
      effect: "clarify (never defaults to buy)",
    });
    await saveMessage(shopId, convo.id, {
      role: "out", author: "ai", content: CLARIFY_MESSAGE, sourceLayer: "clarify",
    });
    await track("turn_fell_back", { reason: "router_parse_failed" });
    await recordUnresolved(shopId, convo.id, message, "fell_back", isTest);
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
  trace.step("lane", `Lane selected: ${routed.intent}`, "info", {
    buy: "hybrid product search over the catalogue",
    question: "RAG over merchant knowledge",
    chat: "persona reply, no retrieval",
    selected: routed.intent,
  });

  if (routed.intent === "buy") {
    yield* buyLane({
      shopId, convoId: convo.id, config, message, queryEmbedding,
      keywords: routed.keywords, priceMax: routed.price_max,
      personaPrompt, generationHistory, meterPromise, routed, isTest, track, trace,
    });
    return;
  }

  if (routed.intent === "question") {
    yield* questionLane({
      shopId, convoId: convo.id, config, message, queryEmbedding,
      fallback, personaPrompt, generationHistory, meterPromise, routed, isTest, track, trace,
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
    { shopId, purpose: "reply" },
    { temperature: 0.5, maxTokens: 60 },
  );
  trace.step("generation", "Reply generation (LLM call 2 of 2)", "info", {
    prompt: "persona + CHAT_REPLY",
    grounding: "none — small talk lane retrieves nothing",
    temperature: 0.5,
    maxTokens: 60,
  });
  yield* streamAndLog({
    shopId, convoId: convo.id, stream, sourceLayer: "chat", intent: routed, meterPromise, track, trace,
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
  isTest: boolean;
  track: TrackFn;
  trace: Trace;
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

  args.trace.step(
    "product_search",
    constrained ? "Custom recommendation pool (hand-picked)" : "Hybrid product search",
    !learnProducts ? "skip" : candidates.length > 0 ? "hit" : "miss",
    {
      method: !learnProducts
        ? "skipped: Learn products is off, the catalogue is off-limits"
        : constrained
          ? "merchant custom recommendation pool for a matched search term"
          : "pgvector cosine + weighted tsvector keyword tier, fused by reciprocal rank",
      routerKeywords: args.keywords,
      priceMax: args.priceMax,
      minMeaningScore,
      excludeOutOfStock,
      candidatesFound: candidates.length,
      ranked: candidates.slice(0, 8).map((c) => ({
        title: c.title,
        price: c.price,
        vectorScore: c.score,
        fusedRank: c.fused,
        keywordCoverage: c.coverage,
        matchedTerms: c.matchedTerms,
      })),
    },
  );

  if (learnProducts && candidates.length === 0 && args.priceMax !== null) {
    candidates = await browseCheapestInBudget(args.shopId, args.priceMax, 4, excludeOutOfStock);
    browse = true;
    args.trace.step("browse_fallback", "Nothing matched, cheapest in budget instead", "hit", {
      priceMax: args.priceMax,
      candidatesFound: candidates.length,
    });
  }

  if (candidates.length === 0) {
    args.trace.step("no_candidates", "No product candidates, asking to clarify", "miss", {
      effect: "clarify reply; the question is logged to the unresolved queue",
    });
    await saveMessage(args.shopId, args.convoId, {
      role: "out", author: "ai", content: CLARIFY_MESSAGE, sourceLayer: "clarify", intent: args.routed,
    });
    await args.track("turn_fell_back", { reason: "no_candidates" });
    await recordUnresolved(args.shopId, args.convoId, args.message, "fell_back", args.isTest);
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

  args.trace.step("relevance_cut", "Top match tier kept, never padded to four", "info", {
    rule:
      candidates[0].coverage > 0
        ? `keyword tier: every candidate matching ${candidates[0].coverage} weighted query words`
        : candidates[0].score !== null
          ? "vector only: rows within 0.04 cosine of the best score"
          : "unscored pool (browse / hand-picked): kept as-is",
    candidatesIn: candidates.length,
    kept: relevant.length,
  });
  args.trace.step("allow_list", "Exact product payload handed to the model", "info", {
    contract:
      "the model may only speak about these rows; titles and prices are rendered from the DB, never from the model",
    products: allowList,
  });
  args.trace.step(
    "cross_sell",
    "Cross-sell companions appended",
    cards.length > relevant.length ? "hit" : "pass",
    { cardsBefore: relevant.length, cardsAfter: cards.length, cap: 6 },
  );

  const stream = getLlmProvider().chatStream(
    [
      { role: "system", content: `${args.personaPrompt}\n${PRODUCT_RECOMMEND}` },
      ...args.generationHistory,
      {
        role: "user",
        content: `Candidate products: ${JSON.stringify(allowList)}\n\nShopper: ${args.message}`,
      },
    ],
    { shopId: args.shopId, purpose: "reply" },
    // Compact reply (user decision 2026-08-18): 1-2 sentences, no titles/prices.
    { temperature: 0.3, maxTokens: 90 },
  );

  args.trace.step("generation", "Reply generation (LLM call 2 of 2)", "info", {
    prompt: "persona + PRODUCT_RECOMMEND",
    grounding: `${allowList.length} candidate products (allow-list above)`,
    historyTurns: args.generationHistory.length,
    temperature: 0.3,
    maxTokens: 90,
  });
  await args.track("recommendation_shown", {
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
    track: args.track,
    trace: args.trace,
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
  isTest: boolean;
  track: TrackFn;
  trace: Trace;
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

  args.trace.step(
    "knowledge_search",
    "RAG retrieval over merchant knowledge",
    strongEnough ? "hit" : "miss",
    {
      method: "pgvector cosine over knowledge chunks, top 3",
      minMeaningScore,
      strongEnough,
      verdict: strongEnough
        ? "best hit clears the floor, ground the answer in these chunks"
        : "nothing clears the floor, fall back unless discounts supply the facts",
      hits: hits.map((h) => ({
        topic: h.topic,
        score: h.score,
        excerpt: h.body.replace(/\s+/g, " ").slice(0, 240),
      })),
    },
  );
  args.trace.step(
    "discount_context",
    "Synced discount facts",
    !args.config.settings.learn.discounts ? "skip" : discountContext ? "hit" : "pass",
    {
      reason: args.config.settings.learn.discounts ? null : "Learn discounts is off",
      injected: Boolean(discountContext),
    },
  );

  // Discount questions are grounded mechanically from the synced Discount
  // mirror (spec 02 backlog: "synced discounts become RAG-available later").
  // When we hold real discount facts, the no-knowledge fallback is skipped —
  // the context IS the store info for this turn.
  if ((guardrails?.answerOnlyFromKnowledge ?? true) && !strongEnough && !discountContext) {
    args.trace.step("rag_fallback", "No grounded facts, serving the fallback message", "miss", {
      rule: "Answer only from knowledge is ON, so the model is not allowed to improvise",
      effect: "fallback reply; the question is logged to the unresolved queue",
    });
    await saveMessage(args.shopId, args.convoId, {
      role: "out", author: "ai", content: args.fallback, sourceLayer: "rag_fallback", intent: args.routed,
    });
    await args.track("turn_fell_back", { reason: "no_knowledge" });
    await recordUnresolved(args.shopId, args.convoId, args.message, "fell_back", args.isTest);
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
    { shopId: args.shopId, purpose: "reply" },
    { temperature: 0.3, maxTokens: 220 },
  );
  args.trace.step("generation", "Reply generation (LLM call 2 of 2)", "info", {
    prompt: "persona + QUESTION_ANSWER",
    grounding: "the store-info block below, the model may not answer past it",
    storeInfo: context,
    historyTurns: args.generationHistory.length,
    temperature: 0.3,
    maxTokens: 220,
  });
  yield* streamAndLog({
    shopId: args.shopId,
    convoId: args.convoId,
    stream,
    sourceLayer: "question",
    intent: args.routed,
    meterPromise: args.meterPromise,
    track: args.track,
    trace: args.trace,
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
  track: TrackFn;
  trace?: Trace;
}): AsyncIterable<PipelineFrame> {
  let full = "";
  try {
    for await (const token of args.stream) {
      full += token;
      yield { type: "token", text: token };
    }
  } catch (error) {
    logError("generation_error", error, { shopId: args.shopId });
    await args.track("llm_error", { layer: args.sourceLayer });
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
  args.trace?.countLlm("reply");
  args.trace?.step("reply", "Reply streamed and saved", "info", {
    sourceLayer: args.sourceLayer,
    characters: full.length,
    cards: args.cards?.length ?? 0,
    text: full,
  });
  await args.track("turn_completed", { sourceLayer: args.sourceLayer });
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
    logError("handover_escalate_error", error, { shopId });
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
  isTest = false,
): Promise<void> {
  // Test-AI turns must never enter the merchant's review queue (QA D3).
  if (isTest) return;
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
    logError("unresolved_record_error", error, { shopId });
  }
}

async function finishBlocked(
  shopId: string,
  convoId: string,
  fallback: string,
  layer: string,
  meterPromise: Promise<unknown>,
  track: TrackFn,
): Promise<PipelineFrame[]> {
  await saveMessage(shopId, convoId, {
    role: "out", author: "ai", content: fallback, sourceLayer: `banned_${layer}`,
  });
  await track("turn_blocked", { layer });
  await meterPromise;
  return [
    { type: "message", text: fallback },
    { type: "done", outcome: "blocked", conversationId: convoId },
  ];
}

/** Resolve (or create) this turn's conversation. Returns the row PLUS the
 *  `lastMessageAt` it had BEFORE this turn stamped it — the billing session
 *  rule (30-min idle ⇒ new metered session) needs the pre-update value, since
 *  the update below always sets it to now (QA D13). */
async function ensureConversation(
  shopId: string,
  input: PipelineInput,
): Promise<{ conversation: Conversation; previousLastMessageAt: Date | null }> {
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
      // never re-flags a blocked thread unread
      if (existing.blocked) {
        return { conversation: existing, previousLastMessageAt: existing.lastMessageAt };
      }
      const previousLastMessageAt = existing.lastMessageAt;
      await db.conversation.update({
        where: { id: existing.id },
        data: {
          lastMessageAt: new Date(),
          unread: true,
          pageContext: mergePageContext(existing.pageContext, input.pageContext, input.userAgent),
        },
      });
      return { conversation: existing, previousLastMessageAt };
    }
  }
  const bySession = await db.conversation.findFirst({
    where: { shopId, sessionId: input.sessionId, status: "open" },
    orderBy: { startedAt: "desc" },
  });
  if (bySession) {
    if (bySession.blocked) {
      return { conversation: bySession, previousLastMessageAt: bySession.lastMessageAt };
    }
    const previousLastMessageAt = bySession.lastMessageAt;
    await db.conversation.update({
      where: { id: bySession.id },
      data: {
        lastMessageAt: new Date(),
        unread: true,
        pageContext: mergePageContext(bySession.pageContext, input.pageContext, input.userAgent),
      },
    });
    return { conversation: bySession, previousLastMessageAt };
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
  return { conversation: created, previousLastMessageAt: null };
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
    logError("custom_recommendation_error", error, { shopId });
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
    logError("cross_sell_error", error, { shopId });
    return cards;
  }
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
