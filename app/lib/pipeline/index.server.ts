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
  normalizeNumberIds,
  purchasableWhere,
  selectRelevant,
  TIER_MARGIN,
  type ProductCandidate,
} from "../search/product-search.server";
import { knowledgeSearch } from "../search/knowledge-search.server";
import { curatedMatch } from "../search/curated-match.server";
import { recommendationMatch } from "../search/recommendation-match.server";
import { ensureSessionContact } from "../contacts/contacts.server";
import { formatMoney } from "../format/money";
import { requireShopId } from "../tenancy.server";
import { mergePageContext } from "../widget/page-context.server";
import { notifyNewConversation, notifyShopperMessage } from "../notify.server";
import { keywordScan, meaningScan, moderationCheck } from "./guardrail.server";
import { detectHandover, detectCannotAnswer, executeHandover } from "./handover.server";
import { loadHistory } from "./history.server";
import {
  actionInstruction,
  availableActions,
  splitActionStream,
  type ChatAction,
} from "./actions.server";
import { splitPicksStream } from "./picks.server";
import { route } from "./router.server";
import { shopperContext } from "./shopper.server";
import {
  blockConfirmUser,
  buildPersonaPrompt,
  CHAT_REPLY,
  CURATED_CONFIRM_SYSTEM,
  curatedConfirmUser,
  languageInstruction,
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
  /** Stable per-browser id. sessionId rotates on the 30-minute billing rule;
   *  this is what keeps a returning shopper the same person (spec 11). */
  visitorId?: string;
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
  // Buttons that open a screen of the widget itself (order tracking, contact,
  // help) — the answer to "just click the Track navigation", which named
  // storefront chrome that does not exist. See actions.server.ts.
  | { type: "actions"; actions: import("./actions.server").ChatAction[] }
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
  /** The SAME variant as a GID, for Shopify.actions.updateCart — the standard
   *  storefront action the widget prefers, because it works on Horizon and
   *  every other theme, where the Dawn-shaped /cart/add.js + sections path
   *  silently fell back to a full page navigation. Null when variantId is. */
  variantGid: string | null;
}

/** First available variant (else the first at all) as {numeric, gid}. The two
 *  cart paths want different spellings of the same id, so both ride the card. */
function variantIds(
  variants: { id: string; available: boolean }[] | null | undefined,
): { variantId: string | null; variantGid: string | null } {
  const first = variants?.find((v) => v.available) ?? variants?.[0];
  if (!first) return { variantId: null, variantGid: null };
  const numeric = first.id.split("/").pop();
  if (!numeric || !/^\d+$/.test(numeric)) return { variantId: null, variantGid: null };
  // Mirrored rows always store the gid, but a legacy row may hold the bare id.
  const gid = first.id.startsWith("gid://") ? first.id : `gid://shopify/ProductVariant/${numeric}`;
  return { variantId: numeric, variantGid: gid };
}

const DEFAULT_FALLBACK =
  "I'm not sure about that one — leave your email and our team will get back to you.";
const CLARIFY_MESSAGE = "I couldn't find a match — what kind of item are you after?";
const BUSY_MESSAGE = "You're sending messages very quickly — give me a few seconds and try again.";
const CAP_MESSAGE = "Our chat assistant is offline right now — leave your email and we'll follow up.";
const BLOCKED_MESSAGE = "This chat has been closed by the store team.";
/** Ranked candidates the reply model may choose cards from (the allow-list).
 *  Cards shown stay ≤ 4 (+ cross-sell); this is what the model gets to READ. */
