/**
 * All model names and pricing live in this one module (build plan §2).
 *
 * VERIFY BEFORE RELEASE: re-check current model ids and USD-per-MTok pricing
 * against https://docs.anthropic.com and https://platform.openai.com/docs —
 * these values move. Pricing here only feeds budget accounting; a stale price
 * degrades cost estimates, not correctness.
 */

export interface ModelInfo {
  provider: "anthropic" | "openai";
  inPerMTok: number;
  outPerMTok: number;
  /** Relative quality tier used by pick-model defaults (0–1). */
  quality: number;
}

export const MODELS: Record<string, ModelInfo> = {
  // Anthropic
  "claude-fable-5": { provider: "anthropic", inPerMTok: 20, outPerMTok: 100, quality: 1.0 },
  "claude-opus-4-8": { provider: "anthropic", inPerMTok: 15, outPerMTok: 75, quality: 0.95 },
  "claude-sonnet-5": { provider: "anthropic", inPerMTok: 3, outPerMTok: 15, quality: 0.9 },
  "claude-haiku-4-5-20251001": { provider: "anthropic", inPerMTok: 1, outPerMTok: 5, quality: 0.75 },
  // OpenAI
  "gpt-5": { provider: "openai", inPerMTok: 10, outPerMTok: 30, quality: 0.92 },
  "gpt-5-mini": { provider: "openai", inPerMTok: 0.6, outPerMTok: 2.4, quality: 0.72 },
};

export const DEFAULTS = {
  anthropic: { model: "claude-sonnet-5", cheap: "claude-haiku-4-5-20251001" },
  openai: { model: "gpt-5", cheap: "gpt-5-mini" },
} as const;

export function priceFor(modelId: string): { inPerMTok: number; outPerMTok: number } {
  const info = MODELS[modelId];
  return info ? { inPerMTok: info.inPerMTok, outPerMTok: info.outPerMTok } : { inPerMTok: 3, outPerMTok: 15 };
}

export function providerFor(modelId: string): "anthropic" | "openai" {
  const info = MODELS[modelId];
  if (info) return info.provider;
  if (modelId.startsWith("claude")) return "anthropic";
  if (modelId.startsWith("gpt") || modelId.startsWith("o")) return "openai";
  throw new Error(`Unknown model "${modelId}". Known: ${Object.keys(MODELS).join(", ")}`);
}

/** Default model id from the environment: Anthropic first, then OpenAI. */
export function defaultModelFromEnv(): string | undefined {
  if (process.env.ANTHROPIC_API_KEY) return DEFAULTS.anthropic.model;
  if (process.env.OPENAI_API_KEY) return DEFAULTS.openai.model;
  return undefined;
}

export function cheapModelFor(modelId: string): string {
  return DEFAULTS[providerFor(modelId)].cheap;
}
