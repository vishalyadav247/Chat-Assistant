import db from "../../db.server";
import { getLlmProvider, type ChatMessage } from "../llm/index.server";
import { requireShopId } from "../tenancy.server";
import { SUMMARY_SYSTEM, summaryUser } from "./prompts";
import { logError } from "../log.server";

// Conversation history (spec 03): rolling summary + recent-verbatim window —
// the last 10 messages for BOTH the router and generation (the validated demo
// sends the same window to every call). Summary refreshed when the
// older-than-window count has grown by ~4 since the last refresh; cached on
// the conversation row. Retrieval never uses history (current message only).
//
// The current shopper message is persisted BEFORE history is loaded (handover's
// repeat detector needs it in the DB), so callers pass its id to keep it out of
// the window — otherwise every LLM call would see the message twice.

export const ROUTER_WINDOW = 10;
export const GENERATION_WINDOW = 10;
const SUMMARY_REFRESH_EVERY = 4;

export interface HistoryBundle {
  routerHistory: ChatMessage[];
  generationHistory: ChatMessage[];
}

export async function loadHistory(
  shopId: string,
  conversationId: string,
  opts: {
    excludeMessageId?: string;
    /** Agent mode (spec 24): append the products each assistant reply showed,
     *  with their ids, so "this" / "the blue one" resolve to a real product. */
    annotateCards?: boolean;
  } = {},
): Promise<HistoryBundle> {
  requireShopId(shopId);
  const convo = await db.conversation.findFirst({
    where: { id: conversationId, shopId },
    select: { id: true, summary: true, summaryMessageCount: true },
  });
  if (!convo) return { routerHistory: [], generationHistory: [] };

  const historyWhere = {
    conversationId,
    shopId,
    role: { in: ["in", "out"] },
    ...(opts.excludeMessageId ? { id: { not: opts.excludeMessageId } } : {}),
  };
  const fetched = await db.message.findMany({
    where: historyWhere,
    orderBy: { createdAt: "desc" },
    take: ROUTER_WINDOW + 40, // window + summarization lookback
    select: { role: true, content: true, productCards: true, intent: true, sourceLayer: true },
  });
  // The leave-message form's submission is stored as a shopper message holding
  // the email, phone and order number for the team. It must never reach the
  // model — not as history and not through the summary (which is also carried
  // into the contact's later conversations).
  const rows = fetched.reverse().map((r) =>
    r.role === "in" && r.sourceLayer === "handover"
      ? { ...r, content: "[The shopper left their contact details for the store team.]" }
      : r,
  );

  const recent = rows.slice(-ROUTER_WINDOW);
  // olderCount must be the TRUE count of messages older than the window, not
  // the capped fetch length: a thread past ~50 messages saturates the fetch,
  // olderCount would freeze at 40, and the refresh condition below would never
  // fire again — silently losing everything that ages out of the window. Only
  // pay the count query once the fetch is actually saturated.
  const totalCount =
    fetched.length < ROUTER_WINDOW + 40 ? rows.length : await db.message.count({ where: historyWhere });
  const olderCount = Math.max(0, totalCount - ROUTER_WINDOW);

  let summary = convo.summary;
  if (
    olderCount > 0 &&
    (!summary || olderCount - convo.summaryMessageCount >= SUMMARY_REFRESH_EVERY)
  ) {
    // The previous summary goes back in: the lookback below is only 50 rows,
    // so on a long thread the opening messages are already gone and a
    // from-scratch refresh would drop what they said with them.
    const refreshed = await summarize(rows.slice(0, rows.length - ROUTER_WINDOW), shopId, convo.summary ?? "");
    if (refreshed) {
      // Only persist a real summary — the fold returns "" on LLM failure, and
      // storing that would wipe the prior summary AND mark these messages as
      // summarized, losing them for good.
      summary = refreshed;
      await db.conversation.updateMany({
        where: { id: convo.id, shopId },
        data: { summary, summaryMessageCount: olderCount },
      });
    } else if (convo.summary) {
      summary = convo.summary;
    }
  }

  const summaryMsg: ChatMessage[] = summary
    ? [{ role: "system", content: `Earlier conversation summary: ${summary}` }]
    : [];
  // Agent mode: what a reply showed and looked up rides as a separate system
  // note after it, not inside the assistant text — a model imitates its own
  // earlier replies, and bracketed ids in them would surface in new replies.
  const toChat = (r: { role: string; content: string; productCards?: unknown; intent?: unknown }): ChatMessage[] => {
    const message: ChatMessage = { role: r.role === "in" ? "user" : "assistant", content: r.content };
    if (!opts.annotateCards || r.role === "in") return [message];
    const note = `${cardsNote(r.productCards)}${factsNote(r.intent)}`.trim();
    return note ? [message, { role: "system", content: note }] : [message];
  };

  return {
    routerHistory: [...summaryMsg, ...recent.flatMap(toChat)],
    generationHistory: [...summaryMsg, ...recent.slice(-GENERATION_WINDOW).flatMap(toChat)],
  };
}

/** "[Products shown with this reply: Title (id 123), …]" — or "" when the reply had none. */
function cardsNote(productCards: unknown): string {
  if (!Array.isArray(productCards) || productCards.length === 0) return "";
  const items = productCards
    .map((c) => {
      const card = c as { shopifyProductId?: unknown; title?: unknown };
      if (typeof card?.title !== "string" || typeof card?.shopifyProductId !== "string") return null;
      return `${card.title} (id ${card.shopifyProductId.split("/").pop()})`;
    })
    .filter(Boolean);
  return items.length > 0 ? `Products shown with the previous reply: ${items.join("; ")}.` : "";
}

/** "[Looked up for this reply: …]" — the compact tool facts an agent reply was
 *  based on (spec 24), so a later "price of this" is answered from the lookup,
 *  not from the model's memory. */
function factsNote(intent: unknown): string {
  const facts = (intent as { facts?: unknown } | null)?.facts;
  if (!Array.isArray(facts)) return "";
  const lines = facts.filter((f): f is string => typeof f === "string" && f.length > 0);
  return lines.length > 0 ? ` Facts looked up for the previous reply: ${lines.join(" | ")}.` : "";
}

async function summarize(
  rows: { role: string; content: string }[],
  shopId: string,
  prior: string,
): Promise<string> {
  try {
    const text = rows
      .map((r) => `${r.role === "in" ? "Shopper" : "Assistant"}: ${r.content}`)
      .join("\n")
      .slice(-6000);
    return await getLlmProvider().chat(
      [
        { role: "system", content: SUMMARY_SYSTEM },
        { role: "user", content: summaryUser(prior, text) },
      ],
      { shopId, purpose: "summary" },
      { temperature: 0.2, maxTokens: 130 },
    );
  } catch (error) {
    logError("summary_error", error, { shopId });
    return "";
  }
}