const MODEL_CANDIDATES = 8;
/** Text when the model returned only a PICKS line and no prose. */
const PICKS_ONLY_REPLY = "Here's what I found — tell me if you'd like more options.";

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

  // ── Fan out everything that does not depend on anything else ──────────────
  // Measured 2026-09-04 (prod: first reply median 5.8 s, chat-lane p90 20.7 s):
  // the turn was a chain of round trips that had no reason to be one. The
  // embedding gates the vector layers, but the ROUTER needs only the history —
  // so it starts here and is awaited below, hiding its ~1.1 s behind the
  // embedding's ~0.9 s. Moderation joins them (it was already parallel, just
  // started later). A turn that short-circuits before the router (curated /
  // recommendation / off-topic) throws that call away: ~$0.0002 on well under
  // 5% of turns, against ~1 s saved on every other one.
  const embedPromise = embedText(message, { shopId });
  const historyPromise = loadHistory(shopId, convo.id, {
    excludeMessageId: shopperMessageId, // appended once below, never twice
  });
  const routedPromise = historyPromise.then((history) =>
    route({
      shopId,
      message,
      history: history.routerHistory,
      bannedTopics: guardrails?.bannedTopics ?? [],
      storeScope: config.persona?.scope ?? "",
    }),
  );
  const moderationPromise = moderationCheck(shopId, message);
  const shopperPromise = shopperContext({
    shopId,
    contactId: convo.contactId,
    // The row's blob was merged with THIS turn's context by ensureConversation
    // above, so it already carries the page they are on and the live cart.
    pageContext: mergePageContext(convo.pageContext, input.pageContext, input.userAgent),
    currency: config.currency,
  });
  // Nothing awaits these on a short-circuit path, and an unhandled rejection
  // takes the process down under Node's default policy.
  const settle = (p: Promise<unknown>) => void p.catch(() => {});
  settle(routedPromise);
  settle(moderationPromise);
  settle(shopperPromise);

  // ── One embedding per turn ────────────────────────────────────────────────
  const queryEmbedding = await embedPromise;
  trace.countLlm("embedding");
  trace.step("embedding", "Message embedded once, reused all turn", "info", {
    dimensions: queryEmbedding.length,
    embeddedText: message,
  });

  // The three vector layers below read the embedding and nothing else, so they
  // run together instead of end to end (measured cold: 626 + 58 + 598 ms
  // sequential → ~630 ms). Precedence is unchanged: the results are still
  // CONSULTED in order — banned meaning, then merchant curated, then app
  // recommendations — only the waiting overlaps.
  const curatedThreshold = guardrails?.curatedMatchThreshold ?? 0.8;
  const curatedBorderline = guardrails?.curatedBorderline ?? 0.65;
  const meaningPromise = guardrails
    ? meaningScan(shopId, queryEmbedding, guardrails)
    : Promise.resolve(null);
  // The raw message goes in too: curatedMatch runs a second lane that matches
  // the merchant's own synonym phrasings exactly, which no embedding can.
  const curatedPromise = curatedMatch(shopId, queryEmbedding, message);
  const recommendationPromise = recommendationMatch(shopId, queryEmbedding).catch((error) => {
    logError("recommendation_match_error", error, { shopId });
    return null;
  });
  settle(meaningPromise);
  settle(curatedPromise);

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
    const meaningHit = await meaningPromise;
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
  const curated = await curatedPromise;
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
  const recommendation = await recommendationPromise;
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

  // ── Router (started at the top of the turn — layer b raced beside it) ─────
  const { routerHistory, generationHistory } = await historyPromise;
  trace.step("history", "Conversation history loaded", "info", {
    routerTurns: routerHistory.length,
    generationTurns: generationHistory.length,
  });
  const routed = await routedPromise;
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
  // …and it may only block for one of THOSE topics, and only after a second
  // look. With topics configured the router still blocked "something that
  // blocks rfid" about one run in three — once citing a reason on no
  // merchant's list, once citing "weapons". Two checks: the reason must NAME a
  // configured topic (word-prefix match, so "political opinions" counts for
  // "politics"), and a focused yes/no confirm call must agree that the message
  // asks for advice/information about that topic rather than for a product.
  // (Embedding similarity was tried as the second check and cannot separate
  // them: "blocks rfid"↔weapons scores 0.23, "cure my arthritis"↔medical
  // advice 0.28.) Blocked turns still make zero generation calls.
  const bannedConfigured = (guardrails?.bannedTopics ?? []).some((t) => t.trim());
  const citedTopic =
    routed.blocked && bannedConfigured
      ? configuredTopicNamedBy(routed.blocked_reason, guardrails?.bannedTopics ?? [])
      : null;
  let confirmed: boolean | null = null;
  let confirmAnswer: string | null = null;
  if (citedTopic) {
    try {
      const answer = await getLlmProvider().chat(
        [
          { role: "system", content: CURATED_CONFIRM_SYSTEM },
          { role: "user", content: blockConfirmUser(message, citedTopic) },
        ],
        { shopId, purpose: "router" },
        { temperature: 0, maxTokens: 3 },
      );
      trace.countLlm("router");
      confirmAnswer = answer.trim().slice(0, 20);
      confirmed = answer.trim().toLowerCase().startsWith("y");
    } catch (error) {
      // Confirm unavailable → keep the router's verdict (fail closed on a
      // configured topic, never open).
      logError("router_block_confirm_error", error, { shopId });
      confirmed = true;
    }
  }
  const routerBlocks = routed.blocked && bannedConfigured && citedTopic !== null && confirmed === true;
  trace.step(
    "router_block",
    "Router policy block",
    routerBlocks ? "hit" : routed.blocked ? "skip" : "pass",
    {
      routerSaidBlocked: routed.blocked,
      blockedReason: routed.blocked_reason || null,
      merchantConfiguredBannedTopics: bannedConfigured,
      citedConfiguredTopic: citedTopic,
      confirmAnswer,
      note: !routed.blocked
        ? null
        : !bannedConfigured
          ? "ignored — the router may only enforce a policy the merchant configured"
          : !citedTopic
            ? "ignored — the reason names none of the merchant's banned topics"
            : confirmed === false
              ? "ignored — the confirm call says this is not a request for advice about that topic"
              : null,
    },
  );
  if (routerBlocks) {
    yield* await finishBlocked(shopId, convo.id, fallback, "router", meterPromise, track);
    return;
  }
  // Same contract for off_topic: it exists to enforce the merchant's STORE
  // SCOPE. With no scope configured the prompt carries no scope line, yet the
  // router still flagged ordinary product asks ("which bracelet is good for
  // money and wealth") as off-topic and turned real shoppers away with the
  // redirect. A merchant who wants a scope enforced configures one.
  const scopeConfigured = Boolean(config.persona?.scope?.trim());
  trace.step(
    "router_off_topic",
    "Router off-topic redirect",
    routed.off_topic && scopeConfigured ? "hit" : routed.off_topic ? "skip" : "pass",
    {
      routerSaidOffTopic: routed.off_topic,
      merchantConfiguredScope: scopeConfigured,
      reason: routed.off_topic_reason || null,
      note: routed.off_topic && !scopeConfigured
        ? "ignored — the router may only enforce a store scope the merchant configured"
        : null,
    },
  );
  if (routed.off_topic && scopeConfigured) {
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

  // Reply language (spec 08): appended to the persona prompt so EVERY
  // generation lane (chat / buy / question) honours it — first message and
  // mid-chat switches alike. Available on every plan (un-gated 2026-09-03).
  const language = languageInstruction(config.persona);
  trace.step("language", "Reply language policy", "info", {
    autoDetectLanguage: config.persona?.autoDetectLanguage ?? false,
    defaultLanguage: config.persona?.defaultLanguage ?? null,
    instruction: language || "none (no persona row — model default)",
  });
  // Who the agent is talking to (name from the pre-chat form, live cart, the
  // product page they are on). Started with the other fan-out work at the top
  // of the turn, so it costs no wall time here.
  const shopper = await shopperPromise;
  trace.step("shopper_context", "What the agent knows about the shopper", shopper ? "hit" : "skip", {
    facts: shopper || "nothing identified — anonymous visitor with no cart",
    privacy: "name only; email / phone / address are never put in the prompt",
  });
  const personaPrompt = `${
    config.persona ? buildPersonaPrompt(config.persona) : "You are a helpful shop assistant."
  }${language ? `\n${language}` : ""}${shopper ? `\n${shopper}` : ""}`;

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
  const chatActions = availableActions(config.widget);
  const chatStream = splitActionStream(
    getLlmProvider().chatStream(
      [
        {
          role: "system",
          content: `${personaPrompt}\n${CHAT_REPLY}\n${actionInstruction(chatActions)}`,
        },
        ...generationHistory,
        { role: "user", content: message },
      ],
      { shopId, purpose: "reply" },
      // +25 tokens over the old 60: the ACTION line has to fit inside the
      // budget or it eats the sentence the shopper actually reads.
      { temperature: 0.5, maxTokens: 85 },
    ),
    chatActions,
  );
  trace.step("generation", "Reply generation (LLM call 2 of 2)", "info", {
    prompt: "persona + CHAT_REPLY + widget actions",
    grounding: "none — small talk lane retrieves nothing",
    offerable: chatActions.map((a) => a.key),
    temperature: 0.5,
    maxTokens: 85,
  });
  yield* streamAndLog({
    shopId, convoId: convo.id, stream: chatStream.text, sourceLayer: "chat", intent: routed,
    actions: chatStream.actions, meterPromise, track, trace,
  });
}

