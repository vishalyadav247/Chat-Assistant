// Provider-agnostic LLM interface — the swap seam. Nothing outside app/lib/llm
// imports a vendor SDK. See .claude/specs/03-ai-pipeline.md.

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  /** Force strict-JSON output (router calls). */
  jsonObject?: boolean;
}

export interface LlmProvider {
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
  chatStream(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<string>;
  embed(text: string): Promise<number[]>;
  /** Batched embeddings (ingestion). Implementations cap batch size internally. */
  embedBatch(texts: string[]): Promise<number[][]>;
  /** Moderation check; returns flagged category names ([] = clean). MUST fail open. */
  moderate(text: string): Promise<string[]>;
}
