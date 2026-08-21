import OpenAI from "openai";
import { env } from "../env.server";
import { getAiOverrides } from "../platform/platform-settings.server";
import { runtimeConfig } from "../platform/runtime-config.server";
import { samplingParams, supportsJsonObject } from "./model-compat";
import { recordLlmUsage, type LlmPurpose } from "./usage.server";
import type { ChatMessage, ChatOptions, LlmCallContext, LlmProvider, ShopContext } from "./types";
import type { AiOverrides } from "../platform/platform-settings.server";
import { logError, logWarn } from "../log.server";

// The ONLY file that imports the openai SDK.
// The chat MODEL can be overridden globally from the /platform dashboard
// (spec 19): per-call `options.model` → dashboard override → env CHAT_MODEL.
//
// temperature/maxTokens resolve differently, on purpose (QA fix 2026-08-21):
// the dashboard override applies only to calls whose params are NOT pinned.
// See `resolveSampling` — an operator must not be able to de-tune strict-JSON
// routing for every tenant from a text box.
//
// Embeddings deliberately stay on env EMBEDDING_MODEL (vectors are pinned to
// 1536 dims; switching embedding models requires a re-embed migration, not a
// toggle — `scripts/reembed-products.ts`).
// Every call reports exact token usage to llm_usage_daily (spec 19 · platform
// usage analytics) — including streamed replies, via stream_options.

const EMBED_BATCH_LIMIT = 100;

const DEFAULT_TEMPERATURE = 0.3;
const DEFAULT_MAX_TOKENS = 300;

/**
 * Purposes whose sampling params are machine-critical and therefore pinned by
 * default: `router` output is JSON.parse'd (strict-JSON routing + the
 * borderline-curated yes/no confirm) and `summary` output is stored and
 * re-fed as context. `reply` is deliberately absent — shopper-visible tone and
 * length are exactly what the global lever exists to tune.
 *
 * A call site can override either way with `options.pinnedParams`.
 */
const PINNED_PURPOSES: ReadonlySet<LlmPurpose> = new Set<LlmPurpose>(["router", "summary"]);

/**
 * Effective {temperature, max_tokens} for one call, in the model's dialect.
 *
 * Pinned:      per-call value wins; the dashboard override is ignored.
 * Not pinned:  dashboard override → per-call value → app default.
 */
function resolveSampling(
  model: string,
  ctx: LlmCallContext,
  options: ChatOptions,
  ai: AiOverrides,
): Record<string, number> {
  const pinned = options.pinnedParams ?? PINNED_PURPOSES.has(ctx.purpose);
  const temperature = pinned
    ? (options.temperature ?? DEFAULT_TEMPERATURE)
    : (ai.temperature ?? options.temperature ?? DEFAULT_TEMPERATURE);
  const maxTokens = pinned
    ? (options.maxTokens ?? DEFAULT_MAX_TOKENS)
    : (ai.maxTokens ?? options.maxTokens ?? DEFAULT_MAX_TOKENS);
  return samplingParams(model, temperature, maxTokens);
}

/** `response_format` for models that accept it; warns once per model otherwise. */
const jsonModeWarned = new Set<string>();
function jsonFormat(model: string, options: ChatOptions): Record<string, unknown> {
  if (!options.jsonObject) return {};
  if (supportsJsonObject(model)) return { response_format: { type: "json_object" as const } };
  if (!jsonModeWarned.has(model)) {
    jsonModeWarned.add(model);
    logWarn("chat_model_no_json_mode", `${model} rejects response_format; sending without it`);
  }
  return {};
}

/** OpenAI usage payload → recorder, tolerating absent fields. */
function report(
  ctx: LlmCallContext,
  model: string,
  usage:
    | {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number } | null;
      }
    | null
    | undefined,
): void {
  recordLlmUsage({
    shopId: ctx.shopId,
    purpose: ctx.purpose,
    model,
    promptTokens: usage?.prompt_tokens ?? 0,
    cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
    completionTokens: usage?.completion_tokens ?? 0,
  });
}

