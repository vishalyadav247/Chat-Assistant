import { env } from "../env.server";
import { OpenAiProvider } from "./openai.server";
import { activeTurnCollector } from "../pipeline/turn-capture.server";
import type {
  AgentEvent,
  AgentMessage,
  ToolDefinition,
  ChatMessage,
  ChatOptions,
  LlmCallContext,
  LlmProvider,
  ShopContext,
} from "./types";

let provider: LlmProvider | undefined;

/**
 * Records the EXACT messages of every chat call into the turn's collector
 * when Admin → Debug is recording (AsyncLocalStorage — set per turn by
 * observeTurn in pipeline/turn-capture.server.ts). With no collector active —
 * the default — every method is a straight pass-through. This is the one
 * seam all pipeline LLM calls cross, so no call site needed changes.
 */
class CapturingProvider implements LlmProvider {
  constructor(private readonly inner: LlmProvider) {}

  async chat(messages: ChatMessage[], ctx: LlmCallContext, options?: ChatOptions): Promise<string> {
    // Close over the collector: re-reading the ALS after the await can lose
    // the context inside vendor-SDK thenables, silently dropping the response.
    const collector = activeTurnCollector();
    const call = collector?.record(ctx.purpose, messages) ?? null;
    const answer = await this.inner.chat(messages, ctx, options);
    collector?.appendResponse(call, answer);
    return answer;
  }

  chatStream(messages: ChatMessage[], ctx: LlmCallContext, options?: ChatOptions): AsyncIterable<string> {
    const collector = activeTurnCollector();
    if (!collector) return this.inner.chatStream(messages, ctx, options);
    const call = collector.record(ctx.purpose, messages);
    const stream = this.inner.chatStream(messages, ctx, options);
    // The collector is closed over — the consumer may iterate outside the
    // ALS context (SSE pump) and the chunks still land on the right turn.
    return (async function* () {
      for await (const chunk of stream) {
        collector.appendResponse(call, chunk);
        yield chunk;
      }
    })();
  }

  agentStream(
    messages: AgentMessage[],
    tools: ToolDefinition[],
    ctx: LlmCallContext,
    options?: ChatOptions,
  ): AsyncIterable<AgentEvent> {
    const collector = activeTurnCollector();
    const stream = this.inner.agentStream(messages, tools, ctx, options);
    if (!collector) return stream;
    // Debug capture reads plain role/content pairs; tool traffic is rendered
    // into the content so the recording still shows what the model saw.
    const call = collector.record(
      ctx.purpose,
      messages.map((m) => ({
        role: m.role === "tool" ? "user" : m.role,
        content:
          m.role === "tool"
            ? `[tool result ${m.toolCallId}] ${m.content}`
            : m.role === "assistant" && m.toolCalls?.length
              ? `${m.content ?? ""}[tool calls] ${m.toolCalls.map((c) => `${c.name}(${c.arguments})`).join("; ")}`
              : (m.content ?? ""),
      })),
    );
    return (async function* () {
      for await (const event of stream) {
        if (event.type === "text") collector.appendResponse(call, event.text);
        else collector.appendResponse(call, `[tool calls] ${event.calls.map((c) => `${c.name}(${c.arguments})`).join("; ")}`);
        yield event;
      }
    })();
  }

  embed(text: string, ctx: ShopContext): Promise<number[]> {
    return this.inner.embed(text, ctx);
  }

  embedBatch(texts: string[], ctx: ShopContext): Promise<number[][]> {
    return this.inner.embedBatch(texts, ctx);
  }

  moderate(text: string, ctx: ShopContext): Promise<string[]> {
    return this.inner.moderate(text, ctx);
  }
}

/** Env-driven provider factory — the only way the app obtains an LLM. */
export function getLlmProvider(): LlmProvider {
  if (!provider) {
    switch (env().LLM_PROVIDER) {
      case "openai":
      default:
        provider = new CapturingProvider(new OpenAiProvider());
    }
  }
  return provider;
}

export type {
  AgentEvent,
  AgentMessage,
  ChatMessage,
  ChatOptions,
  LlmProvider,
  ToolCall,
  ToolDefinition,
} from "./types";
