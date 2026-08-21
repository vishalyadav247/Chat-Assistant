// Provider-agnostic LLM interface — the swap seam. Nothing outside app/lib/llm
// imports a vendor SDK. See .claude/specs/03-ai-pipeline.md.

import type { LlmPurpose } from "./usage.server";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  /** Force strict-JSON output (router calls). */
  jsonObject?: boolean;
  /**
   * This call's `temperature`/`maxTokens` are deliberately tuned and MUST
   * survive the platform-admin global override (/platform/ai). Set it on any
   * call whose output is parsed by code rather than read by a shopper — an
   * operator dialling temperature to 1.2 must not be able to break JSON
   * routing for every tenant.
   *
   * Defaults by `purpose`: router/summary calls are pinned, `reply` calls are
   * not (tone and length are exactly what the global lever is for).
   */
  pinnedParams?: boolean;
  /**
   * Run this ONE call on a specific model, ignoring the dashboard override and
   * the env default. Used by scripts/model-compat-check.ts so a candidate can
   * be exercised WITHOUT switching live traffic to it.
   */
  model?: string;
}

/**
 * Who this call is for (spec 19 · usage analytics). REQUIRED on every method so
 * the compiler proves no call site escapes token attribution. Pass shopId ""
 * only for genuinely shop-less calls (scripts) — those are simply not recorded.
 */
export interface LlmCallContext {
  shopId: string;
  purpose: LlmPurpose;
}

/** Context for calls whose purpose is fixed by the method itself. */
export type ShopContext = Pick<LlmCallContext, "shopId">;

export interface LlmProvider {
  chat(messages: ChatMessage[], ctx: LlmCallContext, options?: ChatOptions): Promise<string>;
  chatStream(messages: ChatMessage[], ctx: LlmCallContext, options?: ChatOptions): AsyncIterable<string>;
  embed(text: string, ctx: ShopContext): Promise<number[]>;
  /** Batched embeddings (ingestion). Implementations cap batch size internally. */
  embedBatch(texts: string[], ctx: ShopContext): Promise<number[][]>;
  /** Moderation check; returns flagged category names ([] = clean). MUST fail open. */
  moderate(text: string, ctx: ShopContext): Promise<string[]>;
}
