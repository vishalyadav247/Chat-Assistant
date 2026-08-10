import db from "../../db.server";
import { getLlmProvider, type ChatMessage } from "../llm/index.server";
import { requireShopId } from "../tenancy.server";
import { SUMMARY_SYSTEM } from "./prompts";

// Conversation history (spec 03): rolling summary + recent-verbatim windows —
// 10 messages for the router, 6 for generation. Summary refreshed when the
// older-than-window count has grown by ~4 since the last refresh; cached on
// the conversation row. Retrieval never uses history (current message only).

export const ROUTER_WINDOW = 10;
export const GENERATION_WINDOW = 6;
const SUMMARY_REFRESH_EVERY = 4;

export interface HistoryBundle {
  routerHistory: ChatMessage[];
  generationHistory: ChatMessage[];
}

export async function loadHistory(shopId: string, conversationId: string): Promise<HistoryBundle> {
  requireShopId(shopId);
  const convo = await db.conversation.findFirst({
    where: { id: conversationId, shopId },
    select: { id: true, summary: true, summaryMessageCount: true },
  });
  if (!convo) return { routerHistory: [], generationHistory: [] };

  const rows = await db.message.findMany({
    where: { conversationId, shopId, role: { in: ["in", "out"] } },
    orderBy: { createdAt: "desc" },
    take: ROUTER_WINDOW + 40, // window + summarization lookback
    select: { role: true, content: true },
  });
  rows.reverse();

  const recent = rows.slice(-ROUTER_WINDOW);
  const olderCount = Math.max(0, rows.length - ROUTER_WINDOW);

  let summary = convo.summary;
  if (
    olderCount > 0 &&
    (!summary || olderCount - convo.summaryMessageCount >= SUMMARY_REFRESH_EVERY)
  ) {
    summary = await summarize(rows.slice(0, rows.length - ROUTER_WINDOW));
    await db.conversation.update({
      where: { id: convo.id },
      data: { summary, summaryMessageCount: olderCount },
    });
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

async function summarize(rows: { role: string; content: string }[]): Promise<string> {
  try {
    const text = rows
      .map((r) => `${r.role === "in" ? "Shopper" : "Assistant"}: ${r.content}`)
      .join("\n")
      .slice(-6000);
    return await getLlmProvider().chat(
      [
        { role: "system", content: SUMMARY_SYSTEM },
        { role: "user", content: text },
      ],
      { temperature: 0.2, maxTokens: 130 },
    );
  } catch (error) {
    console.error("summary_error", error);
    return "";
  }
}
