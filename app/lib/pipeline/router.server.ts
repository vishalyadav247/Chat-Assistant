import { getLlmProvider, type ChatMessage } from "../llm/index.server";
import { ROUTER } from "./prompts";

// Intent router (spec 03 step 4): gpt-4o-mini, temp 0, strict JSON.
// Parse failure → ONE retry → chat-lane clarify (never default to buy — the
// demo's silent default-to-buy on malformed JSON is a documented bug we fix).

export interface RouteResult {
  intent: "buy" | "question" | "chat";
  price_max: number | null;
  keywords: string[];
  blocked: boolean;
  blocked_reason: string;
  off_topic: boolean;
  off_topic_reason: string;
  parseFailed?: boolean;
}

export async function route(args: {
  message: string;
  history: ChatMessage[];
  bannedTopics: string[];
  storeScope: string;
}): Promise<RouteResult> {
  // Mirror the validated demo (chatconvert_ui.py route()): the BANNED TOPICS /
  // STORE SCOPE lines are appended ONLY when the merchant configured them.
  // Injecting a generic scope made the router flag off_topic far more often.
  const banned = args.bannedTopics.map((t) => t.trim()).filter(Boolean);
  const scope = args.storeScope.trim();
  let system = ROUTER;
  if (banned.length > 0) system += `\nBANNED TOPICS: ${banned.join(", ")}`;
  if (scope) system += `\nSTORE SCOPE: ${scope}`;

  const messages: ChatMessage[] = [
    { role: "system", content: system },
    ...args.history,
    { role: "user", content: args.message },
  ];

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await getLlmProvider().chat(messages, {
        temperature: 0,
        maxTokens: 160,
        jsonObject: true,
      });
      const parsed = parseRoute(raw);
      if (parsed) return parsed;
    } catch (error) {
      console.error("router_error", attempt, error);
    }
  }

  // Both attempts failed → safe fallback: chat lane, caller sends a clarify.
  return {
    intent: "chat",
    price_max: null,
    keywords: [],
    blocked: false,
    blocked_reason: "",
    off_topic: false,
    off_topic_reason: "",
    parseFailed: true,
  };
}

function parseRoute(raw: string): RouteResult | null {
  try {
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const data = JSON.parse(cleaned) as Record<string, unknown>;
    const intent = data.intent;
    if (intent !== "buy" && intent !== "question" && intent !== "chat") return null;
    return {
      intent,
      price_max: typeof data.price_max === "number" && data.price_max > 0 ? data.price_max : null,
      keywords: Array.isArray(data.keywords)
        ? data.keywords.filter((k): k is string => typeof k === "string").slice(0, 4)
        : [],
      blocked: data.blocked === true,
      blocked_reason: typeof data.blocked_reason === "string" ? data.blocked_reason : "",
      off_topic: data.off_topic === true,
      off_topic_reason: typeof data.off_topic_reason === "string" ? data.off_topic_reason : "",
    };
  } catch {
    return null;
  }
}
