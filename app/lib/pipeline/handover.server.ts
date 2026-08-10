import db from "../../db.server";
import { recordEvent } from "../analytics/events.server";
import { embedTexts } from "../embeddings/embedding.server";
import { resolveAvailability } from "../settings/availability.server";
import { requireShopId } from "../tenancy.server";
import type { HandoverConfigData } from "../settings/schemas";
import type { ShopConfig } from "../config/shop-config.server";

// Human-handover runtime (spec 10; config authored in 08). Detection +
// state transition + the frames the widget renders. The inbox UI consumes the
// flagged conversations; merchant email notify lands with feature 10's UI.

export type HandoverTrigger =
  | "explicit_ask"
  | "cannot_answer"
  | "repeated_question"
  | "negative_sentiment"
  | "intent_rule";

const EXPLICIT_PATTERNS = [
  /talk\s+to\s+(a\s+)?(human|person|agent|someone|rep)/i,
  /speak\s+(to|with)\s+(a\s+)?(human|person|agent|someone|rep)/i,
  /real\s+(person|human|agent)/i,
  /human\s+(agent|support|help)/i,
  /connect\s+me\s+(to|with)/i,
  /customer\s+service/i,
];

const NEGATIVE_EMOJI = /[👎😠😡💩🤬]/u;
const INTENT_RULE_THRESHOLD = 0.5;

/** Cheap pre-router detection: explicit ask, sentiment, repeated question, intent rules. */
export async function detectHandover(args: {
  shopId: string;
  conversationId: string;
  message: string;
  queryEmbedding: number[] | null; // null when called before embedding exists
  handover: HandoverConfigData;
}): Promise<HandoverTrigger | null> {
  const { handover, message } = args;
  requireShopId(args.shopId);

  // Explicit ask — always on.
  if (EXPLICIT_PATTERNS.some((p) => p.test(message))) return "explicit_ask";

  // Negative sentiment (opt-in): ALL-CAPS ratio, repeated punctuation, emojis.
  if (handover.triggers.negativeSentiment.enabled) {
    const letters = message.replace(/[^a-zA-Z]/g, "");
    const capsRatio = letters.length >= 8 ? letters.replace(/[^A-Z]/g, "").length / letters.length : 0;
    if (capsRatio > 0.8 || /[!?]{3,}/.test(message) || NEGATIVE_EMOJI.test(message)) {
      return "negative_sentiment";
    }
  }

  // Repeated question: same normalized text among recent shopper messages.
  if (handover.triggers.repeatedQuestion.enabled) {
    const recent = await db.message.findMany({
      where: { shopId: args.shopId, conversationId: args.conversationId, role: "in" },
      orderBy: { createdAt: "desc" },
      take: 8,
      select: { content: true },
    });
    const normalized = normalize(message);
    // recent includes the just-saved current message — count all occurrences.
    const repeats = recent.filter((m) => normalize(m.content) === normalized).length;
    if (normalized.length > 4 && repeats >= handover.triggers.repeatedQuestion.threshold) {
      return "repeated_question";
    }
  }

  // Intent rules: semantic topic match (lazy-cached embeddings, banned-topic pattern).
  if (args.queryEmbedding && handover.intentRules.length > 0) {
    const topics = handover.intentRules.map((r) => r.topic).filter((t) => t.trim().length > 0);
    if (topics.length > 0) {
      const vectors = await intentRuleVectors(args.shopId, topics);
      for (let i = 0; i < topics.length; i++) {
        if (dot(args.queryEmbedding, vectors[i]) >= INTENT_RULE_THRESHOLD) return "intent_rule";
      }
    }
  }

  return null;
}

/** Post-fallback detection: N consecutive AI fallback turns. */
export async function detectCannotAnswer(
  shopId: string,
  conversationId: string,
  handover: HandoverConfigData,
): Promise<boolean> {
  if (!handover.triggers.cannotAnswer.enabled) return false;
  const recentOut = await db.message.findMany({
    where: { shopId: requireShopId(shopId), conversationId, role: "out" },
    orderBy: { createdAt: "desc" },
    take: handover.triggers.cannotAnswer.threshold,
    select: { sourceLayer: true },
  });
  const fallbackLayers = new Set(["clarify", "rag_fallback", "banned_router"]);
  return (
    recentOut.length >= handover.triggers.cannotAnswer.threshold &&
    recentOut.every((m) => fallbackLayers.has(m.sourceLayer ?? ""))
  );
}