export class OpenAiProvider implements LlmProvider {
  private cached: { key: string; client: OpenAI } | null = null;

  /** Rebuilt when the operator rotates the key at /platform/settings. */
  private get client(): OpenAI {
    const apiKey = runtimeConfig().openaiApiKey;
    if (!this.cached || this.cached.key !== apiKey) {
      this.cached = { key: apiKey, client: new OpenAI({ apiKey }) };
    }
    return this.cached.client;
  }

  async chat(messages: ChatMessage[], ctx: LlmCallContext, options: ChatOptions = {}): Promise<string> {
    const ai = await getAiOverrides();
    const model = options.model || ai.chatModel || env().CHAT_MODEL;
    const response = await withBackoff(() =>
      this.client.chat.completions.create({
        model,
        messages,
        ...resolveSampling(model, ctx, options, ai),
        ...jsonFormat(model, options),
      }),
    );
    report(ctx, model, response.usage);
    return response.choices[0]?.message?.content ?? "";
  }

  async *chatStream(
    messages: ChatMessage[],
    ctx: LlmCallContext,
    options: ChatOptions = {},
  ): AsyncIterable<string> {
    const ai = await getAiOverrides();
    const model = options.model || ai.chatModel || env().CHAT_MODEL;
    // The backoff wraps only the request handshake — no token has been yielded
    // to the shopper yet, so a retry here is invisible. Once the stream is open
    // a mid-stream failure propagates (retrying would duplicate output).
    const stream = await withBackoff(() =>
      this.client.chat.completions.create({
        model,
        messages,
        ...resolveSampling(model, ctx, options, ai),
        ...jsonFormat(model, options),
        stream: true,
        // Emits a final usage-only chunk after the content chunks.
        stream_options: { include_usage: true },
      }),
    );
    for await (const chunk of stream) {
      // The usage chunk carries no choices; record it and keep going.
      if (chunk.usage) report(ctx, model, chunk.usage);
      const token = chunk.choices[0]?.delta?.content;
      if (token) {
        yield token;
      }
    }
  }

  async embed(text: string, ctx: ShopContext): Promise<number[]> {
    const [vector] = await this.embedBatch([text], ctx);
    return vector;
  }

  async embedBatch(texts: string[], ctx: ShopContext): Promise<number[][]> {
    const out: number[][] = [];
    const model = env().EMBEDDING_MODEL;
    for (let i = 0; i < texts.length; i += EMBED_BATCH_LIMIT) {
      const batch = texts.slice(i, i + EMBED_BATCH_LIMIT);
      const response = await withBackoff(() => this.client.embeddings.create({ model, input: batch }));
      recordLlmUsage({
        shopId: ctx.shopId,
        purpose: "embedding",
        model,
        promptTokens: response.usage?.prompt_tokens ?? 0,
      });
      for (const item of response.data) {
        out.push(normalize(item.embedding));
      }
    }
    return out;
  }

  async moderate(text: string, ctx: ShopContext): Promise<string[]> {
    const model = "omni-moderation-latest";
    try {
      const response = await this.client.moderations.create({
        model,
        input: text,
      });
      // Moderation is free and reports no tokens — recorded for call counts.
      recordLlmUsage({ shopId: ctx.shopId, purpose: "moderation", model });
      const result = response.results[0];
      if (!result?.flagged) {
        return [];
      }
      return Object.entries(result.categories)
        .filter(([, flagged]) => flagged)
        .map(([name]) => name);
    } catch (error) {
      // Fail open by contract — but never silently (metric hook lives in the pipeline).
      logError("moderation_api_error", error, { shopId: ctx.shopId });
      return [];
    }
  }
}

/** Unit-normalize so cosine similarity is a plain dot product / pgvector <=> works uniformly. */
function normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0)) || 1;
  return vector.map((x) => x / norm);
}

/**
 * Retry 429s and 5xx with exponential backoff. Applied to EVERY OpenAI call
 * that the shopper waits on — chat, chat streaming and embeddings (QA fix
 * 2026-08-21: chat was previously unprotected, so a single rate-limit blip
 * surfaced in the widget as a failed reply).
 */
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
