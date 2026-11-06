import type { ModelAdapter } from "@noble-agent/core";
import { AnthropicAdapter } from "./anthropic.js";
import { OpenAIAdapter } from "./openai.js";
import { providerFor } from "./models.js";

export { AnthropicAdapter, toAnthropicMessages } from "./anthropic.js";
export { OpenAIAdapter, toOpenAIMessages } from "./openai.js";
export { MockModelAdapter, type MockScript, type MockTurn } from "./mock.js";
export { MODELS, DEFAULTS, priceFor, providerFor, defaultModelFromEnv, cheapModelFor, type ModelInfo } from "./models.js";

const cache = new Map<string, ModelAdapter>();

/** Model id → adapter, memoised. Used as the registry provider factory. */
export function createAdapter(modelId: string): ModelAdapter {
  const hit = cache.get(modelId);
  if (hit) return hit;
  const adapter = providerFor(modelId) === "anthropic" ? new AnthropicAdapter(modelId) : new OpenAIAdapter(modelId);
  cache.set(modelId, adapter);
  return adapter;
}
