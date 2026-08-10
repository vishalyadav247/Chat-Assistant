import { env } from "../env.server";
import { OpenAiProvider } from "./openai.server";
import type { LlmProvider } from "./types";

let provider: LlmProvider | undefined;

/** Env-driven provider factory — the only way the app obtains an LLM. */
export function getLlmProvider(): LlmProvider {
  if (!provider) {
    switch (env().LLM_PROVIDER) {
      case "openai":
      default:
        provider = new OpenAiProvider();
    }
  }
  return provider;
}

export type { ChatMessage, ChatOptions, LlmProvider } from "./types";
