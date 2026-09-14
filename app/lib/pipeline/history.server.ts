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
  opts: { excludeMessageId?: string } = {},
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
    select: { role: true, content: true },
  });
  const rows = fetched.reverse();

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
  const toChat = (r: { role: string; content: string }): ChatMessage => ({
    role: r.role === "in" ? "user" : "assistant",
    content: r.content,
  });

  return {
    routerHistory: [...summaryMsg, ...recent.map(toChat)],
    generationHistory: [...summaryMsg, ...recent.slice(-GENERATION_WINDOW).map(toChat)],
  };
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
