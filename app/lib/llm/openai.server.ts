import OpenAI from "openai";
import { env } from "../env.server";
import type { ChatMessage, ChatOptions, LlmProvider } from "./types";

// The ONLY file that imports the openai SDK.

const EMBED_BATCH_LIMIT = 100;

export class OpenAiProvider implements LlmProvider {
  private client: OpenAI;

  constructor() {
    this.client = new OpenAI({ apiKey: env().OPENAI_API_KEY });
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: env().CHAT_MODEL,
      messages,
      temperature: options.temperature ?? 0.3,
      max_tokens: options.maxTokens ?? 300,
      ...(options.jsonObject ? { response_format: { type: "json_object" as const } } : {}),
    });
    return response.choices[0]?.message?.content ?? "";
  }

  async *chatStream(messages: ChatMessage[], options: ChatOptions = {}): AsyncIterable<string> {
    const stream = await this.client.chat.completions.create({
      model: env().CHAT_MODEL,
      messages,
      temperature: options.temperature ?? 0.3,
      max_tokens: options.maxTokens ?? 300,
      stream: true,
    });
    for await (const chunk of stream) {
      const token = chunk.choices[0]?.delta?.content;
      if (token) {
        yield token;
      }
    }
  }

  async embed(text: string): Promise<number[]> {
    const [vector] = await this.embedBatch([text]);
    return vector;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH_LIMIT) {
      const batch = texts.slice(i, i + EMBED_BATCH_LIMIT);
      const response = await withBackoff(() =>
        this.client.embeddings.create({ model: env().EMBEDDING_MODEL, input: batch }),
      );
      for (const item of response.data) {
        out.push(normalize(item.embedding));
      }
    }
    return out;
  }

  async moderate(text: string): Promise<string[]> {
    try {
      const response = await this.client.moderations.create({
        model: "omni-moderation-latest",
        input: text,
      });
      const result = response.results[0];
      if (!result?.flagged) {
        return [];
      }
      return Object.entries(result.categories)
        .filter(([, flagged]) => flagged)
        .map(([name]) => name);
    } catch (error) {
      // Fail open by contract — but never silently (metric hook lives in the pipeline).
      console.error("moderation_error", error);
      return [];
    }
  }
}

/** Unit-normalize so cosine similarity is a plain dot product / pgvector <=> works uniformly. */
function normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0)) || 1;
  return vector.map((x) => x / norm);
}

async function withBackoff<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  let delay = 1000;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      const status = (error as { status?: number }).status;
      if (attempt >= retries || (status !== 429 && status !== undefined && status < 500)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
}