export interface HandoverFrameData {
  destination: HandoverConfigData["destination"];
  messages: string[];
  form: null | {
    replyTime: string;
    fields: { key: string; required: boolean }[];
    formMessage: string;
    postSubmitMessage: string;
  };
  aiDormant: boolean;
}

/**
 * Execute the handover: sys message, conversation flags, AI dormancy per
 * aiWhileWaiting + availability, and the payload the widget renders.
 */
export async function executeHandover(args: {
  shopId: string;
  conversationId: string;
  trigger: HandoverTrigger;
  config: ShopConfig;
}): Promise<HandoverFrameData> {
  const shopId = requireShopId(args.shopId);
  const handover = args.config.handover;

  const availability = resolveAvailability(args.config.settings.availability, args.config.timezone);
  const online = availability.status === "online";

  let aiDormant = false;
  const messages: string[] = [];
  let form: HandoverFrameData["form"] = null;

  switch (handover.destination) {
    case "inbox": {
      if (online) {
        messages.push(handover.inbox.afterHandoverMessage);
      } else if (handover.inbox.offlineMode === "leave_message") {
        messages.push(handover.inbox.leaveMessage.formMessage);
        form = {
          replyTime: handover.inbox.leaveMessage.replyTime,
          fields: collectToFields(handover.inbox.leaveMessage.collect),
          formMessage: handover.inbox.leaveMessage.formMessage,
          postSubmitMessage: handover.inbox.leaveMessage.postSubmitMessage,
        };
      } else {
        messages.push(handover.contactMethods.message);
      }
      switch (handover.inbox.aiWhileWaiting) {
        case "never":
          aiDormant = true;
          break;
        case "outside_hours":
          aiDormant = online; // humans available now → AI stays quiet
          break;
        case "always":
          aiDormant = false;
          break;
      }
      break;
    }
    case "collect_email": {
      messages.push(handover.collectEmail.formMessage);
      form = {
        replyTime: handover.collectEmail.replyTime,
        fields: collectToFields(handover.collectEmail.collect),
        formMessage: handover.collectEmail.formMessage,
        postSubmitMessage: handover.collectEmail.postSubmitMessage,
      };
      aiDormant = false;
      break;
    }
    case "contact_methods": {
      messages.push(handover.contactMethods.message);
      aiDormant = false;
      break;
    }
  }

  await db.conversation.updateMany({
    where: { id: args.conversationId, shopId },
    data: {
      handover: true,
      unread: true,
      ...(aiDormant ? { mode: "human" } : {}),
      lastMessageAt: new Date(),
    },
  });
  await db.message.create({
    data: {
      shopId,
      conversationId: args.conversationId,
      role: "sys",
      author: "system",
      content: "Handed over to a human agent.",
      sourceLayer: "handover",
    },
  });
  for (const text of messages) {
    await db.message.create({
      data: {
        shopId,
        conversationId: args.conversationId,
        role: "out",
        author: "system",
        content: text,
        sourceLayer: "handover",
      },
    });
  }
  await recordEvent(shopId, "handover_triggered", {
    trigger: args.trigger,
    destination: handover.destination,
    aiDormant,
  });

  return { destination: handover.destination, messages, form, aiDormant };
}

function collectToFields(collect: {
  email: true;
  issue: true;
  orderNumber: boolean;
  phone: boolean;
  photoUpload: boolean;
}): { key: string; required: boolean }[] {
  const fields = [
    { key: "email", required: true },
    { key: "issue", required: true },
  ];
  if (collect.orderNumber) fields.push({ key: "orderNumber", required: false });
  if (collect.phone) fields.push({ key: "phone", required: false });
  // photoUpload deferred to feature 10's widget form work.
  return fields;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

declare global {
  // eslint-disable-next-line no-var
  var intentRuleVectorCache: Map<string, number[][]> | undefined;
}

async function intentRuleVectors(shopId: string, topics: string[]): Promise<number[][]> {
  if (!global.intentRuleVectorCache) global.intentRuleVectorCache = new Map();
  const key = `${shopId}:${topics.join("|")}`;
  let vectors = global.intentRuleVectorCache.get(key);
  if (!vectors) {
    vectors = await embedTexts(topics.map((t) => `a message about ${t}`));
    global.intentRuleVectorCache.set(key, vectors);
    if (global.intentRuleVectorCache.size > 500) global.intentRuleVectorCache.clear();
  }
  return vectors;
}

function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}