// Words that carry no topic meaning in a banned-topic phrase or a router reason.
const REASON_STOP_WORDS = new Set([
  "advice", "pricing", "content", "message", "about", "topic", "topics", "related",
  "question", "questions", "request", "information", "discussion", "general",
]);

/**
 * The merchant's banned topic that the router's blocked_reason names, or null.
 * Word-level, prefix-tolerant ("political" ~ "politics", "weapon" ~ "weapons"),
 * ignoring filler like "advice"/"content". Exported for the QA suite.
 */
export function configuredTopicNamedBy(reason: string, topics: string[]): string | null {
  const words = (text: string) =>
    text
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((w) => w.length >= 4 && !REASON_STOP_WORDS.has(w));
  const reasonWords = words(reason);
  if (reasonWords.length === 0) return null;
  const stem = (w: string) => w.slice(0, 5);
  for (const topic of topics) {
    const topicWords = words(topic);
    // A topic made only of filler ("advice") cannot be matched by words; the
    // reason must then equal it verbatim.
    if (topicWords.length === 0) {
      if (reason.trim().toLowerCase() === topic.trim().toLowerCase()) return topic;
      continue;
    }
    if (topicWords.some((tw) => reasonWords.some((rw) => stem(rw) === stem(tw)))) return topic;
  }
  return null;
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
  /** Candidates already retrieved by the caller (question-lane rescue). */
  candidates?: ProductCandidate[];
  /** True when the question lane handed the turn over: a `PICKS: none` then
   *  serves the merchant's fallback message instead of model prose. */
  rescued?: boolean;
  /** The merchant's fallback message (rescued turns). */
  fallback?: string;
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
      args.candidates ??
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
    constrained
      ? "Custom recommendation pool (hand-picked)"
      : args.rescued
        ? "Hybrid product search (handed over from the question lane)"
        : "Hybrid product search",
    !learnProducts ? "skip" : candidates.length > 0 ? "hit" : "miss",
    {
      method: !learnProducts
        ? "skipped: Learn products is off, the catalogue is off-limits"
        : constrained
          ? "merchant custom recommendation pool for a matched search term"
          : "pgvector cosine + field-aware weighted tsvector keyword tier (title/type/tags count in full, description-only words 0.4), fused by reciprocal rank; 3 slots reserved for vector-lane rows",
      routerKeywords: args.keywords,
      priceMax: args.priceMax,
      minMeaningScore,
      excludeOutOfStock,
      candidatesFound: candidates.length,
      ranked: candidates.slice(0, MODEL_CANDIDATES).map((c) => ({
        title: c.title,
        price: c.price,
        vectorScore: c.score,
        fusedRank: c.fused,
        keywordCoverage: c.coverage,
        matchedTerms: c.matchedTerms,
        headTerms: c.headTerms,
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

  // The model reads the whole ranked candidate list (allow-list, ≤ 8 rows,
  // 1-based ids) and DECIDES which ones fit — its reply opens with a PICKS
  // line (picks.server.ts). Cards = those picks; titles/prices still come only
  // from DB rows and an id outside the list is ignored. The mechanical
  // relevance tier (1, 2 or 4 products, never padded) stays as the FALLBACK
  // card set when the model gives no usable picks line, and as the whole set
  // for browse / hand-picked pools, where "does it fit" is not the question.
  // The snippet (type · tags · matching fragment · where each word matched)
  // is what lets the model tell a black bracelet from one that "pairs with
  // black outfits".
  const relevant = selectRelevant(candidates, 4);
  // Price goes to the model PRE-FORMATTED in the shop's currency ("₹1,499",
  // not 1499) — a bare number reads as dollars to the model, and an INR store's
  // reply then quoted "$1499" next to cards the widget correctly rendered in ₹.
  const allowList = candidates.slice(0, MODEL_CANDIDATES).map((c, i) => ({
    id: i + 1,
    title: c.title,
    price: formatMoney(c.price, args.config.currency),
    snippet: candidateSnippet(c),
  }));
  const modelDecidesCards = !browse && !constrained;
  // When some product carries EVERY router keyword in its title/type/tags
  // ("Black Obsidian Bracelet" for "black bracelets"), the shopper asked for a
  // literal attribute and the tier already holds the literal matches; the
  // model may then only narrow or reorder that tier, not widen it back to the
  // products whose prose merely mentions the words — gpt-4o-mini pads towards
  // four picks whenever it is allowed to. Purpose-shaped asks ("for stress",
  // "for money") never satisfy this, so there the model's judgement (synonyms,
  // meaning) decides across the whole allow-list.
  // Normalised exactly as keywordSearch normalises them, or a router keyword of
  // "ruling no 5" would never equal the "ruling number 5" the search recorded
  // in headTerms and both tier guards below would quietly go dead.
  const routerTerms = args.keywords
    .map((k) => normalizeNumberIds(k).trim().toLowerCase())
    .filter((k) => k.length > 0);
  const lexicalComplete =
    routerTerms.length > 0 && routerTerms.every((t) => candidates[0].headTerms.includes(t));
  const tierIds = new Set(relevant.map((c) => c.id));
  // Second belt, for asks whose deciding word legitimately lives in the prose
  // ("bracelet for february born" — the birthstone month is description data):
  // when the top candidate satisfies EVERY router word and nothing outside its
  // tier does, products satisfying fewer words are padding, so picks are
  // constrained to the tier. When other products also satisfy every word (the
  // calming bracelets for "stress and anxiety"), the model chooses among them.
  const fullMatch = (c: ProductCandidate) =>
    routerTerms.length > 0 && routerTerms.every((t) => c.matchedTerms.includes(t));
  const onlyTierSatisfiesAll =
    fullMatch(candidates[0]) && !candidates.some((c) => !tierIds.has(c.id) && fullMatch(c));
  const constrainToTier = lexicalComplete || onlyTierSatisfiesAll;
  // Conversely, a `PICKS: none` only stands when NO candidate carries a router
  // keyword in its title/type/tags. The model declared "nothing fits" for "a
  // bottle that keeps drinks hot" with an Insulated Water Bottle on the list;
  // a literal name match is evidence the model may refine but not contradict,
  // so the mechanical tier is shown instead.
  const lexicalAnchor = routerTerms.some((t) => candidates.some((c) => c.headTerms.includes(t)));

  args.trace.step("relevance_cut", "Fallback tier (used when the model gives no picks)", "info", {
    rule:
      candidates[0].coverage > 0
        ? `keyword tier: every candidate within ${TIER_MARGIN} of the top coverage ${candidates[0].coverage}`
        : candidates[0].score !== null
          ? "vector only: rows within 0.04 cosine of the best score"
          : "unscored pool (browse / hand-picked): kept as-is",
    candidatesIn: candidates.length,
    kept: relevant.length,
    titles: relevant.map((c) => c.title),
  });
  args.trace.step("allow_list", "Exact product payload handed to the model", "info", {
    contract:
      "the model may only speak about these rows and may only pick their ids; titles and prices are rendered from the DB, never from the model",
    modelDecidesCards,
    products: allowList,
  });

  const picksStream = splitPicksStream(
    getLlmProvider().chatStream(
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
      // 110 = the 90-token reply budget plus the PICKS line.
      { temperature: 0.3, maxTokens: 110 },
    ),
  );

  args.trace.step("generation", "Reply generation (LLM call 2 of 2)", "info", {
    prompt: "persona + PRODUCT_RECOMMEND",
    grounding: `${allowList.length} candidate products (allow-list above); first line = PICKS`,
    historyTurns: args.generationHistory.length,
    temperature: 0.3,
    maxTokens: 110,
  });

  // Runs after the stream has been consumed: turn the picks line into cards.
  const resolveCards = async (): Promise<ProductCard[]> => {
    const { picks, line } = picksStream.result();
    let chosen: ProductCandidate[];
    let source: string;
    if (!modelDecidesCards) {
      chosen = relevant;
      source = browse ? "browse pool (cheapest in budget)" : "merchant hand-picked pool";
    } else if (picks?.kind === "ids") {
      const seen = new Set<string>();
      chosen = [];
      let widened = 0;
      for (const id of picks.ids) {
        const candidate = id >= 1 && id <= allowList.length ? candidates[id - 1] : undefined;
        if (!candidate || seen.has(candidate.id)) continue;
        if (constrainToTier && !tierIds.has(candidate.id)) {
          widened++;
          continue;
        }
        seen.add(candidate.id);
        chosen.push(candidate);
        if (chosen.length >= 4) break;
      }
      source =
        chosen.length > 0
          ? constrainToTier
            ? `model picks (${lexicalComplete ? "literal match" : "only the top tier satisfies every word"} — ${widened} pick(s) outside the tier dropped)`
            : "model picks"
          : "fallback tier (picks out of range)";
      if (chosen.length === 0) chosen = relevant;
    } else if (picks?.kind === "none" && lexicalAnchor) {
      chosen = relevant;
      source = "fallback tier (model said none, but a candidate carries a router keyword in its title/type/tags)";
    } else if (picks?.kind === "none") {
      chosen = [];
      source = "model: nothing fits";
    } else {
      chosen = relevant;
      source = "fallback tier (no picks line)";
    }
    let cards = chosen.map(toCard);
    const before = cards.length;
    // Cross-sell (spec 08): append companions of any anchored card (cap 6 total).
    cards = await appendCrossSell(args.shopId, cards, excludeOutOfStock);
    args.trace.step("model_picks", "Cards decided", chosen.length > 0 ? "hit" : "miss", {
      picksLine: line,
      parsed: picks,
      lexicalComplete,
      onlyTierSatisfiesAll,
      lexicalAnchor,
      source,
      cards: chosen.map((c) => c.title),
      crossSellAdded: cards.length - before,
    });
    await args.track("recommendation_shown", {
      count: cards.length,
      browse,
      keywords: args.keywords,
      picks: source,
      rescued: args.rescued ?? false,
    });
    return cards;
  };

  let text: AsyncIterable<string> = picksStream.text;
  if (args.rescued) {
    // Force the picks decision (the first line) before any prose streams: a
    // rescued question the catalogue does not answer after all must serve the
    // merchant's configured fallback message and feed the unresolved queue,
    // exactly as the RAG miss would have — never model prose past the
    // knowledge the merchant allowed.
    const iterator = picksStream.text[Symbol.asyncIterator]();
    const first = await iterator.next();
    const { picks, line } = picksStream.result();
    if (picks?.kind === "none" && !lexicalAnchor) {
      await iterator.return?.();
      args.trace.step("model_picks", "Cards decided", "miss", {
        picksLine: line,
        parsed: picks,
        source: "rescued question: the model finds nothing that answers it — serving the fallback message",
      });
      yield* serveRagFallback({ ...args, fallback: args.fallback ?? DEFAULT_FALLBACK, reason: "rescue_no_fit" });
      return;
    }
    text = resumeStream(first, iterator);
  }

  yield* streamAndLog({
    shopId: args.shopId,
    convoId: args.convoId,
    stream: text,
    sourceLayer: browse ? "buy_browse" : "buy",
    intent: args.routed,
    cards: resolveCards,
    emptyReplyText: PICKS_ONLY_REPLY,
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
  const [hits, discountContext, collectionContext] = await Promise.all([
    knowledgeSearch(args.shopId, args.queryEmbedding, 3),
    // Master "Learn discounts" permission (spec 07): OFF ⇒ no discount facts,
    // regardless of per-row learnEnabled.
    args.config.settings.learn.discounts
      ? activeDiscountContext(args.shopId, args.message)
      : Promise.resolve(""),
    // Same contract for collections, gated by "Learn collections".
    args.config.settings.learn.collections
      ? shopCollectionContext(args.shopId, args.message)
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
  args.trace.step(
    "collection_context",
    "Synced collection names",
    !args.config.settings.learn.collections ? "skip" : collectionContext ? "hit" : "pass",
    {
      reason: args.config.settings.learn.collections ? null : "Learn collections is off",
      injected: Boolean(collectionContext),
    },
  );

  // No grounded facts for a question-shaped message: before giving up, ask
  // the CATALOGUE. "which bracelet is good for money?", "is amethyst good for
  // anxiety?" are questions to the router but product asks to the shopper, and
  // the fallback ("I'm not sure — leave your email") loses the sale. The rescue
  // fires only when both lanes agree on the same product — a shopper word in
  // its title/type/tags AND a vector match above the meaning gate — so a
  // policy question that merely shares a word with a tag ("ship" / "free
  // shipping") has no vector agreement and still falls back.
  if (!strongEnough && !discountContext && !collectionContext && args.config.settings.learn.products) {
    const rescue = await hybridProductSearch({
      shopId: args.shopId,
      queryEmbedding: args.queryEmbedding,
      keywords: [],
      message: args.message,
      priceMax: null,
      minMeaningScore,
      excludeOutOfStock: args.config.settings.recommendationRules.excludeOutOfStock,
    }).catch((error) => {
      logError("question_rescue_error", error, { shopId: args.shopId });
      return [] as ProductCandidate[];
    });
    const top = rescue[0];
    const fires = Boolean(top && top.matchedTerms.length > 0 && top.score !== null);
    args.trace.step(
      "question_rescue",
      "No knowledge matched — does the catalogue answer it?",
      fires ? "hit" : "miss",
      {
        rule: "fires when the best product contains a shopper word AND the vector lane agrees (score above minMeaningScore); the model then decides whether anything fits, and a 'none' serves the fallback message",
        topCandidate: top
          ? {
              title: top.title,
              matchedTerms: top.matchedTerms,
              headTerms: top.headTerms,
              vectorScore: top.score,
              coverage: top.coverage,
            }
          : null,
        effect: fires ? "handing the turn to the buy lane with these candidates" : "continue to the fallback",
      },
    );
    if (fires) {
      yield* buyLane({
        shopId: args.shopId,
        convoId: args.convoId,
        config: args.config,
        message: args.message,
        queryEmbedding: args.queryEmbedding,
        keywords: [],
        priceMax: null,
        personaPrompt: args.personaPrompt,
        generationHistory: args.generationHistory,
        meterPromise: args.meterPromise,
        routed: args.routed,
        isTest: args.isTest,
        track: args.track,
        trace: args.trace,
        candidates: rescue,
        rescued: true,
        fallback: args.fallback,
      });
      return;
    }
  }

  // Discount questions are grounded mechanically from the synced Discount
  // mirror (spec 02 backlog: "synced discounts become RAG-available later").
  // When we hold real discount facts, the no-knowledge fallback is skipped —
  // the context IS the store info for this turn.
  if (
    (guardrails?.answerOnlyFromKnowledge ?? true) &&
    !strongEnough &&
    !discountContext &&
    !collectionContext
  ) {
    args.trace.step("rag_fallback", "No grounded facts, serving the fallback message", "miss", {
      rule: "Answer only from knowledge is ON, so the model is not allowed to improvise",
      effect: "fallback reply; the question is logged to the unresolved queue",
    });
    yield* serveRagFallback({ ...args, reason: "no_knowledge" });
    return;
  }

  const context =
    hits.map((h) => `[${h.topic}] ${h.body}`).join("\n\n") + discountContext + collectionContext;
  // Support questions are exactly where the agent used to send shoppers to
  // storefront navigation it had imagined ("click the Track navigation"), so
  // this is the lane the action buttons matter most in.
  const actions = availableActions(args.config.widget);
  const stream = splitActionStream(
    getLlmProvider().chatStream(
      [
        {
          role: "system",
          content: `${args.personaPrompt}\n${QUESTION_ANSWER}\n${actionInstruction(actions)}`,
        },
        ...args.generationHistory,
        { role: "user", content: `Store info:\n${context}\n\nShopper question: ${args.message}` },
      ],
      { shopId: args.shopId, purpose: "reply" },
      { temperature: 0.3, maxTokens: 240 },
    ),
    actions,
  );
  args.trace.step("generation", "Reply generation (LLM call 2 of 2)", "info", {
    prompt: "persona + QUESTION_ANSWER + widget actions",
    grounding: "the store-info block below, the model may not answer past it",
    storeInfo: context,
    offerable: actions.map((a) => a.key),
    historyTurns: args.generationHistory.length,
    temperature: 0.3,
    maxTokens: 240,
  });
  yield* streamAndLog({
    shopId: args.shopId,
    convoId: args.convoId,
    stream: stream.text,
    sourceLayer: "question",
    intent: args.routed,
    actions: stream.actions,
    meterPromise: args.meterPromise,
    track: args.track,
    trace: args.trace,
  });
}

/** The merchant's configured fallback for an unanswerable question: saved as
 *  `rag_fallback`, logged to the unresolved queue, then the cannot-answer
 *  handover escalation. Shared by the RAG miss and by a rescued question the
 *  catalogue turned out not to answer either. */
async function* serveRagFallback(args: {
  shopId: string;
  convoId: string;
  config: ShopConfig;
  message: string;
  fallback: string;
  routed: unknown;
  isTest: boolean;
  meterPromise: Promise<unknown>;
  track: TrackFn;
  reason: string;
}): AsyncIterable<PipelineFrame> {
  await saveMessage(args.shopId, args.convoId, {
    role: "out", author: "ai", content: args.fallback, sourceLayer: "rag_fallback", intent: args.routed,
  });
  await args.track("turn_fell_back", { reason: args.reason });
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
}

/** Re-attach an already-pulled first result to the rest of its iterator. */
async function* resumeStream<T>(first: IteratorResult<T>, iterator: AsyncIterator<T>): AsyncIterable<T> {
  if (!first.done) yield first.value;
  for (;;) {
    const next = await iterator.next();
    if (next.done) return;
    yield next.value;
  }
}

// ── Discount grounding (spec 02 delta closed 2026-08-10) ────────────────────
// Mechanical context injection: when the shopper's message reads like a
// discount question, the currently-active synced discounts (title + Shopify's
// human-readable summary) are appended to the question-lane store info. The
// model still can't invent discounts (prompt rule) — it can only voice these
// rows. Zero extra LLM calls; one indexed query, only on matching messages.

// The trailing `s?` matters: "any discounts today?", "do you have coupons",
// "any offers" are the most natural shopper phrasings, and without it none of
// them matched, so the synced discount rows were never injected. The multi-word
// alternatives that used to be listed here ("discount code", "promo code") are
// already covered by their single words and could never match first anyway.
// Exported so the QA suite can assert against the REAL pattern. It previously
// kept its own copy, which meant the test could not tell a fixed regex from a
// broken one.
export const DISCOUNT_INTENT_RE =
  /\b(discount|coupon|promo|promotion|voucher|sale|offer|deal)s?\b/i;

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

// "what do you sell?", "what categories are there?", "do you have a winter
// range?" — questions about the SHAPE of the catalogue, which product search
// cannot answer: it returns individual products, never the sections they sit
// in. Mirrors DISCOUNT_INTENT_RE; exported so the QA suite tests the real one.
export const COLLECTION_INTENT_RE =
  /\b(collections?|categor(?:y|ies)|ranges?|lines?|departments?|sections?|what (?:do|kind of|type of|products?) (?:you|do you) (?:sell|have|offer|carry)|browse|shop by)\b/i;

/** How many collection names may enter the prompt. Enough to describe a store,
 *  short enough not to crowd out the RAG chunks that answer the actual
 *  question. */
const MAX_COLLECTION_FACTS = 25;

async function shopCollectionContext(shopId: string, message: string): Promise<string> {
  if (!COLLECTION_INTENT_RE.test(message)) return "";
  const collections = await db.collection.findMany({
    // Per-row learnEnabled on top of the master switch the caller checked —
    // same two-level contract as products and discounts (spec 07).
    where: { shopId, learnEnabled: true },
    orderBy: { productCount: "desc" },
    take: MAX_COLLECTION_FACTS,
    select: { title: true, description: true, productCount: true },
  });
  if (collections.length === 0) return "";
  const lines = collections.map((c) => {
    // One clause of description at most: enough to disambiguate two similarly
    // named collections, not enough to become the answer.
    const blurb = c.description.replace(/\s+/g, " ").trim().slice(0, 100);
    return `- ${c.title} (${c.productCount} product${c.productCount === 1 ? "" : "s"})${blurb ? `: ${blurb}` : ""}`;
  });
  return `\n\n[Store collections — the only categories that exist]\n${lines.join("\n")}`;
}

// ── Shared helpers ──────────────────────────────────────────────────────────

async function* streamAndLog(args: {
  shopId: string;
  convoId: string;
  stream: AsyncIterable<string>;
  sourceLayer: string;
  intent: unknown;
  /** Cards to show, or a resolver run AFTER the stream (the buy lane reads the
   *  model's PICKS line, which is only complete once the stream has ended). */
  cards?: ProductCard[] | (() => Promise<ProductCard[]>);
  /** Shown when the model produced no visible text (e.g. only a PICKS line). */
  emptyReplyText?: string;
  /** In-widget buttons the reply asked for, resolved AFTER the stream (the
   *  ACTION line is only complete once the stream has ended). */
  actions?: () => ChatAction[];
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
  if (!full.trim() && args.emptyReplyText) {
    full = args.emptyReplyText;
    yield { type: "message", text: full };
  }

  const cards =
    typeof args.cards === "function"
      ? await args.cards().catch((error) => {
          logError("cards_resolve_error", error, { shopId: args.shopId });
          return [] as ProductCard[];
        })
      : args.cards;
  if (cards && cards.length > 0) {
    yield { type: "cards", cards };
  }
  const actions = args.actions?.() ?? [];
  if (args.actions) {
    args.trace?.step("actions", "In-widget buttons offered", actions.length > 0 ? "hit" : "miss", {
      offered: actions.map((a) => a.key),
      note:
        actions.length > 0
          ? "the model chose from the shop's enabled screens; code owns the label and the destination"
          : "the model's ACTION line named nothing (or it wrote no line) — reply stands on its own",
    });
  }
  if (actions.length > 0) {
    yield { type: "actions", actions };
  }
  await saveMessage(args.shopId, args.convoId, {
    role: "out",
    author: "ai",
    content: full,
    sourceLayer: args.sourceLayer,
    intent: args.intent,
    productCards: cards,
  });
  args.trace?.countLlm("reply");
  args.trace?.step("reply", "Reply streamed and saved", "info", {
    sourceLayer: args.sourceLayer,
    characters: full.length,
    cards: cards?.length ?? 0,
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
  const contactId = input.isTest
    ? null
    : await ensureSessionContact(shopId, input.sessionId, input.visitorId);
  const created = await db.conversation.create({
    data: {
      shopId,
      sessionId: input.sessionId,
      isTest: input.isTest ?? false,
      contactId,
      pageContext: mergePageContext(undefined, input.pageContext, input.userAgent),
      // Carry forward what the agent already learned about this person. The
      // 30-minute session rule (spec 15) is a BILLING boundary, but it was
      // acting as a memory boundary too: the shopper came back, said "the one
      // we discussed", and the agent had nothing. The summary is the compact
      // thing worth carrying — the previous transcript is not replayed.
      summary: contactId ? await previousSummary(shopId, contactId) : null,
    },
  });
  // Opt-in "new conversation" notification for team members (spec 18).
  if (!input.isTest) await notifyNewConversation(shopId, created.id);
  return { conversation: created, previousLastMessageAt: null };
}

/** How far back a returning shopper is still "the same conversation" for the
 *  agent's purposes. Long enough to cover a lunch break or an evening, short
 *  enough that a month-old need is not read back as current. */
const MEMORY_CARRY_DAYS = 14;

/**
 * The summary of this contact's most recent earlier conversation, or null.
 *
 * Only a summary crosses the boundary, never the raw transcript: it is bounded
 * (2-3 sentences), it is what the model already reads as context anyway, and a
 * merchant deleting a contact (spec 17 erasure) takes the conversations — and
 * therefore this — with it.
 */
async function previousSummary(shopId: string, contactId: string): Promise<string | null> {
  const since = new Date(Date.now() - MEMORY_CARRY_DAYS * 24 * 60 * 60 * 1000);
  const previous = await db.conversation.findFirst({
    where: {
      shopId,
      contactId,
      isTest: false,
      summary: { not: null },
      lastMessageAt: { gte: since },
    },
    orderBy: { lastMessageAt: "desc" },
    select: { summary: true },
  });
  return previous?.summary?.trim() || null;
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
/** How many collection members one custom rule may pull in. Deliberately far
 *  above the 8 that survive ranking: the price/stock filters below can discard
 *  most of them, and a rule that returns nothing is worse than one that reads
 *  a few more rows. */
const COLLECTION_POOL_LIMIT = 100;

async function customRecommendationPool(
  shopId: string,
  message: string,
  priceMax: number | null,
  excludeOutOfStock: boolean,
): Promise<ProductCandidate[] | null> {
  try {
    const rows = await db.customRecommendation.findMany({
      where: { shopId, status: "active" },
      select: { id: true, searchTerms: true, productIds: true, collectionIds: true },
    });
    const lower = message.toLowerCase();
    // A rule targeting COLLECTIONS is just as valid as one targeting products.
    // Requiring productIds here is what made every collection-only rule a
    // silent no-op: it saved, it looked active, and it could never match.
    const matched = rows.find(
      (r) =>
        (r.productIds.length > 0 || r.collectionIds.length > 0) &&
        r.searchTerms.some((t) => t.trim().length > 2 && lower.includes(t.trim().toLowerCase())),
    );
    if (!matched) return null;

    // Explicit products first, then everything in the named collections. The
    // merchant's own picks outrank a whole-collection sweep.
    const targetIds = [...matched.productIds];
    if (matched.collectionIds.length > 0) {
      const members = await db.collectionProduct.findMany({
        where: { shopId, collectionId: { in: matched.collectionIds } },
        select: { shopifyProductId: true },
        take: COLLECTION_POOL_LIMIT,
      });
      for (const m of members) {
        if (!targetIds.includes(m.shopifyProductId)) targetIds.push(m.shopifyProductId);
      }
    }
    if (targetIds.length === 0) return null;

    const products = await db.product.findMany({
      where: {
        shopId,
        shopifyProductId: { in: targetIds },
        ...purchasableWhere(excludeOutOfStock),
        ...(priceMax !== null ? { price: { lte: priceMax } } : {}),
      },
      select: {
        id: true, shopifyProductId: true, title: true, price: true, stock: true,
        imageUrl: true, handle: true, variants: true,
        productType: true, tags: true, description: true, metafieldText: true,
      },
    });
    if (products.length === 0) return null;
    // Rank by the merchant's own order — explicit picks, then collection
    // members — and only THEN take the top 8. Letting the database's arbitrary
    // row order decide would let a 100-product collection sweep bury the
    // handful of products the merchant actually chose.
    const rank = new Map(targetIds.map((gid, i) => [gid, i]));
    const ordered = products
      .slice()
      .sort(
        (a, b) =>
          (rank.get(a.shopifyProductId) ?? Number.MAX_SAFE_INTEGER) -
          (rank.get(b.shopifyProductId) ?? Number.MAX_SAFE_INTEGER),
      )
      .slice(0, 8);
    return ordered.map((p, i) => ({
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
      headTerms: [],
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
    ...variantIds(r.variants as { id: string; available: boolean }[] | null),
  }));
}

function toCard(candidate: ProductCandidate): ProductCard {
  return {
    shopifyProductId: candidate.shopifyProductId,
    title: candidate.title,
    price: candidate.price,
    imageUrl: candidate.imageUrl,
    handle: candidate.handle,
    ...variantIds(candidate.variants),
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
